import { budgetFor, DeadlineExceededError, remainingMs } from "@/lib/deadline";
import { HttpTimeoutError, isAbortError } from "@/lib/http";
import { PINECONE_TIMEOUT_MS } from "@/lib/limits";
import type { ScoredDoc } from "@/lib/search/bm25";
import type { LocalSearchIndex } from "@/lib/search/artifacts";
import { SearchServiceError } from "@/lib/search/errors";
import { PineconeError, pineconeConfig, pineconeNamespace, pineconeRequest, queryVectors, resolveHost, waitForSharedRequest, type PineconeConfig } from "./client";

const readyNamespaces = new Map<string, Promise<void>>();

export function resetPineconeReadinessCache(): void { readyNamespaces.clear(); }

function assertConfigured(): PineconeConfig {
  const config = pineconeConfig();
  if (!config) throw new SearchServiceError(503, "Pinecone search is not configured on this deployment. Full text search remains available.");
  return config;
}

async function checkNamespace(config: PineconeConfig, namespace: string, expected: number): Promise<void> {
  const deadlineAt = Date.now() + PINECONE_TIMEOUT_MS;
  const host = await resolveHost(config, PINECONE_TIMEOUT_MS);
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) throw new HttpTimeoutError(PINECONE_TIMEOUT_MS);
  const stats = await pineconeRequest<{ namespaces?: Record<string, { vectorCount?: number }> }>(config, `https://${host}/describe_index_stats`, { method: "POST", body: {} }, remaining);
  if (stats.namespaces?.[namespace]?.vectorCount !== expected) {
    throw new SearchServiceError(503, "The Pinecone corpus upload is incomplete or out of sync. Run npm run index:pinecone. Full text search remains available.");
  }
}

async function ensureNamespaceReady(config: PineconeConfig, namespace: string, expected: number, timeoutMs: number): Promise<void> {
  const key = JSON.stringify([config.indexName, config.host, namespace, expected]);
  let ready = readyNamespaces.get(key);
  if (!ready) {
    ready = checkNamespace(config, namespace, expected);
    const pending = ready;
    ready.catch(() => { if (readyNamespaces.get(key) === pending) readyNamespaces.delete(key); });
    readyNamespaces.set(key, ready);
  }
  await waitForSharedRequest(ready, timeoutMs);
}

// Chunk ID → row of the local document table, built once per loaded index.
const rowsByIndex = new WeakMap<LocalSearchIndex, Map<string, number>>();

function rowLookup(index: LocalSearchIndex): Map<string, number> {
  let rows = rowsByIndex.get(index);
  if (!rows) {
    rows = new Map(index.documents.map((document, row) => [document.chunkId, row]));
    rowsByIndex.set(index, rows);
  }
  return rows;
}

export function namespaceFor(index: LocalSearchIndex): string {
  return pineconeNamespace({ corpusSha256: index.manifest.corpusSha256, ...index.manifest.embedding });
}

/**
 * The semantic ranking, answered by Pinecone instead of the in-process scan.
 *
 * Returns the same `ScoredDoc` rows `searchEmbeddings` does, so ANN, HYBRID's RRF, and case
 * collapse are untouched. A match the local document table does not contain, or an empty
 * namespace, is refused rather than served. A cold instance also verifies the namespace count
 * against the committed corpus; a failed or still propagating upload is retried on the next call.
 */
async function searchVectors(index: LocalSearchIndex, queryVector: number[], limit: number, deadlineAt?: number): Promise<ScoredDoc[]> {
  const config = assertConfigured();
  let matches;
  try {
    const allowance = budgetFor(PINECONE_TIMEOUT_MS, deadlineAt);
    const operationDeadline = Date.now() + allowance;
    const namespace = namespaceFor(index);
    await ensureNamespaceReady(config, namespace, index.documents.length, allowance);
    matches = await queryVectors(config, namespace, queryVector, limit, remainingMs(operationDeadline));
  } catch (error) {
    if (error instanceof SearchServiceError) throw error;
    if (error instanceof DeadlineExceededError) throw new SearchServiceError(504, "The request ran out of time before the vector search could start.");
    if (isAbortError(error)) throw new SearchServiceError(504, "The vector search timed out. Please try again.");
    if (error instanceof PineconeError) {
      console.error("[pinecone-search] request failed", { status: error.status, message: error.message, index: config.indexName });
      if (error.status === 401 || error.status === 403) throw new SearchServiceError(503, "Pinecone rejected the configured API key.");
      if (error.status === 404) throw new SearchServiceError(503, "The Pinecone index does not exist. Run npm run index:pinecone.");
      if (error.status === 429) throw new SearchServiceError(429, "Vector search is temporarily rate limited.");
      throw new SearchServiceError(502, "The vector search service is temporarily unavailable.");
    }
    throw new SearchServiceError(502, "Unable to reach the vector search service.");
  }
  if (matches.length === 0) throw new SearchServiceError(503, "The Pinecone index holds no vectors for this corpus. Run npm run index:pinecone.");
  const rows = rowLookup(index);
  return matches.map((match) => {
    const row = rows.get(match.id);
    if (row === undefined) {
      console.error("[pinecone-search] match is not in the local document table", { chunkId: match.id.slice(0, 100) });
      throw new SearchServiceError(503, "The Pinecone index is out of sync with this deployment's corpus. Run npm run index:pinecone.");
    }
    return { index: row, score: match.score };
  });
}

export const pineconeVectorSearch = Object.assign(searchVectors, { assertConfigured });

import { budgetFor, DeadlineExceededError } from "@/lib/deadline";
import { isAbortError } from "@/lib/http";
import { PINECONE_TIMEOUT_MS } from "@/lib/limits";
import type { ScoredDoc } from "@/lib/search/bm25";
import type { LocalSearchIndex } from "@/lib/search/artifacts";
import { SearchServiceError } from "@/lib/search/errors";
import { PineconeError, pineconeConfig, pineconeNamespace, queryVectors } from "./client";

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
 * namespace, is refused rather than served: either means the uploaded vectors describe a
 * different corpus than the one this deployment renders.
 */
export async function pineconeVectorSearch(index: LocalSearchIndex, queryVector: number[], limit: number, deadlineAt?: number): Promise<ScoredDoc[]> {
  const config = pineconeConfig();
  if (!config) throw new SearchServiceError(503, "Pinecone search is not configured on this deployment. Full text search remains available.");
  let matches;
  try {
    matches = await queryVectors(config, namespaceFor(index), queryVector, limit, budgetFor(PINECONE_TIMEOUT_MS, deadlineAt));
  } catch (error) {
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

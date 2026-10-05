import { createHash } from "node:crypto";
import { fetchWithTimeout } from "@/lib/http";

// Optional vector store for the semantic half of retrieval. The public deployment does not use
// it: the committed artifacts in data/search/ are still the source of truth, and Pinecone holds
// only a copy of their vectors, keyed by chunk ID. That keeps BM25, RRF, and the document table
// local, so switching backends changes where the nearest-neighbour step runs and nothing else.

export const PINECONE_API_VERSION = "2025-04";
export const PINECONE_CONTROL_URL = "https://api.pinecone.io";
export const DEFAULT_PINECONE_INDEX = "legal-chunks";
// The free Starter plan only offers serverless indexes in aws/us-east-1.
export const DEFAULT_PINECONE_CLOUD = "aws";
export const DEFAULT_PINECONE_REGION = "us-east-1";

export type PineconeConfig = { apiKey: string; indexName: string; host?: string };

export class PineconeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "PineconeError";
  }
}

export function pineconeConfig(): PineconeConfig | undefined {
  const apiKey = process.env.PINECONE_API_KEY?.trim();
  if (!apiKey) return undefined;
  return { apiKey, indexName: process.env.PINECONE_INDEX_NAME?.trim() || DEFAULT_PINECONE_INDEX, host: process.env.PINECONE_INDEX_HOST?.trim() || undefined };
}

/** One namespace per (corpus, embedding space). Rebuilding the corpus or changing the embedding
 *  model therefore points the runtime at a namespace that is empty until it is re-uploaded, which
 *  fails loudly, instead of at stale vectors that would still return plausible-looking matches. */
export function pineconeNamespace(embedding: { corpusSha256: string; provider: string; model: string; dimensions: number }): string {
  const space = createHash("sha256").update(`${embedding.corpusSha256}\n${embedding.provider}\n${embedding.model}\n${embedding.dimensions}`).digest("hex");
  return `corpus-${space.slice(0, 24)}`;
}

/** Pinecone error bodies are JSON with a nested `error.message`; anything else is not logged. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown }; message?: unknown };
    const message = body.error?.message ?? body.message;
    if (typeof message === "string" && message.length > 0) return message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
  } catch {
    // Non-JSON proxy or gateway bodies carry nothing worth surfacing.
  }
  return `HTTP ${response.status}`;
}

export async function pineconeRequest<T>(config: PineconeConfig, url: string, init: { method: string; body?: unknown }, timeoutMs: number): Promise<T> {
  return fetchWithTimeout(url, {
    method: init.method,
    headers: { "Api-Key": config.apiKey, "X-Pinecone-API-Version": PINECONE_API_VERSION, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  }, timeoutMs, async (response) => {
    if (!response.ok) throw new PineconeError(response.status, await errorMessage(response));
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  });
}

export type PineconeIndexDescription = { name: string; dimension: number; metric: string; host: string; status: { ready: boolean; state: string } };

export function describeIndex(config: PineconeConfig, timeoutMs: number): Promise<PineconeIndexDescription> {
  return pineconeRequest(config, `${PINECONE_CONTROL_URL}/indexes/${encodeURIComponent(config.indexName)}`, { method: "GET" }, timeoutMs);
}

// The data-plane host is stable for an index's lifetime, so it is resolved once per warm
// instance. PINECONE_INDEX_HOST skips the lookup entirely. A rejection is dropped so a transient
// control-plane failure does not poison the instance.
const hosts = new Map<string, Promise<string>>();

export function resolveHost(config: PineconeConfig, timeoutMs: number): Promise<string> {
  if (config.host) return Promise.resolve(config.host.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  let host = hosts.get(config.indexName);
  if (!host) {
    host = describeIndex(config, timeoutMs).then((index) => index.host);
    host.catch(() => hosts.delete(config.indexName));
    hosts.set(config.indexName, host);
  }
  return host;
}

export function resetPineconeHostCache(): void { hosts.clear(); }

export type PineconeMatch = { id: string; score: number };

export async function queryVectors(config: PineconeConfig, namespace: string, vector: number[], topK: number, timeoutMs: number): Promise<PineconeMatch[]> {
  const host = await resolveHost(config, timeoutMs);
  const body = await pineconeRequest<{ matches?: Array<{ id?: unknown; score?: unknown }> }>(config, `https://${host}/query`, { method: "POST", body: { namespace, vector, topK, includeValues: false, includeMetadata: false } }, timeoutMs);
  if (!Array.isArray(body.matches)) throw new PineconeError(502, "Pinecone returned a query response without matches.");
  return body.matches.map((match) => {
    if (typeof match.id !== "string" || typeof match.score !== "number" || !Number.isFinite(match.score)) throw new PineconeError(502, "Pinecone returned a malformed match.");
    return { id: match.id, score: match.score };
  });
}

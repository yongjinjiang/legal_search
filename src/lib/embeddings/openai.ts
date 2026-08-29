import { EMBEDDING_BATCH_SIZE, EMBEDDING_BUILD_RETRY_DELAYS_MS, EMBEDDING_TIMEOUT_MS } from "@/lib/limits";
import { fetchWithTimeout } from "@/lib/http";
import { EmbeddingServiceError, type EmbeddingProvider } from "./provider";

// Chosen by benchmark, not by price: text-embedding-3-small at 512 dimensions cost 0.0556
// Recall@1 and 0.0278 MRR against this corpus and lost the Q17 third-party relationship
// entirely. text-embedding-3-large at 1024 dimensions recovers it and produces a smaller
// artifact than small at 1536. docs/LOCAL_RETRIEVAL_EVALUATION.md records the full comparison.
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-large";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type OpenAIEmbeddingSettings = { apiKey: string; model: string; dimensions: number; baseUrl?: string; batchSize?: number };

/** Read embedding settings from the server environment. Returns undefined rather than throwing
 *  so callers can distinguish "not configured" (a 503 the operator fixes) from "call failed". */
export function openAIEmbeddingSettings(): OpenAIEmbeddingSettings | undefined {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  // A typo such as "1024x" used to fall back to the default, which hid the mistake and made
  // /api/health report a width the operator never configured. An absent variable still defaults;
  // a present but unusable one is a configuration error.
  const configured = process.env.OPENAI_EMBEDDING_DIMENSIONS?.trim();
  let dimensions = DEFAULT_EMBEDDING_DIMENSIONS;
  if (configured) {
    dimensions = Number(configured);
    if (!Number.isInteger(dimensions) || dimensions <= 0) throw new EmbeddingServiceError(503, "Semantic search is misconfigured: OPENAI_EMBEDDING_DIMENSIONS must be a positive integer.");
  }
  return {
    apiKey,
    model: process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    dimensions,
    baseUrl: process.env.OPENAI_BASE_URL,
  };
}

type EmbeddingResponse = { data?: Array<{ index?: number; embedding?: unknown }> };

export function createOpenAIEmbeddingProvider(settings: OpenAIEmbeddingSettings): EmbeddingProvider {
  const url = `${(settings.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "")}/embeddings`;

  async function embed(inputs: string[], timeoutMs: number): Promise<number[][]> {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        // `dimensions` is a Matryoshka truncation supported by text-embedding-3-*. Sending it on
        // both the corpus build and the query keeps the two vector spaces identical.
        body: JSON.stringify({ model: settings.model, input: inputs, dimensions: settings.dimensions }),
        cache: "no-store",
      }, timeoutMs);
    } catch (error) {
      if ((error as Error).name === "AbortError") throw new EmbeddingServiceError(504, "The embedding service timed out. Please try again.", true);
      throw new EmbeddingServiceError(502, "Unable to reach the embedding service.", true);
    }
    if (!response.ok) {
      // The provider's own message can echo request content; only the status is logged.
      console.error("[embeddings] request failed", { provider: "openai", model: settings.model, status: response.status });
      const message = response.status === 401 || response.status === 403
        ? "The embedding service rejected the server credentials."
        : response.status === 429
          ? "Semantic search is temporarily rate limited. Full text search is unaffected."
          : "The embedding service is temporarily unavailable.";
      // Rejected credentials are the same class of operator problem as a missing key, so they
      // report 503 rather than 502; a visitor cannot fix either by retrying.
      const authFailure = response.status === 401 || response.status === 403;
      throw new EmbeddingServiceError(response.status === 429 ? 429 : authFailure ? 503 : 502, message, !authFailure);
    }
    const payload = await response.json() as EmbeddingResponse;
    const rows = payload.data;
    if (!Array.isArray(rows) || rows.length !== inputs.length) throw new EmbeddingServiceError(502, "The embedding service returned an unexpected response.");
    // The API documents index-ordered results but does not guarantee it, and OPENAI_BASE_URL
    // deliberately allows other OpenAI-compatible gateways. Sorting alone does not establish
    // alignment: absent indices would all collapse to 0 and duplicates would pass silently, so
    // the indices must first be an exact permutation of 0..n-1.
    const seen = new Set<number>();
    for (const row of rows) {
      const index = row.index;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= inputs.length || seen.has(index as number)) {
        throw new EmbeddingServiceError(502, "The embedding service returned rows that do not map one-to-one onto the inputs.");
      }
      seen.add(index as number);
    }
    const ordered = [...rows].sort((a, b) => (a.index as number) - (b.index as number));
    return ordered.map((row) => {
      const vector = row.embedding;
      if (!Array.isArray(vector) || vector.length !== settings.dimensions || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new EmbeddingServiceError(502, `The embedding service returned a vector that is not ${settings.dimensions} finite dimensions.`);
      }
      return vector as number[];
    });
  }

  return {
    name: "openai",
    model: settings.model,
    dimensions: settings.dimensions,
    async embedQuery(text: string) { return (await embed([text], EMBEDDING_TIMEOUT_MS))[0]; },
    async embedDocuments(texts: string[]) {
      const batchSize = settings.batchSize && settings.batchSize > 0 ? settings.batchSize : EMBEDDING_BATCH_SIZE;
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        // Build-time batches are larger and slower than a query, so they get their own budget,
        // and unlike a query they retry: a rebuild that dies two batches in has already spent
        // money on the vectors it is about to discard.
        for (let attempt = 0; ; attempt += 1) {
          try {
            vectors.push(...await embed(batch, 120_000));
            break;
          } catch (error) {
            if (!(error instanceof EmbeddingServiceError && error.retryable) || attempt >= EMBEDDING_BUILD_RETRY_DELAYS_MS.length) throw error;
            const delay = EMBEDDING_BUILD_RETRY_DELAYS_MS[attempt];
            console.warn(`[embeddings] batch ${Math.floor(start / batchSize) + 1} failed with a retryable provider error (status ${(error as EmbeddingServiceError).status}); retrying in ${delay / 1000}s`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
      return vectors;
    },
  };
}

/** Resolve the configured provider, or undefined when the server has no embedding credentials.
 *  Only OpenAI ships today; the indirection exists so adding a provider is a local change. */
export function embeddingProvider(): EmbeddingProvider | undefined {
  const settings = openAIEmbeddingSettings();
  return settings ? createOpenAIEmbeddingProvider(settings) : undefined;
}

import { budgetFor, DeadlineExceededError } from "@/lib/deadline";
import { EMBEDDING_TIMEOUT_MS } from "@/lib/limits";
import { embeddingProvider } from "@/lib/embeddings/openai";
import { EmbeddingServiceError } from "@/lib/embeddings/provider";
import { RRF_CANDIDATE_DEPTH, RRF_K, reciprocalRankFusion } from "./hybridSearch";
import { SearchIndexError, searchBm25, type ScoredDoc } from "./bm25";
import { embeddingMismatch } from "./embeddingCompatibility";
import { searchEmbeddings } from "./semanticSearch";
import { loadLocalIndex } from "./localIndex";
import { SearchServiceError } from "./errors";
import type { LocalSearchIndex } from "./artifacts";
import type { QueryType, SearchChunk } from "./types";

/** Turn ranked document indices into the chunk shape the UI already renders. Rank is positional
 *  so it stays 1..n regardless of which method produced the list. */
function toChunks(index: LocalSearchIndex, ranked: Array<{ index: number; score: number }>): SearchChunk[] {
  return ranked.map((entry, position) => ({ ...index.documents[entry.index], rank: position + 1, score: entry.score }));
}

async function embedQuery(query: string, index: LocalSearchIndex, deadlineAt?: number): Promise<number[]> {
  let provider;
  // An invalid OPENAI_EMBEDDING_DIMENSIONS is now a thrown configuration error rather than a
  // silent fallback, so it has to reach the caller as a public-safe retrieval error.
  try { provider = embeddingProvider(); } catch (error) {
    if (error instanceof EmbeddingServiceError) throw new SearchServiceError(error.status, error.message);
    throw error;
  }
  // Never fall back to lexical or mock results here: a visitor who selected semantic search must
  // be told the semantic path is unavailable rather than shown a different ranking labelled ANN.
  if (!provider) throw new SearchServiceError(503, "Semantic search is not configured on this deployment. Full text search remains available.");
  // Shared with /api/health so the deployment check cannot call a configuration serviceable that
  // this function is about to refuse.
  const mismatch = embeddingMismatch(provider, index.manifest);
  if (mismatch) {
    console.error("[local-search] embedding configuration does not match the built index", { runtimeModel: provider.model, runtimeDimensions: provider.dimensions, indexModel: index.manifest.embedding.model, indexDimensions: index.manifest.embedding.dimensions });
    throw new SearchServiceError(503, mismatch);
  }
  try {
    return await provider.embedQuery(query, budgetFor(EMBEDDING_TIMEOUT_MS, deadlineAt));
  } catch (error) {
    if (error instanceof DeadlineExceededError) throw new SearchServiceError(504, "The request ran out of time before semantic search could start.");
    if (error instanceof EmbeddingServiceError) throw new SearchServiceError(error.status, error.message);
    throw new SearchServiceError(502, "Unable to reach the embedding service.");
  }
}

/** The nearest-neighbour step. Local by default; the optional Pinecone backend swaps in a remote
 *  query that returns the same rows, so lexical ranking and fusion never depend on where it ran. */
export type VectorSearch = (index: LocalSearchIndex, queryVector: number[], limit: number, deadlineAt?: number) => Promise<ScoredDoc[]>;

const scanLocally: VectorSearch = async (index, queryVector, limit) => searchEmbeddings(index.embeddings, queryVector, limit);

/**
 * Retrieve chunks from the committed static index.
 *
 * FULL_TEXT costs nothing beyond CPU. ANN and HYBRID each make exactly one embedding request for
 * the query; the corpus vectors were embedded once, offline. Nothing here contacts a search
 * service, so an idle deployment makes no paid calls at all.
 */
export async function localSearchChunks(query: string, queryType: QueryType, numResults: number, preloaded?: LocalSearchIndex, deadlineAt?: number, vectorSearch: VectorSearch = scanLocally): Promise<SearchChunk[]> {
  // `preloaded` exists for the offline benchmark, which scores alternate indexes through this
  // exact function rather than through a parallel implementation that could drift from it.
  let index: LocalSearchIndex;
  try {
    index = preloaded ?? await loadLocalIndex();
  } catch (error) {
    if (error instanceof SearchIndexError) { console.error("[local-search] index unavailable", { error: error.message }); throw new SearchServiceError(503, "The search index is unavailable on this deployment."); }
    throw error;
  }

  if (queryType === "FULL_TEXT") return toChunks(index, searchBm25(index.bm25, query, numResults));

  const semantic: ScoredDoc[] = await vectorSearch(index, await embedQuery(query, index, deadlineAt), queryType === "ANN" ? numResults : RRF_CANDIDATE_DEPTH, deadlineAt);
  if (queryType === "ANN") return toChunks(index, semantic);

  const lexical = searchBm25(index.bm25, query, RRF_CANDIDATE_DEPTH);
  return toChunks(index, reciprocalRankFusion(semantic, lexical, numResults, RRF_K, RRF_CANDIDATE_DEPTH));
}

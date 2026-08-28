import { embeddingProvider } from "@/lib/embeddings/openai";
import { EmbeddingServiceError } from "@/lib/embeddings/provider";
import { RRF_CANDIDATE_DEPTH, RRF_K, reciprocalRankFusion } from "./hybridSearch";
import { SearchIndexError, searchBm25, type ScoredDoc } from "./bm25";
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

async function embedQuery(query: string, index: LocalSearchIndex): Promise<number[]> {
  const provider = embeddingProvider();
  // Never fall back to lexical or mock results here: a visitor who selected semantic search must
  // be told the semantic path is unavailable rather than shown a different ranking labelled ANN.
  if (!provider) throw new SearchServiceError(503, "Semantic search is not configured on this deployment. Full text search remains available.");
  if (provider.model !== index.manifest.embedding.model || provider.dimensions !== index.manifest.embedding.dimensions) {
    console.error("[local-search] embedding configuration does not match the built index", { runtimeModel: provider.model, runtimeDimensions: provider.dimensions, indexModel: index.manifest.embedding.model, indexDimensions: index.manifest.embedding.dimensions });
    throw new SearchServiceError(503, "Semantic search is misconfigured: the query embedding model does not match the built index.");
  }
  try {
    return await provider.embedQuery(query);
  } catch (error) {
    if (error instanceof EmbeddingServiceError) throw new SearchServiceError(error.status, error.message);
    throw new SearchServiceError(502, "Unable to reach the embedding service.");
  }
}

/**
 * Retrieve chunks from the committed static index.
 *
 * FULL_TEXT costs nothing beyond CPU. ANN and HYBRID each make exactly one embedding request for
 * the query; the corpus vectors were embedded once, offline. Nothing here contacts a search
 * service, so an idle deployment makes no paid calls at all.
 */
export async function localSearchChunks(query: string, queryType: QueryType, numResults: number, preloaded?: LocalSearchIndex): Promise<SearchChunk[]> {
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

  const semantic: ScoredDoc[] = searchEmbeddings(index.embeddings, await embedQuery(query, index), queryType === "ANN" ? numResults : RRF_CANDIDATE_DEPTH);
  if (queryType === "ANN") return toChunks(index, semantic);

  const lexical = searchBm25(index.bm25, query, RRF_CANDIDATE_DEPTH);
  return toChunks(index, reciprocalRankFusion(semantic, lexical, numResults, RRF_K, RRF_CANDIDATE_DEPTH));
}

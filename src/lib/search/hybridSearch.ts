import type { ScoredDoc } from "./bm25";

// Reciprocal Rank Fusion, k = 60 as in Cormack et al. (2009) and as used by the Databricks
// hybrid endpoint this replaces. Raw BM25 scores are unbounded and cosine scores live in
// [-1, 1], so the two are never added directly; only their ranks are combined.
export const RRF_K = 60;
// Fusion depth, chosen by sweep rather than convention. RRF's usual depths assume a corpus of
// millions; here 50 candidates is 21% of the entire corpus, deep enough that chunks BM25 barely
// matched still earn rank credit and dilute strong semantic evidence. Across k = 10…100 and all
// four embedding configurations tested, depth <= 30 never lowered a metric and raised HYBRID MRR
// on the large-model indexes. See docs/LOCAL_RETRIEVAL_EVALUATION.md for the grid.
export const RRF_CANDIDATE_DEPTH = 30;

export type FusedDoc = { index: number; score: number; semanticRank?: number; lexicalRank?: number };

/** Fuse two ranked lists by RRF: score(d) = 1/(k + rank_semantic(d)) + 1/(k + rank_lexical(d)).
 *
 *  A document missing from one list contributes only the other term rather than being assigned
 *  a synthetic worst rank, which would make the fused score depend on candidate-list length.
 *  Ties break on best contributing rank, then on document index, so the ordering is total and
 *  reproducible for a given corpus. */
export function reciprocalRankFusion(semantic: ScoredDoc[], lexical: ScoredDoc[], limit: number, k = RRF_K, depth = RRF_CANDIDATE_DEPTH): FusedDoc[] {
  const fused = new Map<number, FusedDoc>();
  const contribute = (list: ScoredDoc[], field: "semanticRank" | "lexicalRank") => {
    list.slice(0, depth).forEach((doc, position) => {
      const rank = position + 1;
      const entry = fused.get(doc.index) ?? { index: doc.index, score: 0 };
      entry.score += 1 / (k + rank);
      entry[field] = rank;
      fused.set(doc.index, entry);
    });
  };
  contribute(semantic, "semanticRank");
  contribute(lexical, "lexicalRank");
  const best = (doc: FusedDoc) => Math.min(doc.semanticRank ?? Infinity, doc.lexicalRank ?? Infinity);
  return [...fused.values()].sort((a, b) => b.score - a.score || best(a) - best(b) || a.index - b.index).slice(0, limit);
}

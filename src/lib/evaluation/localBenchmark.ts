import type { QueryType } from "@/lib/search/types";

/**
 * The benchmark figures the UI displays, and the prose that explains them.
 *
 * These used to be written directly into the component from the report, and drifted: the page
 * claimed hybrid "ties the best Recall@1" when it is uniquely highest, and that all three methods
 * share one top-three miss when ANN's is Q18 and the other two miss Q17. Nothing in the suite
 * compared the claims with the saved runs, so nothing caught it.
 *
 * `tests/evaluationConsistency.test.ts` recomputes every number here from
 * `data/evaluation/local_retrieval_results.json` and the canonical gold labels in
 * `data/evaluation/legal_search_queries.csv`, and fails if they disagree. Refresh this file by
 * running that test and correcting the constants — and the prose — to whatever it reports. Only
 * these compact constants reach the browser; neither the saved rankings, the query texts, nor the
 * scoring code is imported into the bundle.
 */
export const BENCHMARK_QUERIES = 18;

/** Queries whose primary gold case is ranked first by ANN, FULL_TEXT and HYBRID alike. The rest —
 *  Q01, Q17, Q18 — are where the three methods actually differ. */
export const UNANIMOUS_RANK_ONE = 15;

export type MethodFigures = {
  recall1: number;
  recall3: number;
  recall5: number;
  mrr: number;
  /** Queries whose primary gold case is ranked first, and within the top three. */
  rank1: number;
  top3: number;
  /** The one query this method does not answer within the top three. */
  top3Miss: string;
  /** Rank of the primary gold case on the two queries that separate the methods. */
  goldRankQ17: number;
  goldRankQ18: number;
};

export const LOCAL_BENCHMARK: Record<QueryType, MethodFigures> = {
  HYBRID: { recall1: 0.9444, recall3: 0.9444, recall5: 0.9444, mrr: 0.9537, rank1: 17, top3: 17, top3Miss: "Q17", goldRankQ17: 6, goldRankQ18: 1 },
  ANN: { recall1: 0.8333, recall3: 0.9444, recall5: 1.0, mrr: 0.8907, rank1: 15, top3: 17, top3Miss: "Q18", goldRankQ17: 3, goldRankQ18: 5 },
  FULL_TEXT: { recall1: 0.8889, recall3: 0.9444, recall5: 0.9444, mrr: 0.9153, rank1: 16, top3: 17, top3Miss: "Q17", goldRankQ17: 7, goldRankQ18: 3 },
};

export type EvaluationNote = { heading: string; metric: string; caption: string; body: string };

// The metric is Recall@3 over the 18 benchmark queries, counted rather than restated, so a rebuilt
// benchmark cannot leave the headline number behind.
export const EVALUATION_NOTES: Record<QueryType, EvaluationNote> = {
  HYBRID: {
    heading: "Best at rank one, one paraphrase gap.",
    metric: `${LOCAL_BENCHMARK.HYBRID.top3}/${BENCHMARK_QUERIES}`,
    caption: "primary benchmark cases retrieved within the top 3 by hybrid search",
    body: "Hybrid has the highest Recall@1 of the three local methods at 0.9444, against full text's 0.8889 and semantic's 0.8333, and leads on average rank with MRR 0.9537—above the Databricks prototype's 0.9259. Its single top-three miss is Q17, which states a third-party relationship without using any of the words the opinion uses: fusion placed that case sixth, between semantic search's third and lexical search's seventh.",
  },
  ANN: {
    heading: "Widest reach, weakest at rank one.",
    metric: `${LOCAL_BENCHMARK.ANN.top3}/${BENCHMARK_QUERIES}`,
    caption: "primary benchmark cases retrieved within the top 3 by semantic search",
    body: "Semantic search is the only method here that reaches Recall@5 1.0000, and the only one that places Thompson in the top three on Q17. It pays for that breadth at the very top: Recall@1 0.8333 and MRR 0.8907 are the lowest of the three, and its own top-three miss is elsewhere—on the deliberately underspecified Q18 the primary case lands fifth.",
  },
  FULL_TEXT: {
    heading: "Exact terms, same weakness on paraphrase.",
    metric: `${LOCAL_BENCHMARK.FULL_TEXT.top3}/${BENCHMARK_QUERIES}`,
    caption: "primary benchmark cases retrieved within the top 3 by full-text search",
    body: "This BM25 implementation improved on the Databricks lexical baseline—Recall@1 0.8889 against 0.7778, MRR 0.9153 against 0.8598—while reproducing its signature failure exactly: on Q17 the relevant case lands at rank seven, below the five results shown, because the query shares almost no vocabulary with it.",
  },
};

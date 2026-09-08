import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCsv } from "../scripts/lib/csv";
import { BENCHMARK_QUERIES, EVALUATION_NOTES, LOCAL_BENCHMARK, UNANIMOUS_RANK_ONE } from "../src/lib/evaluation/localBenchmark";
import { QUERY_TYPES, type QueryType } from "../src/lib/search/types";

/**
 * Derive what the page claims from what was actually measured.
 *
 * The displayed figures were transcribed from the report and drifted: the page said hybrid "ties
 * the best Recall@1" when it is uniquely highest, and that all three methods share a single
 * top-three miss when ANN's is Q18 and the other two miss Q17. The whole suite passed throughout,
 * because nothing compared the sentences with the saved rankings.
 *
 * Gold labels come from the canonical query file rather than from the result file, matching
 * `scripts/evaluate_retrieval.py`: a result file that certified its own labels would prove
 * nothing. No provider call and no re-ranking happens here — only the committed evidence is read.
 */
type Run = { query_id: string; method: string; primary_gold_case: string; ranked_case_ids: string[] };

const runs = (JSON.parse(readFileSync(path.join(process.cwd(), "data", "evaluation", "local_retrieval_results.json"), "utf8")) as { runs: Run[] }).runs;
const gold = new Map(parseCsv(readFileSync(path.join(process.cwd(), "data", "evaluation", "legal_search_queries.csv"), "utf8")).map((row) => [row.query_id, row.primary_gold_case]));
const queryIds = [...gold.keys()].sort();

function goldRank(queryId: string, method: QueryType): number | undefined {
  const run = runs.find((entry) => entry.query_id === queryId && entry.method === method);
  if (!run) throw new Error(`No saved run for ${queryId} ${method}`);
  const expected = gold.get(queryId);
  if (run.primary_gold_case !== expected) throw new Error(`Saved gold case for ${queryId} disagrees with the query file`);
  const position = run.ranked_case_ids.indexOf(expected as string);
  return position === -1 ? undefined : position + 1;
}

const ranksFor = (method: QueryType) => queryIds.map((queryId) => goldRank(queryId, method));
const round4 = (value: number) => Number(value.toFixed(4));
const recallAt = (ranks: Array<number | undefined>, k: number) => ranks.filter((rank) => rank !== undefined && rank <= k).length;
const mrr = (ranks: Array<number | undefined>) => round4(ranks.reduce((total: number, rank) => total + (rank ? 1 / rank : 0), 0) / ranks.length);

describe("displayed benchmark figures match the saved evidence", () => {
  it("covers every query in the canonical query file", () => {
    expect(queryIds).toHaveLength(BENCHMARK_QUERIES);
    expect(runs).toHaveLength(BENCHMARK_QUERIES * QUERY_TYPES.length);
  });

  it.each(QUERY_TYPES)("reports %s exactly as measured", (method) => {
    const ranks = ranksFor(method);
    const figures = LOCAL_BENCHMARK[method];
    expect(round4(recallAt(ranks, 1) / BENCHMARK_QUERIES)).toBe(figures.recall1);
    expect(round4(recallAt(ranks, 3) / BENCHMARK_QUERIES)).toBe(figures.recall3);
    expect(round4(recallAt(ranks, 5) / BENCHMARK_QUERIES)).toBe(figures.recall5);
    expect(mrr(ranks)).toBe(figures.mrr);
    expect(recallAt(ranks, 1)).toBe(figures.rank1);
    expect(recallAt(ranks, 3)).toBe(figures.top3);
    expect(goldRank("Q17", method)).toBe(figures.goldRankQ17);
    expect(goldRank("Q18", method)).toBe(figures.goldRankQ18);
  });

  it.each(QUERY_TYPES)("names %s's own top-three miss", (method) => {
    const missed = queryIds.filter((queryId) => { const rank = goldRank(queryId, method); return rank === undefined || rank > 3; });
    expect(missed).toEqual([LOCAL_BENCHMARK[method].top3Miss]);
  });

  it("counts the queries every method answers first", () => {
    const unanimous = queryIds.filter((queryId) => QUERY_TYPES.every((method) => goldRank(queryId, method) === 1));
    expect(unanimous).toHaveLength(UNANIMOUS_RANK_ONE);
    // Not two queries, and not the same two for every method: ANN also places Q01's gold case second.
    expect(queryIds.filter((queryId) => !unanimous.includes(queryId))).toEqual(["Q01", "Q17", "Q18"]);
  });

  it("does not claim a shared top-three miss", () => {
    const misses = QUERY_TYPES.map((method) => LOCAL_BENCHMARK[method].top3Miss);
    expect(new Set(misses).size).toBeGreaterThan(1);
    expect(LOCAL_BENCHMARK.ANN.top3Miss).not.toBe(LOCAL_BENCHMARK.HYBRID.top3Miss);
  });

  it("credits the highest Recall@1 to the method that actually has it", () => {
    const best = QUERY_TYPES.reduce((leader, method) => (LOCAL_BENCHMARK[method].recall1 > LOCAL_BENCHMARK[leader].recall1 ? method : leader));
    expect(best).toBe("HYBRID");
    // Uniquely highest, so prose describing a tie is wrong.
    expect(QUERY_TYPES.filter((method) => LOCAL_BENCHMARK[method].recall1 === LOCAL_BENCHMARK.HYBRID.recall1)).toEqual(["HYBRID"]);
  });

  it("checks the two claims the notes make about Q17", () => {
    // "the only one that places Thompson in the top three on Q17".
    expect(QUERY_TYPES.filter((method) => (goldRank("Q17", method) ?? Infinity) <= 3)).toEqual(["ANN"]);
    // "below the five results shown" — and present, so "not retrieved at all" would be false.
    for (const method of ["FULL_TEXT", "HYBRID"] as const) {
      const rank = goldRank("Q17", method);
      expect(rank).toBeDefined();
      expect(rank as number).toBeGreaterThan(5);
    }
  });

  it.each(QUERY_TYPES)("keeps the %s evaluation note in step with the figures", (method) => {
    const figures = LOCAL_BENCHMARK[method];
    const note = EVALUATION_NOTES[method];
    expect(note.metric).toBe(`${recallAt(ranksFor(method), 3)}/${BENCHMARK_QUERIES}`);
    // The prose quotes its own method's headline numbers, so a rebuilt benchmark cannot leave a
    // stale figure in a sentence while the metric above it updates.
    expect(note.body).toContain(figures.recall1.toFixed(4));
    expect(note.body).toContain(figures.mrr.toFixed(4));
  });
});

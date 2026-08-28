/**
 * Run and score the 18-query benchmark against the local retrieval engine.
 *
 *   npx vite-node -c vitest.config.ts scripts/evaluate_local_retrieval.ts -- [options]
 *
 * Queries go through the same `localSearchChunks` the web route uses, so a scored run reflects
 * production ranking rather than a parallel evaluation implementation. The result file uses the
 * schema of scripts/evaluate_retrieval.py, so `evaluate_retrieval.py --score <file>` recomputes
 * the primary-gold table independently.
 *
 * Options:
 *   --index <dir>        artifact directory to score (default: data/search)
 *   --output <path>      result file (default: data/evaluation/local_retrieval_results.json)
 *   --num-results <n>    chunk depth per query (default: 20, matching the Databricks baseline)
 *   --label <name>       run label recorded in the result file
 *   --quiet              suppress the per-query ranking lines
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalIndex } from "@/lib/search/localIndex";
import { localSearchChunks } from "@/lib/search/localSearch";
import { QUERY_TYPES, type QueryType } from "@/lib/search/types";
import { parseCsv } from "./lib/csv";
import { loadEnvFiles } from "./lib/env";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFiles(ROOT);

const flag = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };
const QUERIES_PATH = path.join(ROOT, "data", "evaluation", "legal_search_queries.csv");
const indexDir = path.resolve(ROOT, flag("index") ?? path.join("data", "search"));
const outputPath = path.resolve(ROOT, flag("output") ?? path.join("data", "evaluation", "local_retrieval_results.json"));
const numResults = Number(flag("num-results") ?? 20);
const quiet = process.argv.includes("--quiet");

type BenchmarkQuery = { queryId: string; query: string; primary: string; others: string[] };
type Run = { query_id: string; method: QueryType; primary_gold_case: string; other_relevant_cases: string[]; ranked_case_ids: string[]; chunks_returned: number; censored: boolean };

function loadQueries(): BenchmarkQuery[] {
  return parseCsv(readFileSync(QUERIES_PATH, "utf8")).map((row) => ({
    queryId: row.query_id,
    query: row.query,
    primary: row.primary_gold_case,
    others: row.other_relevant_cases.split("|").filter(Boolean),
  }));
}

/** Chunk ranks collapse to unique case IDs in retrieval order. The full ranking is kept: a gold
 *  case at rank 7 still contributes 1/7 to MRR, so truncating to the UI's depth would score it
 *  as absent. This mirrors `collapse_case_ids` in scripts/evaluate_retrieval.py. */
function collapseCaseIds(caseIds: string[]): string[] {
  return [...new Set(caseIds)];
}

type MethodScore = { queries: number; recall_at_1: number; recall_at_3: number; recall_at_5: number; mrr: number; unranked_gold: number; censored_misses: number; any_relevant_at_3: number; any_relevant_at_5: number; set_recall_at_3: number; set_recall_at_5: number; set_recall_at_10: number };

function score(runs: Run[]): Record<string, MethodScore> {
  const scores: Record<string, MethodScore> = {};
  for (const method of QUERY_TYPES) {
    const rows = runs.filter((run) => run.method === method);
    if (rows.length === 0) continue;
    const ranks: Array<number | undefined> = rows.map((run) => { const at = run.ranked_case_ids.indexOf(run.primary_gold_case); return at === -1 ? undefined : at + 1; });
    const rate = (predicate: (rank: number | undefined, index: number) => boolean) => ranks.filter(predicate).length / rows.length;
    // Multi-relevant view. Q17 and Q18 have more than one legitimate precedent, so scoring them
    // only against the primary gold case understates every method on exactly the two queries
    // designed to test breadth.
    const relevant = rows.map((run) => new Set([run.primary_gold_case, ...run.other_relevant_cases]));
    const anyAt = (k: number) => rows.filter((run, i) => run.ranked_case_ids.slice(0, k).some((id) => relevant[i].has(id))).length / rows.length;
    const setAt = (k: number) => rows.reduce((sum, run, i) => sum + run.ranked_case_ids.slice(0, k).filter((id) => relevant[i].has(id)).length / relevant[i].size, 0) / rows.length;
    scores[method] = {
      queries: rows.length,
      recall_at_1: rate((rank) => rank !== undefined && rank <= 1),
      recall_at_3: rate((rank) => rank !== undefined && rank <= 3),
      recall_at_5: rate((rank) => rank !== undefined && rank <= 5),
      mrr: ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / rows.length,
      unranked_gold: ranks.filter((rank) => rank === undefined).length,
      censored_misses: rows.filter((run, i) => ranks[i] === undefined && run.censored).length,
      any_relevant_at_3: anyAt(3),
      any_relevant_at_5: anyAt(5),
      set_recall_at_3: setAt(3),
      set_recall_at_5: setAt(5),
      set_recall_at_10: setAt(10),
    };
  }
  return scores;
}

function printScores(scores: Record<string, MethodScore>): void {
  console.log("\nPrimary gold case");
  console.log("Method      Recall@1  Recall@3  Recall@5  MRR");
  for (const method of QUERY_TYPES) {
    const row = scores[method];
    if (row) console.log(`${method.padEnd(10)}  ${row.recall_at_1.toFixed(4)}    ${row.recall_at_3.toFixed(4)}    ${row.recall_at_5.toFixed(4)}    ${row.mrr.toFixed(4)}`);
  }
  console.log("\nAll relevant cases (Q17 and Q18 have more than one)");
  console.log("Method      Any@3   Any@5   SetRecall@3  SetRecall@5  SetRecall@10");
  for (const method of QUERY_TYPES) {
    const row = scores[method];
    if (row) console.log(`${method.padEnd(10)}  ${row.any_relevant_at_3.toFixed(4)}  ${row.any_relevant_at_5.toFixed(4)}  ${row.set_recall_at_3.toFixed(4)}       ${row.set_recall_at_5.toFixed(4)}       ${row.set_recall_at_10.toFixed(4)}`);
  }
  for (const method of QUERY_TYPES) {
    const censored = scores[method]?.censored_misses ?? 0;
    if (censored) console.log(`warning: ${method} has ${censored} gold case(s) below the retrieved chunk depth; its metrics are a lower bound`);
  }
}

async function main(): Promise<void> {
  if (!existsSync(indexDir)) throw new Error(`Index directory ${path.relative(ROOT, indexDir)} does not exist. Run scripts/build_search_index.ts first.`);
  const index = await readLocalIndex(indexDir);
  const queries = loadQueries();
  if (queries.length === 0) throw new Error("Benchmark query file is empty.");
  const runs: Run[] = [];
  for (const query of queries) {
    for (const method of QUERY_TYPES) {
      const chunks = await localSearchChunks(query.query, method, numResults, index);
      const ranked = collapseCaseIds(chunks.map((chunk) => chunk.caseId));
      runs.push({
        query_id: query.queryId,
        method,
        primary_gold_case: query.primary,
        other_relevant_cases: query.others,
        ranked_case_ids: ranked,
        chunks_returned: chunks.length,
        // The requested chunk depth was exhausted, so unseen cases may rank below the window.
        censored: chunks.length >= numResults,
      });
      if (!quiet) console.log(`${query.queryId} ${method.padEnd(9)} ${ranked.join(", ")}`);
    }
  }

  const scores = score(runs);
  printScores(scores);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({
    schema_version: 2,
    generated_at: new Date().toISOString(),
    label: flag("label") ?? "local",
    backend: "local",
    index_name: path.relative(ROOT, indexDir),
    index_manifest: index.manifest,
    num_chunk_results: numResults,
    query_file: path.relative(ROOT, QUERIES_PATH),
    query_file_sha256: createHash("sha256").update(readFileSync(QUERIES_PATH)).digest("hex"),
    scores,
    runs,
  }, null, 2)}\n`, "utf8");
  console.log(`\nSaved auditable rankings to ${path.relative(ROOT, outputPath)}`);
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

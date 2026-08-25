import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SearchContext } from "@/lib/chat/validation";
import { MAX_CASE_RESULTS } from "@/lib/search/types";

export type ContextMode = "standard" | "detailed";
const STANDARD = ["PROJECT_CONTEXT_SUMMARY.md"];
const DETAILED = [...STANDARD, "TECHNICAL_DEEP_DIVE.md", "EVALUATION_RESULTS.md", "FUTURE_DIRECTIONS.md"];
export function contextFiles(mode: ContextMode): string[] { return mode === "detailed" ? DETAILED : STANDARD; }
export async function loadProjectContext(mode: ContextMode): Promise<string> {
  const docs = await Promise.all(contextFiles(mode).map(async (file) => `## ${file}\n${await readFile(path.join(process.cwd(), "docs", file), "utf8")}`));
  return docs.join("\n\n");
}

export function formatSearchContext(search: SearchContext): string {
  return JSON.stringify({
    query: search.query,
    method: search.method,
    cases: search.results.slice(0, MAX_CASE_RESULTS).map((result) => ({
      rank: result.rank,
      caseName: result.caseName,
      citation: result.citation,
      passage: result.bestPassage.slice(0, 900),
    })),
  }, null, 2);
}

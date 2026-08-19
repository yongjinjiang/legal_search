import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SearchState } from "@/lib/search/types";

export type ContextMode = "standard" | "detailed";
const STANDARD = ["PROJECT_CONTEXT_SUMMARY.md"];
const DETAILED = [...STANDARD, "TECHNICAL_DEEP_DIVE.md", "EVALUATION_RESULTS.md", "FUTURE_DIRECTIONS.md"];
export function contextFiles(mode: ContextMode): string[] { return mode === "detailed" ? DETAILED : STANDARD; }
export async function loadProjectContext(mode: ContextMode, search?: SearchState): Promise<string> {
  const docs = await Promise.all(contextFiles(mode).map(async (file) => `## ${file}\n${await readFile(path.join(process.cwd(), "docs", file), "utf8")}`));
  if (search) docs.push(`## Current retrieval state\nQuestion: ${search.query}\nMethod: ${search.method}\nCases:\n${search.results.slice(0, 5).map((r) => `${r.rank}. ${r.caseName} (${r.citation})\nPassage: ${r.bestPassage.slice(0, 900)}`).join("\n")}`);
  return docs.join("\n\n");
}

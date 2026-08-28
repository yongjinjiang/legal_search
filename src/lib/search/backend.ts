import { DEFAULT_CHUNK_RESULTS } from "@/lib/limits";
import { collapseToCases } from "./caseRanking";
import { localSearchChunks } from "./localSearch";
import { SearchServiceError } from "./errors";
import { MAX_CASE_RESULTS, type CaseResult, type QueryType, type SearchChunk } from "./types";

export const SEARCH_BACKENDS = ["local", "databricks"] as const;
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];

/** The public deployment runs `local`. `databricks` is retained only so the original prototype
 *  can be re-measured against the same benchmark harness; it is never the default, because
 *  defaulting to it would reintroduce an always-on serving endpoint. */
export function searchBackend(): SearchBackend {
  return process.env.SEARCH_BACKEND === "databricks" ? "databricks" : "local";
}

/** Mock retrieval for credential-free frontend work. MOCK_SEARCH is the current name;
 *  MOCK_DATABRICKS is still honoured so existing local .env files keep working. */
export function mockEnabled(): boolean {
  return process.env.MOCK_SEARCH === "true" || process.env.MOCK_DATABRICKS === "true";
}

async function retrieveChunks(query: string, queryType: QueryType, numResults: number, backend: SearchBackend): Promise<SearchChunk[]> {
  if (mockEnabled()) return (await import("./mockSearch")).mockSearch(query, queryType, numResults);
  if (backend === "databricks") return (await import("@/lib/databricks/search")).databricksSearchChunks(query, queryType, numResults);
  return localSearchChunks(query, queryType, numResults);
}

/**
 * Retrieve chunks and collapse them to unique cases.
 *
 * Failures propagate as SearchServiceError. There is deliberately no fallback path: production
 * must never answer a failed semantic search with mock data or with a different retrieval method
 * while still labelling the result ANN or HYBRID.
 */
export async function searchCases(query: string, queryType: QueryType, numResults = DEFAULT_CHUNK_RESULTS): Promise<{ results: CaseResult[]; mock: boolean; backend: SearchBackend }> {
  const backend = searchBackend();
  const chunks = await retrieveChunks(query, queryType, numResults, backend);
  return { results: collapseToCases(chunks, queryType, MAX_CASE_RESULTS), mock: mockEnabled(), backend };
}

export { SearchServiceError };

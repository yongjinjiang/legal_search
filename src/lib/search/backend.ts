import { DEFAULT_CHUNK_RESULTS } from "@/lib/limits";
import { collapseToCases } from "./caseRanking";
import { localSearchChunks } from "./localSearch";
import { SearchServiceError } from "./errors";
import { MAX_CASE_RESULTS, type CaseResult, type QueryType, type SearchChunk } from "./types";

export const SEARCH_BACKENDS = ["local", "databricks", "pinecone"] as const;
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];

/** The public deployment runs `local`. `databricks` is retained only so the original prototype
 *  can be re-measured against the same benchmark harness; it is never the default, because
 *  defaulting to it would reintroduce an always-on serving endpoint. `pinecone` is opt-in groundwork
 *  for a corpus too large to scan in-process: it moves only the vector step off the instance. */
export function searchBackend(): SearchBackend {
  const configured = process.env.SEARCH_BACKEND;
  return configured === "databricks" || configured === "pinecone" ? configured : "local";
}

/** Mock retrieval for credential-free frontend work. MOCK_SEARCH is the current name;
 *  MOCK_DATABRICKS is still honoured so existing local .env files keep working. */
export function mockEnabled(): boolean {
  return process.env.MOCK_SEARCH === "true" || process.env.MOCK_DATABRICKS === "true";
}

async function retrieveChunks(query: string, queryType: QueryType, numResults: number, backend: SearchBackend, deadlineAt?: number): Promise<SearchChunk[]> {
  if (mockEnabled()) return (await import("./mockSearch")).mockSearch(query, queryType, numResults);
  if (backend === "databricks") return (await import("@/lib/databricks/search")).databricksSearchChunks(query, queryType, numResults);
  if (backend === "pinecone") return localSearchChunks(query, queryType, numResults, undefined, deadlineAt, (await import("@/lib/pinecone/search")).pineconeVectorSearch);
  return localSearchChunks(query, queryType, numResults, undefined, deadlineAt);
}

/**
 * Retrieve chunks and collapse them to unique cases.
 *
 * Failures propagate as SearchServiceError. There is deliberately no fallback path: production
 * must never answer a failed semantic search with mock data or with a different retrieval method
 * while still labelling the result ANN or HYBRID.
 */
export async function searchCases(query: string, queryType: QueryType, numResults = DEFAULT_CHUNK_RESULTS, deadlineAt?: number): Promise<{ results: CaseResult[]; mock: boolean; backend: SearchBackend }> {
  const backend = searchBackend();
  const chunks = await retrieveChunks(query, queryType, numResults, backend, deadlineAt);
  return { results: collapseToCases(chunks, queryType, MAX_CASE_RESULTS), mock: mockEnabled(), backend };
}

export { SearchServiceError };

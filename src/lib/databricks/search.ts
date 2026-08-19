import { collapseToCases } from "@/lib/search/caseRanking";
import type { CaseResult, QueryType, SearchChunk } from "@/lib/search/types";

const COLUMNS = ["chunk_id", "case_id", "case_name", "citation", "page_start", "page_end", "chunk_text"];

export class SearchServiceError extends Error { constructor(public status: number, message: string) { super(message); } }

export function parseDatabricksResults(payload: unknown): SearchChunk[] {
  if (!payload || typeof payload !== "object") throw new SearchServiceError(502, "Search returned an unreadable response.");
  const body = payload as { manifest?: { columns?: Array<{ name?: string }> }; result?: { data_array?: unknown[][] } };
  const columns = body.manifest?.columns?.map((column) => column.name) ?? [];
  const rows = body.result?.data_array;
  if (!Array.isArray(rows) || !COLUMNS.every((column) => columns.includes(column))) throw new SearchServiceError(502, "Search returned an unexpected result format.");
  const index = Object.fromEntries(columns.map((column, i) => [column, i]));
  return rows.map((row, rank) => {
    const value = (name: string) => row[index[name]];
    if (!Array.isArray(row) || COLUMNS.some((name) => value(name) === null || value(name) === undefined)) throw new SearchServiceError(502, "Search returned an incomplete result.");
    const pageStart = Number(value("page_start")); const pageEnd = Number(value("page_end"));
    if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd)) throw new SearchServiceError(502, "Search returned an invalid page range.");
    return { chunkId: String(value("chunk_id")), caseId: String(value("case_id")), caseName: String(value("case_name")), citation: String(value("citation")), pageStart, pageEnd, chunkText: String(value("chunk_text")), rank: rank + 1 };
  });
}

async function liveSearch(query: string, queryType: QueryType, numResults: number): Promise<SearchChunk[]> {
  const host = process.env.DATABRICKS_HOST?.replace(/\/$/, ""); const token = process.env.DATABRICKS_TOKEN; const index = process.env.DATABRICKS_INDEX_NAME;
  if (!host || !token || !index) throw new SearchServiceError(503, "Live search is not configured. Enable mock mode or add Databricks server credentials.");
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${host}/api/2.0/vector-search/indexes/${encodeURIComponent(index)}/query`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query_text: query, query_type: queryType, columns: COLUMNS, num_results: numResults }), signal: controller.signal, cache: "no-store" });
    if (!response.ok) { const message = response.status === 401 || response.status === 403 ? "Databricks authentication failed." : response.status === 429 ? "Search is temporarily rate limited." : "The search service is temporarily unavailable."; throw new SearchServiceError(response.status, message); }
    return parseDatabricksResults(await response.json());
  } catch (error) { if (error instanceof SearchServiceError) throw error; if ((error as Error).name === "AbortError") throw new SearchServiceError(504, "Search timed out. Please try again."); throw new SearchServiceError(502, "Unable to reach the search service."); } finally { clearTimeout(timeout); }
}

export async function searchCases(query: string, queryType: QueryType, numResults = 20): Promise<{ results: CaseResult[]; mock: boolean }> {
  const mock = process.env.MOCK_DATABRICKS === "true";
  const chunks = mock ? (await import("@/lib/search/mockSearch")).mockSearch(query, queryType, numResults) : await liveSearch(query, queryType, numResults);
  return { results: collapseToCases(chunks, queryType, 5), mock };
}

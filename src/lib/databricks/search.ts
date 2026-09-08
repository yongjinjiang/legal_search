import { SearchServiceError } from "@/lib/search/errors";
import type { QueryType, SearchChunk } from "@/lib/search/types";
import { databricksConnection, fetchWithTimeout, HttpTimeoutError, isAbortError } from "@/lib/databricks/client";

// Historical / optional comparison backend. The public deployment runs the local engine in
// src/lib/search/localSearch.ts and requires no Databricks credentials; this adapter is kept so
// the original AI Search prototype can still be re-measured with the same benchmark harness.

const COLUMNS = ["chunk_id", "case_id", "case_name", "citation", "page_start", "page_end", "chunk_text"];
const MAX_LOG_VALUE_LENGTH = 500;
// Search should fail quickly enough that a user can retry or change strategies.
const SEARCH_TIMEOUT_MS = 12_000;

type DatabricksErrorDetails = {
  status: number;
  errorCode: string;
  message: string;
  requestId?: string;
};

/** Keep useful Databricks diagnostics while removing common credential and PII forms. */
export function sanitizeDatabricksLogValue(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bdapi[a-z0-9_-]{10,}\b/gi, "[REDACTED_TOKEN]")
    .replace(/\beyJ[a-z0-9._-]{20,}\b/gi, "[REDACTED_TOKEN]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_LOG_VALUE_LENGTH);
}

export async function extractDatabricksError(response: Response): Promise<DatabricksErrorDetails> {
  let errorCode = `HTTP_${response.status}`;
  let message = "Databricks returned a non-JSON error response.";
  try {
    const payload = await response.json() as { error_code?: unknown; message?: unknown };
    if (payload.error_code != null) errorCode = sanitizeDatabricksLogValue(payload.error_code).slice(0, 100);
    if (payload.message != null) message = sanitizeDatabricksLogValue(payload.message);
  } catch {
    // Do not log arbitrary HTML or proxy response bodies.
  }
  const requestId = response.headers.get("x-databricks-request-id") ?? response.headers.get("x-request-id") ?? undefined;
  return {
    status: response.status,
    errorCode: errorCode || `HTTP_${response.status}`,
    message: message || "Databricks returned an empty error message.",
    requestId: requestId ? sanitizeDatabricksLogValue(requestId).slice(0, 150) : undefined,
  };
}

function logDatabricksError(details: DatabricksErrorDetails, queryType: QueryType): void {
  console.error("[databricks-search] request failed", {
    status: details.status,
    errorCode: details.errorCode,
    message: details.message,
    requestId: details.requestId,
    queryType,
  });
}

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

export async function databricksSearchChunks(query: string, queryType: QueryType, numResults: number): Promise<SearchChunk[]> {
  const { host, token } = databricksConnection(); const index = process.env.DATABRICKS_INDEX_NAME;
  if (!host || !token || !index) throw new SearchServiceError(503, "Live search is not configured. Enable mock mode or add Databricks server credentials.");
  try {
    // Both the error body and the result body are read inside the timeout; previously the timer
    // was released once the headers arrived, leaving a stalled read unbounded.
    const payload = await fetchWithTimeout(`${host}/api/2.0/vector-search/indexes/${encodeURIComponent(index)}/query`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query_text: query, query_type: queryType, columns: COLUMNS, num_results: numResults }), cache: "no-store" }, SEARCH_TIMEOUT_MS, async (response) => {
      if (!response.ok) {
        const details = await extractDatabricksError(response);
        logDatabricksError(details, queryType);
        const message = response.status === 401
          ? "Databricks authentication failed."
          : response.status === 403
            ? "Databricks denied access to the search index."
            : response.status === 400
              ? "Databricks rejected the search request. Check the server logs for the diagnostic code."
              : response.status === 429
                ? "Search is temporarily rate limited."
                : "The search service is temporarily unavailable.";
        throw new SearchServiceError(response.status, message);
      }
      return await response.json() as unknown;
    });
    return parseDatabricksResults(payload);
  } catch (error) { if (error instanceof SearchServiceError) throw error; if (error instanceof HttpTimeoutError || isAbortError(error)) throw new SearchServiceError(504, "Search timed out. Please try again."); throw new SearchServiceError(502, "Unable to reach the search service."); }
}

export { SearchServiceError };

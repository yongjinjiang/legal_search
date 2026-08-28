import { searchCases, SearchServiceError } from "@/lib/search/backend";
import type { QueryType } from "@/lib/search/types";

// Benchmark-adjacent phrasing that every method should match in this corpus. A successful
// call returning no cases is itself a fault, so it counts as a failed probe.
export const PROBE_QUERY = "materially adverse employment action";
export const PROBE_RESULTS = 3;

export type ProbeResult = { method: QueryType; ok: boolean; cases: number; ms: number; status?: number; error?: string };

// Lives outside the route module because Next restricts which names a route file may export.
export async function probe(method: QueryType): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const { results } = await searchCases(PROBE_QUERY, method, PROBE_RESULTS);
    const ms = Date.now() - started;
    return results.length > 0 ? { method, ok: true, cases: results.length, ms } : { method, ok: false, cases: 0, ms, error: "Search succeeded but returned no cases." };
  } catch (error) {
    // SearchServiceError messages are the sanitized public strings; the Databricks error_code
    // is already logged separately by the search adapter.
    return { method, ok: false, cases: 0, ms: Date.now() - started, status: error instanceof SearchServiceError ? error.status : undefined, error: error instanceof Error ? error.message : "Unknown search failure." };
  }
}

import { NextResponse } from "next/server";
import { searchCases, SearchServiceError } from "@/lib/databricks/search";
import { QUERY_TYPES, type QueryType } from "@/lib/search/types";

// Probes must not be cached, and three 12s searches in sequence would outrun the function
// budget, so they run in parallel and the route costs roughly one search timeout.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Benchmark-adjacent phrasing that every method should match in this corpus. A successful
// call returning no cases is itself a fault, so it counts as a failed probe.
const PROBE_QUERY = "materially adverse employment action";
const PROBE_RESULTS = 3;

type ProbeResult = { method: QueryType; ok: boolean; cases: number; ms: number; status?: number; error?: string };

async function probe(method: QueryType): Promise<ProbeResult> {
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

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: without a secret this route would be a public trigger for live Databricks queries.
  if (!secret) return NextResponse.json({ error: "Monitor is not configured." }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const mode = process.env.MOCK_DATABRICKS === "true" ? "mock" : "live";
  const probes = await Promise.all(QUERY_TYPES.map((method) => probe(method)));
  for (const result of probes) {
    if (result.ok) console.log("[search-monitor] ok", { method: result.method, cases: result.cases, ms: result.ms, mode });
    else console.error("[search-monitor] FAILED", { method: result.method, status: result.status, error: result.error, ms: result.ms, mode });
  }
  const healthy = probes.every((result) => result.ok);
  // A non-2xx marks the run failed in Vercel's cron history, so an outage is visible without reading logs.
  return NextResponse.json({ mode, checkedAt: new Date().toISOString(), healthy, probes }, { status: healthy ? 200 : 503 });
}

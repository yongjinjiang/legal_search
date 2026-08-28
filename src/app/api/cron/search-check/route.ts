import { NextResponse } from "next/server";
import { probe } from "@/lib/monitor/probe";
import { mockEnabled, searchBackend } from "@/lib/search/backend";
import { QUERY_TYPES } from "@/lib/search/types";

// An authenticated on-demand smoke check, no longer on a cron schedule: under the local backend
// there is no external service whose availability could drift, and a daily run would be exactly
// the sort of background paid call this architecture exists to remove. It is kept because a
// single method can still fail independently — semantic and hybrid need the embedding API, full
// text needs only the committed artifacts.
// Probes must not be cached, and running them in sequence would outrun the function budget, so
// they run in parallel and the route costs roughly one search timeout.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: without a secret this route would be a public trigger for paid embedding calls.
  if (!secret) return NextResponse.json({ error: "Monitor is not configured." }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  // Mock mode answers from a fixture, so a green run would assert nothing about real retrieval.
  // Fail closed rather than report health the monitor cannot actually observe.
  if (mockEnabled()) {
    console.error("[search-monitor] FAILED", { error: "Monitor ran in mock mode; no retrieval was performed.", mode: "mock" });
    return NextResponse.json({ mode: "mock", checkedAt: new Date().toISOString(), healthy: false, error: "Monitor requires live mode.", probes: [] }, { status: 503 });
  }

  const mode = searchBackend();
  const probes = await Promise.all(QUERY_TYPES.map((method) => probe(method)));
  for (const result of probes) {
    if (result.ok) console.log("[search-monitor] ok", { method: result.method, cases: result.cases, ms: result.ms, mode });
    else console.error("[search-monitor] FAILED", { method: result.method, status: result.status, error: result.error, ms: result.ms, mode });
  }
  const healthy = probes.every((result) => result.ok);
  // A non-2xx makes a failure visible to whatever invoked the check without reading logs.
  return NextResponse.json({ mode, checkedAt: new Date().toISOString(), healthy, probes }, { status: healthy ? 200 : 503 });
}

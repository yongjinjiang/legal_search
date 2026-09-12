import { NextResponse } from "next/server";
import { rejectUnsafeRequest } from "@/lib/api/guard";
import { generateLegalSummary, SummaryServiceError } from "@/lib/chat/summary";
import { summaryRequestSchema } from "@/lib/chat/validation";
import { deadlineIn } from "@/lib/deadline";
import { LLM_ROUTE_BUDGET_MS } from "@/lib/limits";
import { searchCases, SearchServiceError } from "@/lib/search/backend";

// Deliberately a separate endpoint from /api/search. Retrieval stays pure and free; this route
// is the only path on which a legal query reaches a language model, and it runs only when a
// visitor asks for a summary.
export const maxDuration = 60;

export async function POST(request: Request) {
  const rejected = rejectUnsafeRequest(request); if (rejected) return rejected;
  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid summary request." }, { status: 400 }); }
  const body = summaryRequestSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Invalid summary request." }, { status: 400 });
  try {
    // Retrieval is repeated server-side so the summary is grounded in corpus text rather than in
    // passages a caller could have edited before posting them back.
    // One allowance for the whole request. Retrieval and generation run in sequence, so their
    // independent caps would otherwise sum to the entire platform budget and leave nothing to
    // return an error with.
    const deadlineAt = deadlineIn(LLM_ROUTE_BUDGET_MS);
    const { results } = await searchCases(body.data.query, body.data.queryType, undefined, deadlineAt);
    const summary = await generateLegalSummary(body.data.query, results, deadlineAt);
    return NextResponse.json({ summary, cases: results.map((result) => ({ caseName: result.caseName, citation: result.citation })) });
  } catch (error) {
    if (error instanceof SearchServiceError || error instanceof SummaryServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[summarize] request failed", error);
    return NextResponse.json({ error: "The research summary could not be generated." }, { status: 503 });
  }
}

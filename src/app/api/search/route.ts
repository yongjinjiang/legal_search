import { NextResponse } from "next/server";
import { searchCases, SearchServiceError } from "@/lib/search/backend";
import { searchRequestSchema } from "@/lib/search/validation";

// A malformed body is a client error, so it is parsed outside the service try/catch to keep it a 400 rather than a retryable 500.
export async function POST(request: Request) {
  let raw: unknown; try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid search request." }, { status: 400 }); }
  try { const body = searchRequestSchema.safeParse(raw); if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Invalid search request." }, { status: 400 }); const data = await searchCases(body.data.query, body.data.queryType, body.data.numResults); return NextResponse.json(data); }
  catch (error) { const known = error instanceof SearchServiceError; return NextResponse.json({ error: known ? error.message : "Search could not be completed." }, { status: known ? error.status : 500 }); }
}

import { NextResponse } from "next/server";
import { searchCases, SearchServiceError } from "@/lib/databricks/search";
import { searchRequestSchema } from "@/lib/search/validation";

export async function POST(request: Request) {
  try { const body = searchRequestSchema.safeParse(await request.json()); if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Invalid search request." }, { status: 400 }); const data = await searchCases(body.data.query, body.data.queryType, body.data.numResults); return NextResponse.json(data); }
  catch (error) { const known = error instanceof SearchServiceError; return NextResponse.json({ error: known ? error.message : "Search could not be completed." }, { status: known ? error.status : 500 }); }
}

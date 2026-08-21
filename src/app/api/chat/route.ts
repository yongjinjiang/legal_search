import { NextResponse } from "next/server";
import { answerProjectQuestion, ChatServiceError } from "@/lib/databricks/chat";
import { chatRequestSchema } from "@/lib/chat/validation";
// A malformed body is a client error, so it is parsed outside the service try/catch to keep it a 400 rather than a retryable 503.
export async function POST(request: Request) {
  let body: unknown; try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid chat request." }, { status: 400 }); }
  try { const parsed = chatRequestSchema.safeParse(body); if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid chat request." }, { status: 400 }); const answer = await answerProjectQuestion(parsed.data.question, parsed.data.mode, parsed.data.search); return NextResponse.json({ answer }); } catch (error) { const known = error instanceof ChatServiceError; if (!known) console.error("[databricks-chat] request failed", error); return NextResponse.json({ error: known ? error.message : "The technical guide is temporarily unavailable." }, { status: known ? error.status : 503 }); } }

import { NextResponse } from "next/server";
import { rejectUnsafeRequest } from "@/lib/api/guard";
import { answerProjectQuestion, ChatServiceError } from "@/lib/chat/guide";
import { chatRequestSchema } from "@/lib/chat/validation";
import { deadlineIn } from "@/lib/deadline";
import { LLM_ROUTE_BUDGET_MS } from "@/lib/limits";

// A detailed guide answer is a reasoning-model call over the full project documentation and runs
// well past the platform's default function budget. Declared explicitly so the route is not
// killed mid-answer by a default it never chose.
export const maxDuration = 60;

// A malformed body is a client error, so it is parsed outside the service try/catch to keep it a 400 rather than a retryable 503.
export async function POST(request: Request) {
  const rejected = rejectUnsafeRequest(request); if (rejected) return rejected;
  let body: unknown; try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid chat request." }, { status: 400 }); }
  try { const parsed = chatRequestSchema.safeParse(body); if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid chat request." }, { status: 400 }); const answer = await answerProjectQuestion(parsed.data.question, parsed.data.mode, parsed.data.search, deadlineIn(LLM_ROUTE_BUDGET_MS)); return NextResponse.json({ answer }); } catch (error) { const known = error instanceof ChatServiceError; if (!known) console.error("[chat] request failed", error); return NextResponse.json({ error: known ? error.message : "The technical guide is temporarily unavailable." }, { status: known ? error.status : 503 }); } }

import { NextResponse } from "next/server";
import { z } from "zod";
import { answerProjectQuestion, ChatServiceError } from "@/lib/databricks/chat";
const message = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(3000) });
const schema = z.object({ messages: z.array(message).min(1).max(10), mode: z.enum(["standard", "detailed"]).default("standard"), search: z.any().optional() });
export async function POST(request: Request) { try { const parsed = schema.safeParse(await request.json()); if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid chat request." }, { status: 400 }); const answer = await answerProjectQuestion(parsed.data.messages, parsed.data.mode, parsed.data.search); return NextResponse.json({ answer }); } catch (error) { const known = error instanceof ChatServiceError; if (!known) console.error("[databricks-chat] request failed", error); return NextResponse.json({ error: known ? error.message : "The technical guide is temporarily unavailable." }, { status: known ? error.status : 503 }); } }

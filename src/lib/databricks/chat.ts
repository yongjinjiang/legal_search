import type { ContextMode } from "@/lib/chat/contextLoader";
import { loadProjectContext } from "@/lib/chat/contextLoader";
import type { SearchContext } from "@/lib/chat/validation";
import { databricksConnection, fetchWithTimeout } from "@/lib/databricks/client";

// Guide requests include documentation context and allow more generation time than search.
const CHAT_TIMEOUT_MS = 20_000;

export class ChatServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function answerProjectQuestion(question: string, mode: ContextMode, search?: SearchContext): Promise<string> {
  const { host, token } = databricksConnection(); const model = process.env.DATABRICKS_CHAT_MODEL;
  if (!host || !token || !model) throw new ChatServiceError(503, "The technical guide is not configured yet. Search remains available.");
  const context = await loadProjectContext(mode, search);
  const system = `You are a technical guide to the Legal Retrieval Explorer project. Ground answers only in the supplied project documentation and retrieval state. Clearly distinguish measured results from future ideas; never fabricate metrics. Explain limitations openly. If information is absent, say so. You are not legal counsel and must not give personalized legal advice.\n\n${context}`;
  const response = await fetchWithTimeout(`${host}/serving-endpoints/${encodeURIComponent(model)}/invocations`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: question }], max_tokens: 700, temperature: 0.2 }) }, CHAT_TIMEOUT_MS);
  if (!response.ok) throw new ChatServiceError(response.status === 429 ? 429 : 503, response.status === 429 ? "The technical guide is busy. Try again shortly." : "The technical guide is temporarily unavailable.");
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }; const answer = data.choices?.[0]?.message?.content;
  if (!answer) throw new ChatServiceError(502, "The technical guide returned an empty response."); return answer;
}

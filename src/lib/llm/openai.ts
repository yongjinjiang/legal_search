import { fetchWithTimeout } from "@/lib/http";
import { LlmServiceError, type CompletionOptions, type LlmMessage, type LlmProvider } from "./provider";

export const DEFAULT_CHAT_MODEL = "gpt-5-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type OpenAIChatSettings = { apiKey: string; model: string; baseUrl?: string; reasoningEffort?: string };

export function openAIChatSettings(): OpenAIChatSettings | undefined {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return {
    apiKey,
    model: process.env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
    // Low keeps latency and billed reasoning tokens down. Both callers ground the model in
    // supplied text rather than asking it to solve anything.
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || "low",
  };
}

/** The gpt-5 and o-series models take `max_completion_tokens` and reject a non-default
 *  temperature; earlier chat models take `max_tokens`. Detecting the family keeps the model
 *  swappable by environment variable instead of by code change. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model);
}

type ChatResponse = { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };

export function createOpenAIChatProvider(settings: OpenAIChatSettings): LlmProvider {
  const url = `${(settings.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "")}/chat/completions`;
  const reasoning = isReasoningModel(settings.model);
  return {
    name: "openai",
    model: settings.model,
    async complete(messages: LlmMessage[], options: CompletionOptions) {
      const body = {
        model: settings.model,
        messages,
        ...(reasoning
          ? { max_completion_tokens: options.maxOutputTokens, reasoning_effort: settings.reasoningEffort }
          : { max_tokens: options.maxOutputTokens, temperature: 0.2 }),
      };
      let response: Response;
      try {
        response = await fetchWithTimeout(url, { method: "POST", headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }, options.timeoutMs);
      } catch (error) {
        if ((error as Error).name === "AbortError") throw new LlmServiceError(504, "The request timed out. Please try again.");
        throw new LlmServiceError(502, "Unable to reach the language model service.");
      }
      if (!response.ok) {
        // Visitor prompts can be echoed inside provider error bodies, so only the status is logged.
        console.error("[llm] request failed", { provider: "openai", model: settings.model, status: response.status });
        throw new LlmServiceError(response.status === 429 ? 429 : 503, response.status === 429 ? "The service is busy. Try again shortly." : "The service is temporarily unavailable.");
      }
      const payload = await response.json() as ChatResponse;
      const answer = payload.choices?.[0]?.message?.content?.trim();
      // A reasoning model spends the same budget on reasoning tokens, so exhausting it returns a
      // well-formed response with empty content. Reporting that as success would show a blank reply.
      if (!answer) throw new LlmServiceError(502, payload.choices?.[0]?.finish_reason === "length" ? "The response exceeded its length budget before any text was produced." : "The service returned an empty response.");
      return answer;
    },
  };
}

export function llmProvider(): LlmProvider | undefined {
  const settings = openAIChatSettings();
  return settings ? createOpenAIChatProvider(settings) : undefined;
}

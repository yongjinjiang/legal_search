import { fetchWithTimeout, HttpTimeoutError, isAbortError } from "@/lib/http";
import { LlmServiceError, type CompletionOptions, type LlmMessage, type LlmProvider } from "./provider";

export const DEFAULT_CHAT_MODEL = "gpt-5-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type OpenAIChatSettings = { apiKey: string; model: string; baseUrl?: string; reasoningEffort?: string };

// The provider's own enum. Anything outside it is a typo that becomes an invalid request.
export const SUPPORTED_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
// The subset measured against this deployment's prompts and budgets. "medium" ran 50-66s and
// spent an entire 4,000-token output budget on reasoning, returning nothing; "high" is strictly
// worse. Those are not merely slower settings — they break the configured routes — so they are
// refused unless an operator deliberately opts into an untested profile.
export const TESTED_REASONING_EFFORTS = ["minimal", "low"] as const;
export const ALLOW_UNTESTED_EFFORT_ENV = "OPENAI_ALLOW_UNTESTED_REASONING_EFFORT";

/** Validate the configured effort instead of forwarding an arbitrary string. Documenting a
 *  footgun does not remove it: a typo reaches the provider as an invalid request, and a valid
 *  but untested value fails intermittently in production rather than at startup.
 *
 *  Low, by measurement rather than by default: on this project's summary prompt "minimal"
 *  produced roughly a fifth of the required page-range citations. Both callers ground the model
 *  in supplied text rather than asking it to solve anything. */
export function resolveReasoningEffort(): string {
  const configured = process.env.OPENAI_REASONING_EFFORT?.trim();
  if (!configured) return "low";
  if (!(SUPPORTED_REASONING_EFFORTS as readonly string[]).includes(configured)) {
    throw new LlmServiceError(503, `OPENAI_REASONING_EFFORT must be one of: ${SUPPORTED_REASONING_EFFORTS.join(", ")}.`);
  }
  if (!(TESTED_REASONING_EFFORTS as readonly string[]).includes(configured) && process.env[ALLOW_UNTESTED_EFFORT_ENV] !== "true") {
    throw new LlmServiceError(503, `OPENAI_REASONING_EFFORT "${configured}" is not tested against this deployment's token and time budgets. Set ${ALLOW_UNTESTED_EFFORT_ENV}=true to override.`);
  }
  return configured;
}

export function openAIChatSettings(): OpenAIChatSettings | undefined {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return {
    apiKey,
    model: process.env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
    reasoningEffort: resolveReasoningEffort(),
  };
}

/** The gpt-5 and o-series models take `max_completion_tokens` and reject a non-default
 *  temperature; earlier chat models take `max_tokens`. Detecting the family keeps the model
 *  swappable by environment variable instead of by code change. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model);
}

type ChatResponse = { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } };

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
      const started = Date.now();
      let payload: ChatResponse;
      try {
        // The body is parsed inside the timeout, so a provider that flushes headers and then
        // stalls is cut off at the budget instead of running until the platform kills the
        // invocation.
        payload = await fetchWithTimeout(url, { method: "POST", headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }, options.timeoutMs, async (response, context) => {
          if (!response.ok) {
            // Visitor prompts can be echoed inside provider error bodies, so only the status is logged.
            console.error("[llm] request failed", { provider: "openai", model: settings.model, status: response.status });
            throw new LlmServiceError(response.status === 429 ? 429 : 503, response.status === 429 ? "The service is busy. Try again shortly." : "The service is temporarily unavailable.");
          }
          try {
            return await response.json() as ChatResponse;
          } catch (error) {
            // A read the timeout aborted is not a malformed payload; reporting it as one sent
            // operators looking for a provider bug instead of at the budget.
            if (context.timedOut() || isAbortError(error)) throw error;
            console.error("[llm] response body could not be read", { provider: "openai", model: settings.model, name: (error as Error).name, ms: Date.now() - started });
            throw new LlmServiceError(502, "The service returned an unreadable response.");
          }
        });
      } catch (error) {
        if (error instanceof LlmServiceError) throw error;
        // Transport failures used to produce no log line at all, which made a report of "the
        // service is temporarily unavailable" impossible to diagnose from production logs. The
        // error name and cause are provider diagnostics, never request content.
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        console.error("[llm] request did not complete", { provider: "openai", model: settings.model, name: (error as Error).name, code: cause?.code, cause: cause?.message?.slice(0, 200), ms: Date.now() - started });
        if (error instanceof HttpTimeoutError || isAbortError(error)) throw new LlmServiceError(504, "The request timed out. Please try again.");
        throw new LlmServiceError(502, "Unable to reach the language model service.");
      }
      const answer = payload.choices?.[0]?.message?.content?.trim();
      // The same token accounting is recorded either way. On success it makes the next budget
      // cliff an observable trend instead of a user report; on failure it is what distinguishes a
      // configuration fault from a transient one. Model and usage only — never prompts,
      // retrieved text, or credentials.
      const accounting = {
        provider: "openai",
        model: settings.model,
        effort: settings.reasoningEffort,
        finishReason: payload.choices?.[0]?.finish_reason,
        maxOutputTokens: options.maxOutputTokens,
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
        reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens,
        ms: Date.now() - started,
      };
      if (!answer) {
        // A reasoning model spends this budget on reasoning tokens before emitting any text, so
        // exhausting it returns a well-formed 200 with empty content. That is a configuration
        // fault, not an outage: it recurs until the budget is raised.
        console.error("[llm] empty completion", accounting);
        throw new LlmServiceError(502, accounting.finishReason === "length" ? "The response exceeded its length budget before any text was produced." : "The service returned an empty response.");
      }
      if (accounting.finishReason === "length") {
        // Nonempty and truncated. The guide and the summary both present the returned string as a
        // finished answer, so a completion that stopped at the budget would be shown as complete —
        // a sentence short of a citation, or missing the caveat the prompt asks for last. Rejecting
        // is a worse experience and a truthful one. Accounting only; never the answer text.
        console.error("[llm] truncated completion", accounting);
        throw new LlmServiceError(502, "The response was cut off before it was complete. Please try again.");
      }
      console.log("[llm] ok", accounting);
      return answer;
    },
  };
}

export function llmProvider(): LlmProvider | undefined {
  const settings = openAIChatSettings();
  return settings ? createOpenAIChatProvider(settings) : undefined;
}

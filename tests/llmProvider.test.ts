import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOW_UNTESTED_EFFORT_ENV, DEFAULT_CHAT_MODEL, SUPPORTED_REASONING_EFFORTS, TESTED_REASONING_EFFORTS, createOpenAIChatProvider, isReasoningModel, llmProvider, resolveReasoningEffort } from "../src/lib/llm/openai";
import { LlmServiceError } from "../src/lib/llm/provider";

const originalEnv = { ...process.env };
const settings = { apiKey: "test-key", model: "gpt-5-mini", reasoningEffort: "low" };
const options = { maxOutputTokens: 100, timeoutMs: 1000 };
const reply = (content: string, finish = "stop") => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 });

afterEach(() => { process.env = { ...originalEnv }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OpenAI chat provider", () => {
  it("sends the parameter shape each model family accepts", () => {
    // gpt-5 and o-series reject a non-default temperature and take max_completion_tokens, so the
    // model has to stay swappable by environment variable without a code change.
    expect(isReasoningModel("gpt-5-mini")).toBe(true);
    expect(isReasoningModel("gpt-5-nano")).toBe(true);
    expect(isReasoningModel("gpt-4o-mini")).toBe(false);
    expect(DEFAULT_CHAT_MODEL).toBe("gpt-5-mini");
  });

  it("uses max_completion_tokens and omits temperature for a reasoning model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("answer"));
    vi.stubGlobal("fetch", fetchMock);
    await createOpenAIChatProvider(settings).complete([{ role: "user", content: "hi" }], options);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "gpt-5-mini", max_completion_tokens: 100, reasoning_effort: "low" });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("uses max_tokens and a low temperature for an older chat model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("answer"));
    vi.stubGlobal("fetch", fetchMock);
    await createOpenAIChatProvider({ ...settings, model: "gpt-4o-mini" }).complete([{ role: "user", content: "hi" }], options);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({ max_tokens: 100, temperature: 0.2 });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("logs the token accounting when a reasoning model returns nothing", async () => {
    // This failure is a configuration fault, not an outage: the budget is consumed by reasoning
    // tokens before any text is emitted, and it recurs until the cap is raised. Without the token
    // accounting in the log it is indistinguishable from a transient provider problem — which is
    // exactly how it reached production once.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 3776, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 2000 } },
    }), { status: 200 })));
    await expect(createOpenAIChatProvider(settings).complete([{ role: "user", content: "hi" }], options)).rejects.toThrow(/length budget/);
    expect(error).toHaveBeenCalledWith("[llm] empty completion", expect.objectContaining({ finishReason: "length", maxOutputTokens: 100, reasoningTokens: 2000, completionTokens: 2000 }));
  });

  it("logs a transport failure that never produced a response", async () => {
    // Previously this path threw with no log line at all, which made a user report of "the
    // service is temporarily unavailable" impossible to diagnose from production logs.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("fetch failed"), { name: "TypeError", cause: { code: "ECONNRESET", message: "socket hang up" } })));
    await expect(createOpenAIChatProvider(settings).complete([{ role: "user", content: "hi" }], options)).rejects.toThrow(/Unable to reach/);
    expect(error).toHaveBeenCalledWith("[llm] request did not complete", expect.objectContaining({ name: "TypeError", code: "ECONNRESET" }));
  });

  it("treats an empty completion as a failure rather than a blank answer", async () => {
    // A reasoning model spends the same budget on reasoning tokens, so exhausting it returns a
    // well-formed 200 with no content.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply("", "length")));
    await expect(createOpenAIChatProvider(settings).complete([{ role: "user", content: "hi" }], options)).rejects.toThrow(/length budget/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    await expect(createOpenAIChatProvider(settings).complete([{ role: "user", content: "hi" }], options)).rejects.toThrow(/empty response/);
  });

  it("refuses a nonempty answer that stopped at the token budget", async () => {
    // finish_reason "length" means the model was cut off, not that it finished. Both callers
    // present the returned string as a complete answer, so a truncated one is shown as though it
    // were whole — a summary missing its final citation reads exactly like a summary that had
    // none. Accounting is logged; the answer text never is.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "Burlington Northern establishes that a materially adverse action" }, finish_reason: "length" }],
      usage: { prompt_tokens: 3776, completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 1200 } },
    }), { status: 200 })));
    await expect(createOpenAIChatProvider(settings).complete([{ role: "user", content: "hi" }], options)).rejects.toThrow(/cut off/);
    expect(error).toHaveBeenCalledWith("[llm] truncated completion", expect.objectContaining({ finishReason: "length", completionTokens: 4000, reasoningTokens: 1200 }));
    expect(error.mock.calls.flat().some((argument) => JSON.stringify(argument).includes("Burlington"))).toBe(false);
  });

  it("keeps an ordinary completion that stopped on its own", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply("a complete answer", "stop")));
    await expect(createOpenAIChatProvider(settings).complete([{ role: "user", content: "hi" }], options)).resolves.toBe("a complete answer");
    expect(log).toHaveBeenCalledWith("[llm] ok", expect.objectContaining({ finishReason: "stop" }));
  });

  it("maps upstream failures to public-safe messages and never echoes the provider body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [status, expected] of [[429, 429], [500, 503]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "prompt echoed: sk-live-secret" } }), { status })));
      const error = await createOpenAIChatProvider(settings).complete([{ role: "user", content: "hi" }], options).catch((caught: unknown) => caught) as LlmServiceError;
      expect(error).toBeInstanceOf(LlmServiceError);
      expect(error.status).toBe(expected);
      expect(error.message).not.toContain("sk-live-secret");
    }
  });

  it("is unconfigured without a server API key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(llmProvider()).toBeUndefined();
    process.env.OPENAI_API_KEY = "test-key";
    expect(llmProvider()?.model).toBe(DEFAULT_CHAT_MODEL);
  });
});

describe("reasoning effort configuration", () => {
  afterEach(() => { process.env = { ...originalEnv }; });

  it("defaults to the measured value when unset", () => {
    delete process.env.OPENAI_REASONING_EFFORT;
    expect(resolveReasoningEffort()).toBe("low");
  });

  it("rejects a value outside the provider's enum", () => {
    // A typo would otherwise reach the provider as an invalid request at the first question.
    for (const value of ["lo", "LOW ", "fastest", "1"]) {
      process.env.OPENAI_REASONING_EFFORT = value;
      expect(() => resolveReasoningEffort()).toThrow(/must be one of/);
    }
  });

  it("refuses efforts measured to break this deployment's budgets", () => {
    // "medium" ran 50-66s and spent an entire output budget on reasoning, returning nothing.
    for (const value of ["medium", "high"]) {
      process.env.OPENAI_REASONING_EFFORT = value;
      expect(() => resolveReasoningEffort()).toThrow(/not tested against this deployment/);
    }
  });

  it("allows an untested effort only behind a deliberate override", () => {
    process.env.OPENAI_REASONING_EFFORT = "medium";
    process.env[ALLOW_UNTESTED_EFFORT_ENV] = "true";
    expect(resolveReasoningEffort()).toBe("medium");
    expect(TESTED_REASONING_EFFORTS.every((effort) => (SUPPORTED_REASONING_EFFORTS as readonly string[]).includes(effort))).toBe(true);
  });

  it("accepts every tested value without an override", () => {
    for (const value of TESTED_REASONING_EFFORTS) {
      process.env.OPENAI_REASONING_EFFORT = value;
      expect(resolveReasoningEffort()).toBe(value);
    }
  });
});

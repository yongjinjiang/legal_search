import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/chat/route";

const originalEnv = { ...process.env };

const ask = (question: string) => POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) }));

afterEach(() => { process.env = { ...originalEnv }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("chat API errors", () => {
  it("returns deliberate configuration errors", async () => {
    delete process.env.OPENAI_API_KEY;
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How does search work?" }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "The technical guide is not configured yet. Search remains available." });
  });

  it("rejects malformed retrieval context before model invocation", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Explain this.", search: {} }),
    }));
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain("Invalid input");
    expect(payload.error).not.toContain("slice");
  });

  // The guide presents whatever string it gets back as a finished answer, so a completion the
  // model was cut off mid-sentence would be rendered as complete. The provider now rejects it; this
  // checks the rejection survives the two wrappers between the provider and the HTTP response
  // rather than being assumed to.
  it("fails the request when the guide answer stopped at the token budget", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const truncated = "Hybrid retrieval fuses BM25 and embedding ranks with RRF, and the benchmark shows";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: truncated }, finish_reason: "length" }],
      usage: { prompt_tokens: 9000, completion_tokens: 3200, completion_tokens_details: { reasoning_tokens: 900 } },
    }), { status: 200 })));

    const response = await ask("How does this system work end-to-end?");
    expect(response.status).toBe(503);
    const payload = await response.json() as { answer?: string; error?: string };
    expect(payload.answer).toBeUndefined();
    // ChatServiceError normalises provider faults to one public string, as it does for every other
    // 5xx from the model; the specific cause stays in the server log.
    expect(payload.error).toBe("The technical guide is temporarily unavailable.");
    // The half-finished text must not reach the visitor by any route, including the error body.
    expect(JSON.stringify(payload)).not.toContain("Hybrid retrieval fuses");
  });

  it("still answers when the model stops on its own", async () => {
    // The control for the case above: without it, a 503 could come from anything in the setup.
    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "A complete grounded answer." }, finish_reason: "stop" }],
    }), { status: 200 })));

    const response = await ask("How does this system work end-to-end?");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ answer: "A complete grounded answer." });
  });
});

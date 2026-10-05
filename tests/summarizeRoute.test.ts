import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as summarize } from "../src/app/api/summarize/route";
import { POST as search } from "../src/app/api/search/route";
import { summaryRequestSchema } from "../src/lib/chat/validation";

const originalEnv = { ...process.env };
const post = (body: unknown) => new Request("http://localhost/api/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

afterEach(() => { process.env = { ...originalEnv }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.sequential("research summary endpoint", () => {
  it("validates the request the same way search does", () => {
    expect(summaryRequestSchema.parse({ query: "retaliation question" })).toMatchObject({ queryType: "HYBRID" });
    expect(summaryRequestSchema.safeParse({ query: "ab" }).success).toBe(false);
    expect(summaryRequestSchema.safeParse({ query: "a".repeat(2001) }).success).toBe(false);
    expect(summaryRequestSchema.safeParse({ query: "valid query", queryType: "MAGIC" }).success).toBe(false);
  });

  it("rejects a malformed body as a client error", async () => {
    const response = await summarize(post("{not-json"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid summary request." });
  });

  it("reports a configuration error without generating anything", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.MOCK_SEARCH = "true";
    const response = await summarize(post({ query: "but-for causation", queryType: "FULL_TEXT" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("not configured") });
  });

  it("retrieves server-side rather than trusting passages posted by the caller", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MOCK_SEARCH = "true";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [{ text: "grounded summary", citations: [1] }] }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // A caller-supplied passage must not appear in the prompt: the request schema has no field
    // for one, and the route re-runs retrieval itself.
    const response = await summarize(post({ query: "but-for causation", queryType: "FULL_TEXT", results: [{ bestPassage: "INJECTED TEXT" }] }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { summary: string; sources: Array<{ id: number; caseName: string; pageStart: number }>; cases: Array<{ caseName: string }> };
    expect(payload.summary).toBe("grounded summary [1]");
    expect(payload.sources[0]).toMatchObject({ id: 1, caseName: payload.cases[0].caseName });
    expect(payload.sources[0].pageStart).toBeGreaterThan(0);
    expect(payload.cases.length).toBeGreaterThan(0);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { messages: Array<{ content: string }> };
    expect(body.messages[1].content).not.toContain("INJECTED TEXT");
    expect(body.messages[1].content).toContain("<retrieved_passages>");
  });

  it("fails the request rather than returning a truncated summary as a finished one", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MOCK_SEARCH = "true";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "The first case holds that" }, finish_reason: "length" }],
    }), { status: 200 })));
    const response = await summarize(post({ query: "but-for causation", queryType: "FULL_TEXT" }));
    expect(response.status).not.toBe(200);
    const payload = await response.json() as { error?: string; summary?: string };
    expect(payload.summary).toBeUndefined();
    expect(payload.error).toBeTruthy();
  });

  it("returns a safe error instead of exposing prose with an invented source ID", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MOCK_SEARCH = "true";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ blocks: [{ text: "UNVERIFIED MODEL CLAIM", citations: [99] }] }) } }],
    }), { status: 200 })));
    const response = await summarize(post({ query: "but-for causation", queryType: "FULL_TEXT" }));
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toEqual({ error: "The summary could not be verified against its source references. Try again." });
    expect(JSON.stringify(payload)).not.toContain("UNVERIFIED MODEL CLAIM");
  });
});

describe.sequential("search stays pure retrieval", () => {
  it("never invokes a language model to answer a search", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.MOCK_SEARCH;
    delete process.env.MOCK_DATABRICKS;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await search(new Request("http://localhost/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "materially adverse employment action", queryType: "FULL_TEXT" }) }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { backend: string; mock: boolean; results: Array<{ caseId: string }> };
    expect(payload).toMatchObject({ backend: "local", mock: false });
    expect(payload.results[0].caseId).toBe("burlington_white");
    // No outbound request of any kind: no search service, no embedding call, no model call.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT: missing /private/server/docs/PROJECT_CONTEXT_SUMMARY.md")),
}));

import { POST } from "../src/app/api/chat/route";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("chat API failure regression", () => {
  it("rejects a malformed JSON body as a client error without parser details", async () => {
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    }));

    // A body the client can never fix by retrying must not be reported as a retryable outage.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid chat request." });
  });

  it("does not expose document read errors or server paths", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How does retrieval work?" }),
    }));

    expect(response.status).toBe(503);
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe("The technical guide is temporarily unavailable.");
    expect(payload.error).not.toContain("ENOENT");
    expect(payload.error).not.toContain("/private/server");
  });
});

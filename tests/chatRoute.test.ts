import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/chat/route";

const originalEnv = { ...process.env };

afterEach(() => { process.env = { ...originalEnv }; });

describe("chat API errors", () => {
  it("returns deliberate configuration errors", async () => {
    delete process.env.OPENAI_API_KEY;
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ question: "How does search work?" }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "The technical guide is not configured yet. Search remains available." });
  });

  it("rejects malformed retrieval context before model invocation", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ question: "Explain this.", search: {} }),
    }));
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain("Invalid input");
    expect(payload.error).not.toContain("slice");
  });
});

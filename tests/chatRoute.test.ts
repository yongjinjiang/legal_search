import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/chat/route";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("chat API errors", () => {
  it("returns deliberate configuration errors", async () => {
    delete process.env.DATABRICKS_HOST;
    delete process.env.DATABRICKS_TOKEN;
    delete process.env.DATABRICKS_CHAT_MODEL;
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "How does search work?" }] }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "The technical guide is not configured yet. Search remains available." });
  });

  it("does not expose unexpected internal errors", async () => {
    process.env.DATABRICKS_HOST = "https://example.invalid";
    process.env.DATABRICKS_TOKEN = "secret";
    process.env.DATABRICKS_CHAT_MODEL = "model";
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Explain this." }], search: {} }),
    }));
    expect(response.status).toBe(503);
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe("The technical guide is temporarily unavailable.");
    expect(payload.error).not.toContain("slice");
  });
});

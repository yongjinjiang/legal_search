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
  it("does not expose malformed JSON parser details", async () => {
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "The technical guide is temporarily unavailable." });
  });

  it("does not expose document read errors or server paths", async () => {
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    process.env.DATABRICKS_CHAT_MODEL = "guide";
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

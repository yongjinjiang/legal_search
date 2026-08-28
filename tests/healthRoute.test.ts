import { afterEach, describe, expect, it } from "vitest";
import { GET as health } from "../src/app/api/health/route";

const originalEnv = { ...process.env };
const KEYS = ["MOCK_SEARCH", "MOCK_DATABRICKS", "SEARCH_BACKEND", "OPENAI_API_KEY", "DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_INDEX_NAME"];
const clear = () => { for (const key of KEYS) delete process.env[key]; };

afterEach(() => { process.env = { ...originalEnv }; });

describe.sequential("health route", () => {
  it("reports the committed index as serving search with no credentials at all", async () => {
    clear();
    // The point of the migration: the public site serves lexical search with no API key.
    const response = await health();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "degraded", backend: "local", searchMode: "local", searchConfigured: true, lexicalConfigured: true, semanticConfigured: false, chatConfigured: false });
  });

  it("reports ok once embedding and chat credentials are present", async () => {
    clear();
    process.env.OPENAI_API_KEY = "test-key";
    const response = await health();
    expect(response.status).toBe(200);
    const payload = await response.json() as { status: string; index: { rowCount: number; embeddingModel: string } };
    expect(payload.status).toBe("ok");
    // The manifest is surfaced so a deployment check can confirm which index actually shipped.
    expect(payload.index).toMatchObject({ rowCount: 234, embeddingModel: "text-embedding-3-large" });
  });

  it("reports mock mode without claiming the deployment can retrieve", async () => {
    clear();
    process.env.MOCK_SEARCH = "true";
    await expect((await health()).json()).resolves.toMatchObject({ searchMode: "mock", searchConfigured: true });
  });

  // The README's deployment check relies on this: a deployment that cannot serve search must
  // fail rather than report ok.
  it("fails the check when the optional Databricks backend lacks its credentials", async () => {
    clear();
    process.env.SEARCH_BACKEND = "databricks";
    const response = await health();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", backend: "databricks", searchConfigured: false });
  });

  it("fails the Databricks check when the index name alone is missing", async () => {
    clear();
    process.env.SEARCH_BACKEND = "databricks";
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    expect((await health()).status).toBe(503);
  });
});

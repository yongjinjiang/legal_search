import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as monitor } from "../src/app/api/cron/search-check/route";
import { probe } from "../src/lib/monitor/probe";

const originalEnv = { ...process.env };
const request = (headers?: Record<string, string>) => new Request("http://localhost/api/cron/search-check", { headers });
const embedding = () => new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1024).fill(0.01) }] }), { status: 200 });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.sequential("search smoke check", () => {
  it("refuses to run when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    // Fail closed: without a secret this would be a public trigger for paid embedding calls.
    const response = await monitor(request({ authorization: "Bearer anything" }));
    expect(response.status).toBe(503);
  });

  it("rejects a caller without the secret", async () => {
    process.env.CRON_SECRET = "expected";
    expect((await monitor(request())).status).toBe(401);
    expect((await monitor(request({ authorization: "Bearer wrong" }))).status).toBe(401);
  });

  // A mock run exercises a fixture, so reporting it healthy would assert nothing about retrieval.
  it("refuses to report health while running in mock mode", async () => {
    process.env.CRON_SECRET = "expected";
    process.env.MOCK_SEARCH = "true";
    const response = await monitor(request({ authorization: "Bearer expected" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ mode: "mock", healthy: false, probes: [] });
  });

  it("probes each method and counts the cases returned", async () => {
    process.env.MOCK_SEARCH = "true";
    const results = await Promise.all(["HYBRID", "ANN", "FULL_TEXT"].map((method) => probe(method as "HYBRID")));
    expect(results.every((result) => result.ok && result.cases > 0)).toBe(true);
  });

  it("reports every method healthy against the committed local index", async () => {
    process.env.CRON_SECRET = "expected";
    delete process.env.MOCK_SEARCH;
    delete process.env.MOCK_DATABRICKS;
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(embedding())));

    const response = await monitor(request({ authorization: "Bearer expected" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { mode: string; healthy: boolean; probes: Array<{ method: string }> };
    expect(payload).toMatchObject({ mode: "local", healthy: true });
    expect(payload.probes.map((entry) => entry.method)).toEqual(["HYBRID", "ANN", "FULL_TEXT"]);
  });

  // The reason this check still exists: methods fail independently. Full text needs only the
  // committed artifacts, while semantic and hybrid additionally need the embedding API.
  it("fails the run when only the embedding-dependent methods are broken", async () => {
    process.env.CRON_SECRET = "expected";
    delete process.env.MOCK_SEARCH;
    delete process.env.MOCK_DATABRICKS;
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })));

    const response = await monitor(request({ authorization: "Bearer expected" }));
    expect(response.status).toBe(503);
    const payload = await response.json() as { healthy: boolean; probes: Array<{ method: string; ok: boolean; status?: number }> };
    expect(payload.healthy).toBe(false);
    expect(payload.probes.filter((entry) => entry.ok).map((entry) => entry.method)).toEqual(["FULL_TEXT"]);
    expect(payload.probes.find((entry) => entry.method === "ANN")).toMatchObject({ ok: false, status: 429 });
  });

  it("treats an empty result set as a failure", async () => {
    process.env.CRON_SECRET = "expected";
    delete process.env.MOCK_SEARCH;
    delete process.env.MOCK_DATABRICKS;
    process.env.SEARCH_BACKEND = "databricks";
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    process.env.DATABRICKS_INDEX_NAME = "catalog.schema.index";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      manifest: { columns: ["chunk_id", "case_id", "case_name", "citation", "page_start", "page_end", "chunk_text"].map((name) => ({ name })) },
      result: { data_array: [] },
    }), { status: 200 }))));

    const response = await monitor(request({ authorization: "Bearer expected" }));
    expect(response.status).toBe(503);
    const payload = await response.json() as { healthy: boolean; probes: Array<{ ok: boolean; cases: number }> };
    expect(payload.healthy).toBe(false);
    expect(payload.probes.every((entry) => !entry.ok && entry.cases === 0)).toBe(true);
  });
});

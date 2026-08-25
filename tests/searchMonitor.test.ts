import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as monitor, probe } from "../src/app/api/cron/search-check/route";

const originalEnv = { ...process.env };
const request = (headers?: Record<string, string>) => new Request("http://localhost/api/cron/search-check", { headers });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.sequential("search monitor cron", () => {
  it("refuses to run when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await monitor(request({ authorization: "Bearer anything" }));
    expect(response.status).toBe(503);
  });

  it("rejects a caller without the cron secret", async () => {
    process.env.CRON_SECRET = "expected";
    expect((await monitor(request())).status).toBe(401);
    expect((await monitor(request({ authorization: "Bearer wrong" }))).status).toBe(401);
  });

  // A mock run exercises a local fixture, so reporting it healthy would assert nothing
  // about Databricks. The probe helper is still tested directly against mock data below.
  it("refuses to report health while running in mock mode", async () => {
    process.env.CRON_SECRET = "expected";
    process.env.MOCK_DATABRICKS = "true";
    const response = await monitor(request({ authorization: "Bearer expected" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ mode: "mock", healthy: false, probes: [] });
  });

  it("probes each method and counts the cases returned", async () => {
    process.env.MOCK_DATABRICKS = "true";
    const results = await Promise.all(["HYBRID", "ANN", "FULL_TEXT"].map((method) => probe(method as "HYBRID")));
    expect(results.every((result) => result.ok && result.cases > 0)).toBe(true);
  });

  it("reports every method healthy against a live index", async () => {
    process.env.CRON_SECRET = "expected";
    process.env.MOCK_DATABRICKS = "false";
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    process.env.DATABRICKS_INDEX_NAME = "catalog.schema.index";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      manifest: { columns: ["chunk_id", "case_id", "case_name", "citation", "page_start", "page_end", "chunk_text"].map((name) => ({ name })) },
      result: { data_array: [["chunk-1", "case-1", "Case One", "1 U.S. 1", 1, 2, "Relevant passage"]] },
    }), { status: 200 }))));

    const response = await monitor(request({ authorization: "Bearer expected" }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { mode: string; healthy: boolean; probes: Array<{ method: string }> };
    expect(payload).toMatchObject({ mode: "live", healthy: true });
    expect(payload.probes.map((entry) => entry.method)).toEqual(["HYBRID", "ANN", "FULL_TEXT"]);
  });

  it("fails the run when a method is rejected by Databricks", async () => {
    process.env.CRON_SECRET = "expected";
    process.env.MOCK_DATABRICKS = "false";
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    process.env.DATABRICKS_INDEX_NAME = "catalog.schema.index";
    // Reproduces the FULL_TEXT outage: one method rejected, the others serving normally.
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query_type: string };
      if (body.query_type === "FULL_TEXT") return Promise.resolve(new Response(JSON.stringify({ error_code: "FEATURE_DISABLED", message: "Full-text search is not enabled." }), { status: 400 }));
      return Promise.resolve(new Response(JSON.stringify({
        manifest: { columns: ["chunk_id", "case_id", "case_name", "citation", "page_start", "page_end", "chunk_text"].map((name) => ({ name })) },
        result: { data_array: [["chunk-1", "case-1", "Case One", "1 U.S. 1", 1, 2, "Relevant passage"]] },
      }), { status: 200 }));
    }));

    const response = await monitor(request({ authorization: "Bearer expected" }));
    expect(response.status).toBe(503);
    const payload = await response.json() as { mode: string; healthy: boolean; probes: Array<{ method: string; ok: boolean; status?: number }> };
    expect(payload).toMatchObject({ mode: "live", healthy: false });
    const fullText = payload.probes.find((probe) => probe.method === "FULL_TEXT");
    expect(fullText).toMatchObject({ ok: false, status: 400 });
    expect(payload.probes.filter((probe) => probe.ok).map((probe) => probe.method).sort()).toEqual(["ANN", "HYBRID"]);
  });

  it("treats an empty result set as a failure", async () => {
    process.env.CRON_SECRET = "expected";
    process.env.MOCK_DATABRICKS = "false";
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
    expect(payload.probes.every((probe) => !probe.ok && probe.cases === 0)).toBe(true);
  });
});

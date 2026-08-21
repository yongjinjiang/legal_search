import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "../src/app/api/health/route";
import { POST as search } from "../src/app/api/search/route";
import { loadProjectContext } from "../src/lib/chat/contextLoader";
import { answerProjectQuestion } from "../src/lib/databricks/chat";
import { mockSearch } from "../src/lib/search/mockSearch";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe.sequential("service integration", () => {
  it("reports mock health and serves grouped mock search results", async () => {
    process.env.MOCK_DATABRICKS = "true";
    const healthResponse = health();
    await expect(healthResponse.json()).resolves.toMatchObject({ status: "ok", searchMode: "mock" });

    const response = await search(new Request("http://localhost/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "but-for causation", queryType: "ANN", numResults: 20 }),
    }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { mock: boolean; results: Array<{ caseId: string }> };
    expect(payload.mock).toBe(true);
    expect(payload.results[0].caseId).toBe("nassar");
    expect(payload.results.length).toBeLessThanOrEqual(5);
  });

  it("calls live Databricks search through the route with server credentials", async () => {
    process.env.MOCK_DATABRICKS = "false";
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    process.env.DATABRICKS_INDEX_NAME = "catalog.schema.index";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      manifest: { columns: ["chunk_id", "case_id", "case_name", "citation", "page_start", "page_end", "chunk_text"].map((name) => ({ name })) },
      result: { data_array: [["chunk-1", "case-1", "Case One", "1 U.S. 1", 1, 2, "Relevant passage"]] },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await search(new Request("http://localhost/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "valid legal query", queryType: "HYBRID", numResults: 20 }),
    }));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("catalog.schema.index/query");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret" });
  });

  it("loads documentation and bounded retrieval state into chat context", async () => {
    const context = await loadProjectContext("standard", {
      query: "retaliation standard",
      method: "HYBRID",
      results: [{ rank: 1, caseName: "Example Case", citation: "1 U.S. 1", bestPassage: "P".repeat(1200) }],
    });
    expect(context).toContain("# Project Context Summary");
    expect(context).toContain("Question: retaliation standard");
    expect(context).not.toContain("P".repeat(901));
  });

  it("sends only the system context and current user question to chat", async () => {
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    process.env.DATABRICKS_CHAT_MODEL = "guide";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "Grounded answer" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(answerProjectQuestion("Current question", "standard")).resolves.toBe("Grounded answer");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(body.messages[1].content).toBe("Current question");
  });

  it("keeps mock retrieval deterministic and bounded", () => {
    const first = mockSearch("internal investigation", "FULL_TEXT", 3);
    const second = mockSearch("internal investigation", "FULL_TEXT", 3);
    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first[0].caseId).toBe("crawford_nashville");
  });
});

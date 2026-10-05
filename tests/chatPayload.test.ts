import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/chat/route";
import { MAX_BODY_BYTES } from "../src/lib/api/guard";
import { compactSearchContext } from "../src/lib/chat/requestContext";
import { GUIDE_PASSAGE_CHARS } from "../src/lib/limits";
import { collapseToCases } from "../src/lib/search/caseRanking";
import { readLocalIndex } from "../src/lib/search/localIndex";
import { localSearchChunks } from "../src/lib/search/localSearch";

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; vi.unstubAllGlobals(); });

describe("chat after a real corpus search", () => {
  it("projects a formerly oversized search into a valid HTTP request without losing cases", async () => {
    const index = await readLocalIndex();
    const query = "retaliation";
    const chunks = await localSearchChunks(query, "FULL_TEXT", 20, index);
    const search = { query, method: "FULL_TEXT" as const, results: collapseToCases(chunks, "FULL_TEXT") };
    const originalBody = JSON.stringify({ question: "Why did these cases rank here?", search });
    expect(Buffer.byteLength(originalBody)).toBeGreaterThan(MAX_BODY_BYTES);
    const compact = compactSearchContext(search)!;
    expect(compact.results.map((result) => result.caseName)).toEqual(search.results.map((result) => result.caseName));
    for (const result of compact.results) {
      expect(result.bestPassage.length).toBeLessThanOrEqual(GUIDE_PASSAGE_CHARS);
      expect(result).not.toHaveProperty("passages");
      expect(result.opinionSections?.length).toBeGreaterThan(0);
    }
    const body = JSON.stringify({ question: "Why did these cases rank here?", search: compact });
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES);
    process.env.OPENAI_API_KEY = "test-key";
    const provider = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "A grounded answer.", }, finish_reason: "stop" }] }), { status: 200 }));
    vi.stubGlobal("fetch", provider);
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) }, body,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ answer: "A grounded answer." });
    expect(provider).toHaveBeenCalledOnce();
    const prompt = JSON.parse(String(provider.mock.calls[0][1].body)).messages[1].content as string;
    expect(prompt).toContain("<untrusted_retrieval_state>");
    for (const result of compact.results) expect(prompt).toContain(result.caseName);
  });
});

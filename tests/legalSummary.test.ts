import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSummaryPrompt, generateLegalSummary, selectPassages } from "../src/lib/chat/summary";
import { SUMMARY_MAX_CASES, SUMMARY_MAX_PASSAGES, SUMMARY_PASSAGE_CHARS } from "../src/lib/limits";
import type { CaseResult, SearchChunk } from "../src/lib/search/types";

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; vi.unstubAllGlobals(); });

const chunk = (caseId: string, n: number, text = `${caseId} passage ${n}`): SearchChunk => ({ chunkId: `${caseId}-${n}`, caseId, caseName: `${caseId} case`, citation: `${n} U.S. ${n}`, pageStart: n, pageEnd: n + 1, chunkText: text, rank: n });
const caseResult = (caseId: string, passages: SearchChunk[]): CaseResult => ({ rank: 1, caseId, caseName: `${caseId} case`, citation: "1 U.S. 1", pageStart: 1, pageEnd: 2, bestPassage: passages[0].chunkText, method: "HYBRID", passages });

describe("research summary grounding inputs", () => {
  it("takes each case's best passage before any case's second, so one opinion cannot fill the budget", () => {
    // A 101-chunk opinion would otherwise consume the whole budget and the summary would cover
    // one case while appearing to cover five.
    const results = [caseResult("long", Array.from({ length: 20 }, (_, i) => chunk("long", i + 1))), caseResult("short", [chunk("short", 1)])];
    const selected = selectPassages(results);
    expect(selected[0].caseName).toBe("long case");
    expect(selected[1].caseName).toBe("short case");
    expect(selected.filter((passage) => passage.caseName === "short case")).toHaveLength(1);
  });

  it("never sends more than the configured case and passage budget", () => {
    const results = Array.from({ length: 12 }, (_, i) => caseResult(`case${i}`, [chunk(`case${i}`, 1), chunk(`case${i}`, 2)]));
    const selected = selectPassages(results);
    expect(selected.length).toBeLessThanOrEqual(SUMMARY_MAX_PASSAGES);
    expect(new Set(selected.map((passage) => passage.caseName)).size).toBeLessThanOrEqual(SUMMARY_MAX_CASES);
  });

  it("truncates a long passage rather than sending a whole opinion", () => {
    const selected = selectPassages([caseResult("long", [chunk("long", 1, "x".repeat(SUMMARY_PASSAGE_CHARS + 500))])]);
    expect(selected[0].text).toHaveLength(SUMMARY_PASSAGE_CHARS);
  });

  it("labels every passage with its case name and page range for citation", () => {
    const prompt = buildSummaryPrompt("Does but-for causation apply?", [caseResult("nassar", [chunk("nassar", 3)])]);
    // The citation identifies the case; the page range comes from the specific passage.
    expect(prompt).toContain("nassar case, 1 U.S. 1, pages 3–4");
    // Question and passages are delimited so the model treats both as quoted data.
    expect(prompt).toContain("<research_question>");
    expect(prompt).toContain("<retrieved_passages>");
  });

  it("instructs the model to stay inside the passages and give no legal advice", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "grounded" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLegalSummary("Does but-for causation apply?", [caseResult("nassar", [chunk("nassar", 1)])])).resolves.toBe("grounded");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(body.messages[0].content).toContain("Use only the passages supplied");
    expect(body.messages[0].content).toContain("never give personalised legal advice");
    expect(body.messages[0].content).toContain("cite its page range");
    // The question must not reach the trusted system turn.
    expect(body.messages[0].content).not.toContain("but-for causation apply");
  });

  it("refuses without credentials or without retrieved passages", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(generateLegalSummary("question", [caseResult("a", [chunk("a", 1)])])).rejects.toMatchObject({ status: 503 });
    process.env.OPENAI_API_KEY = "test-key";
    await expect(generateLegalSummary("question", [])).rejects.toMatchObject({ status: 400 });
  });
});

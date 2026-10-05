import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSummaryPrompt, generateLegalSummary, resolveSummaryDraft, selectPassages } from "../src/lib/chat/summary";
import { SUMMARY_MAX_CASES, SUMMARY_MAX_PASSAGES, SUMMARY_PASSAGE_CHARS } from "../src/lib/limits";
import type { CaseResult, SearchChunk } from "../src/lib/search/types";
import { inlineReferenceIssue } from "../src/lib/chat/summaryReferences";

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    expect(prompt).toContain("nassar case, 1 U.S. 1, PDF pages 3–4");
    // Question and passages are delimited so the model treats both as quoted data.
    expect(prompt).toContain("<research_question>");
    expect(prompt).toContain("<retrieved_passages>");
  });

  it("instructs the model to stay inside the passages and give no legal advice", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [{ text: "grounded", citations: [1] }] }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLegalSummary("Does but-for causation apply?", [caseResult("nassar", [chunk("nassar", 1)])])).resolves.toMatchObject({ summary: "grounded [1]", sources: [{ id: 1, pageStart: 1, pageEnd: 2 }] });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(body.messages[0].content).toContain("Use only the passages supplied");
    expect(body.messages[0].content).toContain("never give personalised legal advice");
    expect(body.messages[0].content).toContain("The application renders numbered references");
    // The question must not reach the trusted system turn.
    expect(body.messages[0].content).not.toContain("but-for causation apply");
  });

  it("keeps overlapping ranges separate and resolves authors and links from server sources", () => {
    const passages = [chunk("nassar", 42), chunk("nassar", 45)];
    passages[0].pageEnd = 46;
    passages[0].sourceUrl = "https://example.com/nassar.pdf";
    passages[0].opinionSections = [{ type: "dissent", author: "Ginsburg", pageStart: 31, pageEnd: 50 }];
    const rendered = resolveSummaryDraft(JSON.stringify({ blocks: [{ text: "Ginsburg's dissent discusses causation.", citations: [2, 1, 2] }] }), [caseResult("nassar", passages)]);
    expect(rendered.summary).toBe("Ginsburg's dissent discusses causation. [2] [1]");
    expect(rendered.sources.map((source) => [source.id, source.pageStart, source.pageEnd])).toEqual([[1, 42, 46], [2, 45, 46]]);
    expect(rendered.sources[0]).toMatchObject({ sourceUrl: passages[0].sourceUrl, opinionSections: passages[0].opinionSections });
    expect(rendered.sources[0]).not.toHaveProperty("text");
  });

  it.each([
    "plain unverified prose",
    JSON.stringify({ blocks: [{ text: "Holding", citations: [99] }] }),
    JSON.stringify({ blocks: [{ text: "PDF pages 42–48 show causation.", citations: [1] }] }),
    JSON.stringify({ blocks: [{ text: "Holding [9]", citations: [1] }] }),
    JSON.stringify({ blocks: [{ text: "Holding", citations: [] }] }),
    JSON.stringify({ blocks: [{ text: "Holding", citations: [1], sourceUrl: "https://attacker.example" }] }),
  ])("rejects malformed or unverifiable reference output", (raw) => {
    expect(() => resolveSummaryDraft(raw, [caseResult("nassar", [chunk("nassar", 1)])])).toThrow(/could not be verified/);
  });

  it("refuses without credentials or without retrieved passages", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(generateLegalSummary("question", [caseResult("a", [chunk("a", 1)])])).rejects.toMatchObject({ status: 503 });
    process.env.OPENAI_API_KEY = "test-key";
    await expect(generateLegalSummary("question", [])).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ["See ante, at 346–347.", "relative_pinpoint"],
    ["See supra at 350.", "relative_pinpoint"],
    ["Id., at 352.", "relative_pinpoint"],
    ["570 U.S., at 352", "reporter_pinpoint"],
    ["570 U.S. 338, 350", "reporter_pinpoint"],
    ["133 S. Ct. 2517, 2524–2525", "reporter_pinpoint"],
    ["123 F.3d 100, at 105", "reporter_pinpoint"],
    ["PDF pp. 42–46", "pdf_page_reference"],
    ["pages 42–46", "pdf_page_reference"],
    ["Evidence [1, 2].", "inline_source_marker"],
  ])("recognises an unverified opinion reference: %s", (text, category) => {
    expect(inlineReferenceIssue(text)).toBe(category);
    expect(() => resolveSummaryDraft(JSON.stringify({ blocks: [{ text, citations: [1] }] }), [caseResult("a", [chunk("a", 1)])])).toThrow(/could not be verified/);
  });

  it.each([
    "Restatement § 27, Comment a, p. 385",
    "The Court cited 570 U.S. 338.",
    "The rate remained at 3 percent.",
    "The hearing began at 3 pm.",
  ])("keeps secondary citations or quantities without guessing opinion pinpoints: %s", (text) => {
    expect(inlineReferenceIssue(text)).toBeUndefined();
    expect(resolveSummaryDraft(JSON.stringify({ blocks: [{ text, citations: [1] }] }), [caseResult("a", [chunk("a", 1)])]).summary).toBe(`${text} [1]`);
  });

  it("retains verified paragraphs, reports omissions, and logs categories without model text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = [caseResult("a", [chunk("a", 1)]), caseResult("b", [chunk("b", 1)])];
    const resolved = resolveSummaryDraft(JSON.stringify({ blocks: [
      { text: "Private user detail: see ante, at 346–347.", citations: [2] },
      { text: "The supplied passage discusses causation.", citations: [1] },
    ] }), results);
    expect(resolved.summary).toBe("The supplied passage discusses causation. [1]");
    expect(resolved.sources.map((source) => source.id)).toEqual([1]);
    expect(resolved.notice).toMatch(/omitted/);
    expect(warn).toHaveBeenCalledWith("[summary] paragraph omitted", { category: "relative_pinpoint" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Private user detail");
  });

  it("still rejects an unknown source ID even in a paragraph that would be omitted", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => resolveSummaryDraft(JSON.stringify({ blocks: [
      { text: "Private detail: see ante, at 346.", citations: [99] },
      { text: "Otherwise valid.", citations: [1] },
    ] }), [caseResult("a", [chunk("a", 1)])])).toThrow(/could not be verified/);
    expect(error).toHaveBeenCalledWith("[summary] draft rejected", { category: "unknown_source_id" });
    expect(JSON.stringify(error.mock.calls)).not.toContain("Private detail");
  });

  it.each(["json", ""])("accepts a single complete %s code fence with the same strict schema", (language) => {
    const raw = `\`\`\`${language}\n${JSON.stringify({ blocks: [{ text: "Grounded.", citations: [1] }] })}\n\`\`\``;
    expect(resolveSummaryDraft(raw, [caseResult("a", [chunk("a", 1)])]).summary).toBe("Grounded. [1]");
  });

  it.each([
    ['Commentary\n```json\n{"blocks":[]}\n```', "json_parse"],
    ['```json\n{"blocks":[],"extra":"Private model detail"}\n```', "schema"],
  ])("rejects wrapped commentary or extra schema fields without logging raw output", (raw, category) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => resolveSummaryDraft(raw, [caseResult("a", [chunk("a", 1)])])).toThrow(/could not be verified/);
    expect(error).toHaveBeenCalledWith("[summary] draft rejected", { category });
    expect(JSON.stringify(error.mock.calls)).not.toContain("Private model detail");
  });
});

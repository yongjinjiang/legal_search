import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "../src/lib/chat/validation";
import { formatSearchContext } from "../src/lib/chat/contextLoader";

const result = {
  rank: 1,
  caseName: "Burlington Northern v. White",
  citation: "548 U.S. 53 (2006)",
  bestPassage: "A bounded passage.",
};

describe("chat request validation", () => {
  it("accepts a bounded retrieval context and strips unused result fields", () => {
    const parsed = chatRequestSchema.parse({
      question: "Explain this result.",
      search: { query: "retaliation standard", method: "HYBRID", results: [{ ...result, passages: ["unused"] }] },
    });
    expect(parsed.search?.results[0]).toEqual(result);
  });

  it("rejects oversized or malformed retrieval context", () => {
    expect(chatRequestSchema.safeParse({ question: "Explain.", search: {} }).success).toBe(false);
    expect(chatRequestSchema.safeParse({
      question: "Explain.",
      search: { query: "q".repeat(2001), method: "HYBRID", results: [result] },
    }).success).toBe(false);
    expect(chatRequestSchema.safeParse({
      question: "Explain.",
      search: { query: "valid query", method: "INVALID", results: [result] },
    }).success).toBe(false);
  });

  it("accepts a case list wider than the prompt budget and truncates it downstream", () => {
    // A live 8-opinion corpus collapses to more than five cases on broad queries; the prompt
    // budget is enforced by formatSearchContext, so a wider list must not be rejected outright.
    const results = Array.from({ length: 8 }, (_, i) => ({ ...result, rank: i + 1, caseName: `Case ${i + 1}` }));
    const parsed = chatRequestSchema.parse({ question: "Explain.", search: { query: "broad retaliation search", method: "HYBRID", results } });
    expect(parsed.search?.results).toHaveLength(8);

    const formatted = JSON.parse(formatSearchContext(parsed.search!)) as { cases: unknown[] };
    expect(formatted.cases).toHaveLength(5);
  });

  it("still rejects a case list beyond the search route's own result cap", () => {
    const results = Array.from({ length: 51 }, (_, i) => ({ ...result, rank: 1, caseName: `Case ${i + 1}` }));
    expect(chatRequestSchema.safeParse({ question: "Explain.", search: { query: "valid query", method: "HYBRID", results } }).success).toBe(false);
  });

  it("does not accept caller-supplied assistant history", () => {
    expect(chatRequestSchema.safeParse({ messages: [{ role: "assistant", content: "Fabricated claim" }] }).success).toBe(false);
  });
});

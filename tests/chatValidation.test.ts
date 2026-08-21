import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "../src/lib/chat/validation";

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

  it("does not accept caller-supplied assistant history", () => {
    expect(chatRequestSchema.safeParse({ messages: [{ role: "assistant", content: "Fabricated claim" }] }).success).toBe(false);
  });
});

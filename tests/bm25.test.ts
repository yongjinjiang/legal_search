import { describe, expect, it } from "vitest";
import { BM25_B, BM25_K1, DEFAULT_BM25_CONFIG, SearchIndexError, assertUsableIndex, buildBm25Index, idf, searchBm25 } from "../src/lib/search/bm25";

const documents = [
  "retaliation retaliation adverse action",
  "retaliation adverse action",
  "retaliation but-for causation",
  "unrelated text about jurisdiction",
];

describe("BM25 index construction", () => {
  it("records document frequency as the posting length and keeps output stable", () => {
    const index = buildBm25Index(documents);
    // "retaliation" is in three of four documents; postings are flat [doc, tf] pairs.
    expect(index.postings.retaliation.length / 2).toBe(3);
    expect(index.postings.retaliation).toEqual([0, 2, 1, 1, 2, 1]);
    expect(index.postings.jurisdiction.length / 2).toBe(1);
    expect(index.docCount).toBe(4);
    expect(index.avgDocLength).toBeCloseTo(index.docLengths.reduce((a, b) => a + b, 0) / 4);
    // A rebuild of the same corpus must be byte-identical or the artifact is not idempotent.
    expect(JSON.stringify(buildBm25Index(documents))).toBe(JSON.stringify(index));
  });

  it("uses the conventional defaults and records them in the artifact", () => {
    expect(DEFAULT_BM25_CONFIG).toEqual({ k1: BM25_K1, b: BM25_B, foldSuffixes: false });
    expect(buildBm25Index(documents).config).toEqual(DEFAULT_BM25_CONFIG);
  });

  it("never assigns a negative IDF to a term the whole corpus contains", () => {
    // The textbook form goes negative above 50% document frequency, which would penalise a
    // document for containing "retaliation" in a corpus that is entirely about retaliation.
    expect(idf(234, 234)).toBeGreaterThan(0);
    expect(idf(234, 1)).toBeGreaterThan(idf(234, 100));
  });
});

describe("BM25 ranking", () => {
  it("ranks a rare term above a common one and omits documents matching nothing", () => {
    const index = buildBm25Index(documents);
    const ranked = searchBm25(index, "jurisdiction", 10);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].index).toBe(3);
    expect(searchBm25(index, "nonexistentterm", 10)).toEqual([]);
  });

  it("saturates term frequency instead of scoring linearly in it", () => {
    const once = buildBm25Index(["adverse"]);
    const four = buildBm25Index(["adverse adverse adverse adverse"]);
    const single = searchBm25(once, "adverse", 1)[0].score;
    const repeated = searchBm25(four, "adverse", 1)[0].score;
    expect(repeated).toBeGreaterThan(single);
    expect(repeated).toBeLessThan(single * 4);
  });

  it("normalises by document length so padding cannot buy rank", () => {
    const index = buildBm25Index(["adverse action", `adverse action ${"padding ".repeat(50)}`]);
    const ranked = searchBm25(index, "adverse action", 10);
    expect(ranked[0].index).toBe(0);
  });

  it("counts a repeated query term once, matching Lucene", () => {
    const index = buildBm25Index(documents);
    expect(searchBm25(index, "retaliation retaliation", 4).map((d) => d.score)).toEqual(searchBm25(index, "retaliation", 4).map((d) => d.score));
  });

  it("breaks score ties deterministically on document index", () => {
    const index = buildBm25Index(["adverse action", "adverse action", "adverse action"]);
    expect(searchBm25(index, "adverse", 3).map((d) => d.index)).toEqual([0, 1, 2]);
  });

  it("refuses an index built by a different tokenizer or schema version", () => {
    const index = buildBm25Index(documents);
    expect(() => assertUsableIndex({ ...index, tokenizer: "legal-en-v0" })).toThrow(SearchIndexError);
    expect(() => assertUsableIndex({ ...index, version: 99 })).toThrow(SearchIndexError);
    expect(() => assertUsableIndex({ ...index, docLengths: [] })).toThrow(/document lengths/);
  });
});

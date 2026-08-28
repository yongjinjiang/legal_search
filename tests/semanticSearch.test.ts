import { describe, expect, it } from "vitest";
import { SearchIndexError } from "../src/lib/search/bm25";
import { assertUsableMatrix, l2Normalize, searchEmbeddings } from "../src/lib/search/semanticSearch";
import { FIXTURE_DIMENSIONS, fixtureMatrix } from "./fixtures";

describe("vector similarity", () => {
  it("normalises to unit length so the dot product is a cosine", () => {
    const unit = l2Normalize([3, 4, 0, 0]);
    expect(Math.hypot(...unit)).toBeCloseTo(1);
    expect(unit[0]).toBeCloseTo(0.6);
  });

  it("scores an exact direction match at 1 and an orthogonal one at 0", () => {
    const matrix = fixtureMatrix();
    const ranked = searchEmbeddings(matrix, [1, 0, 0, 0], 4);
    expect(ranked[0].index).toBe(0);
    expect(ranked[0].score).toBeCloseTo(1);
    expect(ranked.find((entry) => entry.index === 1)!.score).toBeCloseTo(0);
  });

  it("ranks partial alignment between the exact match and the orthogonal rows", () => {
    // Row 3 is [0, 0, 0.6, 0.8]; a query along axis 2 should score 0.6 and rank below row 2.
    const ranked = searchEmbeddings(fixtureMatrix(), [0, 0, 1, 0], 4);
    expect(ranked.map((entry) => entry.index).slice(0, 2)).toEqual([2, 3]);
    expect(ranked[1].score).toBeCloseTo(0.6);
  });

  it("refuses a query whose dimensions do not match the built index", () => {
    // A model or dimension change without an index rebuild is the realistic cause, and silently
    // scoring a truncated vector would produce a plausible but meaningless ranking.
    expect(() => searchEmbeddings(fixtureMatrix(), [1, 0, 0], 4)).toThrow(/3 dimensions but the corpus index has 4/);
    expect(() => searchEmbeddings(fixtureMatrix(), new Array(1024).fill(0.1), 4)).toThrow(SearchIndexError);
  });

  it("refuses a zero or non-finite vector rather than ranking by nothing", () => {
    expect(() => l2Normalize([0, 0, 0, 0])).toThrow(SearchIndexError);
    expect(() => l2Normalize([Number.NaN, 1, 0, 0])).toThrow(SearchIndexError);
  });

  it("refuses a matrix whose payload contradicts its header", () => {
    const matrix = fixtureMatrix();
    expect(() => assertUsableMatrix({ ...matrix, docCount: 9 })).toThrow(/not the 36 its header declares/);
    expect(() => assertUsableMatrix({ ...matrix, docCount: 0 })).toThrow(SearchIndexError);
    expect(FIXTURE_DIMENSIONS).toBe(4);
  });

  it("breaks identical scores deterministically on document index", () => {
    const ranked = searchEmbeddings(fixtureMatrix(), [0, 0, 0, 1], 4).filter((entry) => entry.score === 0);
    expect(ranked.map((entry) => entry.index)).toEqual([...ranked.map((entry) => entry.index)].sort((a, b) => a - b));
  });
});

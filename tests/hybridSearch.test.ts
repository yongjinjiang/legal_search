import { describe, expect, it } from "vitest";
import { RRF_CANDIDATE_DEPTH, RRF_K, reciprocalRankFusion } from "../src/lib/search/hybridSearch";

const list = (indices: number[]) => indices.map((index, position) => ({ index, score: 1 - position / 100 }));

describe("reciprocal rank fusion", () => {
  it("uses the documented formula over ranks, not over raw scores", () => {
    // BM25 scores are unbounded and cosine scores live in [-1, 1]; only ranks are combined.
    const fused = reciprocalRankFusion(list([7]), list([7]), 5);
    expect(fused[0].score).toBeCloseTo(2 / (RRF_K + 1));
    expect(fused[0]).toMatchObject({ index: 7, semanticRank: 1, lexicalRank: 1 });
  });

  it("rewards a document both methods rank over one that only one method found", () => {
    const fused = reciprocalRankFusion(list([1, 2]), list([2, 3]), 5);
    expect(fused[0].index).toBe(2);
    expect(fused.map((doc) => doc.index)).toEqual([2, 1, 3]);
  });

  it("gives a document missing from one list only the other term", () => {
    // Assigning a synthetic worst rank instead would make the score depend on list length.
    const fused = reciprocalRankFusion(list([4]), list([9]), 5);
    const semanticOnly = fused.find((doc) => doc.index === 4)!;
    expect(semanticOnly).toMatchObject({ score: 1 / (RRF_K + 1), semanticRank: 1 });
    expect(semanticOnly.lexicalRank).toBeUndefined();
  });

  it("ignores candidates below the fusion depth", () => {
    const deep = list(Array.from({ length: 60 }, (_, i) => i));
    const fused = reciprocalRankFusion(deep, [], 100, RRF_K, 10);
    expect(fused).toHaveLength(10);
    expect(fused.map((doc) => doc.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("breaks ties on best contributing rank, then on document index", () => {
    // Both documents appear once at rank 1 of one list, so scores are equal by construction.
    const fused = reciprocalRankFusion(list([5]), list([2]), 5);
    expect(fused.map((doc) => doc.index)).toEqual([2, 5]);
    expect(reciprocalRankFusion(list([1, 2]), list([1, 2]), 5)).toEqual(reciprocalRankFusion(list([1, 2]), list([1, 2]), 5));
  });

  it("keeps the swept defaults the evaluation documents", () => {
    expect(RRF_K).toBe(60);
    expect(RRF_CANDIDATE_DEPTH).toBe(30);
  });
});

import { describe, expect, it } from "vitest";
import { collapseToCases } from "../src/lib/search/caseRanking";
import type { SearchChunk } from "../src/lib/search/types";
const chunk = (caseId: string, rank: number): SearchChunk => ({ chunkId: `${caseId}-${rank}`, caseId, caseName: caseId.toUpperCase(), citation: `${caseId} citation`, pageStart: rank, pageEnd: rank + 1, chunkText: `${caseId} passage ${rank}`, rank });
describe("case-level ranking", () => { it("collapses duplicate case chunks and retains passages", () => { const results = collapseToCases([chunk("a", 1), chunk("a", 2), chunk("b", 3)], "HYBRID"); expect(results).toHaveLength(2); expect(results[0].passages).toHaveLength(2); expect(results[1].rank).toBe(2); }); it("orders by best chunk rank even for unordered input", () => { const results = collapseToCases([chunk("b", 5), chunk("a", 2), chunk("b", 1)], "ANN"); expect(results.map((r) => r.caseId)).toEqual(["b", "a"]); expect(results[0].bestPassage).toContain("1"); }); });

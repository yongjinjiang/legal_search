import { MAX_CASE_RESULTS, type CaseResult, type QueryType, type SearchChunk } from "./types";

export function collapseToCases(chunks: SearchChunk[], method: QueryType, limit = MAX_CASE_RESULTS): CaseResult[] {
  const ordered = [...chunks].sort((a, b) => a.rank - b.rank);
  const grouped = new Map<string, SearchChunk[]>();
  for (const chunk of ordered) grouped.set(chunk.caseId, [...(grouped.get(chunk.caseId) ?? []), chunk]);
  return [...grouped.entries()].slice(0, limit).map(([caseId, passages], index) => {
    const best = passages[0];
    return { rank: index + 1, caseId, caseName: best.caseName, citation: best.citation, pageStart: best.pageStart, pageEnd: best.pageEnd, bestPassage: best.chunkText, method, passages,
      ...(best.sourceUrl ? { sourceUrl: best.sourceUrl } : {}),
      ...(best.opinionSections ? { opinionSections: best.opinionSections } : {}),
    };
  });
}

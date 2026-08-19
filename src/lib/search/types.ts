export const QUERY_TYPES = ["HYBRID", "ANN", "FULL_TEXT"] as const;
export type QueryType = (typeof QUERY_TYPES)[number];
export type SearchChunk = { chunkId: string; caseId: string; caseName: string; citation: string; pageStart: number; pageEnd: number; chunkText: string; rank: number; score?: number };
export type CaseResult = { rank: number; caseId: string; caseName: string; citation: string; pageStart: number; pageEnd: number; bestPassage: string; method: QueryType; passages: SearchChunk[] };
export type SearchState = { query: string; method: QueryType; results: CaseResult[] };

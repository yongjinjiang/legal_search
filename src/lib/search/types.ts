export const QUERY_TYPES = ["HYBRID", "ANN", "FULL_TEXT"] as const;
// Every collapsed search returns at most this many cases. The chat context bound derives from
// it so the two cannot drift: a looser bound would let the UI send a payload the prompt budget
// silently drops, and a hard-coded tighter one would reject valid state if this cap ever grew.
export const MAX_CASE_RESULTS = 5;
export type QueryType = (typeof QUERY_TYPES)[number];
export type SearchChunk = { chunkId: string; caseId: string; caseName: string; citation: string; pageStart: number; pageEnd: number; chunkText: string; rank: number; score?: number };
export type CaseResult = { rank: number; caseId: string; caseName: string; citation: string; pageStart: number; pageEnd: number; bestPassage: string; method: QueryType; passages: SearchChunk[] };
export type SearchState = { query: string; method: QueryType; results: CaseResult[] };

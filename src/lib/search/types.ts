export const QUERY_TYPES = ["HYBRID", "ANN", "FULL_TEXT"] as const;
// Every collapsed search returns at most this many cases. The chat context bound derives from
// it so the two cannot drift: a looser bound would let the UI send a payload the prompt budget
// silently drops, and a hard-coded tighter one would reject valid state if this cap ever grew.
export const MAX_CASE_RESULTS = 5;
export type QueryType = (typeof QUERY_TYPES)[number];
export const OPINION_TYPES = ["majority", "concurrence", "dissent", "syllabus", "front_matter"] as const;
export type OpinionSection = { type: (typeof OPINION_TYPES)[number]; author?: string; pageStart: number; pageEnd: number };
export type PassageProvenance = { sourceUrl?: string; opinionSections?: OpinionSection[] };
export type SearchChunk = PassageProvenance & { chunkId: string; caseId: string; caseName: string; citation: string; pageStart: number; pageEnd: number; chunkText: string; rank: number; score?: number };
export type CaseResult = PassageProvenance & { rank: number; caseId: string; caseName: string; citation: string; pageStart: number; pageEnd: number; bestPassage: string; method: QueryType; passages: SearchChunk[] };
export type SearchState = { query: string; method: QueryType; results: CaseResult[] };

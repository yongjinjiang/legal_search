import { z } from "zod";
import { MAX_QUERY_LENGTH } from "@/lib/limits";
import { MAX_CASE_RESULTS, QUERY_TYPES } from "@/lib/search/types";

const contextResultSchema = z.object({
  rank: z.number().int().min(1).max(MAX_CASE_RESULTS),
  caseName: z.string().trim().min(1).max(300),
  citation: z.string().trim().min(1).max(200),
  bestPassage: z.string().trim().min(1).max(6000),
});

export const searchContextSchema = z.object({
  query: z.string().trim().min(3).max(2000),
  method: z.enum(QUERY_TYPES),
  // searchCases always collapses to MAX_CASE_RESULTS, so a wider list cannot come from this
  // application and is rejected rather than silently truncated.
  results: z.array(contextResultSchema).max(MAX_CASE_RESULTS),
});

export const chatRequestSchema = z.object({
  question: z.string().trim().min(1).max(3000),
  mode: z.enum(["standard", "detailed"]).default("standard"),
  search: searchContextSchema.optional(),
});

export type SearchContext = z.infer<typeof searchContextSchema>;

// The research summary re-runs retrieval on the server rather than trusting passages posted by
// the browser, so the request carries only the query and the method the visitor had selected.
export const summaryRequestSchema = z.object({
  query: z.string().trim().min(3, "Enter a more specific legal question.").max(MAX_QUERY_LENGTH, "Keep the question under 2,000 characters."),
  queryType: z.enum(QUERY_TYPES).default("HYBRID"),
});

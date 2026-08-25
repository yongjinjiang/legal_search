import { z } from "zod";
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

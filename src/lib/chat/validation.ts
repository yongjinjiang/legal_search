import { z } from "zod";
import { QUERY_TYPES } from "@/lib/search/types";

const contextResultSchema = z.object({
  rank: z.number().int().min(1).max(50),
  caseName: z.string().trim().min(1).max(300),
  citation: z.string().trim().min(1).max(200),
  bestPassage: z.string().trim().min(1).max(6000),
});

export const searchContextSchema = z.object({
  query: z.string().trim().min(3).max(2000),
  method: z.enum(QUERY_TYPES),
  // Bounded by the search route's own numResults cap, not by the prompt budget:
  // formatSearchContext trims to the top 5 cases, so a wider result set is truncated rather than rejected.
  results: z.array(contextResultSchema).max(50),
});

export const chatRequestSchema = z.object({
  question: z.string().trim().min(1).max(3000),
  mode: z.enum(["standard", "detailed"]).default("standard"),
  search: searchContextSchema.optional(),
});

export type SearchContext = z.infer<typeof searchContextSchema>;

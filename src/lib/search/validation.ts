import { z } from "zod";
import { QUERY_TYPES } from "./types";
export const searchRequestSchema = z.object({ query: z.string().trim().min(3, "Enter a more specific legal question.").max(2000, "Keep the question under 2,000 characters."), queryType: z.enum(QUERY_TYPES).default("HYBRID"), numResults: z.number().int().min(1).max(50).default(20) });

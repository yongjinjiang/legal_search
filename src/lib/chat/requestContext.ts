import { GUIDE_PASSAGE_CHARS } from "@/lib/limits";
import { MAX_CASE_RESULTS, type SearchState } from "@/lib/search/types";
import type { SearchContext } from "./validation";

/** Send only what the guide can use. SearchState also carries every full matching passage,
 *  duplicating bestPassage and exceeding the HTTP body limit on ordinary corpus searches. */
export function compactSearchContext(search?: SearchState): SearchContext | undefined {
  if (!search) return undefined;
  return {
    query: search.query,
    method: search.method,
    results: search.results.slice(0, MAX_CASE_RESULTS).map((result) => ({
      rank: result.rank,
      caseName: result.caseName,
      citation: result.citation,
      bestPassage: result.bestPassage.slice(0, GUIDE_PASSAGE_CHARS),
      ...(result.opinionSections ? { opinionSections: result.opinionSections } : {}),
    })),
  };
}

import reviewed from "../../../data/metadata/opinion_sections.json";
import type { IndexDocument } from "./artifacts";
import type { OpinionSection } from "./types";

type OpinionSource = { sourceUrl: string; pageCount: number; sections: OpinionSection[] };
const sources = reviewed.cases as Record<string, OpinionSource>;

/** Join reviewed PDF sections after artifact validation. Metadata does not change chunk text,
 *  vectors or ranking. A different corpus needs a new review, not stale section labels. */
export function attachOpinionProvenance(documents: IndexDocument[], corpusSha256: string): IndexDocument[] {
  if (corpusSha256 !== reviewed.corpusSha256) return documents;
  return documents.map((document) => {
    const source = sources[document.caseId];
    if (!source || !Number.isInteger(document.pageStart) || !Number.isInteger(document.pageEnd)
      || document.pageStart < 1 || document.pageEnd < document.pageStart || document.pageEnd > source.pageCount) return document;
    const opinionSections = source.sections
      .filter((section) => section.pageStart <= document.pageEnd && section.pageEnd >= document.pageStart)
      .map((section) => ({ ...section, pageStart: Math.max(section.pageStart, document.pageStart), pageEnd: Math.min(section.pageEnd, document.pageEnd) }));
    return { ...document, sourceUrl: source.sourceUrl, opinionSections };
  });
}

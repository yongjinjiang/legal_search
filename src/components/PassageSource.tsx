import { opinionLabel } from "@/lib/search/opinionLabels";
import type { PassageProvenance } from "@/lib/search/types";

export function PassageSource({ pageStart, pageEnd, sourceUrl, opinionSections }: PassageProvenance & { pageStart: number; pageEnd: number }) {
  return <div className="passage-source">
    <span>PDF pages {pageStart}–{pageEnd}</span>
    <span className="opinion-label" title="Section labels use PDF page boundaries. A boundary page can contain more than one opinion.">{opinionLabel(opinionSections)}</span>
    {sourceUrl && <a href={`${sourceUrl}#page=${pageStart}`} target="_blank" rel="noopener noreferrer" aria-label={`Open source PDF at page ${pageStart} (new tab)`}>Open source PDF ↗</a>}
  </div>;
}

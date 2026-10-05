import type { OpinionSection } from "./types";

const LABELS: Record<OpinionSection["type"], string> = {
  majority: "Court opinion",
  concurrence: "Concurrence",
  dissent: "Dissent",
  syllabus: "Syllabus (headnote)",
  front_matter: "Counsel / front matter",
};

/** Page-level attribution, not a claim that every sentence on a boundary page has one author. */
export function opinionLabel(sections?: OpinionSection[]): string {
  if (!sections?.length) return "Opinion type unclassified";
  const labels = sections.map((section) => `${LABELS[section.type]}${section.author ? ` — ${section.author}` : ""}`);
  return `${sections.length > 1 ? "Mixed sections: " : ""}${labels.join(" / ")}`;
}

export function opinionAttribution(sections?: OpinionSection[]): string {
  if (!sections?.length) return "Opinion type unclassified; do not assume this is the Court's opinion.";
  const labels = sections.map((section) => `${LABELS[section.type]}${section.author ? ` by ${section.author}` : ""}, PDF pages ${section.pageStart}–${section.pageEnd}`);
  return `${sections.length > 1 ? "Mixed sections (page-level boundaries; identify the speaker from the text): " : ""}${labels.join("; ")}`;
}

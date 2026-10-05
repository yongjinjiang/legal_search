import type { PassageProvenance } from "@/lib/search/types";

export type SummarySource = PassageProvenance & {
  id: number;
  caseName: string;
  citation: string;
  pageStart: number;
  pageEnd: number;
};

export type LegalSummary = { summary: string; sources: SummarySource[] };

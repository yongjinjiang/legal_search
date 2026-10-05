import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import reviewed from "../data/metadata/opinion_sections.json";
import { PassageSource } from "../src/components/PassageSource";
import { parseCsv } from "../scripts/lib/csv";
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from "../src/lib/chat/summary";
import { collapseToCases } from "../src/lib/search/caseRanking";
import { corpusDigest, readLocalIndex } from "../src/lib/search/localIndex";
import { attachOpinionProvenance } from "../src/lib/search/opinionProvenance";
import type { IndexDocument } from "../src/lib/search/artifacts";
import { opinionLabel } from "../src/lib/search/opinionLabels";

describe("reviewed source attribution", () => {
  it("uses an unambiguous label for three mixed sections including front matter", () => {
    expect(opinionLabel([
      { type: "syllabus", pageStart: 1, pageEnd: 1 },
      { type: "front_matter", pageStart: 1, pageEnd: 1 },
      { type: "majority", author: "Breyer", pageStart: 1, pageEnd: 1 },
    ])).toBe("Mixed sections: Syllabus (headnote) / Counsel and front matter / Court opinion — Breyer");
  });
  it("covers all corpus pages and uses the canonical source URLs without changing text or digest", async () => {
    const metadata = parseCsv(readFileSync("data/metadata/metadata.csv", "utf8"));
    expect(Object.keys(reviewed.cases)).toHaveLength(8);
    for (const [caseId, source] of Object.entries(reviewed.cases)) {
      expect(source.sourceUrl).toBe(metadata.find((row) => row.case_id === caseId)?.source_url);
      for (let page = 1; page <= source.pageCount; page += 1) expect(source.sections.some((section) => page >= section.pageStart && page <= section.pageEnd)).toBe(true);
    }
    const index = await readLocalIndex();
    expect(corpusDigest(index.documents)).toBe(index.manifest.corpusSha256);
    for (const document of index.documents) {
      expect(document.sourceUrl).toMatch(/^https:\/\/(tile\.loc\.gov|www\.supremecourt\.gov)\//);
      expect(document.opinionSections?.length).toBeGreaterThan(0);
      for (const section of document.opinionSections!) {
        expect(section.pageStart).toBeGreaterThanOrEqual(document.pageStart);
        expect(section.pageEnd).toBeLessThanOrEqual(document.pageEnd);
      }
    }
  });

  it("identifies Nassar's dissent and keeps its shared boundary page mixed", async () => {
    const index = await readLocalIndex();
    const dissent = index.documents.find((doc) => doc.caseId === "nassar" && doc.pageStart === 46 && doc.pageEnd === 48)!;
    expect(dissent).toBeDefined();
    expect(dissent.opinionSections).toEqual([{ type: "dissent", author: "Ginsburg", pageStart: 46, pageEnd: 48 }]);
    const boundary = index.documents.find((doc) => doc.caseId === "nassar" && doc.pageStart <= 26 && doc.pageEnd >= 26)!;
    expect(boundary.opinionSections?.map((section) => section.type)).toEqual(["majority", "dissent"]);
    const [result] = collapseToCases([{ ...dissent, rank: 1 }], "HYBRID");
    expect(result.opinionSections).toEqual(dissent.opinionSections);
    const prompt = buildSummaryPrompt("Does but-for causation apply?", [result]);
    expect(prompt).toContain("Dissent by Ginsburg, PDF pages 46–48");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("never to the Court's holding");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("A dissent's description of the majority");
    const html = renderToStaticMarkup(createElement(PassageSource, dissent));
    expect(html).toContain("#page=46");
    expect(html).toContain("Dissent — Ginsburg");
    expect(html).toContain("PDF pages 46–48");
  });

  it("separates the two Bostock dissent authors and does not guess for a changed corpus", async () => {
    const index = await readLocalIndex();
    const kavanaugh = index.documents.find((doc) => doc.caseId === "bostock_clayton" && doc.pageStart >= 145)!;
    expect(kavanaugh.opinionSections?.every((section) => section.type === "dissent" && section.author === "Kavanaugh")).toBe(true);
    const plain: IndexDocument = { chunkId: "unknown", caseId: "nassar", caseName: "New text", citation: "570 U.S. 338", pageStart: 46, pageEnd: 48, chunkText: "A different corpus." };
    expect(attachOpinionProvenance([plain], "changed-corpus")).toEqual([plain]);
    expect(attachOpinionProvenance([{ ...plain, caseId: "unknown" }], reviewed.corpusSha256)[0]).not.toHaveProperty("opinionSections");
    const unknownPrompt = buildSummaryPrompt("question", collapseToCases([{ ...plain, rank: 1 }], "ANN"));
    expect(unknownPrompt).toContain("Opinion type unclassified; do not assume");
  });
});

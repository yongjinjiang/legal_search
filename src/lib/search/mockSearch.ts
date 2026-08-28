import type { QueryType, SearchChunk } from "./types";

// Fixtures for credential-free frontend work, selected by keyword rather than retrieved. Every
// passage says so in its own text, so a mock result cannot be mistaken for a measured ranking
// even if it is copied out of the page. Production must never enable this path.

const cases = [
  ["thompson_nas", "Thompson v. North American Stainless, LP", "562 U.S. 170 (2011)", 4, 6, "Title VII's antiretaliation provision must be construed to cover a broad range of employer conduct. Firing the fiancé of an employee who filed an EEOC charge may dissuade that employee from protected activity."],
  ["burlington_white", "Burlington Northern & Santa Fe Railway Co. v. White", "548 U.S. 53 (2006)", 12, 14, "A plaintiff must show that a reasonable employee would have found the challenged action materially adverse—meaning it might have dissuaded a reasonable worker from making or supporting a charge of discrimination."],
  ["nassar", "University of Texas Southwestern Medical Center v. Nassar", "570 U.S. 338 (2013)", 32, 35, "Title VII retaliation claims require proof that the desire to retaliate was the but-for cause of the challenged employment action."],
  ["crawford_nashville", "Crawford v. Metropolitan Government of Nashville and Davidson County", "555 U.S. 271 (2009)", 5, 7, "The opposition clause can protect an employee who reports discrimination while answering questions during an employer's internal investigation."],
  ["kasten_saint_gobain", "Kasten v. Saint-Gobain Performance Plastics Corp.", "563 U.S. 1 (2011)", 10, 13, "The statutory phrase filed any complaint includes oral as well as written complaints when the employer receives fair notice."],
  ["murray_ubs", "Murray v. UBS Securities, LLC", "601 U.S. 23 (2024)", 8, 10, "A whistleblower invoking 18 U.S.C. §1514A need not prove that the employer acted with retaliatory intent; the protected activity must be a contributing factor."],
] as const;

export function mockSearch(query: string, method: QueryType, limit: number): SearchChunk[] {
  const q = query.toLowerCase();
  const order = [...cases];
  const prioritize = q.includes("fiancé") || q.includes("someone close") ? "thompson_nas" : q.includes("but-for") || q.includes("causation") ? "nassar" : q.includes("oral") || q.includes("wage") ? "kasten_saint_gobain" : q.includes("internal investigation") ? "crawford_nashville" : q.includes("securities") || q.includes("whistleblower") ? "murray_ubs" : "burlington_white";
  order.sort((a, b) => Number(b[0] === prioritize) - Number(a[0] === prioritize));
  return order.flatMap((item, caseRank) => [0, 1].map((extra) => ({ chunkId: `${item[0]}__${caseRank * 2 + extra + 1}`, caseId: item[0], caseName: item[1], citation: item[2], pageStart: item[3] + extra, pageEnd: item[4] + extra, chunkText: extra ? `${item[5]} [MOCK DEVELOPMENT RESULT] This additional passage is included to demonstrate case-level grouping in mock mode.` : `${item[5]} [MOCK DEVELOPMENT RESULT — not retrieved from the corpus]`, rank: caseRank * 2 + extra + 1 }))).slice(0, limit);
}

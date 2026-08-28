import { describe, expect, it } from "vitest";
import { TOKENIZER_VERSION, foldSuffix, normalizeText, tokenize } from "../src/lib/search/tokenize";

describe("legal text tokenizer", () => {
  it("folds typographic punctuation that would otherwise split a term in two", () => {
    // The corpus writes "fiancé" and "employer’s"; a query typed as "fiance" and "employer's"
    // has to reach the same terms or Q05 stops matching on its most distinctive word.
    expect(normalizeText("Employer’s fiancé — 18 U.S.C. § 2000e–3")).toBe("employer's fiance - 18 u.s.c.  section  2000e-3");
    expect(tokenize("fiancé")).toEqual(tokenize("fiance"));
    expect(tokenize("employer’s")).toEqual(["employer"]);
  });

  it("keeps legally meaningful terms retrievable from either surface form", () => {
    expect(tokenize("Title VII")).toEqual(["title", "vii"]);
    // A compound is indexed under its full form, its separator-free form, and its parts, so an
    // opinion writing "but-for" is reachable from a query writing "but for".
    expect(tokenize("but-for")).toEqual(["but-for", "butfor", "but", "for"]);
    expect(tokenize("Sarbanes-Oxley")).toEqual(["sarbanes-oxley", "sarbanesoxley", "sarbanes", "oxley"]);
    expect(tokenize("§1514A")).toEqual(["section", "1514a"]);
    expect(tokenize("18 U.S.C.")).toEqual(["18", "u.s.c", "usc"]);
    for (const term of ["retaliation", "causation", "adverse", "action"]) expect(tokenize(`the ${term}`)).toContain(term);
  });

  it("drops single characters from abbreviations but preserves whole numbers", () => {
    expect(tokenize("u.s.c")).not.toContain("u");
    expect(tokenize("2000e-3")).toEqual(["2000e-3", "2000e3", "2000e"]);
  });

  it("is deterministic and version-stamped so a built index can be invalidated", () => {
    const text = "Title VII retaliation, but-for causation, and adverse action.";
    expect(tokenize(text)).toEqual(tokenize(text));
    expect(TOKENIZER_VERSION).toBe("legal-en-v1");
  });

  it("folds suffixes conservatively when the option is enabled", () => {
    expect(tokenize("complaints", { foldSuffixes: true })).toEqual(["complaint"]);
    expect(tokenize("complaints")).toEqual(["complaints"]);
    // Short and doctrinally loaded tokens must survive: "vii" and "sex" carry the query.
    for (const term of ["vii", "sex", "us", "process", "analysis"]) expect(foldSuffix(term)).toBe(term);
    expect(foldSuffix("1514a")).toBe("1514a");
  });
});

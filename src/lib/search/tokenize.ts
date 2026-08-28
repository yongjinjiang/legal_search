// Deterministic tokenizer for English legal text. The offline index builder and the runtime
// query path both import this module, so a change here invalidates the built artifact rather
// than silently skewing query terms against document terms. TOKENIZER_VERSION is recorded in
// the manifest and checked at load.
export const TOKENIZER_VERSION = "legal-en-v1";

// Suffix folding is a tunable, not a default. It is exposed so the benchmark can measure it
// instead of it being assumed helpful; see docs/LOCAL_RETRIEVAL_EVALUATION.md.
export type TokenizerOptions = { foldSuffixes?: boolean };

const DIACRITIC = /\p{Diacritic}/gu;
// Legal text is full of typographic punctuation that must not create distinct terms:
// "fiancé"/"fiance", "employer’s"/"employer's", and "§ 2000e–3" all have to collapse.
const APOSTROPHES = /[‘’ʼ′]/g;
const QUOTES = /[“”″]/g;
const DASHES = /[‐-―−]/g;
// A section sign carries meaning ("§1514A" is a citation), so it becomes a searchable word
// rather than being dropped. Opinions that spell out "Section 1514A" then match the same term.
const SECTION = /[§]+/g;

// A term is alphanumeric runs joined by the separators that appear inside single legal tokens:
// "but-for", "u.s.c", "sarbanes-oxley", "employer's", "1514a".
const TERM = /[a-z0-9]+(?:['.-][a-z0-9]+)*/g;

export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(DIACRITIC, "")
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')
    .replace(DASHES, "-")
    .replace(SECTION, " section ");
}

/** Light suffix folding. Deliberately conservative: it never rewrites a token shorter than
 *  five characters, so "vii", "sex", and "ss"-final words such as "process" survive intact. */
export function foldSuffix(term: string): string {
  if (term.length < 5 || /\d/.test(term)) return term;
  if (term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.endsWith("sses")) return term.slice(0, -2);
  if (term.endsWith("es") && /(?:s|x|z|ch|sh)es$/.test(term)) return term.slice(0, -2);
  if (term.endsWith("s") && !/(?:ss|us|is)$/.test(term)) return term.slice(0, -1);
  if (term.endsWith("ing") && term.length >= 7) return term.slice(0, -3);
  if (term.endsWith("ed") && term.length >= 6) return term.slice(0, -2);
  return term;
}

/** Expand one surface form into the terms it should match.
 *
 *  A compound is indexed under its full form, its separator-free form, and its parts, so that
 *  "but-for" in an opinion is reachable from "but-for", "butfor", and "but for" in a query, and
 *  "u.s.c" is reachable from "usc". Parts shorter than two characters are dropped because the
 *  individual letters of an abbreviation carry no retrieval signal. */
function expand(surface: string): string[] {
  const possessiveStripped = surface.endsWith("'s") ? surface.slice(0, -2) : surface;
  const base = possessiveStripped.replace(/^[.'-]+|[.'-]+$/g, "");
  if (!base) return [];
  if (!/['.-]/.test(base)) return [base];
  const joined = base.replace(/['.-]/g, "");
  const parts = base.split(/['.-]+/).filter((part) => part.length > 1);
  // Set semantics keep a single occurrence from inflating term frequency, while distinct
  // variants still each contribute once.
  return [...new Set([base, joined, ...parts].filter(Boolean))];
}

export function tokenize(text: string, options: TokenizerOptions = {}): string[] {
  const tokens: string[] = [];
  for (const match of normalizeText(text).matchAll(TERM)) {
    for (const term of expand(match[0])) tokens.push(options.foldSuffixes ? foldSuffix(term) : term);
  }
  return tokens;
}

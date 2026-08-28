import { TOKENIZER_VERSION, tokenize, type TokenizerOptions } from "./tokenize";

// Conventional Robertson/Sparck-Jones defaults. They are constants rather than literals so the
// benchmark can vary them and the manifest can record what the artifact was built with.
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const BM25_INDEX_VERSION = 2;

export type Bm25Config = { k1: number; b: number; foldSuffixes: boolean };
export const DEFAULT_BM25_CONFIG: Bm25Config = { k1: BM25_K1, b: BM25_B, foldSuffixes: false };

/** Postings are stored flat as [docIndex, termFrequency, …] pairs. A nested object per posting
 *  roughly triples the artifact for no gain; document frequency is the pair count. */
export type Bm25Index = {
  version: number;
  tokenizer: string;
  /** Digest of the corpus these postings were derived from; cross-checked at load. */
  corpusSha256: string;
  config: Bm25Config;
  docCount: number;
  avgDocLength: number;
  docLengths: number[];
  postings: Record<string, number[]>;
};

export type ScoredDoc = { index: number; score: number };

export class SearchIndexError extends Error {}

export function buildBm25Index(documents: string[], config: Bm25Config = DEFAULT_BM25_CONFIG, corpusSha256 = ""): Bm25Index {
  const options: TokenizerOptions = { foldSuffixes: config.foldSuffixes };
  const postings: Record<string, number[]> = {};
  const docLengths: number[] = [];
  documents.forEach((text, docIndex) => {
    const terms = tokenize(text, options);
    docLengths.push(terms.length);
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    // Sorting keeps the serialized artifact byte-identical across rebuilds of the same corpus,
    // which is what makes `npm run build:index` idempotent and reviewable in a diff.
    for (const term of [...counts.keys()].sort()) (postings[term] ??= []).push(docIndex, counts.get(term)!);
  });
  const totalLength = docLengths.reduce((sum, length) => sum + length, 0);
  return {
    version: BM25_INDEX_VERSION,
    tokenizer: TOKENIZER_VERSION,
    corpusSha256,
    config,
    docCount: documents.length,
    avgDocLength: documents.length > 0 ? totalLength / documents.length : 0,
    docLengths,
    postings: Object.fromEntries([...Object.keys(postings)].sort().map((term) => [term, postings[term]])),
  };
}

/** Lucene's non-negative IDF variant. The textbook form goes negative for terms present in more
 *  than half the corpus, which in a 234-chunk single-topic corpus would penalise documents for
 *  containing "retaliation". */
export function idf(docCount: number, docFrequency: number): number {
  return Math.log(1 + (docCount - docFrequency + 0.5) / (docFrequency + 0.5));
}

export function assertUsableIndex(index: Bm25Index): void {
  if (index.version !== BM25_INDEX_VERSION) throw new SearchIndexError(`BM25 index version ${index.version} does not match the expected ${BM25_INDEX_VERSION}.`);
  if (index.tokenizer !== TOKENIZER_VERSION) throw new SearchIndexError(`BM25 index was built with tokenizer ${index.tokenizer}, not ${TOKENIZER_VERSION}.`);
  if (!Array.isArray(index.docLengths) || index.docLengths.length !== index.docCount) throw new SearchIndexError("BM25 index document lengths do not match its document count.");
  if (!(index.avgDocLength > 0)) throw new SearchIndexError("BM25 index has no average document length.");
  if (!index.postings || typeof index.postings !== "object") throw new SearchIndexError("BM25 index has no postings.");
}

/** Score every document containing at least one query term.
 *
 *  Query terms are de-duplicated, matching Lucene: a term repeated in the query does not
 *  multiply its own contribution. Documents matching no term are absent rather than scored 0,
 *  so the lexical candidate list stays short on a narrow query. */
export function searchBm25(index: Bm25Index, query: string, limit: number): ScoredDoc[] {
  assertUsableIndex(index);
  const { k1, b } = index.config;
  const terms = [...new Set(tokenize(query, { foldSuffixes: index.config.foldSuffixes }))];
  const scores = new Map<number, number>();
  for (const term of terms) {
    const posting = index.postings[term];
    if (!posting) continue;
    const weight = idf(index.docCount, posting.length / 2);
    for (let i = 0; i < posting.length; i += 2) {
      const docIndex = posting[i];
      const tf = posting[i + 1];
      const norm = 1 - b + (b * index.docLengths[docIndex]) / index.avgDocLength;
      scores.set(docIndex, (scores.get(docIndex) ?? 0) + (weight * (tf * (k1 + 1))) / (tf + k1 * norm));
    }
  }
  return rankScores(scores, limit);
}

/** Shared descending ranking with a deterministic tie-break on document index, so two documents
 *  with identical scores always appear in the same order for the same corpus. */
export function rankScores(scores: Map<number, number>, limit: number): ScoredDoc[] {
  return [...scores.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit);
}

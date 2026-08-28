import { rankScores, SearchIndexError, type ScoredDoc } from "./bm25";

/** Corpus vectors held as one contiguous Float32Array: 234 × 512 floats is 479 KB, so a linear
 *  scan is a sub-millisecond loop and no vector database is warranted. Row `i` of the matrix
 *  corresponds to document `i` in the same order as the BM25 index and the document table. */
export type EmbeddingMatrix = { data: Float32Array; docCount: number; dimensions: number; model: string; corpusSha256: string };

export function l2Normalize(vector: number[]): Float32Array {
  const normalized = new Float32Array(vector.length);
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  // A zero vector has no direction; scoring it would silently rank the corpus by nothing.
  if (!(sumOfSquares > 0) || !Number.isFinite(sumOfSquares)) throw new SearchIndexError("Embedding vector is empty or not finite.");
  const scale = 1 / Math.sqrt(sumOfSquares);
  for (let i = 0; i < vector.length; i += 1) normalized[i] = vector[i] * scale;
  return normalized;
}

export function assertUsableMatrix(matrix: EmbeddingMatrix): void {
  if (!(matrix.docCount > 0) || !(matrix.dimensions > 0)) throw new SearchIndexError("Embedding matrix is empty.");
  if (matrix.data.length !== matrix.docCount * matrix.dimensions) throw new SearchIndexError(`Embedding matrix holds ${matrix.data.length} values, not the ${matrix.docCount * matrix.dimensions} its header declares.`);
}

/** Rank documents by cosine similarity to the query.
 *
 *  Corpus rows are stored L2-normalised by the offline builder and the query vector is
 *  normalised here, so the cosine reduces to a dot product and the loop stays a plain
 *  multiply-accumulate over `docCount × dimensions` floats. */
export function searchEmbeddings(matrix: EmbeddingMatrix, queryVector: number[], limit: number): ScoredDoc[] {
  assertUsableMatrix(matrix);
  if (queryVector.length !== matrix.dimensions) throw new SearchIndexError(`Query embedding has ${queryVector.length} dimensions but the corpus index has ${matrix.dimensions}.`);
  const query = l2Normalize(queryVector);
  const scores = new Map<number, number>();
  for (let doc = 0; doc < matrix.docCount; doc += 1) {
    const offset = doc * matrix.dimensions;
    let dot = 0;
    for (let i = 0; i < matrix.dimensions; i += 1) dot += matrix.data[offset + i] * query[i];
    scores.set(doc, dot);
  }
  return rankScores(scores, limit);
}

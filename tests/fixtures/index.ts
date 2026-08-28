import { ARTIFACT_VERSION, EMBEDDING_DTYPE, type IndexDocument, type IndexManifest, type LocalSearchIndex } from "../../src/lib/search/artifacts";
import { DEFAULT_BM25_CONFIG, buildBm25Index } from "../../src/lib/search/bm25";
import { corpusDigest } from "../../src/lib/search/localIndex";
import { l2Normalize, type EmbeddingMatrix } from "../../src/lib/search/semanticSearch";

export const FIXTURE_MODEL = "fixture-embed";
export const FIXTURE_DIMENSIONS = 4;

/** Four chunks across three cases, one of which owns two. Small enough to reason about by hand
 *  and shaped to exercise case collapse: `long_case` contributes consecutive chunks. */
export const fixtureDocuments: IndexDocument[] = [
  { chunkId: "c1", caseId: "burlington", caseName: "Burlington v. White", citation: "548 U.S. 53 (2006)", pageStart: 1, pageEnd: 2, chunkText: "A materially adverse action might dissuade a reasonable worker from making a charge of discrimination." },
  { chunkId: "c2", caseId: "nassar", caseName: "UT Southwestern v. Nassar", citation: "570 U.S. 338 (2013)", pageStart: 3, pageEnd: 4, chunkText: "Title VII retaliation claims require proof of but-for causation rather than a motivating factor." },
  { chunkId: "c3", caseId: "long_case", caseName: "Long Opinion", citation: "590 U.S. 644 (2020)", pageStart: 5, pageEnd: 6, chunkText: "An employer who fires a worker because of sex violates Title VII regardless of other motives." },
  { chunkId: "c4", caseId: "long_case", caseName: "Long Opinion", citation: "590 U.S. 644 (2020)", pageStart: 7, pageEnd: 8, chunkText: "The same opinion continues discussing sex discrimination and the ordinary meaning of because of sex." },
];

// Deliberately hand-written rather than generated: each row is a unit axis so a dot product with
// a query is readable, and the tests can assert exact orderings.
const RAW_VECTORS: number[][] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0.6, 0.8],
];

export const fixtureDigest = () => corpusDigest(fixtureDocuments);

export function fixtureMatrix(): EmbeddingMatrix {
  const data = new Float32Array(fixtureDocuments.length * FIXTURE_DIMENSIONS);
  RAW_VECTORS.forEach((vector, row) => data.set(l2Normalize(vector), row * FIXTURE_DIMENSIONS));
  return { data, docCount: fixtureDocuments.length, dimensions: FIXTURE_DIMENSIONS, model: FIXTURE_MODEL, corpusSha256: fixtureDigest() };
}

export function fixtureEmbeddingArtifact(overrides: Record<string, unknown> = {}) {
  const matrix = fixtureMatrix();
  return {
    version: ARTIFACT_VERSION,
    provider: "fixture",
    model: FIXTURE_MODEL,
    dimensions: FIXTURE_DIMENSIONS,
    count: fixtureDocuments.length,
    corpusSha256: fixtureDigest(),
    dtype: EMBEDDING_DTYPE,
    normalized: true,
    data: Buffer.from(matrix.data.buffer, matrix.data.byteOffset, matrix.data.byteLength).toString("base64"),
    ...overrides,
  };
}

export function fixtureManifest(overrides: Partial<IndexManifest> = {}): IndexManifest {
  return {
    version: ARTIFACT_VERSION,
    generatedAt: "2026-01-01T00:00:00.000Z",
    rowCount: fixtureDocuments.length,
    sourceFile: "tests/fixtures/index.ts",
    sourceSha256: "0".repeat(64),
    corpusSha256: fixtureDigest(),
    embedding: { provider: "fixture", model: FIXTURE_MODEL, dimensions: FIXTURE_DIMENSIONS },
    bm25: DEFAULT_BM25_CONFIG,
    tokenizerVersion: "legal-en-v1",
    ...overrides,
  };
}

export function fixtureIndex(): LocalSearchIndex {
  return {
    manifest: fixtureManifest(),
    documents: fixtureDocuments,
    bm25: buildBm25Index(fixtureDocuments.map((document) => document.chunkText), DEFAULT_BM25_CONFIG, fixtureDigest()),
    embeddings: fixtureMatrix(),
  };
}

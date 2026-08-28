import { describe, expect, it } from "vitest";
import { ARTIFACT_VERSION, assembleIndex, parseBm25Artifact, parseDocumentTable, parseEmbeddingArtifact, parseManifest } from "../src/lib/search/artifacts";
import { SearchIndexError, buildBm25Index } from "../src/lib/search/bm25";
import { chunkOrderDigest, readLocalIndex } from "../src/lib/search/localIndex";
import { searchBm25 } from "../src/lib/search/bm25";
import { fixtureDocuments, fixtureEmbeddingArtifact, fixtureManifest, fixtureMatrix } from "./fixtures";

const table = (overrides: Record<string, unknown> = {}) => ({ version: ARTIFACT_VERSION, count: fixtureDocuments.length, documents: fixtureDocuments, ...overrides });

describe("document table validation", () => {
  it("accepts a well-formed table", () => {
    expect(parseDocumentTable(table())).toHaveLength(4);
  });

  it("rejects a missing, misversioned, or miscounted table", () => {
    expect(() => parseDocumentTable(undefined)).toThrow(SearchIndexError);
    expect(() => parseDocumentTable(table({ version: 99 }))).toThrow(/unsupported version/);
    expect(() => parseDocumentTable(table({ count: 3 }))).toThrow(/declares 3 rows but holds 4/);
    expect(() => parseDocumentTable(table({ documents: [] }))).toThrow(/no documents/);
  });

  it("rejects a row missing text or with a non-numeric page range", () => {
    expect(() => parseDocumentTable(table({ documents: [{ ...fixtureDocuments[0], chunkText: "" }], count: 1 }))).toThrow(/missing chunkText/);
    expect(() => parseDocumentTable(table({ documents: [{ ...fixtureDocuments[0], pageStart: "one" }], count: 1 }))).toThrow(/invalid page range/);
  });
});

describe("embedding artifact validation", () => {
  it("round-trips the float32 payload exactly", () => {
    const matrix = parseEmbeddingArtifact(fixtureEmbeddingArtifact());
    expect(Array.from(matrix.data)).toEqual(Array.from(fixtureMatrix().data));
  });

  it("rejects a payload whose byte length contradicts its header", () => {
    // A truncated or partially rebuilt file is the realistic failure; reading it anyway would
    // silently attach vectors to the wrong chunks.
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ count: 5 }))).toThrow(/bytes but its header describes/);
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ dimensions: 8 }))).toThrow(SearchIndexError);
  });

  it("rejects the wrong dtype, an unnormalised matrix, or an empty payload", () => {
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ dtype: "float64" }))).toThrow(/dtype float64/);
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ normalized: false }))).toThrow(/not L2-normalised/);
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ data: "" }))).toThrow(/no vector payload/);
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ version: 2 }))).toThrow(/unsupported version/);
  });
});

describe("cross-artifact consistency", () => {
  const bm25 = buildBm25Index(fixtureDocuments.map((document) => document.chunkText));

  it("rejects artifacts that disagree about the corpus", () => {
    expect(() => assembleIndex(fixtureManifest({ rowCount: 3 }), fixtureDocuments, bm25, fixtureMatrix())).toThrow(/Manifest declares 3 rows/);
    expect(() => assembleIndex(fixtureManifest(), fixtureDocuments, { ...bm25, docCount: 3 }, fixtureMatrix())).toThrow(/BM25 index covers 3/);
    expect(() => assembleIndex(fixtureManifest(), fixtureDocuments, bm25, { ...fixtureMatrix(), docCount: 3 })).toThrow(/Embedding matrix covers 3/);
  });

  it("rejects an embedding matrix built with a different model or width", () => {
    expect(() => assembleIndex(fixtureManifest({ embedding: { provider: "fixture", model: "other-model", dimensions: 4 } }), fixtureDocuments, bm25, fixtureMatrix())).toThrow(/built with fixture-embed but the manifest records other-model/);
    expect(() => assembleIndex(fixtureManifest({ embedding: { provider: "fixture", model: "fixture-embed", dimensions: 8 } }), fixtureDocuments, bm25, fixtureMatrix())).toThrow(/manifest records 8/);
  });

  it("detects a reordered corpus through the chunk-order digest", () => {
    const reordered = [...fixtureDocuments].reverse().map((document) => document.chunkId);
    expect(chunkOrderDigest(reordered)).not.toBe(fixtureManifest().chunkOrderSha256);
  });

  it("rejects a manifest that does not record its embedding model", () => {
    expect(() => parseManifest({ ...fixtureManifest(), embedding: { provider: "fixture" } })).toThrow(/does not record the embedding model/);
    expect(() => parseManifest({ ...fixtureManifest(), version: 99 })).toThrow(/unsupported version/);
    expect(() => parseBm25Artifact(undefined)).toThrow(SearchIndexError);
  });
});

// Guards the artifacts that are actually deployed: they must load and serve lexical search with
// no API key, no network, and no Databricks credentials of any kind.
describe("committed search index", () => {
  it("loads and answers a lexical query offline", async () => {
    const index = await readLocalIndex();
    expect(index.documents).toHaveLength(index.manifest.rowCount);
    expect(index.manifest.rowCount).toBe(234);
    expect(index.embeddings.dimensions).toBe(index.manifest.embedding.dimensions);
    const ranked = searchBm25(index.bm25, "materially adverse employment action", 20);
    expect(ranked.length).toBeGreaterThan(0);
    expect(index.documents[ranked[0].index].caseId).toBe("burlington_white");
  });
});

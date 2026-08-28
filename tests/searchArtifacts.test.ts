import { describe, expect, it } from "vitest";
import { ARTIFACT_VERSION, assembleIndex, parseBm25Artifact, parseDocumentTable, parseEmbeddingArtifact, parseManifest } from "../src/lib/search/artifacts";
import { SearchIndexError, buildBm25Index } from "../src/lib/search/bm25";
import { corpusDigest, readLocalIndex } from "../src/lib/search/localIndex";
import { searchBm25 } from "../src/lib/search/bm25";
import { DEFAULT_BM25_CONFIG } from "../src/lib/search/bm25";
import { fixtureDigest, fixtureDocuments, fixtureEmbeddingArtifact, fixtureManifest, fixtureMatrix } from "./fixtures";

const table = (overrides: Record<string, unknown> = {}) => ({ version: ARTIFACT_VERSION, count: fixtureDocuments.length, corpusSha256: fixtureDigest(), documents: fixtureDocuments, ...overrides });
const reworded = fixtureDocuments.map((document) => ({ ...document, chunkText: `${document.chunkText} REWRITTEN` }));

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

  it("rejects a table whose contents do not match the digest it records", () => {
    // Localises a hand-edited or truncated document file to this artifact rather than blaming
    // the manifest it is compared against later.
    expect(() => parseDocumentTable(table({ documents: reworded }))).toThrow(/do not match the corpus digest it records/);
    expect(() => parseDocumentTable(table({ corpusSha256: "" }))).toThrow(/does not record which corpus/);
  });

  it("rejects a row missing text or with a non-numeric page range", () => {
    expect(() => parseDocumentTable(table({ documents: [{ ...fixtureDocuments[0], chunkText: "" }], count: 1 }))).toThrow(/missing chunkText/);
    expect(() => parseDocumentTable(table({ documents: [{ ...fixtureDocuments[0], pageStart: "one" }], count: 1 }))).toThrow(/invalid page range/);
    expect(() => parseDocumentTable(table({ documents: [], count: 0 }))).toThrow(/no documents/);
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
    // Version 1 artifacts predate the corpus digest and cannot prove what they were built from.
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ version: 1 }))).toThrow(/unsupported version/);
  });
});

describe("cross-artifact consistency", () => {
  const digest = fixtureDigest();
  const bm25 = buildBm25Index(fixtureDocuments.map((document) => document.chunkText), DEFAULT_BM25_CONFIG, digest);
  const assemble = (overrides: { manifest?: Parameters<typeof assembleIndex>[0]; bm25?: Parameters<typeof assembleIndex>[2]; embeddings?: Parameters<typeof assembleIndex>[3]; digest?: string } = {}) =>
    assembleIndex(overrides.manifest ?? fixtureManifest(), fixtureDocuments, overrides.bm25 ?? bm25, overrides.embeddings ?? fixtureMatrix(), overrides.digest ?? digest);

  it("accepts a consistent artifact set", () => {
    expect(assemble().documents).toHaveLength(4);
  });

  it("rejects artifacts that disagree about the corpus size", () => {
    expect(() => assemble({ manifest: fixtureManifest({ rowCount: 3 }) })).toThrow(/Manifest declares 3 rows/);
    expect(() => assemble({ bm25: { ...bm25, docCount: 3 } })).toThrow(/BM25 index covers 3/);
    expect(() => assemble({ embeddings: { ...fixtureMatrix(), docCount: 3 } })).toThrow(/Embedding matrix covers 3/);
  });

  // The defect this suite exists for: editing chunk_text while keeping every chunk_id lets a
  // rebuild reuse vectors for the old text, and the row counts still line up perfectly.
  it("detects rewritten passages even when every chunk ID and the row count are unchanged", () => {
    const edited = fixtureDocuments.map((document) => ({ ...document, chunkText: `${document.chunkText} REWRITTEN` }));
    const editedDigest = corpusDigest(edited);
    expect(editedDigest).not.toBe(digest);
    expect(edited.map((document) => document.chunkId)).toEqual(fixtureDocuments.map((document) => document.chunkId));
    // Stale vectors and stale postings both carry the old digest and must be refused.
    expect(() => assemble({ digest: editedDigest })).toThrow(/manifest records a different corpus/);
    expect(() => assemble({ manifest: fixtureManifest({ corpusSha256: editedDigest }) })).toThrow(/manifest records a different corpus/);
  });

  it("rejects a stale embedding matrix with the right count, model, and dimensions", () => {
    expect(() => assemble({ embeddings: { ...fixtureMatrix(), corpusSha256: "0".repeat(64) } })).toThrow(/embedding matrix was built from a different corpus/i);
  });

  it("rejects a stale BM25 index with the right document count", () => {
    expect(() => assemble({ bm25: { ...bm25, corpusSha256: "0".repeat(64) } })).toThrow(/BM25 index was built from a different corpus/);
  });

  it("rejects BM25 postings built with parameters the manifest does not describe", () => {
    // Different k1/b produce a valid index that ranks differently from what the manifest advertises.
    const retuned = buildBm25Index(fixtureDocuments.map((document) => document.chunkText), { k1: 2.0, b: 0.3, foldSuffixes: false }, digest);
    expect(() => assemble({ bm25: retuned })).toThrow(/different parameters than the manifest records/);
    const folded = buildBm25Index(fixtureDocuments.map((document) => document.chunkText), { ...DEFAULT_BM25_CONFIG, foldSuffixes: true }, digest);
    expect(() => assemble({ bm25: folded })).toThrow(/different parameters than the manifest records/);
  });

  it("rejects a tokenizer that does not match the manifest", () => {
    expect(() => assemble({ manifest: fixtureManifest({ tokenizerVersion: "legal-en-v0" }) })).toThrow(/tokenizer legal-en-v1 but the manifest records legal-en-v0/);
  });

  it("rejects an embedding matrix built with a different model or width", () => {
    expect(() => assemble({ manifest: fixtureManifest({ embedding: { provider: "fixture", model: "other-model", dimensions: 4 } }) })).toThrow(/built with fixture-embed but the manifest records other-model/);
    expect(() => assemble({ manifest: fixtureManifest({ embedding: { provider: "fixture", model: "fixture-embed", dimensions: 8 } }) })).toThrow(/manifest records 8/);
  });

  it("rejects a manifest that records no corpus digest or embedding model", () => {
    expect(() => parseManifest({ ...fixtureManifest(), embedding: { provider: "fixture" } })).toThrow(/does not record the embedding model/);
    expect(() => parseManifest({ ...fixtureManifest(), corpusSha256: "" })).toThrow(/does not record a corpus digest/);
    expect(() => parseManifest({ ...fixtureManifest(), version: 99 })).toThrow(/unsupported version/);
    expect(() => parseBm25Artifact(undefined)).toThrow(SearchIndexError);
  });

  it("rejects an embedding artifact that records no corpus digest or provider", () => {
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ corpusSha256: "" }))).toThrow(/does not record which corpus/);
    expect(() => parseEmbeddingArtifact(fixtureEmbeddingArtifact({ provider: "" }))).toThrow(/does not record which provider/);
  });

  it("rejects a matrix produced by a provider the manifest does not name", () => {
    // A model name does not imply a vector space. A hand-mixed set can otherwise agree on
    // digest, model, dimensions, and count while the vectors came from a different gateway.
    expect(() => assemble({ embeddings: { ...fixtureMatrix(), provider: "other-gateway" } })).toThrow(/produced by other-gateway but the manifest records fixture/);
  });

  it("hashes length-prefixed fields so a separator inside a passage cannot forge a match", () => {
    // A naive join would let text ending in the delimiter absorb the next field.
    const a = corpusDigest([{ chunkId: "a", chunkText: "b" }, { chunkId: "c", chunkText: "d" }]);
    const b = corpusDigest([{ chunkId: "a", chunkText: "bcd" }, { chunkId: "", chunkText: "" }]);
    expect(a).not.toBe(b);
    expect(corpusDigest(fixtureDocuments)).toBe(corpusDigest([...fixtureDocuments]));
    expect(corpusDigest([...fixtureDocuments].reverse())).not.toBe(digest);
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

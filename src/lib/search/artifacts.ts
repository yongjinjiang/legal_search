import { createHash } from "node:crypto";
import { assertUsableIndex, SearchIndexError, type Bm25Config, type Bm25Index } from "./bm25";
import { assertUsableMatrix, type EmbeddingMatrix } from "./semanticSearch";
import type { SearchChunk } from "./types";

// Bumped to 2 when corpusSha256 was added. Version 1 artifacts cannot prove which corpus they
// were built from, so they are refused rather than trusted.
export const ARTIFACT_VERSION = 2;
export const EMBEDDING_DTYPE = "float32";

export type IndexDocument = Omit<SearchChunk, "rank" | "score">;
export type DocumentTable = { version: number; count: number; corpusSha256: string; documents: IndexDocument[] };
export type EmbeddingArtifact = { version: number; provider: string; model: string; dimensions: number; count: number; corpusSha256: string; dtype: string; normalized: boolean; data: string };
export type IndexManifest = {
  version: number;
  generatedAt: string;
  rowCount: number;
  sourceFile: string;
  sourceSha256: string;
  corpusSha256: string;
  embedding: { provider: string; model: string; dimensions: number };
  bm25: Bm25Config;
  tokenizerVersion: string;
};
export type LocalSearchIndex = { manifest: IndexManifest; documents: IndexDocument[]; bm25: Bm25Index; embeddings: EmbeddingMatrix };

/** Stable fingerprint of the corpus: its order *and* its content.
 *
 *  The artifacts are positional — row `i` of the embedding matrix is document `i` — so every
 *  file has to agree on which corpus it was built from. Hashing chunk IDs alone is not enough:
 *  editing `chunk_text` while keeping `chunk_id` leaves an ID-only digest unchanged, which is
 *  exactly how stale vectors get reused for rewritten passages.
 *
 *  Fields are length-prefixed rather than joined by a delimiter, so no chunk ID or passage can
 *  contain a separator that shifts a field boundary and forges a matching digest. */
export function corpusDigest(documents: Array<{ chunkId: string; chunkText: string }>): string {
  const hash = createHash("sha256");
  for (const document of documents) {
    for (const field of [document.chunkId, document.chunkText]) hash.update(`${Buffer.byteLength(field, "utf8")}:${field}`);
  }
  return hash.digest("hex");
}

const REQUIRED_FIELDS = ["chunkId", "caseId", "caseName", "citation", "chunkText"] as const;

export function parseDocumentTable(raw: unknown): IndexDocument[] {
  const table = raw as DocumentTable;
  if (!table || typeof table !== "object" || table.version !== ARTIFACT_VERSION) throw new SearchIndexError("Document table is missing or has an unsupported version.");
  if (!Array.isArray(table.documents) || table.documents.length === 0) throw new SearchIndexError("Document table contains no documents.");
  if (table.count !== table.documents.length) throw new SearchIndexError(`Document table declares ${table.count} rows but holds ${table.documents.length}.`);
  for (const document of table.documents) {
    if (!document || typeof document !== "object") throw new SearchIndexError("Document table contains a non-object row.");
    for (const field of REQUIRED_FIELDS) if (typeof document[field] !== "string" || document[field].length === 0) throw new SearchIndexError(`Document ${document.chunkId ?? "?"} is missing ${field}.`);
    if (!Number.isFinite(document.pageStart) || !Number.isFinite(document.pageEnd)) throw new SearchIndexError(`Document ${document.chunkId} has an invalid page range.`);
  }
  // The table states which corpus it holds; recomputing localises a hand-edited or truncated
  // document file to this artifact instead of blaming the manifest it is later compared against.
  if (typeof table.corpusSha256 !== "string" || table.corpusSha256.length === 0) throw new SearchIndexError("Document table does not record which corpus it holds.");
  if (corpusDigest(table.documents) !== table.corpusSha256) throw new SearchIndexError("Document table contents do not match the corpus digest it records. Rebuild the index.");
  return table.documents;
}

/** Decode the base64 Float32 payload. Storing the vectors as JSON numbers roughly triples the
 *  artifact and reintroduces decimal rounding; base64 round-trips the exact float32 bits. */
export function parseEmbeddingArtifact(raw: unknown): EmbeddingMatrix {
  const artifact = raw as EmbeddingArtifact;
  if (!artifact || typeof artifact !== "object" || artifact.version !== ARTIFACT_VERSION) throw new SearchIndexError("Embedding artifact is missing or has an unsupported version.");
  if (artifact.dtype !== EMBEDDING_DTYPE) throw new SearchIndexError(`Embedding artifact uses dtype ${artifact.dtype}, not ${EMBEDDING_DTYPE}.`);
  if (!artifact.normalized) throw new SearchIndexError("Embedding artifact is not L2-normalised; similarity would not be a cosine.");
  if (typeof artifact.data !== "string" || artifact.data.length === 0) throw new SearchIndexError("Embedding artifact has no vector payload.");
  const bytes = Buffer.from(artifact.data, "base64");
  const expected = artifact.count * artifact.dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expected) throw new SearchIndexError(`Embedding payload is ${bytes.byteLength} bytes but its header describes ${expected}.`);
  // Buffer.from(base64) may hand back a view into a pooled ArrayBuffer, so the byteOffset is
  // required; a bare `new Float32Array(bytes.buffer)` would read neighbouring allocations.
  if (typeof artifact.corpusSha256 !== "string" || artifact.corpusSha256.length === 0) throw new SearchIndexError("Embedding artifact does not record which corpus it was built from.");
  if (typeof artifact.provider !== "string" || artifact.provider.length === 0) throw new SearchIndexError("Embedding artifact does not record which provider produced it.");
  const matrix: EmbeddingMatrix = { data: new Float32Array(bytes.buffer, bytes.byteOffset, artifact.count * artifact.dimensions), docCount: artifact.count, dimensions: artifact.dimensions, model: artifact.model, provider: artifact.provider, corpusSha256: artifact.corpusSha256 };
  assertUsableMatrix(matrix);
  return matrix;
}

export function parseBm25Artifact(raw: unknown): Bm25Index {
  const index = raw as Bm25Index;
  if (!index || typeof index !== "object") throw new SearchIndexError("BM25 index artifact is missing.");
  assertUsableIndex(index);
  return index;
}

export function parseManifest(raw: unknown): IndexManifest {
  const manifest = raw as IndexManifest;
  if (!manifest || typeof manifest !== "object" || manifest.version !== ARTIFACT_VERSION) throw new SearchIndexError("Index manifest is missing or has an unsupported version.");
  if (!manifest.embedding?.model || !Number.isFinite(manifest.embedding?.dimensions)) throw new SearchIndexError("Index manifest does not record the embedding model it was built with.");
  if (typeof manifest.corpusSha256 !== "string" || manifest.corpusSha256.length === 0) throw new SearchIndexError("Index manifest does not record a corpus digest.");
  return manifest;
}

/** Cross-check every artifact against the manifest and against the corpus actually shipped.
 *
 *  The files are built together but committed separately, so a partial rebuild — or a manually
 *  mixed set — is the realistic failure. Row counts alone do not catch it: stale vectors for
 *  rewritten passages have exactly the right count. Each artifact therefore carries the digest
 *  of the corpus it was derived from, and `corpusSha256` here is recomputed from the shipped
 *  document text rather than read from any file that could be stale.
 *
 *  BM25 configuration and tokenizer version are compared too, because postings built with
 *  different parameters score correctly but rank differently from what the manifest advertises. */
export function assembleIndex(manifest: IndexManifest, documents: IndexDocument[], bm25: Bm25Index, embeddings: EmbeddingMatrix, corpusSha256: string): LocalSearchIndex {
  if (documents.length !== manifest.rowCount) throw new SearchIndexError(`Manifest declares ${manifest.rowCount} rows but the document table holds ${documents.length}.`);
  if (bm25.docCount !== documents.length) throw new SearchIndexError(`BM25 index covers ${bm25.docCount} documents but the document table holds ${documents.length}.`);
  if (embeddings.docCount !== documents.length) throw new SearchIndexError(`Embedding matrix covers ${embeddings.docCount} documents but the document table holds ${documents.length}.`);
  if (manifest.corpusSha256 !== corpusSha256) throw new SearchIndexError("The manifest records a different corpus than the document table contains. Rebuild the index.");
  if (bm25.corpusSha256 !== corpusSha256) throw new SearchIndexError("The BM25 index was built from a different corpus than the document table contains. Rebuild the index.");
  if (embeddings.corpusSha256 !== corpusSha256) throw new SearchIndexError("The embedding matrix was built from a different corpus than the document table contains. Rebuild the index.");
  if (embeddings.dimensions !== manifest.embedding.dimensions) throw new SearchIndexError(`Embedding matrix has ${embeddings.dimensions} dimensions but the manifest records ${manifest.embedding.dimensions}.`);
  if (embeddings.model !== manifest.embedding.model) throw new SearchIndexError(`Embedding matrix was built with ${embeddings.model} but the manifest records ${manifest.embedding.model}.`);
  // A model name does not imply a vector space: OPENAI_BASE_URL admits other gateways whose
  // identically-named model need not embed into the same geometry.
  if (embeddings.provider !== manifest.embedding.provider) throw new SearchIndexError(`Embedding matrix was produced by ${embeddings.provider} but the manifest records ${manifest.embedding.provider}.`);
  if (bm25.tokenizer !== manifest.tokenizerVersion) throw new SearchIndexError(`BM25 index was built with tokenizer ${bm25.tokenizer} but the manifest records ${manifest.tokenizerVersion}.`);
  if (bm25.config.k1 !== manifest.bm25.k1 || bm25.config.b !== manifest.bm25.b || bm25.config.foldSuffixes !== manifest.bm25.foldSuffixes) throw new SearchIndexError("The BM25 index was built with different parameters than the manifest records. Rebuild the index.");
  return { manifest, documents, bm25, embeddings };
}

import { assertUsableIndex, SearchIndexError, type Bm25Config, type Bm25Index } from "./bm25";
import { assertUsableMatrix, type EmbeddingMatrix } from "./semanticSearch";
import type { SearchChunk } from "./types";

export const ARTIFACT_VERSION = 1;
export const EMBEDDING_DTYPE = "float32";

export type IndexDocument = Omit<SearchChunk, "rank" | "score">;
export type DocumentTable = { version: number; count: number; documents: IndexDocument[] };
export type EmbeddingArtifact = { version: number; provider: string; model: string; dimensions: number; count: number; dtype: string; normalized: boolean; data: string };
export type IndexManifest = {
  version: number;
  generatedAt: string;
  rowCount: number;
  sourceFile: string;
  sourceSha256: string;
  chunkOrderSha256: string;
  embedding: { provider: string; model: string; dimensions: number };
  bm25: Bm25Config;
  tokenizerVersion: string;
};
export type LocalSearchIndex = { manifest: IndexManifest; documents: IndexDocument[]; bm25: Bm25Index; embeddings: EmbeddingMatrix };

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
  const matrix: EmbeddingMatrix = { data: new Float32Array(bytes.buffer, bytes.byteOffset, artifact.count * artifact.dimensions), docCount: artifact.count, dimensions: artifact.dimensions, model: artifact.model };
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
  return manifest;
}

/** Cross-check the three artifacts against each other and against the manifest. They are built
 *  together but committed as separate files, so a partial rebuild is the realistic failure and
 *  it must surface as a configuration error rather than as a silently misaligned ranking. */
export function assembleIndex(manifest: IndexManifest, documents: IndexDocument[], bm25: Bm25Index, embeddings: EmbeddingMatrix): LocalSearchIndex {
  if (documents.length !== manifest.rowCount) throw new SearchIndexError(`Manifest declares ${manifest.rowCount} rows but the document table holds ${documents.length}.`);
  if (bm25.docCount !== documents.length) throw new SearchIndexError(`BM25 index covers ${bm25.docCount} documents but the document table holds ${documents.length}.`);
  if (embeddings.docCount !== documents.length) throw new SearchIndexError(`Embedding matrix covers ${embeddings.docCount} documents but the document table holds ${documents.length}.`);
  if (embeddings.dimensions !== manifest.embedding.dimensions) throw new SearchIndexError(`Embedding matrix has ${embeddings.dimensions} dimensions but the manifest records ${manifest.embedding.dimensions}.`);
  if (embeddings.model !== manifest.embedding.model) throw new SearchIndexError(`Embedding matrix was built with ${embeddings.model} but the manifest records ${manifest.embedding.model}.`);
  return { manifest, documents, bm25, embeddings };
}

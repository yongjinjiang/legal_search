import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assembleIndex, parseBm25Artifact, parseDocumentTable, parseEmbeddingArtifact, parseManifest, type LocalSearchIndex } from "./artifacts";
import { SearchIndexError } from "./bm25";

/** Resolved per call rather than captured at module load. A path frozen at import time silently
 *  ignores any later change of working directory, which made the loader untestable and would
 *  mask a genuine cwd difference between build and runtime. */
export function indexDir(): string { return path.join(process.cwd(), "data", "search"); }
export const ARTIFACT_FILES = { manifest: "index_manifest.json", documents: "documents.json", bm25: "bm25_index.json", embeddings: "embeddings.json" } as const;

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

async function readArtifact(file: string, dir: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path.join(dir, file), "utf8");
  } catch {
    // The filename is a repository path, not user input, so naming it aids deployment debugging.
    throw new SearchIndexError(`Search index artifact data/search/${file} is missing. Run npm run build:index.`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new SearchIndexError(`Search index artifact data/search/${file} is not valid JSON.`);
  }
}

export async function readLocalIndex(dir = indexDir()): Promise<LocalSearchIndex> {
  const [manifestRaw, documentsRaw, bm25Raw, embeddingsRaw] = await Promise.all([
    readArtifact(ARTIFACT_FILES.manifest, dir),
    readArtifact(ARTIFACT_FILES.documents, dir),
    readArtifact(ARTIFACT_FILES.bm25, dir),
    readArtifact(ARTIFACT_FILES.embeddings, dir),
  ]);
  const manifest = parseManifest(manifestRaw);
  const documents = parseDocumentTable(documentsRaw);
  // Recomputed from the text actually shipped, so the manifest cannot certify a corpus the
  // document table does not contain.
  const digest = corpusDigest(documents);
  if (manifest.corpusSha256 !== digest) throw new SearchIndexError("Search index artifacts are out of sync: the document table does not match the manifest. Rebuild the index.");
  return assembleIndex(manifest, documents, parseBm25Artifact(bm25Raw), parseEmbeddingArtifact(embeddingsRaw), digest);
}

// One parse per warm serverless instance. The promise is cached rather than the value so
// concurrent first requests share a single read, and a rejection is dropped so a transient
// failure does not poison the instance for its remaining lifetime.
let cached: Promise<LocalSearchIndex> | undefined;

export function loadLocalIndex(): Promise<LocalSearchIndex> {
  if (!cached) cached = readLocalIndex().catch((error: unknown) => { cached = undefined; throw error; });
  return cached;
}

export function resetLocalIndexCache(): void { cached = undefined; }

/** Readiness for /api/health. Loads and cross-validates the complete artifact set rather than
 *  the manifest alone: a valid manifest beside a missing or corrupt companion file is precisely
 *  the deployment that would otherwise report healthy and then fail every search. The load is
 *  cached per warm instance, so this costs one parse per instance, not one per poll. */
export async function indexReadiness(): Promise<{ ready: true; index: LocalSearchIndex } | { ready: false; reason: string }> {
  try {
    return { ready: true, index: await loadLocalIndex() };
  } catch (error) {
    return { ready: false, reason: error instanceof SearchIndexError ? error.message : "The search index could not be loaded." };
  }
}

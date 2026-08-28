import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assembleIndex, parseBm25Artifact, parseDocumentTable, parseEmbeddingArtifact, parseManifest, type IndexManifest, type LocalSearchIndex } from "./artifacts";
import { SearchIndexError } from "./bm25";

export const INDEX_DIR = path.join(process.cwd(), "data", "search");
export const ARTIFACT_FILES = { manifest: "index_manifest.json", documents: "documents.json", bm25: "bm25_index.json", embeddings: "embeddings.json" } as const;

/** Stable fingerprint of the document ordering. The three artifacts are positional — row `i` of
 *  the embedding matrix is document `i` — so a rebuild that reorders the corpus without
 *  refreshing every file would otherwise mis-attribute passages instead of failing. */
export function chunkOrderDigest(chunkIds: string[]): string {
  return createHash("sha256").update(chunkIds.join("\n")).digest("hex");
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

export async function readLocalIndex(dir = INDEX_DIR): Promise<LocalSearchIndex> {
  const [manifestRaw, documentsRaw, bm25Raw, embeddingsRaw] = await Promise.all([
    readArtifact(ARTIFACT_FILES.manifest, dir),
    readArtifact(ARTIFACT_FILES.documents, dir),
    readArtifact(ARTIFACT_FILES.bm25, dir),
    readArtifact(ARTIFACT_FILES.embeddings, dir),
  ]);
  const manifest = parseManifest(manifestRaw);
  const documents = parseDocumentTable(documentsRaw);
  const digest = chunkOrderDigest(documents.map((document) => document.chunkId));
  if (manifest.chunkOrderSha256 !== digest) throw new SearchIndexError("Search index artifacts are out of sync: the document order does not match the manifest. Rebuild the index.");
  return assembleIndex(manifest, documents, parseBm25Artifact(bm25Raw), parseEmbeddingArtifact(embeddingsRaw));
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

/** Cheap readiness check for /api/health: parses only the small manifest, never the 2.7 MB of
 *  artifacts, so a health poll costs one file read rather than a full index load. */
export async function readIndexManifest(): Promise<IndexManifest | undefined> {
  try {
    return parseManifest(await readArtifact(ARTIFACT_FILES.manifest, INDEX_DIR));
  } catch {
    return undefined;
  }
}

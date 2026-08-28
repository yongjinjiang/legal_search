/**
 * Offline builder for the static retrieval artifacts in data/search/.
 *
 *   npx vite-node -c vitest.config.ts scripts/build_search_index.ts -- [options]
 *
 * It embeds the corpus exactly once and writes four committed files that the deployed
 * application reads directly. Nothing in this script runs during a web request.
 *
 * Options:
 *   --model <name>        embedding model (default: OPENAI_EMBEDDING_MODEL or text-embedding-3-small)
 *   --dimensions <n>      embedding dimensions (default: OPENAI_EMBEDDING_DIMENSIONS or 512)
 *   --fold-suffixes       enable the tokenizer's light suffix folding for the BM25 index
 *   --k1 <n> --b <n>      BM25 parameters
 *   --source <path>       chunk CSV (default: data/chunks/legal_chunks.csv)
 *   --out <dir>           output directory (default: data/search)
 *   --batch-size <n>      chunks per embedding request (default 16; lower it on a 429)
 *   --force               re-embed even when a reusable artifact is already present
 *   --skip-embeddings     rebuild only the lexical artifacts (no API key required)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_VERSION, EMBEDDING_DTYPE, type EmbeddingArtifact, type IndexDocument, type IndexManifest } from "@/lib/search/artifacts";
import { BM25_B, BM25_K1, buildBm25Index, type Bm25Config } from "@/lib/search/bm25";
import { corpusDigest } from "@/lib/search/localIndex";
import { l2Normalize } from "@/lib/search/semanticSearch";
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL, createOpenAIEmbeddingProvider } from "@/lib/embeddings/openai";
import { TOKENIZER_VERSION } from "@/lib/search/tokenize";
import { parseCsv } from "./lib/csv";
import { loadEnvFiles } from "./lib/env";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFiles(ROOT);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const sourcePath = path.resolve(ROOT, flag("source") ?? path.join("data", "chunks", "legal_chunks.csv"));
const outDir = path.resolve(ROOT, flag("out") ?? path.join("data", "search"));
const model = flag("model") ?? process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
const dimensions = Number(flag("dimensions") ?? process.env.OPENAI_EMBEDDING_DIMENSIONS ?? DEFAULT_EMBEDDING_DIMENSIONS);
const bm25: Bm25Config = { k1: Number(flag("k1") ?? BM25_K1), b: Number(flag("b") ?? BM25_B), foldSuffixes: has("fold-suffixes") };
// Set once the chunk file is read; the reuse gate compares it against the committed artifact.
let rowCount = 0;

function readChunks(): IndexDocument[] {
  if (!existsSync(sourcePath)) throw new Error(`Chunk file ${path.relative(ROOT, sourcePath)} is missing. The corpus is not stored in Git; run \`make bootstrap\` first.`);
  const rows = parseCsv(readFileSync(sourcePath, "utf8"));
  if (rows.length === 0) throw new Error("Chunk file contains no rows.");
  const seen = new Set<string>();
  return rows.map((row) => {
    for (const field of ["chunk_id", "case_id", "case_name", "citation", "chunk_text"]) if (!row[field]) throw new Error(`Chunk row is missing ${field}.`);
    if (seen.has(row.chunk_id)) throw new Error(`Chunk file contains duplicate chunk_id ${row.chunk_id}.`);
    seen.add(row.chunk_id);
    const pageStart = Number(row.page_start);
    const pageEnd = Number(row.page_end);
    if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd)) throw new Error(`Chunk ${row.chunk_id} has a non-numeric page range.`);
    return { chunkId: row.chunk_id, caseId: row.case_id, caseName: row.case_name, citation: row.citation, pageStart, pageEnd, chunkText: row.chunk_text };
  });
}

/** Reuse the committed vectors only when they provably describe this corpus, so a rebuild after
 *  a tokenizer or BM25 change costs nothing while an edit to any passage forces a re-embed.
 *
 *  The digest covers chunk text, not just chunk IDs. Keying on IDs alone was the bug this
 *  guard replaces: rewriting a passage left the ID digest unchanged, so the builder reused
 *  vectors for the old text and then wrote a manifest certifying the new corpus. `--force`
 *  overrides. */
function reusableEmbeddings(digest: string): EmbeddingArtifact | undefined {
  const location = path.join(outDir, "embeddings.json");
  if (has("force") || !existsSync(location)) return undefined;
  try {
    const existing = JSON.parse(readFileSync(location, "utf8")) as EmbeddingArtifact;
    const matches = existing.version === ARTIFACT_VERSION
      && existing.provider === "openai"
      && existing.model === model
      && existing.dimensions === dimensions
      && existing.count === rowCount
      && existing.dtype === EMBEDDING_DTYPE
      && existing.normalized === true
      && existing.corpusSha256 === digest;
    return matches ? existing : undefined;
  } catch {
    return undefined;
  }
}

async function buildEmbeddings(documents: IndexDocument[], digest: string): Promise<EmbeddingArtifact> {
  const reused = reusableEmbeddings(digest);
  if (reused) { console.log(`Reusing ${reused.count} committed ${reused.model} vectors (${reused.dimensions}d). Pass --force to re-embed.`); return reused; }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to build corpus embeddings. Set it in .env.local, or pass --skip-embeddings to rebuild only the lexical artifacts.");
  const provider = createOpenAIEmbeddingProvider({ apiKey, model, dimensions, baseUrl: process.env.OPENAI_BASE_URL, batchSize: Number(flag("batch-size")) || undefined });
  console.log(`Embedding ${documents.length} chunks with ${model} at ${dimensions} dimensions…`);
  const vectors = await provider.embedDocuments(documents.map((document) => document.chunkText));
  if (vectors.length !== documents.length) throw new Error(`Embedding provider returned ${vectors.length} vectors for ${documents.length} chunks.`);
  // Vectors are stored unit-length so the runtime cosine is a plain dot product.
  const matrix = new Float32Array(documents.length * dimensions);
  vectors.forEach((vector, row) => {
    if (vector.length !== dimensions) throw new Error(`Chunk ${documents[row].chunkId} received a ${vector.length}-dimension vector, expected ${dimensions}.`);
    matrix.set(l2Normalize(vector), row * dimensions);
  });
  return { version: ARTIFACT_VERSION, provider: provider.name, model, dimensions, count: documents.length, corpusSha256: digest, dtype: EMBEDDING_DTYPE, normalized: true, data: Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength).toString("base64") };
}

function write(file: string, value: unknown): void {
  const location = path.join(outDir, file);
  const contents = `${JSON.stringify(value, null, file === "embeddings.json" || file === "bm25_index.json" ? 0 : 2)}\n`;
  writeFileSync(location, contents, "utf8");
  console.log(`  ${path.relative(ROOT, location)}  ${(Buffer.byteLength(contents) / 1024).toFixed(0)} KB`);
}

async function main(): Promise<number> {
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error(`--dimensions must be a positive integer, received ${dimensions}.`);
  const documents = readChunks();
  rowCount = documents.length;
  const digest = corpusDigest(documents);
  const sourceSha256 = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  mkdirSync(outDir, { recursive: true });

  const embeddings = has("skip-embeddings")
    ? reusableEmbeddings(digest) ?? (() => { throw new Error("--skip-embeddings needs an existing embeddings.json built from this exact corpus with the same model and dimensions."); })()
    : await buildEmbeddings(documents, digest);

  const manifest: IndexManifest = {
    version: ARTIFACT_VERSION,
    generatedAt: new Date().toISOString(),
    rowCount: documents.length,
    sourceFile: path.relative(ROOT, sourcePath),
    sourceSha256,
    corpusSha256: digest,
    embedding: { provider: embeddings.provider, model: embeddings.model, dimensions: embeddings.dimensions },
    bm25,
    tokenizerVersion: TOKENIZER_VERSION,
  };

  console.log(`Writing artifacts for ${documents.length} chunks:`);
  write("documents.json", { version: ARTIFACT_VERSION, count: documents.length, corpusSha256: digest, documents });
  write("bm25_index.json", buildBm25Index(documents.map((document) => document.chunkText), bm25, digest));
  // The corpus digest travels inside every artifact, so a stale one is detected at load.
  write("embeddings.json", embeddings);
  write("index_manifest.json", manifest);
  console.log("Done. No API key is needed to serve these files.");
  return 0;
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

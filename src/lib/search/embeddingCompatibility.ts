import type { IndexManifest } from "./artifacts";

/** The parts of an embedding provider that have to agree with the committed index. */
export type EmbeddingConfiguration = { model: string; dimensions: number };

/**
 * One statement of the rule the query path and `/api/health` both apply.
 *
 * Health used to conclude that semantic search was configured as soon as the artifacts loaded and
 * an API key existed, and never compared the runtime model or width with the manifest — even
 * though `localSearchChunks` refuses either mismatch. `OPENAI_EMBEDDING_DIMENSIONS=512` parses as
 * a valid positive integer, so a deployment pointed at the committed 1024-dimensional index
 * reported "ok" and then failed every semantic query. Two independent copies of a rule is how
 * that gap opened; this is the one copy.
 *
 * Returns a public-safe reason, or undefined when the configuration can serve the index.
 */
export function embeddingMismatch(runtime: EmbeddingConfiguration, manifest: Pick<IndexManifest, "embedding">): string | undefined {
  const built = manifest.embedding;
  if (runtime.model === built.model && runtime.dimensions === built.dimensions) return undefined;
  // Both sides are published in data/search/index_manifest.json, so naming them is a deployment
  // diagnostic rather than a disclosure, and it is the difference between an operator fixing the
  // variable and an operator rebuilding an index that was never wrong.
  return `Semantic search is misconfigured: the query embedding ${runtime.model} at ${runtime.dimensions} dimensions does not match the built index, which is ${built.model} at ${built.dimensions} dimensions.`;
}

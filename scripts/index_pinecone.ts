/**
 * Upload the committed corpus vectors to Pinecone for the optional SEARCH_BACKEND=pinecone.
 *
 *   npm run index:pinecone
 *
 * Nothing is re-embedded: the vectors come from data/search/embeddings.json, loaded through the
 * same validated reader the application uses, so a stale or mixed artifact set is refused here
 * before it can be uploaded. Creates the index on first run (serverless, cosine, the manifest's
 * dimensions), upserts into the content-addressed namespace, waits until every vector is
 * queryable, and checks candidate scores with a Float32 tolerance.
 *
 * Re-run it after every `npm run build:index` that changes the corpus or the embedding model:
 * the namespace name is derived from both, so the runtime refuses to search until you do.
 *
 * Options:
 *   --prune corpus-<24 hex characters>   delete only this explicitly named unused namespace
 *   Repeat --prune for additional namespaces. Confirm no production or preview deployment uses
 *   any requested namespace; an older build can still be active.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalIndex } from "@/lib/search/localIndex";
import { verifyVectorProbe } from "@/lib/pinecone/probe";
import { namespaceFor } from "@/lib/pinecone/search";
import { DEFAULT_PINECONE_CLOUD, DEFAULT_PINECONE_REGION, describeIndex, PINECONE_CONTROL_URL, PineconeError, pineconeConfig, pineconeRequest, queryVectors, resolveHost, type PineconeConfig, type PineconeIndexDescription } from "@/lib/pinecone/client";
import { loadEnvFiles } from "./lib/env";
import { requestedPruneNamespaces, validatePruneNamespaces } from "./lib/pineconeMaintenance";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFiles(ROOT);

const TIMEOUT_MS = 30_000;
// 1024 floats serialise to ~20 KB of JSON, so 50 vectors stays well under the 2 MB request cap.
const UPSERT_BATCH = 50;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureIndex(config: PineconeConfig, dimensions: number): Promise<PineconeIndexDescription> {
  let description: PineconeIndexDescription | undefined;
  try {
    description = await describeIndex(config, TIMEOUT_MS);
  } catch (error) {
    if (!(error instanceof PineconeError && error.status === 404)) throw error;
    const cloud = process.env.PINECONE_CLOUD || DEFAULT_PINECONE_CLOUD;
    const region = process.env.PINECONE_REGION || DEFAULT_PINECONE_REGION;
    console.log(`Creating serverless index ${config.indexName} (${dimensions}d, cosine, ${cloud}/${region})…`);
    await pineconeRequest(config, `${PINECONE_CONTROL_URL}/indexes`, { method: "POST", body: { name: config.indexName, dimension: dimensions, metric: "cosine", spec: { serverless: { cloud, region } }, deletion_protection: "disabled" } }, TIMEOUT_MS);
  }
  for (let attempt = 0; !description?.status.ready; attempt += 1) {
    if (attempt === 60) throw new Error(`Index ${config.indexName} was not ready after two minutes.`);
    if (description) await sleep(2_000);
    description = await describeIndex(config, TIMEOUT_MS);
  }
  if (description.dimension !== dimensions) throw new Error(`Index ${config.indexName} has ${description.dimension} dimensions but the committed vectors have ${dimensions}. Delete it or set PINECONE_INDEX_NAME to a new name.`);
  if (description.metric !== "cosine") throw new Error(`Index ${config.indexName} uses ${description.metric}; the local scan ranks by cosine, so results would not be comparable.`);
  return description;
}

type IndexStats = { namespaces?: Record<string, { vectorCount?: number }> };

async function main(): Promise<number> {
  const prune = requestedPruneNamespaces(process.argv.slice(2));
  const config = pineconeConfig();
  if (!config) throw new Error("PINECONE_API_KEY is required. Set it in .env.local.");
  const index = await readLocalIndex();
  const { docCount, dimensions, data } = index.embeddings;
  const namespace = namespaceFor(index);
  validatePruneNamespaces(namespace, prune);

  await ensureIndex(config, dimensions);
  const host = `https://${await resolveHost(config, TIMEOUT_MS)}`;
  console.log(`Index ${config.indexName} at ${host}\nNamespace ${namespace} (corpus ${index.manifest.corpusSha256.slice(0, 12)}…, ${index.manifest.embedding.model})`);

  // The namespace already identifies the exact corpus and embedding configuration. Removed
  // chunks change that fingerprint. Re-running an unchanged upload is therefore an idempotent
  // upsert; clearing an active namespace first would create an avoidable outage on upload failure.

  for (let start = 0; start < docCount; start += UPSERT_BATCH) {
    const vectors = index.documents.slice(start, start + UPSERT_BATCH).map((document, offset) => {
      const row = start + offset;
      return { id: document.chunkId, values: Array.from(data.subarray(row * dimensions, (row + 1) * dimensions)), metadata: { caseId: document.caseId } };
    });
    await pineconeRequest(config, `${host}/vectors/upsert`, { method: "POST", body: { namespace, vectors } }, TIMEOUT_MS);
    console.log(`  upserted ${Math.min(start + UPSERT_BATCH, docCount)}/${docCount}`);
  }

  // Serverless writes are eventually consistent; searching before they land returns a partial
  // ranking that looks valid.
  let stats: IndexStats = {};
  for (let attempt = 0; (stats.namespaces?.[namespace]?.vectorCount ?? 0) < docCount; attempt += 1) {
    if (attempt === 60) throw new Error(`Only ${stats.namespaces?.[namespace]?.vectorCount ?? 0} of ${docCount} vectors became visible after two minutes.`);
    if (attempt > 0) await sleep(2_000);
    stats = await pineconeRequest<IndexStats>(config, `${host}/describe_index_stats`, { method: "POST", body: {} }, TIMEOUT_MS);
  }
  console.log(`All ${docCount} vectors are queryable.`);
  if (stats.namespaces?.[namespace]?.vectorCount !== docCount) throw new Error("The corpus namespace contains unexpected extra vectors. Inspect it before switching deployments.");

  // Near ties may reorder equally useful chunks. Verify IDs, counts, scores and the local top-k
  // score threshold, instead of treating exact ordering on three probes as a quality benchmark.
  for (const row of [0, Math.floor(docCount / 2), docCount - 1]) {
    const probe = Array.from(data.subarray(row * dimensions, (row + 1) * dimensions));
    const remote = await queryVectors(config, namespace, probe, 3, TIMEOUT_MS);
    const verified = verifyVectorProbe(index, probe, remote, 3);
    console.log(`  probe ${index.documents[row].chunkId}: scores within ${verified.scoreTolerance}; exact order ${verified.exactOrderMatch}`);
  }
  console.log("Self-check passed: candidate coverage and cosine scores verified on 3 probes. This is not a relevance benchmark.");

  if (prune.length > 0) {
    for (const name of prune) await pineconeRequest(config, `${host}/vectors/delete`, { method: "POST", body: { namespace: name, deleteAll: true } }, TIMEOUT_MS);
    console.log(`Pruned ${prune.length} explicitly requested namespace(s).`);
  }
  const retained = Object.keys(stats.namespaces ?? {}).filter((name) => name !== namespace && !prune.includes(name));
  if (retained.length > 0) console.log(`${retained.length} other namespace(s) retained. Only use --prune <namespace> after confirming that namespace is unused by all deployments.`);
  console.log("\nSet SEARCH_BACKEND=pinecone to search through this index.");
  return 0;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

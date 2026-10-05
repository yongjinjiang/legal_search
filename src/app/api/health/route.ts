import { NextResponse } from "next/server";
import { embeddingProvider } from "@/lib/embeddings/openai";
import { llmProvider } from "@/lib/llm/openai";
import { mockEnabled, searchBackend } from "@/lib/search/backend";
import { indexReadiness } from "@/lib/search/localIndex";
import { embeddingMismatch } from "@/lib/search/embeddingCompatibility";
import { pineconeConfig } from "@/lib/pinecone/client";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";

// The README's deployment check hits this route, so "ok" must be unreachable when a deployment
// cannot actually serve search. Under the local backend that means loading and cross-validating
// the whole artifact set: a valid manifest beside a missing or corrupt companion file is exactly
// the deployment that would otherwise report healthy and then fail every query. Nothing here
// calls a paid API.
export async function GET() {
  const backend = searchBackend();
  const mock = mockEnabled();

  // A malformed embedding configuration is reported as a reason rather than thrown, so an
  // operator sees the specific problem instead of a 500.
  let embeddings: EmbeddingProvider | undefined;
  let embeddingError: string | undefined;
  // Constructing the provider reads environment variables and makes no request, so health still
  // costs nothing.
  try { embeddings = embeddingProvider(); } catch (error) { embeddingError = error instanceof Error ? error.message : "The embedding configuration is invalid."; }
  // A rejected reasoning effort is a configuration fault an operator can only fix if it is
  // reported; otherwise it surfaces as a generic chat outage on the first question asked.
  let chatConfigured = false;
  let chatError: string | undefined;
  try { chatConfigured = Boolean(llmProvider()); } catch (error) { chatError = error instanceof Error ? error.message : "The chat configuration is invalid."; }

  if (mock) return NextResponse.json({ status: chatConfigured ? "ok" : "degraded", backend, searchMode: "mock", searchConfigured: true, lexicalConfigured: true, semanticConfigured: true, chatConfigured }, { status: 200 });

  if (backend === "databricks") {
    const credentials = Boolean(process.env.DATABRICKS_HOST && process.env.DATABRICKS_TOKEN);
    const searchConfigured = credentials && Boolean(process.env.DATABRICKS_INDEX_NAME);
    return NextResponse.json({ status: !searchConfigured ? "unavailable" : chatConfigured ? "ok" : "degraded", backend, searchMode: "databricks", searchConfigured, lexicalConfigured: searchConfigured, semanticConfigured: searchConfigured, chatConfigured }, { status: searchConfigured ? 200 : 503 });
  }

  const readiness = await indexReadiness();
  // Full text needs only the artifacts; semantic and hybrid additionally need embedding
  // credentials, so a deployment with a valid index but no API key is degraded rather than down.
  const lexicalConfigured = readiness.ready;
  let semanticConfigured = lexicalConfigured && Boolean(embeddings);
  // Credentials alone were the whole test until a valid-looking width — 512 against a
  // 1024-dimensional index — reported "ok" and then failed every semantic query. The comparison
  // is the same one the query path makes, imported rather than restated.
  if (readiness.ready && embeddings) {
    const mismatch = embeddingMismatch(embeddings, readiness.index.manifest);
    if (mismatch) { semanticConfigured = false; embeddingError = mismatch; }
  }
  // The Pinecone backend keeps lexical search local and moves only the vector step, so a missing
  // key degrades semantic search exactly as a missing embedding key does. Whether the namespace
  // is populated needs a network call, which this route does not make.
  let vectorStoreError: string | undefined;
  if (backend === "pinecone" && !pineconeConfig()) { semanticConfigured = false; vectorStoreError = "SEARCH_BACKEND is pinecone but PINECONE_API_KEY is not set."; }
  const status = !lexicalConfigured ? "unavailable" : semanticConfigured && chatConfigured ? "ok" : "degraded";
  const manifest = readiness.ready ? readiness.index.manifest : undefined;
  return NextResponse.json({
    status,
    backend,
    searchMode: backend === "pinecone" ? "pinecone" : "local",
    searchConfigured: lexicalConfigured,
    lexicalConfigured,
    semanticConfigured,
    chatConfigured,
    index: manifest ? { rowCount: manifest.rowCount, embeddingModel: manifest.embedding.model, embeddingDimensions: manifest.embedding.dimensions, generatedAt: manifest.generatedAt } : undefined,
    // Artifact paths are public repository filenames, so naming the fault aids deployment
    // debugging without disclosing anything.
    indexError: readiness.ready ? undefined : readiness.reason,
    embeddingError,
    vectorStoreError,
    chatError,
  }, { status: lexicalConfigured ? 200 : 503 });
}

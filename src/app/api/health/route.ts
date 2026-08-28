import { NextResponse } from "next/server";
import { embeddingProvider } from "@/lib/embeddings/openai";
import { llmProvider } from "@/lib/llm/openai";
import { mockEnabled, searchBackend } from "@/lib/search/backend";
import { readIndexManifest } from "@/lib/search/localIndex";

// The README's deployment check hits this route, so "ok" must be unreachable when a deployment
// cannot actually serve search. Under the local backend the artifacts are the dependency that
// can be missing, so the manifest is parsed; nothing here calls a paid API.
export async function GET() {
  const backend = searchBackend();
  const mock = mockEnabled();
  const embeddings = Boolean(embeddingProvider());
  const chatConfigured = Boolean(llmProvider());

  if (mock) return NextResponse.json({ status: chatConfigured ? "ok" : "degraded", backend, searchMode: "mock", searchConfigured: true, lexicalConfigured: true, semanticConfigured: true, chatConfigured }, { status: 200 });

  if (backend === "databricks") {
    const credentials = Boolean(process.env.DATABRICKS_HOST && process.env.DATABRICKS_TOKEN);
    const searchConfigured = credentials && Boolean(process.env.DATABRICKS_INDEX_NAME);
    return NextResponse.json({ status: !searchConfigured ? "unavailable" : chatConfigured ? "ok" : "degraded", backend, searchMode: "databricks", searchConfigured, lexicalConfigured: searchConfigured, semanticConfigured: searchConfigured, chatConfigured }, { status: searchConfigured ? 200 : 503 });
  }

  const manifest = await readIndexManifest();
  // Full text needs only the artifacts; semantic and hybrid additionally need embedding
  // credentials, so a deployment with an index but no API key is degraded rather than down.
  const lexicalConfigured = Boolean(manifest);
  const semanticConfigured = lexicalConfigured && embeddings;
  const status = !lexicalConfigured ? "unavailable" : semanticConfigured && chatConfigured ? "ok" : "degraded";
  return NextResponse.json({
    status,
    backend,
    searchMode: "local",
    searchConfigured: lexicalConfigured,
    lexicalConfigured,
    semanticConfigured,
    chatConfigured,
    index: manifest ? { rowCount: manifest.rowCount, embeddingModel: manifest.embedding.model, embeddingDimensions: manifest.embedding.dimensions, generatedAt: manifest.generatedAt } : undefined,
  }, { status: lexicalConfigured ? 200 : 503 });
}

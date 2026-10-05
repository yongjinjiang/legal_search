import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "../src/app/api/health/route";
import { pineconeNamespace, resetPineconeHostCache } from "../src/lib/pinecone/client";
import { namespaceFor, pineconeVectorSearch } from "../src/lib/pinecone/search";
import { searchBackend } from "../src/lib/search/backend";
import { localSearchChunks } from "../src/lib/search/localSearch";
import { RRF_CANDIDATE_DEPTH } from "../src/lib/search/hybridSearch";
import { FIXTURE_DIMENSIONS, FIXTURE_MODEL, fixtureIndex } from "./fixtures";

const originalEnv = { ...process.env };
const index = fixtureIndex();
const HOST = "legal-chunks-test.svc.pinecone.io";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const embeddingResponse = (vector: number[]) => json({ data: [{ index: 0, embedding: vector }] });

function configure({ host = true } = {}) {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_EMBEDDING_MODEL = FIXTURE_MODEL;
  process.env.OPENAI_EMBEDDING_DIMENSIONS = String(FIXTURE_DIMENSIONS);
  process.env.PINECONE_API_KEY = "pc-test-key";
  if (host) process.env.PINECONE_INDEX_HOST = HOST;
}

/** Embedding first, then whatever Pinecone responses the test supplies, in order. */
function stubFetch(...pinecone: Response[]) {
  const fetchMock = vi.fn().mockResolvedValueOnce(embeddingResponse([0, 0, 1, 0]));
  for (const response of pinecone) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const search = (queryType: "ANN" | "HYBRID" = "ANN") => localSearchChunks("because of sex", queryType, 10, index, undefined, pineconeVectorSearch);

beforeEach(() => { resetPineconeHostCache(); });
afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.sequential("pinecone vector backend", () => {
  it("ranks by Pinecone's matches and renders them from the local document table", async () => {
    configure();
    const fetchMock = stubFetch(json({ matches: [{ id: "c3", score: 0.91 }, { id: "c1", score: 0.12 }] }));
    const chunks = await search();
    expect(chunks.map((chunk) => [chunk.chunkId, chunk.score])).toEqual([["c3", 0.91], ["c1", 0.12]]);
    expect(chunks[0].chunkText).toBe(index.documents[2].chunkText);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`https://${HOST}/query`);
    expect(init.headers).toMatchObject({ "Api-Key": "pc-test-key" });
    expect(url).not.toContain("pc-test-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ namespace: namespaceFor(index), topK: 10, vector: [0, 0, 1, 0], includeValues: false });
  });

  it("asks Pinecone for the RRF candidate depth on hybrid and still fuses with BM25 locally", async () => {
    configure();
    const fetchMock = stubFetch(json({ matches: [{ id: "c3", score: 0.9 }, { id: "c4", score: 0.5 }] }));
    const chunks = await search("HYBRID");
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).topK).toBe(RRF_CANDIDATE_DEPTH);
    // c3 leads both lists, so fusion must keep it first; c4 matches "because of sex" in both.
    expect(chunks[0].chunkId).toBe("c3");
    expect(chunks.some((chunk) => chunk.chunkId === "c4")).toBe(true);
  });

  it("refuses a match the local corpus does not contain rather than dropping it", async () => {
    configure();
    stubFetch(json({ matches: [{ id: "c3", score: 0.9 }, { id: "stale-chunk", score: 0.8 }] }));
    await expect(search()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/out of sync/) });
  });

  it("refuses an empty namespace instead of returning no results", async () => {
    configure();
    stubFetch(json({ matches: [] }));
    await expect(search()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/npm run index:pinecone/) });
  });

  it.each([[401, 503, /API key/], [404, 503, /does not exist/], [429, 429, /rate limited/], [500, 502, /temporarily unavailable/]])("maps Pinecone HTTP %i to a public-safe %i", async (upstream, status, message) => {
    configure();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(json({ error: { code: "X", message: "upstream detail" } }, upstream));
    const error = await search().catch((caught: unknown) => caught) as Error & { status: number };
    expect(error).toMatchObject({ status });
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain("upstream detail");
  });

  it("fails closed without a Pinecone key and makes no Pinecone call", async () => {
    configure();
    delete process.env.PINECONE_API_KEY;
    const fetchMock = stubFetch();
    await expect(search()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/not configured/) });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("resolves the index host once per instance when no host is configured", async () => {
    configure({ host: false });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(embeddingResponse([0, 0, 1, 0]))
      .mockResolvedValueOnce(json({ name: "legal-chunks", dimension: 4, metric: "cosine", host: HOST, status: { ready: true, state: "Ready" } }))
      .mockResolvedValueOnce(json({ matches: [{ id: "c3", score: 0.9 }] }))
      .mockResolvedValueOnce(embeddingResponse([0, 0, 1, 0]))
      .mockResolvedValueOnce(json({ matches: [{ id: "c3", score: 0.9 }] }));
    vi.stubGlobal("fetch", fetchMock);
    await search();
    await search();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url === "https://api.pinecone.io/indexes/legal-chunks")).toHaveLength(1);
    expect(urls.filter((url) => url === `https://${HOST}/query`)).toHaveLength(2);
  });

  it("derives a new namespace when the corpus or the embedding space changes", () => {
    const base = { corpusSha256: "a".repeat(64), provider: "openai", model: "text-embedding-3-large", dimensions: 1024 };
    const namespace = pineconeNamespace(base);
    expect(namespace).toMatch(/^corpus-[0-9a-f]{24}$/);
    expect(pineconeNamespace({ ...base })).toBe(namespace);
    expect(pineconeNamespace({ ...base, corpusSha256: "b".repeat(64) })).not.toBe(namespace);
    expect(pineconeNamespace({ ...base, model: "text-embedding-3-small" })).not.toBe(namespace);
    expect(pineconeNamespace({ ...base, dimensions: 512 })).not.toBe(namespace);
  });

  it("is selected only by SEARCH_BACKEND=pinecone", () => {
    process.env.SEARCH_BACKEND = "pinecone";
    expect(searchBackend()).toBe("pinecone");
    process.env.SEARCH_BACKEND = "Pinecone";
    expect(searchBackend()).toBe("local");
  });

  it("reports semantic search degraded on health when the backend is pinecone but the key is missing", async () => {
    delete process.env.MOCK_SEARCH;
    delete process.env.MOCK_DATABRICKS;
    delete process.env.PINECONE_API_KEY;
    process.env.SEARCH_BACKEND = "pinecone";
    process.env.OPENAI_API_KEY = "test-key";
    const missing = await (await health()).json() as Record<string, unknown>;
    expect(missing).toMatchObject({ status: "degraded", backend: "pinecone", searchMode: "pinecone", lexicalConfigured: true, semanticConfigured: false });
    expect(missing.vectorStoreError).toMatch(/PINECONE_API_KEY/);

    process.env.PINECONE_API_KEY = "pc-test-key";
    const configured = await (await health()).json() as Record<string, unknown>;
    expect(configured).toMatchObject({ status: "ok", semanticConfigured: true });
    expect(configured.vectorStoreError).toBeUndefined();
  });
});

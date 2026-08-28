import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchServiceError } from "../src/lib/search/errors";
import { localSearchChunks } from "../src/lib/search/localSearch";
import { collapseToCases } from "../src/lib/search/caseRanking";
import { FIXTURE_DIMENSIONS, FIXTURE_MODEL, fixtureIndex } from "./fixtures";

const originalEnv = { ...process.env };
const index = fixtureIndex();

/** Configure the runtime embedding provider to agree with the fixture index. */
function configureEmbeddings() {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_EMBEDDING_MODEL = FIXTURE_MODEL;
  process.env.OPENAI_EMBEDDING_DIMENSIONS = String(FIXTURE_DIMENSIONS);
}

const embeddingResponse = (vector: number[]) => new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }] }), { status: 200 });

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.sequential("local retrieval", () => {
  it("answers a full-text query with no credentials and no network call", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const chunks = await localSearchChunks("but-for causation", "FULL_TEXT", 10, index);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks[0].caseId).toBe("nassar");
    expect(chunks.map((chunk) => chunk.rank)).toEqual(chunks.map((_, i) => i + 1));
  });

  it("makes exactly one embedding request for a semantic query", async () => {
    configureEmbeddings();
    const fetchMock = vi.fn().mockResolvedValue(embeddingResponse([1, 0, 0, 0]));
    vi.stubGlobal("fetch", fetchMock);
    const chunks = await localSearchChunks("adverse action", "ANN", 10, index);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(chunks[0].caseId).toBe("burlington");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/embeddings");
    // The key must travel in a server-side header and never in a URL or a response payload.
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(url).not.toContain("test-key");
  });

  it("makes one embedding request for hybrid and fuses with lexical results", async () => {
    configureEmbeddings();
    const fetchMock = vi.fn().mockResolvedValue(embeddingResponse([0, 1, 0, 0]));
    vi.stubGlobal("fetch", fetchMock);
    const chunks = await localSearchChunks("but-for causation", "HYBRID", 10, index);
    expect(fetchMock).toHaveBeenCalledOnce();
    // Nassar leads both the lexical list (it owns the phrase) and the semantic list (the stub
    // vector is its row), so fusion must place it first.
    expect(chunks[0].caseId).toBe("nassar");
  });

  it("reports a configuration error for semantic search rather than serving another method", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(localSearchChunks("adverse action", "ANN", 10, index)).rejects.toMatchObject({ status: 503 });
    // Production must never answer a failed semantic search with lexical or mock results while
    // still labelling the response ANN.
    await expect(localSearchChunks("adverse action", "ANN", 10, index)).rejects.toThrow(/not configured/);
  });

  it("refuses to query when the runtime embedding model does not match the built index", async () => {
    configureEmbeddings();
    process.env.OPENAI_EMBEDDING_MODEL = "some-other-model";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(localSearchChunks("adverse action", "ANN", 10, index)).rejects.toThrow(/does not match the built index/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces provider failures as public-safe retrieval errors", async () => {
    configureEmbeddings();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [status, expected] of [[401, 503], [429, 429], [500, 502]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "sk-live-secret leaked in body" } }), { status })));
      const error = await localSearchChunks("adverse action", "ANN", 10, index).catch((caught: unknown) => caught) as SearchServiceError;
      expect(error).toBeInstanceOf(SearchServiceError);
      expect(error.status).toBe(status === 401 ? 503 : expected);
      expect(error.message).not.toContain("sk-live-secret");
    }
  });

  it("rejects an embedding whose width does not match the corpus", async () => {
    configureEmbeddings();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(embeddingResponse([1, 0, 0])));
    await expect(localSearchChunks("adverse action", "ANN", 10, index)).rejects.toThrow(/not 4 finite dimensions/);
  });

  it("gives each case one rank and keeps its other passages, so a long opinion cannot repeat", async () => {
    delete process.env.OPENAI_API_KEY;
    const chunks = await localSearchChunks("sex discrimination because of sex", "FULL_TEXT", 10, index);
    const cases = collapseToCases(chunks, "FULL_TEXT");
    expect(cases.map((result) => result.caseId)).toEqual([...new Set(cases.map((result) => result.caseId))]);
    const longCase = cases.find((result) => result.caseId === "long_case")!;
    expect(longCase.passages.length).toBe(2);
    expect(cases.filter((result) => result.caseId === "long_case")).toHaveLength(1);
  });
});

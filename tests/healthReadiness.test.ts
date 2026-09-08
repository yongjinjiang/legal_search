import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET as health } from "../src/app/api/health/route";
import { resetLocalIndexCache } from "../src/lib/search/localIndex";
import { localSearchChunks } from "../src/lib/search/localSearch";

const REAL = path.join(process.cwd(), "data", "search");
const FILES = ["index_manifest.json", "documents.json", "bm25_index.json", "embeddings.json"] as const;
const originalEnv = { ...process.env };
let sandbox: string;
let originalCwd: string;

/** Health resolves artifacts from process.cwd(), so each case runs against a disposable copy of
 *  the committed index rather than mutating the real one. */
beforeEach(() => {
  originalCwd = process.cwd();
  sandbox = mkdtempSync(path.join(tmpdir(), "health-"));
  mkdirSync(path.join(sandbox, "data", "search"), { recursive: true });
  for (const file of FILES) writeFileSync(path.join(sandbox, "data", "search", file), readFileSync(path.join(REAL, file)));
  process.chdir(sandbox);
  resetLocalIndexCache();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(sandbox, { recursive: true, force: true });
  process.env = { ...originalEnv };
  resetLocalIndexCache();
});

const corrupt = (file: string, contents: string) => writeFileSync(path.join(sandbox, "data", "search", file), contents);
const remove = (file: string) => rmSync(path.join(sandbox, "data", "search", file));

describe.sequential("health readiness", () => {
  it("reports ok when the whole artifact set loads", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const response = await health();
    expect(response.status).toBe(200);
    const payload = await response.json() as { status: string; indexError?: string; index: { rowCount: number } };
    expect(payload.status).toBe("ok");
    expect(payload.indexError).toBeUndefined();
    expect(payload.index.rowCount).toBe(234);
  });

  // The defect this suite exists for: a valid manifest beside a missing companion file used to
  // report 200 "ok" while every semantic search failed.
  it.each(["documents.json", "bm25_index.json", "embeddings.json"])("fails when %s is missing", async (file) => {
    remove(file);
    const response = await health();
    expect(response.status).toBe(503);
    const payload = await response.json() as { status: string; lexicalConfigured: boolean; indexError: string };
    expect(payload.status).toBe("unavailable");
    expect(payload.lexicalConfigured).toBe(false);
    expect(payload.indexError).toContain(file);
  });

  it.each(FILES)("fails when %s is malformed", async (file) => {
    corrupt(file, "{ not json");
    const response = await health();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", indexError: expect.stringContaining("not valid JSON") });
  });

  it("fails when the manifest describes a corpus the document table does not contain", async () => {
    const manifest = JSON.parse(readFileSync(path.join(sandbox, "data", "search", "index_manifest.json"), "utf8")) as { corpusSha256: string };
    manifest.corpusSha256 = "0".repeat(64);
    corrupt("index_manifest.json", JSON.stringify(manifest));
    const response = await health();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ indexError: expect.stringContaining("does not match the manifest") });
  });

  it("fails when the embedding matrix is stale relative to the document table", async () => {
    const embeddings = JSON.parse(readFileSync(path.join(sandbox, "data", "search", "embeddings.json"), "utf8")) as { corpusSha256: string };
    embeddings.corpusSha256 = "0".repeat(64);
    corrupt("embeddings.json", JSON.stringify(embeddings));
    const response = await health();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ indexError: expect.stringContaining("different corpus") });
  });

  it("is degraded, not down, when the index is valid but credentials are absent", async () => {
    delete process.env.OPENAI_API_KEY;
    const response = await health();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "degraded", lexicalConfigured: true, semanticConfigured: false });
  });

  // Health used to stop at "artifacts load and a key exists". A width that parses is not a width
  // the committed index can serve, and this deployment reported ok while every semantic query
  // failed.
  it.each([
    ["a mismatched dimension", { OPENAI_EMBEDDING_DIMENSIONS: "512" }, "512 dimensions"],
    ["a mismatched model", { OPENAI_EMBEDDING_MODEL: "text-embedding-3-small" }, "text-embedding-3-small"],
  ])("is degraded rather than ok under %s", async (_label, env, expected) => {
    process.env.OPENAI_API_KEY = "test-key";
    Object.assign(process.env, env);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await health();
    expect(response.status).toBe(200);
    const payload = await response.json() as { status: string; lexicalConfigured: boolean; semanticConfigured: boolean; embeddingError?: string };
    expect(payload).toMatchObject({ status: "degraded", lexicalConfigured: true, semanticConfigured: false });
    expect(payload.embeddingError).toContain(expected);
    expect(payload.embeddingError).toContain("text-embedding-3-large");
    // The comparison is against the manifest, so it costs nothing and reaches no provider.
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports exactly what retrieval would refuse", async () => {
    // The two used to disagree, which is the whole defect: health called a configuration
    // serviceable that the query path was about to reject.
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_EMBEDDING_DIMENSIONS = "512";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const payload = await (await health()).json() as { embeddingError: string };
    await expect(localSearchChunks("materially adverse action", "ANN", 5)).rejects.toThrow(payload.embeddingError);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays ok when the configuration matches the committed manifest", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
    process.env.OPENAI_EMBEDDING_DIMENSIONS = "1024";
    const payload = await (await health()).json() as { status: string; semanticConfigured: boolean; embeddingError?: string };
    expect(payload).toMatchObject({ status: "ok", semanticConfigured: true });
    expect(payload.embeddingError).toBeUndefined();
  });

  it("reports an invalid embedding configuration instead of failing the request", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_EMBEDDING_DIMENSIONS = "1024x";
    const response = await health();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "degraded", semanticConfigured: false, embeddingError: expect.stringContaining("positive integer") });
  });
});

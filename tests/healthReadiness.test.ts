import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET as health } from "../src/app/api/health/route";
import { resetLocalIndexCache } from "../src/lib/search/localIndex";

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

  it("reports an invalid embedding configuration instead of failing the request", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_EMBEDDING_DIMENSIONS = "1024x";
    const response = await health();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "degraded", semanticConfigured: false, embeddingError: expect.stringContaining("positive integer") });
  });
});

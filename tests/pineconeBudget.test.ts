import { afterEach, describe, expect, it, vi } from "vitest";
import { queryVectors, resetPineconeHostCache, resolveHost } from "../src/lib/pinecone/client";
import { HttpTimeoutError } from "../src/lib/http";
import { namespaceFor, pineconeVectorSearch, resetPineconeReadinessCache } from "../src/lib/pinecone/search";
import { fixtureIndex } from "./fixtures";

const config = { apiKey: "test-key", indexName: "budget-fixture" };
const json = (value: unknown) => new Response(JSON.stringify(value));
function slowResponse(value: unknown, ms: number, signal?: AbortSignal | null) {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(json(value)), ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}
afterEach(() => { resetPineconeHostCache(); resetPineconeReadinessCache(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Pinecone total query budget", () => {
  it("aborts a 70ms discovery plus 70ms query within a single 100ms allowance", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return slowResponse(url.includes("/indexes/") ? { host: "fixture.svc.pinecone.io" } : { matches: [{ id: "c1", score: 1 }] }, 70, init.signal);
    }));
    const done = expect(queryVectors(config, "corpus-fixture", [1], 1, 100)).rejects.toBeInstanceOf(HttpTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a short waiter without cancelling another caller's shared discovery", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => slowResponse({ host: "fixture.svc.pinecone.io" }, 70, init.signal));
    vi.stubGlobal("fetch", fetchMock);
    const owner = resolveHost(config, 100);
    const shortWait = expect(resolveHost(config, 15)).rejects.toBeInstanceOf(HttpTimeoutError);
    await vi.advanceTimersByTimeAsync(15);
    await shortWait;
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(55);
    await expect(owner).resolves.toBe("fixture.svc.pinecone.io");
    await expect(resolveHost(config, 1)).resolves.toBe("fixture.svc.pinecone.io");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops failed discovery so the next query can retry", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(json({ host: "fixture.svc.pinecone.io" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveHost(config, 100)).rejects.toThrow("offline");
    await expect(resolveHost(config, 100)).resolves.toBe("fixture.svc.pinecone.io");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a short discovery starter abort a later long waiter", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => slowResponse({ host: "fixture.svc.pinecone.io" }, 70, init.signal));
    vi.stubGlobal("fetch", fetchMock);
    const short = expect(resolveHost(config, 15)).rejects.toBeInstanceOf(HttpTimeoutError);
    const long = resolveHost(config, 100);
    await vi.advanceTimersByTimeAsync(15);
    await short;
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(55);
    await expect(long).resolves.toBe("fixture.svc.pinecone.io");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares readiness without letting the starter's shorter route allowance cancel it", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PINECONE_API_KEY", "test-key");
    vi.stubEnv("PINECONE_INDEX_HOST", "fixture.svc.pinecone.io");
    const index = fixtureIndex();
    const fetchMock = vi.fn((url: string, init: RequestInit) => slowResponse(url.endsWith("/describe_index_stats")
      ? { namespaces: { [namespaceFor(index)]: { vectorCount: index.documents.length } } }
      : { matches: [{ id: "c1", score: 1 }] }, url.endsWith("/describe_index_stats") ? 3000 : 1, init.signal));
    vi.stubGlobal("fetch", fetchMock);
    const short = expect(pineconeVectorSearch(index, [1], 1, Date.now() + 2000)).rejects.toMatchObject({ status: 504 });
    const long = pineconeVectorSearch(index, [1], 1);
    await vi.advanceTimersByTimeAsync(2000);
    await short;
    await vi.advanceTimersByTimeAsync(1001);
    await expect(long).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes readiness and query in one 8s Pinecone allowance", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PINECONE_API_KEY", "test-key");
    vi.stubEnv("PINECONE_INDEX_HOST", "fixture.svc.pinecone.io");
    const index = fixtureIndex();
    const fetchMock = vi.fn((url: string, init: RequestInit) => slowResponse(url.endsWith("/describe_index_stats")
      ? { namespaces: { [namespaceFor(index)]: { vectorCount: index.documents.length } } }
      : { matches: [{ id: "c1", score: 1 }] }, 4500, init.signal));
    vi.stubGlobal("fetch", fetchMock);
    const done = expect(pineconeVectorSearch(index, [1], 1)).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(8000);
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

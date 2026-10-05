import { afterEach, describe, expect, it, vi } from "vitest";
import { queryVectors, resetPineconeHostCache, resolveHost } from "../src/lib/pinecone/client";
import { HttpTimeoutError } from "../src/lib/http";

const config = { apiKey: "test-key", indexName: "budget-fixture" };
const json = (value: unknown) => new Response(JSON.stringify(value));
function slowResponse(value: unknown, ms: number, signal?: AbortSignal | null) {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(json(value)), ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}
afterEach(() => { resetPineconeHostCache(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
});

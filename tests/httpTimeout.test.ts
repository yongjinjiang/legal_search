import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchWithTimeout, HttpTimeoutError, isAbortError } from "../src/lib/http";

/** A real socket rather than a mock. The defect was that the timer was cleared once `fetch`
 *  resolved with headers, so anything that stalled afterwards ran unbounded — and a mock that
 *  ignores the abort signal would pass against the broken version just as happily as the fixed
 *  one. `/stall` flushes a 200 and part of a JSON body and then never writes again, so the only
 *  thing that can end the request is the client aborting it. */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    if (request.url === "/stall") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"partial":');
      return; // never ends
    }
    if (request.url === "/slow-headers") {
      setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}'); }, 30_000);
      return;
    }
    if (request.url === "/bad-json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{ not json");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => { vi.restoreAllMocks(); });

describe("fetchWithTimeout", () => {
  it("aborts a body that stalls after the headers arrive", async () => {
    let observed: { aborted: boolean; timedOut: boolean } | undefined;
    const started = Date.now();
    const attempt = fetchWithTimeout(`${base}/stall`, { method: "POST" }, 150, async (response, context) => {
      try {
        return await response.json() as unknown;
      } finally {
        observed = { aborted: context.signal.aborted, timedOut: context.timedOut() };
      }
    });
    await expect(attempt).rejects.toBeInstanceOf(HttpTimeoutError);
    // The server never finishes this response, so returning at all proves the client cancelled.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(observed).toEqual({ aborted: true, timedOut: true });
  });

  it("still bounds a request whose headers never arrive", async () => {
    const started = Date.now();
    await expect(fetchWithTimeout(`${base}/slow-headers`, { method: "POST" }, 150, async (response) => response.json() as Promise<unknown>))
      .rejects.toBeInstanceOf(HttpTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns the consumer's value and releases the timer on success", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await expect(fetchWithTimeout(`${base}/ok`, { method: "POST" }, 5_000, async (response) => response.json() as Promise<{ ok: boolean }>))
      .resolves.toEqual({ ok: true });
    // Without this the timer stays armed for its full budget on every successful call.
    expect(clear).toHaveBeenCalled();
  });

  it("releases the timer when the consumer throws", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await expect(fetchWithTimeout(`${base}/ok`, { method: "POST" }, 5_000, async () => { throw new Error("consumer failed"); }))
      .rejects.toThrow("consumer failed");
    expect(clear).toHaveBeenCalled();
  });

  it("reports a malformed body as itself, not as a timeout", async () => {
    // The distinction matters downstream: one is a provider contract problem, the other is a
    // budget problem, and they have different fixes.
    let timedOut: boolean | undefined;
    const attempt = fetchWithTimeout(`${base}/bad-json`, { method: "POST" }, 5_000, async (response, context) => {
      try {
        return await response.json() as unknown;
      } catch (error) {
        timedOut = context.timedOut();
        throw error;
      }
    });
    await expect(attempt).rejects.not.toBeInstanceOf(HttpTimeoutError);
    expect(timedOut).toBe(false);
  });

  it("recognises an abort however the runtime reports it", () => {
    expect(isAbortError(new HttpTimeoutError(10))).toBe(true);
    expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isAbortError(Object.assign(new Error("terminated"), { cause: { name: "AbortError" } }))).toBe(true);
    expect(isAbortError(new SyntaxError("Unexpected token"))).toBe(false);
  });
});

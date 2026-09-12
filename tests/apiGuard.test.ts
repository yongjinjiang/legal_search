import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, rejectUnsafeRequest } from "@/lib/api/guard";

const post = (headers: Record<string, string>) => new Request("http://localhost/api/search", { method: "POST", headers, body: "{}" });

describe("rejectUnsafeRequest", () => {
  it("accepts a same-origin JSON request like the browser client sends", () => {
    expect(rejectUnsafeRequest(post({ "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }))).toBeNull();
  });

  it("accepts JSON with a charset parameter and no fetch metadata (curl, tests)", () => {
    expect(rejectUnsafeRequest(post({ "Content-Type": "application/json; charset=utf-8" }))).toBeNull();
  });

  it("refuses the content types a cross-origin page can send without a preflight", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = rejectUnsafeRequest(post({ "Content-Type": type }));
      expect(response?.status).toBe(415);
    }
    expect(rejectUnsafeRequest(new Request("http://localhost/api/search", { method: "POST", body: "{}" }))?.status).toBe(415);
  });

  it("refuses a browser request driven by another site", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(rejectUnsafeRequest(post({ "Content-Type": "application/json", "Sec-Fetch-Site": site }))?.status).toBe(403);
    }
    expect(rejectUnsafeRequest(post({ "Content-Type": "application/json", "Sec-Fetch-Site": "none" }))).toBeNull();
  });

  it("refuses an oversized body before it is read", () => {
    const response = rejectUnsafeRequest(post({ "Content-Type": "application/json", "Content-Length": String(MAX_BODY_BYTES + 1) }));
    expect(response?.status).toBe(413);
    expect(rejectUnsafeRequest(post({ "Content-Type": "application/json", "Content-Length": String(MAX_BODY_BYTES) }))).toBeNull();
  });
});

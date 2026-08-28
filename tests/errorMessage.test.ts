import { describe, expect, it } from "vitest";
import { readError } from "../src/lib/errorMessage";

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

describe("client error messages", () => {
  it("explains a rate-limit denial instead of leaking a parser error", async () => {
    // The edge WAF denies with 403 and an HTML body. Parsing before checking status made
    // response.json() throw, and the SyntaxError text was rendered to the visitor as the error.
    const denied = new Response("<!DOCTYPE html><html>Forbidden</html>", { status: 403 });
    await expect(readError(denied, "Search could not be completed.")).resolves.toBe("Too many requests. Please wait a moment and try again.");
    await expect(readError(new Response("<html/>", { status: 429 }), "fallback")).resolves.toBe("Too many requests. Please wait a moment and try again.");
  });

  it("never surfaces raw parser output for any non-JSON body", async () => {
    for (const status of [500, 502, 503, 504]) {
      const message = await readError(new Response("<!DOCTYPE html><html>gateway</html>", { status }), "The service is unavailable.");
      expect(message).toBe("The service is unavailable.");
      expect(message).not.toContain("DOCTYPE");
      expect(message).not.toContain("Unexpected token");
    }
  });

  it("prefers the application's own message when the server sent one", async () => {
    await expect(readError(json({ error: "Enter a more specific legal question." }, 400), "fallback")).resolves.toBe("Enter a more specific legal question.");
  });

  it("falls back when the body is JSON but carries no usable error", async () => {
    await expect(readError(json({}, 500), "fallback")).resolves.toBe("fallback");
    await expect(readError(json({ error: "" }, 500), "fallback")).resolves.toBe("fallback");
    await expect(readError(json({ error: { nested: true } }, 500), "fallback")).resolves.toBe("fallback");
  });
});

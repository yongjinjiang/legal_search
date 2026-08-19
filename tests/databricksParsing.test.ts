import { describe, expect, it } from "vitest";
import { extractDatabricksError, parseDatabricksResults, sanitizeDatabricksLogValue, SearchServiceError } from "../src/lib/databricks/search";
const columns = ["chunk_id", "case_id", "case_name", "citation", "page_start", "page_end", "chunk_text"];
describe("Databricks parsing", () => { it("maps manifest columns and preserves rank", () => { const rows = parseDatabricksResults({ manifest: { columns: columns.map((name) => ({ name })) }, result: { data_array: [["c1", "case", "Case", "1 U.S. 1", 2, 3, "Text"]] } }); expect(rows[0]).toMatchObject({ chunkId: "c1", rank: 1, pageStart: 2 }); }); it("rejects malformed and missing fields", () => { expect(() => parseDatabricksResults({ result: { data_array: [] } })).toThrow(SearchServiceError); expect(() => parseDatabricksResults({ manifest: { columns: columns.map((name) => ({ name })) }, result: { data_array: [["c1", null, "Case", "cite", 1, 2, "text"]] } })).toThrow("incomplete"); }); });

describe("Databricks error diagnostics", () => {
  it("extracts structured error details and request IDs", async () => {
    const response = new Response(JSON.stringify({ error_code: "INVALID_PARAMETER_VALUE", message: "Unsupported column" }), { status: 400, headers: { "x-databricks-request-id": "request-123" } });
    await expect(extractDatabricksError(response)).resolves.toEqual({ status: 400, errorCode: "INVALID_PARAMETER_VALUE", message: "Unsupported column", requestId: "request-123" });
  });

  it("redacts tokens, bearer credentials, emails, and line breaks", () => {
    const unsafe = "Bearer secret-value dapi1234567890abcdef eyJ1234567890abcdefghijklmnop user@example.com\nnext line";
    const safe = sanitizeDatabricksLogValue(unsafe);
    expect(safe).not.toContain("secret-value");
    expect(safe).not.toContain("dapi1234567890abcdef");
    expect(safe).not.toContain("user@example.com");
    expect(safe).not.toContain("\n");
  });

  it("does not expose non-JSON response bodies", async () => {
    const response = new Response("<html>proxy details</html>", { status: 502 });
    const details = await extractDatabricksError(response);
    expect(details.message).toBe("Databricks returned a non-JSON error response.");
    expect(details.message).not.toContain("proxy details");
  });
});

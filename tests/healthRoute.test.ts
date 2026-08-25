import { afterEach, describe, expect, it } from "vitest";
import { GET as health } from "../src/app/api/health/route";

const originalEnv = { ...process.env };
const clear = () => { for (const key of ["MOCK_DATABRICKS", "DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_INDEX_NAME", "DATABRICKS_CHAT_MODEL"]) delete process.env[key]; };

afterEach(() => { process.env = { ...originalEnv }; });

describe.sequential("health route", () => {
  it("reports mock mode as serving search without chat", () => {
    clear();
    process.env.MOCK_DATABRICKS = "true";
    const response = health();
    expect(response.status).toBe(200);
    return expect(response.json()).resolves.toMatchObject({ status: "degraded", searchMode: "mock", searchConfigured: true, chatConfigured: false });
  });

  it("reports ok when live search and chat are both configured", () => {
    clear();
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    process.env.DATABRICKS_INDEX_NAME = "catalog.schema.index";
    process.env.DATABRICKS_CHAT_MODEL = "endpoint";
    const response = health();
    expect(response.status).toBe(200);
    return expect(response.json()).resolves.toMatchObject({ status: "ok", searchMode: "live", searchConfigured: true, chatConfigured: true });
  });

  // The deployment check in the README relies on this: a live deployment missing search
  // credentials previously reported status "ok" and passed.
  it("fails the check when live mode lacks search configuration", async () => {
    clear();
    const response = health();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", searchMode: "live", searchConfigured: false });
  });

  it("fails the check when the index name alone is missing", async () => {
    clear();
    process.env.DATABRICKS_HOST = "https://workspace.example";
    process.env.DATABRICKS_TOKEN = "secret";
    const response = health();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "unavailable", searchConfigured: false });
  });
});

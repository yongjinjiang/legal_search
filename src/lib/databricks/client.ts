export { fetchWithTimeout, HttpTimeoutError, isAbortError } from "@/lib/http";

export type DatabricksConnection = { host?: string; token?: string };

export function databricksConnection(): DatabricksConnection {
  return {
    host: process.env.DATABRICKS_HOST?.replace(/\/$/, ""),
    token: process.env.DATABRICKS_TOKEN,
  };
}

export type DatabricksConnection = { host?: string; token?: string };

export function databricksConnection(): DatabricksConnection {
  return {
    host: process.env.DATABRICKS_HOST?.replace(/\/$/, ""),
    token: process.env.DATABRICKS_TOKEN,
  };
}

export async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

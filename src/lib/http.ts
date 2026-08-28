/** Abort-backed fetch. Every outbound provider call is bounded so a hung upstream cannot hold a
 *  serverless invocation open for its whole platform budget. */
export async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

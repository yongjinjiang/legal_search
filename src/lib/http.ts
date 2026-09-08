/** Raised when the request exceeded its budget. Distinct from a malformed body so a caller can
 *  report a stalled read as a timeout rather than as an unreadable response. */
export class HttpTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`The request exceeded its ${timeoutMs}ms budget.`);
    this.name = "HttpTimeoutError";
  }
}

/** What the consumer can ask about the request it is reading. `timedOut` lets a body-parse
 *  failure be attributed correctly: an aborted read and a syntactically broken payload both
 *  reject, but only one of them is a timeout. */
export type FetchTimeoutContext = { readonly signal: AbortSignal; timedOut(): boolean };

/**
 * Abort-backed fetch whose budget covers the whole exchange, headers *and* body.
 *
 * The earlier version cleared its timer the moment `fetch` resolved, which is only the headers.
 * Everything after that — `response.json()` on a stalled or slow-trickling body — ran unbounded,
 * so a hung upstream could still hold a serverless invocation open for its whole platform budget.
 * A review probe measured 179ms against a 20ms budget with the signal never aborted.
 *
 * The consumer therefore runs inside the timer's lifetime and the timer is cleared only once it
 * returns, which is also why the body is read through a callback rather than by returning the
 * `Response`: a returned response could always be consumed after the helper had already let go.
 */
export async function fetchWithTimeout<T>(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response, context: FetchTimeoutContext) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  const timeout = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
  const context: FetchTimeoutContext = { signal: controller.signal, timedOut: () => expired };
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await consume(response, context);
  } catch (error) {
    // Once our own timer has fired the request genuinely overran its budget, whatever shape the
    // resulting rejection took: undici reports an aborted body read as an AbortError in some
    // versions and as a wrapped TypeError in others, and neither is worth pattern-matching.
    if (expired) throw new HttpTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** A rejection that came from aborting the request rather than from the payload itself. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof HttpTimeoutError) return true;
  const name = (error as Error | undefined)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const cause = (error as { cause?: { name?: string } } | undefined)?.cause;
  return cause?.name === "AbortError" || cause?.name === "TimeoutError";
}

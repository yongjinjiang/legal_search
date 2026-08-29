export class EmbeddingServiceError extends Error {
  /** `retryable` marks a failure that a later attempt could plausibly survive — rate limiting, a
   *  timeout, an unreachable host, an upstream outage. A malformed or contract-violating response
   *  is not retryable: repeating it wastes the build's time and money to fail identically.
   *  Status alone cannot express this, because both classes surface as 502. */
  constructor(public status: number, message: string, public retryable = false) { super(message); }
}

/** The only surface retrieval depends on. Swapping OpenAI for another pay-per-request provider
 *  means adding one module that satisfies this interface and one branch in `embeddingProvider`;
 *  nothing in the ranking code changes. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** `timeoutMs` lets a route cap this call by whatever remains of its own budget. */
  embedQuery(text: string, timeoutMs?: number): Promise<number[]>;
  /** Offline index building. Runtime never calls this. */
  embedDocuments(texts: string[]): Promise<number[][]>;
}

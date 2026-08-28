export class EmbeddingServiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The only surface retrieval depends on. Swapping OpenAI for another pay-per-request provider
 *  means adding one module that satisfies this interface and one branch in `embeddingProvider`;
 *  nothing in the ranking code changes. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  /** Offline index building. Runtime never calls this. */
  embedDocuments(texts: string[]): Promise<number[][]>;
}

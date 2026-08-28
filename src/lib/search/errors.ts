/** Public-facing retrieval failure. `message` is always a string that is safe to render to an
 *  anonymous visitor: no credentials, no provider diagnostics, no stack traces. */
export class SearchServiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

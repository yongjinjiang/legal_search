// Cost and abuse limits for every paid call the application can make. They live in one module
// because the public site pays per request: a bound that only exists inside a prompt string or a
// UI attribute is a bound that a direct API caller does not have to respect.

/** Retrieval. Query length is also enforced by the request schema; the chunk depth caps how much
 *  of the 234-chunk corpus a single response may carry back to the browser. */
export const MAX_QUERY_LENGTH = 2000;
export const MAX_CHUNK_RESULTS = 50;
export const DEFAULT_CHUNK_RESULTS = 20;

/** Embeddings. One query embedding per ANN or HYBRID search; FULL_TEXT makes no network call. */
export const EMBEDDING_TIMEOUT_MS = 10_000;
/** Offline builder only: the embeddings endpoint accepts batched inputs, so the 234-chunk corpus
 *  is built in a handful of requests rather than 234. Sized against tokens, not documents: at
 *  ~900 tokens per chunk a batch of 64 is ~60k tokens in one request, which exceeds the
 *  per-request and per-minute ceilings on lower OpenAI usage tiers and fails as "Request too
 *  large". Sixteen keeps a batch near 16k tokens. Override with --batch-size. */
export const EMBEDDING_BATCH_SIZE = 16;
/** Build-time retry budget for a rate-limited or transient provider failure. Query-time calls
 *  deliberately do not retry: a visitor waiting on a search should get a fast, honest error. */
export const EMBEDDING_BUILD_RETRY_DELAYS_MS = [2_000, 6_000, 18_000, 45_000];

/** Technical guide. */
export const MAX_QUESTION_LENGTH = 3000;
export const CHAT_TIMEOUT_MS = 30_000;
export const MAX_GUIDE_OUTPUT_TOKENS = 1_600;

/** Legal research summary. Deliberately narrower than retrieval: the LLM sees the best few
 *  passages, never the corpus. Sending all 234 chunks would cost roughly 200k input tokens per
 *  click for no measurable gain in grounding. */
export const SUMMARY_MAX_CASES = 5;
export const SUMMARY_MAX_PASSAGES = 8;
export const SUMMARY_PASSAGE_CHARS = 1_800;
export const SUMMARY_TIMEOUT_MS = 45_000;
export const MAX_SUMMARY_OUTPUT_TOKENS = 2_000;

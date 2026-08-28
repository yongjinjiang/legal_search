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
// Both LLM routes declare maxDuration = 60, so the application timeout has to sit below that
// platform ceiling with room left to serialise an error response. Measured: a detailed guide
// answer over ~5,900 prompt tokens runs 22-30s on gpt-5-mini, so 30s was on the boundary and
// aborted mid-answer.
export const CHAT_TIMEOUT_MS = 50_000;
// Reasoning models spend this budget on reasoning tokens *before* emitting any visible text, so
// a cap that looks generous for the answer can be consumed entirely by reasoning and return an
// empty response. Measured against gpt-5-mini on this project's detailed context (~5,900 prompt
// tokens): at 1,600 the model spent all 1,600 reasoning and produced nothing; at 2,400 reasoning
// fell to 64 and it produced ~8,700 characters. 3,200 leaves margin above that cliff.
export const MAX_GUIDE_OUTPUT_TOKENS = 3_200;

/** Legal research summary. Deliberately narrower than retrieval: the LLM sees the best few
 *  passages, never the corpus. Sending all 234 chunks would cost roughly 200k input tokens per
 *  click for no measurable gain in grounding. */
export const SUMMARY_MAX_CASES = 5;
export const SUMMARY_MAX_PASSAGES = 8;
export const SUMMARY_PASSAGE_CHARS = 1_800;
export const SUMMARY_TIMEOUT_MS = 50_000;
// Same failure mode as the guide, measured on the real summary prompt (~3,800 prompt tokens):
// at 2,000 the model spent all 2,000 reasoning and returned empty; at 3,000 reasoning fell to
// 256 and it produced ~9,500 characters. 4,000 leaves margin.
export const MAX_SUMMARY_OUTPUT_TOKENS = 4_000;

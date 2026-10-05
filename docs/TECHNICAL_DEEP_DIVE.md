# Technical Deep Dive

## Problem and corpus

The project studies retrieval — not legal advice — over eight public Supreme Court
employment-discrimination and retaliation opinions. The deliberately compact corpus makes errors
inspectable. PDFs are extracted with PyMuPDF, retaining page markers; metadata and validation
scripts enforce case IDs, citations, sources, page counts, and benchmark labels.

## Chunking and ingestion

Page-aware paragraphs are the first boundary, sentences split oversized units, and chunks target
900 tokens with 125-token overlap. This balances enough doctrinal context against localized
passages. The result is 234 chunks across 8 cases, distributed very unevenly: *Bostock* has 101,
*Nassar* 39, and *Thompson* 7. That imbalance drives most of the interesting retrieval behaviour.

## Architecture: why it changed

Phase 1 stored chunks in the `workspace.default.legal_chunks` Delta table with Change Data Feed,
synced to the `workspace.default.legal_chunks_index` AI Search index on `legal-search-endpoint`
using `databricks-gte-large-en` embeddings. This was the right way to establish three retrieval
baselines quickly: managed ANN, managed lexical, managed hybrid, and a controlled benchmark, with
no retrieval code to write or defend.

It was the wrong way to *host* the result. An AI Search endpoint bills for provisioned serving
capacity continuously, independent of query volume. This corpus is 234 chunks and this deployment
is a portfolio demonstration that may serve a handful of queries a day. The infrastructure was
sized for a workload that does not exist.

Phase 2 replaced the managed index with an application-level engine. The decision rests on a
concrete number: 234 vectors × 1024 dimensions is a 958 KB matrix, and a full linear scan over it
is a sub-millisecond multiply-accumulate loop. At that scale, the local scan is the default because a remote vector service is not required for
latency or capacity. An optional Pinecone path is implemented to study the tradeoff at larger
scale; selecting it adds a remote vector query rather than replacing the whole search engine.

## Static artifacts

`scripts/build_search_index.ts` reads the chunk CSV and writes four files to `data/search/`, all
committed to the repository:

| File | Size | Contents |
|---|---:|---|
| `documents.json` | 930 KB | Chunk metadata and text, in canonical order |
| `bm25_index.json` | 539 KB | Postings, document lengths, and BM25 configuration |
| `embeddings.json` | 1248 KB | Base64 Float32 matrix, 234 × 1024, L2-normalised |
| `index_manifest.json` | 1 KB | Timestamp, row count, source file SHA-256, chunk-order digest, embedding provider/model/dimensions, BM25 config, tokenizer version |

Vectors are base64 Float32 rather than JSON numbers: the numeric form is roughly three times
larger and reintroduces decimal rounding, while base64 round-trips the exact float32 bits.

The artifacts are positional — row `i` of the embedding matrix is document `i` — so they are
cross-checked at load. The manifest carries a SHA-256 digest of length-prefixed chunk IDs and text; if a
rebuild reordered the corpus without refreshing every file, the mismatch is refused rather than
served as a silently mis-attributed ranking. Model and dimension mismatches between the runtime
configuration and the built index are refused the same way. The builder is idempotent: it reuses
committed vectors when the corpus, model, and dimensions are unchanged, so a tokenizer or BM25
change costs no API calls.

## Retrieval methods

**Tokenizer** (`legal-en-v1`). Shared by the offline builder and the query path, so a change
invalidates the artifact rather than silently skewing query terms against document terms.
Diacritics, curly punctuation, and dash variants fold, so "fiancé" and "fiance" are one term. The
section sign becomes the word "section", making `§1514A` reachable from "Section 1514A". A
compound is indexed under its full form, its separator-free form, and its parts, so "but-for" in
an opinion matches "but for" in a query and "u.s.c" matches "usc". No stopword list is used: with
non-negative IDF a term appearing in all 234 chunks scores about 0.002, so the arithmetic
suppresses common words without a hand-curated list that might remove "any" from *"filed any
complaint"*.

**BM25.** Standard saturation and length normalisation with `k1 = 1.2`, `b = 0.75`, exposed as
constants and recorded in the manifest. IDF uses Lucene's non-negative variant; the textbook form
goes negative above 50% document frequency, which in a corpus entirely about retaliation would
penalise a document for containing "retaliation". Postings are stored flat as `[docIndex, tf, …]`
pairs. Query terms are de-duplicated, matching Lucene: a repeated query term does not multiply its
own contribution.

**Semantic.** One embedding request per query, then a dot product against every corpus row. Both
sides are unit length, so the dot product is the cosine. A query embedding of the wrong width, a
zero vector, or a non-finite value is refused rather than scored.

**Hybrid.** Reciprocal Rank Fusion, `score(d) = 1/(k + rank_semantic) + 1/(k + rank_lexical)`,
with `k = 60` and candidate depth 30. Ranks are fused, never raw scores, because BM25 scores are
unbounded and cosine scores live in [-1, 1]. A document present in only one list contributes only
that term rather than being assigned a synthetic worst rank, which would make the fused score
depend on candidate-list length. Ties break on best contributing rank, then on document index, so
the ordering is total and reproducible.

Depth 30 was chosen by sweep rather than convention. RRF's usual depths assume corpora of
millions; here 50 candidates is 21% of the entire corpus, deep enough that chunks BM25 barely
matched still earn rank credit and dilute strong semantic evidence.

## Case collapse

Results are sorted by chunk rank and collapsed by `case_id`; the first passage determines case
order and other passages are retained for inspection. This stops *Bostock*'s 101 chunks from
occupying several visible ranks at once.

Collapse is display-level deduplication applied *after* retrieval, so it cannot recover a case
that never entered the candidate chunk set. That limitation is now cheap to fix — retrieving 50 or
234 chunks costs nothing locally — but the depth was left at 20 to keep the benchmark comparable
with the Phase 1 baseline. Candidate-level diversification, two-stage retrieval, or reranking
before collapse would be the real fix.

## Benchmark and failure analysis

The 18-query benchmark pairs natural-language fact patterns with exact-term queries across the
eight cases. Recall@k and reciprocal rank are computed after case collapse. Fifteen of the
eighteen queries are answered at rank one by all three methods; the comparison rests on Q01, Q17
and Q18. The three methods tie on Recall@3 without sharing a blind spot — ANN's one top-three miss
is Q18, full text's and hybrid's is Q17 — and hybrid holds the highest Recall@1 outright. See `EVALUATION_RESULTS.md` for the measured values and `LOCAL_RETRIEVAL_EVALUATION.md` for
the embedding dimension tradeoff, the BM25 sweep, and the 100-cell RRF grid.

Q17 exposes a candidate-diversity weakness: RRF scores each chunk independently, and case collapse
keeps the best chunk rather than summing a case's chunk scores. Long opinions can occupy many
candidate slots, leaving short opinions below the display cutoff. *Thompson* has 7 chunks,
*Bostock* 101, and *Nassar* 39. This is candidate saturation, not accumulated case-level votes. Case-level fusion was implemented and measured as an alternative; it fixed Q17
but lowered Recall@1 and Recall@3 overall, and was rejected.

Reranking was attempted in Phase 1 but the workspace reported that it was not enabled. It belongs
after candidate retrieval and before case collapse, but no results should be inferred.

## Web architecture and security

The App Router UI calls Next.js route handlers. `/api/search` is pure retrieval: it makes no
language-model call of any kind, and for FULL_TEXT it makes no outbound request at all.
`/api/summarize` is the only path on which a legal query reaches a language model, and it runs
only when a visitor clicks the action; it re-runs retrieval server-side rather than trusting
passages posted back by the browser.

Embedding and language-model access sit behind small server-side provider interfaces
(`embedQuery`, `complete`), so a provider swap is a local change and no model name is referenced
from UI or retrieval code. The chat provider adapts its request shape to the model family — gpt-5
and o-series models take `max_completion_tokens` and reject a non-default temperature — so the
model stays swappable by environment variable.

Chat context is assembled server-side from a concise standard document and optional detailed
documents plus current retrieval state. The endpoint accepts a single question rather than a
caller-supplied transcript, so assistant turns cannot be forged. Retrieval state is validated
against a schema, trimmed to the five highest-ranked cases, and passed inside explicit untrusted
delimiters in the user message; the system prompt directs the model to treat it as quoted data and
never as instructions. Input lengths, result counts, passage counts, output-token budgets, and
request durations are capped in one module because a bound that exists only in a prompt string or
a UI attribute is a bound a direct API caller does not have to respect.

Malformed request bodies are rejected as client errors; unrecognized failures are mapped to
public-safe messages rather than surfacing internal detail; API keys are never logged and never
appear in an error message; prompts are not persisted; and the chatbot has no tools or arbitrary
execution. Mock mode labels every fixture passage inline so a development result cannot be
mistaken for a measured one, and production never falls back to it: a failed embedding call
surfaces as a configuration or service error, never as a plausible-looking fake ranking.

At larger scale this architecture stops being appropriate. A linear scan is fine at 234 vectors
and untenable at a million; that is where an approximate index, partitioning and filtering by
jurisdiction, court, date, statute, and document type, sharded lexical indexes, caching,
per-slice evaluation, and selective reranking all become necessary. The engineering judgment here
is about matching infrastructure to corpus size, not about vector databases being unnecessary in
general.

## Optional Pinecone vector backend

`SEARCH_BACKEND` selects `local` (default), `pinecone`, or the retained `databricks` comparison
adapter. Pinecone mode makes one query embedding and a remote cosine-index query for ANN and
HYBRID. BM25, RRF, document lookup and case collapse remain local; FULL_TEXT never calls Pinecone.
The offline uploader uses the existing normalized 1024-dimensional vectors, creates a serverless
index if necessary, and verifies vector count, candidate identity and cosine scores with a 0.0005 tolerance. A corpus/model-specific
namespace prevents using an old corpus after a rebuild. Unknown returned IDs fail explicitly.
There is no automatic fallback to local vectors or mock results after a Pinecone failure.

Backend configuration is injected server-side into the technical guide, without secrets. It
identifies the selected backend and mock mode for this instance, not a remote readiness result.
The existing benchmark numbers describe the local engine and the Phase 1 Databricks baseline;
they should not be relabelled as a new Pinecone benchmark or a quality evaluation of the LLM.

## Passage attribution and request bounds

`data/metadata/opinion_sections.json` records reviewed source URLs and section ranges for all
eight PDFs. `readLocalIndex` joins that catalog only when its corpus digest matches the validated
document table. Overlapping boundary pages yield mixed labels; unknown or changed corpora stay
unclassified. This metadata join leaves the committed vectors and chunk texts unchanged. Each
visible best or additional passage links to the source PDF using `#page=` with a 1-based PDF page.
The labels distinguish Court opinion, concurrence, dissent, syllabus, and front matter. They
do not establish sentence-level authorship on shared pages or convert PDF pages into reporter
pinpoint citations.

The summary prompt receives these section labels and author names for each selected passage.
The model returns JSON paragraphs and numbered passage IDs, validated before display.
The server resolves used IDs to case names, original PDF ranges, labels and links; the UI
keeps each reference separate. Invalid IDs or model-authored inline page citations fail safely.
This checks citation identity, not the accuracy of each prose claim.
It must distinguish dissent/concurrence from the Court's reasoning, avoid treating a headnote as
an opinion, and state when a majority holding cannot be verified from supplied Court passages.
At most eight passages, 1,800 characters each, are selected round-robin across five cases.

The technical guide's browser request contains only five case names/citations, section labels
and at most 900 characters of each best passage. Duplicate best passages, full passage arrays and
other search fields are removed before serialization, keeping normal requests below the 64 KB
HTTP limit. The server retains schema validation, prompt trimming, and untrusted delimiters.
An empty result array is a completed zero-match search, with a visible explanation and a full-text
retry action that runs semantic search on the completed query.

Pinecone host discovery and vector query consume a shared total deadline, including body reads.
Concurrent discovery waiters keep their own waiting budgets. The uploader upserts an unchanged
corpus without clearing its active namespace; three score probes allow near-tie swaps but reject
unknown/duplicate IDs, incorrect scores, material ordering inversions and missing stronger
candidates. Exact ordering is diagnostic, not an upload acceptance criterion.

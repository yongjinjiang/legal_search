# Project Context Summary

Legal Retrieval Explorer is a public research prototype for semantic, lexical, and hybrid
retrieval over public U.S. Supreme Court opinions. It is not legal advice. The corpus contains 8
opinions, 350 pages, approximately 693,422 extracted characters, and 234 provenance-aware chunks.

PDFs were extracted page by page with PyMuPDF. Text was divided at page-aware paragraph and
sentence boundaries into approximately 900-token chunks with a 125-token overlap; 228 of 234
chunks fall in the preferred 700–1,000-token range. Metadata keeps case identity, citation, page
range, topic, and source provenance with each chunk.

## Two phases, and why the architecture changed

Phase 1 built the corpus as a Delta table with Change Data Feed and indexed it in Databricks AI
Search using `databricks-gte-large-en` embeddings (1,024 dimensions), served by
`legal-search-endpoint`. That established ANN, lexical, and hybrid baselines quickly on managed
infrastructure and produced the original 18-query benchmark.

Phase 2 moved retrieval into the application. The reason was cost shape, not a failure of the
prototype: an AI Search endpoint bills for provisioned serving time whether or not anyone queries
it, and this public demonstration corpus is 234 chunks. A linear similarity scan over 234 vectors
is sub-millisecond, so a continuously provisioned search service was paying rent to answer a
handful of queries a day. The production demo now uses precomputed embeddings, local BM25, local
vector similarity, and Reciprocal Rank Fusion, which reduces idle infrastructure cost to
effectively zero while preserving the retrieval experiment.

## How production retrieval works now

Four static artifacts are built offline and committed to the repository: a document table, a BM25
index, a base64 Float32 embedding matrix, and a manifest recording the source file hash, corpus
size, embedding model and dimensions, BM25 configuration, and tokenizer version. Nothing embeds
the corpus during a web request.

Every artifact carries a SHA-256 digest of the corpus it was derived from, computed over
length-prefixed chunk IDs *and* chunk text. Because the files are positional — row `i` of the
embedding matrix is document `i` — the digests are cross-checked at load, so a partial rebuild
fails loudly instead of attaching vectors to text they were not built from. Hashing chunk IDs
alone was not enough: editing a passage while keeping its ID left an ID-only digest unchanged.

- **FULL_TEXT** scores BM25 (`k1 = 1.2`, `b = 0.75`) against the precomputed index. It makes no
  network call at all and works with no API key.
- **ANN** makes exactly one embedding request for the query, then computes cosine similarity
  against all 234 corpus vectors. Corpus vectors are stored L2-normalised, so the cosine is a dot
  product.
- **HYBRID** makes one embedding request, runs both rankings, and fuses them with Reciprocal Rank
  Fusion (`k = 60`, candidate depth 30). Ranks are fused, never raw scores: BM25 scores are
  unbounded and cosine scores live in [-1, 1].

Embeddings are `text-embedding-3-large` at 1024 dimensions. That choice was made by benchmark, not
by price: `text-embedding-3-small` at 512 dimensions cost 5.6 points of hybrid Recall@1 and failed
to retrieve *Thompson* on Q17 at all. The runtime refuses to serve a semantic query if the
configured model or dimensions disagree with the built index.

The UI retrieves 20 candidate chunks, groups them by `case_id`, preserves each case's
highest-ranked passage, and assigns unique case ranks; extra passages remain expandable. This
deduplicates what is displayed rather than diversifying what is retrieved: a long opinion can
still fill the candidate chunks and exclude a shorter case before collapse runs.

There is no vector database, no always-on search service, no background compute, and no database.
The public site requires no Databricks credentials of any kind.

## Cost behaviour

Nothing bills while the site is idle. A full-text search costs nothing beyond CPU. A semantic or
hybrid search costs one embedding request, roughly 50 tokens. The technical guide and the optional
research summary are the only paths that reach a language model, and the research summary runs
only when a visitor clicks the button — searching never invokes one.

## Benchmark

An 18-query controlled benchmark measures case-level retrieval. The local engine achieves ANN
Recall@1 0.8333, Recall@3 0.9444, Recall@5 1.0000, MRR 0.8907; FULL_TEXT 0.8889, 0.9444, 0.9444,
0.9153; HYBRID 0.9444, 0.9444, 0.9444, 0.9537. The Phase 1 Databricks baseline was ANN 0.8889,
0.9444, 1.0000, 0.9278; FULL_TEXT 0.7778, 0.9444, 0.9444, 0.8598; HYBRID 0.8889, 1.0000, 1.0000,
0.9259.

These are development-set figures: the same 18 queries selected the configuration and then
reported it, with no held-out test set. The migration traded coverage for precision. Lexical retrieval improved clearly. Hybrid became
sharper at rank one and leads on MRR, but lost the perfect top-three coverage Databricks hybrid
had. Semantic retrieval regressed slightly at rank one. Fifteen of eighteen queries are answered
at rank one by all three methods, so the comparison rests on three: Q01, where ANN alone places the
gold case second, and Q17 and Q18. Hybrid's Recall@1 is the highest of the three outright, 17 of
18, and the equal Recall@3 hides different misses — ANN's is Q18, full text's and hybrid's is
Q17.

Q17 paraphrased third-party retaliation without canonical terminology: semantic retrieval places
*Thompson* at rank 3, lexical at rank 7 — the same rank Databricks full-text produced — and hybrid
at 6. The UI displays five cases, so under full text and hybrid the gold case is ranked below what
is shown rather than missing from the ranking. That single query is why hybrid Recall@3 is 0.9444 rather than 1.0000. Q18 was deliberately
underspecified with seven relevant cases; hybrid places *Burlington* first and returns 5 of 7
relevant cases in the top five, while ANN reproduces the Phase 1 result exactly at rank 5 with
3/7, 4/7, and 5/7 coverage.

The technical guide answers from this project's documentation rather than generating answers from
the opinions themselves; it uses this summary in standard mode and adds the technical deep dive,
evaluation results, and future directions in detailed mode. Context is assembled server-side, and
the endpoint accepts a single question rather than a caller-supplied transcript, so assistant
turns cannot be forged. When a search is on screen, its state is schema-validated, trimmed to the
five highest-ranked cases, and supplied inside explicit untrusted delimiters that the model must
treat as quoted data and never as instructions. Credentials stay server-side, prompts are not
persisted, and the guide has no tools or arbitrary execution.

Databricks reranking was planned in Phase 1 but the workspace returned `InvalidParameterValue:
Reranking is not yet enabled for this workspace.` No reranker results exist. Future work includes
reranking, metadata filters, richer corpora, expert judgments, feedback-driven learning, and
citation-grounded answer generation.

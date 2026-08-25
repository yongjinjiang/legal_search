# Technical Deep Dive

## Problem and corpus

The project studies retrieval—not legal advice—over eight public Supreme Court employment-discrimination and retaliation opinions. The deliberately compact corpus makes errors inspectable. PDFs are extracted with PyMuPDF, retaining page markers; metadata and validation scripts enforce case IDs, citations, sources, page counts, and benchmark labels.

## Chunking and ingestion

Page-aware paragraphs are the first boundary, sentences split oversized units, and chunks target 900 tokens with 125-token overlap. This balances enough doctrinal context against localized passages and stays well inside the GTE model's 8,192-token context. The result is 234 chunks. The source Delta table is `workspace.default.legal_chunks`. Delta Change Data Feed records row-level changes; Delta Sync can consume them to keep the AI Search index current.

## Search index and methods

`workspace.default.legal_chunks_index` runs on `legal-search-endpoint`, with `chunk_text` as source text, `chunk_id` as primary key, and `databricks-gte-large-en` embeddings (1,024 dimensions). ANN retrieves by vector similarity and is strong on conceptual paraphrases. FULL_TEXT uses lexical/BM25-style matching and is strong on exact doctrine. HYBRID combines their ranked lists through Reciprocal Rank Fusion. Because score semantics differ, the application compares ranks rather than raw scores.

The Next.js server sends `query_text`, `query_type`, requested columns, and 20 candidates to the Databricks REST API. Credentials never reach browser code. Results are sorted by chunk rank and collapsed by `case_id`; the first passage determines case order and other passages are retained for inspection.

## Benchmark and failure analysis

The 18-query benchmark pairs natural-language fact patterns with exact-term queries across the eight cases. Recall@k and reciprocal rank are computed after case collapse, which stops long opinions such as *Bostock* (101 chunks) from occupying many user-facing ranks. Collapse is a display-level deduplication applied after retrieval, so it cannot recover a case that never entered the candidate chunk set. See `EVALUATION_RESULTS.md` for all measured values. Q17 demonstrates semantic relationship matching; Q18 demonstrates that broad prompts can have multiple valid precedents rather than one uniquely correct answer.

Reranking was attempted but the workspace reported that it was not enabled. It belongs after candidate retrieval and before case collapse, but no results should be inferred.

## Web architecture and security

The App Router UI calls Next.js route handlers. The search adapter calls Databricks AI Search; the chat adapter calls a configured Databricks Model Serving endpoint. Chat context is assembled server-side from a concise standard document and optional detailed documents plus current retrieval state. The endpoint accepts a single question rather than a caller-supplied transcript, so assistant turns cannot be forged. Retrieval state is validated against a schema, trimmed to the five highest-ranked cases, and passed inside explicit untrusted delimiters in the user message; the system prompt directs the model to treat it as quoted data and never as instructions. Input lengths, result counts, and request durations are capped; malformed request bodies are rejected as client errors; unrecognized failures are mapped to public-safe messages rather than surfacing internal detail; prompts are not persisted; and the chatbot has no tools or arbitrary execution.

At larger scale, partition and filter by jurisdiction, court, date, statute, and document type; monitor Delta Sync freshness; add caching and rate limits; evaluate retrieval by domain slice; use reranking selectively; and build expert relevance sets. Production also needs identity, audit logs, secret rotation, data-retention policy, and traceable citation-grounded answers.

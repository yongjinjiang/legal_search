# Project Context Summary

Legal Retrieval Explorer is a public research prototype for semantic, lexical, and hybrid retrieval over public U.S. Supreme Court opinions. It is not legal advice. The corpus contains 8 opinions, 350 pages, approximately 693,422 extracted characters, and 234 provenance-aware chunks.

PDFs were extracted page by page with PyMuPDF. Text was divided at page-aware paragraph and sentence boundaries into approximately 900-token chunks with a 125-token overlap; 228 of 234 chunks fall in the preferred 700–1,000-token range. Metadata keeps case identity, citation, page range, topic, and source provenance with each chunk.

Chunks are stored in the `workspace.default.legal_chunks` Delta table. Change Data Feed can expose row changes to Delta Sync, which keeps the `workspace.default.legal_chunks_index` AI Search index aligned without rebuilding it manually. The index uses `databricks-gte-large-en` embeddings (1,024 dimensions; 8,192-token context) and is served by `legal-search-endpoint`.

The system supports ANN semantic search, FULL_TEXT lexical search, and HYBRID search. Databricks hybrid retrieval combines semantic and lexical rankings using Reciprocal Rank Fusion. Raw scores from different algorithms are not treated as comparable. The UI retrieves 20 candidate chunks, groups them by `case_id`, preserves each case's highest-ranked passage, and assigns unique case ranks; extra passages remain expandable.

An 18-query controlled prototype benchmark measured case-level retrieval. ANN achieved Recall@1 0.8889, Recall@3 0.9444, Recall@5 1.0000, and MRR 0.9278. FULL_TEXT achieved 0.7778, 0.9444, 0.9444, and 0.8598. HYBRID achieved 0.8889, 1.0000, 1.0000, and 0.9259. Thus hybrid did not dramatically improve average rank over ANN; its value here was robustness: all 18 primary cases appeared in the top three.

Q17 paraphrased third-party retaliation without canonical terminology. ANN ranked Thompson first while FULL_TEXT ranked it seventh, showing semantic retrieval's advantage on relationships and fact patterns. Q18 was deliberately underspecified; several retaliation cases were legitimately relevant. ANN placed the primary Burlington case fifth while retrieving 3/7 relevant cases in the top 3, 4/7 in the top 4, and 5/7 in the top 5.

Databricks reranking was planned, but the workspace returned `InvalidParameterValue: Reranking is not yet enabled for this workspace.` No reranker results exist. Future work includes reranking, metadata filters, richer corpora, expert judgments, feedback-driven learning, and citation-grounded answer generation.

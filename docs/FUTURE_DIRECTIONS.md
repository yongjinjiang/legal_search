# Future Directions

These are planned experiments, not implemented features. Near-term retrieval work includes the Databricks reranker when enabled, cross-encoder reranking, query expansion, statute/jurisdiction/date filters, metadata-aware retrieval, citation-graph signals, legal-specific embeddings, and a broader legal corpus.

Evaluation should move toward expert-created graded relevance judgments and lawyer feedback. That feedback could support active learning, learning-to-rank, preference learning, and eventually carefully evaluated reinforcement-learning approaches. Agentic query reformulation and adaptive retrieval may help difficult or underspecified requests, but require guardrails and transparent evaluation.

A later answer-generation layer could synthesize retrieved material with pinpoint citations. Production deployment would also require access control, auditability, retention rules, rate limiting, observability, and formal security review.

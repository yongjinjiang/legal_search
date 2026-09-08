# Future Directions

These are planned experiments, not implemented features.

Retrieval. The clearest known weakness is Q17: Reciprocal Rank Fusion operates on chunk ranks, so
a case accumulates rank credit once per chunk and a 7-chunk opinion is outvoted by a 101-chunk
one. Candidate-level diversification, two-stage retrieval, or a cross-encoder reranker placed
before case collapse would attack this directly, as would deeper retrieval — now free, since a
scan over 234 vectors costs nothing. Case-level fusion was tried and rejected on measurement.
Beyond that: query expansion, statute/jurisdiction/date filters, metadata-aware retrieval,
citation-graph signals, legal-specific embeddings, and a broader corpus.

Evaluation should move toward expert-created graded relevance judgments and lawyer feedback. The
current benchmark is 18 author-labelled queries of which 15 are solved at rank one by every
method, so it can no longer distinguish between good retrieval systems. That feedback could
support active learning, learning-to-rank, preference learning, and eventually carefully evaluated
reinforcement-learning approaches. Agentic query reformulation and adaptive retrieval may help
difficult or underspecified requests, but require guardrails and transparent evaluation.

Architecture. The current design is deliberately matched to a 234-chunk corpus. Growing the corpus
by two or three orders of magnitude would invalidate the linear scan and reintroduce the case for
an approximate index — at which point the Phase 1 architecture, or something like it, becomes the
right answer again. A useful next step would be to establish the corpus size at which a scan stops
being the cheaper option, rather than assuming it either way.

The optional research summary already synthesizes retrieved passages with case names and page
ranges. Extending it toward pinpoint citation verification, quote-level attribution, and automated
grounding checks would make it usable rather than illustrative. Production deployment would also
require access control, auditability, retention rules, rate limiting, observability, and formal
security review.

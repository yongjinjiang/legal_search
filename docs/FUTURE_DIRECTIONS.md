# Future Directions

The experiments below are future work. Optional Pinecone vector retrieval, page-level opinion
section labels, source PDF links, bounded chat context, and empty-result feedback are already
implemented; the default backend remains local.

Retrieval. The clearest known weakness is Q17: Reciprocal Rank Fusion operates on chunk ranks, so
each chunk receives its own score, while case collapse keeps only the best chunk. A long
opinion can saturate candidate slots and crowd a shorter one below the display cutoff; scores
are not summed per case. Candidate-level diversification, two-stage retrieval, or a cross-encoder reranker placed
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

Architecture. The current design is deliberately matched to a 234-chunk corpus. The optional Pinecone path already moves the vector step to a remote index, while keeping
lexical scoring and the document table local. Growing the corpus by orders of magnitude still
requires measuring end-to-end latency, memory, cost, filtering, and lexical-index scaling.
Pinecone alone does not solve those remaining bottlenecks. A useful next step would be to establish the corpus size at which a scan stops
being the cheaper option, rather than assuming it either way.

The optional research summary already synthesizes retrieved passages with case names and page
ranges with page-level opinion attribution and original PDF links. Extending it toward pinpoint citation verification, quote-level attribution, and automated
grounding checks would make it usable rather than illustrative. Production deployment would also
require access control, auditability, retention rules, rate limiting, observability, and formal
security review.

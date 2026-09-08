# Evaluation Results

## Controlled setup

The benchmark contains 18 queries: eight semantic fact-pattern prompts, eight keyword prompts, one
multi-relevant hybrid prompt, and one broad-recall prompt. Metrics are case-level and apply only
to this small prototype benchmark.

Two systems have been measured against it. Phase 1 used Databricks AI Search with
`databricks-gte-large-en` embeddings. Phase 2 — the current public deployment — runs retrieval
inside the application over precomputed `text-embedding-3-large` vectors at 1024 dimensions, local
BM25, and Reciprocal Rank Fusion.

## Current results (local engine)

| Method | Recall@1 | Recall@3 | Recall@5 | MRR |
|---|---:|---:|---:|---:|
| ANN | 0.8333 | 0.9444 | 1.0000 | 0.8907 |
| FULL_TEXT | 0.8889 | 0.9444 | 0.9444 | 0.9153 |
| HYBRID | 0.9444 | 0.9444 | 0.9444 | 0.9537 |

## Phase 1 baseline (Databricks AI Search)

| Method | Recall@1 | Recall@3 | Recall@5 | MRR |
|---|---:|---:|---:|---:|
| ANN | 0.8889 | 0.9444 | 1.0000 | 0.9278 |
| FULL_TEXT | 0.7778 | 0.9444 | 0.9444 | 0.8598 |
| HYBRID | 0.8889 | 1.0000 | 1.0000 | 0.9259 |

The migration was a trade, not an improvement. Lexical retrieval improved substantially: Recall@1
rose from 0.7778 to 0.8889 and MRR from 0.8598 to 0.9153. Hybrid became sharper at rank one
(0.8889 to 0.9444) and leads on MRR (0.9259 to 0.9537), but lost the perfect top-three and
top-five coverage the Databricks hybrid achieved. Semantic retrieval regressed at rank one, from
0.8889 to 0.8333, while holding Recall@3 and Recall@5.

These are development-set results: the same 18 queries selected the embedding model and
dimensions, the BM25 parameters, and the RRF depth, and are then used to report the outcome. No
held-out test set exists, so the table describes the committed engine on this benchmark rather
than estimating performance on unseen queries.

### Per-query rank of the primary gold case

| Query | ANN | FULL_TEXT | HYBRID |
|---|---:|---:|---:|
| Q01 | 2 | 1 | 1 |
| Q02–Q16 | 1 | 1 | 1 |
| Q17 | 3 | 7 | 6 |
| Q18 | 5 | 3 | 1 |

Fifteen of the eighteen queries are answered at rank one by every method, so the whole comparison
rests on Q01, Q17, Q18, and small MRR differences. Differences of this size, on 18 author-labelled
queries, do not establish that one retrieval system is better than another in general.

The equal Recall@3 column hides a real difference: the three methods miss different queries. ANN's
one top-three miss is Q18; full text and hybrid both miss Q17. Hybrid's Recall@1 is the highest of
the three outright — 17 of 18 against full text's 16 and ANN's 15 — rather than tied.

## Multi-relevant metrics

Q17 has two relevant cases and Q18 has seven, so scoring them against a single gold case
understates every method on exactly the two queries designed to test breadth.

| Method | Any relevant @3 | Any relevant @5 | Set recall @3 | Set recall @5 | Set recall @10 |
|---|---:|---:|---:|---:|---:|
| ANN | 1.0000 | 1.0000 | 0.9683 | 0.9841 | 0.9841 |
| FULL_TEXT | 0.9444 | 1.0000 | 0.9127 | 0.9484 | 0.9921 |
| HYBRID | 1.0000 | 1.0000 | 0.9405 | 0.9563 | 0.9921 |

On this view ANN is the strongest method — the reverse of the primary-gold ordering. The headline
table rewards pinpointing one case; this one rewards breadth.

## Failure analysis

**Q17** tested an implicit relationship: one person complained and someone close to them suffered
an adverse action. The query uses none of the vocabulary the opinion uses — no "fiancé", no "third
party", no "zone of interests". Semantic retrieval places *Thompson* at case rank 3 (from chunk
rank 6 of 234). Lexical retrieval places it at rank 7, exactly the rank the Databricks full-text
implementation produced; two independent BM25-style implementations landing on the same position
is evidence the benchmark is measuring the query rather than the engine. Hybrid lands at rank 6,
between its two inputs, and this single query is the entire reason HYBRID Recall@3 is 0.9444
rather than 1.0000. When one input to a fusion is confidently wrong, the compromise is worse than
the better input alone. Both lexical and hybrid rank *Thompson* below the five cases the page
displays; neither fails to retrieve it.

The mechanism is structural: RRF fuses chunk ranks, so a case accumulates rank credit once per
chunk. *Thompson* has 7 chunks; *Bostock* has 101 and *Nassar* 39. A long opinion gets more
chances to occupy a fused slot. A case-level fusion variant was implemented and measured; it
brought *Thompson* into the Q17 top five but lowered HYBRID Recall@1 and Recall@3 overall, so it
was rejected.

**Q18** is ANN's own top-three miss — the only one it has, and a different query from the one full
text and hybrid miss. It deliberately withheld statute, protected activity, and adverse-action
type, so seven of the eight opinions are legitimately relevant. Hybrid places the primary
*Burlington* case first and returns 5 of 7 relevant cases in the top five. ANN reproduces the Phase 1 Databricks result
exactly — Burlington at rank 5, with 3/7 relevant at top 3, 4/7 at top 4, and 5/7 at top 5.
Ranking one of seven relevant precedents fifth is a defensible answer to an underspecified
question, not a retrieval failure.

## Reproducibility

Unlike the Phase 1 table, whose raw per-query rankings were never preserved, the current numbers
ship with their evidence. `data/evaluation/local_retrieval_results.json` records every query's
full case ranking, the index manifest, and the retrieval depth.

```bash
npm run benchmark
.venv/bin/python scripts/evaluate_retrieval.py --score data/evaluation/local_retrieval_results.json
```

The second command uses the original Databricks-era scorer, unmodified, and reproduces the
primary-gold table independently.

The figures the web page displays live in `src/lib/evaluation/localBenchmark.ts`, and
`tests/evaluationConsistency.test.ts` recomputes each of them from the saved runs and the
canonical gold labels in `data/evaluation/legal_search_queries.csv`. To refresh them after a
rebuild, run `npm test -- evaluationConsistency`, correct the constants — and the surrounding
prose — to whatever the failures report, and run it again. The check reads the committed evidence
only; it makes no provider call.

Because Phase 1's per-query rankings were lost, query-level improvement and degradation can only
be stated for the two failures the original documentation described in prose. Everything else is
an aggregate comparison.

See `LOCAL_RETRIEVAL_EVALUATION.md` for the embedding dimension tradeoff, the BM25 parameter
sweep, and the 100-cell RRF grid.

No HYBRID_RERANK results exist because reranking was unavailable in the Phase 1 workspace.

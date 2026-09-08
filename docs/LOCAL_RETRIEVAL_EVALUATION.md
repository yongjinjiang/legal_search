# Local Retrieval Evaluation

This document records the measurements that justified moving production retrieval off Databricks
AI Search and into the application. It is written to be checkable: every number below comes from
`data/evaluation/local_retrieval_results.json`, which stores the full case ranking for all 18
queries under all three methods.

Reproduce it with:

```bash
npm run benchmark
.venv/bin/python scripts/evaluate_retrieval.py --score data/evaluation/local_retrieval_results.json
```

The second command is a deliberate cross-check. `scripts/evaluate_retrieval.py` is the original
Databricks-era scorer and was not modified for this migration; it recomputes the primary-gold
table from the saved rankings and reproduces the TypeScript harness exactly. A metric that only
one implementation can produce is not a measurement.

## Production configuration

| Component | Setting |
|---|---|
| Embeddings | `text-embedding-3-large`, 1024 dimensions, L2-normalised at build time |
| Similarity | Dot product over 234 pre-embedded vectors (cosine, since both sides are unit length) |
| Lexical | BM25, `k1 = 1.2`, `b = 0.75`, no suffix folding |
| Tokenizer | `legal-en-v1`, shared by the offline builder and the query path |
| Fusion | Reciprocal Rank Fusion, `k = 60`, candidate depth 30 |
| Retrieval depth | 20 chunks, matching the Databricks baseline, collapsed to unique cases |

## Headline result

| Method | Recall@1 | Recall@3 | Recall@5 | MRR |
|---|---:|---:|---:|---:|
| ANN | 0.8333 | 0.9444 | 1.0000 | 0.8907 |
| FULL_TEXT | 0.8889 | 0.9444 | 0.9444 | 0.9153 |
| HYBRID | 0.9444 | 0.9444 | 0.9444 | 0.9537 |

### Against the Databricks baseline

| Method | Metric | Databricks | Local | Change |
|---|---|---:|---:|---:|
| ANN | Recall@1 | 0.8889 | 0.8333 | −0.0556 |
| ANN | Recall@3 | 0.9444 | 0.9444 | — |
| ANN | Recall@5 | 1.0000 | 1.0000 | — |
| ANN | MRR | 0.9278 | 0.8907 | −0.0371 |
| FULL_TEXT | Recall@1 | 0.7778 | 0.8889 | **+0.1111** |
| FULL_TEXT | Recall@3 | 0.9444 | 0.9444 | — |
| FULL_TEXT | Recall@5 | 0.9444 | 0.9444 | — |
| FULL_TEXT | MRR | 0.8598 | 0.9153 | **+0.0555** |
| HYBRID | Recall@1 | 0.8889 | 0.9444 | **+0.0556** |
| HYBRID | Recall@3 | 1.0000 | 0.9444 | **−0.0556** |
| HYBRID | Recall@5 | 1.0000 | 0.9444 | **−0.0556** |
| HYBRID | MRR | 0.9259 | 0.9537 | **+0.0278** |

**These are development-set numbers.** The same 18 queries chose the embedding model and
dimensions, the BM25 parameters, and the RRF candidate depth, and are then used to report the
result. There is no held-out test set, so this table accurately describes the committed engine on
this benchmark but is not an unbiased estimate of performance on unseen queries.

**The quality gate is met but not exceeded.** The stated bar was HYBRID Recall@3 ≥ 0.94, ideally
1.0. The local engine reaches 0.9444: it meets the bar and misses the ideal. That single missing
query is Q17, analysed below, and no amount of parameter tuning recovered it.

Read honestly, the change is a trade rather than a win:

- **Lexical retrieval clearly improved.** Recall@1 rose 11 points and MRR 5.5 points over the
  Databricks full-text implementation.
- **Hybrid became sharper at the top and blunter in the tail.** It now places the gold case first
  on 17 of 18 queries instead of 16, and leads the whole comparison on MRR — but it lost the
  perfect top-three and top-five coverage the Databricks hybrid had.
- **Semantic retrieval regressed slightly.** `databricks-gte-large-en` was a stronger retriever on
  this corpus at rank one than `text-embedding-3-large`; ANN gave up 5.6 points of Recall@1 and
  3.7 of MRR while holding Recall@3 and Recall@5.

### Per-query rank of the primary gold case

| Query | ANN | FULL_TEXT | HYBRID |
|---|---:|---:|---:|
| Q01 | 2 | 1 | 1 |
| Q02–Q16 | 1 | 1 | 1 |
| Q17 | 3 | 7 | 6 |
| Q18 | 5 | 3 | 1 |

Fifteen of the eighteen queries are solved at rank one by every method. All of the interesting
behaviour is in Q01, Q17 and Q18.

The identical Recall@3 column is a coincidence of counting, not a shared weakness: ANN's single
top-three miss is Q18, and full text's and hybrid's is Q17. Recall@1 separates them cleanly —
hybrid 17 of 18, full text 16, ANN 15.

**Per-query comparison against Databricks is not possible.** The original workspace run's raw
rankings were never preserved — `docs/EVALUATION_RESULTS.md` recorded this before the migration
began. Only two per-query facts survive in the documentation (Q17 ANN rank 1 / FULL_TEXT rank 7,
and Q18 ANN Burlington rank 5 with 3/7, 4/7, 5/7 coverage). So "queries improved" and "queries
degraded" can be stated only for those two, and for comparisons between local configurations.
Everything else is an aggregate-level comparison.

## Multi-relevant metrics

Q17 has two legitimately relevant cases and Q18 has seven. Scoring them against a single primary
gold case understates every method on exactly the two queries designed to test breadth.

| Method | Any relevant @3 | Any relevant @5 | Set recall @3 | Set recall @5 | Set recall @10 |
|---|---:|---:|---:|---:|---:|
| ANN | 1.0000 | 1.0000 | 0.9683 | 0.9841 | 0.9841 |
| FULL_TEXT | 0.9444 | 1.0000 | 0.9127 | 0.9484 | 0.9921 |
| HYBRID | 1.0000 | 1.0000 | 0.9405 | 0.9563 | 0.9921 |

Every method surfaces at least one relevant precedent in the top five for every query. On the
multi-relevant view ANN is the strongest method, which is the opposite of the primary-gold
ordering — a reminder that the headline table rewards pinpointing one case and penalises breadth.

## Q17 — the one real regression

> "An employee complains about discrimination and soon afterward someone close to that employee
> suffers an adverse employment action. Which Supreme Court cases are most relevant to evaluating
> retaliation?"

Gold: *Thompson v. North American Stainless*. Also relevant: *Burlington Northern v. White*.

| Method | Case ranking | Thompson |
|---|---|---:|
| ANN | nassar, burlington_white, **thompson_nas** | 3 |
| FULL_TEXT | jackson, murray, crawford, burlington, bostock, nassar, **thompson_nas** | 7 |
| HYBRID | burlington, nassar, crawford, jackson, murray, **thompson_nas**, bostock | 6 |

The query describes a third-party relationship without using a single word the opinion uses: no
"fiancé", no "third party", no "zone of interests". This is the query the benchmark exists to
test, and the results split cleanly:

- **Semantic retrieval still captures the relationship.** Thompson is at case rank 3, from chunk
  rank 6 of 234. The Databricks baseline had it at rank 1, so this is a real regression in
  degree — but the relationship is found, which was the stated requirement.
- **Lexical retrieval reproduces the historical failure exactly.** Thompson lands at rank 7 under
  BM25, the same rank Databricks full-text produced. Two independent lexical implementations
  agreeing to the position is good evidence the benchmark is measuring the query, not the engine.
- **Fusion cannot rescue it.** RRF combines a rank-3 semantic signal with a rank-7 lexical one and
  lands on 6. This is the mechanism behind the lost Recall@3: hybrid is a compromise, and when one
  input is confidently wrong, the compromise is worse than the better input alone. The page shows
  five cases, so under full text and hybrid *Thompson* is ranked below the displayed results — it
  is present in the ranking, not absent from it.

Why fusion loses here is structural. RRF operates on chunk ranks, so a case accumulates rank
credit once per chunk. *Thompson* has 7 chunks out of 234; *Bostock* has 101 and *Nassar* 39. A
long opinion gets more chances to occupy a fused slot, and Thompson's single strong passage is
outvoted by many mediocre ones.

**A case-level fusion variant was implemented and measured**, collapsing each ranked list to case
ranks before fusing. It did bring Thompson into Q17's top five, but it was worse overall — on
`text-embedding-3-large@1024` it dropped HYBRID Recall@1 from 0.9444 to 0.8889 and Recall@3 from
0.9444 to 0.8889, because it also promoted whatever BM25 happened to rank first, and on Q17 BM25
ranks *Jackson* first. It was rejected and is not in the codebase.

## Q18 — the broad query

> "A worker says the employer punished them after they raised a workplace concern, but the client
> has not yet identified the statute, the protected activity, or the type of adverse action."

Gold: *Burlington*. Six other cases are relevant, so seven of the eight opinions count.

| Method | Burlington rank | Relevant @3 | @4 | @5 | @7 |
|---|---:|---:|---:|---:|---:|
| ANN | 5 | 3/7 | 4/7 | 5/7 | 5/7 |
| FULL_TEXT | 3 | 3/7 | 4/7 | 4/7 | 6/7 |
| HYBRID | 1 | 3/7 | 4/7 | 5/7 | 6/7 |

ANN reproduces the Databricks ANN result on this query **exactly**: Burlington at rank 5, coverage
3/7 at top 3, 4/7 at top 4, 5/7 at top 5. Those are the same three fractions recorded in the
original evaluation.

Hybrid is the strongest here, placing Burlington first while still returning five of seven
relevant precedents in the top five. This is the query where hybrid retrieval earns its keep, and
it is worth noting that ANN "missing" at Recall@3 here is not a failure in any practical sense:
ranking one of seven legitimately relevant precedents fourth or fifth is a reasonable answer to a
deliberately underspecified question.

## Embedding dimension and model tradeoff

The brief's starting point was `text-embedding-3-small` at 512 dimensions. The instruction was not
to assume that preserved quality. It did not.

| Model | Dims | `embeddings.json` | ANN R@1 | ANN R@3 | ANN R@5 | ANN MRR | HYBRID R@1 | HYBRID MRR | Q17 ANN Thompson |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `3-small` | 512 | 628 KB | 0.8333 | 0.8889 | 0.9444 | 0.8630 | 0.8889 | 0.9167 | not retrieved |
| `3-small` | 1536 | 1876 KB | 0.8333 | 0.9444 | 0.9444 | 0.8889 | 0.9444 | 0.9444 | not retrieved |
| **`3-large`** | **1024** | **1252 KB** | 0.8333 | 0.9444 | 1.0000 | 0.8935 | 0.9444 | 0.9537 | **rank 3** |
| `3-large` | 3072 | 3748 KB | 0.8333 | 1.0000 | 1.0000 | 0.8981 | 0.9444 | 0.9524 | rank 3 |

Findings:

1. **512 dimensions materially reduced quality.** It cost 5.6 points of HYBRID Recall@1, 2.8 of
   HYBRID MRR, 5.6 of ANN Recall@3, and — decisively — it failed to retrieve *Thompson* on Q17 at
   all. It is not a usable configuration for this corpus.
2. **Raising `3-small` to its full 1536 dimensions fixed the aggregate metrics but not Q17.** The
   headline HYBRID numbers match the larger model, yet the Q17 relationship is still missed. This
   is why the aggregate table alone was not treated as sufficient evidence.
3. **`3-large` at 1024 dimensions is the chosen configuration.** It dominates `3-small@1536` on
   every metric measured *and* produces a smaller artifact (1252 KB against 1876 KB), because
   Matryoshka truncation of a stronger model beats the full width of a weaker one here.
4. **3072 dimensions buys one rank position for 3× the storage.** It lifts ANN Recall@3 to 1.0000
   by moving Q18's Burlington from 4th to 3rd — a query where 7 of 8 cases are relevant, so the
   improvement is close to meaningless — while tripling `embeddings.json` to 3.7 MB and tripling
   per-query embedding cost. It was rejected on cost/benefit, not on quality.

**Caveat on reproducibility.** OpenAI embeddings are not bit-identical across calls. Re-embedding
the corpus at `3-large@1024` moved Q18's ANN rank between 4 and 5 across two builds, shifting ANN
MRR between 0.8935 and 0.8907. Ranks that are this close together should be read as ties. The
committed artifact produces 0.8907; a third full re-embed, performed when the artifacts were
rebuilt for the integrity digest, reproduced every metric in the headline table exactly.

## BM25 observations

Every BM25 variant tested produced **identical** Recall@1, Recall@3, and Recall@5. Only MRR and
the Q17 Thompson rank moved at all.

| Suffix folding | k1 | b | R@1 | R@3 | R@5 | MRR | Q17 Thompson | Vocabulary |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **off** | **1.2** | **0.75** | 0.8889 | 0.9444 | 0.9444 | **0.9153** | **7** | 11,391 |
| off | 1.2 | 0.40 | 0.8889 | 0.9444 | 0.9444 | 0.9074 | not retrieved | 11,391 |
| off | 1.2 | 0.00 | 0.8333 | 0.9444 | 0.9444 | 0.8876 | 7 | 11,391 |
| off | 0.9 | 0.75 | 0.8333 | 0.9444 | 0.9444 | 0.8704 | not retrieved | 11,391 |
| off | 1.6 | 0.75 | 0.8889 | 0.9444 | 0.9444 | 0.9153 | 7 | 11,391 |
| off | 2.0 | 0.75 | 0.8889 | 0.9444 | 0.9444 | 0.9153 | 7 | 11,391 |
| on | 1.2 | 0.75 | 0.8889 | 0.9444 | 0.9444 | 0.9167 | not retrieved | 10,041 |
| on | 1.2 | 0.40 | 0.8889 | 0.9444 | 0.9444 | 0.9167 | not retrieved | 10,041 |
| on | 0.9 | 0.75 | 0.8889 | 0.9444 | 0.9444 | 0.9167 | not retrieved | 10,041 |

- **The conventional defaults were kept because nothing beat them.** `k1 = 1.2`, `b = 0.75` sits at
  the top of the unfolded group, and raising `k1` to 1.6 or 2.0 changes nothing — term frequencies
  in ~900-token legal chunks rarely reach the saturation point where `k1` matters.
- **Length normalisation earns its place.** Dropping `b` to 0 costs 5.6 points of Recall@1. In a
  corpus where *Bostock* contributes 101 chunks and *Thompson* 7, removing length normalisation
  rewards long documents for being long.
- **Suffix folding was rejected.** It gains 0.0014 MRR — noise — while shrinking the vocabulary by
  12% and losing the Q17 Thompson relationship entirely. The brief said not to stem unless the
  benchmark demonstrated improvement; the benchmark demonstrated the opposite. The implementation
  remains in `src/lib/search/tokenize.ts` behind a flag so the finding stays reproducible.
- **The tokenizer preserves what legal text needs.** "Title VII", "but-for", "Sarbanes-Oxley",
  "§1514A", and "2000e-3" all survive as retrievable terms, and compounds are indexed under their
  full form, their separator-free form, and their parts, so "but-for" in an opinion is reachable
  from "but for" in a query. Diacritics fold, so "fiancé" and "fiance" are the same term.
- **No stopword list is used.** With Lucene's non-negative IDF, a term in all 234 chunks scores
  ≈0.002 — effectively zero — so common words are suppressed by the arithmetic rather than by a
  hand-curated list that would risk removing "any" from *"filed any complaint"*.

## Hybrid observations

RRF was swept across `k ∈ {10, 20, 30, 60, 100}` × candidate depth `∈ {20, 30, 50, 100, 234}` on
all four embedding configurations — 100 measured cells.

**HYBRID Recall@1, Recall@3, and Recall@5 were constant across every single cell.** Neither knob
moves a recall metric on this benchmark. Only MRR and the Q17 Thompson rank respond:

| Depth | HYBRID MRR (`3-large@1024`) | Q17 Thompson case rank |
|---:|---:|---:|
| 20 | 0.9537 | 6 |
| 30 | 0.9537 | 6 |
| 50 | 0.9444 | not retrieved |
| 100 | 0.9444 | not retrieved |
| 234 | 0.9524 | 7 |

Depth 30 was chosen over the brief's suggested 50. The rationale is structural rather than
fitted: RRF's conventional depths assume corpora of millions, whereas 50 candidates here is 21% of
the *entire corpus*, deep enough that chunks BM25 barely matched still earn rank credit and dilute
strong semantic evidence. The improvement holds across every value of `k` tested and is not a
single lucky cell — but it should be reported for what it is: no recall metric changed, and the
MRR gain appears only on the two large-model indexes, not on `3-small`. `k = 60` was left at the
literature default because it made no measurable difference at any depth.

## What this evaluation does not establish

Configuration selection and final reporting used the same 18-query development benchmark. Every
number here is in-sample: no held-out generalization estimate exists. Splitting 18 queries into
train and test would leave neither half able to measure anything, so the honest fix is not a split
but a separately authored, expert-graded test set collected after freezing this configuration.

The corpus is 8 opinions and 234 chunks. The benchmark is 18 queries with author-created relevance
judgments. Fifteen of those queries are solved at rank one by all three methods, so the entire
comparison rests on three queries and a handful of MRR fractions — differences of 0.0014 MRR are
noise, and even the 0.0556 recall differences are one query out of eighteen. No claim about
general legal-search accuracy follows from any of this. Expert graded relevance judgments, a
substantially larger corpus, and many more queries would be needed before these numbers could
support a ranking of retrieval methods rather than a description of this prototype's behaviour.

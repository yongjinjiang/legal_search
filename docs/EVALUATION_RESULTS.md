# Evaluation Results

## Controlled setup

The benchmark contains 18 queries: eight semantic fact-pattern prompts, eight keyword prompts, one multi-relevant hybrid prompt, and one broad-recall prompt. Metrics are case-level and apply only to this small prototype benchmark.

| Method | Recall@1 | Recall@3 | Recall@5 | MRR |
|---|---:|---:|---:|---:|
| ANN | 0.8889 | 0.9444 | 1.0000 | 0.9278 |
| FULL_TEXT | 0.7778 | 0.9444 | 0.9444 | 0.8598 |
| HYBRID | 0.8889 | 1.0000 | 1.0000 | 0.9259 |

Hybrid retrieved 18/18 primary benchmark cases within the top three. It did not materially beat ANN on MRR; its measured benefit was top-three robustness. These results do not establish general legal-search accuracy.

## Failure analysis

Q17 tested an implicit relationship: one person complained and someone close to them suffered an adverse action. ANN placed *Thompson* first; FULL_TEXT placed it seventh. Q18 deliberately withheld statute, protected activity, and adverse-action type, so several precedents were legitimate matches. For ANN, the primary *Burlington* case was fifth; relevant-case coverage was 3/7 at top 3, 4/7 at top 4, and 5/7 at top 5.

No HYBRID_RERANK results exist because reranking was unavailable in the workspace.

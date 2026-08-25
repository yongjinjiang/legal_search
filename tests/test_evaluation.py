import unittest

from scripts.evaluate_retrieval import METHODS, collapse_case_ids, load_queries, score_runs, validate_runs


class EvaluationTests(unittest.TestCase):
    def test_collapses_chunk_rows_to_cases(self):
        payload = {
            "manifest": {"columns": [{"name": "chunk_id"}, {"name": "case_id"}]},
            "result": {"data_array": [["a1", "a"], ["a2", "a"], ["b1", "b"]]},
        }
        self.assertEqual(collapse_case_ids(payload), ["a", "b"])

    def test_keeps_the_full_ranking_beyond_the_display_depth(self):
        payload = {
            "manifest": {"columns": [{"name": "chunk_id"}, {"name": "case_id"}]},
            "result": {"data_array": [[f"c{i}", f"case{i}"] for i in range(1, 8)]},
        }
        ranked = collapse_case_ids(payload)
        self.assertEqual(len(ranked), 7)
        self.assertEqual(ranked[6], "case7")
        self.assertEqual(collapse_case_ids(payload, limit=5), ranked[:5])

    def test_gold_case_at_rank_seven_contributes_its_reciprocal_rank(self):
        """Documented failure analysis puts Thompson seventh under FULL_TEXT.

        Truncating the saved ranking at five scored that as absent, giving MRR 0 instead
        of 1/7 and making the documented rank unauditable.
        """
        ranked = [f"case{i}" for i in range(1, 8)]
        runs = [{"method": "FULL_TEXT", "primary_gold_case": "case7", "ranked_case_ids": ranked}]
        scores = score_runs(runs)
        self.assertAlmostEqual(scores["FULL_TEXT"]["mrr"], 1 / 7)
        self.assertEqual(scores["FULL_TEXT"]["recall_at_5"], 0.0)
        self.assertEqual(scores["FULL_TEXT"]["unranked_gold"], 0.0)

    def test_reports_censored_misses_separately(self):
        runs = [
            {"method": "ANN", "primary_gold_case": "missing", "ranked_case_ids": ["a", "b"], "censored": True},
            {"method": "ANN", "primary_gold_case": "gone", "ranked_case_ids": ["a", "b"], "censored": False},
        ]
        scores = score_runs(runs)
        self.assertEqual(scores["ANN"]["mrr"], 0.0)
        self.assertEqual(scores["ANN"]["unranked_gold"], 2.0)
        self.assertEqual(scores["ANN"]["censored_misses"], 1.0)

    def test_scores_primary_case_rank(self):
        runs = []
        for method in ("ANN", "FULL_TEXT", "HYBRID"):
            runs.extend([
                {"method": method, "primary_gold_case": "a", "ranked_case_ids": ["a", "b"]},
                {"method": method, "primary_gold_case": "b", "ranked_case_ids": ["a", "b"]},
            ])
        scores = score_runs(runs)
        self.assertEqual(scores["ANN"]["recall_at_1"], 0.5)
        self.assertEqual(scores["ANN"]["recall_at_3"], 1.0)
        self.assertEqual(scores["ANN"]["mrr"], 0.75)


class RunValidationTests(unittest.TestCase):
    def setUp(self):
        self.queries = load_queries()
        self.runs = [
            {"query_id": row["query_id"], "method": method, "primary_gold_case": row["primary_gold_case"], "ranked_case_ids": [row["primary_gold_case"]]}
            for row in self.queries
            for method in METHODS
        ]

    def test_accepts_a_complete_result_file(self):
        self.assertEqual(len(validate_runs(self.runs, self.queries)), len(self.queries) * len(METHODS))

    def test_rejects_a_partial_result_file(self):
        with self.assertRaises(ValueError):
            validate_runs(self.runs[:-1], self.queries)

    def test_rejects_duplicate_runs(self):
        with self.assertRaises(ValueError):
            validate_runs(self.runs + [self.runs[0]], self.queries)

    def test_rejects_an_unknown_query(self):
        stray = dict(self.runs[0], query_id="Q999")
        with self.assertRaises(ValueError):
            validate_runs(self.runs + [stray], self.queries)

    def test_rejects_an_altered_gold_label(self):
        tampered = list(self.runs)
        tampered[0] = dict(tampered[0], primary_gold_case="not-the-gold-case")
        with self.assertRaises(ValueError):
            validate_runs(tampered, self.queries)


if __name__ == "__main__":
    unittest.main()

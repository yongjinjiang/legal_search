import unittest

from scripts.evaluate_retrieval import collapse_case_ids, score_runs


class EvaluationTests(unittest.TestCase):
    def test_collapses_chunk_rows_to_cases(self):
        payload = {
            "manifest": {"columns": [{"name": "chunk_id"}, {"name": "case_id"}]},
            "result": {"data_array": [["a1", "a"], ["a2", "a"], ["b1", "b"]]},
        }
        self.assertEqual(collapse_case_ids(payload), ["a", "b"])

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


if __name__ == "__main__":
    unittest.main()

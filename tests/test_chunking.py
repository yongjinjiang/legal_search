import unittest

from scripts.chunk_corpus import require_chunks


class ChunkingFailureTests(unittest.TestCase):
    def test_empty_case_has_actionable_error(self):
        with self.assertRaisesRegex(ValueError, "empty_case: no chunks produced"):
            require_chunks("empty_case", [])


if __name__ == "__main__":
    unittest.main()

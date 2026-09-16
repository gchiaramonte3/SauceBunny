"""Contract checks for the offline parity harness; no model import/download."""
from pathlib import Path
import unittest
from unittest.mock import patch

from compare_original import functions, parity_passed, PARITY_ABSOLUTE_TOLERANCE


class ReferenceComparisonTests(unittest.TestCase):
    def test_reference_import_does_not_execute_package_side_effects(self):
        code = "raise RuntimeError('must not run')\ndef selected():\n    return 42\ndef unused():\n    raise RuntimeError('unused')\n"
        namespace = {}
        with patch.object(Path, "read_text", return_value=code):
            functions(Path("reference.py"), {"selected"}, namespace)
        self.assertEqual(namespace["selected"](), 42)
        self.assertNotIn("unused", namespace)

    def test_missing_reference_function_is_not_silently_substituted(self):
        with patch.object(Path, "read_text", return_value="def other(): pass"):
            with self.assertRaisesRegex(ValueError, "missing"):
                functions(Path("reference.py"), {"selected"}, {})

    def test_parity_requires_audio_and_finite_small_embedding_and_score_errors(self):
        good = {"max_absolute": PARITY_ABSOLUTE_TOLERANCE / 2}
        rows = [{"embedding": good, "scores": good}]
        self.assertTrue(parity_passed(good, rows))
        self.assertFalse(parity_passed(good, []))
        for error in [float("nan"), float("inf"), -1, PARITY_ABSOLUTE_TOLERANCE * 2]:
            bad = {"max_absolute": error}
            self.assertFalse(parity_passed(bad, rows))
            self.assertFalse(parity_passed(good, [{"embedding": bad, "scores": good}]))
            self.assertFalse(parity_passed(good, [{"embedding": good, "scores": bad}]))


if __name__ == "__main__":
    unittest.main()

"""Frozen multiprocessing helpers must bypass the app's CLI and model imports."""
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch


class WorkerEntrypointTests(unittest.TestCase):
    def test_freeze_support_runs_before_app_argument_parsing(self):
        class HelperDiverted(Exception):
            pass

        with patch("multiprocessing.freeze_support", side_effect=HelperDiverted) as freeze, \
                patch("argparse.ArgumentParser", side_effect=AssertionError("App CLI reached")), \
                patch.dict("sys.modules", {"artifacts": None, "index_store": None, "media": None}):
            with self.assertRaises(HelperDiverted):
                runpy.run_path(str(Path(__file__).with_name("worker.py")), run_name="__main__")
        freeze.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()

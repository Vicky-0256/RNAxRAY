import importlib.util
import unittest
from pathlib import Path

from desktop.runtime.bridge import handle

ROOT = Path(__file__).resolve().parents[3]


class WarmupTest(unittest.TestCase):
    def test_reports_unavailable_without_cplfold_sources(self):
        result = handle({"operation": "warmup"}, repo_root=ROOT / "desktop")
        self.assertEqual(result["status"], "unavailable")

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "numpy not installed")
    def test_folds_the_reference_hairpin(self):
        result = handle({"operation": "warmup"}, repo_root=ROOT)
        self.assertEqual(result["status"], "warm")
        self.assertGreaterEqual(result["seconds"], 0)


if __name__ == "__main__":
    unittest.main()

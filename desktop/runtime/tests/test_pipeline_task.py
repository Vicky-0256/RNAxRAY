import tempfile
import unittest
from pathlib import Path

from desktop.runtime.bridge import handle
from desktop.runtime.project import import_input, new_project

ROOT = Path(__file__).resolve().parents[3]


class PipelineTaskTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name) / "p.rnaxrayproj"
        new_project(self.project, "Pipeline")
        self.sam = import_input(self.project, ROOT / "data/testData.sam", role="sam")["path"]
        self.ref = import_input(self.project, ROOT / "data/Zika_18S_formatted.fasta", role="reference")["path"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_sam_input_produces_legacy_identical_hyb(self):
        result = handle({"operation": "pipeline_run", "project_path": str(self.project), "input": self.sam,
                         "reference": self.ref, "task_id": "pipeline-t1"}, repo_root=ROOT)
        self.assertTrue(result["ok"], result)
        produced = Path(result["output"])
        self.assertEqual(produced.parent, (self.project / "runs/pipeline-t1").resolve())
        golden = ROOT / "pipeline/tests/golden/testData.hyb"
        self.assertEqual(produced.read_bytes(), golden.read_bytes())
        self.assertEqual(result["counts"]["hybrids"], 10411)

    def test_inputs_must_stay_inside_the_project(self):
        for bad in ("../../etc/passwd", "/etc/passwd", "inputs/missing.sam"):
            with self.assertRaises(ValueError):
                handle({"operation": "pipeline_run", "project_path": str(self.project), "input": bad,
                        "reference": self.ref}, repo_root=ROOT)

    def test_parameters_are_bounded(self):
        with self.assertRaises(ValueError):
            handle({"operation": "pipeline_run", "project_path": str(self.project), "input": self.sam,
                    "reference": self.ref, "parameters": {"max_hits": 0}}, repo_root=ROOT)

    def test_missing_package_reports_unavailable(self):
        result = handle({"operation": "pipeline_run", "project_path": str(self.project), "input": self.sam,
                         "reference": self.ref}, repo_root=Path(self.tmp.name))
        self.assertEqual(result["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()

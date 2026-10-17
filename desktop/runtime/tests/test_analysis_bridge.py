import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from desktop.runtime.bridge import _dumps_line, handle
from desktop.runtime.project import new_project

ROOT = Path(__file__).resolve().parents[3]
HYB = ROOT / "pipeline/tests/golden/testData.hyb"


class AnalysisBridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(ROOT / "pipeline"))
        from rnaxrayanalysis import index

        cls.tmp = tempfile.TemporaryDirectory()
        cls.project = Path(cls.tmp.name) / "p.rnaxrayproj"
        new_project(cls.project, "Analysis")
        for sample in ("S1", "S2"):
            (cls.project / "samples" / sample).mkdir(parents=True)
            index.build(HYB, cls.project / "samples" / sample / "testData.rnaxrayidx")
        cls.outside = Path(cls.tmp.name) / "linked.rnaxrayidx"
        shutil.copy(cls.project / "samples/S1/testData.rnaxrayidx", cls.outside)
        manifest = json.loads((cls.project / "project.json").read_text())
        manifest["samples"] = [
            {"id": "S1", "outputs": {"index": "samples/S1/testData.rnaxrayidx"}},
            {"id": "S2", "outputs": {"index": "samples/S2/testData.rnaxrayidx"}},
            {"id": "LINKED", "outputs": {"index": str(cls.outside)}},
            {"id": "PENDING", "outputs": {"index": None}},
            {"id": "ESCAPE", "outputs": {"index": "../linked.rnaxrayidx"}},
        ]
        (cls.project / "project.json").write_text(json.dumps(manifest))

    @classmethod
    def tearDownClass(cls):
        from rnaxrayanalysis import query

        query.close_all()
        cls.tmp.cleanup()

    def call(self, **request):
        request.setdefault("project_path", str(self.project))
        response = handle(request, repo_root=ROOT)
        json.loads(_dumps_line(response))  # the sidecar must be able to serialise it
        return response

    def test_summary_merges_samples(self):
        one = self.call(operation="analysis_summary", sample_ids=["S1"])
        both = self.call(operation="analysis_summary", sample_ids=["S1", "S2"])
        self.assertTrue(one["ok"])
        self.assertEqual(one["result"]["merged"]["records"], 10411)
        self.assertEqual(both["result"]["merged"]["records"], 2 * 10411)
        self.assertEqual(both["sample_ids"], ["S1", "S2"])
        linked = self.call(operation="analysis_summary", sample_ids=["LINKED"])
        self.assertEqual(linked["indexes"], [str(self.outside.resolve())])

    def test_contact_bins_and_top(self):
        single = self.call(operation="analysis_contact_bins", sample_ids=["S1"], gene="18S_rRNA", bin_size=10)["result"]
        merged = self.call(operation="analysis_contact_bins", sample_ids=["S1", "S2"], gene="18S_rRNA", bin_size=10)["result"]
        self.assertEqual(merged["count"], [2 * c for c in single["count"]])
        self.assertEqual(set(single) >= {"bin_size", "length", "x", "y", "count"}, True)
        region = self.call(operation="analysis_contact_bins", sample_ids=["S1"], gene="Zika_virusRNA", bin_size=5,
                           region={"x": [100, 600], "y": [100, 900]}, types=["Type_1"])["result"]
        self.assertTrue(all(100 // 5 * 5 <= x <= 600 for x in region["x"]))
        top = self.call(operation="analysis_top", sample_ids=["S1", "S2"], gene="Zika_virusRNA", bin_size=50, n=3)["result"]
        self.assertEqual(len(top["rows"]), 3)
        self.assertEqual(top["rows"][0]["per_index"][0] * 2, top["rows"][0]["count"])

    def test_hybrids_and_explicit_index_paths(self):
        result = self.call(operation="analysis_hybrids", index_paths=[str(self.outside)],
                           filters={"gene1": "Zika_virusRNA", "gene2": "18S_rRNA"}, limit=3, order="reads")["result"]
        self.assertEqual(result["total"], 947)
        self.assertEqual(len(result["rows"]), 3)
        self.assertTrue(result["rows"][0]["name"])

    def test_viewpoint_and_region(self):
        single = self.call(operation="analysis_viewpoint", sample_ids=["S1"], gene="Zika_virusRNA", start=2000, end=2600,
                           bin_size=10)["result"]
        merged = self.call(operation="analysis_viewpoint", sample_ids=["S1", "S2"], gene="Zika_virusRNA", start=2000, end=2600,
                           bin_size=10, measure="reads", types=["Type_1"])["result"]
        self.assertEqual((single["start"], single["end"], single["bin_size"]), (2000, 2600, 10))
        self.assertEqual(len(single["bins"]["value"]), 61)
        self.assertGreater(single["records"], 0)
        self.assertEqual(merged["measure"], "reads")
        self.assertLess(merged["records"], 2 * single["records"])
        region = self.call(operation="analysis_region", sample_ids=["S1", "S2"], gene="Zika_virusRNA", start=3000, end=3200,
                           partner="Zika_virusRNA", partner_start=1, partner_end=10807, overlap="any", limit=5)["result"]
        alone = self.call(operation="analysis_region", sample_ids=["S1"], gene="Zika_virusRNA", start=3000, end=3200,
                          partner="Zika_virusRNA")["result"]
        self.assertEqual(region["records"], 2 * alone["records"])
        self.assertEqual(len(region["rows"]), 5)
        self.assertEqual(region["rows"][0]["records"] % 2, 0)
        self.assertEqual(set(region["profile"]), {"bin_size", "adjusted", "start", "end", "value"})
        for request in ({"operation": "analysis_viewpoint", "sample_ids": ["S1"]},
                        {"operation": "analysis_viewpoint", "sample_ids": ["S1"], "gene": "Zika_virusRNA", "start": "1"},
                        {"operation": "analysis_region", "sample_ids": ["S1"], "gene": "Zika_virusRNA", "start": 1},
                        {"operation": "analysis_region", "sample_ids": ["S1"], "gene": "Zika_virusRNA", "start": 1, "end": 9,
                         "overlap": "inside"}):
            with self.assertRaises(ValueError, msg=request):
                self.call(**request)

    def test_errors(self):
        for request in (
            {"operation": "analysis_summary", "sample_ids": ["NOPE"]},
            {"operation": "analysis_summary", "sample_ids": ["PENDING"]},
            {"operation": "analysis_summary", "sample_ids": ["ESCAPE"]},
            {"operation": "analysis_summary", "sample_ids": "S1"},
            {"operation": "analysis_summary"},
            {"operation": "analysis_summary", "index_paths": [str(Path(self.tmp.name) / "missing")]},
            {"operation": "analysis_contact_bins", "sample_ids": ["S1"]},
            {"operation": "analysis_contact_bins", "sample_ids": ["S1"], "gene": "18S_rRNA", "bin_size": "10"},
            {"operation": "analysis_hybrids", "sample_ids": ["S1"], "filters": []},
            {"operation": "analysis_hybrids", "sample_ids": ["S1"], "limit": True},
        ):
            with self.assertRaises(ValueError, msg=request):
                self.call(**request)

    def test_analysis_index_build_task(self):
        project = Path(self.tmp.name) / "build.rnaxrayproj"
        new_project(project, "Index build")
        source = Path(self.tmp.name) / "given.hyb"
        shutil.copyfile(HYB, source)
        reference = ROOT / "data" / "Zika_18S_formatted.fasta"
        for mode in ("copied", "linked"):
            added = handle({"operation": "add_sample", "path": str(project), "source": str(source), "reference": str(reference),
                            "gene_id": "18S_rRNA", "mode": mode, "name": "given_" + mode}, repo_root=ROOT)
            self.assertTrue(added["ok"], added)
            sample_id = added["sample"]["id"]
            run_dir = project / "runs" / ("index-" + mode)
            run_dir.mkdir(parents=True)
            result = handle({"operation": "analysis_index_build", "project_path": str(project), "sample_id": sample_id,
                             "task_id": "index-" + mode, "run_dir": str(run_dir)}, repo_root=ROOT)
            self.assertTrue(result["ok"], result)
            self.assertEqual(json.loads((run_dir / "result.json").read_text())["status"], "succeeded")
            self.assertEqual(json.loads((run_dir / "progress.json").read_text())["stage"], "done")
            stored = next(s for s in json.loads((project / "project.json").read_text())["samples"] if s["id"] == sample_id)
            self.assertEqual(stored["stages"]["index"]["status"], "succeeded")
            self.assertEqual(stored["outputs"]["index"], "samples/%s/given_%s.index.sqlite" % (sample_id, mode))
            contact = project / stored["outputs"]["contact"]
            self.assertEqual(contact.name, "given_%s.18S_rRNA.contact.txt" % mode)
            self.assertEqual(contact.read_bytes(), (ROOT / "pipeline/tests/golden/testData.18S_rRNA.contact.txt").read_bytes())
            summary = handle({"operation": "analysis_summary", "project_path": str(project), "sample_ids": [sample_id]},
                             repo_root=ROOT)
            self.assertEqual(summary["result"]["merged"]["records"], 10411)
        with self.assertRaises(ValueError):
            handle({"operation": "analysis_index_build", "project_path": str(project), "sample_id": "nope"}, repo_root=ROOT)

    def test_missing_backend(self):
        with self.assertRaisesRegex(ValueError, "not bundled"):
            handle({"operation": "analysis_summary", "project_path": str(self.project), "sample_ids": ["S1"]},
                   repo_root=Path(self.tmp.name))


if __name__ == "__main__":
    unittest.main()

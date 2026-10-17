"""End-to-end ``sample_pipeline_run`` on the pipeline test data (contract R2)."""
import gzip
import json
import os
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from desktop.runtime.bridge import handle
from desktop.runtime.project import new_project, validate_manifest

ROOT = Path(__file__).resolve().parents[3]
SAM = ROOT / "data" / "testData.sam"
REFERENCE = ROOT / "data" / "Zika_18S_formatted.fasta"
GOLDEN = ROOT / "pipeline" / "tests" / "golden" / "testData.hyb"


def _bowtie2_dir():
    """Bundled Bowtie2 (gitignored, so also look in the main checkout of a worktree)."""
    configured = os.environ.get("RNAXRAYPIPE_TOOL_DIR")
    candidates = ([Path(configured)] if configured else []) + [p / "desktop/resources/native/bin" for p in (ROOT, *ROOT.parents)]
    for candidate in candidates:
        if (candidate / "bowtie2-align-s").exists() or shutil.which("bowtie2-align-s", path=str(candidate)):
            return candidate
    return Path(shutil.which("bowtie2-align-s")).parent if shutil.which("bowtie2-align-s") else None


class SamplePipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.project = self.dir / "p.rnaxrayproj"
        new_project(self.project, "Pipeline samples")
        self.saved_path = list(sys.path)

    def tearDown(self):
        sys.path[:] = self.saved_path
        for name in [n for n in sys.modules if n == "rnaxrayanalysis" or n.startswith("rnaxrayanalysis.")]:
            del sys.modules[name]
        self.tmp.cleanup()

    def call(self, operation, **request):
        request.setdefault("path", str(self.project))
        return handle({"operation": operation, **request}, repo_root=self.repo_root if hasattr(self, "repo_root") else ROOT)

    def add(self, source, **extra):
        response = self.call("add_sample", source=str(source), reference=str(REFERENCE), **extra)
        self.assertTrue(response["ok"], response)
        return response["sample"]

    def run_sample(self, sample_id, task_id, **extra):
        run_dir = self.project / "runs" / task_id
        run_dir.mkdir(parents=True)
        result = self.call("sample_pipeline_run", path=None, project_path=str(self.project), sample_id=sample_id,
                           task_id=task_id, run_dir=str(run_dir), **extra)
        return result, run_dir

    def sample(self, sample_id):
        manifest = json.loads((self.project / "project.json").read_text(encoding="utf-8"))
        self.assertEqual(validate_manifest(manifest), [])
        return next(s for s in manifest["samples"] if s["id"] == sample_id)

    def test_linked_sam_sample_matches_golden_and_updates_stages(self):
        sample = self.add(SAM, condition="test", replicate=1)
        self.assertIsNone(sample["gene_id"], "three-sequence reference has no default gene")
        result, run_dir = self.run_sample(sample["id"], "sample-t1")
        self.assertTrue(result["ok"], result)
        produced = Path(result["output"])
        self.assertEqual(produced.parent, (self.project / "samples" / sample["id"]).resolve())
        self.assertEqual(produced.read_bytes(), GOLDEN.read_bytes())
        self.assertEqual(result["counts"]["hybrids"], 10411)
        stored = self.sample(sample["id"])
        self.assertEqual(stored["stages"]["map"]["status"], "skipped")
        self.assertEqual(stored["stages"]["hyb"]["status"], "succeeded")
        self.assertEqual(stored["stages"]["hyb"]["task_id"], "sample-t1")
        self.assertIn(stored["stages"]["index"]["status"], ("skipped", "succeeded"))
        self.assertEqual(stored["outputs"]["hyb"], "samples/%s/testData.hyb" % sample["id"])
        self.assertEqual(stored["outputs"]["stats"], "samples/%s/testData_hybrids.hyb_stats.txt" % sample["id"])
        progress = json.loads((run_dir / "progress.json").read_text(encoding="utf-8"))
        self.assertEqual(progress["stage"], "done")
        self.assertEqual(set(progress), {"stage", "detail", "bytes_done", "bytes_total", "updated_at", "work"})
        self.assertEqual(progress["work"]["format"], "sam")
        self.assertEqual(progress["work"]["input_bytes"], stored["reads"]["size_bytes"])
        stored_result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
        self.assertTrue(stored_result["ok"])
        # The active time feeds the desktop's time estimates.
        performance = stored_result["performance"]
        self.assertEqual((performance["format"], performance["input_bytes"]), ("sam", stored["reads"]["size_bytes"]))
        self.assertGreater(performance["seconds"], 0)
        self.assertIn("hybrids", performance["stage_seconds"])
        self.assertNotIn("wait", performance["stage_seconds"])
        # The shell-owned status.json + result.json still register as a project run.
        (run_dir / "status.json").write_text(json.dumps({"task_id": "sample-t1", "kind": "sample_pipeline", "status": "succeeded"}))
        run = self.call("register_task_run", task_id="sample-t1")["run"]
        self.assertIn("samples/%s/testData.hyb" % sample["id"], run["output_paths"])

    def test_missing_input_fails_without_running(self):
        moved = self.dir / "moved.sam"
        shutil.copyfile(SAM, moved)
        sample = self.add(moved)
        moved.unlink()
        result, _ = self.run_sample(sample["id"], "sample-missing")
        self.assertFalse(result["ok"])
        self.assertIn("missing", result["error"])
        # Nothing ran, but the first stage says this task failed (a pending
        # stage hid the failure on the Data page).
        stored = self.sample(sample["id"])
        self.assertEqual((stored["stages"]["hyb"]["status"], stored["stages"]["hyb"]["task_id"]), ("failed", "sample-missing"))
        self.assertIsNone(stored["outputs"]["hyb"])

    def test_unknown_sample_and_bad_parameters(self):
        with self.assertRaises(ValueError):
            self.run_sample("nope", "sample-x")
        sample = self.add(SAM)
        result, _ = self.run_sample(sample["id"], "sample-bad", parameters={"max_hits": 0})
        self.assertFalse(result["ok"])
        self.assertEqual(self.sample(sample["id"])["stages"]["hyb"]["status"], "failed")

    @staticmethod
    def _restore_modules(cached):
        for name in [n for n in sys.modules if n == "rnaxrayanalysis" or n.startswith("rnaxrayanalysis.")]:
            del sys.modules[name]
        sys.modules.update(cached)

    def test_hyb_sample_runs_analysis_stage_with_rnaxrayanalysis(self):
        """A stub rnaxrayanalysis (R3 API) is called for contact + index; outputs land in samples/<id>/."""
        fake_root = self.dir / "repo"
        package = fake_root / "pipeline" / "rnaxrayanalysis"
        package.mkdir(parents=True)
        (fake_root / "pipeline" / "rnaxraypipe").symlink_to(ROOT / "pipeline" / "rnaxraypipe")
        (package / "__init__.py").write_text("")
        (package / "coverage.py").write_text(textwrap.dedent("""
            from pathlib import Path
            def write_contact(hyb, gene_id, out):
                Path(out).write_text("contact %s %s\\n" % (Path(hyb).name, gene_id))
        """))
        (package / "index.py").write_text(textwrap.dedent("""
            from pathlib import Path
            def build(hyb, index_path):
                Path(index_path).write_bytes(b"SQLite stub")
        """))
        self.repo_root = fake_root
        # Other tests may have imported the real package; load the stub instead.
        cached = {name: module for name, module in sys.modules.items()
                  if name == "rnaxrayanalysis" or name.startswith("rnaxrayanalysis.")}
        for name in cached:
            del sys.modules[name]
        self.addCleanup(self._restore_modules, cached)
        hyb = self.dir / "given.hyb"
        shutil.copyfile(GOLDEN, hyb)
        sample = self.add(hyb, gene_id="Zika_virusRNA", mode="copied")
        self.assertEqual(sample["outputs"]["hyb"], sample["reads"]["path"])
        result, run_dir = self.run_sample(sample["id"], "sample-idx")
        self.assertTrue(result["ok"], result)
        stored = self.sample(sample["id"])
        self.assertEqual([stored["stages"][k]["status"] for k in ("map", "hyb", "index")], ["skipped", "skipped", "succeeded"])
        contact = self.project / stored["outputs"]["contact"]
        self.assertEqual(contact.name, "given.Zika_virusRNA.contact.txt")
        self.assertEqual(contact.read_text(), "contact given.hyb Zika_virusRNA\n")
        self.assertEqual((self.project / stored["outputs"]["index"]).read_bytes(), b"SQLite stub")

    @unittest.skipUnless(_bowtie2_dir(), "Bowtie2 is not available")
    def tiny_fastq(self, name="tiny.fastq.gz"):
        reads = self.dir / name
        with SAM.open(encoding="utf-8") as sam, gzip.open(reads, "wt") as out:
            seen = set()
            for line in sam:
                if line.startswith("@"):
                    continue
                fields = line.split("\t")
                if fields[1] != "0" or fields[0] in seen:
                    continue
                seen.add(fields[0])
                out.write("@%s\n%s\n+\n%s\n" % (fields[0], fields[9], fields[10]))
                if len(seen) >= 3000:
                    break
        return reads

    def test_fastq_gz_sample_maps_with_bowtie2(self):
        sample = self.add(self.tiny_fastq())
        saved = {key: os.environ.get(key) for key in ("RNAXRAYPIPE_TOOL_DIR", "RNAXRAY_TASK_CPUS")}
        os.environ["RNAXRAYPIPE_TOOL_DIR"] = str(_bowtie2_dir())
        os.environ["RNAXRAY_TASK_CPUS"] = "2"  # scheduler budget -> Options.threads
        try:
            result, run_dir = self.run_sample(sample["id"], "sample-fq")
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertTrue(result["ok"], result)
        stored = self.sample(sample["id"])
        self.assertEqual(stored["stages"]["map"]["status"], "succeeded")
        self.assertEqual(stored["stages"]["hyb"]["status"], "succeeded")
        self.assertTrue((self.project / stored["outputs"]["hyb"]).is_file())
        self.assertGreater(result["counts"].get("alignments", 0), 0)
        self.assertEqual(json.loads((run_dir / "progress.json").read_text())["stage"], "done")

    def test_mapping_waits_for_the_map_slot(self):
        """A sample started early prepares its reads, then waits while
        another task holds the machine-wide map slot."""
        import threading
        import time
        from desktop.runtime.sample_run import MapSlot
        sample = self.add(self.tiny_fastq())
        lock = self.dir / "map.lock"
        held = MapSlot(str(lock))
        held.acquire()
        saved = {key: os.environ.get(key) for key in ("RNAXRAYPIPE_TOOL_DIR", "RNAXRAY_TASK_CPUS", "RNAXRAY_MAP_SLOT")}
        os.environ.update({"RNAXRAYPIPE_TOOL_DIR": str(_bowtie2_dir()), "RNAXRAY_TASK_CPUS": "2", "RNAXRAY_MAP_SLOT": str(lock)})
        out = {}
        worker = threading.Thread(target=lambda: out.update(zip(("result", "run_dir"), self.run_sample(sample["id"], "sample-slot"))))
        try:
            worker.start()
            progress = self.project / "runs" / "sample-slot" / "progress.json"
            deadline = time.time() + 60
            seen = {}
            while time.time() < deadline and seen.get("detail") != "waiting: another sample is mapping":
                time.sleep(0.05)
                try:
                    seen = json.loads(progress.read_text())
                except (OSError, ValueError):
                    pass
            self.assertEqual(seen.get("stage"), "map", seen)
            self.assertEqual(seen.get("detail"), "waiting: another sample is mapping")
            time.sleep(0.5)
            self.assertTrue(worker.is_alive())
            held.release()
            worker.join(120)
        finally:
            held.release()
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertFalse(worker.is_alive())
        self.assertTrue(out["result"]["ok"], out["result"])
        # Waiting for the slot is not counted as work.
        performance = out["result"]["performance"]
        self.assertGreaterEqual(performance["stage_seconds"]["wait"], 0.5)
        total = sum(performance["stage_seconds"].values())
        self.assertLess(performance["seconds"], total - performance["stage_seconds"]["wait"] + 0.5)
        # The slot is free again once the sample has mapped.
        again = MapSlot(str(lock))
        again.handle = open(lock, "a+b")
        self.assertTrue(again._try())
        again.release()


if __name__ == "__main__":
    unittest.main()

"""structures[] registration, list/read_structure, stale stages, list_samples, bonus cap."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from desktop.runtime.bridge import MAX_BONUS_ENTRIES, _dumps_line, cap_bonus_entries, handle
from desktop.runtime.project import load_manifest, new_project, validate_manifest
from desktop.runtime.samples import add_reference, add_sample, set_sample_stage, stage_summary
from desktop.runtime.tests.test_structure import GENE, _hyb_rows, _sequence

ROOT = Path(__file__).resolve().parents[3]
HYB = ROOT / "pipeline/tests/golden/testData.hyb"


def call(**request):
    response = handle(request, repo_root=ROOT)
    json.loads(_dumps_line(response))  # the sidecar must be able to serialise it
    return response


def write_status(project: Path, task_id: str, status: str, kind: str = "structure") -> Path:
    run_dir = project / "runs" / task_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "status.json").write_text(json.dumps({"task_id": task_id, "kind": kind, "status": status}))
    return run_dir


class StructureRegistryTests(unittest.TestCase):
    length = 240

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.project = Path(cls.tmp.name) / "p.rnaxrayproj"
        new_project(cls.project, "Structures")
        data = cls.project / "data"
        data.mkdir()
        cls.sequence = _sequence(cls.length)
        (data / "ref.fa").write_text(f">{GENE} test\n{cls.sequence}\n")
        (data / "a.hyb").write_text("".join(_hyb_rows(cls.length, 60)))
        reference = add_reference(cls.project, data / "ref.fa", mode="linked")["reference"]
        cls.sample = add_sample(cls.project, data / "a.hyb", name="s1", reference_id=reference["id"], gene_id=GENE,
                                mode="copied", condition="A")
        cls.windows = [{"start": 1, "end": 120}, {"start": 101, "end": 240}]
        for task_id, mode in (("win1", "windows"), ("gen1", "genome")):
            run_dir = write_status(cls.project, task_id, "running")
            request = {"operation": "structure_run", "project_path": str(cls.project), "sample_ids": [cls.sample["id"]],
                       "task_id": task_id, "run_dir": str(run_dir), "mode": mode, "workers": 1,
                       "parameters": {"beam": 20}}
            if mode == "windows":
                request["windows"] = cls.windows
            result = handle(request, repo_root=ROOT)
            assert result["ok"], result
            write_status(cls.project, task_id, "succeeded")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def register(self, task_id):
        return call(operation="register_task_run", path=str(self.project), task_id=task_id)

    def test_register_appends_structure_once(self):
        self.register("win1")
        self.register("win1")  # idempotent
        manifest = load_manifest(self.project)
        self.assertEqual(validate_manifest(manifest), [])
        entries = [s for s in manifest["structures"] if s["id"] == "win1"]
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["task_id"], "win1")
        self.assertEqual(entry["sample_ids"], [self.sample["id"]])
        self.assertEqual((entry["gene_id"], entry["mode"], entry["windows"]), (GENE, "windows", self.windows))
        self.assertEqual(entry["paths"], {"dbn": "structures/win1/structure.dbn", "pairs": "structures/win1/pairs.tsv",
                                          "ct": "structures/win1/structure.ct", "meta": "structures/win1/meta.json"})
        self.assertTrue(entry["parameters"]["allow_pseudoknot"])
        self.assertEqual(entry["summary"]["records"], 2)
        self.assertEqual(len(entry["summary"]["energies"]), 2)
        self.assertIsNone(entry["summary"]["energy"])
        self.assertIn("pairs", entry["summary"])
        self.assertTrue(any(run["id"] == "win1" for run in manifest["runs"]))

    def test_list_and_read_structure(self):
        self.register("win1")
        self.register("gen1")
        listed = call(operation="list_structures", path=str(self.project))["structures"]
        self.assertEqual({s["id"] for s in listed}, {"win1", "gen1"})
        self.assertTrue(all(s["available"] for s in listed))
        genome = call(operation="read_structure", path=str(self.project), structure_id="gen1")
        self.assertEqual(genome["structure"]["id"], "gen1")
        self.assertEqual(genome["meta"]["mode"], "genome")
        (record,) = genome["records"]
        self.assertEqual((record["window_start"], record["window_end"], record["sequence"]), (1, self.length, self.sequence))
        self.assertEqual(record["energy"], genome["structure"]["summary"]["energy"])
        self.assertEqual(len(record["pairs"]), record["dbn"].count("("))
        windows = call(operation="read_structure", path=str(self.project), structure_id="win1")
        second = windows["records"][1]
        self.assertEqual((second["window_start"], second["window_end"]), (101, 240))
        self.assertEqual(second["sequence"], self.sequence[100:240])
        # pairs are gene coordinates (1-based), inside the window, matching pairs.tsv
        tsv = (self.project / "structures/win1/pairs.tsv").read_text().splitlines()[1:]
        expected = [[int(c[2]), int(c[3])] for c in (line.split("\t") for line in tsv) if c[0] == "101"]
        self.assertEqual(sorted(second["pairs"]), sorted(expected))
        self.assertTrue(all(101 <= i < j <= 240 for i, j in second["pairs"]))
        # each pair's chimera bonus comes from pairs.tsv
        bonus = {(int(c[2]), int(c[3])): float(c[5]) for c in (line.split("\t") for line in tsv) if c[0] == "101"}
        self.assertEqual(second["bonus"], [bonus[(i, j)] for i, j in second["pairs"]])
        with self.assertRaises(ValueError):
            handle({"operation": "read_structure", "path": str(self.project), "structure_id": "nope"}, repo_root=ROOT)

    def test_failed_or_foreign_results_are_not_registered(self):
        project = Path(self.tmp.name) / "q.rnaxrayproj"
        new_project(project, "Other")
        # a failed structure task
        run_dir = write_status(project, "bad1", "failed")
        (run_dir / "result.json").write_text(json.dumps({"ok": False, "status": "failed", "error": "x"}))
        call(operation="register_task_run", path=str(project), task_id="bad1")
        # a successful one whose result points outside structures/<task_id>/
        run_dir = write_status(project, "evil", "succeeded")
        (project / "structures" / "evil").mkdir(parents=True)
        outside = project / "inputs" / "x.dbn"
        outside.write_text(">a\nAC\n..\n")
        (run_dir / "result.json").write_text(json.dumps({"ok": True, "structure": {
            "id": "other", "mode": "genome", "paths": {"dbn": "inputs/x.dbn"}}, "outputs": {"dbn": str(outside)}}))
        call(operation="register_task_run", path=str(project), task_id="evil")
        manifest = load_manifest(project)
        self.assertEqual(manifest["structures"], [])
        self.assertEqual({r["id"] for r in manifest["runs"]}, {"bad1", "evil"})

    def test_schema_validation_and_migration(self):
        project = Path(self.tmp.name) / "old.rnaxrayproj"
        new_project(project, "Old")
        manifest = json.loads((project / "project.json").read_text())
        manifest.pop("structures")
        (project / "project.json").write_text(json.dumps(manifest))
        self.assertEqual(load_manifest(project)["structures"], [])
        self.assertEqual(call(operation="list_structures", path=str(project))["structures"], [])
        manifest["structures"] = [{"id": "s", "task_id": "s", "sample_ids": [], "gene_id": None, "mode": "genome",
                                   "windows": [], "parameters": {}, "created_at": "2026-01-01T00:00:00Z",
                                   "paths": {"dbn": "../escape.dbn"}, "summary": {}}]
        self.assertTrue(any("paths.dbn" in error for error in validate_manifest(manifest)))


class ReferenceSequenceTests(unittest.TestCase):
    def test_reads_linked_reference_sequence_by_gene(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "p.rnaxrayproj"
            new_project(project, "Ref")
            fasta = Path(tmp) / "ref.fa"
            fasta.write_text(">geneA first\nACGU\nACGT\n>geneB\nGGGG\n")
            reference = add_reference(project, fasta, mode="linked")["reference"]
            result = handle({"operation": "read_reference_sequence", "path": str(project),
                             "reference_id": reference["id"], "name": "geneA"})
            self.assertEqual((result["sequence"], result["length"]), ("ACGUACGT", 8))
            self.assertEqual(handle({"operation": "read_reference_sequence", "path": str(project),
                                     "reference_id": reference["id"], "name": "geneB"})["sequence"], "GGGG")
            with self.assertRaises(ValueError):
                handle({"operation": "read_reference_sequence", "path": str(project),
                        "reference_id": reference["id"], "name": "nope"})


class StaleStageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name) / "p.rnaxrayproj"
        new_project(self.project, "Stages")
        data = Path(self.tmp.name) / "data"
        data.mkdir()
        (data / "ref.fa").write_text(">Gene_A\nACGUACGUAC\n")
        (data / "r.fastq").write_text("@r\nACGT\n+\nIIII\n")
        reference = add_reference(self.project, data / "ref.fa")["reference"]
        self.ids = [add_sample(self.project, data / "r.fastq", name="s%d" % k, reference_id=reference["id"],
                               condition="AB"[k % 2])["id"] for k in range(5)]

    def tearDown(self):
        self.tmp.cleanup()

    def stages(self):
        return {s["id"]: s["stages"] for s in json.loads((self.project / "project.json").read_text())["samples"]}

    def test_open_project_marks_dead_tasks_interrupted(self):
        a, b, c, d, e = self.ids
        set_sample_stage(self.project, a, "map", "running", task_id="t-live", extra_stages={"hyb": "pending"})
        write_status(self.project, "t-live", "running", "sample_pipeline")
        set_sample_stage(self.project, b, "map", "running", task_id="t-dead")
        write_status(self.project, "t-dead", "interrupted", "sample_pipeline")
        set_sample_stage(self.project, c, "hyb", "queued", task_id="t-gone")  # no run directory at all
        set_sample_stage(self.project, d, "index", "running", task_id="t-failed")
        write_status(self.project, "t-failed", "failed", "analysis_index")
        set_sample_stage(self.project, e, "index", "running", task_id="t-cancel")
        write_status(self.project, "t-cancel", "cancelled", "analysis_index")
        opened = call(operation="open_project", path=str(self.project))
        self.assertTrue(opened["ok"])
        self.assertEqual({(n["sample_id"], n["stage"], n["status"]) for n in opened["normalized"]},
                         {(b, "map", "interrupted"), (c, "hyb", "interrupted"), (d, "index", "failed"),
                          (e, "index", "cancelled")})
        returned = {s["id"]: s["stages"] for s in opened["manifest"]["samples"]}
        stored = self.stages()
        for stages in (returned, stored):  # returned and persisted
            self.assertEqual(stages[a]["map"]["status"], "running")
            self.assertEqual(stages[b]["map"]["status"], "interrupted")
            self.assertEqual(stages[c]["hyb"]["status"], "interrupted")
            self.assertEqual(stages[d]["index"]["status"], "failed")
            self.assertEqual(stages[e]["index"]["status"], "cancelled")
        self.assertEqual(stored[b]["map"]["task_id"], "t-dead")
        # status.json is never written by Python
        self.assertEqual(json.loads((self.project / "runs/t-live/status.json").read_text())["status"], "running")
        again = call(operation="open_project", path=str(self.project))
        self.assertEqual(again["normalized"], [])

    def test_list_samples_derives_fields(self):
        a, b, c, d, e = self.ids
        index = self.project / "samples" / a / "x.rnaxrayidx"
        index.parent.mkdir(parents=True)
        index.write_bytes(b"index")
        set_sample_stage(self.project, a, "index", "succeeded", task_id="t1", outputs={"index": "samples/%s/x.rnaxrayidx" % a},
                         extra_stages={"map": "succeeded", "hyb": "succeeded"})
        set_sample_stage(self.project, b, "map", "running", task_id="t-dead")
        write_status(self.project, "t-dead", "interrupted", "sample_pipeline")
        set_sample_stage(self.project, c, "map", "failed", task_id="t2")
        set_sample_stage(self.project, d, "index", "succeeded", task_id="t3", outputs={"index": "samples/%s/gone.rnaxrayidx" % d},
                         extra_stages={"map": "skipped", "hyb": "skipped"})
        set_sample_stage(self.project, e, "hyb", "running", task_id="t-live")
        write_status(self.project, "t-live", "running", "sample_pipeline")
        listed = call(operation="list_samples", path=str(self.project))
        self.assertTrue(listed["ok"])
        rows = {s["id"]: s for s in listed["samples"]}
        self.assertEqual([s["id"] for s in listed["samples"]], self.ids)
        self.assertEqual({k: (v["ready"], v["stage_summary"]) for k, v in rows.items()},
                         {a: (True, "done"), b: (False, "interrupted"), c: (False, "failed"), d: (False, "done"),
                          e: (False, "running")})
        self.assertEqual(listed["conditions"], [{"name": "A", "sample_ids": [a, c, e]}, {"name": "B", "sample_ids": [b, d]}])
        (reference,) = listed["references"]
        self.assertEqual(reference["sequences"], [{"name": "Gene_A", "length": 10}])
        self.assertEqual(rows[b]["stages"]["map"]["status"], "interrupted")
        self.assertEqual(self.stages()[b]["map"]["status"], "interrupted")

    def test_stage_summary_rules(self):
        self.assertEqual(stage_summary({}), "pending")
        self.assertEqual(stage_summary({"map": {"status": "pending"}}), "pending")
        self.assertEqual(stage_summary({"map": {"status": "succeeded"}, "hyb": {"status": "pending"}}), "pending")
        self.assertEqual(stage_summary({"map": {"status": "queued"}}), "running")
        self.assertEqual(stage_summary({"map": {"status": "cancelled"}}), "interrupted")
        self.assertEqual(stage_summary({"map": {"status": "skipped"}, "hyb": {"status": "succeeded"}}), "done")


class AnalysisLengthsTests(unittest.TestCase):
    """Bridge passes reference lengths to analysis_summary / compare_bins."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(ROOT / "pipeline"))
        from rnaxrayanalysis import index

        cls.tmp = tempfile.TemporaryDirectory()
        cls.project = Path(cls.tmp.name) / "p.rnaxrayproj"
        new_project(cls.project, "Lengths")
        data = Path(cls.tmp.name) / "data"
        data.mkdir()
        (data / "ref.fa").write_text(">Zika_virusRNA\n" + "A" * 10807 + "\n>Other\nACGU\n")
        reference = add_reference(cls.project, data / "ref.fa")["reference"]
        cls.ids = []
        for name, condition in (("a1", "A"), ("a2", "A"), ("b1", "B")):
            hyb = data / (name + ".hyb")
            shutil.copy(HYB, hyb)
            sample = add_sample(cls.project, hyb, name=name, reference_id=reference["id"], condition=condition)
            target = cls.project / "samples" / sample["id"] / "idx.rnaxrayidx"
            index.build(hyb, target)
            set_sample_stage(cls.project, sample["id"], "index", "succeeded", task_id="t",
                             outputs={"index": "samples/%s/idx.rnaxrayidx" % sample["id"]})
            cls.ids.append(sample["id"])

    @classmethod
    def tearDownClass(cls):
        from rnaxrayanalysis import query

        query.close_all()
        cls.tmp.cleanup()

    def test_summary_uses_reference_lengths(self):
        merged = call(operation="analysis_summary", project_path=str(self.project), sample_ids=self.ids[:1])["result"]["merged"]
        zika = next(g for g in merged["genes"] if g["name"] == "Zika_virusRNA")
        self.assertEqual((zika["length"], zika["length_source"]), (10807, "reference"))
        rrna = next(g for g in merged["genes"] if g["name"] == "18S_rRNA")
        self.assertEqual((rrna["length"], rrna["length_source"]), (rrna["max_end"], "observed"))
        self.assertEqual(merged["extents"]["Zika_virusRNA"], {"min": zika["min_start"], "max": zika["max_end"]})

    def test_compare_bins_and_contact_options(self):
        a, a2, b = self.ids
        response = call(operation="compare_bins", project_path=str(self.project), sample_ids_a=[a, a2], sample_ids_b=[b],
                        gene="Zika_virusRNA", bin_size=100)
        result = response["result"]
        self.assertEqual((response["sample_ids_a"], response["sample_ids_b"]), ([a, a2], [b]))
        self.assertEqual(result["length"], 10807)
        self.assertEqual(result["bin_size"], 100)
        self.assertEqual(len(result["x"]), len(result["log2ratio"]))
        # identical data on both sides: equal CPM, zero log-ratio
        self.assertEqual(result["a"], result["b"])
        self.assertTrue(all(abs(v) < 1e-9 for v in result["log2ratio"]))
        self.assertEqual(result["a_count"], [2 * c for c in result["b_count"]])
        alias = call(operation="analysis_compare_bins", project_path=str(self.project), sample_ids_a=[a],
                     sample_ids_b=[b], gene="Zika_virusRNA", bin_size=200, max_cells=50, fixed_bin=True)["result"]
        self.assertEqual(alias["bin_size"], 200)
        bins = call(operation="analysis_contact_bins", project_path=str(self.project), sample_ids=[a], gene="Zika_virusRNA",
                    gene2="18S_rRNA", bin_size=50, orientation="both", max_cells=10, fixed_bin=True)["result"]
        self.assertEqual((bins["bin_size"], bins["orientation"], bins["fixed_bin"], bins["length"]), (50, "both", True, 10807))
        with self.assertRaises(ValueError):
            handle({"operation": "compare_bins", "project_path": str(self.project), "sample_ids_a": [a],
                    "sample_ids_b": [], "gene": "Zika_virusRNA"}, repo_root=ROOT)
        with self.assertRaises(ValueError):
            handle({"operation": "analysis_contact_bins", "project_path": str(self.project), "sample_ids": [a],
                    "gene": "Zika_virusRNA", "orientation": "sideways"}, repo_root=ROOT)


class BonusCapTests(unittest.TestCase):
    def test_keeps_largest_in_original_order(self):
        entries = [{"one": k, "two": k + 5, "value": float(v)} for k, v in enumerate([3, 9, 1, 9, 5, 2])]
        result = {"evidence": {"bonusEntries": list(entries)}}
        cap_bonus_entries(result, limit=3)
        self.assertEqual([e["one"] for e in result["evidence"]["bonusEntries"]], [1, 3, 4])
        self.assertTrue(result["evidence"]["bonusEntriesTruncated"])
        self.assertEqual(result["evidence"]["bonusEntriesTotal"], 6)
        self.assertTrue(result["bonusEntriesTruncated"])
        small = {"evidence": {"bonusEntries": list(entries)}}
        cap_bonus_entries(small)
        self.assertEqual(small["evidence"]["bonusEntries"], entries)
        self.assertFalse(small["bonusEntriesTruncated"])
        self.assertEqual(MAX_BONUS_ENTRIES, 200_000)
        self.assertEqual(cap_bonus_entries({"ok": True}), {"ok": True})


if __name__ == "__main__":
    unittest.main()

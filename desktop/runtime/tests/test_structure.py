import gzip
import json
import os
import random
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from desktop.runtime import detector
from desktop.runtime.bridge import handle
from desktop.runtime.project import new_project

ROOT = Path(__file__).resolve().parents[3]
GENE = "TEST_virusRNA"


def _module():
    from desktop.runtime.structure import load_cplfold_web
    return load_cplfold_web(ROOT)


def _sequence(length, seed=7):
    rng = random.Random(seed)
    return "".join(rng.choice("ACGU") for _ in range(length))


def _hyb_rows(length, count, seed=11, gene=GENE, other=None):
    rng = random.Random(seed)
    rows = []
    for k in range(count):
        a0 = rng.randint(1, length - 60)
        a1 = a0 + rng.randint(15, 40)
        b0 = rng.randint(1, length - 60)
        b1 = b0 + rng.randint(15, 40)
        g2 = other if (other and k % 5 == 0) else gene
        rows.append(f"{k}_1\tACGU\t.\t{gene}\t1\t20\t{a0}\t{a1}\t1e-5\t{g2}\t21\t40\t{b0}\t{b1}\t1e-5\t\t-10\tType_1\n")
    # a heavily duplicated block exercises weight-dependent truncation
    rows.extend([f"dup_1\tACGU\t.\t{gene}\t1\t20\t30\t55\t1e-5\t{gene}\t21\t40\t200\t226\t1e-5\t\t-10\tType_1\n"] * 400)
    return rows


class SparseBonusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.web = _module()
        except ImportError as error:  # pragma: no cover
            raise unittest.SkipTest("cplfold_web dependencies unavailable: %s" % error)

    def test_sparse_matches_dense_within_1e_4(self):
        import numpy as np
        from collections import Counter
        for length, count in ((300, 150), (1200, 400)):
            rng = random.Random(length)
            arms = []
            for _ in range(count):
                a0 = rng.randint(1, length - 50); b0 = rng.randint(1, length - 50)
                arms.append((a0, a0 + rng.randint(10, 45), b0, b0 + rng.randint(10, 45)))
            arms += [(5, 30, length - 40, length - 10)] * 300 + [(1, 12, length - 11, length)] * 3
            dense, dense_summary = self.web.build_hyb_bonus_matrix(length, arms)
            for use_numba in (True, False):
                fast, summary = self.web.build_hyb_bonus_matrix_fast(length, Counter(arms), use_numba=use_numba)
                self.assertLessEqual(float(np.abs(dense - fast).max()), 1e-4)
                self.assertEqual(summary["inputRecords"], len(arms))
                self.assertEqual(summary["uniqueBlocks"], dense_summary["uniqueBlocks"])
                self.assertAlmostEqual(summary["gaussianStandardDeviation"], dense_summary["gaussianStandardDeviation"], places=9)
                self.assertEqual(fast.dtype, np.float32)

    def test_listing_matches_dense_entries(self):
        arms = [(3, 8, 20, 25), (3, 8, 20, 25), (1, 4, 40, 44)]
        dense, summary = self.web.build_hyb_bonus_matrix(60, arms)
        fast, _ = self.web.build_hyb_bonus_matrix_fast(60, arms)
        listing = self.web.bonus_matrix_listing(fast)
        self.assertEqual([(e["one"], e["two"]) for e in listing["bonusEntries"]],
                         [(e["one"], e["two"]) for e in summary["bonusEntries"]])
        self.assertEqual(len(listing["nucleotideSupport"]), 60)

    def test_empty_evidence(self):
        bonus, summary = self.web.build_hyb_bonus_matrix_fast(50, [])
        self.assertIsNone(bonus)
        self.assertEqual(summary["inputRecords"], 0)

    def test_hyb_streaming_filters_and_reads_gzip(self):
        rows = _hyb_rows(400, 50, other="OTHER_gene")
        with tempfile.TemporaryDirectory() as tmp:
            plain = Path(tmp) / "a.hyb"; plain.write_text("".join(rows))
            packed = Path(tmp) / "b.hyb.gz"
            with gzip.open(packed, "wt") as handle:
                handle.write("".join(rows))
            seen = []
            arms = list(self.web.iter_hyb_arms([plain, packed], GENE, progress=seen.append))
            expected = sum(1 for row in rows if row.split("\t")[9] == GENE)
            self.assertEqual(len(arms), 2 * expected)
            self.assertEqual(seen[-1], plain.stat().st_size + packed.stat().st_size)
            collected = self.web.collect_hyb_arms([plain], GENE, 400, windows=[(1, 200), (101, 400)])
            for (start, end), counter in zip([(1, 200), (101, 400)], collected["windows"]):
                for a0, a1, b0, b1 in counter:
                    self.assertTrue(1 <= a0 <= a1 <= end - start + 1 and 1 <= b0 <= b1 <= end - start + 1)


class LimitsTests(unittest.TestCase):
    def test_formula_and_modes(self):
        snapshot = {"total_bytes": 32 * 2**30, "available_bytes": 8 * 2**30}
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RNAXRAY_CPLFOLD_MAX_NT", None); os.environ.pop("RNAXRAY_MEMORY_BUDGET_MB", None)
            limits = detector.cplfold_limits(snapshot=snapshot)
        self.assertEqual(limits["memory_budget_bytes"], 8 * 2**30)
        self.assertGreater(limits["pseudoknot_free_max_nt"], limits["pseudoknot_max_nt"])
        for key, pk in (("pseudoknot_free_max_nt", False), ("pseudoknot_max_nt", True)):
            n = limits[key]
            self.assertLessEqual(detector.cplfold_memory_estimate(n, pk), limits["memory_budget_bytes"])
            self.assertGreater(detector.cplfold_memory_estimate(n + 1, pk), limits["memory_budget_bytes"])
        # A 32 GB machine can fold the 10.8 kb ZIKV genome pseudoknot-free when idle.
        self.assertGreater(limits["pseudoknot_free_max_nt_idle"], 10_807)

    def test_override_and_wrapper(self):
        with mock.patch.dict(os.environ, {"RNAXRAY_CPLFOLD_MAX_NT": "1234"}):
            limits = detector.cplfold_limits()
            self.assertEqual(limits["source"], "RNAXRAY_CPLFOLD_MAX_NT")
            self.assertEqual(detector.cplfold_max_nt(), 1234)
            self.assertEqual(detector.cplfold_max_nt(False), 1234)
        with mock.patch.dict(os.environ, {"RNAXRAY_MEMORY_BUDGET_MB": "1024"}):
            os.environ.pop("RNAXRAY_CPLFOLD_MAX_NT", None)
            limits = detector.cplfold_limits()
            self.assertEqual(limits["memory_budget_source"], "RNAXRAY_MEMORY_BUDGET_MB")
            self.assertEqual(detector.cplfold_max_nt(True), limits["pseudoknot_max_nt"])

    def test_memory_snapshot_reports_total(self):
        self.assertGreater(detector.memory_snapshot()["total_bytes"] or 0, 0)


class StructureRunTests(unittest.TestCase):
    length = 320

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name) / "p.rnaxrayproj"
        new_project(self.project, "Structure")
        (self.project / "data").mkdir()
        self.sequence = _sequence(self.length)
        (self.project / "data" / "ref.fa").write_text(f">{GENE} test\n{self.sequence[:150]}\n{self.sequence[150:]}\n")
        (self.project / "data" / "a.hyb").write_text("".join(_hyb_rows(self.length, 80)))
        self.external = Path(self.tmp.name) / "linked.hyb"
        self.external.write_text("".join(_hyb_rows(self.length, 40, seed=5)))

    def tearDown(self):
        self.tmp.cleanup()

    def _request(self, **extra):
        request = {"operation": "structure_run", "project_path": str(self.project), "reference": "data/ref.fa",
                   "hyb_paths": ["data/a.hyb", str(self.external)], "gene_id": GENE}
        request.update(extra)
        return request

    def test_genome_mode_writes_outputs(self):
        result = handle(self._request(task_id="genome1", parameters={"beam": 50}), repo_root=ROOT)
        self.assertTrue(result["ok"], result)
        out = self.project / "structures" / "genome1"
        lines = (out / "structure.dbn").read_text().splitlines()
        self.assertEqual(lines[1], self.sequence)
        self.assertEqual(len(lines[2]), self.length)
        self.assertNotIn("[", lines[2])  # genome mode is pseudoknot-free by default
        meta = json.loads((out / "meta.json").read_text())
        self.assertEqual(meta["mode"], "genome")
        self.assertFalse(meta["parameters"]["allow_pseudoknot"])
        self.assertGreater(meta["records"][0]["evidence"]["inputRecords"], 400)
        pairs = (out / "pairs.tsv").read_text().splitlines()
        self.assertEqual(pairs[0], "window_start\twindow_end\ti\tj\tbracket\tbonus")
        self.assertEqual(len(pairs) - 1, lines[2].count("("))
        ct = (out / "structure.ct").read_text().splitlines()
        self.assertEqual(len(ct), self.length + 1)
        run_dir = Path(result["run_dir"])
        self.assertEqual(json.loads((run_dir / "result.json").read_text())["status"], "succeeded")
        progress = json.loads((run_dir / "progress.json").read_text())
        self.assertEqual(set(progress) >= {"stage", "detail", "bytes_done", "bytes_total", "updated_at"}, True)
        self.assertEqual(result["structure"]["path"], "structures/genome1")
        # What was folded and how long it took feed the desktop's estimates.
        self.assertEqual(progress["work"], {"lengths": [self.length], "beam": 50, "workers": 1})
        performance = result["performance"]
        self.assertEqual((performance["lengths"], performance["beam"], performance["workers"]), ([self.length], 50, 1))
        self.assertGreater(performance["seconds"], 0)

    def test_progress_says_what_is_folded_while_reading_evidence(self):
        # The desktop's time-left estimate needs the work from the start.
        from desktop.runtime import structure
        real = structure.load_cplfold_web
        seen = []

        class Spy:
            def __init__(self, module):
                self._module = module

            def __getattr__(self, name):
                return getattr(self._module, name)

            def collect_hyb_arms(self, *args, **kwargs):
                progress = json.loads((self_project / "runs" / "evwork" / "progress.json").read_text())
                seen.append(progress.get("work"))
                return self._module.collect_hyb_arms(*args, **kwargs)

        self_project = self.project
        with mock.patch.object(structure, "load_cplfold_web", lambda root: Spy(real(root))):
            result = handle(self._request(task_id="evwork", parameters={"beam": 50}), repo_root=ROOT)
        self.assertTrue(result["ok"], result)
        self.assertEqual(seen, [{"lengths": [self.length], "beam": 50, "workers": 1}])

    def test_windows_parallel_matches_serial(self):
        windows = [{"start": 1, "end": 160}, {"start": 120, "end": 300}, {"start": 200, "end": 320}]
        serial = handle(self._request(task_id="serial", mode="windows", windows=windows, workers=1,
                                      parameters={"beam": 30}), repo_root=ROOT)
        parallel = handle(self._request(task_id="parallel", mode="windows", windows=windows, workers=2,
                                        parameters={"beam": 30}), repo_root=ROOT)
        self.assertTrue(serial["ok"] and parallel["ok"], (serial, parallel))
        self.assertEqual(parallel["summary"]["workers"], 2)
        a = (self.project / "structures" / "serial" / "structure.dbn").read_text().split("\n")
        b = (self.project / "structures" / "parallel" / "structure.dbn").read_text().split("\n")
        self.assertEqual(a, b)
        meta = json.loads((self.project / "structures" / "parallel" / "meta.json").read_text())
        self.assertTrue(meta["parameters"]["allow_pseudoknot"])
        self.assertEqual([r["start"] for r in meta["records"]], [1, 120, 200])
        with mock.patch.dict(os.environ, {"RNAXRAY_TASK_CPUS": "1"}):
            capped = handle(self._request(task_id="capped", mode="windows", windows=windows,
                                          parameters={"beam": 30}), repo_root=ROOT)
        self.assertEqual(capped["summary"]["workers"], 1)

    def test_samples_resolve_from_schema_2_manifest(self):
        from desktop.runtime.samples import add_reference, add_sample
        reference = add_reference(self.project, self.project / "data" / "ref.fa", mode="linked")["reference"]
        # s2 is a linked .hyb: it has no outputs.hyb, the reads file is the evidence
        ids = [add_sample(self.project, path, name=name, reference_id=reference["id"], gene_id=GENE, mode=mode)["id"]
               for name, path, mode in (("s1", self.project / "data" / "a.hyb", "copied"), ("s2", self.external, "linked"))]
        request = {"operation": "structure_run", "project_path": str(self.project), "sample_ids": ids,
                   "task_id": "samples", "parameters": {"beam": 30}}
        result = handle(request, repo_root=ROOT)
        self.assertTrue(result["ok"], result)
        meta = json.loads((self.project / "structures" / "samples" / "meta.json").read_text())
        self.assertEqual([s["id"] for s in meta["evidence_inputs"]["samples"]], ids)
        explicit = handle(self._request(task_id="explicit", parameters={"beam": 30}), repo_root=ROOT)
        self.assertEqual((self.project / "structures" / "samples" / "structure.dbn").read_text().split("\n")[1:],
                         (self.project / "structures" / "explicit" / "structure.dbn").read_text().split("\n")[1:])
        self.assertTrue(explicit["ok"])

    def test_fasta_names_follow_rnaxray_renaming(self):
        from desktop.runtime.samples import read_fasta_sequences
        from desktop.runtime.structure import read_fasta
        path = Path(self.tmp.name) / "formatted.fa"
        path.write_text(">ENSG1|ENST1|GENE_A|protein_coding\nACGU\n>ENSG2|ENST2|B|lncRNA\nGGCC\n")
        self.assertEqual([name for name, _ in read_fasta(path)], [s["name"] for s in read_fasta_sequences(path)])

    def test_rejects_bad_requests(self):
        with self.assertRaises(ValueError):
            handle(self._request(mode="windows", windows=[{"start": 0, "end": 50}]), repo_root=ROOT)
        with self.assertRaisesRegex(ValueError, "outside 1-320"):
            handle(self._request(mode="windows", windows=[{"start": 300, "end": 321}]), repo_root=ROOT)
        with mock.patch.dict(os.environ, {"RNAXRAY_TASK_MEM_MB": "64"}):
            with self.assertRaisesRegex(ValueError, "windows mode"):
                handle(self._request(), repo_root=ROOT)
        with self.assertRaises(ValueError):
            handle(self._request(parameters={"alpha": 3}), repo_root=ROOT)
        with self.assertRaises(ValueError):
            handle(self._request(hyb_paths=["../outside.hyb"]), repo_root=ROOT)
        with self.assertRaisesRegex(ValueError, "windows mode"):
            handle(self._request(memory_budget_mb=64), repo_root=ROOT)
        # A gene that is not in the (single-sequence) reference is refused
        # as such, not folded as the reference's only sequence.
        with self.assertRaisesRegex(ValueError, "gene_id MISSING is not a sequence of the reference FASTA"):
            handle(self._request(task_id="nogene", gene_id="MISSING"), repo_root=ROOT)
        # Evidence without chimeras of the gene fails in result.json.
        (self.project / "data" / "other.hyb").write_text("".join(_hyb_rows(self.length, 20, gene="OTHER_virusRNA")))
        failed = handle(self._request(task_id="noevidence", hyb_paths=["data/other.hyb"]), repo_root=ROOT)
        self.assertFalse(failed["ok"])
        self.assertIn("no intramolecular", failed["error"])
        stored = json.loads((Path(failed["run_dir"]) / "result.json").read_text())
        self.assertEqual(stored["status"], "failed")


if __name__ == "__main__":
    unittest.main()

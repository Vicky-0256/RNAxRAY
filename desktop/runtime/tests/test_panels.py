"""Enriched-region panels (regions.py), folding energy (energy.py) and the seqmap port."""
import json
import math
import random
import tempfile
import unittest
from pathlib import Path

from desktop.runtime import energy, regions, seqmap
from desktop.runtime.bridge import handle
from desktop.runtime.project import _atomic_write_json, load_manifest, new_project, register_task_run

ROOT = Path(__file__).resolve().parents[3]
GENE_A, GENE_B = "LINEAGE_A_virusRNA", "LINEAGE_B_virusRNA"
LENGTH = 600


class SeqmapPortTests(unittest.TestCase):
    def test_matches_the_go_package(self):
        # (a, b, To) triples written by desktop/app/seqmap.Align
        cases = json.loads((Path(__file__).parent / "seqmap_go_cases.json").read_text())
        self.assertGreater(len(cases), 3)
        for case in cases:
            self.assertEqual(seqmap.align(case["a"], case["b"]).to, case["to"])

    def test_identity_indel_and_nearest(self):
        m = seqmap.align("ACGTACGT", "acguacgu")
        self.assertTrue(m.same)
        self.assertEqual((m.pos(1), m.pos(8), m.pos(9)), (1, 8, 0))
        rng = random.Random(3)
        to = "".join(rng.choice("ACGU") for _ in range(800))
        source = to[:300] + to[301:]  # to position 301 deleted from source
        m = seqmap.align(source, to)
        self.assertEqual(m.pos(290), 290)
        self.assertEqual(m.pos(310), 311)
        self.assertEqual(m.gaps, 1)
        inserted = to[:300] + "GG" + to[300:]
        m = seqmap.align(inserted, to)
        self.assertEqual((m.pos(301), m.pos(302), m.pos(303)), (0, 0, 301))
        self.assertEqual(m.nearest(301, 5), 301)
        with self.assertRaises(ValueError):
            seqmap.align("", "ACGU")


class TTestTests(unittest.TestCase):
    def test_paired_t_test_matches_r(self):
        # R: t.test(c(1,2,3,4,5.5,-2,8), c(2,2.5,4,3,7,-1,6), paired=TRUE)
        out = energy.paired_t_test([1, 2, 3, 4, 5.5, -2, 8], [2, 2.5, 4, 3, 7, -1, 6])
        self.assertAlmostEqual(out["t"], -0.587642528249270, places=12)
        self.assertAlmostEqual(out["p"], 0.578201730081321, places=12)
        self.assertEqual((out["n"], out["df"]), (7, 6))

    def test_t_distribution_and_incomplete_beta(self):
        # R: 2*pt(-|t|, df) and pbeta
        for t, df, p in ((2, 10, 0.0733880347707404), (35, 3, 5.12851688987073e-05), (0.3, 1000, 0.764239504167244),
                         (40, 1240, 2.20568877666209e-225)):
            self.assertLess(abs(energy.t_two_sided(t, df) - p) / p, 1e-9, (t, df))
        self.assertAlmostEqual(energy.betainc(2.5, 7, 0.3), 0.641222462971721, places=12)
        self.assertAlmostEqual(energy.betainc(2, 3, 0.5), 0.6875, places=13)
        self.assertEqual(energy.betainc(2, 3, 0), 0.0)
        self.assertEqual(energy.betainc(2, 3, 1), 1.0)

    def test_degenerate_samples(self):
        self.assertIsNone(energy.paired_t_test([1.0], [2.0]))
        # R: all-zero differences give t and p NaN; constant non-zero ones stop
        # with "data are essentially constant"
        zero = energy.paired_t_test([1.0, 2.0], [1.0, 2.0])
        self.assertTrue(math.isnan(zero["t"]) and math.isnan(zero["p"]))
        self.assertNotIn("note", zero)
        constant = energy.paired_t_test([1.0, 2.0, 3.0, 4.0], [0.0, 1.0, 2.0, 3.0])
        self.assertTrue(math.isnan(constant["t"]) and math.isnan(constant["p"]))
        self.assertEqual(constant["note"], "differences are constant")

    def test_fragment_bounds(self):
        seq = "ACGU" * 10
        self.assertEqual(energy.fragment(seq, 20, 10), seq[15:25])
        self.assertIsNone(energy.fragment(seq, 4, 10))
        self.assertIsNone(energy.fragment(seq, 36, 10))
        self.assertEqual(energy.fragment(seq, 35, 10), seq[30:40])

    def test_gap_takes_the_base_after_the_previous_aligned_one(self):
        rng = random.Random(7)
        one = "".join(rng.choice("ACGU") for _ in range(600))
        two = one[:300] + one[305:]  # 5 nt deleted at 301-305 of one
        amap = seqmap.align(one, two)
        gapped = [p for p in range(290, 316) if amap.pos(p) == 0]
        self.assertEqual(len(gapped), 5)
        for p in gapped:
            q = p - 1
            while amap.pos(q) == 0:
                q -= 1
            # every base facing the deletion moves to the same base, as align_map
            self.assertEqual(energy.forward(amap, p, len(two)), amap.pos(q) + 1, p)
        self.assertEqual(len({energy.forward(amap, p, len(two)) for p in gapped}), 1)
        self.assertEqual(energy.forward(amap, 400, len(two)), 395)
        self.assertEqual(energy.forward(None, 400, len(two)), 400)
        self.assertEqual(energy.forward(amap, 0, len(two)), 0)
        rows = [{"x": gapped[-1] - 5, "y": 500, "direction": "down", "padj": 1e-5, "log2FoldChange": -1.0}]
        jobs, skipped = energy.fragment_jobs(rows, one, two, amap, 20)
        self.assertEqual(skipped, 0)
        centre = amap.pos(gapped[0] - 1) + 1
        self.assertEqual(jobs[0][6][0], two[centre - 1 - 10:centre - 1 + 10])


class RegionFunctionTests(unittest.TestCase):
    def test_runs_merge_partners_within_five(self):
        self.assertEqual(regions.runs([10, 3, 12, 30, 35, 41]), [[3, 3], [10, 12], [30, 35], [41, 41]])
        self.assertEqual(regions.runs_text([256, 257, 527, 530, 543]), "256-257; 527-530; 543")
        self.assertEqual(regions.runs_text([]), "-")

    def test_candidates_need_a_pair_of_the_own_fold(self):
        rows = [{"direction": "up", "x": 200, "y": 400, "padj": 1e-9, "log2FoldChange": 3.0},
                {"direction": "up", "x": 500, "y": 100, "padj": 1e-8, "log2FoldChange": 2.0},
                {"direction": "up", "x": 100, "y": 500, "padj": 0.02, "log2FoldChange": 2.0},
                {"direction": "down", "x": 100, "y": 500, "padj": 1e-12, "log2FoldChange": -2.0}]
        ranked = regions.ranked(rows, "up", 0.01)
        self.assertEqual([r["x"] for r in ranked], [200, 500])
        own = [(150, 470), (101, 510), (20, 30)]
        other = [(105, 505)]
        found = regions.candidates(ranked, own, other, None, 50)
        self.assertEqual(len(found), 1)
        c = found[0]
        self.assertEqual((c["rank"], c["a"], c["b"], c["pairs_own"], c["pairs_other"]), (2, 105, 505, 2, 1))
        self.assertEqual(regions.windows_of(c["hit"], 15, 520), [(86, 165), (455, 520)])
        # touching windows become one
        self.assertEqual(regions.windows_of([(100, 120)], 15, 600), [(85, 135)])

    def test_cut_counts_layout_and_outside_partners(self):
        rng = random.Random(1)
        seq = "".join(rng.choice("ACGU") for _ in range(200))
        partner = {}
        for i, j in [(11, 120), (12, 119), (13, 118), (20, 30), (21, 29), (15, 180), (16, 179), (125, 160)]:
            partner[i], partner[j] = j, i
        panel = regions.cut(seq, partner, [(10, 32), (115, 130)])
        self.assertEqual(len(panel["pos"]), 23 + 16)
        self.assertEqual(panel["pairs_in_window"], [2, 0])
        self.assertEqual(panel["inter_window_pairs"], 3)
        self.assertEqual(panel["bases_paired_outside"], 3)
        self.assertEqual(panel["outside_partners"], [[160, 160], [179, 180]])
        self.assertEqual(panel["base"], seq[9:32] + seq[114:130])
        k = panel["pos"].index(11)
        self.assertEqual(panel["pos"][panel["partner"][k]], 120)
        self.assertEqual(panel["outside"][panel["pos"].index(15)], 180)
        self.assertEqual(len(panel["linker"]), 3)
        self.assertEqual(len(panel["x"]), len(panel["pos"]))
        # consecutive bases are about one backbone step apart in the layout
        step = math.dist((panel["x"][0], panel["y"][0]), (panel["x"][1], panel["y"][1]))
        self.assertTrue(5 < step < 30, step)

    def test_crossing_pairs_are_left_out_of_the_layout_only(self):
        seq = "G" * 40
        partner = {}
        for i, j in [(2, 20), (10, 30)]:
            partner[i], partner[j] = j, i
        panel = regions.cut(seq, partner, [(1, 40)])
        self.assertEqual(panel["pairs_in_window"], [2])
        self.assertEqual(panel["not_drawn"], 1)


def _random(n, seed):
    rng = random.Random(seed)
    return "".join(rng.choice("ACGU") for _ in range(n))


def _dbn(n, pairs):
    chars = ["."] * n
    for i, j in pairs:
        chars[i - 1], chars[j - 1] = "(", ")"
    return "".join(chars)


class PanelsProjectTests(unittest.TestCase):
    """structure_regions / energy_run / read_energy through the bridge on a small two-lineage project."""

    def setUp(self):
        from desktop.runtime.samples import add_reference, add_sample

        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.project = base / "p.rnaxrayproj"
        new_project(self.project, "Panels")
        self.seq_a = _random(LENGTH, 5)
        b = list(self.seq_a[:49] + "G" + self.seq_a[49:])  # B = A with one base inserted after 49
        b[400] = "A" if b[400] != "A" else "C"
        self.seq_b = "".join(b)
        refs = {}
        for gene, seq in ((GENE_A, self.seq_a), (GENE_B, self.seq_b)):
            path = base / f"{gene}.fa"
            path.write_text(f">{gene}\n{seq}\n")
            refs[gene] = add_reference(self.project, path, mode="linked")["reference"]["id"]
        hyb = f"1_1\tACGU\t.\t{GENE_A}\t1\t20\t1\t20\t1e-5\t{GENE_A}\t21\t40\t100\t120\t1e-5\t\t-10\tType_1\n"
        self.one, self.two = [], []
        for name, gene in (("a1", GENE_A), ("a2", GENE_A), ("b1", GENE_B), ("b2", GENE_B)):
            path = base / f"{name}.hyb"
            path.write_text(hyb)
            sample = add_sample(self.project, path, name=name, reference_id=refs[gene], gene_id=gene,
                                condition=name[0], mode="linked")
            (self.one if gene == GENE_A else self.two).append(sample["id"])
        # A's fold: helix 101-110 x 501-510 and 301 paired outside (to 150)
        self.pairs_a = [(100 + k, 511 - k) for k in range(1, 11)] + [(150, 301)]
        # B's fold (B coordinates = A + 1 after 49): helix A 301-308 x 451-458
        self.pairs_b = [(301 + k, 460 - k) for k in range(1, 9)] + [(103, 201)]
        self._structure("st-a", GENE_A, self.seq_a, self.pairs_a, self.one)
        self._structure("st-b", GENE_B, self.seq_b, self.pairs_b, self.two)
        self._comparison()

    def tearDown(self):
        self.tmp.cleanup()

    def _register(self, task_id, kind, result):
        run = self.project / "runs" / task_id
        run.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(run / "result.json", result)
        _atomic_write_json(run / "status.json", {"task_id": task_id, "kind": kind, "status": "succeeded",
                                                 "started_at": "2026-10-16T10:00:00Z", "finished_at": "2026-10-16T10:01:00Z"})
        register_task_run(self.project, task_id)

    def _structure(self, task_id, gene, seq, pairs, samples):
        out = self.project / "structures" / task_id
        out.mkdir(parents=True)
        n = len(seq)
        (out / "structure.dbn").write_text(f">{gene}:1-{n} CPLfold pseudoknot-free, alpha 0.5, beam 100, energy -100.00\n{seq}\n{_dbn(n, pairs)}\n")
        rel = f"structures/{task_id}"
        self._register(task_id, "structure", {"ok": True, "structure": {
            "id": task_id, "task_id": task_id, "sample_ids": samples, "gene_id": gene, "mode": "genome",
            "windows": [{"start": 1, "end": n}], "parameters": {}, "created_at": "2026-10-16T10:00:00Z", "path": rel,
            "paths": {"dbn": rel + "/structure.dbn"}, "summary": {"pairs": len(pairs)}}})

    def _comparison(self):
        out = self.project / "comparisons" / "cmp"
        out.mkdir(parents=True)
        rows = [  # direction x y log2FoldChange padj baseMean
            ("up", 200, 400, 3.0, 1e-9),     # rank 1 up: not formed by A
            ("up", 100, 500, 2.5, 1e-8),     # rank 2 up: A's helix
            ("up", 590, 100, 2.0, 1e-7),     # arm off the end: no energy
            ("up", 100, 500, 2.0, 0.02),     # above the cutoff
            ("down", 452, 302, -4.0, 1e-10),  # cell on B's reference: A 305 x 455, B's helix
            ("down", 30, 60, -3.0, 1e-6),
        ]
        text = "direction\tx\ty\tlog2FoldChange\tpadj\tbaseMean\n" + "".join(
            f"{d}\t{x}\t{y}\t{l}\t{p}\t10\n" for d, x, y, l, p in rows)
        (out / "interactions.tsv").write_text(text)
        (out / "significant.tsv").write_text("x\ty\tbaseMean\tlog2FoldChange\tlfcSE\tstat\tpvalue\tpadj\n")
        self._register("cmp", "compare", {"ok": True, "comparison": {
            "samples_one": self.one, "samples_two": self.two, "label_one": "AFR", "label_two": "ILM",
            "genes": [GENE_A, GENE_B], "parameters": {}, "created_at": "2026-10-16T10:00:00Z", "summary": {}}})

    def _regions(self, **extra):
        request = {"operation": "structure_regions", "path": str(self.project), "comparison_id": "cmp",
                   "structure_one": "st-a", "structure_two": "st-b"}
        request.update(extra)
        result = handle(request, repo_root=ROOT)
        self.assertTrue(result["ok"], result)
        return result

    def test_regions_pick_formed_interactions_and_cut_both_folds(self):
        result = self._regions()
        up, down = result["regions"]
        self.assertEqual((up["direction"], up["tested"], up["chosen"]), ("up", 3, 2))
        self.assertEqual([c["rank"] for c in up["candidates"]], [2])
        self.assertEqual(up["windows"], [[86, 125], [486, 525]])
        own, other = up["panels"]
        self.assertEqual((own["structure_id"], own["enriched"], own["inter_window_pairs"]), ("st-a", True, 10))
        self.assertEqual(own["windows"], [[86, 125], [486, 525]])
        # the same windows on B's own reference
        self.assertEqual((other["structure_id"], other["windows"]), ("st-b", [[87, 126], [487, 526]]))
        self.assertEqual(other["inter_window_pairs"], 0)
        self.assertEqual(other["outside_partners"], [[201, 201]])

        # down: the cell is on B's reference and moves onto A's (B 307 x 457 -> A 306 x 456)
        self.assertEqual(down["chosen"], 1)
        chosen = down["candidates"][0]
        self.assertEqual((chosen["a"], chosen["b"], chosen["cell_a"], chosen["cell_b"]), (306, 456, 307, 457))
        self.assertEqual(down["windows"], [[286, 323], [436, 473]])
        own, other = down["panels"]
        self.assertEqual((own["structure_id"], own["inter_window_pairs"], own["windows"]), ("st-b", 8, [[287, 324], [437, 474]]))
        self.assertEqual((other["structure_id"], other["inter_window_pairs"]), ("st-a", 0))
        self.assertEqual(other["outside_partners"], [[150, 150]])
        self.assertEqual(result["alignment"][0]["gaps"], 1)

    def test_regions_choice_reach_and_flank(self):
        result = self._regions(flank=5, reach=10)
        self.assertEqual(result["regions"][0]["windows"], [[96, 115], [496, 515]])
        # a rank that is not a candidate falls back to the best one
        result = self._regions(choice={"up": 1})
        self.assertEqual(result["regions"][0]["chosen"], 2)
        result = self._regions(reach=0)
        self.assertEqual(result["regions"][0]["chosen"], None)
        self.assertEqual(result["regions"][0]["panels"], [])
        with self.assertRaises(ValueError):
            self._regions(reach=-1)
        with self.assertRaises(ValueError):
            self._regions(structure_two="")

    def test_energy_task_and_read(self):
        import RNA

        run = self.project / "runs" / "energy-1"
        run.mkdir(parents=True)
        result = handle({"operation": "energy_run", "project_path": str(self.project), "task_id": "energy-1",
                         "run_dir": str(run), "comparison_id": "cmp", "parameters": {"length": 20}}, repo_root=ROOT)
        self.assertTrue(result["ok"], result)
        summary = result["summary"]
        self.assertEqual((summary["interactions"], summary["folded"], summary["skipped"]), (5, 4, 1))
        self.assertEqual(summary["sides"]["enriched_in_one"]["n"], 2)
        self.assertEqual(summary["sides"]["enriched_in_two"]["n"], 2)
        read = handle({"operation": "read_energy", "path": str(self.project), "comparison_id": "cmp"}, repo_root=ROOT)
        self.assertEqual(read["lengths"], [20])
        rows = read["rows"]
        self.assertEqual(rows["side"], ["enriched_in_one", "enriched_in_one", "enriched_in_two", "enriched_in_two"])
        # fragments: 20 nt centred on bin start + 5 of A; B at the aligned positions (A + 1 after 49)
        k = rows["x"].index(452)
        a = self.seq_a
        b = self.seq_b
        want_one = round(RNA.cofold(a[456 - 10:456 + 10] + "&" + a[306 - 10:306 + 10])[1], 2)
        want_two = round(RNA.cofold(b[457 - 10:457 + 10] + "&" + b[307 - 10:307 + 10])[1], 2)
        self.assertEqual((rows["dG_one"][k], rows["dG_two"][k]), (want_one, want_two))
        tsv = (self.project / "comparisons" / "cmp" / "energy_L20.tsv").read_text().splitlines()
        self.assertEqual(tsv[0], "length\tside\tx\ty\tlog2FoldChange\tpadj\tdG_one\tdG_two")
        self.assertEqual(len(tsv), 5)
        self.assertTrue((run / "progress.json").is_file())
        # registering the run keeps the manifest valid
        _atomic_write_json(run / "status.json", {"task_id": "energy-1", "kind": "energy", "status": "succeeded"})
        register_task_run(self.project, "energy-1")
        self.assertTrue(any(r["id"] == "energy-1" for r in load_manifest(self.project)["runs"]))

    def test_energy_rejects_bad_requests(self):
        base = {"operation": "energy_run", "project_path": str(self.project), "comparison_id": "cmp"}
        for bad in ({"length": 2}, {"padj": 0}, {"other": 1}):
            with self.assertRaises(ValueError):
                handle({**base, "parameters": bad}, repo_root=ROOT)
        with self.assertRaises(ValueError):
            handle({**base, "comparison_id": "nope"}, repo_root=ROOT)
        empty = handle({"operation": "read_energy", "path": str(self.project), "comparison_id": "cmp"}, repo_root=ROOT)
        self.assertEqual((empty["lengths"], empty["summary"]), ([], None))


if __name__ == "__main__":
    unittest.main()

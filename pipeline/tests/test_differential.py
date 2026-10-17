"""Tests for rnaxrayanalysis.deseq / differential against R DESeq2 1.46.

``golden/deseq/<case>.R.tsv`` were made with R 4.4.3 + DESeq2 1.46.0 from
``<case>.counts.tsv`` and ``<case>.conditions.tsv`` by the same calls as
``bin/DESeq_run.R`` (``rowSums > 2``, ``DESeq()``, ``results(contrast =
c("conditions", "condition_one", "condition_two"), alpha = 0.01)``).  The
counts are random rows of the reproduce_zikv comparisons:

- ``two_vs_two``: ZAFR REP1-2 vs ZBRA REP1-2;
- ``two_vs_three``: ZAFR REP1-2 vs ZSIN REP1-3 (Cook's distance filtering);
- ``local_fit``: Livefire1-3 vs Aag1-2 on min-10 hybrids, where the parametric
  dispersion trend fails and DESeq2 substitutes locfit;
- ``local_extrapolation``: a synthetic 2 vs 2 table (scratch generator, kept
  as counts) whose locfit trend is evaluated far above the fitted means (one
  strong block of cells), checking locfit's extrapolation (``dispFit``
  column).
- ``bandwidth_690``: a synthetic 3 vs 3 table (R ``DESeq()`` defaults;
  columns baseMean lfc padj dispFit dispersion) whose trend is
  fitted on 690 cells: locfit's span 0.7 takes the floor(690 * 0.7) = 483rd
  nearest point, though 690 * 0.7 is 482.999... in floating point.
- ``local_four_points``: a synthetic 3 vs 3 table of 7 rows (R ``DESeq()``
  defaults; columns as ``bandwidth_690``) whose trend falls back to locfit on
  only 4 gene-wise estimates; ``local_vertex_space``: a 3-row table where R
  stops with locfit's "newsplit: out of vertex space" (counts only).
- ``local_small_fits``: locfit itself, ``locfit(logDisps ~ logMeans, weights
  = means)`` then ``exp(predict())`` as in ``localDispersionFit``, on 2-8
  points (random, wide, tied and equispaced means; scratch generator, kept as
  ``case means disps`` and ``case q p``; ``p`` is NA where R stops with "out of
  vertex space").
- ``map_two_vs_two`` (2 vs 2), ``map_three_vs_two`` (3 vs 2), ``map_one_vs_two``
  (1 vs 2): small synthetic tables (scratch generator, R ``DESeq()`` defaults,
  ``results(alpha = 0.01)``; columns baseMean lfc padj dispGeneEst dispFit
  dispersion dispPriorVar) with 1-3 residual degrees of freedom, where
  dispPriorVar comes from DESeq2's simulation after ``set.seed(2)``; the
  numerical-convolution prior variance was off by up to 25x and the final
  dispersions by up to 80%.  ``map_small_dispersion`` (2 vs 3, local trend):
  genes whose MAP dispersion is ~1e-4, where the order of the lgamma terms in
  the log posterior decides the line search.
"""
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from rnaxrayanalysis import deseq, differential  # noqa: E402

GOLDEN = HERE / "golden" / "deseq"

# R 4.4.3: hist(log(rchisq(1e4, 2)) + rnorm(1e4, 0, sqrt(v)) - log(2), breaks =
# -20:20/2)$counts for the 101st grid value v of seq(0, 8, length = 200), the
# draws continuing the stream after set.seed(2) as estimateDispersionsPriorVar
# does
SIMULATED_DF2_GRID100 = [3, 2, 7, 10, 11, 21, 36, 64, 90, 141, 183, 242, 314, 442, 483, 651, 698, 798, 815, 868,
                         827, 724, 618, 553, 450, 320, 232, 160, 105, 58, 27, 23, 11, 3, 2, 4, 0, 0, 0, 0]
# R 4.4.3 lgamma(x), both printed with %a
LGAMMA_R = [
    ("0x1p-1", "0x1.250d048e7a1bdp-1"),
    ("0x1.ep+1", "0x1.7c9ff21d3df6ap+0"),
    ("0x1.3fae147ae147bp+3", "0x1.98f02675dd191p+3"),
    ("0x1.5p+3", "0x1.be199a0f64394p+3"),
    ("0x1.6333333333333p+5", "0x1.ec2d15b2e1b2p+6"),
    ("0x1.81cd6c8b43958p+13", "0x1.9617eb7eee0bcp+16"),
    ("0x1.3882aaaaaaaabp+13", "0x1.40b6c9a012ff2p+16"),
    ("0x1.2d30fep+22", "0x1.0f4b61cf35128p+26"),
    ("0x1.2d3106p+22", "0x1.0f4b6983eb25bp+26"),
    ("0x1.7d78404p+24", "0x1.7e4a2083b2ce5p+28"),
    ("0x1.7d7841cp+26", "0x1.9f57678c31c43p+30"),
    ("0x1.5d3ef798p+41", "0x1.2ea3b362d0422p+46"),
    ("0x1.6345785d8ap+57", "0x1.af2da8ce803abp+62"),
]


def _load(case):
    ids, rows = [], []
    with open(GOLDEN / f"{case}.counts.tsv") as handle:
        columns = handle.readline().rstrip("\n").split("\t")[1:]
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            ids.append(parts[0])
            rows.append([int(v) for v in parts[1:]])
    with open(GOLDEN / f"{case}.conditions.tsv") as handle:
        conditions = dict(line.rstrip("\n").split("\t") for line in handle)
    one = [conditions[c] == "condition_one" for c in columns]
    expected = {}
    with open(GOLDEN / f"{case}.R.tsv") as handle:
        handle.readline()
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            expected[parts[0]] = [math.nan if v == "NA" else float(v) for v in parts[1:]]
    return ids, np.array(rows), one, expected


def _ranks(values):
    order = np.argsort(values, kind="stable")
    ranks = np.empty(len(values))
    ranks[order] = np.arange(len(values))
    return ranks


class DeseqMatchesR(unittest.TestCase):
    def check(self, case, fit_type):
        ids, counts, one, expected = _load(case)
        res = deseq.deseq_two_conditions(counts, one)
        self.assertEqual(res["fitType"], fit_type)
        r = np.array([expected[i] for i in ids])  # baseMean lfc se p padj
        np.testing.assert_allclose(res["baseMean"], r[:, 0], rtol=1e-9)
        padj, r_padj = res["padj"], r[:, 4]
        # Same rows filtered (independent filtering, Cook's distance).
        self.assertEqual(int(np.sum(np.isnan(padj) != np.isnan(r_padj))), 0)
        both = ~np.isnan(padj)
        rho = np.corrcoef(_ranks(padj[both]), _ranks(r_padj[both]))[0, 1]
        self.assertGreater(rho, 0.9999)
        self.assertLess(float(np.median(np.abs(padj[both] - r_padj[both]) / r_padj[both])), 1e-3)
        lfc_ok = ~np.isnan(r[:, 1])
        self.assertLess(float(np.median(np.abs(res["log2FoldChange"][lfc_ok] - r[lfc_ok, 1]))), 1e-4)
        mine = set(np.where(padj < 0.05)[0])
        theirs = set(np.where(r_padj < 0.05)[0])
        self.assertLessEqual(len(mine ^ theirs), max(1, len(theirs) // 200))

    def test_two_vs_two(self):
        self.check("two_vs_two", "parametric")

    def test_two_vs_three_with_cooks_filtering(self):
        self.check("two_vs_three", "parametric")

    def test_local_fit_fallback(self):
        self.check("local_fit", "local")

    def test_local_fit_extrapolates_like_locfit(self):
        # the trend is fitted on means up to ~8 but evaluated at ~300; a cubic
        # Hermite continuation gave dispFit ~1e37 and padj ~1 here, R gives
        # dispFit ~1.07 and padj ~0.002
        self.check("local_extrapolation", "local")
        ids, counts, one, expected = _load("local_extrapolation")
        res = deseq.deseq_two_conditions(counts, one)
        r = np.array([expected[i] for i in ids])
        np.testing.assert_allclose(res["dispFit"], r[:, 5], rtol=1e-5)
        strong = [ids.index(cell) for cell in ("100_300", "100_310", "110_300", "110_310")]
        np.testing.assert_allclose(res["padj"][strong], r[strong, 4], rtol=1e-3)
        self.assertTrue(np.all(res["padj"][strong] < 0.01))


    def test_local_fit_bandwidth_at_a_floating_point_edge(self):
        ids, counts, one, expected = _load("bandwidth_690")
        res = deseq.deseq_two_conditions(counts, one)
        self.assertEqual(res["fitType"], "local")
        r = np.array([expected[i] for i in ids])  # baseMean lfc padj dispFit dispersion
        np.testing.assert_allclose(res["dispFit"], r[:, 3], rtol=1e-6)
        np.testing.assert_allclose(res["dispersion"], r[:, 4], rtol=1e-6)

    def test_map_dispersion_matches_r(self):
        for case in ("map_two_vs_two", "map_three_vs_two", "map_one_vs_two", "map_small_dispersion"):
            with self.subTest(case=case):
                ids, counts, one, expected = _load(case)
                keep = counts.sum(axis=1) > 2
                res = deseq.deseq_two_conditions(counts[keep], [bool(v) for v in one])
                r = np.array([expected[i] for i, k in zip(ids, keep) if k])
                # baseMean lfc padj dispGeneEst dispFit dispersion dispPriorVar
                self.assertAlmostEqual(res["dispPriorVar"], r[0, 6], places=12)
                np.testing.assert_allclose(res["dispGeneEst"], r[:, 3], rtol=1e-9)
                np.testing.assert_allclose(res["dispFit"], r[:, 4], rtol=1e-8)
                np.testing.assert_allclose(res["dispersion"], r[:, 5], rtol=1e-8)
                # (IRLS stops at a deviance tolerance: lfc within ~1e-5 where a cell is 0)
                np.testing.assert_allclose(res["log2FoldChange"], r[:, 1], rtol=1e-4)
                np.testing.assert_allclose(res["padj"], r[:, 2], rtol=1e-4)

    def test_prior_variance_simulation_is_rs(self):
        dens = deseq._simulated_log_disp(2)
        expected = SIMULATED_DF2_GRID100
        np.testing.assert_array_equal(np.round(dens[100] * np.sum(expected) * 0.5), expected)

    def test_lgamma_is_rs(self):
        for x, value in LGAMMA_R:
            self.assertEqual(deseq._lgamma_r(float.fromhex(x)), float.fromhex(value), x)

    def test_local_fit_on_a_few_points(self):
        # degenerate local fits (one or two points in the window, a vertex with
        # no points, nearly collinear windows) as locfit solves them
        data, pred = {}, {}
        with open(GOLDEN / "local_small_fits.data.tsv") as handle:
            handle.readline()
            for line in handle:
                case, mean, disp = line.split("\t")
                data.setdefault(case, []).append((float(mean), float(disp)))
        with open(GOLDEN / "local_small_fits.R.tsv") as handle:
            handle.readline()
            for line in handle:
                case, q, p = line.split("\t")
                pred.setdefault(case, []).append((float(q), math.nan if p.strip() == "NA" else float(p)))
        for case, rows in data.items():
            means, disps = np.array(rows).T
            q, p = np.array(pred[case]).T
            with self.subTest(case=case):
                if np.isnan(p).all():
                    with self.assertRaisesRegex(ValueError, "out of vertex space"):
                        deseq._local_fit(means, disps, q)
                else:
                    np.testing.assert_allclose(deseq._local_fit(means, disps, q), p, rtol=1e-8)

    def test_local_fit_with_four_points(self):
        ids, counts, one, expected = _load("local_four_points")
        res = deseq.deseq_two_conditions(counts, one)
        self.assertEqual(res["fitType"], "local")
        r = np.array([expected[i] for i in ids])  # baseMean lfc padj dispFit dispersion
        np.testing.assert_allclose(res["dispFit"], r[:, 3], rtol=1e-9)
        np.testing.assert_allclose(res["dispersion"], r[:, 4], rtol=1e-5)
        np.testing.assert_allclose(res["padj"], r[:, 2], rtol=1e-4)

    def test_local_fit_out_of_vertex_space(self):
        with open(GOLDEN / "local_vertex_space.counts.tsv") as handle:
            handle.readline()
            counts = np.array([[int(v) for v in line.split("\t")[1:]] for line in handle])
        with self.assertRaisesRegex(ValueError, "out of vertex space"):
            deseq.deseq_two_conditions(counts, [True, True, True, False, False, False])


class Helpers(unittest.TestCase):
    def test_no_trend_when_every_dispersion_is_at_the_minimum(self):
        # R estimateDispersionsFit: "all gene-wise dispersion estimates are within
        # 2 orders of magnitude from the minimum value ..."
        counts = np.array([[5, 15, 2, 9], [1, 1, 2, 2], [18, 29, 7, 11]])
        with self.assertRaisesRegex(ValueError, "within 2 orders of magnitude"):
            deseq.deseq_two_conditions(counts, [True, True, False, False])

    def test_no_cell_without_zero_has_no_size_factors(self):
        # R: "every gene contains at least one zero, cannot compute log geometric means"
        counts = np.array([[5, 0, 3, 4], [2, 6, 0, 1], [0, 7, 8, 9], [3, 3, 3, 0]])
        with self.assertRaisesRegex(ValueError, "size factors"):
            deseq.deseq_two_conditions(counts, [True, True, False, False])

    def test_bh_matches_r(self):
        # p.adjust(c(0.01, 0.02, NA, 0.03, 0.5), "BH") in R
        out = deseq.p_adjust_bh(np.array([0.01, 0.02, np.nan, 0.03, 0.5]))
        np.testing.assert_allclose(out[[0, 1, 3, 4]], [0.04, 0.04, 0.04, 0.5])
        self.assertTrue(math.isnan(out[2]))

    def test_lowess_matches_r(self):
        # lowess(1:10, c(2,4,3,6,8,7,9,12,11,14), f = 1/2)$y in R 4.4.3
        y = deseq.lowess(np.arange(1, 11), np.array([2, 4, 3, 6, 8, 7, 9, 12, 11, 14], float), f=0.5)
        np.testing.assert_allclose(y, [2.2747429004, 3.1808212307, 4.1855134505, 5.7235981303, 7.1313547454,
                                       7.8686438305, 9.2766208349, 10.8326249350, 12.2145460521, 13.5338242069],
                                   atol=1e-9)


class SplitAndCompare(unittest.TestCase):
    def test_split_keeps_best_cell_per_neighbourhood_and_direction(self):
        x = np.array([100, 150, 400, 120, 1000])
        y = np.array([500, 520, 900, 510, 1000])
        lfc = np.array([1.0, 2.0, 1.5, -1.0, 3.0])
        padj = np.array([0.01, 0.001, 0.02, 0.03, 0.04])
        kept = differential.split_interactions(x, y, lfc, padj, 100)
        # cell 1 (best) hides cell 0; cell 3 has the other sign; 2 and 4 are far away
        self.assertEqual(kept, [1, 2, 4, 3])

    def test_bucketed_split_matches_the_plain_scan(self):
        def plain(x, y, lfc, padj, radius):
            kept = []
            for direction in (1, -1):
                cx, cy = [], []
                for index in np.argsort(padj, kind="stable"):
                    if np.sign(lfc[index]) != direction:
                        continue
                    if any(abs(a - x[index]) <= radius and abs(b - y[index]) <= radius for a, b in zip(cx, cy)):
                        continue
                    cx.append(int(x[index]))
                    cy.append(int(y[index]))
                    kept.append(int(index))
            return kept

        rng = np.random.default_rng(1)
        for case in range(60):
            n = int(rng.integers(1, 800))
            span = [50, 500, 5000, 10 ** 6][case % 4]
            radius = [0, 1, 10, 100, 250][case % 5]
            x = rng.integers(0, span // 10 + 1, n) * 10 - (span // 2 if case % 7 == 0 else 0)
            y = rng.integers(0, span // 10 + 1, n) * 10
            lfc = np.where(rng.random(n) < 0.05, 0.0, rng.random(n) - 0.5)
            padj = np.where(rng.random(n) < 0.2, 0.01, rng.random(n) * 0.05)
            self.assertEqual(differential.split_interactions(x, y, lfc, padj, radius), plain(x, y, lfc, padj, radius))

    def test_compare_writes_outputs_from_contact_maps(self):
        ids, counts, one, expected = _load("two_vs_two")
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            contacts = []
            for column in range(counts.shape[1]):
                path = tmp / f"s{column}.G.contact.txt"
                with open(path, "w") as handle:
                    handle.write("# hybrids between G and G\nx\ty\tcount\n")
                    for cell, value in zip(ids, counts[:, column]):
                        if value:
                            x, y = cell.split("_")
                            handle.write(f"{x}\t{y}\t{value}\n")
                contacts.append(path)
            summary = differential.compare(contacts, [f"s{i}" for i in range(4)], one, tmp / "out")
            self.assertEqual(summary["cells_tested"], len(ids))
            significant = differential.read_significant(tmp / "out" / "significant.tsv")
            r_sig = sum(1 for values in expected.values() if values[4] < 0.05)
            self.assertLessEqual(abs(len(significant["x"]) - r_sig), max(1, r_sig // 200))
            self.assertEqual(summary["significant"], len(significant["x"]))
            self.assertTrue(all(p < 0.05 for p in significant["padj"]))
            self.assertEqual(significant["padj"], sorted(significant["padj"]))
            interactions = differential.read_interactions(tmp / "out" / "interactions.tsv")
            self.assertEqual(len(interactions), summary["interactions"])
            self.assertEqual(sum(1 for row in interactions if row["direction"] == "up"), summary["interactions_up"])
            with open(tmp / "out" / "results.tsv") as handle:
                header = handle.readline().rstrip("\n").split("\t")
            self.assertEqual(header, ["x", "y", "s0", "s1", "s2", "s3", "baseMean", "log2FoldChange", "lfcSE",
                                      "stat", "pvalue", "padj"])
            self.assertEqual(json.loads((tmp / "out" / "summary.json").read_text())["engine"].split()[0],
                             "rnaxrayanalysis.deseq")

    def test_compare_rejects_single_sample_condition_pairs(self):
        with self.assertRaises(ValueError):
            differential.compare(["a", "b"], ["a", "b"], [True, False], "unused")


if __name__ == "__main__":
    unittest.main()

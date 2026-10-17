"""Tests for rnaxrayanalysis: legacy-identical contact.txt/forTable, index and queries.

The golden ``testData.<gene>.contact.txt`` / ``.forTable.txt`` files were made
from ``golden/testData.hyb`` with the legacy commands under macOS
``/usr/bin/awk`` (one-true-awk 20200816)::

    plot_hybrids_3.awk USE_ENTIRE_HYBRIDS=1 BIN_SIZE=10 GENE_1=G GENE_2=G testData.hyb \
        | sed '2s/^/x\\ty\\tcount\\n/' > testData.G.contact.txt
    sort -k3,3nr testData.G.contact.txt | awk -v a=testData.G '!/^#/{print $1 "_" $2 "\\t" a "=" $3}'

The Zika files are large, so only their sha256 is kept.
"""
import hashlib
import random
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from rnaxrayanalysis import coverage, hybfile, index, query  # noqa: E402
from rnaxraypipe import awk  # noqa: E402

GOLDEN = HERE / "golden"
HYB = GOLDEN / "testData.hyb"
ZIKA_SHA256 = {
    "contact": "9373b0422f4465cae981a32fc88342b48412c884ab8b553b0e73d68a66f1f43f",
    "forTable": "7b35a78227b3dd3059ec968d49ce210707bbac66a43231f380786e1e8fcfe9ca",
}


def records():
    with open(HYB, "rb") as handle:
        return [r for r in (hybfile.parse(line) for line in handle) if r is not None]


def brute_contact(recs, gene, bin_size, measure="records", types=None):
    cells = {}
    gene = gene.encode()
    for r in recs:
        if r.gene1 != gene or r.gene2 != gene or (types and r.chimera_type.decode() not in types):
            continue
        weight = 1 if measure == "records" else r.reads
        for i in range(r.start1 // bin_size, r.end1 // bin_size + 1):
            for j in range(r.start2 // bin_size, r.end2 // bin_size + 1):
                cells[(i * bin_size, j * bin_size)] = cells.get((i * bin_size, j * bin_size), 0) + weight
    return {k: v for k, v in cells.items() if v}


def as_cells(result):
    return dict(zip(zip(result["x"], result["y"]), result["count"]))


class CoverageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_contact_and_for_table_match_legacy(self):
        out = coverage.write_contact(HYB, "18S_rRNA", self.dir / "testData.18S_rRNA.contact.txt")
        self.assertEqual(out.read_bytes(), (GOLDEN / "testData.18S_rRNA.contact.txt").read_bytes())
        table = coverage.write_for_table(out, self.dir / "t.forTable.txt", name="testData.18S_rRNA")
        self.assertEqual(table.read_bytes(), (GOLDEN / "testData.18S_rRNA.forTable.txt").read_bytes())

    def test_large_gene_matches_legacy_hash(self):
        out = coverage.write_contact(HYB, "Zika_virusRNA", self.dir / "z.contact.txt")
        self.assertEqual(hashlib.sha256(out.read_bytes()).hexdigest(), ZIKA_SHA256["contact"])
        table = coverage.write_for_table(out, self.dir / "z.forTable.txt", name="testData.Zika_virusRNA")
        self.assertEqual(hashlib.sha256(table.read_bytes()).hexdigest(), ZIKA_SHA256["forTable"])

    def test_reference_port_agrees_with_fast_path(self):
        fast = list(coverage.contact_lines(HYB, "Zika_virusRNA"))
        slow = list(coverage.contact_lines(HYB, "Zika_virusRNA", exact_fallback_only=True))
        self.assertEqual(fast, slow)

    def test_absent_gene_has_no_header_line(self):
        out = coverage.write_contact(HYB, "NoSuchGene", self.dir / "n.contact.txt")
        self.assertEqual(out.read_bytes(), (GOLDEN / "testData.NoSuchGene.contact.txt").read_bytes())
        self.assertEqual(coverage.write_for_table(out, self.dir / "n.forTable.txt").read_bytes(), b"")

    def test_default_names_follow_the_shell_substitution(self):
        self.assertEqual(coverage.contact_path("/a/S.hyb", "G"), Path("/a/S.G.contact.txt"))
        self.assertEqual(coverage.for_table_name("/a/S.G.contact.txt"), "/a/S.G")

    def test_unusual_coordinates_use_the_exact_fallback(self):
        hyb = self.dir / "odd.hyb"
        hyb.write_text("a_1\tACGT\t.\tG\t1\t4\t25.5\t47\t1\tG\t5\t9\t3\t18\t1\n"
                       "b_2\tACGT\t.\tG\t1\t4\t12\t30\t1\tG\t5\t9\t1\t9\t1\n")
        lines = list(coverage.contact_lines(hyb, "G"))
        self.assertEqual(sorted(lines), sorted(coverage.contact_lines(hyb, "G", exact_fallback_only=True)))
        self.assertEqual(sum(int(line.split(b"\t")[2]) for line in lines), 3 * 2 + 3 * 1)

    def test_bwk_order_matches_awk_array(self):
        rng = random.Random(7)
        for total in (0, 1, 99, 100, 101, 401, 1601, 7000):
            keys, seen = [], set()
            while len(keys) < total:
                key = "%d\t%d" % (rng.randrange(0, 11000, 10), rng.randrange(0, 11000, 10))
                if key not in seen:
                    seen.add(key)
                    keys.append(key)
            array = awk.BwkArray()
            for key in keys:
                array[key] = 1
            order = coverage.bwk_order(coverage._hash_keys([k.encode() for k in keys]))
            self.assertEqual([keys[i] for i in order.tolist()], list(array.keys()), total)


class IndexQueryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.index = Path(cls.tmp.name) / "testData.rnaxrayidx"
        cls.meta = index.build(HYB, cls.index)
        cls.records = records()

    @classmethod
    def tearDownClass(cls):
        query.close_all()
        cls.tmp.cleanup()

    def test_index_path_with_uri_characters(self):
        # Folder names such as "ZIKV #2" or "50% subset" must not change
        # which file SQLite opens, or how (the index stays read-only).
        folder = Path(self.tmp.name) / "ZIKV #2 50% a?mode=rw&x"
        folder.mkdir()
        copy = folder / "testData.rnaxrayidx"
        copy.write_bytes(self.index.read_bytes())
        self.assertEqual(query.summary([copy])["merged"]["records"], self.meta["records"])
        con = query._get(copy).con
        with self.assertRaises(Exception):
            con.execute("CREATE TABLE x (a)")

    def test_meta_and_summary(self):
        self.assertEqual(self.meta["records"], 10411)
        self.assertEqual(self.meta["invalid"], 0)
        result = query.summary([self.index])
        merged = result["merged"]
        self.assertEqual(merged["records"], 10411)
        self.assertEqual(merged["reads"], sum(r.reads for r in self.records))
        self.assertEqual({g["name"] for g in merged["genes"]}, {"Zika_virusRNA", "18S_rRNA"})
        zika = next(g for g in merged["genes"] if g["name"] == "Zika_virusRNA")
        self.assertEqual(zika["length"], max(max(r.end1 for r in self.records if r.gene1 == b"Zika_virusRNA"),
                                             max(r.end2 for r in self.records if r.gene2 == b"Zika_virusRNA")))
        self.assertEqual(sum(t["records"] for t in merged["types"]), 10411)
        pair = next(p for p in merged["pairs"] if p["gene1"] == "Zika_virusRNA" and p["gene2"] == "18S_rRNA")
        self.assertEqual(pair["records"], 947)
        doubled = query.summary([self.index, self.index])["merged"]
        self.assertEqual(doubled["records"], 2 * 10411)
        self.assertEqual(doubled["genes"][0]["records"], 2 * merged["genes"][0]["records"])

    def test_contact_bins_at_10_equal_contact_txt(self):
        result = query.contact_bins([self.index], "18S_rRNA", 10)
        legacy = {}
        for line in (GOLDEN / "testData.18S_rRNA.contact.txt").read_text().splitlines()[2:]:
            x, y, c = map(int, line.split("\t"))
            legacy[(x, y)] = c
        self.assertEqual(as_cells(result), legacy)
        self.assertEqual(result["cells"], len(legacy))
        self.assertEqual(result["total"], 365)

    def test_contact_bins_any_bin_size_and_measure(self):
        for bin_size in (5, 7, 25, 100):
            for measure in ("records", "reads"):
                got = as_cells(query.contact_bins([self.index], "Zika_virusRNA", bin_size, measure=measure))
                self.assertEqual(got, brute_contact(self.records, "Zika_virusRNA", bin_size, measure), (bin_size, measure))

    def test_contact_bins_types_region_and_merge(self):
        full = brute_contact(self.records, "Zika_virusRNA", 10, types=["Type_1"])
        got = query.contact_bins([self.index], "Zika_virusRNA", 10, types=["Type_1"])
        self.assertEqual(as_cells(got), full)
        for bin_size in (1, 10):
            region = {"x": [2000, 3999], "y": [5000, 7999]}
            got = query.contact_bins([self.index], "Zika_virusRNA", bin_size, region)
            expected = {k: v for k, v in brute_contact(self.records, "Zika_virusRNA", bin_size).items()
                        if 2000 <= k[0] <= 3999 and 5000 <= k[1] <= 7999}
            self.assertEqual(as_cells(got), expected)
        merged = query.contact_bins([self.index, self.index], "Zika_virusRNA", 50)
        single = query.contact_bins([self.index], "Zika_virusRNA", 50)
        self.assertEqual(merged["count"], [2 * c for c in single["count"]])
        self.assertEqual(query.contact_bins([self.index], "Unknown", 10)["cells"], 0)

    def test_contact_bins_max_cells_coarsens(self):
        result = query.contact_bins([self.index], "Zika_virusRNA", 10, max_cells=500)
        self.assertTrue(result["adjusted"])
        self.assertLessEqual(result["cells"], 500)
        self.assertEqual(as_cells(result), brute_contact(self.records, "Zika_virusRNA", result["bin_size"]))

    def test_top_interactions(self):
        result = query.top_interactions([self.index, self.index], "Zika_virusRNA", 25, 10)
        cells = brute_contact(self.records, "Zika_virusRNA", 25)
        expected = sorted(cells.items(), key=lambda kv: (-kv[1], kv[0]))[:10]
        self.assertEqual([(r["x"], r["y"]) for r in result["rows"]], [k for k, _ in expected])
        self.assertEqual([r["count"] for r in result["rows"]], [2 * v for _, v in expected])
        self.assertEqual(result["rows"][0]["per_index"], [expected[0][1]] * 2)

    def test_hybrids_filters(self):
        recs = self.records
        result = query.hybrids([self.index], {"gene1": "Zika_virusRNA", "gene2": "Zika_virusRNA",
                                              "region": {"x": [3000, 3200]}}, limit=5)
        expected = [i for i, r in enumerate(recs, 1) if r.gene1 == r.gene2 == b"Zika_virusRNA" and r.end1 >= 3000 and r.start1 <= 3200]
        self.assertEqual(result["total"], len(expected))
        self.assertEqual([row["id"] for row in result["rows"]], expected[:5])
        first = result["rows"][0]
        line = HYB.read_text().splitlines()[expected[0] - 1].split("\t")
        self.assertEqual((first["name"], first["sequence"], first["start1"], first["type"]), (line[0], line[1], int(line[6]), line[17]))

        by_reads = query.hybrids([self.index], {"types": ["Type_2"], "min_reads": 2}, limit=20, offset=3, order="reads")
        expected = sorted(((r.reads, i) for i, r in enumerate(recs, 1) if r.chimera_type == b"Type_2" and r.reads >= 2),
                          key=lambda t: (-t[0], t[1]))
        self.assertEqual(by_reads["total"], len(expected))
        self.assertEqual([(row["reads"], row["id"]) for row in by_reads["rows"]], expected[3:23])

        both = query.hybrids([self.index, self.index], {"gene": "18S_rRNA"}, limit=4, offset=1, order="position",
                             with_sequence=False)
        self.assertEqual(both["total"], 2 * sum(1 for r in recs if b"18S_rRNA" in (r.gene1, r.gene2)))
        self.assertEqual([row["index"] for row in both["rows"]][:1], [1])  # same row from the second index comes next
        self.assertIsNone(both["rows"][0]["name"])
        self.assertEqual(query.hybrids([self.index], {"gene1": "Unknown"})["total"], 0)

    def test_bad_arguments(self):
        with self.assertRaises(ValueError):
            query.contact_bins([self.index], "Zika_virusRNA", 0)
        with self.assertRaises(ValueError):
            query.contact_bins([self.index], "Zika_virusRNA", 1)  # full map at 1 nt is too large
        with self.assertRaises(ValueError):
            query.hybrids([self.index], {}, limit=10**6)
        with self.assertRaises(ValueError):
            query.summary([Path(self.tmp.name) / "missing"])
        bogus = Path(self.tmp.name) / "bogus.rnaxrayidx"
        bogus.write_bytes(b"not sqlite")
        with self.assertRaises(ValueError):
            query.summary([bogus])

    def test_index_skips_comments_and_counts_invalid_lines(self):
        hyb = Path(self.tmp.name) / "mixed.hyb"
        good = HYB.read_text().splitlines()[0]
        hyb.write_text("# comment\n\n" + good + "\nbroken\tline\n" + good.replace("\t", "\t", 1) + "\n")
        meta = index.build(hyb, Path(self.tmp.name) / "mixed.rnaxrayidx")
        self.assertEqual((meta["records"], meta["invalid"], meta["skipped"]), (2, 1, 2))


def brute_pair(recs, gene, gene2, bin_size, both=False):
    """Cells of the (gene, gene2) map; ``both`` adds (gene2, gene) rows with swapped arms."""
    cells = {}
    g, g2 = gene.encode(), gene2.encode()
    for r in recs:
        if r.gene1 == g and r.gene2 == g2:
            spans = (r.start1, r.end1, r.start2, r.end2)
        elif both and g != g2 and r.gene1 == g2 and r.gene2 == g:
            spans = (r.start2, r.end2, r.start1, r.end1)
        else:
            continue
        for i in range(spans[0] // bin_size, spans[1] // bin_size + 1):
            for j in range(spans[2] // bin_size, spans[3] // bin_size + 1):
                key = (i * bin_size, j * bin_size)
                cells[key] = cells.get(key, 0) + 1
    return cells


class ProviderGapsTest(unittest.TestCase):
    """extents/lengths, orientation, fixed_bin and compare_bins (DesktopProvider needs)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.index = Path(cls.tmp.name) / "testData.rnaxrayidx"
        index.build(HYB, cls.index)
        cls.records = records()
        # a second "condition": only the first half of the file
        half = Path(cls.tmp.name) / "half.hyb"
        lines = HYB.read_text().splitlines(keepends=True)
        half.write_text("".join(lines[: len(lines) // 2]))
        cls.half = Path(cls.tmp.name) / "half.rnaxrayidx"
        index.build(half, cls.half)
        cls.half_records = [r for r in (hybfile.parse(line.encode()) for line in lines[: len(lines) // 2]) if r is not None]

    @classmethod
    def tearDownClass(cls):
        query.close_all()
        cls.tmp.cleanup()

    def expected_extents(self, recs):
        out = {}
        for r in recs:
            for gene, start, end in ((r.gene1, r.start1, r.end1), (r.gene2, r.start2, r.end2)):
                lo, hi = out.get(gene.decode(), (start, end))
                out[gene.decode()] = (min(lo, start), max(hi, end))
        return {k: {"min": lo, "max": hi} for k, (lo, hi) in out.items()}

    def test_summary_extents_and_reference_lengths(self):
        result = query.summary([self.index, self.half], lengths={"Zika_virusRNA": 10807})
        self.assertEqual(result["merged"]["extents"], self.expected_extents(self.records))
        self.assertEqual(result["indexes"][1]["extents"], self.expected_extents(self.half_records))
        genes = {g["name"]: g for g in result["merged"]["genes"]}
        self.assertEqual((genes["Zika_virusRNA"]["length"], genes["Zika_virusRNA"]["length_source"]), (10807, "reference"))
        self.assertEqual(genes["18S_rRNA"]["length"], genes["18S_rRNA"]["max_end"])
        self.assertEqual(genes["18S_rRNA"]["length_source"], "observed")
        with self.assertRaises(ValueError):
            query.summary([self.index], lengths={"Zika_virusRNA": "long"})

    def test_extents_fall_back_for_indexes_without_min_start(self):
        import shutil
        import sqlite3

        old = Path(self.tmp.name) / "old.rnaxrayidx"
        shutil.copy(self.index, old)
        con = sqlite3.connect(str(old))
        con.execute("ALTER TABLE genes DROP COLUMN min_start")
        con.commit()
        con.close()
        self.assertEqual(query.summary([old])["merged"]["extents"], self.expected_extents(self.records))

    def test_orientation_both_merges_swapped_pairs(self):
        for bin_size in (50, 200):
            oriented = query.contact_bins([self.index], "Zika_virusRNA", bin_size, gene2="18S_rRNA")
            both = query.contact_bins([self.index], "Zika_virusRNA", bin_size, gene2="18S_rRNA", orientation="both")
            self.assertEqual(as_cells(oriented), brute_pair(self.records, "Zika_virusRNA", "18S_rRNA", bin_size))
            self.assertEqual(as_cells(both), brute_pair(self.records, "Zika_virusRNA", "18S_rRNA", bin_size, both=True))
            self.assertEqual(both["orientation"], "both")
        swapped = sum(1 for r in self.records if r.gene1 == b"18S_rRNA" and r.gene2 == b"Zika_virusRNA")
        self.assertGreater(swapped, 0)  # the fixture has both orientations
        self.assertEqual(both["total"], oriented["total"] + swapped)
        # intramolecular maps keep the legacy (unmirrored) rule
        self.assertEqual(query.contact_bins([self.index], "Zika_virusRNA", 100, orientation="both")["count"],
                         query.contact_bins([self.index], "Zika_virusRNA", 100)["count"])
        top = query.top_interactions([self.index], "18S_rRNA", 100, 5, gene2="Zika_virusRNA", orientation="both")
        expected = sorted(brute_pair(self.records, "18S_rRNA", "Zika_virusRNA", 100, both=True).items(),
                          key=lambda kv: (-kv[1], kv[0]))[:5]
        self.assertEqual([(row["x"], row["y"], row["count"]) for row in top["rows"]], [(x, y, c) for (x, y), c in expected])
        with self.assertRaises(ValueError):
            query.contact_bins([self.index], "Zika_virusRNA", 10, orientation="normalised")

    def test_fixed_bin_ignores_max_cells(self):
        fixed = query.contact_bins([self.index], "Zika_virusRNA", 10, max_cells=500, fixed_bin=True)
        self.assertEqual((fixed["bin_size"], fixed["adjusted"], fixed["fixed_bin"]), (10, False, True))
        self.assertGreater(fixed["cells"], 500)
        with self.assertRaises(ValueError):  # the dense-grid guard still applies
            query.contact_bins([self.index], "Zika_virusRNA", 1, max_cells=10, fixed_bin=True)
        self.assertEqual(query.contact_bins([self.index], "Zika_virusRNA", 10, lengths={"Zika_virusRNA": 10807})["length"], 10807)

    def test_compare_bins_normalizes_per_million(self):
        result = query.compare_bins([self.index], [self.half], "Zika_virusRNA", 100)
        full = brute_contact(self.records, "Zika_virusRNA", 100)
        half = brute_contact(self.half_records, "Zika_virusRNA", 100)
        keys = sorted(set(full) | set(half))
        self.assertEqual(list(zip(result["x"], result["y"])), keys)
        self.assertEqual(result["a_count"], [full.get(k, 0) for k in keys])
        self.assertEqual(result["b_count"], [half.get(k, 0) for k in keys])
        lib_a, lib_b = len(self.records), len(self.half_records)
        self.assertEqual((result["library_a"], result["library_b"]), (lib_a, lib_b))
        self.assertAlmostEqual(result["pseudocount"], 1e6 / lib_b)
        import math
        for k, key in enumerate(keys[:200]):
            a = full.get(key, 0) * 1e6 / lib_a
            b = half.get(key, 0) * 1e6 / lib_b
            self.assertAlmostEqual(result["a"][k], a, places=5)
            self.assertAlmostEqual(result["b"][k], b, places=5)
            self.assertAlmostEqual(result["log2ratio"][k], math.log2((b + 1e6 / lib_b) / (a + 1e6 / lib_b)), places=5)
        self.assertEqual(result["normalization"], "per_million_records")
        same = query.compare_bins([self.index, self.index], [self.index], "Zika_virusRNA", 250)
        self.assertEqual(same["a"], same["b"])
        coarse = query.compare_bins([self.index], [self.half], "Zika_virusRNA", 10, max_cells=300)
        self.assertTrue(coarse["adjusted"])
        self.assertLessEqual(coarse["cells"], 300)
        fixed = query.compare_bins([self.index], [self.half], "Zika_virusRNA", 10, max_cells=300, fixed_bin=True)
        self.assertEqual(fixed["bin_size"], 10)
        region = query.compare_bins([self.index], [self.half], "Zika_virusRNA", 50, {"x": [1000, 2999], "y": [4000, 8999]})
        self.assertTrue(all(1000 <= x <= 2999 for x in region["x"]) and all(4000 <= y <= 8999 for y in region["y"]))
        empty = query.compare_bins([self.index], [self.half], "Missing", 50)
        self.assertEqual((empty["cells"], empty["x"]), (0, []))



def brute_viewpoint(recs, gene, lo, hi, width, partner=None, types=None, measure="records"):
    cov = [0.0] * (hi - lo + 1)
    records = reads = arms = 0
    partners = {}
    g = gene.encode()
    for r in recs:
        if types and r.chimera_type.decode() not in types:
            continue
        hit = None
        for own, other, s, e, mate in ((r.gene1, r.gene2, r.start1, r.end1, r.gene2), (r.gene2, r.gene1, r.start2, r.end2, r.gene1)):
            if own != g or (partner and other != partner.encode()) or s > hi or e < lo:
                continue
            arms += 1
            for p in range(max(s, lo), min(e, hi) + 1):
                cov[p - lo] += 1 if measure == "records" else r.reads
            hit = hit or mate.decode()
        if hit:
            records += 1
            reads += r.reads
            entry = partners.setdefault(hit, [0, 0])
            entry[0] += 1
            entry[1] += r.reads
    starts = list(range(lo, hi + 1, width))
    values = [sum(cov[s - lo:min(s + width - 1, hi) - lo + 1]) / (min(s + width - 1, hi) - s + 1) for s in starts]
    return records, reads, arms, starts, values, partners


def brute_region(recs, gene, lo, hi, partner=None, plo=None, phi=None, overlap="any", types=None):
    def ov(s, e, a, b):
        return (s >= a and e <= b) if overlap == "contained" else (s <= b and e >= a)
    g = gene.encode()
    span = hi - lo + 1
    width = 50 if span > 1000 else 25 if span > 500 else 10
    profile = [0] * (-(-span // width))
    hits, partners, groups = [], {}, {}
    for r in recs:
        if types and r.chimera_type.decode() not in types:
            continue
        forward = r.gene1 == g and ov(r.start1, r.end1, lo, hi) and (not partner or r.gene2 == partner.encode())
        reverse = r.gene2 == g and ov(r.start2, r.end2, lo, hi) and (not partner or r.gene1 == partner.encode())
        if plo is not None:
            forward = forward and ov(r.start2, r.end2, plo, phi)
            reverse = reverse and ov(r.start1, r.end1, plo, phi)
        if not (forward or reverse):
            continue
        hits.append(r)
        name = (r.gene2 if forward else r.gene1).decode()
        entry = partners.setdefault(name, [0, 0])
        entry[0] += 1
        entry[1] += r.reads
        for own, s, e in ((r.gene1, r.start1, r.end1), (r.gene2, r.start2, r.end2)):
            if own == g and s <= hi and e >= lo:
                for b in range((max(s, lo) - lo) // width, (min(e, hi) - lo) // width + 1):
                    profile[b] += r.reads
        key = (r.start1, r.end1, r.start2, r.end2, r.chimera_type.decode(), r.gene1.decode(), r.gene2.decode())
        group = groups.setdefault(key, [0, 0])
        group[0] += 1
        group[1] += r.reads
    return hits, partners, profile, groups


class ViewpointRegionTest(unittest.TestCase):
    """analysis_viewpoint / analysis_region against brute force over the records."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.index = Path(cls.tmp.name) / "testData.rnaxrayidx"
        index.build(HYB, cls.index)
        cls.records = records()
        half = Path(cls.tmp.name) / "half.hyb"
        lines = HYB.read_text().splitlines(keepends=True)
        half.write_text("".join(lines[: len(lines) // 2]))
        cls.half = Path(cls.tmp.name) / "half.rnaxrayidx"
        index.build(half, cls.half)
        cls.half_records = [r for r in (hybfile.parse(line.encode()) for line in lines[: len(lines) // 2]) if r is not None]

    @classmethod
    def tearDownClass(cls):
        query.close_all()
        cls.tmp.cleanup()

    def check_viewpoint(self, result, expected):
        records, reads, arms, starts, values, partners = expected
        self.assertEqual((result["records"], result["reads"], result["arms"]), (records, reads, arms))
        self.assertEqual(result["bins"]["start"], starts)
        for got, want in zip(result["bins"]["value"], values):
            self.assertAlmostEqual(got, want, places=3)
        self.assertEqual({p["name"]: [p["records"], p["reads"]] for p in result["partners"]}, partners)

    def test_viewpoint_matches_legacy_plot_viewpoint(self):
        # golden/testData_Zika_virusRNA.gplot: the legacy rnaxray step 2
        # (`plot_viewpoint -a Zika_virusRNA`: rnaxrayblast.awk + blast2gplot.pl)
        # on testData.hyb, from TomHarcus's python-migration branch
        # (fixtures/legacy_run/direct_viewpoint). It counts, per nucleotide,
        # the arms of the hybrids with both arms on the gene.
        lines = (GOLDEN / "testData_Zika_virusRNA.gplot").read_text().splitlines()
        self.assertEqual(lines[0], "#test_Zika_virusRNA_10807")
        legacy = [int(line.split("\t")[1]) for line in lines[1:]]
        result = query.viewpoint([self.index], "Zika_virusRNA", 1, 10807, partner="Zika_virusRNA")
        self.assertEqual(result["bins"]["start"], list(range(1, 10808)))
        self.assertEqual(result["bins"]["value"], legacy)

    def test_viewpoint_matches_brute_force(self):
        recs = self.records
        result = query.viewpoint([self.index], "Zika_virusRNA", 2000, 2600)
        self.check_viewpoint(result, brute_viewpoint(recs, "Zika_virusRNA", 2000, 2600, 1))
        self.assertEqual((result["start"], result["end"], result["bin_size"], result["adjusted"]), (2000, 2600, 1, False))
        result = query.viewpoint([self.index], "Zika_virusRNA", 100, 9000, bin_size=25, measure="reads", types=["Type_1"])
        self.check_viewpoint(result, brute_viewpoint(recs, "Zika_virusRNA", 100, 9000, 25, types=["Type_1"], measure="reads"))
        result = query.viewpoint([self.index], "18S_rRNA", 1, 1900, bin_size=10, partner="Zika_virusRNA")
        self.check_viewpoint(result, brute_viewpoint(recs, "18S_rRNA", 1, 1900, 10, partner="Zika_virusRNA"))
        merged = query.viewpoint([self.index, self.half], "Zika_virusRNA", 3000, 3400, bin_size=5)
        self.check_viewpoint(merged, brute_viewpoint(recs + self.half_records, "Zika_virusRNA", 3000, 3400, 5))
        # defaults: observed start to the reference length; the bin grows past 30,000 bins
        whole = query.viewpoint([self.index], "Zika_virusRNA", lengths={"Zika_virusRNA": 10807})
        self.assertEqual((whole["start"], whole["end"]), (min(min(r.start1 for r in recs if r.gene1 == b"Zika_virusRNA"),
                                                              min(r.start2 for r in recs if r.gene2 == b"Zika_virusRNA")), 10807))
        wide = query.viewpoint([self.index], "Zika_virusRNA", 1, 90_000)
        self.assertTrue(wide["adjusted"])
        self.assertEqual(wide["bin_size"], 3)
        self.assertEqual(query.viewpoint([self.index], "Missing")["bins"]["value"], [])
        for bad in ({"measure": "x"}, {"bin_size": 0}, {"start": 10, "end": 5}, {"start": 1.5}):
            with self.assertRaises(ValueError, msg=bad):
                query.viewpoint([self.index], "Zika_virusRNA", **bad)

    def check_region(self, result, recs, *args, **kwargs):
        hits, partners, profile, groups = brute_region(recs, *args, **kwargs)
        self.assertEqual(result["records"], len(hits))
        self.assertEqual(result["reads"], sum(r.reads for r in hits))
        self.assertEqual({p["name"]: [p["records"], p["reads"]] for p in result["partners"]}, partners)
        self.assertEqual(result["profile"]["value"], profile)
        # the strongest distinct interactions (ties at the cut may pick any of the tied rows)
        ranked = sorted(groups.values(), key=lambda v: (-v[1], -v[0]))
        got = [((r["start1"], r["end1"], r["start2"], r["end2"], r["type"], r["gene1"], r["gene2"]), [r["records"], r["reads"]])
               for r in result["rows"]]
        self.assertEqual([v for _, v in got], ranked[:len(got)])
        self.assertEqual(len({k for k, _ in got}), len(got))
        for key, value in got:
            self.assertEqual(groups[key], value, key)
        return groups

    def test_region_matches_brute_force(self):
        recs = self.records
        result = query.region([self.index], "Zika_virusRNA", 3000, 3200, limit=20)
        groups = self.check_region(result, recs, "Zika_virusRNA", 3000, 3200)
        self.assertEqual(result["distinct"], len(groups))
        self.assertEqual(len(result["rows"]), 20)
        self.assertTrue(result["rows_exact"])
        result = query.region([self.index], "Zika_virusRNA", 2000, 4000, partner="Zika_virusRNA", partner_start=5000,
                              partner_end=9000, overlap="contained", types=["Type_1", "Type_2"], limit=50)
        self.check_region(result, recs, "Zika_virusRNA", 2000, 4000, "Zika_virusRNA", 5000, 9000, "contained", ["Type_1", "Type_2"])
        result = query.region([self.index], "18S_rRNA", 1, 1900, partner="Zika_virusRNA")
        self.check_region(result, recs, "18S_rRNA", 1, 1900, "Zika_virusRNA")
        self.assertEqual(result["profile"]["bin_size"], 50)
        merged = query.region([self.index, self.half], "Zika_virusRNA", 1, 10807, limit=30)
        self.check_region(merged, recs + self.half_records, "Zika_virusRNA", 1, 10807)
        self.assertIsNone(merged["distinct"])
        self.assertEqual(query.region([self.index], "Missing", 1, 100)["records"], 0)
        for bad in ({"start": 5, "end": 1}, {"start": 1, "end": 5, "partner_start": 1}, {"start": 1, "end": 5, "partner_start": 1, "partner_end": 9},
                    {"start": 1, "end": 5, "overlap": "x"}, {"start": None, "end": 5}, {"start": 1, "end": 5, "limit": 10**6}):
            with self.assertRaises(ValueError, msg=bad):
                query.region([self.index], "Zika_virusRNA", **bad)

if __name__ == "__main__":
    unittest.main()

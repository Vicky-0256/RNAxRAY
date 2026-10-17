import json
import tempfile
import unittest
from pathlib import Path

from desktop.runtime.annotation import detect_format, parse_annotation, track_features
from desktop.runtime.bridge import handle
from desktop.runtime.project import load_manifest, new_project, validate_project_directory

GENE = "ZIKV_TEST_virusRNA"

GENBANK = """LOCUS       NC_000001              60 bp    RNA     linear   VRL 01-JAN-2020
VERSION     NC_000001.1
FEATURES             Location/Qualifiers
     source          1..60
                     /organism="Test virus"
     5'UTR           1..9
     CDS             10..51
                     /gene="POLY"
                     /product="polyprotein"
     mat_peptide     10..30
                     /gene="POLY"
                     /product="anchored capsid protein C"
     mat_peptide     10..25
                     /gene="POLY"
                     /product="capsid protein C"
     mat_peptide     31..51
                     /gene="POLY"
                     /product="membrane glycoprotein precursor M"
     3'UTR           52..60
ORIGIN
        1 acgtacgtac gtacgtacgt acgtacgtac gtacgtacgt acgtacgtac gtacgtacgt
//
"""

GFF = """##gff-version 3
seqA\tRefSeq\tgene\t5\t20\t.\t+\t.\tID=g1;Name=alpha
seqA\tRefSeq\tCDS\t5\t20\t.\t+\t0\tID=c1;product=alpha protein
seqB\tRefSeq\tgene\t30\t40\t.\t-\t.\tID=g2;Name=beta
"""


class ParseTests(unittest.TestCase):
    def _write(self, text, name):
        path = Path(self.tmp.name) / name
        path.write_text(text)
        return path

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_genbank_track_keeps_outer_mature_peptides_and_utrs(self):
        fmt, features, sequences = parse_annotation(self._write(GENBANK, "a.gb"))
        self.assertEqual(fmt, "genbank")
        self.assertEqual(len(sequences["NC_000001.1"]), 60)
        self.assertTrue(set(sequences["NC_000001.1"]) <= set("ACGU"))
        track, seqid = track_features(features, GENE)  # one-sequence file: applies to any gene
        self.assertEqual(seqid, "NC_000001.1")
        self.assertEqual([(f["name"], f["start"], f["end"]) for f in track],
                         [("5'UTR", 1, 9), ("C", 10, 30), ("prM", 31, 51), ("3'UTR", 52, 60)])

    def test_gff_picks_the_gene_sequence_and_genes(self):
        fmt, features, _ = parse_annotation(self._write(GFF, "a.gff3"))
        self.assertEqual(fmt, "gff")
        track, seqid = track_features(features, "seqA")
        self.assertEqual(seqid, "seqA")
        self.assertEqual([(f["name"], f["type"]) for f in track], [("alpha", "gene")])
        self.assertEqual(track_features(features, "other")[0], [])  # two sequences, none named "other"

    def test_genbank_remote_parts_and_last_qualifier(self):
        text = ("LOCUS       X 100 bp RNA\nFEATURES             Location/Qualifiers\n"
                "     CDS             join(AB012345.1:1..20,30..60)\n                     /gene=\"g\"\n"
                "     CDS             complement(<5..>40)\n                     /gene=\"h\"\n\n"
                "ORIGIN\n        1 acgt\n//\n")
        _, features, _ = parse_annotation(self._write(text, "g.gb"))
        self.assertEqual([(f["name"], f["start"], f["end"]) for f in features], [("g", 30, 60), ("h", 5, 40)])

    def test_tsv_and_bed(self):
        fmt, features, _ = parse_annotation(self._write("gene\tstart\tend\nC\t107\t472\nprM\t473\t976\n", "genes.tsv"))
        self.assertEqual(fmt, "tsv")
        self.assertEqual([(f["name"], f["start"], f["end"]) for f in track_features(features, GENE)[0]],
                         [("C", 107, 472), ("prM", 473, 976)])
        fmt, features, _ = parse_annotation(self._write("chr1\t0\t10\tfirst\nchr1\t10\t20\tsecond\n", "a.bed"))
        self.assertEqual(fmt, "bed")
        self.assertEqual([(f["start"], f["end"]) for f in features], [(1, 10), (11, 20)])
        self.assertEqual(detect_format("seq\tsrc\tgene\t1\t9\t.\t+\t.\tID=x"), "gff")

    def test_rejects_a_file_without_features(self):
        with self.assertRaisesRegex(ValueError, "no features"):
            parse_annotation(self._write("just text\n", "x.txt"))


class BridgeTests(unittest.TestCase):
    def setUp(self):
        from desktop.runtime.samples import add_reference

        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.project = base / "p.rnaxrayproj"
        new_project(self.project, "Annotation")
        ref = base / "ref.fa"
        ref.write_text(f">{GENE}\n" + "ACGU" * 15 + "\n")
        self.reference = add_reference(self.project, ref, mode="linked")["reference"]["id"]
        self.genbank = base / "virus.gb"
        self.genbank.write_text(GENBANK)

    def tearDown(self):
        self.tmp.cleanup()

    def test_attach_read_replace_and_remove(self):
        out = handle({"operation": "set_reference_annotation", "path": str(self.project),
                      "reference_id": self.reference, "source": str(self.genbank)})
        self.assertEqual(out["reference"]["annotation"]["format"], "genbank")
        self.assertEqual(out["reference"]["annotation"]["path"], f"annotations/{self.reference}.gb")
        self.assertTrue((self.project / "annotations" / f"{self.reference}.gb").is_file())
        self.assertEqual(validate_project_directory(self.project), [])

        read = handle({"operation": "read_annotation", "path": str(self.project), "reference_id": self.reference, "gene": GENE})
        self.assertEqual([f["name"] for f in read["features"]], ["5'UTR", "C", "prM", "3'UTR"])
        self.assertEqual(len(read["sequence"]), 60)

        tsv = Path(self.tmp.name) / "genes.tsv"
        tsv.write_text("name\tstart\tend\nA\t1\t30\nB\t31\t60\n")
        handle({"operation": "set_reference_annotation", "path": str(self.project), "reference_id": self.reference, "source": str(tsv)})
        self.assertFalse((self.project / "annotations" / f"{self.reference}.gb").exists(), "the replaced file is removed")
        read = handle({"operation": "read_annotation", "path": str(self.project), "reference_id": self.reference, "gene": GENE})
        self.assertEqual([f["name"] for f in read["features"]], ["A", "B"])
        self.assertIsNone(read["sequence"])

        handle({"operation": "set_reference_annotation", "path": str(self.project), "reference_id": self.reference})
        manifest = load_manifest(self.project)
        self.assertNotIn("annotation", manifest["references"][0])
        read = handle({"operation": "read_annotation", "path": str(self.project), "reference_id": self.reference, "gene": GENE})
        self.assertIsNone(read["annotation"])
        self.assertEqual(read["features"], [])

    def test_rejects_bad_requests(self):
        with self.assertRaisesRegex(ValueError, "absolute path"):
            handle({"operation": "set_reference_annotation", "path": str(self.project), "reference_id": self.reference,
                    "source": "relative.gb"})
        with self.assertRaisesRegex(ValueError, "does not exist"):
            handle({"operation": "set_reference_annotation", "path": str(self.project), "reference_id": "nope",
                    "source": str(self.genbank)})


if __name__ == "__main__":
    unittest.main()

"""Project schema 2.0: migration, references/samples, sample sheets, checks (contract R2)."""
import gzip
import hashlib
import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from desktop.runtime import samples
from desktop.runtime.bridge import handle
from desktop.runtime.project import import_input, load_manifest, new_project, validate_manifest, validate_project_directory

ROOT = Path(__file__).resolve().parents[3]
# The real map lives beside the checkout (outside git); fall back to an embedded copy.
ZIKV_MAP = next((p / "ZIKV_dataset_map.tsv" for p in ROOT.parents if (p / "ZIKV_dataset_map.tsv").is_file()), ROOT / "missing.tsv")
ZIKV_MAP_TEXT = (
    "dataset\tcondition\tstrain\tcell_type\tmethod\treference\treplicates\tfiles\n"
    "ZAFR_virion\tvirion\tAFR\tvirion\tSPLASH\tzika_files/ZAFR.fasta\t2\tzika_files/ZAFR_REP1.fastq.gz;zika_files/ZAFR_REP2.fastq.gz\n"
    "ZBRA_virion\tvirion\tBRA\tvirion\tSPLASH\tzika_files/ZBRA.fasta\t2\tzika_files/ZBRA_REP1.fastq.gz;zika_files/ZBRA_REP2.fastq.gz\n"
    "ZILM_virion\tvirion\tILM\tvirion\tSPLASH\tzika_files/ZILM.fasta\t2\tzika_files/ZILM_REP2.fastq.gz;zika_files/ZILM_REP3.fastq.gz\n"
    "ZSIN_virion\tvirion\tSIN\tvirion\tSPLASH\tzika_files/ZSIN.fasta\t3\tzika_files/ZSIN_REP1.fastq.gz;zika_files/ZSIN_REP2.fastq.gz;zika_files/ZSIN_REP3.fastq.gz\n"
    "Livefire_human\tin_vivo\tBRA\thuman\tCOMRADES\tzika_files/Zika.fasta\tunknown\tzika_files/Livefire1_comp.fasta.gz;zika_files/Livefire1_hybrids.fasta.gz;zika_files/Livefire2_comp.fasta.gz;zika_files/Livefire3_comp.fasta.gz\n"
    "Aag_insect\tin_vivo\tBRA\tinsect/Aedes aegypti\tCOMRADES\tzika_files/Zika.fasta\t2\tzika_files/Aag-1.assembled.collapse.fasta.gz;zika_files/Aag-2.assembled.collapse.fasta.gz\n"
)
REFERENCE_NAMES = {"ZAFR": "ZIKV_African_KX377335-1_virusRNA", "ZBRA": "ZIKV_Brazilian_MF073357-1_virusRNA",
                   "ZILM": "ZIKV_FrenchPolynesian_KJ776791-2_virusRNA", "ZSIN": "ZIKV_Singaporean_KY241713-1_virusRNA",
                   "Zika": "ZIKV-PE243-2015_virusRNA"}


def _write_gz(path: Path, text: str) -> None:
    # mtime=0: rewriting the same text must give the same bytes (the gzip
    # header otherwise embeds the current second, which made dedup flaky).
    path.write_bytes(gzip.compress(text.encode("utf-8"), mtime=0))


def _make_zikv_layout(directory: Path) -> Path:
    """A copy of ZIKV_dataset_map.tsv next to tiny fake zika_files/."""
    sheet = directory / "ZIKV_dataset_map.tsv"
    if ZIKV_MAP.is_file():
        shutil.copyfile(ZIKV_MAP, sheet)
    else:
        sheet.write_text(ZIKV_MAP_TEXT, encoding="utf-8")
    files = directory / "zika_files"
    files.mkdir()
    for stem, name in REFERENCE_NAMES.items():
        (files / (stem + ".fasta")).write_text(">%s\nACGU\nACGUAC\n" % name, encoding="utf-8")
    for line in sheet.read_text(encoding="utf-8").splitlines()[1:]:
        for item in line.split("\t")[-1].split(";"):
            target = directory / item
            if item.endswith(".fastq.gz"):
                _write_gz(target, "@r1\nACGT\n+\nIIII\n@%s\nACGTA\n+\nIIIII\n" % target.name)
            else:
                _write_gz(target, ">1_10\nACGTACGT\n>%s\nACG\n" % target.name)
    return sheet


class ProjectTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.project = self.dir / "p.rnaxrayproj"
        new_project(self.project, "Samples")
        self.data = self.dir / "data"
        self.data.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, operation, **request):
        request.setdefault("path", str(self.project))
        return handle({"operation": operation, **request}, repo_root=ROOT)

    def manifest(self):
        return json.loads((self.project / "project.json").read_text(encoding="utf-8"))

    def reference(self, name="ref.fasta", header="Gene_A"):
        path = self.data / name
        path.write_text(">%s description\nACGUACGU\nAC\n" % header, encoding="utf-8")
        return path

    def reads(self, name="s1.fastq.gz", body="@r\nACGT\n+\nIIII\n"):
        path = self.data / name
        if name.endswith(".gz"):
            _write_gz(path, body)
        else:
            path.write_text(body, encoding="utf-8")
        return path


class MigrationTests(ProjectTestCase):
    def downgrade(self):
        manifest = self.manifest()
        manifest["schema_version"] = "1.0"
        del manifest["references"], manifest["samples"]
        (self.project / "project.json").write_text(json.dumps(manifest), encoding="utf-8")

    def test_new_projects_are_schema_2(self):
        manifest = self.manifest()
        self.assertEqual(manifest["schema_version"], "2.0")
        self.assertEqual((manifest["references"], manifest["samples"]), ([], []))
        self.assertEqual(validate_manifest(manifest), [])

    def test_open_migrates_1_0_in_memory_and_keeps_inputs(self):
        item = import_input(self.project, self.reads("legacy.sam", "@HD\tVN:1.0\n"), role="sam")
        self.downgrade()
        response = self.call("open_project", check_files=True)
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["manifest"]["schema_version"], "2.0")
        self.assertEqual(response["manifest"]["inputs"][0]["id"], item["id"])
        self.assertEqual(self.manifest()["schema_version"], "1.0", "opening must not rewrite the file")
        self.call("update_ui_state", ui_state={"desktop": {"route": "data"}})
        saved = self.manifest()
        self.assertEqual(saved["schema_version"], "2.0")
        self.assertEqual(saved["inputs"][0]["id"], item["id"])
        self.assertEqual(saved["samples"], [])

    def test_1_0_project_can_take_a_sample_immediately(self):
        self.downgrade()
        response = self.call("add_sample", source=str(self.reads()), reference=str(self.reference()))
        self.assertTrue(response["ok"], response)
        self.assertEqual(self.manifest()["schema_version"], "2.0")

    def test_spec_example_project_still_validates(self):
        self.assertEqual(validate_project_directory(ROOT / "desktop/spec/example.rnaxrayproj"), [])

    def test_newer_major_version_is_rejected(self):
        manifest = self.manifest()
        manifest["schema_version"] = "3.0"
        self.assertTrue(any("newer" in error for error in validate_manifest(manifest)))

    def test_sample_records_are_validated(self):
        self.call("add_sample", source=str(self.reads()), reference=str(self.reference()))
        manifest = self.manifest()
        sample = manifest["samples"][0]
        sample["reads"]["path"] = "relative/but/linked.fastq"
        sample["reference_id"] = "nope"
        sample["outputs"]["hyb"] = "../escape.hyb"
        sample["stages"]["map"]["status"] = "bogus"
        errors = validate_manifest(manifest)
        for fragment in ("linked file must be absolute", "reference_id", "outputs.hyb", "stages.map.status"):
            self.assertTrue(any(fragment in error for error in errors), (fragment, errors))


class FileRecordTests(ProjectTestCase):
    def test_quick_hash_definition(self):
        small = self.data / "small.bin"; small.write_bytes(b"abc")
        self.assertEqual(samples.quick_hash(small), hashlib.sha256(b"3\nabcabc").hexdigest())
        big = self.data / "big.bin"
        payload = os.urandom(3 * samples.MiB + 17)
        big.write_bytes(payload)
        expected = hashlib.sha256(b"%d\n" % len(payload) + payload[: samples.MiB] + payload[-samples.MiB:]).hexdigest()
        self.assertEqual(samples.quick_hash(big), expected)

    def test_format_detection_includes_gz(self):
        cases = {"a.fastq.gz": "fastq.gz", "a.FQ.GZ": "fastq.gz", "a.fasta.gz": "fasta.gz", "a.fa.gz": "fasta.gz",
                 "a.fastq": "fastq", "a.fq": "fastq", "a.fa": "fasta", "a.sam": "sam", "a.hyb": "hyb"}
        for name, fmt in cases.items():
            self.assertEqual(samples.detect_read_format(Path(name)), fmt, name)
        with self.assertRaises(ValueError):
            samples.detect_read_format(Path("a.bam"))
        self.assertEqual(samples.read_stem(Path("Aag-1.assembled.collapse.fasta.gz")), "Aag-1.assembled.collapse")

    def test_import_input_detects_gz_and_leaves_no_temp_files(self):
        item = import_input(self.project, self.reads("x.fastq.gz"), role="fastq")
        self.assertEqual(item["format"], "fastq.gz")
        self.assertEqual(item["sha256"], hashlib.sha256((self.project / item["path"]).read_bytes()).hexdigest())
        again = import_input(self.project, self.reads("x.fastq.gz"), role="fastq")
        self.assertEqual(again["id"], item["id"])
        self.assertEqual(sorted(p.name for p in (self.project / "inputs").iterdir()), ["x.fastq.gz"])

    def test_reference_sequences_and_dedup(self):
        fasta = self.data / "multi.fa.gz"
        _write_gz(fasta, ">one desc\nACGU\nAC\n>two\nACGUACGUAC\n")
        first = self.call("add_reference", source=str(fasta), label="Multi")
        self.assertTrue(first["ok"], first)
        self.assertFalse(first["existing"])
        self.assertEqual(first["reference"]["sequences"], [{"name": "one", "length": 6}, {"name": "two", "length": 10}])
        self.assertEqual(first["reference"]["mode"], "linked")
        self.assertEqual(first["reference"]["path"], str(fasta.resolve()))
        second = self.call("add_reference", source=str(fasta))
        self.assertTrue(second["existing"])
        self.assertEqual(len(self.manifest()["references"]), 1)

    def test_rnaxray_formatted_reference_names_match_pipeline(self):
        fasta = self.data / "pipe.fa"
        fasta.write_text(">ENSG1_ENST1|Gene_a|protein_coding\nACGU\n>ENSG2|x|pseudogene\nAC\n", encoding="utf-8")
        names = [s["name"] for s in samples.read_fasta_sequences(fasta)]
        self.assertEqual(names, ["ENSG1-ENST1_Gene-a_mRNA"])
        import sys
        sys.path.insert(0, str(ROOT / "pipeline"))
        try:
            from rnaxraypipe import inputs
        finally:
            sys.path.remove(str(ROOT / "pipeline"))
        formatted = [line[1:] for line in inputs.format_reference(inputs.iter_lines(fasta)) if line.startswith(">")]
        self.assertEqual(names, formatted)

    def test_linked_sample_ok_touched_changed_missing(self):
        reads = self.reads("s1.fastq")
        response = self.call("add_sample", source=str(reads), reference=str(self.reference()), condition="A", replicate=1)
        self.assertTrue(response["ok"], response)
        sample = response["sample"]
        self.assertEqual(sample["reads"]["mode"], "linked")
        self.assertEqual(sample["reads"]["path"], str(reads.resolve()))
        self.assertIsNone(sample["reads"]["sha256"])
        self.assertEqual(sample["gene_id"], "Gene_A")
        self.assertEqual(sample["stages"]["map"]["status"], "pending")
        status = lambda: {i["id"]: i["status"] for i in self.call("check_inputs")["items"]}
        self.assertEqual(status()[sample["id"]], "ok")
        later = time.time() + 5
        os.utime(reads, (later, later))
        self.assertEqual(status()[sample["id"]], "ok", "touch alone keeps the fingerprint")
        reads.write_text("@r\nACGA\n+\nIIII\n", encoding="utf-8")  # same size, new content
        os.utime(reads, (later + 5, later + 5))
        self.assertEqual(status()[sample["id"]], "changed")
        reads.unlink()
        result = self.call("check_inputs")
        self.assertEqual(status()[sample["id"]], "missing")
        self.assertEqual(result["summary"]["missing"], 1)
        self.assertFalse(result["all_ok"])
        # A missing linked file must never block opening the project.
        self.assertTrue(self.call("open_project", check_files=True)["ok"])
        moved = self.reads("moved.fastq")
        relinked = self.call("update_sample", sample_id=sample["id"], changes={"reads_path": str(moved)})
        self.assertEqual(relinked["sample"]["reads"]["path"], str(moved.resolve()))
        self.assertEqual(status()[sample["id"]], "ok")

    def test_copied_sample_is_relative_and_hashed(self):
        reads = self.reads("c.fasta.gz", ">1_5\nACGT\n")
        response = self.call("add_sample", source=str(reads), reference=str(self.reference()), mode="copied")
        record = response["sample"]["reads"]
        self.assertEqual(record["mode"], "copied")
        self.assertEqual(record["format"], "fasta.gz")
        self.assertTrue(record["path"].startswith("inputs/"), record)
        self.assertEqual(record["sha256"], hashlib.sha256(reads.read_bytes()).hexdigest())
        self.assertEqual(validate_project_directory(self.project, check_files=True), [])
        self.assertFalse([p for p in (self.project / "inputs").iterdir() if p.name.startswith(".")])

    def test_hash_inputs_task_writes_progress_and_result(self):
        reads = self.reads("h.fastq")
        sample = self.call("add_sample", source=str(reads), reference=str(self.reference()))["sample"]
        run_dir = self.project / "runs" / "hash-1"
        run_dir.mkdir()
        result = self.call("hash_inputs", task_id="hash-1", run_dir=str(run_dir))
        self.assertTrue(result["ok"], result)
        hashed = {item["id"]: item["sha256"] for item in result["hashed"]}
        self.assertEqual(hashed[sample["id"]], hashlib.sha256(reads.read_bytes()).hexdigest())
        stored = self.manifest()["samples"][0]["reads"]["sha256"]
        self.assertEqual(stored, hashed[sample["id"]])
        self.assertEqual(json.loads((run_dir / "progress.json").read_text())["stage"], "done")
        self.assertTrue(json.loads((run_dir / "result.json").read_text())["ok"])
        self.assertEqual(self.call("hash_inputs")["hashed"], [], "already hashed files are skipped")

    def test_update_and_remove_sample(self):
        sample = self.call("add_sample", source=str(self.reads()), reference=str(self.reference()))["sample"]
        updated = self.call("update_sample", sample_id=sample["id"], changes={"condition": "B", "replicate": 2, "settings": {"threads": 4}})
        self.assertEqual((updated["sample"]["condition"], updated["sample"]["replicate"]), ("B", 2))
        with self.assertRaises(ValueError):
            self.call("update_sample", sample_id=sample["id"], changes={"replicate": 0})
        with self.assertRaises(ValueError):
            self.call("update_sample", sample_id=sample["id"], changes={"reads": {}})
        out = self.project / "samples" / sample["id"]
        out.mkdir(parents=True)
        (out / "x.hyb").write_text("x")
        removed = self.call("remove_sample", sample_id=sample["id"], delete_outputs=True)
        self.assertTrue(removed["outputs_deleted"])
        self.assertFalse(out.exists())
        self.assertEqual(self.manifest()["samples"], [])
        self.assertTrue(self.reads().is_file(), "raw data is never deleted")

    def test_disk_estimate(self):
        gz = self.reads("big.fastq.gz", "@r\n" + "A" * 1000 + "\n+\n" + "I" * 1000 + "\n")
        plain = self.reads("plain.fastq", "@r\nACGT\n+\nIIII\n")
        a = self.call("add_sample", source=str(gz), reference=str(self.reference()))["sample"]
        b = self.call("add_sample", source=str(plain), reference=str(self.reference()))["sample"]
        result = self.call("disk_estimate", sample_ids=[a["id"], b["id"]])
        rows = {row["id"]: row for row in result["samples"]}
        self.assertEqual(rows[a["id"]]["uncompressed_bytes"], int(gz.stat().st_size * samples.GZ_EXPANSION))
        self.assertEqual(rows[b["id"]]["temp_bytes"], int(plain.stat().st_size * 1.2))
        self.assertEqual(result["totals"]["temp_peak_bytes"], max(r["temp_bytes"] for r in rows.values()))
        both = self.call("disk_estimate", sample_ids=[a["id"], b["id"]], concurrency=2)
        self.assertEqual(both["totals"]["temp_peak_bytes"], sum(r["temp_bytes"] for r in rows.values()))
        self.assertTrue(result["fits"])
        self.assertGreater(result["volumes"][0]["free_bytes"], 0)
        with self.assertRaises(ValueError):
            self.call("disk_estimate", sample_ids=["missing"])


class SampleSheetTests(ProjectTestCase):
    def test_zikv_dataset_map(self):
        sheet = _make_zikv_layout(self.dir)
        response = self.call("import_sample_sheet", sheet=str(sheet))
        self.assertTrue(response["ok"], response)
        added = response["samples"]
        self.assertEqual(len(added), 15)
        self.assertEqual(len(response["references_added"]), 5)
        manifest = self.manifest()
        self.assertEqual(validate_manifest(manifest), [])
        refs = {r["id"]: r for r in manifest["references"]}
        by_name = {s["name"]: s for s in manifest["samples"]}
        zafr = by_name["ZAFR_REP1"]
        self.assertEqual((zafr["condition"], zafr["replicate"], zafr["reads"]["format"]), ("ZAFR_virion", 1, "fastq.gz"))
        self.assertEqual(zafr["gene_id"], REFERENCE_NAMES["ZAFR"])
        self.assertEqual(refs[zafr["reference_id"]]["sequences"], [{"name": REFERENCE_NAMES["ZAFR"], "length": 10}])
        self.assertEqual(zafr["metadata"]["strain"], "AFR")
        self.assertEqual(zafr["reads"]["path"], str((self.dir / "zika_files/ZAFR_REP1.fastq.gz").resolve()))
        self.assertEqual([by_name["ZSIN_REP%d" % i]["replicate"] for i in (1, 2, 3)], [1, 2, 3])
        self.assertEqual(by_name["ZILM_REP3"]["replicate"], 2, "replicate is the position in the files cell")
        livefire = [s for s in manifest["samples"] if s["condition"] == "Livefire_human"]
        self.assertEqual([s["replicate"] for s in livefire], [1, 2, 3, 4])
        self.assertEqual(livefire[1]["reads"]["format"], "fasta.gz")
        # Zika.fasta is shared by two datasets but registered once.
        zika_users = {s["reference_id"] for s in manifest["samples"] if s["condition"] in ("Livefire_human", "Aag_insect")}
        self.assertEqual(len(zika_users), 1)
        self.assertEqual(by_name["Aag-1.assembled.collapse"]["gene_id"], REFERENCE_NAMES["Zika"])
        # Re-importing is idempotent.
        again = self.call("import_sample_sheet", sheet=str(sheet))
        self.assertEqual((len(again["samples"]), len(again["skipped"]), len(again["references_reused"])), (0, 15, 5))
        self.assertEqual(len(self.manifest()["samples"]), 15)

    def test_base_dir_condition_column_and_dry_run(self):
        sheet = _make_zikv_layout(self.dir)
        moved = self.dir / "sheets"; moved.mkdir()
        shutil.move(str(sheet), moved / "map.tsv")
        failed = self.call("import_sample_sheet", sheet=str(moved / "map.tsv"))
        self.assertFalse(failed["ok"])
        self.assertTrue(any("file not found" in error for error in failed["errors"]))
        self.assertEqual(self.manifest()["samples"], [], "a failing sheet writes nothing")
        dry = self.call("import_sample_sheet", sheet=str(moved / "map.tsv"), base_dir=str(self.dir), dry_run=True, condition_column="strain")
        self.assertTrue(dry["dry_run"])
        self.assertEqual(len(dry["samples"]), 15)
        self.assertEqual(dry["samples"][0]["condition"], "AFR")
        self.assertEqual(self.manifest()["samples"], [])

    def test_csv_with_explicit_columns(self):
        reads = self.reads("a.fastq")
        ref = self.reference("multi.fa", "G1")
        with ref.open("a") as handle:
            handle.write(">G2\nACGU\n")
        sheet = self.data / "s.csv"
        sheet.write_text("name,condition,replicate,reference,gene_id,file\nMine,ctrl,3,multi.fa,G2,a.fastq\n", encoding="utf-8")
        response = self.call("import_sample_sheet", sheet=str(sheet))
        self.assertTrue(response["ok"], response)
        sample = response["samples"][0]
        self.assertEqual((sample["name"], sample["condition"], sample["replicate"], sample["gene_id"]), ("Mine", "ctrl", 3, "G2"))
        self.assertEqual(sample["reads"]["path"], str(reads.resolve()))
        no_gene = self.data / "t.csv"
        self.reads("b.fastq", "@x\nAC\n+\nII\n")
        no_gene.write_text("name,condition,reference,file\nOther,ctrl,multi.fa,b.fastq\n", encoding="utf-8")
        sample = self.call("import_sample_sheet", sheet=str(no_gene))["samples"][0]
        self.assertIsNone(sample["gene_id"], "multi-sequence references have no default gene")


class DataFolderTests(ProjectTestCase):
    def zikv_folder(self):
        files = self.dir / "zika_files"
        files.mkdir()
        for stem in ("ZAFR", "ZSIN", "Zika"):
            (files / (stem + ".fasta")).write_text(">%s\n%s\n" % (REFERENCE_NAMES[stem], "ACGU" * 200), encoding="utf-8")
        fastq = "".join("@r%d\nACGTACGT\n+\nIIIIIIII\n" % i for i in range(5))
        for stem in ("ZAFR_REP1", "ZAFR_REP2", "ZSIN_REP1", "ZSIN_REP2", "ZSIN_REP3"):
            _write_gz(files / (stem + ".fastq.gz"), "@%s\n" % stem + fastq[fastq.index("\n") + 1:])
        (files / "ZSIN_REP1.fastq").write_text(fastq, encoding="utf-8")  # plain copy of the .gz
        for name in ("Livefire1_comp", "Livefire2_comp", "Aag-1.assembled.collapse"):
            _write_gz(files / (name + ".fasta.gz"), ">%s\nACGT\n" % name + "".join(">%d_10\nACGTACGTAC\n" % i for i in range(80)))
        _write_gz(files / "Livefire1_hybrids.fasta.gz", "1_9\tACGT\n")  # not FASTA
        for suffix in (".1.bt2", ".rev.1.bt2"):
            (files / ("ZSIN" + suffix)).write_bytes(b"x")
        (files / "ZSIN.tab").write_text("x\tACGU\n", encoding="utf-8")
        (files / ".DS_Store").write_bytes(b"x")
        inner = files / "old.rnaxrayproj"
        inner.mkdir()
        (inner / "x.fastq").write_text(fastq, encoding="utf-8")
        return files

    def test_scan_matches_names_references_and_skips_the_rest(self):
        files = self.zikv_folder()
        result = self.call("scan_data_folder", folder=str(files))
        self.assertTrue(result["ok"], result)
        rows = {Path(s["path"]).name: s for s in result["samples"]}
        self.assertEqual(sorted(rows), sorted(["Aag-1.assembled.collapse.fasta.gz", "Livefire1_comp.fasta.gz", "Livefire2_comp.fasta.gz",
                                              "ZAFR_REP1.fastq.gz", "ZAFR_REP2.fastq.gz", "ZSIN_REP1.fastq.gz", "ZSIN_REP2.fastq.gz",
                                              "ZSIN_REP3.fastq.gz"]))
        zsin = rows["ZSIN_REP3.fastq.gz"]
        self.assertEqual((zsin["name"], zsin["condition"], zsin["replicate"]), ("ZSIN_REP3", "ZSIN", 3))
        self.assertEqual(Path(zsin["reference"]).name, "ZSIN.fasta")
        self.assertFalse(zsin["reference_guessed"])
        live = rows["Livefire2_comp.fasta.gz"]
        self.assertEqual((live["name"], live["condition"], live["replicate"]), ("Livefire2", "Livefire", 2))
        self.assertEqual(Path(live["reference"]).name, "Zika.fasta")
        self.assertTrue(live["reference_guessed"])
        aag = rows["Aag-1.assembled.collapse.fasta.gz"]
        self.assertEqual((aag["name"], aag["condition"], aag["replicate"]), ("Aag-1", "Aag", 1))
        self.assertEqual(len(result["references"]), 3)
        self.assertEqual([Path(d["path"]).name for d in result["duplicates"]], ["ZSIN_REP1.fastq"])
        self.assertEqual(result["ignored"], {"Bowtie2 index files (RNAxRay builds its own)": 2, ".tab files": 1,
                                             "named FASTA but not FASTA content": 1})
        self.assertEqual(self.manifest()["samples"], [])  # scanning writes nothing

    def test_split_replicate_and_paired_end_note(self):
        self.assertEqual(samples._split_replicate("ctrl-rep12_trimmed"), ("ctrl-rep12", "ctrl", 12))
        self.assertEqual(samples._split_replicate("Sample"), ("Sample", None, None))
        _write_gz(self.data / "S_R1.fastq.gz", "@r\nACGT\n+\nIIII\n")
        _write_gz(self.data / "S_R2.fastq.gz", "@r\nACGT\n+\nIIII\n")
        result = samples.scan_data_folder(self.data)
        self.assertTrue(all(any("paired-end" in n for n in s["notes"]) for s in result["samples"]), result)
        self.assertTrue(all(any("no reference" in n for n in s["notes"]) for s in result["samples"]))

    def test_import_reviewed_rows(self):
        files = self.zikv_folder()
        scan = samples.scan_data_folder(files)
        rows = [{k: s[k] for k in ("path", "name", "condition", "replicate", "reference")} for s in scan["samples"]]
        rows[0]["condition"] = "insect"
        dry = self.call("import_sample_rows", rows=rows, dry_run=True)
        self.assertTrue(dry["ok"], dry)
        self.assertEqual(self.manifest()["samples"], [])
        result = self.call("import_sample_rows", rows=rows)
        self.assertTrue(result["ok"], result)
        manifest = self.manifest()
        self.assertEqual(len(manifest["samples"]), len(rows))
        self.assertEqual(len(manifest["references"]), 3)
        first = next(s for s in manifest["samples"] if s["name"] == rows[0]["name"])
        self.assertEqual(first["condition"], "insect")
        self.assertEqual(first["gene_id"], REFERENCE_NAMES["Zika"])
        self.assertEqual(first["reads"]["mode"], "linked")
        again = self.call("import_sample_rows", rows=rows)
        self.assertEqual(len(again["skipped"]), len(rows))

    def test_import_rows_rejects_bad_rows_atomically(self):
        good = self.reads("a.fastq.gz")
        bad = [{"path": str(good), "name": "a"}, {"path": str(self.data / "missing.fastq"), "name": "b"},
               {"path": str(good), "name": "", "replicate": 0}, {"path": "relative.fastq", "name": "c"},
               {"path": str(good), "name": "d", "extra": 1}]
        result = self.call("import_sample_rows", rows=bad)
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["errors"]), 4, result["errors"])
        self.assertEqual(self.manifest()["samples"], [])
        with self.assertRaises(ValueError):
            self.call("scan_data_folder", folder="relative/dir")


if __name__ == "__main__":
    unittest.main()

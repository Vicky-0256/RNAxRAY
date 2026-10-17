"""Files a project links outside its folder (F5).

A project folder may come from another computer (a download, a colleague).
Its project.json can name any absolute path; the app opens such a file only
when it was linked on this computer (RNAXRAY_TRUSTED_LINKS) or the user allowed
it. Without RNAXRAY_TRUSTED_LINKS (tests, command line) nothing is checked.
"""
import gzip
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from desktop.runtime.bridge import handle
from desktop.runtime.project import new_project

ROOT = Path(__file__).resolve().parents[3]


class TrustedLinksTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.project = self.dir / "p.rnaxrayproj"
        new_project(self.project, "Links")
        self.data = self.dir / "data"
        self.data.mkdir()
        self.here = self.dir / "here-links.json"
        self.elsewhere = self.dir / "elsewhere-links.json"
        self.fasta = self.data / "ref.fasta"
        self.fasta.write_text(">Gene_A d\nACGUACGUAC\n", encoding="utf-8")
        self.reads = self.data / "s1.fastq.gz"
        with gzip.open(self.reads, "wt") as handle_:
            handle_.write("@r\nACGT\n+\nIIII\n")

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, operation, store, **request):
        request.setdefault("path", str(self.project))
        with mock.patch.dict(os.environ, {"RNAXRAY_TRUSTED_LINKS": str(store)}):
            return handle({"operation": operation, **request}, repo_root=ROOT)

    def link_here(self):
        self.call("add_sample", self.here, source=str(self.reads), reference=str(self.fasta))

    def test_files_linked_here_are_opened(self):
        self.link_here()
        checked = self.call("check_inputs", self.here)
        self.assertTrue(checked["all_ok"], checked)
        self.assertEqual(self.call("list_untrusted_links", self.here)["files"], [])

    def test_files_linked_on_another_computer_are_not_opened(self):
        self.link_here()
        # The same project on a computer whose store does not list them.
        checked = self.call("check_inputs", self.elsewhere)
        self.assertEqual({item["status"] for item in checked["items"]}, {"unconfirmed"}, checked)
        self.assertFalse(checked["all_ok"])
        files = self.call("list_untrusted_links", self.elsewhere)["files"]
        self.assertEqual(self.call("list_samples", self.elsewhere)["untrusted_links"], files)
        self.assertEqual(self.call("list_samples", self.here)["untrusted_links"], [])
        self.assertEqual(sorted(item["path"] for item in files),
                         sorted(str(p.resolve()) for p in (self.fasta, self.reads)))
        reference_id = self.manifest()["references"][0]["id"]
        with self.assertRaisesRegex(ValueError, "not linked on this computer"):
            self.call("read_reference_sequence", self.elsewhere, reference_id=reference_id, name="Gene_A")

    def test_allowing_trusts_only_this_projects_files(self):
        self.link_here()
        other = self.data / "secret.txt"
        other.write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "not a file this project links"):
            self.call("trust_links", self.elsewhere, paths=[str(other)])
        files = [item["path"] for item in self.call("list_untrusted_links", self.elsewhere)["files"]]
        self.assertTrue(self.call("trust_links", self.elsewhere, paths=files)["ok"])
        self.assertTrue(self.call("check_inputs", self.elsewhere)["all_ok"])

    def test_a_planted_absolute_index_makes_the_project_invalid(self):
        self.link_here()
        outside = self.dir / "outside.rnaxrayidx"
        outside.write_bytes(b"not an index")
        manifest = self.manifest()
        manifest["samples"][0]["outputs"]["index"] = str(outside)
        (self.project / "project.json").write_text(json.dumps(manifest), encoding="utf-8")
        # Outputs must be project-relative: the project is refused outright.
        with self.assertRaisesRegex(ValueError, "outputs.index must be a project-relative path"):
            self.call("list_samples", self.here)

    def test_structure_and_compare_inputs_are_checked(self):
        from desktop.runtime.structure import _input_file
        hyb = self.data / "s.hyb"
        hyb.write_text("x\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {"RNAXRAY_TRUSTED_LINKS": str(self.elsewhere)}):
            with self.assertRaisesRegex(ValueError, "not linked on this computer"):
                _input_file(self.project, str(hyb), "sample S1 .hyb")
            inside = self.project / "data.hyb"
            inside.write_text("x\n", encoding="utf-8")
            self.assertEqual(_input_file(self.project, str(inside), "inside"), inside.resolve())

    def test_a_dry_run_import_trusts_nothing(self):
        sheet = self.data / "sheet.tsv"
        sheet.write_text("name\tfiles\treference\nS1\t%s\t%s\n" % (self.reads, self.fasta), encoding="utf-8")
        self.call("import_sample_sheet", self.here, sheet=str(sheet), dry_run=True)
        self.assertFalse(self.here.exists() and json.loads(self.here.read_text())["paths"])
        self.call("import_sample_sheet", self.here, sheet=str(sheet))
        self.assertTrue(self.call("check_inputs", self.here)["all_ok"])

    def test_without_a_store_nothing_is_checked(self):
        self.link_here()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RNAXRAY_TRUSTED_LINKS", None)
            checked = handle({"operation": "check_inputs", "path": str(self.project)}, repo_root=ROOT)
        self.assertTrue(checked["all_ok"], checked)

    def manifest(self):
        return json.loads((self.project / "project.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

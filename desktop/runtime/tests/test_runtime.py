import json
import tempfile
import unittest
from pathlib import Path

from desktop.runtime.detector import RuntimeDetector, _version
from desktop.runtime.project import safe_relative_path, validate_manifest, validate_project_directory, new_project
from desktop.runtime.bridge import handle


ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "desktop" / "spec" / "example.rnaxrayproj"


class RuntimeTests(unittest.TestCase):
    def test_open_project_returns_manifest_from_directory_or_manifest_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample.rnaxrayproj"
            manifest = new_project(root, "Sample")
            for path in (root, manifest):
                result = handle({"operation": "open_project", "path": str(path), "check_files": True})
                self.assertTrue(result["ok"])
                self.assertEqual(result["manifest"]["name"], "Sample")
                self.assertEqual(result["path"], str(root.resolve()))

    def test_bridge_rejects_empty_path_and_non_object_requests(self):
        for request in ({"operation": "open_project", "path": ""}, {"operation": "create_project", "name": "Example"}, []):
            with self.assertRaises(ValueError):
                handle(request)

    def test_open_invalid_project_returns_validation_details(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "project.json").write_text("[]", encoding="utf-8")
            result = handle({"operation": "open_project", "path": tmp, "check_files": True})
            self.assertFalse(result["ok"])
            self.assertIn("manifest must be an object", result["error"])
            self.assertNotIn("manifest", result)

    def test_create_project_and_bridge_validate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample.rnaxrayproj"
            manifest = new_project(root, "Sample")
            self.assertTrue(manifest.is_file())
            self.assertEqual(validate_project_directory(root), [])
            result = handle({"operation": "validate_project", "path": str(root)})
            self.assertTrue(result["ok"])

    def test_import_input_is_copied_and_portable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample.rnaxrayproj"
            source = Path(tmp) / "reads.hyb"
            source.write_text("read\t1\n", encoding="utf-8")
            new_project(root, "Sample")
            result = handle({"operation": "import_input", "path": str(root), "source": str(source), "role": "hyb"})
            self.assertTrue(result["ok"])
            item = result["input"]
            self.assertTrue((root / item["path"]).is_file())
            self.assertTrue(item["path"].startswith("inputs/"))
            self.assertEqual(validate_project_directory(root, check_files=True), [])

    def test_ui_state_persists_and_rejects_absolute_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sample.rnaxrayproj"
            new_project(root, "Sample")
            result = handle({"operation": "update_ui_state", "path": str(root), "ui_state": {"route": "analysis", "zoom": 2}})
            self.assertTrue(result["ok"])
            manifest = json.loads((root / "project.json").read_text())
            self.assertEqual(manifest["ui_state"]["route"], "analysis")
            with self.assertRaises(ValueError):
                handle({"operation": "update_ui_state", "path": str(root), "ui_state": {"file": "/tmp/x"}})

    def test_version_parser(self):
        self.assertEqual(_version("RNAfold 2.6.4"), "2.6.4")
        self.assertEqual(_version("R version 4.3.1 (2023-06-16)"), "4.3.1")
        self.assertIsNone(_version("command unavailable"))

    def test_detector_serializes_expected_capabilities(self):
        matrix = RuntimeDetector(repo_root=ROOT).detect()
        data = matrix.to_dict()
        self.assertEqual(data["detector_version"], "0.1.0")
        self.assertIn(data["platform"]["os"], {"windows", "macos", "linux", "unknown"})
        self.assertTrue(matrix.supports("web.analysis"))
        self.assertFalse(matrix.supports("does.not.exist"))
        self.assertIn("rnaxray.cli", {probe["id"] for probe in data["probes"]})
        self.assertIn("language.numpy", {probe["id"] for probe in data["probes"]})
        self.assertIn("language.numba", {probe["id"] for probe in data["probes"]})

    def test_packaged_native_resource_root_is_detected(self):
        """The desktop shell passes resources/native as repo_root in a bundle."""
        resource_root = ROOT / "desktop" / "resources" / "native"
        if not (resource_root / "native-manifest.json").is_file():
            self.skipTest("portable native resource is not staged")
        matrix = RuntimeDetector(repo_root=resource_root, timeout_seconds=10).detect()
        probes = {probe["id"]: probe for probe in matrix.to_dict()["probes"]}
        self.assertEqual(probes["native.runtime"]["status"], "available")
        self.assertEqual(probes["native.numpy"]["status"], "available")
        self.assertEqual(probes["native.numba"]["status"], "available")
        self.assertEqual(probes["native.cplfold"]["status"], "available")
        self.assertTrue(matrix.supports("structure.cplfold_native"))

    def test_relative_path_rejects_traversal(self):
        self.assertTrue(safe_relative_path("runs/a/out.tsv"))
        for unsafe in ("/tmp/out.tsv", "../out.tsv", "runs/../../out.tsv", "C:\\out.tsv", "runs/./out.tsv", "runs/", "runs/\x00out"):
            self.assertFalse(safe_relative_path(unsafe), unsafe)

    def test_example_manifest_and_directory(self):
        manifest = json.loads((EXAMPLE / "project.json").read_text(encoding="utf-8"))
        self.assertEqual(validate_manifest(manifest), [])
        errors = validate_project_directory(EXAMPLE, check_files=True)
        self.assertEqual(errors, [])

    def test_manifest_detects_unsafe_output(self):
        manifest = json.loads((EXAMPLE / "project.json").read_text(encoding="utf-8"))
        manifest["runs"][0]["output_paths"] = ["../outside.txt"]
        self.assertTrue(any("unsafe path" in error for error in validate_manifest(manifest)))


if __name__ == "__main__":
    unittest.main()

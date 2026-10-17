import json
import tempfile
import unittest
from pathlib import Path

from desktop.runtime.bridge import handle
from desktop.runtime.project import validate_manifest


ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "desktop" / "spec"


class ProtocolContractTests(unittest.TestCase):
    def test_fixtures_match_schema_required_fields(self):
        for schema_name, fixture_name in (("task.schema.json", "task.json"), ("result.schema.json", "result.json"), ("capabilities.schema.json", "capabilities.json")):
            schema = json.loads((SPEC / schema_name).read_text(encoding="utf-8"))
            fixture = json.loads((SPEC / "fixtures" / fixture_name).read_text(encoding="utf-8"))
            for field in schema["required"]:
                self.assertIn(field, fixture, f"{fixture_name} missing {field}")
            self.assertEqual(fixture["protocol_version"], schema["properties"]["protocol_version"]["const"])

    def test_bridge_detect_is_capability_contract(self):
        data = handle({"operation": "detect"}, repo_root=ROOT)
        self.assertTrue(data["ok"])
        snapshot = data["result"]
        self.assertEqual(snapshot["protocol_version"], "1.0")
        self.assertIsInstance(snapshot["capabilities"], list)
        self.assertTrue(all({"id", "status", "execution"} <= set(item) for item in snapshot["capabilities"]))

    def test_bridge_create_project_emits_protocol_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "fixture.rnaxrayproj"
            response = handle({"operation": "create_project", "path": str(root), "name": "Fixture"})
            self.assertTrue(response["ok"])
            manifest = json.loads((root / "project.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["runtime"]["protocol_version"], "1.0")
            self.assertEqual(validate_manifest(manifest), [])


if __name__ == "__main__":
    unittest.main()

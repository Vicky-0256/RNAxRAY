import json
import tempfile
import unittest
from pathlib import Path

from desktop.runtime.project import new_project, validate_manifest, validate_project_directory


class MalformedProjectTests(unittest.TestCase):
    def test_untrusted_member_types_and_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'sample.rnaxrayproj'
            manifest = json.loads(new_project(root, 'Test').read_text())
            manifest['runs'] = [{
                'id': [], 'kind': 'structure', 'status': 'succeeded',
                'input_ids': [], 'parameters': {}, 'output_paths': 42,
                'log_paths': ['../outside.log'],
            }]
            errors = validate_manifest(manifest)
            self.assertTrue(any('.id is invalid' in error for error in errors))
            self.assertTrue(any('output_paths must be an array' in error for error in errors))
            self.assertTrue(any('log_paths contains an unsafe path' in error for error in errors))
            (root / 'project.json').write_text(json.dumps(manifest))
            self.assertEqual(validate_project_directory(root, check_files=True), errors)

    def test_boolean_size_is_not_an_integer_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'sample.rnaxrayproj'
            manifest = json.loads(new_project(root, 'Test').read_text())
            manifest['artifacts'] = [{'path': 'result.txt', 'kind': 'output',
                                      'sha256': '0' * 64, 'size_bytes': True}]
            self.assertTrue(any('size_bytes' in error for error in validate_manifest(manifest)))

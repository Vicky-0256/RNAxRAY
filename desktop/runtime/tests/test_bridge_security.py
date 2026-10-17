import json
import tempfile
import unittest
from pathlib import Path

from desktop.runtime.bridge import handle
from desktop.runtime.project import new_project


class BridgeSecurityTests(unittest.TestCase):
    def test_invalid_task_ids_and_empty_paths_do_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'project'
            new_project(project, 'Test')
            for task_id in ('../escape', '/tmp/escape', 'a/b', 'a\\b', '.', '1bad'):
                with self.assertRaises(ValueError):
                    handle({'operation': 'run_task', 'path': str(project), 'task_id': task_id})
            with self.assertRaises(ValueError):
                handle({'operation': 'run_task', 'path': ''})
            self.assertEqual(list((project / 'runs').iterdir()), [])

    def test_runs_symlink_cannot_escape_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'project'
            new_project(project, 'Test')
            outside = Path(tmp) / 'outside'
            outside.mkdir()
            (project / 'runs').rmdir()
            (project / 'runs').symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'escapes project'):
                handle({'operation': 'run_task', 'path': str(project)})
            self.assertEqual(list(outside.iterdir()), [])

    def test_invalid_project_is_rejected_before_run_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / 'project.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'invalid project'):
                handle({'operation': 'run_task', 'path': str(project)})
            self.assertFalse((project / 'runs').exists())

    def test_failed_validation_preserves_structured_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'project'
            manifest_path = new_project(project, 'Test')
            manifest = json.loads(manifest_path.read_text())
            manifest['inputs'] = [{'id': 'input-1', 'role': 'interactions', 'path': 'inputs/missing.hyb', 'format': 'hyb', 'sha256': '0' * 64, 'size_bytes': 1}]
            manifest_path.write_text(json.dumps(manifest))
            result = handle({'operation': 'run_task', 'path': str(project), 'task_id': 'validation-test'})
            self.assertTrue(result['ok'])
            self.assertEqual(result['status'], 'failed')
            self.assertIn('missing project file', json.dumps(result['events']))
            self.assertTrue((Path(result['run_dir']) / 'events.jsonl').is_file())
            self.assertTrue((Path(result['run_dir']) / 'result.json').is_file())
            self.assertFalse((Path(result['run_dir']) / 'status.json').exists())
            with self.assertRaises(FileExistsError):
                handle({'operation': 'run_task', 'path': str(project), 'task_id': 'validation-test'})

    def test_cplfold_request_is_structured_and_reports_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'project'
            new_project(project, 'Test')
            result = handle({'operation': 'cplfold_run', 'project_path': str(project), 'sequence': 'AUGC', 'parameters': {'alpha': 0.5}}, repo_root=Path(tmp))
            self.assertFalse(result['ok'])
            self.assertEqual(result['status'], 'unavailable')
            with self.assertRaises(ValueError):
                handle({'operation': 'cplfold_run', 'project_path': str(project), 'sequence': 'AUGX'}, repo_root=Path(tmp))

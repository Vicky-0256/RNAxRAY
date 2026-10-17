import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from desktop.runtime import bridge
from desktop.runtime.bridge import handle, serve
from desktop.runtime.detector import detect_runtime
from desktop.runtime.project import new_project, register_task_run, save_analysis_run, update_ui_state, validate_manifest, validate_project_directory

ROOT = Path(__file__).resolve().parents[3]


def _load_cplfold_web():
    spec = importlib.util.spec_from_file_location("rnaxray_test_cplfold_web", ROOT / "web" / "cplfold" / "cplfold_web.py")
    module = importlib.util.module_from_spec(spec)
    for extra in (str(ROOT / "third_party" / "cplfold"), str(ROOT / "web" / "cplfold")):
        if extra not in sys.path: sys.path.insert(0, extra)
    spec.loader.exec_module(module)
    return module


class ServeModeTests(unittest.TestCase):
    def test_serve_subprocess_one_line_per_request(self):
        lines = [json.dumps({"id": 1, "request": {"operation": "nope"}}), "not json", "", json.dumps({"id": 2, "request": {"operation": "validate_project", "path": ""}}), json.dumps({"id": 3})]
        completed = subprocess.run([sys.executable, "-m", "desktop.runtime.bridge", "--repo-root", str(ROOT), "--serve"], input="\n".join(lines) + "\n", cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        out = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([item["id"] for item in out], [1, None, 2, 3])
        self.assertTrue(all(item["response"]["ok"] is False and item["response"]["error"] for item in out))
        self.assertIn("unsupported bridge operation", out[0]["response"]["error"])

    def test_serve_redirects_stray_prints_and_handles_exceptions(self):
        def noisy(request, repo_root=None):
            print("stray output from a library")
            if request.get("boom"): raise RuntimeError("kaboom")
            return {"ok": True, "echo": request.get("value")}
        stdin = io.BytesIO(b'{"id": 7, "request": {"value": 1}}\n{"id": 8, "request": {"boom": true}}\n')
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(bridge, "handle", noisy), mock.patch.object(sys, "stderr", stderr):
            self.assertEqual(serve(None, stdin=stdin, stdout=stdout), 0)
        out = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(out, [{"id": 7, "response": {"ok": True, "echo": 1}}, {"id": 8, "response": {"ok": False, "error": "kaboom"}}])
        self.assertIn("stray output", stderr.getvalue())


class ManifestConcurrencyTests(unittest.TestCase):
    def test_concurrent_writers_do_not_lose_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "p"; new_project(root, "P")
            errors = []
            def runs():
                try:
                    for i in range(10): save_analysis_run(root, {"algorithm": "structure", "i": i})
                except Exception as error: errors.append(error)
            def states():
                try:
                    for i in range(20): update_ui_state(root, {"desktop": {"route": "analysis"}, "analysis": {"n": i}})
                except Exception as error: errors.append(error)
            threads = [threading.Thread(target=runs) for _ in range(3)] + [threading.Thread(target=states) for _ in range(2)]
            for thread in threads: thread.start()
            for thread in threads: thread.join()
            self.assertEqual(errors, [])
            manifest = json.loads((root / "project.json").read_text())
            self.assertEqual(len(manifest["runs"]), 30)
            self.assertEqual(len(manifest["artifacts"]), 30)
            self.assertEqual(validate_project_directory(root, check_files=True), [])
            self.assertEqual([p.name for p in root.iterdir() if p.name.endswith(".tmp")], [])

    def test_concurrent_processes_do_not_lose_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "p"; new_project(root, "P")
            code = "import sys\nfrom pathlib import Path\nfrom desktop.runtime.project import save_analysis_run\nfor i in range(8): save_analysis_run(Path(sys.argv[1]), {'algorithm': 'structure'})\n"
            procs = [subprocess.Popen([sys.executable, "-c", code, str(root)], cwd=ROOT) for _ in range(4)]
            self.assertEqual([proc.wait(timeout=120) for proc in procs], [0, 0, 0, 0])
            self.assertEqual(len(json.loads((root / "project.json").read_text())["runs"]), 32)


class UiStateAndVersionTests(unittest.TestCase):
    def test_new_project_default_and_nested_ui_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "p"
            with mock.patch.dict(os.environ, {"RNAXRAY_APP_VERSION": "9.8.7"}):
                manifest = json.loads(new_project(root, "P").read_text())
            self.assertEqual(manifest["application"]["version"], "9.8.7")
            self.assertEqual(manifest["ui_state"], {"desktop": {"route": "home"}, "analysis": {}})
            state = {"desktop": {"route": "tasks"}, "analysis": {"page": "structure", "region": {"start": 1, "end": 50}, "files": ["inputs/a.hyb"]}}
            result = handle({"operation": "update_ui_state", "path": str(root), "ui_state": state})
            self.assertEqual(result["ui_state"], state)
            self.assertEqual(json.loads((root / "project.json").read_text())["ui_state"], state)
            with self.assertRaises(ValueError):
                update_ui_state(root, {"desktop": {"route": "home"}, "analysis": {"file": "/etc/passwd"}})

    def test_new_project_without_env_uses_default_version(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RNAXRAY_APP_VERSION", None)
            manifest = json.loads(new_project(Path(tmp) / "p", "P").read_text())
            self.assertEqual(manifest["application"]["version"], "0.1.5")

    def test_project_made_by_hyb2_desktop_still_validates(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = new_project(Path(tmp) / "old.hyb2proj", "Old")
            manifest = json.loads(path.read_text())
            manifest["application"] = {"name": "HYB2 Desktop", "version": "0.1.3"}
            self.assertEqual(validate_manifest(manifest), [])
            manifest["application"]["name"] = "Something else"
            self.assertTrue(validate_manifest(manifest))


class RegisterTaskRunTests(unittest.TestCase):
    def _task(self, root, task_id, **status):
        run_dir = root / "runs" / task_id; run_dir.mkdir()
        (run_dir / "stdout.log").write_text("out"); (run_dir / "stderr.log").write_text("")
        (run_dir / "cplfold.out").write_text("....")
        base = {"task_id": task_id, "kind": "cplfold", "status": "succeeded", "exit_code": 0, "error": None, "run_dir": str(run_dir),
                "log_paths": [str(run_dir / "stdout.log"), "runs/%s/stderr.log" % task_id], "started_at": "2026-10-13T00:00:00Z", "finished_at": "2026-10-13T00:01:00Z", "output": None}
        base.update(status)
        (run_dir / "status.json").write_text(json.dumps(base))
        (run_dir / "result.json").write_text(json.dumps({"ok": True, "output": str(run_dir / "cplfold.out")}))
        return run_dir

    def test_register_is_idempotent_and_relative(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "p"; new_project(root, "P")
            self._task(root, "cplfold-1")
            first = handle({"operation": "register_task_run", "path": str(root), "task_id": "cplfold-1"})
            second = handle({"operation": "register_task_run", "path": str(root), "task_id": "cplfold-1"})
            self.assertEqual(first["run"], second["run"])
            runs = json.loads((root / "project.json").read_text())["runs"]
            self.assertEqual(len(runs), 1)
            run = runs[0]
            self.assertEqual((run["id"], run["kind"], run["status"], run["exit_code"]), ("cplfold-1", "cplfold", "succeeded", 0))
            self.assertEqual(run["output_paths"], ["runs/cplfold-1/cplfold.out", "runs/cplfold-1/result.json"])
            self.assertEqual(run["log_paths"], ["runs/cplfold-1/stdout.log", "runs/cplfold-1/stderr.log"])
            self.assertEqual(validate_project_directory(root, check_files=True), [])

    def test_register_updates_status_and_rejects_escapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "p"; new_project(root, "P")
            outside = Path(tmp) / "secret.txt"; outside.write_text("x")
            run_dir = self._task(root, "task-2", status="failed", error="boom", log_paths=[str(outside), "../secret.txt", "/etc/passwd"], output={"output": str(outside)})
            (run_dir / "result.json").write_text(json.dumps({"ok": False, "output": "../../secret.txt"}))
            run = register_task_run(root, "task-2")
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error"], {"code": "task_failed", "message": "boom"})
            self.assertEqual(run["output_paths"], ["runs/task-2/result.json"])
            self.assertEqual(run["log_paths"], [])
            status = json.loads((run_dir / "status.json").read_text()); status.update(status="succeeded", error=None)
            (run_dir / "status.json").write_text(json.dumps(status))
            self.assertEqual(register_task_run(root, "task-2")["status"], "succeeded")
            self.assertEqual(len(json.loads((root / "project.json").read_text())["runs"]), 1)
            for bad in ("../x", "a/b", "", "1bad"):
                with self.assertRaises(ValueError):
                    handle({"operation": "register_task_run", "path": str(root), "task_id": bad})
            with self.assertRaises(ValueError):
                register_task_run(root, "missing-task")


class CplfoldLimitTests(unittest.TestCase):
    def test_detector_reports_native_max_length(self):
        with mock.patch.dict(os.environ, {"RNAXRAY_CPLFOLD_MAX_NT": "1234"}):
            capability = detect_runtime(ROOT).capability("structure.cplfold_native").to_dict()
        self.assertEqual(capability["details"]["max_sequence_length"], 1234)

    def test_predict_passes_native_limit(self):
        seen = {}
        class Fake:
            def set_host_hard_max_sequence_length(self, value): seen["hard"] = value
            def fold(self, payload): seen["payload"] = payload; return {"structure": "."}
        with mock.patch.dict(bridge._CPLFOLD_MODULES, {str(ROOT / "web" / "cplfold" / "cplfold_web.py"): Fake()}), mock.patch.dict(os.environ, {"RNAXRAY_CPLFOLD_MAX_NT": "1000"}):
            result = handle({"operation": "cplfold_predict", "sequence": "A" * 700}, repo_root=ROOT)
        self.assertTrue(result["ok"])
        self.assertEqual(seen["hard"], 1000)
        self.assertEqual(seen["payload"]["maxSequenceLength"], 1000)

    def test_shared_module_keeps_browser_default_and_honours_host_limit(self):
        try:
            module = _load_cplfold_web()
        except ImportError as error:
            self.skipTest("cplfold_web dependencies unavailable: %s" % error)
        with self.assertRaisesRegex(ValueError, "500"):
            module._sequence("A" * 600, 600)
        with self.assertRaises(ValueError):
            module._request_maximum(600)
        module.set_host_hard_max_sequence_length(1000)
        self.assertEqual(module._request_maximum(1000), 1000)
        self.assertEqual(len(module._sequence("A" * 900, 1000)), 900)


if __name__ == "__main__":
    unittest.main()

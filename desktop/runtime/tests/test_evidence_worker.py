"""Evidence worker process tests against a fake FastMCP server.

The fake server (evidence_fake/fake_server.py) is injected by a test launcher
(evidence_fake/run_worker.py) that patches the module constant before
serve(); the worker protocol itself cannot change the server command.
Skipped when the MCP SDK is not installed (pipeline CI jobs).
"""
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from desktop.runtime.evidence import mcp_client

try:
    import mcp  # noqa: F401
    HAVE_MCP = True
except ImportError:
    HAVE_MCP = False

FAKE = Path(__file__).resolve().parent / "evidence_fake"
REPO = Path(__file__).resolve().parents[3]
SENTINEL = "RNAXRAY_TEST_SECRET_SHOULD_NOT_LEAK"


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie still answers kill(0); ask ps for its state.
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def wait_gone(pids, seconds=8.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not any(pid_alive(p) for p in pids):
            return True
        time.sleep(0.1)
    return False


def bytecode_files():
    roots = [REPO / "desktop/runtime/evidence", FAKE]
    return {str(p) for root in roots for p in root.rglob("*.pyc")}


class Worker:
    def __init__(self, test, call_timeout=None, cache=True):
        self.dir = Path(tempfile.mkdtemp(prefix="rnaxray-ev-"))
        test.addCleanup(self.cleanup)
        self.state = self.dir / "state"
        env = {"PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
               SENTINEL: "secret", "PATH": os.environ.get("PATH", "")}
        if cache:
            env["RNAXRAY_EVIDENCE_CACHE"] = str(self.dir / "cache")
        env["RNAXRAY_EVIDENCE_LOG"] = str(self.dir / "log")
        for name in ("SYSTEMROOT", "TEMP", "TMP"):
            if name in os.environ:
                env[name] = os.environ[name]
        args = [sys.executable, "-B", str(FAKE / "run_worker.py"), str(self.state)]
        if call_timeout is not None:
            args.append(str(call_timeout))
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env=env, cwd=str(self.dir))
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.next_id = 0

    def _read(self):
        for line in self.proc.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def request(self, request, timeout=40):
        self.next_id += 1
        self.proc.stdin.write((json.dumps({"id": self.next_id, "request": request}) + "\n").encode())
        self.proc.stdin.flush()
        line = self.lines.get(timeout=timeout)
        assert line is not None, "worker exited"
        message = json.loads(line)
        assert message["id"] == self.next_id, message
        return message["response"]

    def describe(self, rna_id, **extra):
        return self.request(dict({"operation": "describe", "rna_id": rna_id}, **extra))

    def calls(self):
        path = self.state / "calls.jsonl"
        return [json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []

    def child_pids(self):
        return [int(p.name[4:]) for p in self.state.glob("pid-*")] if self.state.exists() else []

    def cleanup(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(10)
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        for pid in self.child_pids():
            if pid_alive(pid):
                os.kill(pid, signal.SIGKILL)
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)


@unittest.skipUnless(HAVE_MCP, "evidence dependencies (mcp) not installed")
@unittest.skipIf(os.name == "nt", "process checks use POSIX signals")
class WorkerProcessTests(unittest.TestCase):
    def setUp(self):
        self.pyc_before = bytecode_files()

    def tearDown(self):
        self.assertEqual(bytecode_files() - self.pyc_before, set(), "worker wrote bytecode into the repository")

    def test_status_lists_only_allowed_tools(self):
        worker = Worker(self)
        status = worker.request({"operation": "status"})
        self.assertEqual((status["ok"], status["connected"], status["tools"]), (True, False, []))
        self.assertEqual(worker.child_pids(), [])  # lazy: nothing started yet
        for field in ("server_package_version", "sdk_version", "adapter_version"):
            self.assertIn(field, status)
        status = worker.request({"operation": "status", "connect": True})
        self.assertEqual((status["ok"], status["connected"]), (True, True))
        self.assertEqual(status["tools"], ["get_rna_description", "map_rna_id"])  # query_rnacentral hidden
        self.assertEqual(status["sdk_version"], mcp_client_version())

    def test_every_classification(self):
        worker = Worker(self)
        expected = {
            "fake-ok": ("success", None),
            "fake-404": ("not_found_or_no_summary", "HTTP 404 Not Found"),
            "fake-500": ("upstream_error", "HTTP 500 Internal Server Error"),
            "fake-nodesc": ("summary_unavailable", None),
            "fake-empty": ("unexpected_response", "empty response"),
            "fake-image": ("unexpected_response", "non-text response (image)"),
            "fake-big": ("unexpected_response", None),
            "fake-iserror": ("upstream_error", None),
        }
        for rna_id, (status, detail) in expected.items():
            response = worker.describe(rna_id)
            card = response["card"]
            self.assertEqual(card["status"], status, rna_id)
            if detail is not None:
                self.assertEqual(card["status_detail"], detail, rna_id)
            if status == "success":
                self.assertEqual(card["display_text"], response["raw_text"])
                self.assertEqual(card["source_identifiers"], ["PMC5549916", "PMC3456789", "PMID:12345678", "10.1093/nar/gkab123"])
                self.assertEqual(card["raw_response_digest"],
                                 "sha256:" + hashlib.sha256(response["raw_text"].encode()).hexdigest())
            else:
                self.assertIsNone(card["display_text"], rna_id)
                self.assertEqual(card["source_identifiers"], [], rna_id)
        # one call each: neither 404 nor HTTP errors are retried
        self.assertEqual(len(worker.calls()), len(expected))
        # an upstream connection failure text is retried exactly once
        self.assertEqual(worker.describe("fake-connerr")["card"]["status"], "upstream_error")
        self.assertEqual([c["arguments"]["rna_id"] for c in worker.calls()[-2:]], ["fake-connerr"] * 2)
        self.assertEqual(len(worker.calls()), len(expected) + 2)

    def test_map_id(self):
        worker = Worker(self)
        card = worker.request({"operation": "map_id", "identifier": "MIMAT0000076", "taxon": "9606"})["card"]
        self.assertEqual((card["status"], card["content_kind"], card["source_tool"]),
                         ("success", "database_metadata", "map_rna_id"))
        self.assertTrue(card["display_text"].startswith("# ID Mapping for MIMAT0000076"))
        self.assertEqual(card["source_url"], "https://rnacentral.org/rna/URS000075A546/9606")
        card = worker.request({"operation": "map_id", "identifier": "fake-map-mouse", "taxon": "9606"})["card"]
        self.assertIn("differs from requested 9606", card["status_detail"])
        card = worker.request({"operation": "map_id", "identifier": "fake-map-none", "taxon": "9606"})["card"]
        self.assertEqual(card["status"], "not_found_or_no_summary")
        self.assertIn("No RNAcentral entry", card["display_text"])
        self.assertEqual(worker.request({"operation": "map_id", "identifier": "fake-map-error", "taxon": "9606"})["card"]["status"],
                         "upstream_error")
        self.assertFalse(worker.request({"operation": "map_id", "identifier": "x1"})["ok"])

    def test_requests_carry_only_public_fields(self):
        worker = Worker(self)
        worker.describe("hsa-mir-21", taxon="9606", identity_confirmation="user_confirmed", force=True)
        worker.request({"operation": "map_id", "identifier": "MIMAT0000076", "taxon": "Homo sapiens"})
        bad = worker.describe("hsa-mir-21", project_path="/Users/me/proj")
        self.assertFalse(bad["ok"])
        self.assertIn("unexpected field", bad["error"])
        self.assertEqual([(c["name"], c["arguments"]) for c in worker.calls()],
                         [("get_rna_description", {"rna_id": "hsa-mir-21"}),
                          ("map_rna_id", {"identifier": "MIMAT0000076", "taxon": "Homo sapiens"})])
        child_env = set(json.loads((worker.state / "env.json").read_text()))
        self.assertNotIn(SENTINEL, child_env)
        self.assertNotIn("RNAXRAY_EVIDENCE_CACHE", child_env)
        allowed = set(mcp_client.CHILD_ENV) | {"HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER",
                                               "LC_CTYPE", "__CF_USER_TEXT_ENCODING"}
        self.assertLessEqual(child_env, allowed)
        log = (worker.dir / "log" / "evidence-worker.log").read_text()
        self.assertNotIn("hsa-mir-21", log)
        self.assertNotIn("MIMAT", log)

    def test_timeout_then_usable(self):
        worker = Worker(self, call_timeout=1.5)
        started = time.time()
        card = worker.describe("fake-sleep")["card"]
        self.assertLess(time.time() - started, 10)
        self.assertEqual((card["status"], card["retrieved_at"], card["raw_response_digest"]), ("timeout", None, None))
        first_child = worker.child_pids()
        self.assertEqual(worker.describe("fake-ok")["card"]["status"], "success")
        self.assertTrue(wait_gone(first_child), "timed-out session's child was not reaped")
        self.assertEqual(len(worker.child_pids()), 2)

    def test_crash_reconnects(self):
        worker = Worker(self)
        self.assertEqual(worker.describe("fake-crash-once")["card"]["status"], "success")
        self.assertEqual(len(worker.calls()), 2)
        self.assertEqual(len(worker.child_pids()), 2)
        card = worker.describe("fake-crash")["card"]  # crashes on both attempts
        self.assertEqual(card["status"], "local_error")
        self.assertIn("connection", card["status_detail"])
        self.assertEqual(worker.describe("fake-ok")["card"]["status"], "success")
        # a child killed while idle is replaced on the next call
        live = [p for p in worker.child_pids() if pid_alive(p)]
        self.assertEqual(len(live), 1)
        os.kill(live[0], signal.SIGKILL)
        self.assertTrue(wait_gone(live))
        self.assertEqual(worker.describe("fake-404")["card"]["status"], "not_found_or_no_summary")

    def test_cache_through_worker(self):
        worker = Worker(self)
        first = worker.describe("fake-ok", taxon="9606")
        second = worker.describe("fake-ok", taxon="9606")
        self.assertEqual((first["cached"], second["cached"]), (False, True))
        self.assertEqual(len(worker.calls()), 1)
        self.assertFalse(worker.describe("fake-ok", taxon="9606", force=True)["cached"])
        self.assertEqual(len(worker.calls()), 2)
        worker.describe("fake-404")
        self.assertTrue(worker.describe("fake-404")["cached"])
        worker.describe("fake-500")
        self.assertFalse(worker.describe("fake-500")["cached"])  # errors are not cached
        self.assertEqual(len(worker.calls()), 5)

    def test_rate_limit(self):
        worker = Worker(self, cache=False)
        worker.request({"operation": "status", "connect": True})
        for i in range(5):
            worker.describe("fake-rate-%d" % i)
        times = [c["t"] for c in worker.calls()]
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertGreaterEqual(min(gaps), 0.45, gaps)

    def test_unsupported_operations(self):
        worker = Worker(self)
        for request in ({"operation": "call_tool", "tool": "query_rnacentral", "arguments": {}},
                        {"operation": "query_rnacentral"}, {"operation": "run_task"}, {},
                        {"operation": None}, {"operation": "clear_cache"}):
            self.assertEqual(worker.request(request), {"ok": False, "error": "unsupported evidence operation"})
        self.assertEqual(worker.calls(), [])
        self.assertEqual(worker.child_pids(), [])

    def test_shutdown_reaps_child(self):
        worker = Worker(self)
        worker.describe("fake-ok")
        pids = worker.child_pids()
        self.assertEqual(worker.request({"operation": "shutdown"}), {"ok": True})
        self.assertEqual(worker.proc.wait(15), 0)
        self.assertTrue(wait_gone(pids), "MCP child survived shutdown")

    def test_eof_and_sigterm_reap_child(self):
        worker = Worker(self)
        worker.describe("fake-ok")
        pids = worker.child_pids()
        worker.proc.stdin.close()
        self.assertEqual(worker.proc.wait(15), 0)
        self.assertTrue(wait_gone(pids))
        worker = Worker(self)
        worker.describe("fake-ok")
        pids = worker.child_pids()
        worker.proc.send_signal(signal.SIGTERM)
        worker.proc.wait(15)
        self.assertTrue(wait_gone(pids))

    def test_killed_worker_leaves_no_orphan_even_mid_call(self):
        worker = Worker(self, call_timeout=30)
        worker.request({"operation": "status", "connect": True})
        worker.proc.stdin.write(b'{"id": 99, "request": {"operation": "describe", "rna_id": "fake-sleep"}}\n')
        worker.proc.stdin.flush()
        deadline = time.time() + 10
        while not worker.calls() and time.time() < deadline:
            time.sleep(0.1)
        pids = worker.child_pids()
        worker.proc.kill()
        worker.proc.wait(10)
        self.assertTrue(wait_gone(pids), "MCP child outlived a killed worker")


@unittest.skipUnless(HAVE_MCP, "evidence dependencies (mcp) not installed")
class ClientAllowlistTests(unittest.TestCase):
    def test_listed_but_not_allowed_tool_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = mcp_client.McpClient(server_args=["-I", "-B", str(FAKE / "fake_server.py"), "--state", tmp])
            self.addCleanup(client.close)
            self.assertIn("query_rnacentral", client.connect())  # the server lists it ...
            with self.assertRaises(mcp_client.ToolRefused):    # ... but it is never called
                client.call_tool("query_rnacentral", {"query": "x"})
            self.assertFalse((Path(tmp) / "calls.jsonl").exists())


def mcp_client_version():
    import importlib.metadata
    return importlib.metadata.version("mcp")


if __name__ == "__main__":
    unittest.main()

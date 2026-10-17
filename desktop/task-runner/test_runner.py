import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path

from runner import TaskRunner, TaskRunnerError, TaskSpec, validate_argv


ROOT = Path(__file__).resolve().parents[2]


class TaskRunnerTests(unittest.TestCase):
    def test_rejects_string_command_and_empty_argument(self):
        with self.assertRaises(TaskRunnerError):
            validate_argv("echo unsafe")
        with self.assertRaises(TaskRunnerError):
            validate_argv(["echo", ""])

    def test_streams_stdout_and_stderr_and_completes(self):
        events = []
        code = TaskRunner(events.append).run(
            TaskSpec.from_values(
                [
                    sys.executable,
                    "-c",
                    "import sys; print('out'); print('err', file=sys.stderr)",
                ],
                task_id="stream-test",
            )
        )
        self.assertEqual(code, 0)
        self.assertEqual(events[0]["type"], "started")
        self.assertTrue(any(e["type"] == "log" and e["stream"] == "stdout" and e["line"] == "out" for e in events))
        self.assertTrue(any(e["type"] == "log" and e["stream"] == "stderr" and e["line"] == "err" for e in events))
        self.assertEqual(events[-1]["type"], "completed")

    def test_cancel_terminates_process_group(self):
        events = []
        runner = TaskRunner(events.append)
        thread = threading.Thread(
            target=runner.run,
            args=(TaskSpec.from_values([sys.executable, "-c", "import time; time.sleep(30)"], task_id="cancel-test"),),
        )
        thread.start()
        for _ in range(50):
            if runner.process is not None:
                break
            time.sleep(0.01)
        self.assertTrue(runner.cancel())
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(events[-1]["type"], "cancelled")


if __name__ == "__main__":
    unittest.main()

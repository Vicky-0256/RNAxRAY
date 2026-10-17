#!/usr/bin/env python3
"""Small, dependency-free process runner for RNAxRay Desktop.

The desktop shell will eventually expose the same contract through the Go task scheduler (desktop/app/core).
This prototype deliberately accepts an argv array and never invokes a shell.
It emits newline-delimited JSON events so a UI or an integration test can
consume progress, logs, and terminal state incrementally.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Sequence


EventCallback = Callable[[dict[str, object]], None]


class TaskRunnerError(ValueError):
    """Raised when a task specification is unsafe or malformed."""


def validate_argv(argv: Sequence[str]) -> list[str]:
    """Return a copy of argv after enforcing the task runner contract."""

    if isinstance(argv, (str, bytes)) or not argv:
        raise TaskRunnerError("command must be a non-empty argument array")
    copied = list(argv)
    if any(not isinstance(item, str) or not item for item in copied):
        raise TaskRunnerError("command arguments must be non-empty strings")
    return copied


@dataclass(frozen=True)
class TaskSpec:
    command: tuple[str, ...]
    cwd: Path | None = None
    env: Mapping[str, str] | None = None
    task_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    @classmethod
    def from_values(
        cls,
        command: Sequence[str],
        *,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        task_id: str | None = None,
    ) -> "TaskSpec":
        checked = validate_argv(command)
        resolved_cwd = Path(cwd).expanduser() if cwd is not None else None
        if resolved_cwd is not None and not resolved_cwd.is_dir():
            raise TaskRunnerError(f"working directory does not exist: {resolved_cwd}")
        return cls(
            command=tuple(checked),
            cwd=resolved_cwd,
            env=dict(env) if env is not None else None,
            task_id=task_id or uuid.uuid4().hex,
        )


class TaskRunner:
    """Run one task at a time and publish structured lifecycle events."""

    def __init__(self, callback: EventCallback | None = None) -> None:
        self._callback = callback or (lambda _event: None)
        self._process: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._cancel_requested = False

    @property
    def process(self) -> subprocess.Popen[str] | None:
        with self._lock:
            return self._process

    def _emit(self, event: dict[str, object]) -> None:
        event.setdefault("timestamp", time.time())
        self._callback(event)

    def run(self, spec: TaskSpec) -> int:
        """Run ``spec`` and return its process exit code.

        stdout and stderr are read by separate threads and converted into log
        events. The method blocks until the process exits, while ``cancel``
        can be called safely from another thread.
        """

        with self._lock:
            if self._process is not None:
                raise RuntimeError("a task is already running")
            self._cancel_requested = False

        environment = os.environ.copy()
        if spec.env is not None:
            environment.update(spec.env)

        popen_kwargs: dict[str, object] = {
            "cwd": str(spec.cwd) if spec.cwd is not None else None,
            "env": environment,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "bufsize": 1,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["start_new_session"] = True

        try:
            process = subprocess.Popen(list(spec.command), **popen_kwargs)  # type: ignore[arg-type]
        except OSError as error:
            self._emit(
                {
                    "type": "failed",
                    "taskId": spec.task_id,
                    "error": str(error),
                    "exitCode": None,
                }
            )
            return 127

        with self._lock:
            self._process = process
        self._emit(
            {
                "type": "started",
                "taskId": spec.task_id,
                "command": list(spec.command),
                "cwd": str(spec.cwd) if spec.cwd is not None else None,
            }
        )

        lines: queue.Queue[tuple[str, str] | None] = queue.Queue()
        readers: list[threading.Thread] = []

        def read_stream(name: str, stream: object) -> None:
            assert hasattr(stream, "readline")
            while True:
                line = stream.readline()  # type: ignore[union-attr]
                if line == "":
                    break
                lines.put((name, line.rstrip("\r\n")))
            lines.put(None)

        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            thread = threading.Thread(target=read_stream, args=(name, stream), daemon=True)
            thread.start()
            readers.append(thread)

        streams_closed = 0
        while streams_closed < 2:
            item = lines.get()
            if item is None:
                streams_closed += 1
                continue
            stream_name, line = item
            self._emit({"type": "log", "taskId": spec.task_id, "stream": stream_name, "line": line})

        return_code = process.wait()
        for thread in readers:
            thread.join(timeout=1)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()

        with self._lock:
            cancelled = self._cancel_requested
            self._process = None
        terminal_type = "cancelled" if cancelled else ("completed" if return_code == 0 else "failed")
        self._emit(
            {
                "type": terminal_type,
                "taskId": spec.task_id,
                "exitCode": return_code,
            }
        )
        return return_code

    def cancel(self) -> bool:
        """Terminate the current process tree, returning whether one existed."""

        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                return False
            self._cancel_requested = True

        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                return False
        return True


def _json_event_writer(event: dict[str, object]) -> None:
    print(json.dumps(event, ensure_ascii=False, sort_keys=True), flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", help="working directory for the child process")
    parser.add_argument("--task-id", default=None)
    parser.add_argument("command", nargs=argparse.REMAINDER, help="argv passed directly to the child")
    args = parser.parse_args(argv)
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    try:
        spec = TaskSpec.from_values(command, cwd=args.cwd, task_id=args.task_id)
    except (TaskRunnerError, OSError) as error:
        print(json.dumps({"type": "failed", "error": str(error)}), flush=True)
        return 2
    return TaskRunner(_json_event_writer).run(spec)


if __name__ == "__main__":
    raise SystemExit(main())

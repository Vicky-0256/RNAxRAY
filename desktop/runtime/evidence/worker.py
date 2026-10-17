"""RNAxRay evidence worker: ``python -m desktop.runtime.evidence.worker --serve``.

Same newline-JSON framing as the bridge sidecar (contract C1): one
``{"id": N, "request": {...}}`` line in, one ``{"id": N, "response": {...}}``
line out.  Operations: status, describe, map_id, shutdown (EVIDENCE.md).
Everything else is rejected.  The worker only ever receives public query
fields; it never opens project files.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import os
from pathlib import Path
import signal
import sys
from typing import Any

from .mcp_client import McpClient, mcp_available
from .rnacentral import EvidenceService
from .store import EvidenceCache

UNSUPPORTED = {"ok": False, "error": "unsupported evidence operation"}


class _Log:
    """Redacted worker log: operation, status, timings; never texts or ids."""

    def __init__(self, directory: str | None):
        self.path = None
        if directory:
            try:
                Path(directory).mkdir(parents=True, exist_ok=True)
                self.path = Path(directory) / "evidence-worker.log"
            except OSError:
                self.path = None

    def __call__(self, record: dict) -> None:
        if self.path is None:
            return
        line = dict(record, at=_dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        try:
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(line, sort_keys=True) + "\n")
        except OSError:
            pass


def build_service() -> EvidenceService:
    log_dir = os.environ.get("RNAXRAY_EVIDENCE_LOG") or None
    cache_dir = os.environ.get("RNAXRAY_EVIDENCE_CACHE") or None
    client = McpClient(log_dir=log_dir, cwd=cache_dir if cache_dir and os.path.isdir(cache_dir) else None)
    return EvidenceService(client=client, cache=EvidenceCache(cache_dir), log=_Log(log_dir))


def handle(service: EvidenceService, request: Any) -> tuple[dict, bool]:
    """Returns (response, stop)."""
    if not isinstance(request, dict):
        return dict(UNSUPPORTED), False
    operation = request.get("operation")
    if operation == "shutdown":
        service.close()
        return {"ok": True}, True
    if operation == "status":
        return service.status(request), False
    if operation in ("describe", "map_id"):
        if not mcp_available():
            return {"ok": False, "error": "evidence dependencies (mcp, rnacentral-mcp-server) are not installed"}, False
        return (service.describe(request) if operation == "describe" else service.map_id(request)), False
    return dict(UNSUPPORTED), False


def _dumps_line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, allow_nan=False)


def serve(service: EvidenceService | None = None, stdin: Any = None, stdout: Any = None) -> int:
    """Line loop, framed exactly like desktop.runtime.bridge.serve."""
    if stdout is None:
        protocol_fd = os.dup(1)
        sys.stdout.flush()
        os.dup2(2, 1)
        stdout = os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")
    reader = stdin if stdin is not None else sys.stdin.buffer
    service = service or build_service()
    try:
        while True:
            raw = reader.readline()
            if not raw:
                return 0
            line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
            if not line.strip():
                continue
            request_id: Any = None
            stop = False
            try:
                message = json.loads(line)
                if not isinstance(message, dict) or not isinstance(message.get("request"), dict):
                    if isinstance(message, dict) and isinstance(message.get("id"), (int, str)) and not isinstance(message.get("id"), bool):
                        request_id = message["id"]
                    raise ValueError("sidecar message must be {\"id\": <int>, \"request\": {...}}")
                request_id = message.get("id")
                with contextlib.redirect_stdout(sys.stderr):
                    response, stop = handle(service, message["request"])
            except Exception as error:  # noqa: BLE001 - every failure must be a protocol response
                response = {"ok": False, "error": str(error) or error.__class__.__name__}
            stdout.write(_dumps_line({"id": request_id, "response": response}) + "\n")
            stdout.flush()
            if stop:
                return 0
    finally:
        service.close()


def _terminate(signum, frame):  # pragma: no cover - exercised by process tests
    raise SystemExit(128 + signum)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="RNAxRay evidence worker (RNAcentral MCP client)")
    parser.add_argument("--serve", action="store_true", help="long-lived line protocol on stdin/stdout")
    args = parser.parse_args(argv)
    if not args.serve:
        parser.error("only --serve is supported")
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _terminate)
    return serve()


if __name__ == "__main__":
    sys.exit(main())

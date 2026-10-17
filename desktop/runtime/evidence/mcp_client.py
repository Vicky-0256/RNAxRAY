"""One lazily started MCP stdio session to the fixed RNAcentral server.

The MCP SDK is asynchronous and its stdio transport must be entered and left
in one task, so the session lives in an *owner* task on a private event loop
thread.  The synchronous worker hands tool calls to that task and waits.

Guarantees:
- the server command is fixed (``SERVER_ARGS`` run by this interpreter); no
  protocol field can change it;
- the child sees an allowlisted environment only, and a neutral cwd;
- only allowlisted tools can be called (``ALLOWED_TOOLS``), even if the server
  lists more;
- every tool call is bounded (``CALL_TIMEOUT``); after a timeout or a lost
  connection the session is discarded and restarted lazily on the next call;
- calls start at most ``1 / MIN_INTERVAL`` times per second;
- ``close()`` closes stdin, waits, then terminates the child's process tree.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from typing import Any

# The only server this client ever starts: the pinned rnacentral-mcp-server
# package, imported by the bundled interpreter in isolated mode (-I: no user
# site, no PYTHON* variables, no cwd on sys.path; -B: no bytecode).
SERVER_ARGS = ["-I", "-B", "-c", "from rnacentral_sequence_search.server import main; main()"]
ALLOWED_TOOLS = frozenset({"get_rna_description", "map_rna_id"})
CALL_TIMEOUT = 30.0
CONNECT_TIMEOUT = 30.0
MIN_INTERVAL = 0.5  # at most 2 calls per second
CLOSE_TIMEOUT = 8.0
SERVER_LOG = "rnacentral-server.log"
SERVER_LOG_ENV = "RNAXRAY_EVIDENCE_SERVER_LOG"
# Variables we set for the child.  The SDK adds its own small allowlist
# (mcp.client.stdio.DEFAULT_INHERITED_ENV_VARS: HOME, PATH, ... / SYSTEMROOT,
# TEMP, ... on Windows) when present in the worker's environment.
CHILD_ENV = {
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUNBUFFERED": "1",
    "PYTHONIOENCODING": "utf-8",
    "PYTHONNOUSERSITE": "1",
}
# Passed through only when the worker itself has them (TLS trust overrides).
CHILD_ENV_PASSTHROUGH = ("SSL_CERT_FILE", "SSL_CERT_DIR")


class EvidenceClientError(Exception):
    """Base class; ``kind`` is one of connection, timeout, protocol, refused."""

    kind = "protocol"


class ConnectionLost(EvidenceClientError):
    kind = "connection"


class CallTimeout(EvidenceClientError):
    kind = "timeout"


class ToolRefused(EvidenceClientError):
    kind = "refused"


class DependencyMissing(EvidenceClientError):
    kind = "connection"


def mcp_available() -> bool:
    try:
        import mcp  # noqa: F401
        import mcp.client.stdio  # noqa: F401
    except ImportError:
        return False
    return True


def _is_connection_error(error: BaseException) -> bool:
    try:
        import anyio
        from mcp.shared.exceptions import McpError
        from mcp.types import CONNECTION_CLOSED
    except ImportError:  # pragma: no cover - checked before connecting
        return isinstance(error, (OSError, EOFError))
    if isinstance(error, McpError):
        return getattr(error.error, "code", None) == CONNECTION_CLOSED
    return isinstance(error, (OSError, EOFError, anyio.ClosedResourceError,
                              anyio.BrokenResourceError, anyio.EndOfStream))


def _set(future: asyncio.Future, value: Any = None, error: BaseException | None = None) -> None:
    if not future.done():
        if error is not None:
            future.set_exception(error)
        else:
            future.set_result(value)


class _Session:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.ready: asyncio.Future = loop.create_future()
        self.task: asyncio.Task | None = None
        self.tools: list[str] = []
        self.alive = True
        self.pid: int | None = None


class McpClient:
    def __init__(self, server_args: list[str] | None = None, *, call_timeout: float | None = None,
                 connect_timeout: float | None = None, min_interval: float | None = None,
                 log_dir: str | None = None, cwd: str | None = None):
        # server_args is for in-process tests only; the worker never passes it.
        self._server_args = list(server_args) if server_args is not None else list(SERVER_ARGS)
        self.call_timeout = CALL_TIMEOUT if call_timeout is None else call_timeout
        self.connect_timeout = CONNECT_TIMEOUT if connect_timeout is None else connect_timeout
        self.min_interval = MIN_INTERVAL if min_interval is None else min_interval
        self._log_dir = log_dir
        self._cwd = cwd or tempfile.gettempdir()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._session: _Session | None = None
        self._owners: set[asyncio.Task] = set()
        self._last_start = 0.0
        self._lock = threading.Lock()
        self._errlog = None
        self.tools: list[str] = []
        self.started_sessions = 0

    # ---- loop plumbing -------------------------------------------------
    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            self._loop = asyncio.new_event_loop()
            self._thread = threading.Thread(target=self._loop.run_forever, name="evidence-mcp", daemon=True)
            self._thread.start()
        return self._loop

    def _run(self, coroutine, timeout: float | None):
        future = asyncio.run_coroutine_threadsafe(coroutine, self._ensure_loop())
        return future.result(timeout)

    def _errlog_file(self):
        """The server's stderr: discarded, as it logs the identifiers queried
        (RNACENTRAL_MCP_TASK.md §8), unless RNAXRAY_EVIDENCE_SERVER_LOG=1 asks
        for it while debugging; then one session only, never appended."""
        if self._errlog is None:
            path = Path(self._log_dir) / SERVER_LOG if self._log_dir else None
            if path is not None and os.environ.get(SERVER_LOG_ENV) == "1":
                path.parent.mkdir(parents=True, exist_ok=True)
                self._errlog = open(path, "w", encoding="utf-8")
            else:
                if path is not None:
                    try:
                        path.unlink()  # one kept by an earlier version
                    except OSError:
                        pass
                self._errlog = open(os.devnull, "w", encoding="utf-8")
        return self._errlog

    def _child_env(self) -> dict[str, str]:
        env = dict(CHILD_ENV)
        for name in CHILD_ENV_PASSTHROUGH:
            if os.environ.get(name):
                env[name] = os.environ[name]
        return env

    # ---- session owner (runs on the loop thread) ----------------------
    async def _owner(self, session: _Session) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        params = StdioServerParameters(command=sys.executable, args=self._server_args,
                                       env=self._child_env(), cwd=self._cwd)
        failure: BaseException = ConnectionLost("MCP server connection closed")
        try:
            async with stdio_client(params, errlog=self._errlog_file()) as (read, write):
                async with ClientSession(read, write) as client:
                    await client.initialize()
                    listed = await client.list_tools()
                    session.tools = [tool.name for tool in listed.tools]
                    _set(session.ready, True)
                    while True:
                        item = await session.queue.get()
                        if item is None:
                            break
                        name, arguments, reply, timeout = item
                        try:
                            result = await asyncio.wait_for(client.call_tool(name, arguments), timeout)
                        except asyncio.TimeoutError:
                            # The call may still hold the server; start fresh next time.
                            session.alive = False
                            _set(reply, error=CallTimeout(f"no answer within {timeout:g} s"))
                            break
                        except Exception as error:  # noqa: BLE001
                            if _is_connection_error(error):
                                session.alive = False
                                _set(reply, error=ConnectionLost(f"MCP server connection lost: {error}"))
                                break
                            _set(reply, error=EvidenceClientError(f"MCP protocol error: {error.__class__.__name__}: {error}"))
                        else:
                            _set(reply, result)
        except asyncio.CancelledError:
            failure = ConnectionLost("MCP session cancelled")
        except BaseException as error:  # noqa: BLE001 - includes ExceptionGroup from anyio
            failure = ConnectionLost(f"MCP server unavailable: {error.__class__.__name__}: {error}")
        finally:
            session.alive = False
            _set(session.ready, error=failure)
            while not session.queue.empty():
                item = session.queue.get_nowait()
                if item is not None:
                    _set(item[2], error=failure)

    async def _open(self, connect_timeout: float) -> _Session:
        loop = asyncio.get_running_loop()
        session = _Session(loop)
        session.task = loop.create_task(self._owner(session))
        self._owners.add(session.task)
        session.task.add_done_callback(self._owners.discard)
        try:
            await asyncio.wait_for(asyncio.shield(session.ready), connect_timeout)
        except asyncio.TimeoutError:
            session.alive = False
            session.task.cancel()
            raise CallTimeout(f"MCP server did not start within {connect_timeout:g} s") from None
        return session

    async def _submit(self, session: _Session, name: str, arguments: dict, timeout: float) -> Any:
        reply = asyncio.get_running_loop().create_future()
        session.queue.put_nowait((name, arguments, reply, timeout))
        return await reply

    async def _close_all(self) -> None:
        if self._session is not None:
            self._session.queue.put_nowait(None)
        tasks = list(self._owners)
        if tasks:
            done, pending = await asyncio.wait(tasks, timeout=CLOSE_TIMEOUT)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.wait(pending, timeout=CLOSE_TIMEOUT)

    # ---- public synchronous API ---------------------------------------
    @property
    def connected(self) -> bool:
        return self._session is not None and self._session.alive

    def connect(self, timeout: float | None = None) -> list[str]:
        """Start the server if needed (within ``timeout``, at most
        CONNECT_TIMEOUT); return the tool names it lists."""
        if not mcp_available():
            raise DependencyMissing("evidence dependencies (mcp, rnacentral-mcp-server) are not installed")
        connect_timeout = self.connect_timeout if timeout is None else min(self.connect_timeout, timeout)
        with self._lock:
            if not self.connected:
                self._session = None
                self.tools = []
                session = self._run(self._open(connect_timeout), connect_timeout + CLOSE_TIMEOUT + 5)
                self._session = session
                self.started_sessions += 1
                self.tools = list(session.tools)
            return list(self.tools)

    def call_tool(self, name: str, arguments: dict, timeout: float | None = None) -> Any:
        """One bounded call, starting the server if needed, all within
        ``timeout`` when given (each part also within its own limit); raises
        EvidenceClientError subclasses on failure."""
        if name not in ALLOWED_TOOLS:
            raise ToolRefused(f"tool {name!r} is not allowed")
        deadline = None if timeout is None else time.monotonic() + timeout
        self.connect(timeout)
        if name not in self.tools:
            raise ToolRefused(f"tool {name!r} is not offered by the server")
        with self._lock:
            wait = self._last_start + self.min_interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last_start = time.monotonic()
            session = self._session
            if session is None or not session.alive:
                raise ConnectionLost("MCP server connection closed")
            call_timeout = self.call_timeout
            if deadline is not None:
                call_timeout = max(min(call_timeout, deadline - time.monotonic()), 0.1)
            try:
                return self._run(self._submit(session, name, dict(arguments), call_timeout), call_timeout + CLOSE_TIMEOUT + 5)
            except EvidenceClientError:
                raise
            except TimeoutError as error:  # concurrent.futures timeout: owner is stuck
                session.alive = False
                raise CallTimeout(f"no answer within {call_timeout:g} s") from error

    def close(self) -> None:
        """Close the session and reap the child; safe to call repeatedly."""
        with self._lock:
            if self._loop is not None:
                try:
                    self._run(self._close_all(), 2 * CLOSE_TIMEOUT + 5)
                except Exception:  # noqa: BLE001 - best effort at shutdown
                    pass
                self._loop.call_soon_threadsafe(self._loop.stop)
                if self._thread is not None:
                    self._thread.join(5)
                if not self._loop.is_running():
                    self._loop.close()
                self._loop = None
                self._thread = None
            self._session = None
            self.tools = []
            if self._errlog is not None:
                self._errlog.close()
                self._errlog = None

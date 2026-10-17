"""Test launcher: the real worker, with the MCP server command pointed at the
fake server.  The override exists only here (a module patch before serve());
nothing in the worker protocol can change the server command.

usage: run_worker.py STATE_DIR [CALL_TIMEOUT]
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from desktop.runtime.evidence import mcp_client, worker  # noqa: E402

mcp_client.SERVER_ARGS = ["-I", "-B", str(Path(__file__).with_name("fake_server.py")), "--state", sys.argv[1]]
if len(sys.argv) > 2:
    mcp_client.CALL_TIMEOUT = float(sys.argv[2])
sys.exit(worker.main(["--serve"]))

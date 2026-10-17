"""External evidence worker for RNAxRay Desktop (RNAcentral MCP client).

Contract: desktop/spec/EVIDENCE.md.  The worker is a separate process that
speaks RNAxRay's newline JSON to Go and the official MCP Python SDK (v1) to one
fixed RNAcentral MCP server child over stdio.  It receives public query
fields only and never reads project files.
"""

ADAPTER_VERSION = "rnaxray-evidence 1.0"
SCHEMA_VERSION = "1.0"
PROVIDER = "RNAcentral"

__all__ = ["ADAPTER_VERSION", "SCHEMA_VERSION", "PROVIDER"]

"""RNAcentral adapter: request validation, tool calls, classification, cards.

Classification follows desktop/spec/EVIDENCE.md in this order: local timeout /
cancel / protocol error -> MCP ``isError`` -> known texts of the pinned
rnacentral-mcp-server 0.1.1 -> empty or non-text -> success.  A 404 is never
reported as "no summary" and nothing is ever reported as "not studied".
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import importlib.metadata
import re
import time
import uuid
from typing import Any, Callable

from . import ADAPTER_VERSION, PROVIDER, SCHEMA_VERSION
from .mcp_client import ALLOWED_TOOLS, EvidenceClientError, McpClient, ToolRefused, mcp_available

# One request, retry included, ends within REQUEST_BUDGET seconds, before Go
# kills the worker (core.EvidenceTimeout, 45 s); the retry starts only with
# RETRY_MIN seconds left.
REQUEST_BUDGET = 40.0
RETRY_MIN = 10.0
from .store import EvidenceCache, cache_key

DESCRIBE_TOOL = "get_rna_description"
MAP_TOOL = "map_rna_id"
assert {DESCRIBE_TOOL, MAP_TOOL} == set(ALLOWED_TOOLS)

MAX_RAW_CHARS = 256 * 1024
# Public identifiers only (same rule as the Go shell): 1-100 characters of
# letters, digits and - _ . : |; taxon is 1-10 digits or a short name
# (letters, space, . and -, at most 64 characters).
_IDENTIFIER = re.compile(r"[A-Za-z0-9_.:|\-]{1,100}")
_TAXON = re.compile(r"[0-9]{1,10}|[A-Za-z .\-]{1,64}")
_URS = re.compile(r"(URS[0-9A-F]{10})(?:_(\d{1,10}))?")

# Texts of rnacentral-mcp-server 0.1.1 (literature.py / mapping.py).
_API_ERROR = "Error querying RNAcentral API:"
_HTTP_STATUS = re.compile(r"Error querying RNAcentral API: (\d{3}), message='([^']*)'")
_NO_DESCRIPTION = "No description available"
_CONNECTION_TEXT = re.compile(r"Cannot connect to host|Server disconnected|Connection reset|Connection refused"
                              r"|Temporary failure in name resolution|nodename nor servname|getaddrinfo failed"
                              r"|Network is unreachable", re.IGNORECASE)
_MAP_NOT_FOUND = ("No RNAcentral entry found for external ID:", "No cross-references found for",
                  "Could not determine a valid Taxon ID for")
_MAP_ERROR = "Error looking up external ID"
_MAP_OK = "# ID Mapping for"
_MAP_PRIMARY = re.compile(r"\*\*Primary ID\*\*: `(URS[0-9A-F]{10})_(\d+)`")
_MAP_TAXON = re.compile(r"\*\*NCBI Taxon ID\*\*: `(\d+)`")

_PMC = re.compile(r"\bPMC\d{3,10}\b")
_PMID = re.compile(r"\bPMID:?\s*(\d{1,9})\b")
_DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"'<>\]\[(){},;]+)")

REQUEST_FIELDS = {
    "status": {"operation", "connect"},
    "describe": {"operation", "rna_id", "taxon", "force", "identity_confirmation"},
    "map_id": {"operation", "identifier", "taxon", "identity_confirmation"},
    "shutdown": {"operation"},
}


def _version(package: str) -> str | None:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def versions() -> dict:
    return {"server_package_version": _version("rnacentral-mcp-server"),
            "sdk_version": _version("mcp"), "adapter_version": ADAPTER_VERSION}


def _now_iso(clock: Callable[[], float]) -> str:
    return _dt.datetime.fromtimestamp(clock(), _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def source_identifiers(text: str | None) -> list[str]:
    """PMC / PMID / DOI tokens that literally occur in the text, in order."""
    if not text:
        return []
    found: list[tuple[int, str]] = []
    found += [(m.start(), m.group(0)) for m in _PMC.finditer(text)]
    found += [(m.start(), "PMID:" + m.group(1)) for m in _PMID.finditer(text)]
    found += [(m.start(), m.group(1).rstrip(".:")) for m in _DOI.finditer(text)]
    seen, result = set(), []
    for _, token in sorted(found):
        if token not in seen:
            seen.add(token)
            result.append(token)
    return result


def source_url(identifier: str, mapped_text: str | None = None) -> str | None:
    """RNAcentral page for a URS identifier (query or mapping result), else None."""
    match = _URS.fullmatch(identifier)
    if match:
        return "https://rnacentral.org/rna/" + match.group(1) + ("/" + match.group(2) if match.group(2) else "")
    if mapped_text:
        primary = _MAP_PRIMARY.search(mapped_text)
        if primary:
            return "https://rnacentral.org/rna/%s/%s" % primary.groups()
    return None


def _check_fields(operation: str, request: dict) -> None:
    extra = sorted(set(request) - REQUEST_FIELDS[operation])
    if extra:
        raise ValueError("unexpected field(s) for %s: %s" % (operation, ", ".join(extra)))


def _identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value.strip()):
        raise ValueError(f"{name} must be a public identifier (1-100 letters, digits, - _ . : |)")
    return value.strip()


def _taxon(value: Any, required: bool) -> str | None:
    if value is None or value == "":
        if required:
            raise ValueError("taxon is required")
        return None
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        value = str(value)
    if not isinstance(value, str) or not _TAXON.fullmatch(value.strip()):
        raise ValueError("taxon must be 1-10 digits or a name of letters, space, . and - (at most 64)")
    return value.strip()


def _bool(value: Any, name: str) -> bool:
    if value is None:
        return False
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean")
    return value


def _tool_text(result: Any) -> tuple[str | None, list[str]]:
    """Joined text content (None if there is none) and the non-text kinds."""
    texts, other = [], []
    for item in getattr(result, "content", None) or []:
        if getattr(item, "type", None) == "text" and isinstance(getattr(item, "text", None), str):
            texts.append(item.text)
        else:
            other.append(str(getattr(item, "type", type(item).__name__)))
    return ("".join(texts) if texts else None), other


def classify_describe(text: str) -> tuple[str, str | None]:
    stripped = text.strip()
    if stripped.startswith(_API_ERROR):
        status = _HTTP_STATUS.match(stripped)
        if status and status.group(1) == "404":
            return "not_found_or_no_summary", "HTTP 404 Not Found"
        if status:
            return "upstream_error", ("HTTP %s %s" % (status.group(1), status.group(2))).strip()
        detail = stripped[len(_API_ERROR):].strip()
        return "upstream_error", ("RNAcentral request failed: " + detail)[:300] if detail else "RNAcentral request failed"
    if stripped == _NO_DESCRIPTION:
        return "summary_unavailable", None
    if not stripped:
        return "unexpected_response", "empty response"
    return "success", None


def classify_mapping(text: str, taxon: str | None) -> tuple[str, str | None]:
    stripped = text.strip()
    if not stripped:
        return "unexpected_response", "empty response"
    if stripped.startswith(_MAP_ERROR):
        return "upstream_error", stripped[:300]
    if stripped.startswith(_API_ERROR):
        return "upstream_error", stripped[:300]
    if stripped.startswith(_MAP_NOT_FOUND):
        return "not_found_or_no_summary", stripped.splitlines()[0][:300]
    if stripped.startswith(_MAP_OK):
        returned = _MAP_TAXON.search(stripped)
        if taxon and taxon.isdigit() and returned and returned.group(1) != taxon:
            return "success", f"returned taxon {returned.group(1)} differs from requested {taxon}"
        return "success", None
    return "unexpected_response", "unrecognised mapping text"


def _retryable_text(text: str) -> bool:
    stripped = text.strip()
    return (stripped.startswith((_API_ERROR, _MAP_ERROR)) and not _HTTP_STATUS.match(stripped)
            and bool(_CONNECTION_TEXT.search(stripped)))


class EvidenceService:
    def __init__(self, client: McpClient | None = None, cache: EvidenceCache | None = None,
                 clock: Callable[[], float] = time.time, log: Callable[[dict], None] | None = None):
        self.client = client or McpClient()
        self.cache = cache or EvidenceCache(None)
        self.clock = clock
        self.log = log or (lambda record: None)
        self.tool_calls = 0
        self.budget = REQUEST_BUDGET
        self.retry_min = RETRY_MIN

    # ---- operations -----------------------------------------------------
    def status(self, request: dict) -> dict:
        _check_fields("status", request)
        connect = _bool(request.get("connect"), "connect")
        response = {"ok": True, **versions()}
        if connect:
            try:
                self.client.connect()
            except EvidenceClientError as error:
                response.update(ok=False, error=str(error))
        response["connected"] = self.client.connected
        response["tools"] = sorted(t for t in self.client.tools if t in ALLOWED_TOOLS)
        return response

    def describe(self, request: dict) -> dict:
        _check_fields("describe", request)
        rna_id = _identifier(request.get("rna_id"), "rna_id")
        taxon = _taxon(request.get("taxon"), required=False)
        force = _bool(request.get("force"), "force")
        confirmation = request.get("identity_confirmation")
        meta = versions()
        key = cache_key(PROVIDER, DESCRIBE_TOOL, rna_id, taxon, meta["server_package_version"], ADAPTER_VERSION)
        requested_at = _now_iso(self.clock)
        if not force:
            hit = self.cache.get(key)
            if hit is not None:
                status, detail = classify_describe(hit["raw_text"])
                card = self._card(DESCRIBE_TOOL, rna_id, taxon, confirmation, requested_at, hit["retrieved_at"],
                                  status, detail, hit["raw_text"], "external_ai_summary", meta)
                self.log({"operation": "describe", "status": status, "cached": True})
                return {"ok": True, "card": card, "raw_text": hit["raw_text"], "cached": True}
        status, detail, raw, retrieved_at = self._call(DESCRIBE_TOOL, {"rna_id": rna_id}, classify_describe)
        if raw is not None and status in ("success", "summary_unavailable", "not_found_or_no_summary"):
            try:
                self.cache.put(key, raw, retrieved_at)
            except OSError:
                pass
        card = self._card(DESCRIBE_TOOL, rna_id, taxon, confirmation, requested_at, retrieved_at,
                          status, detail, raw, "external_ai_summary", meta)
        return {"ok": True, "card": card, "raw_text": raw, "cached": False}

    def map_id(self, request: dict) -> dict:
        _check_fields("map_id", request)
        identifier = _identifier(request.get("identifier"), "identifier")
        taxon = _taxon(request.get("taxon"), required=True)
        confirmation = request.get("identity_confirmation")
        meta = versions()
        requested_at = _now_iso(self.clock)
        status, detail, raw, retrieved_at = self._call(
            MAP_TOOL, {"identifier": identifier, "taxon": taxon}, lambda text: classify_mapping(text, taxon))
        card = self._card(MAP_TOOL, identifier, taxon, confirmation, requested_at, retrieved_at,
                          status, detail, raw, "database_metadata", meta)
        return {"ok": True, "card": card, "raw_text": raw, "cached": False}

    def close(self) -> None:
        self.client.close()

    # ---- internals ------------------------------------------------------
    def _call(self, tool: str, arguments: dict, classify) -> tuple[str, str | None, str | None, str | None]:
        """Returns (status, detail, raw_text or None, retrieved_at or None)."""
        started = time.monotonic()
        deadline = started + self.budget
        outcome: tuple[str, str | None, str | None, str | None] = ("unexpected_response", "no call made", None, None)
        for attempt in (1, 2):
            retry = False
            self.tool_calls += 1
            try:
                result = self.client.call_tool(tool, arguments, timeout=max(deadline - time.monotonic(), 0.1))
            except ToolRefused as error:
                outcome = ("unexpected_response", str(error), None, None)
            except EvidenceClientError as error:
                if error.kind == "timeout":
                    outcome = ("timeout", str(error), None, None)
                elif error.kind == "connection":
                    # The MCP server is a process on this computer; RNAcentral's
                    # own (network) errors come back as tool text.
                    outcome = ("local_error", str(error), None, None)
                    retry = True
                else:
                    outcome = ("unexpected_response", str(error), None, None)
            else:
                retrieved_at = _now_iso(self.clock)
                text, other = _tool_text(result)
                raw = text if text is not None else ""
                if getattr(result, "isError", False):
                    outcome = ("upstream_error", ("MCP tool error: " + raw.strip())[:300] if raw.strip() else "MCP tool error",
                               raw, retrieved_at)
                elif text is None or other:
                    # Only plain text is understood; text mixed with other
                    # content is not shown as a summary either.
                    kinds = ", ".join(other) if other else "no content"
                    outcome = ("unexpected_response", "non-text response (%s)" % kinds, raw, retrieved_at)
                elif len(text) > MAX_RAW_CHARS:
                    outcome = ("unexpected_response", "response larger than %d characters" % MAX_RAW_CHARS,
                               text[:MAX_RAW_CHARS], retrieved_at)
                else:
                    status, detail = classify(text)
                    outcome = (status, detail, text, retrieved_at)
                    retry = status == "upstream_error" and _retryable_text(text)
            if not retry or deadline - time.monotonic() < self.retry_min:
                break
        self.log({"operation": tool, "status": outcome[0], "attempts": attempt,
                  "seconds": round(time.monotonic() - started, 2)})
        return outcome

    def _card(self, tool, identifier, taxon, confirmation, requested_at, retrieved_at, status, detail,
              raw, content_kind, meta) -> dict:
        shown = raw if raw is not None and (status == "success" or content_kind == "database_metadata") else None
        return {
            "schema_version": SCHEMA_VERSION,
            "evidence_id": "ev-" + uuid.uuid4().hex,
            "source_provider": PROVIDER,
            "source_tool": tool,
            "adapter_version": ADAPTER_VERSION,
            "server_package_version": meta["server_package_version"],
            "sdk_version": meta["sdk_version"],
            "query_identifier": identifier,
            "taxon": taxon,
            "identity_confirmation": "user_confirmed" if confirmation == "user_confirmed" else "unconfirmed",
            "requested_at": requested_at,
            "retrieved_at": retrieved_at,
            "status": status,
            "status_detail": detail,
            "content_kind": content_kind,
            "display_text": shown,
            "raw_response_digest": None if raw is None else "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            "raw_response_local_ref": None,
            "source_identifiers": source_identifiers(raw) if shown is not None else [],
            "citation_verification": "not_checked",
            "relation_to_current_structure": "background_only",
            "review": {"state": "unreviewed", "reviewer": None, "at": None},
            "source_url": source_url(identifier, raw if content_kind == "database_metadata" else None),
            "binding": None,
        }


def dependencies_available() -> bool:
    return mcp_available()

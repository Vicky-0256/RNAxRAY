"""Raw-response cache for the evidence worker (``RNAXRAY_EVIDENCE_CACHE``).

Entries are keyed by (provider, tool, query_identifier, taxon,
server_package_version, adapter_version) and expire after seven days.  Only
the raw tool text and its retrieval time are kept; cards are rebuilt from it
so every answer gets a fresh evidence_id and requested_at.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from typing import Callable

TTL_SECONDS = 7 * 24 * 3600
_PREFIX = "rnac-"
_SUFFIX = ".json"
# A clock that jumps backwards must not keep an entry alive forever.
_FUTURE_SLACK = 300


def cache_key(provider: str, tool: str, query_identifier: str, taxon: str | None,
              server_package_version: str | None, adapter_version: str) -> list:
    return [provider, tool, query_identifier, taxon, server_package_version, adapter_version]


class EvidenceCache:
    def __init__(self, root: str | os.PathLike | None, ttl: float = TTL_SECONDS,
                 clock: Callable[[], float] = time.time):
        self.root = Path(root) if root else None
        self.ttl = ttl
        self.clock = clock

    @property
    def enabled(self) -> bool:
        return self.root is not None

    def _path(self, key: list) -> Path:
        digest = hashlib.sha256(json.dumps(key, separators=(",", ":")).encode("utf-8")).hexdigest()
        assert self.root is not None
        return self.root / (_PREFIX + digest + _SUFFIX)

    def get(self, key: list) -> dict | None:
        """Return ``{"raw_text", "retrieved_at"}`` for a live entry, else None."""
        if self.root is None:
            return None
        path = self._path(key)
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        now = self.clock()
        stored = entry.get("stored_at") if isinstance(entry, dict) else None
        if (not isinstance(stored, (int, float)) or entry.get("key") != key
                or not isinstance(entry.get("raw_text"), str)
                or stored > now + _FUTURE_SLACK or now - stored >= self.ttl):
            try:
                path.unlink()
            except OSError:
                pass
            return None
        return {"raw_text": entry["raw_text"], "retrieved_at": entry.get("retrieved_at")}

    def put(self, key: list, raw_text: str, retrieved_at: str | None) -> None:
        if self.root is None:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.root, 0o700)
        except OSError:
            pass
        entry = {"key": key, "raw_text": raw_text, "retrieved_at": retrieved_at,
                 "stored_at": self.clock()}
        fd, temp = tempfile.mkstemp(prefix=".tmp-", dir=self.root)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(entry, handle, ensure_ascii=False)
            os.replace(temp, self._path(key))
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise

    def clear(self) -> int:
        """Delete every cache entry this module wrote; returns the count."""
        if self.root is None or not self.root.is_dir():
            return 0
        removed = 0
        for path in self.root.iterdir():
            name = path.name
            if path.is_file() and ((name.startswith(_PREFIX) and name.endswith(_SUFFIX))
                                   or name.startswith(".tmp-")):
                try:
                    path.unlink()
                    removed += 1
                except OSError:
                    pass
        return removed

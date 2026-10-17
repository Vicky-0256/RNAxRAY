"""Files a project links outside its folder (F5).

project.json may name any absolute path (linked references and reads, an
index). A project folder can come from another computer, so such a file is
opened only when it was linked on this computer, or the user allowed it
after seeing the list. The desktop app passes its per-computer list as
RNAXRAY_TRUSTED_LINKS (a JSON file beside the preferences); without it (tests,
command line) nothing is checked.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set

from .project import _atomic_write_json, _file_lock, is_absolute_path

ENV = "RNAXRAY_TRUSTED_LINKS"


class UntrustedLink(ValueError):
    """An absolute path outside the project that this computer did not link."""


def _store() -> Optional[Path]:
    value = os.environ.get(ENV)
    return Path(value) if value else None


def _real(path: Any) -> str:
    return os.path.realpath(os.path.expanduser(str(path)))


def _load(store: Path) -> Set[str]:
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    paths = data.get("paths") if isinstance(data, dict) else None
    return {p for p in paths if isinstance(p, str)} if isinstance(paths, list) else set()


def _inside(root: Path, real: str) -> bool:
    base = _real(root)
    return real == base or real.startswith(base.rstrip(os.sep) + os.sep)


def is_trusted(root: Path, path: Any) -> bool:
    store = _store()
    if store is None:
        return True
    real = _real(path)
    return _inside(root, real) or real in _load(store)


def require(root: Path, path: Any, label: str) -> None:
    """Raise UntrustedLink unless ``path`` may be opened."""
    if not is_trusted(root, path):
        raise UntrustedLink(f"{label} is outside the project and was not linked on this computer: {path}. "
                            "Allow it on the Data page if you trust where this project came from")


def trust(paths: Iterable[Any]) -> None:
    """Record ``paths`` as linked on this computer."""
    store = _store()
    new = {_real(p) for p in paths}
    if store is None or not new:
        return
    store.parent.mkdir(parents=True, exist_ok=True)
    with _file_lock(store.with_name(store.name + ".lock")):
        known = _load(store)
        if new <= known:
            return
        _atomic_write_json(store, {"version": 1, "paths": sorted(known | new)})


def linked_files(manifest: Dict[str, Any]) -> Dict[str, List[str]]:
    """Absolute paths the manifest names → what uses them."""
    out: Dict[str, List[str]] = {}

    def add(value: Any, user: str) -> None:
        if isinstance(value, str) and value and is_absolute_path(value):
            out.setdefault(value, []).append(user)

    for reference in manifest.get("references") or []:
        if isinstance(reference, dict) and reference.get("mode") != "copied":
            add(reference.get("path"), "reference " + str(reference.get("id")))
    for sample in manifest.get("samples") or []:
        if not isinstance(sample, dict):
            continue
        reads = sample.get("reads") if isinstance(sample.get("reads"), dict) else {}
        if reads.get("mode") != "copied":
            add(reads.get("path"), "sample " + str(sample.get("id")) + " reads")
        outputs = sample.get("outputs") if isinstance(sample.get("outputs"), dict) else {}
        for key, value in outputs.items():
            add(value, "sample " + str(sample.get("id")) + " " + str(key))
    return out


def untrusted(root: Path, manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The manifest's absolute files that may not be opened, with their users."""
    if _store() is None:
        return []
    return [{"path": _real(path), "used_by": users} for path, users in sorted(linked_files(manifest).items())
            if not is_trusted(root, path)]

"""References and samples (project schema 2.0, contract R2).

Raw data is *linked* by default: the manifest records the absolute path, size,
mtime and a quick fingerprint (``quick_hash`` = SHA-256 of the decimal size,
a newline, the first MiB and the last MiB).  The full SHA-256 is optional and
computed later by :func:`hash_inputs`, which is suitable for a background task.
*Copied* files are copied into ``inputs/`` under a temporary name while no
manifest lock is held and are renamed into place under the lock.

Every mutation goes through :func:`project._mutate_manifest` (locked
read-modify-write with an atomic replace); slow work (hashing, copying,
reading FASTA) always happens before the lock is taken.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .project import (_ID, _mutate_manifest, _now, READ_FORMATS, STAGE_NAMES, copy_into_project, is_absolute_path,
                      load_manifest, safe_relative_path, validate_project_directory)
from . import trust as _trust

MiB = 1024 * 1024
# Bounded so that a hostile project cannot make the runtime hash forever per call.
_MAX_SETTINGS_BYTES = 64_000

# Suffix -> read format; longest suffix first so ".fastq.gz" wins over ".gz".
_READ_SUFFIXES = (
    (".fastq.gz", "fastq.gz"), (".fq.gz", "fastq.gz"), (".fasta.gz", "fasta.gz"), (".fa.gz", "fasta.gz"),
    (".fastq", "fastq"), (".fq", "fastq"), (".fasta", "fasta"), (".fa", "fasta"), (".sam", "sam"), (".hyb", "hyb"),
)
_REFERENCE_SUFFIXES = (".fasta", ".fa", ".fna", ".fasta.gz", ".fa.gz", ".fna.gz")

ByteProgress = Callable[[str, str, Optional[int], Optional[int]], None]


class SampleSheetError(ValueError):
    """A sample sheet could not be imported; ``errors`` lists every problem."""

    def __init__(self, errors: List[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


# --------------------------------------------------------------------------- files

def quick_hash(path: Path, size: Optional[int] = None) -> str:
    """sha256(str(size) + "\\n" + first 1 MiB + last 1 MiB) as hex."""
    path = Path(path)
    if size is None:
        size = path.stat().st_size
    digest = hashlib.sha256(b"%d\n" % size)
    with path.open("rb") as handle:
        digest.update(handle.read(MiB))
        handle.seek(max(0, size - MiB))
        digest.update(handle.read(MiB))
    return digest.hexdigest()


def sha256_with_progress(path: Path, progress: Optional[Callable[[int, int], None]] = None) -> str:
    path = Path(path)
    total = path.stat().st_size
    digest = hashlib.sha256()
    done = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * MiB), b""):
            digest.update(chunk)
            done += len(chunk)
            if progress is not None:
                progress(done, total)
    return digest.hexdigest()


def detect_read_format(path: Path) -> str:
    """fastq | fastq.gz | fasta | fasta.gz | sam | hyb, from the file name."""
    name = Path(path).name.lower()
    for suffix, fmt in _READ_SUFFIXES:
        if name.endswith(suffix):
            return fmt
    raise ValueError("unrecognised read file type (expected .fastq/.fq/.fasta/.fa[.gz], .sam or .hyb): %s" % Path(path).name)


def read_stem(path: Path) -> str:
    """File name without its read/reference suffix (``ZAFR_REP1.fastq.gz`` -> ``ZAFR_REP1``)."""
    name = Path(path).name
    lower = name.lower()
    for suffix in [s for s, _ in _READ_SUFFIXES] + list(_REFERENCE_SUFFIXES) + [".gz"]:
        if lower.endswith(suffix) and len(name) > len(suffix):
            return name[: -len(suffix)]
    return name


def _open_text(path: Path):
    with Path(path).open("rb") as probe:
        magic = probe.read(2)
    if magic == b"\x1f\x8b":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def _rnaxray_reference_name(header: str) -> str:
    # Same renaming as rnaxraypipe.inputs.format_reference (fasta_rnaxray_formatting).
    line = header.replace("_", "-").replace("protein-coding", "mRNA").replace("|", "_")
    return line.replace("__", "_unknown_")


def read_fasta_sequences(path: Path) -> List[Dict[str, Any]]:
    """Sequence names (first header word) and lengths of a FASTA(.gz) file.

    When the reference uses rnaxray ``|``-separated headers the names are reported
    the way the pipeline rewrites them (and ``unknown``/``pseudogene`` records,
    which the pipeline drops, are omitted), so they match .hyb gene IDs.
    """
    headers: List[str] = []
    lengths: List[int] = []
    with _open_text(path) as handle:
        for raw in handle:
            line = raw.rstrip("\r\n")
            if line.startswith(">"):
                headers.append(line[1:].strip()); lengths.append(0)
            elif headers:
                lengths[-1] += len(line.strip())
            elif line.strip():
                raise ValueError("reference is not a FASTA file: %s" % Path(path).name)
    if not headers:
        raise ValueError("reference FASTA contains no sequences: %s" % Path(path).name)
    formatted = any("|" in header for header in headers)
    sequences = []
    for header, length in zip(headers, lengths):
        if formatted:
            name = _rnaxray_reference_name(header).split()[0] if header else ""
            if "unknown" in name or "pseudogene" in name:
                continue
        else:
            name = header.split()[0] if header else ""
        sequences.append({"name": name, "length": length})
    return sequences


def _mtime(stat: os.stat_result) -> float:
    return round(stat.st_mtime, 6)


def resolve_record_path(root: Path, record: Dict[str, Any]) -> Path:
    """Absolute path of a linked/copied file record (copied paths stay inside ``root``)."""
    path = record.get("path")
    if record.get("mode") == "copied":
        if not safe_relative_path(path):
            raise ValueError("copied file path must be project-relative")
        return Path(root) / str(path).replace("\\", "/")
    if not is_absolute_path(path):
        raise ValueError("linked file path must be absolute")
    _trust.require(Path(root), path, "linked file")
    return Path(path)


def check_record(root: Path, record: Dict[str, Any]) -> Tuple[str, str]:
    """``("ok"|"missing"|"changed", detail)`` for a linked/copied file record."""
    try:
        path = resolve_record_path(root, record)
        stat = path.stat()
    except _trust.UntrustedLink:
        return "unconfirmed", "linked on another computer: not opened until you allow it"
    except (OSError, ValueError):
        return "missing", "file not found"
    if not path.is_file():
        return "missing", "not a regular file"
    if stat.st_size != record.get("size_bytes"):
        return "changed", "size changed from %s to %d bytes" % (record.get("size_bytes"), stat.st_size)
    if abs(_mtime(stat) - float(record.get("mtime") or 0)) > 1e-3:
        try:
            current = quick_hash(path, stat.st_size)
        except OSError as error:
            return "missing", "cannot read file: %s" % error
        if current != record.get("quick_hash"):
            return "changed", "content fingerprint changed"
        return "ok", "modification time changed but the content fingerprint matches"
    return "ok", ""


class _Prepared:
    """A file record computed outside the lock; ``finalize`` runs under it."""

    def __init__(self, source: Path, mode: str, record: Dict[str, Any], temp: Optional[Path] = None):
        self.source, self.mode, self.record, self.temp = source, mode, record, temp

    def finalize(self, root: Path) -> Dict[str, Any]:
        if self.temp is not None:
            stem = re.sub(r"[^A-Za-z0-9._-]+", "_", self.source.name).strip("._") or "input"
            destination = Path(root) / "inputs" / stem
            if destination.exists():
                destination = destination.with_name(read_stem(Path(stem)) + "-" + uuid.uuid4().hex[:8] + stem[len(read_stem(Path(stem))):])
            os.replace(self.temp, destination)
            self.temp = None
            self.record["path"] = destination.relative_to(root).as_posix()
        return self.record

    def discard(self) -> None:
        if self.temp is not None and self.temp.exists():
            self.temp.unlink()
        self.temp = None


def _prepare_file(root: Path, source: Path, mode: str, *, fmt: Optional[str] = None) -> _Prepared:
    """Stat/fingerprint (linked) or copy+hash (copied) ``source``; holds no lock."""
    if mode not in ("linked", "copied"):
        raise ValueError("mode must be linked or copied")
    root = Path(root).resolve()
    source = Path(source).expanduser().resolve()
    if not source.is_file():
        raise ValueError("file does not exist: %s" % source)
    record: Dict[str, Any] = {}
    if fmt is not None:
        record["format"] = fmt
    if root in source.parents:
        # Already inside the project (e.g. a legacy inputs/ copy): reference it in place.
        relative = source.relative_to(root).as_posix()
        if not safe_relative_path(relative):
            raise ValueError("project file path is unsafe: %s" % relative)
        stat = source.stat()
        record.update({"path": relative, "mode": "copied", "size_bytes": stat.st_size, "mtime": _mtime(stat),
                       "quick_hash": quick_hash(source, stat.st_size), "sha256": None})
        return _Prepared(source, "copied", record)
    if mode == "linked":
        stat = source.stat()
        record.update({"path": str(source), "mode": "linked", "size_bytes": stat.st_size, "mtime": _mtime(stat),
                       "quick_hash": quick_hash(source, stat.st_size), "sha256": None})
        return _Prepared(source, mode, record)
    temp, digest = copy_into_project(root, source, "inputs")
    stat = temp.stat()
    record.update({"path": None, "mode": "copied", "size_bytes": stat.st_size, "mtime": _mtime(stat),
                   "quick_hash": quick_hash(temp, stat.st_size), "sha256": digest})
    return _Prepared(source, mode, record, temp)


# --------------------------------------------------------------------------- ids

def _slug_id(name: str, taken: Iterable[str], prefix: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._-")
    if not base or not base[0].isalpha():
        base = prefix + "-" + base if base else prefix
    base = base[:56]
    taken = set(taken)
    candidate, counter = base, 2
    while candidate in taken or not _ID.match(candidate):
        candidate = "%s-%d" % (base, counter)
        counter += 1
        if counter > 10000:
            candidate = prefix + "-" + uuid.uuid4().hex[:12]
            break
    return candidate


def _find(items: List[Dict[str, Any]], item_id: Any, kind: str) -> Dict[str, Any]:
    for item in items:
        if item.get("id") == item_id:
            return item
    raise ValueError("%s does not exist: %s" % (kind, item_id))


def _same_file(record: Dict[str, Any], other: Dict[str, Any]) -> bool:
    if record.get("mode") == other.get("mode") and record.get("path") == other.get("path"):
        return True
    return record.get("size_bytes") == other.get("size_bytes") and record.get("quick_hash") == other.get("quick_hash")


def _default_stages(fmt: str) -> Dict[str, Dict[str, Any]]:
    stages = {name: {"status": "pending", "task_id": None, "updated_at": None} for name in STAGE_NAMES}
    if fmt in ("sam", "hyb"):
        stages["map"]["status"] = "skipped"
    if fmt == "hyb":
        stages["hyb"]["status"] = "skipped"
    return stages


def _check_settings(settings: Any) -> Dict[str, Any]:
    if settings is None:
        return {}
    if not isinstance(settings, dict):
        raise ValueError("settings must be an object")
    if len(json.dumps(settings)) > _MAX_SETTINGS_BYTES:
        raise ValueError("settings are too large")
    return settings


def _check_metadata(metadata: Any) -> Dict[str, Any]:
    if metadata is None:
        return {}
    if not isinstance(metadata, dict) or any(not isinstance(value, (str, int, float, bool, type(None))) for value in metadata.values()):
        raise ValueError("metadata must be an object of scalar values")
    if len(json.dumps(metadata)) > _MAX_SETTINGS_BYTES:
        raise ValueError("metadata is too large")
    return {str(key): value for key, value in metadata.items()}


def _project_root(root: Path) -> Path:
    root = Path(root).expanduser().resolve()
    errors = validate_project_directory(root)
    if errors:
        raise ValueError("invalid project: " + "; ".join(errors))
    return root


def _source_from_input(root: Path, input_id: Any) -> Path:
    manifest = load_manifest(root)
    item = _find(manifest.get("inputs", []), input_id, "input")
    if not safe_relative_path(item.get("path")):
        raise ValueError("input path is unsafe")
    return root / item["path"]


# --------------------------------------------------------------------------- references

def _prepare_reference(root: Path, source: Path, mode: str, label: str) -> Tuple[_Prepared, Dict[str, Any]]:
    source = Path(source).expanduser().resolve()
    if not source.is_file():
        raise ValueError("reference file does not exist: %s" % source)
    sequences = read_fasta_sequences(source)  # before copying: fail fast on a non-FASTA
    prepared = _prepare_file(root, source, mode)
    extra = {"label": (label or read_stem(source))[:200], "sequences": sequences}
    return prepared, extra


def _register_reference(manifest: Dict[str, Any], root: Path, prepared: _Prepared, extra: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
    for existing in manifest["references"]:
        if _same_file(prepared.record, existing):
            prepared.discard()
            return existing, True
    record = prepared.finalize(root)
    reference = {"id": _slug_id(extra["label"], [r.get("id") for r in manifest["references"]], "ref"), "label": extra["label"]}
    reference.update({key: record[key] for key in ("path", "mode", "size_bytes", "mtime", "quick_hash", "sha256")})
    reference["sequences"] = extra["sequences"]
    manifest["references"].append(reference)
    return reference, False


def add_reference(root: Path, source: Optional[Path] = None, *, input_id: Any = None, label: str = "", mode: str = "linked") -> Dict[str, Any]:
    """Register a reference FASTA(.gz); returns ``{"reference": ..., "existing": bool}``."""
    root = _project_root(root)
    if source is None:
        if input_id is None:
            raise ValueError("reference source or input_id is required")
        source = _source_from_input(root, input_id)
    prepared, extra = _prepare_reference(root, Path(source), mode, label)
    try:
        reference, existing = _mutate_manifest(root, lambda manifest: _register_reference(manifest, root, prepared, extra))
    finally:
        prepared.discard()
    return {"reference": reference, "existing": existing}


def update_reference(root: Path, reference_id: str, *, label: Any = None, source: Optional[Path] = None) -> Dict[str, Any]:
    """Rename a reference or relocate it to ``source`` (re-reads sequences, resets sha256)."""
    root = _project_root(root)
    prepared = extra = None
    if source is not None:
        prepared, extra = _prepare_reference(root, Path(source), "linked", "")

    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        reference = _find(manifest["references"], reference_id, "reference")
        if label is not None:
            if not isinstance(label, str) or not label.strip():
                raise ValueError("label must be a non-empty string")
            reference["label"] = label.strip()[:200]
        if prepared is not None:
            record = prepared.finalize(root)
            reference.update({key: record[key] for key in ("path", "mode", "size_bytes", "mtime", "quick_hash", "sha256")})
            reference["sequences"] = extra["sequences"]
        return reference
    return _mutate_manifest(root, mutate)


def remove_reference(root: Path, reference_id: str) -> Dict[str, Any]:
    root = _project_root(root)

    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        reference = _find(manifest["references"], reference_id, "reference")
        users = [s["id"] for s in manifest["samples"] if s.get("reference_id") == reference_id]
        if users:
            raise ValueError("reference is used by samples: " + ", ".join(users))
        manifest["references"].remove(reference)
        return reference
    return _mutate_manifest(root, mutate)


# --------------------------------------------------------------------------- samples

def _default_gene_id(reference: Optional[Dict[str, Any]]) -> Optional[str]:
    if reference and len(reference.get("sequences") or []) == 1:
        return reference["sequences"][0]["name"]
    return None


def _new_sample(manifest: Dict[str, Any], record: Dict[str, Any], *, name: str, condition: Any, replicate: Any,
                reference_id: Any, gene_id: Any, settings: Dict[str, Any], metadata: Dict[str, Any]) -> Dict[str, Any]:
    reference = _find(manifest["references"], reference_id, "reference") if reference_id is not None else None
    if gene_id is None:
        gene_id = _default_gene_id(reference)
    sample = {
        "id": _slug_id(name, [s.get("id") for s in manifest["samples"]], "sample"),
        "name": name, "condition": condition, "replicate": replicate,
        "reference_id": reference_id, "gene_id": gene_id,
        "reads": {key: record[key] for key in ("path", "mode", "format", "size_bytes", "mtime", "quick_hash", "sha256")},
        "settings": settings,
        "outputs": {"hyb": None, "homodimers": None, "stats": None, "contact": None, "index": None},
        "stages": _default_stages(record["format"]),
        "created_at": _now(),
    }
    if record["format"] == "hyb" and record["mode"] == "copied":
        sample["outputs"]["hyb"] = record["path"]
    if metadata:
        sample["metadata"] = metadata
    manifest["samples"].append(sample)
    return sample


def _check_sample_fields(name: Any, condition: Any, replicate: Any, gene_id: Any) -> None:
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise ValueError("sample name must be a non-empty string (max 200 characters)")
    if condition is not None and (not isinstance(condition, str) or len(condition) > 200):
        raise ValueError("condition must be a string or null")
    if replicate is not None and (type(replicate) is not int or replicate < 1):
        raise ValueError("replicate must be a positive integer or null")
    if gene_id is not None and (not isinstance(gene_id, str) or not gene_id or len(gene_id) > 500):
        raise ValueError("gene_id must be a non-empty string or null")


def add_sample(root: Path, source: Optional[Path] = None, *, input_id: Any = None, name: Any = None, condition: Any = None,
               replicate: Any = None, reference_id: Any = None, reference: Optional[Path] = None, gene_id: Any = None,
               mode: str = "linked", settings: Any = None, metadata: Any = None) -> Dict[str, Any]:
    """Register one sample (reads file + reference); ``reference`` (a path) is auto-registered."""
    root = _project_root(root)
    if source is None:
        if input_id is None:
            raise ValueError("sample source or input_id is required")
        source = _source_from_input(root, input_id)
    source = Path(source).expanduser().resolve()
    fmt = detect_read_format(source)
    name = name if name is not None else read_stem(source)
    _check_sample_fields(name, condition, replicate, gene_id)
    settings, metadata = _check_settings(settings), _check_metadata(metadata)
    if reference is not None and reference_id is not None:
        raise ValueError("pass either reference_id or reference, not both")
    reference_prep = _prepare_reference(root, Path(reference), "linked", "") if reference is not None else None
    prepared = _prepare_file(root, source, mode, fmt=fmt)

    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        ref_id = reference_id
        if reference_prep is not None:
            ref_id = _register_reference(manifest, root, *reference_prep)[0]["id"]
        if ref_id is not None:
            _find(manifest["references"], ref_id, "reference")
        record = prepared.finalize(root)
        return _new_sample(manifest, record, name=name.strip(), condition=condition, replicate=replicate,
                           reference_id=ref_id, gene_id=gene_id, settings=settings, metadata=metadata)
    try:
        return _mutate_manifest(root, mutate)
    finally:
        prepared.discard()
        if reference_prep is not None:
            reference_prep[0].discard()


_UPDATABLE = ("name", "condition", "replicate", "reference_id", "gene_id", "settings", "metadata")


def update_sample(root: Path, sample_id: str, changes: Dict[str, Any]) -> Dict[str, Any]:
    """Edit sample fields; ``reads_path`` relinks the raw file, ``reset_stages`` clears progress."""
    root = _project_root(root)
    if not isinstance(changes, dict):
        raise ValueError("changes must be an object")
    unknown = set(changes) - set(_UPDATABLE) - {"reads_path", "reset_stages"}
    if unknown:
        raise ValueError("cannot update sample fields: " + ", ".join(sorted(unknown)))
    prepared = None
    if changes.get("reads_path") is not None:
        new_source = Path(str(changes["reads_path"])).expanduser().resolve()
        prepared = _prepare_file(root, new_source, "linked", fmt=detect_read_format(new_source))
    settings = _check_settings(changes["settings"]) if "settings" in changes else None
    metadata = _check_metadata(changes["metadata"]) if "metadata" in changes else None

    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        sample = _find(manifest["samples"], sample_id, "sample")
        merged = {key: changes.get(key, sample.get(key)) for key in ("name", "condition", "replicate", "gene_id")}
        _check_sample_fields(merged["name"], merged["condition"], merged["replicate"], merged["gene_id"])
        if "reference_id" in changes and changes["reference_id"] is not None:
            _find(manifest["references"], changes["reference_id"], "reference")
        for key in ("name", "condition", "replicate", "reference_id", "gene_id"):
            if key in changes:
                sample[key] = changes[key].strip() if key == "name" else changes[key]
        if settings is not None:
            sample["settings"] = settings
        if metadata is not None:
            sample["metadata"] = metadata
        if prepared is not None:
            record = prepared.finalize(root)
            sample["reads"] = {key: record[key] for key in ("path", "mode", "format", "size_bytes", "mtime", "quick_hash", "sha256")}
        if changes.get("reset_stages") is True or prepared is not None:
            sample["stages"] = _default_stages(sample["reads"]["format"])
        return sample
    try:
        return _mutate_manifest(root, mutate)
    finally:
        if prepared is not None:
            prepared.discard()


def remove_sample(root: Path, sample_id: str, *, delete_outputs: bool = False) -> Dict[str, Any]:
    """Drop a sample from the manifest; optionally delete ``samples/<id>/``. Raw files are never deleted."""
    root = _project_root(root)

    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        sample = _find(manifest["samples"], sample_id, "sample")
        manifest["samples"].remove(sample)
        return sample
    sample = _mutate_manifest(root, mutate)
    deleted = False
    if delete_outputs:
        target = root / "samples" / sample["id"]
        samples_dir = root / "samples"
        if target.is_dir() and not target.is_symlink() and not samples_dir.is_symlink() and target.resolve().parent == samples_dir.resolve():
            shutil.rmtree(target)
            deleted = True
    return {"sample": sample, "outputs_deleted": deleted}


def set_sample_stage(root: Path, sample_id: str, stage: str, status: str, *, task_id: Optional[str] = None,
                     outputs: Optional[Dict[str, Optional[str]]] = None, extra_stages: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Atomically update one (or more) stage statuses and output paths of a sample."""
    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        sample = _find(manifest["samples"], sample_id, "sample")
        stamp = _now()
        stages = sample.setdefault("stages", {})
        for name, value in [(stage, status)] + list((extra_stages or {}).items()):
            stages[name] = {"status": value, "task_id": task_id, "updated_at": stamp}
        if outputs:
            sample.setdefault("outputs", {}).update(outputs)
        return sample
    return _mutate_manifest(Path(root), mutate)


# --------------------------------------------------------------------------- stale stages and listing

ACTIVE_STAGE_STATUSES = ("queued", "running")
# Status of the stage's task in runs/<task_id>/status.json (written only by the
# desktop task scheduler) -> what a still-"active" stage is shown as.  queued/running
# task records may belong to a live task and are left alone.
_STALE_STAGE_STATUS = {"interrupted": "interrupted", "cancelled": "cancelled", "failed": "failed",
                       "succeeded": "interrupted", None: "interrupted"}


def _task_status(root: Path, task_id: Any) -> Optional[str]:
    """``status`` from ``runs/<task_id>/status.json``; None when the record is absent or unreadable."""
    if not isinstance(task_id, str) or not _ID.match(task_id):
        return None
    status_path = Path(root) / "runs" / task_id / "status.json"
    try:
        if status_path.is_symlink() or not status_path.is_file():
            return None
        data = json.loads(status_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    status = data.get("status") if isinstance(data, dict) else None
    return status if isinstance(status, str) else None


def stale_stages(root: Path, manifest: Dict[str, Any]) -> List[Tuple[str, str, Optional[str], str]]:
    """``(sample_id, stage, task_id, new_status)`` for queued/running stages with no live task."""
    stale = []
    for sample in manifest.get("samples") or []:
        if not isinstance(sample, dict) or not isinstance(sample.get("stages"), dict):
            continue
        for name, stage in sample["stages"].items():
            if not isinstance(stage, dict) or stage.get("status") not in ACTIVE_STAGE_STATUSES:
                continue
            task_status = _task_status(root, stage.get("task_id"))
            if task_status in ACTIVE_STAGE_STATUSES:
                continue
            new = _STALE_STAGE_STATUS.get(task_status, "interrupted")
            stale.append((sample.get("id"), name, stage.get("task_id"), new))
    return stale


def normalize_stale_stages(root: Path, manifest: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Mark queued/running sample stages whose task is no longer live.

    Returns the (normalized) manifest and the changes.  The change is
    persisted through the locked manifest writer; a read-only project is
    normalized in memory only.
    """
    root = Path(root).expanduser().resolve()
    manifest = manifest if manifest is not None else load_manifest(root)
    stale = stale_stages(root, manifest)
    if not stale:
        return manifest, []
    changes = [{"sample_id": sid, "stage": name, "task_id": task_id, "status": status} for sid, name, task_id, status in stale]

    def apply(target: Dict[str, Any]) -> List[Dict[str, Any]]:
        stamp = _now()
        applied = []
        for change in changes:
            sample = next((s for s in target.get("samples") or [] if isinstance(s, dict) and s.get("id") == change["sample_id"]), None)
            stage = (sample or {}).get("stages", {}).get(change["stage"]) if sample else None
            # Re-check under the lock: the stage may have moved on meanwhile.
            if not isinstance(stage, dict) or stage.get("status") not in ACTIVE_STAGE_STATUSES or stage.get("task_id") != change["task_id"]:
                continue
            stage["status"] = change["status"]
            stage["updated_at"] = stamp
            applied.append(change)
        return applied

    try:
        applied = _mutate_manifest(root, apply)
        return load_manifest(root), applied
    except OSError:
        return manifest, apply(manifest)


def stage_summary(stages: Any) -> str:
    """One word for a sample's stage row: pending | running | done | failed | interrupted."""
    statuses = [stage.get("status") for stage in (stages or {}).values() if isinstance(stage, dict)] if isinstance(stages, dict) else []
    if any(status in ACTIVE_STAGE_STATUSES for status in statuses):
        return "running"
    if "failed" in statuses:
        return "failed"
    if any(status in ("interrupted", "cancelled") for status in statuses):
        return "interrupted"
    if statuses and all(status in ("succeeded", "skipped") for status in statuses):
        return "done"
    return "pending"


def _output_exists(root: Path, value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    if is_absolute_path(value):
        return _trust.is_trusted(root, value) and Path(value).is_file()
    if not safe_relative_path(value):
        return False
    target = (root / value).resolve()
    return root in target.parents and target.is_file()


def list_samples(root: Path) -> Dict[str, Any]:
    """Samples with derived fields, conditions and references (bridge ``list_samples``).

    ``samples[]`` are the manifest records plus ``ready`` (the analysis index
    exists) and ``stage_summary``; stale queued/running stages are normalized
    first.  ``conditions`` groups sample ids by condition in sample order;
    ``references`` are the reference records with their ``sequences``.
    """
    root = _project_root(root)
    manifest, changes = normalize_stale_stages(root)
    samples = []
    conditions: Dict[str, List[str]] = {}
    for sample in manifest.get("samples") or []:
        outputs = sample.get("outputs") if isinstance(sample.get("outputs"), dict) else {}
        samples.append({**sample, "ready": _output_exists(root, outputs.get("index")),
                        "stage_summary": stage_summary(sample.get("stages"))})
        condition = sample.get("condition")
        if isinstance(condition, str) and condition:
            conditions.setdefault(condition, []).append(sample["id"])
    references = [{**reference, "sequences": list(reference.get("sequences") or [])}
                  for reference in manifest.get("references") or []]
    return {"samples": samples, "conditions": [{"name": name, "sample_ids": ids} for name, ids in conditions.items()],
            "references": references, "normalized": changes}


# --------------------------------------------------------------------------- sample sheets

_FILES_COLUMNS = ("files", "file", "reads", "read", "path", "paths", "fastq", "input")
_REFERENCE_COLUMNS = ("reference", "ref", "reference_path", "genome", "fasta")
_NAME_COLUMNS = ("name", "sample", "sample_name")
_CONDITION_COLUMNS = ("condition", "group")
_REPLICATE_COLUMNS = ("replicate", "rep")
_GENE_COLUMNS = ("gene_id", "gene", "target")


def parse_sample_sheet(sheet: Path) -> List[Dict[str, str]]:
    """Rows of a TSV/CSV sample sheet with lower-cased, trimmed column names."""
    text = Path(sheet).read_text(encoding="utf-8-sig")
    first = next((line for line in text.splitlines() if line.strip()), "")
    suffix = Path(sheet).suffix.lower()
    delimiter = "," if suffix == ".csv" else "\t" if suffix in (".tsv", ".tab", ".txt") else ("\t" if "\t" in first else ",")
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    if not reader.fieldnames:
        raise SampleSheetError(["sample sheet has no header row"])
    rows = []
    for row in reader:
        clean = {str(key).strip().lower(): (value or "").strip() for key, value in row.items() if key is not None}
        if not any(clean.values()) or next(iter(clean.values()), "").startswith("#"):
            continue
        rows.append(clean)
    return rows


def _column(row: Dict[str, str], names: Iterable[str]) -> Tuple[Optional[str], str]:
    for name in names:
        if name in row:
            return name, row[name]
    return None, ""


def _resolve(base: Path, value: str) -> Path:
    path = Path(os.path.expanduser(value))
    return (path if path.is_absolute() else base / path).resolve()


def import_sample_sheet(root: Path, sheet: Path, *, base_dir: Optional[Path] = None, mode: str = "linked",
                        condition_column: Optional[str] = None, dry_run: bool = False) -> Dict[str, Any]:
    """Import a TSV/CSV sample sheet (``ZIKV_dataset_map.tsv`` compatible).

    One sample per file: a ``files`` cell may hold several ``;``-separated
    files, which become replicates 1..n of that row.  Relative paths resolve
    against ``base_dir`` or the sheet's directory.  References are registered
    once (deduplicated by path / fingerprint), and ``gene_id`` defaults to the
    reference's sequence name when it has exactly one.  The condition is the
    ``condition_column`` if given, else ``dataset`` (the replicate group of the
    ZIKV map), else ``condition``/``group``.  Nothing is written when any row
    has an error.
    """
    root = _project_root(root)
    sheet = Path(sheet).expanduser().resolve()
    if not sheet.is_file():
        raise SampleSheetError(["sample sheet does not exist: %s" % sheet])
    base = Path(base_dir).expanduser().resolve() if base_dir else sheet.parent
    rows = parse_sample_sheet(sheet)
    errors: List[str] = []
    planned: List[Dict[str, Any]] = []
    references: Dict[Path, Any] = {}
    for number, row in enumerate(rows, start=2):  # header is line 1
        where = "row %d" % number
        files_col, files_value = _column(row, _FILES_COLUMNS)
        files = [part.strip() for part in files_value.split(";") if part.strip()] if files_col else []
        if not files:
            errors.append(where + ": no read files"); continue
        _, ref_value = _column(row, _REFERENCE_COLUMNS)
        ref_path = _resolve(base, ref_value) if ref_value else None
        if ref_path is not None and ref_path not in references:
            if not ref_path.is_file():
                errors.append(where + ": reference not found: %s" % ref_path)
            references[ref_path] = None
        if condition_column:
            condition = row.get(condition_column.strip().lower()) or None
        elif "dataset" in row:
            condition = row["dataset"] or None
        else:
            condition = _column(row, _CONDITION_COLUMNS)[1] or None
        name_col, name_value = _column(row, _NAME_COLUMNS)
        _, rep_value = _column(row, _REPLICATE_COLUMNS)
        _, gene_value = _column(row, _GENE_COLUMNS)
        consumed = {files_col, name_col} | {c for c in _REFERENCE_COLUMNS + _REPLICATE_COLUMNS + _GENE_COLUMNS if c in row}
        metadata = {key: value for key, value in row.items() if key not in consumed and value}
        metadata["sheet_row"] = number
        for index, value in enumerate(files, start=1):
            path = _resolve(base, value)
            if not path.is_file():
                errors.append(where + ": file not found: %s" % path); continue
            try:
                fmt = detect_read_format(path)
            except ValueError as error:
                errors.append(where + ": " + str(error)); continue
            replicate = index
            if len(files) == 1 and rep_value.isdigit() and int(rep_value) > 0:
                replicate = int(rep_value)
            name = name_value if (name_value and len(files) == 1) else read_stem(path)
            planned.append({"source": path, "format": fmt, "name": name, "condition": condition, "replicate": replicate,
                            "reference": ref_path, "gene_id": gene_value or None, "metadata": dict(metadata)})
    if errors:
        raise SampleSheetError(errors)
    return _import_planned(root, planned, references, mode=mode, dry_run=dry_run)


def _import_planned(root: Path, planned: List[Dict[str, Any]], references: Dict[Path, Any], *, mode: str,
                    dry_run: bool) -> Dict[str, Any]:
    """Register ``references`` and the ``planned`` samples (the common end of
    the sheet and folder imports); with ``dry_run`` only report the plan."""
    if dry_run:
        return {"dry_run": True, "samples": [{**{k: v for k, v in p.items() if k not in ("source", "reference")},
                                              "path": str(p["source"]), "reference": str(p["reference"]) if p["reference"] else None}
                                             for p in planned],
                "references": [str(path) for path in references]}
    # Slow work (fingerprints, FASTA scans, optional copies) happens before the lock.
    prepared_refs: Dict[Path, Tuple[_Prepared, Dict[str, Any]]] = {}
    prepared_samples: List[Tuple[Dict[str, Any], _Prepared]] = []
    try:
        for path in references:
            prepared_refs[path] = _prepare_reference(root, path, mode, "")
        for plan in planned:
            prepared_samples.append((plan, _prepare_file(root, plan["source"], mode, fmt=plan["format"])))

        def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
            ref_ids: Dict[Path, str] = {}
            added_refs, reused_refs = [], []
            for path, (prep, extra) in prepared_refs.items():
                reference, existing = _register_reference(manifest, root, prep, extra)
                ref_ids[path] = reference["id"]
                (reused_refs if existing else added_refs).append(reference["id"])
            added, skipped = [], []
            for plan, prep in prepared_samples:
                duplicate = next((s for s in manifest["samples"] if _same_file(prep.record, s.get("reads", {}))), None)
                if duplicate is not None:
                    prep.discard()
                    skipped.append({"id": duplicate["id"], "path": str(plan["source"]), "reason": "already in project"})
                    continue
                record = prep.finalize(root)
                sample = _new_sample(manifest, record, name=plan["name"], condition=plan["condition"], replicate=plan["replicate"],
                                     reference_id=ref_ids.get(plan["reference"]) if plan["reference"] else None,
                                     gene_id=plan["gene_id"], settings={}, metadata=plan["metadata"])
                added.append(sample)
            return {"samples": added, "skipped": skipped, "references_added": added_refs, "references_reused": reused_refs}
        return _mutate_manifest(root, mutate)
    finally:
        for prep, _ in prepared_refs.values():
            prep.discard()
        for _, prep in prepared_samples:
            prep.discard()


# --------------------------------------------------------------------------- data folders

_FOLDER_MAX_DEPTH = 2
_FOLDER_MAX_FILES = 20_000
_SNIFF_BYTES = MiB
_BOWTIE2_SUFFIXES = (".bt2", ".bt2l")
_REP_TOKEN = re.compile(r"^(?P<cond>.+?)[._-]?(?:rep|replicate)[._-]?(?P<rep>\d{1,3})(?P<rest>(?:[._-].*)?)$", re.IGNORECASE)
_TRAILING_NUMBER = re.compile(r"^(?P<cond>.*?[A-Za-z])[._-]?(?P<rep>\d{1,3})(?P<rest>(?:[._-]\D.*)?)$")
_MATE = re.compile(r"[._-]R[12](?:[._-]0*1)?$", re.IGNORECASE)


def _fasta_kind(path: Path) -> str:
    """'reads' or 'reference' for a FASTA(.gz), from its first MiB: many
    short records are reads (collapsed/assembled chimeras), a few long
    ones a reference."""
    headers, bases = 0, 0
    try:
        with _open_text(path) as handle:
            text = handle.read(_SNIFF_BYTES)
    except (OSError, EOFError, ValueError):
        return "unknown"
    for line in text.splitlines():
        if line.startswith(">"):
            headers += 1
        else:
            bases += len(line.strip())
    if headers == 0:
        return "unknown"
    return "reads" if headers >= 50 and bases / headers < 500 else "reference"


def _split_replicate(stem: str) -> Tuple[str, Optional[str], Optional[int]]:
    """(name, condition, replicate) from a file stem:
    ``ZSIN_REP1`` -> (ZSIN_REP1, ZSIN, 1), ``Livefire1_comp`` -> (Livefire1,
    Livefire, 1), ``Aag-1.assembled.collapse`` -> (Aag-1, Aag, 1); otherwise
    (stem, None, None)."""
    for pattern in (_REP_TOKEN, _TRAILING_NUMBER):
        match = pattern.match(stem)
        if match:
            cond = match.group("cond").rstrip("._-")
            if cond:
                rest = match.group("rest")
                name = stem[: len(stem) - len(rest)] if rest else stem
                return name, cond, int(match.group("rep"))
    return stem, None, None


def _walk_folder(folder: Path):
    """Regular files under folder (two levels), skipping hidden entries,
    symlinked directories and RNAxRay project folders."""
    count = 0
    stack = [(folder, 0)]
    while stack:
        current, depth = stack.pop()
        try:
            entries = sorted(os.scandir(current), key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith("."):
                continue
            if entry.is_dir(follow_symlinks=False):
                if depth + 1 < _FOLDER_MAX_DEPTH and not entry.name.lower().endswith(".rnaxrayproj"):
                    stack.append((Path(entry.path), depth + 1))
                continue
            if entry.is_file():
                count += 1
                if count > _FOLDER_MAX_FILES:
                    raise ValueError("the folder has more than %d files; choose the folder that holds the data" % _FOLDER_MAX_FILES)
                yield Path(entry.path)


def scan_data_folder(folder: Path) -> Dict[str, Any]:
    """Propose samples and references for the files of a data folder.

    Reads (FASTQ, read FASTA, SAM, .hyb) become one sample each; the same
    reads both plain and gzipped are proposed once (the .gz). Condition and
    replicate come from the file name (``<condition>_REP<n>``,
    ``<condition><n>``). A reference FASTA whose name starts the sample's
    name is matched (longest first); samples left over get the single
    reference no sample matched, flagged as a guess. Nothing is read
    beyond the first MiB of FASTA files, and nothing is written.
    """
    folder = Path(folder).expanduser().resolve()
    if not folder.is_dir():
        raise ValueError("not a folder: %s" % folder)
    reads: List[Path] = []
    references: List[Path] = []
    ignored: Dict[str, int] = {}

    def ignore(kind: str) -> None:
        ignored[kind] = ignored.get(kind, 0) + 1

    for path in _walk_folder(folder):
        lower = path.name.lower()
        if lower.endswith(_BOWTIE2_SUFFIXES):
            ignore("Bowtie2 index files (RNAxRay builds its own)"); continue
        if lower.endswith(_REFERENCE_SUFFIXES) and not lower.endswith((".fastq.gz", ".fq.gz")):
            kind = _fasta_kind(path)
            if kind == "reference":
                references.append(path)
            elif kind == "reads":
                reads.append(path)
            else:
                ignore("named FASTA but not FASTA content")
            continue
        try:
            detect_read_format(path)
        except ValueError:
            ignore("%s files" % (path.suffix.lower() or "other")); continue
        reads.append(path)

    # The same reads plain and gzipped: keep the .gz.
    by_stem: Dict[Tuple[Path, str], List[Path]] = {}
    for path in reads:
        by_stem.setdefault((path.parent, read_stem(path)), []).append(path)
    duplicates: List[Dict[str, str]] = []
    chosen: List[Path] = []
    for (_, _), paths in sorted(by_stem.items(), key=lambda item: (str(item[0][0]), item[0][1])):
        paths.sort(key=lambda p: (not p.name.lower().endswith(".gz"), p.name))
        chosen.append(paths[0])
        for other in paths[1:]:
            duplicates.append({"path": str(other), "kept": str(paths[0])})

    ref_stems = sorted(((read_stem(path).lower(), path) for path in references), key=lambda item: -len(item[0]))
    samples: List[Dict[str, Any]] = []
    for path in chosen:
        stem = read_stem(path)
        name, condition, replicate = _split_replicate(stem)
        reference = next((ref for ref_stem, ref in ref_stems if stem.lower().startswith(ref_stem)), None)
        notes = []
        if _MATE.search(stem) and any(read_stem(other) != stem and _MATE.sub("", read_stem(other)) == _MATE.sub("", stem) for other in chosen):
            notes.append("looks like one mate of a paired-end run; RNAxRay expects single-end (merged) reads")
        samples.append({"path": str(path), "format": detect_read_format(path), "size_bytes": path.stat().st_size,
                        "name": name, "condition": condition, "replicate": replicate,
                        "reference": str(reference) if reference else None, "reference_guessed": False, "notes": notes})
    matched = {s["reference"] for s in samples if s["reference"]}
    leftover = [str(ref) for ref in references if str(ref) not in matched]
    if len(references) == 1:
        leftover = [str(references[0])]
    for sample in samples:
        if sample["reference"] is None and len(leftover) == 1:
            sample["reference"], sample["reference_guessed"] = leftover[0], True
            sample["notes"].append("reference guessed (no file name matched); check it")
        elif sample["reference"] is None:
            sample["notes"].append("no reference matched; choose one")
    # Replicate numbers repeated within a condition.
    seen: Dict[Tuple[Any, Any], int] = {}
    for sample in samples:
        if sample["condition"] is not None:
            key = (sample["condition"], sample["replicate"])
            seen[key] = seen.get(key, 0) + 1
    for sample in samples:
        if seen.get((sample["condition"], sample["replicate"]), 0) > 1:
            sample["notes"].append("another file has the same condition and replicate")
    return {"folder": str(folder), "samples": samples, "references": [str(ref) for ref in references],
            "duplicates": duplicates, "ignored": ignored}


def import_sample_rows(root: Path, rows: Any, *, mode: str = "linked", dry_run: bool = False) -> Dict[str, Any]:
    """Import samples given as rows ``{path, name, condition, replicate,
    reference}`` (absolute paths, typically a reviewed
    :func:`scan_data_folder` proposal). All rows are checked first; nothing
    is written when one has an error."""
    root = _project_root(root)
    if not isinstance(rows, list) or not rows:
        raise SampleSheetError(["no samples to import"])
    if len(rows) > _FOLDER_MAX_FILES:
        raise SampleSheetError(["too many samples"])
    errors: List[str] = []
    planned: List[Dict[str, Any]] = []
    references: Dict[Path, Any] = {}
    for number, row in enumerate(rows, start=1):
        where = "sample %d" % number
        if not isinstance(row, dict) or set(row) - {"path", "name", "condition", "replicate", "reference"}:
            errors.append(where + ": unexpected fields"); continue
        value = row.get("path")
        if not isinstance(value, str) or not is_absolute_path(value) or not Path(value).is_file():
            errors.append(where + ": file not found: %s" % value); continue
        path = Path(value).resolve()
        name = row.get("name")
        condition = row.get("condition") or None
        replicate = row.get("replicate")
        try:
            fmt = detect_read_format(path)
            _check_sample_fields(name, condition, replicate, None)
        except ValueError as error:
            errors.append("%s (%s): %s" % (where, path.name, error)); continue
        ref_value = row.get("reference")
        ref_path = None
        if ref_value:
            if not isinstance(ref_value, str) or not is_absolute_path(ref_value) or not Path(ref_value).is_file():
                errors.append(where + ": reference not found: %s" % ref_value); continue
            ref_path = Path(ref_value).resolve()
            references[ref_path] = None
        planned.append({"source": path, "format": fmt, "name": name.strip(), "condition": condition, "replicate": replicate,
                        "reference": ref_path, "gene_id": None, "metadata": {}})
    if errors:
        raise SampleSheetError(errors)
    return _import_planned(root, planned, references, mode=mode, dry_run=dry_run)


# --------------------------------------------------------------------------- checks

def check_inputs(root: Path) -> Dict[str, Any]:
    """Verify every reference and sample reads file: ok / missing / changed."""
    root = _project_root(root)
    manifest = load_manifest(root)
    items = []
    for kind, entries in (("reference", manifest["references"]), ("sample", manifest["samples"])):
        for entry in entries:
            record = entry if kind == "reference" else entry.get("reads", {})
            status, detail = check_record(root, record)
            items.append({"kind": kind, "id": entry["id"], "path": record.get("path"), "mode": record.get("mode"),
                          "status": status, "detail": detail})
    # Reads are mapped to the sample's reference (sample_run refuses to start
    # without one); a .hyb sample is already mapped.
    references = {r.get("id") for r in manifest["references"]}
    no_reference = [s["id"] for s in manifest["samples"]
                    if s.get("reads", {}).get("format") != "hyb" and s.get("reference_id") not in references]
    summary = {status: sum(1 for item in items if item["status"] == status)
               for status in ("ok", "missing", "changed", "unconfirmed")}
    summary["no_reference"] = len(no_reference)
    return {"items": items, "summary": summary, "no_reference": no_reference,
            "all_ok": not no_reference and summary["missing"] == 0 and summary["changed"] == 0 and summary["unconfirmed"] == 0}


MAX_REFERENCE_SEQUENCE = 50_000_000


def read_reference_sequence(root: Path, reference_id: str, name: str) -> Dict[str, Any]:
    """One reference sequence by gene name (names as ``read_fasta_sequences`` reports them)."""
    root = _project_root(root)
    manifest = load_manifest(root)
    reference = next((item for item in manifest["references"] if item.get("id") == reference_id), None)
    if reference is None:
        raise ValueError("unknown reference: %s" % reference_id)
    status, detail = check_record(root, reference)
    if status == "missing":
        raise ValueError("reference file is missing: %s" % detail)
    path = resolve_record_path(root, reference)
    with _open_text(path) as handle:
        lines = handle.read().splitlines() if path.stat().st_size <= MAX_REFERENCE_SEQUENCE else None
    if lines is None:
        raise ValueError("reference file is too large to read whole")
    formatted = any(line.startswith(">") and "|" in line for line in lines)
    current, chunks, header = None, [], ""
    for line in lines + [">"]:
        if line.startswith(">"):
            if current == name:
                return {"reference_id": reference_id, "name": name, "header": header,
                        "length": sum(len(c) for c in chunks), "sequence": "".join(chunks)}
            header = line[1:].strip()
            current = (_rnaxray_reference_name(header).split() or [""])[0] if formatted else (header.split() or [""])[0]
            chunks = []
        elif current is not None:
            chunks.append(line.strip())
    raise ValueError("sequence %s is not in reference %s" % (name, reference_id))


def hash_inputs(root: Path, *, ids: Optional[List[str]] = None, force: bool = False,
                progress: Optional[ByteProgress] = None) -> Dict[str, Any]:
    """Compute full SHA-256 for references/sample reads (``sha256: null`` ones unless ``force``).

    Hashing happens without the manifest lock; the result is stored only if the
    file's size/mtime still match the record when the lock is taken.
    """
    root = _project_root(root)
    manifest = load_manifest(root)
    targets = []
    for kind, entries in (("reference", manifest["references"]), ("sample", manifest["samples"])):
        for entry in entries:
            if ids is not None and entry["id"] not in ids:
                continue
            record = entry if kind == "reference" else entry.get("reads", {})
            if record.get("sha256") and not force:
                continue
            targets.append((kind, entry["id"], dict(record)))
    total = sum(record.get("size_bytes") or 0 for _, _, record in targets)
    done_before = 0
    computed, skipped = [], []
    for kind, entry_id, record in targets:
        status, detail = check_record(root, record)
        if status != "ok":
            skipped.append({"kind": kind, "id": entry_id, "reason": status, "detail": detail}); continue
        path = resolve_record_path(root, record)
        label = "hashing %s %s" % (kind, entry_id)
        if progress:
            progress("hash", label, done_before, total)
        digest = sha256_with_progress(path, (lambda done, _t, base=done_before: progress("hash", label, base + done, total)) if progress else None)
        done_before += record.get("size_bytes") or 0
        computed.append({"kind": kind, "id": entry_id, "sha256": digest, "size_bytes": record.get("size_bytes"), "mtime": record.get("mtime")})

    def mutate(manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
        stored = []
        for item in computed:
            entries = manifest["references"] if item["kind"] == "reference" else manifest["samples"]
            entry = next((e for e in entries if e.get("id") == item["id"]), None)
            if entry is None:
                continue
            record = entry if item["kind"] == "reference" else entry.get("reads", {})
            if record.get("size_bytes") == item["size_bytes"] and record.get("mtime") == item["mtime"]:
                record["sha256"] = item["sha256"]
                stored.append({"kind": item["kind"], "id": item["id"], "sha256": item["sha256"]})
        return stored
    stored = _mutate_manifest(root, mutate) if computed else []
    if progress:
        progress("done", "%d file(s) hashed" % len(stored), total, total)
    return {"hashed": stored, "skipped": skipped, "bytes_total": total}


# Disk estimate heuristics (documented in the response so the UI can show them).
# Calibrated on the ZIKV data set (zika_files/*.fastq.gz against the legacy
# reproduce_zikv/results_combined outputs, 9 samples of 1.5-2.2 GB gz):
#   gz FASTQ -> FASTQ        5.6x-6.8x (median 6.1x; ZAFR_REP1 1.71 GB -> 10.19 GB = 5.97x)
#   .hyb / FASTQ             0.004-0.014 (ZSIN_REP3, a degenerate library, 0.13)
#   plain SAM / FASTQ        0.72-1.16 (median 0.90)
#   contact.txt / .hyb       0.07-0.20
#   analysis index / .hyb    ~0.23 (352 MB index for a 1.56 GB .hyb)
# The factors round towards the conservative end so a pre-flight check does
# not pass for a run that then fills the disk.
GZ_EXPANSION = 6.5         # gzip FASTQ/FASTA expands ~6x
TEMP_FACTOR = 1.2          # external sort / intermediates ~1.2x the uncompressed input
HYB_FACTOR = 0.02          # .hyb + homodimers + stats vs uncompressed input
INDEX_FACTOR = 0.25        # analysis index vs .hyb size
CONTACT_FACTOR = 0.2       # contact.txt vs .hyb size
SAM_FACTORS = {"none": 0.0, "gz": 0.25, "plain": 1.0}


def estimate_sample(sample: Dict[str, Any]) -> Dict[str, Any]:
    reads = sample.get("reads", {})
    size = int(reads.get("size_bytes") or 0)
    fmt = reads.get("format", "")
    uncompressed = int(size * GZ_EXPANSION) if fmt.endswith(".gz") else size
    settings = sample.get("settings") or {}
    keep_sam = settings.get("keep_sam", "none") if settings.get("keep_sam") in SAM_FACTORS else "none"
    if fmt == "hyb":
        temp, outputs = 0, int(size * (INDEX_FACTOR + CONTACT_FACTOR))
    else:
        temp = int(uncompressed * TEMP_FACTOR)
        hyb = int(uncompressed * HYB_FACTOR)
        outputs = hyb + int(hyb * (INDEX_FACTOR + CONTACT_FACTOR)) + int(uncompressed * SAM_FACTORS[keep_sam])
    return {"id": sample["id"], "format": fmt, "input_bytes": size, "uncompressed_bytes": uncompressed,
            "temp_bytes": temp, "output_bytes": outputs}


def disk_estimate(root: Path, sample_ids: Optional[List[str]] = None, *, concurrency: int = 1,
                  tmp_dir: Optional[Path] = None, include_completed: bool = False) -> Dict[str, Any]:
    """Estimate disk needed to run samples and compare with free space.

    temp ~ 1.2x uncompressed input (gz counted as 6.5x its size), freed after
    each sample, so the peak temp is the ``concurrency`` largest samples;
    outputs accumulate.  Samples whose ``hyb`` stage already succeeded are
    left out unless ``include_completed``.
    """
    root = _project_root(root)
    manifest = load_manifest(root)
    samples = manifest["samples"]
    if sample_ids is not None:
        known = {s["id"] for s in samples}
        missing = [sid for sid in sample_ids if sid not in known]
        if missing:
            raise ValueError("unknown sample ids: " + ", ".join(missing))
        samples = [s for s in samples if s["id"] in sample_ids]
    if type(concurrency) is not int or concurrency < 1:
        raise ValueError("concurrency must be a positive integer")
    rows, completed = [], []
    for sample in samples:
        done = (sample.get("stages", {}).get("hyb", {}).get("status") == "succeeded"
                and sample.get("stages", {}).get("index", {}).get("status") in ("succeeded", "skipped"))
        if done and not include_completed:
            completed.append(sample["id"]); continue
        rows.append(estimate_sample(sample))
    temps = sorted((row["temp_bytes"] for row in rows), reverse=True)
    temp_peak = sum(temps[:concurrency])
    outputs = sum(row["output_bytes"] for row in rows)
    tmp_root = Path(tmp_dir).expanduser().resolve() if tmp_dir else None
    volumes = []
    if tmp_root is not None and tmp_root.exists() and tmp_root.stat().st_dev != root.stat().st_dev:
        volumes.append({"path": str(root), "role": "outputs", "required_bytes": outputs, "free_bytes": shutil.disk_usage(root).free})
        volumes.append({"path": str(tmp_root), "role": "temp", "required_bytes": temp_peak, "free_bytes": shutil.disk_usage(tmp_root).free})
    else:
        volumes.append({"path": str(root), "role": "outputs+temp", "required_bytes": outputs + temp_peak, "free_bytes": shutil.disk_usage(root).free})
    for volume in volumes:
        volume["ok"] = volume["required_bytes"] <= volume["free_bytes"]
    return {
        "samples": rows, "completed": completed,
        "totals": {"input_bytes": sum(r["input_bytes"] for r in rows), "uncompressed_bytes": sum(r["uncompressed_bytes"] for r in rows),
                   "temp_peak_bytes": temp_peak, "temp_total_bytes": sum(temps), "output_bytes": outputs,
                   "required_bytes": outputs + temp_peak},
        "volumes": volumes, "fits": all(v["ok"] for v in volumes),
        "assumptions": {"gz_expansion": GZ_EXPANSION, "temp_factor": TEMP_FACTOR, "hyb_factor": HYB_FACTOR,
                        "index_factor": INDEX_FACTOR, "contact_factor": CONTACT_FACTOR, "sam_factors": SAM_FACTORS, "concurrency": concurrency},
    }

"""Small dependency-free manifest and path checks for the desktop prototype.

The JSON Schema remains the normative format. These checks are deliberately
duplicated here because the bootstrap and diagnostic environments cannot rely
on a JSON Schema package being installed.
"""

import hashlib
import json
import os
import re
import tempfile
import uuid
import shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional

try:
    import fcntl  # type: ignore[import-not-found]
except ImportError:  # Windows
    fcntl = None  # type: ignore[assignment]
    import msvcrt  # type: ignore[import-not-found]

_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")
_SCHEMA = re.compile(r"^[0-9]+\.[0-9]+$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}T")


DEFAULT_APP_VERSION = "0.1.5"
SCHEMA_VERSION = "2.0"
SUPPORTED_MAJOR = 2
READ_FORMATS = ("fastq", "fastq.gz", "fasta", "fasta.gz", "sam", "hyb")
STAGE_NAMES = ("map", "hyb", "index")
STAGE_STATUSES = ("pending", "queued", "running", "succeeded", "failed", "skipped", "interrupted", "cancelled")
OUTPUT_NAMES = ("hyb", "homodimers", "stats", "contact", "index")
DEFAULT_UI_STATE: Dict[str, Any] = {"desktop": {"route": "home"}, "analysis": {}}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@contextmanager
def _manifest_lock(root: Path) -> Iterator[None]:
    """Exclusive inter-process lock on ``project.json.lock`` (flock/msvcrt)."""
    with _file_lock(Path(root) / "project.json.lock"):
        yield


@contextmanager
def _file_lock(path: Path) -> Iterator[None]:
    """Exclusive inter-process lock on the file ``path`` (flock/msvcrt)."""
    handle = open(path, "a+b")
    try:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        else:
            handle.seek(0)
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1); break
                except OSError:
                    continue  # LK_LOCK gives up after ~10 s; keep waiting
        yield
    finally:
        try:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            else:
                handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            handle.close()


def _atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON to a same-directory temp file, fsync, then os.replace."""
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, indent=2) + "\n"); handle.flush(); os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def _mutate_manifest(root: Path, fn: Callable[[Dict[str, Any]], Any]) -> Any:
    """Locked read-modify-write of project.json; ``fn`` mutates in place and returns a result."""
    root = Path(root).expanduser().resolve(); manifest_path = root / "project.json"
    if not manifest_path.is_file():
        raise ValueError("project.json is missing")
    with _manifest_lock(root):
        manifest = migrate_manifest(json.loads(manifest_path.read_text(encoding="utf-8")))
        errors = validate_manifest(manifest)
        if errors: raise ValueError("invalid project: " + "; ".join(errors))
        manifest["updated_at"] = _now()
        result = fn(manifest)
        _atomic_write_json(manifest_path, manifest)
        return result


def _schema_major(manifest: Dict[str, Any]) -> Optional[int]:
    version = manifest.get("schema_version")
    if not isinstance(version, str) or not _SCHEMA.match(version):
        return None
    return int(version.split(".", 1)[0])


def migrate_manifest(manifest: Any) -> Any:
    """Upgrade an older manifest in place (in memory) to schema 2.0.

    1.x -> 2.0 adds empty ``references`` and ``samples`` arrays; ``inputs``,
    ``runs`` and ``artifacts`` are kept unchanged.  2.0 manifests written
    before ``structures``/``comparisons`` existed get empty arrays.  The upgraded manifest is
    written back by the next locked mutation, so opening a read-only project
    still works.  Unknown or newer versions are returned untouched so that
    validation can report them.
    """
    if not isinstance(manifest, dict):
        return manifest
    if _schema_major(manifest) == 1:
        manifest.setdefault("references", [])
        manifest.setdefault("samples", [])
        manifest["schema_version"] = SCHEMA_VERSION
    if _schema_major(manifest) == 2:
        manifest.setdefault("structures", [])
        manifest.setdefault("comparisons", [])
    return manifest


def load_manifest(root: Path) -> Dict[str, Any]:
    """Read ``project.json`` and migrate it in memory (no lock, no write)."""
    manifest = json.loads((Path(root) / "project.json").read_text(encoding="utf-8"))
    return migrate_manifest(manifest)


def is_absolute_path(value: Any) -> bool:
    """True for a POSIX or Windows absolute path, independent of the host OS."""
    if not isinstance(value, str) or not value or "\x00" in value:
        return False
    return value.startswith("/") or value.startswith("\\\\") or bool(re.match(r"^[A-Za-z]:[\\/]", value))


def safe_relative_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or "\x00" in value:
        return False
    normal = value.replace("\\", "/")
    if normal.startswith("/") or re.match(r"^[A-Za-z]:", normal):
        return False
    return all(part not in ("", ".", "..") for part in normal.split("/"))


def _required(obj: Dict[str, Any], names: Iterable[str], errors: List[str], where: str) -> None:
    for name in names:
        if name not in obj:
            errors.append("%s missing %s" % (where, name))


def validate_manifest(manifest: Any) -> List[str]:
    """Return human-readable validation errors; an empty list means valid."""
    errors: List[str] = []
    if not isinstance(manifest, dict):
        return ["manifest must be an object"]
    _required(manifest, ("format", "schema_version", "project_id", "name", "created_at", "updated_at", "inputs", "runs", "artifacts", "application", "runtime"), errors, "manifest")
    if manifest.get("format") != "rnaxray-project": errors.append("manifest.format must be rnaxray-project")
    if not isinstance(manifest.get("schema_version"), str) or not _SCHEMA.match(manifest.get("schema_version", "")): errors.append("manifest.schema_version must be major.minor")
    if not isinstance(manifest.get("project_id"), str) or not re.match(r"^[0-9a-fA-F-]{36}$", manifest.get("project_id", "")): errors.append("manifest.project_id must be a UUID")
    for key in ("created_at", "updated_at"):
        if not isinstance(manifest.get(key), str) or not _DATE.match(manifest.get(key, "")): errors.append("manifest.%s must be an ISO timestamp" % key)
    if not isinstance(manifest.get("name"), str) or not manifest.get("name"): errors.append("manifest.name must be non-empty")
    app = manifest.get("application")
    # Accept the legacy application label so existing .hyb2proj directories
    # remain readable after the RNAxRay brand migration. New projects use the
    # RNAxRay label below.
    if not isinstance(app, dict) or app.get("name") not in {"HYB2 Desktop", "RNAxRay Desktop"} or not isinstance(app.get("version"), str): errors.append("manifest.application must contain RNAxRay Desktop (or legacy HYB2 Desktop) and version")
    for key, required in (("inputs", ("id", "role", "path", "format", "sha256", "size_bytes")), ("runs", ("id", "kind", "status", "input_ids", "parameters", "output_paths")), ("artifacts", ("path", "kind", "sha256", "size_bytes"))):
        value = manifest.get(key)
        if not isinstance(value, list):
            errors.append("manifest.%s must be an array" % key)
            continue
        ids = set()
        for index, item in enumerate(value):
            where = "manifest.%s[%d]" % (key, index)
            if not isinstance(item, dict):
                errors.append(where + " must be an object")
                continue
            _required(item, required, errors, where)
            if "id" in required and (not isinstance(item.get("id"), str) or not _ID.match(item.get("id", ""))): errors.append(where + ".id is invalid")
            if "path" in item and not safe_relative_path(item.get("path")): errors.append(where + ".path must be relative and traversal-free")
            for path_key in ("output_paths", "log_paths"):
                if path_key in item:
                    if not isinstance(item[path_key], list):
                        errors.append(where + "." + path_key + " must be an array")
                    else:
                        for path in item[path_key]:
                            if not safe_relative_path(path): errors.append(where + "." + path_key + " contains an unsafe path")
            if "sha256" in item and (not isinstance(item.get("sha256"), str) or not _SHA256.match(item.get("sha256", ""))): errors.append(where + ".sha256 must be 64 hex characters")
            if "size_bytes" in item and (type(item.get("size_bytes")) is not int or item.get("size_bytes") < 0): errors.append(where + ".size_bytes must be a non-negative integer")
            if isinstance(item.get("id"), str):
                if item["id"] in ids: errors.append(where + ".id is duplicated")
                ids.add(item["id"])
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict) or not isinstance(runtime.get("capabilities"), list): errors.append("manifest.runtime.capabilities must be an array")
    major = _schema_major(manifest)
    if major is not None and major > SUPPORTED_MAJOR:
        errors.append("manifest.schema_version %s is newer than this application supports" % manifest.get("schema_version"))
    if major is not None and major >= 2:
        _validate_references_samples(manifest, errors)
        _validate_structures(manifest, errors)
        _validate_comparisons(manifest, errors)
    return errors


STRUCTURE_PATH_KEYS = ("dbn", "pairs", "ct", "meta")


def _validate_structures(manifest: Dict[str, Any], errors: List[str]) -> None:
    """``structures[]`` (optional in 2.0): registered structure_run results."""
    structures = manifest.get("structures", [])
    if not isinstance(structures, list):
        errors.append("manifest.structures must be an array"); return
    ids = set()
    for index, item in enumerate(structures):
        where = "manifest.structures[%d]" % index
        if not isinstance(item, dict):
            errors.append(where + " must be an object"); continue
        _required(item, ("id", "task_id", "sample_ids", "gene_id", "mode", "windows", "parameters", "created_at", "paths", "summary"), errors, where)
        if not isinstance(item.get("id"), str) or not _ID.match(item.get("id", "")): errors.append(where + ".id is invalid")
        elif item["id"] in ids: errors.append(where + ".id is duplicated")
        else: ids.add(item["id"])
        if "task_id" in item and (not isinstance(item.get("task_id"), str) or not _ID.match(item.get("task_id", ""))): errors.append(where + ".task_id is invalid")
        if "sample_ids" in item and (not isinstance(item.get("sample_ids"), list) or any(not isinstance(s, str) for s in item["sample_ids"])): errors.append(where + ".sample_ids must be an array of ids")
        if "mode" in item and item.get("mode") not in ("genome", "windows"): errors.append(where + ".mode must be genome or windows")
        if "windows" in item and (not isinstance(item.get("windows"), list) or any(not isinstance(w, dict) for w in item["windows"])): errors.append(where + ".windows must be an array of {start, end}")
        for key in ("parameters", "summary"):
            if key in item and not isinstance(item.get(key), dict): errors.append(where + "." + key + " must be an object")
        paths = item.get("paths")
        if "paths" in item:
            if not isinstance(paths, dict): errors.append(where + ".paths must be an object")
            else:
                for key, value in paths.items():
                    if value is not None and not safe_relative_path(value): errors.append(where + ".paths." + str(key) + " must be a project-relative path or null")


COMPARISON_PATH_KEYS = ("results", "significant", "interactions", "similarity", "summary")


def _validate_comparisons(manifest: Dict[str, Any], errors: List[str]) -> None:
    """``comparisons[]`` (optional in 2.0): registered compare_run results."""
    comparisons = manifest.get("comparisons", [])
    if not isinstance(comparisons, list):
        errors.append("manifest.comparisons must be an array"); return
    ids = set()
    for index, item in enumerate(comparisons):
        where = "manifest.comparisons[%d]" % index
        if not isinstance(item, dict):
            errors.append(where + " must be an object"); continue
        _required(item, ("id", "task_id", "samples_one", "samples_two", "parameters", "created_at", "paths", "summary"), errors, where)
        if not isinstance(item.get("id"), str) or not _ID.match(item.get("id", "")): errors.append(where + ".id is invalid")
        elif item["id"] in ids: errors.append(where + ".id is duplicated")
        else: ids.add(item["id"])
        for key in ("samples_one", "samples_two"):
            if key in item and (not isinstance(item.get(key), list) or any(not isinstance(s, str) for s in item[key])): errors.append(where + "." + key + " must be an array of ids")
        for key in ("parameters", "summary"):
            if key in item and not isinstance(item.get(key), dict): errors.append(where + "." + key + " must be an object")
        paths = item.get("paths")
        if "paths" in item:
            if not isinstance(paths, dict): errors.append(where + ".paths must be an object")
            else:
                for key, value in paths.items():
                    if value is not None and not safe_relative_path(value): errors.append(where + ".paths." + str(key) + " must be a project-relative path or null")


def _validate_file_record(record: Any, where: str, errors: List[str], *, formats: Optional[Iterable[str]] = None) -> None:
    """Shared checks for a linked/copied file record (reference or sample reads)."""
    if not isinstance(record, dict):
        errors.append(where + " must be an object"); return
    _required(record, ("path", "mode", "size_bytes", "mtime", "quick_hash"), errors, where)
    mode = record.get("mode")
    if mode not in ("linked", "copied"): errors.append(where + ".mode must be linked or copied")
    path = record.get("path")
    if mode == "copied" and not safe_relative_path(path): errors.append(where + ".path of a copied file must be relative and traversal-free")
    if mode == "linked" and not is_absolute_path(path): errors.append(where + ".path of a linked file must be absolute")
    if type(record.get("size_bytes")) is not int or record.get("size_bytes") < 0: errors.append(where + ".size_bytes must be a non-negative integer")
    if "mtime" in record and (isinstance(record.get("mtime"), bool) or not isinstance(record.get("mtime"), (int, float))): errors.append(where + ".mtime must be a number")
    if "quick_hash" in record and (not isinstance(record.get("quick_hash"), str) or not _SHA256.match(record.get("quick_hash", ""))): errors.append(where + ".quick_hash must be 64 hex characters")
    if record.get("sha256") is not None and (not isinstance(record.get("sha256"), str) or not _SHA256.match(record["sha256"])): errors.append(where + ".sha256 must be null or 64 hex characters")
    if formats is not None and record.get("format") not in formats: errors.append(where + ".format must be one of " + ", ".join(formats))


def _validate_references_samples(manifest: Dict[str, Any], errors: List[str]) -> None:
    reference_ids = set()
    references = manifest.get("references")
    if not isinstance(references, list):
        errors.append("manifest.references must be an array"); references = []
    for index, item in enumerate(references):
        where = "manifest.references[%d]" % index
        if not isinstance(item, dict):
            errors.append(where + " must be an object"); continue
        _required(item, ("id", "label", "sequences"), errors, where)
        if not isinstance(item.get("id"), str) or not _ID.match(item.get("id", "")): errors.append(where + ".id is invalid")
        elif item["id"] in reference_ids: errors.append(where + ".id is duplicated")
        else: reference_ids.add(item["id"])
        if "label" in item and not isinstance(item.get("label"), str): errors.append(where + ".label must be a string")
        _validate_file_record(item, where, errors)
        sequences = item.get("sequences")
        if not isinstance(sequences, list) or any(not isinstance(seq, dict) or not isinstance(seq.get("name"), str) or type(seq.get("length")) is not int or seq.get("length") < 0 for seq in sequences):
            errors.append(where + ".sequences must be an array of {name, length}")
    samples = manifest.get("samples")
    if not isinstance(samples, list):
        errors.append("manifest.samples must be an array"); samples = []
    sample_ids = set()
    for index, item in enumerate(samples):
        where = "manifest.samples[%d]" % index
        if not isinstance(item, dict):
            errors.append(where + " must be an object"); continue
        _required(item, ("id", "name", "condition", "replicate", "reference_id", "gene_id", "reads", "settings", "outputs", "stages"), errors, where)
        if not isinstance(item.get("id"), str) or not _ID.match(item.get("id", "")): errors.append(where + ".id is invalid")
        elif item["id"] in sample_ids: errors.append(where + ".id is duplicated")
        else: sample_ids.add(item["id"])
        if not isinstance(item.get("name"), str) or not item.get("name"): errors.append(where + ".name must be non-empty")
        for key in ("condition", "gene_id"):
            if item.get(key) is not None and not isinstance(item.get(key), str): errors.append(where + "." + key + " must be a string or null")
        replicate = item.get("replicate")
        if replicate is not None and (type(replicate) is not int or replicate < 1): errors.append(where + ".replicate must be a positive integer or null")
        reference_id = item.get("reference_id")
        if reference_id is not None and reference_id not in reference_ids: errors.append(where + ".reference_id does not name a reference")
        if "reads" in item: _validate_file_record(item.get("reads"), where + ".reads", errors, formats=READ_FORMATS)
        if "settings" in item and not isinstance(item.get("settings"), dict): errors.append(where + ".settings must be an object")
        if "outputs" in item:
            outputs = item.get("outputs")
            if not isinstance(outputs, dict): errors.append(where + ".outputs must be an object")
            else:
                for key, value in outputs.items():
                    if value is not None and not safe_relative_path(value): errors.append(where + ".outputs." + str(key) + " must be a project-relative path or null")
        if "stages" in item:
            stages = item.get("stages")
            if not isinstance(stages, dict): errors.append(where + ".stages must be an object")
            else:
                for key, stage in stages.items():
                    sw = where + ".stages." + str(key)
                    if not isinstance(stage, dict):
                        errors.append(sw + " must be an object"); continue
                    if stage.get("status") not in STAGE_STATUSES: errors.append(sw + ".status is invalid")
                    if stage.get("task_id") is not None and (not isinstance(stage.get("task_id"), str) or not _ID.match(stage["task_id"])): errors.append(sw + ".task_id is invalid")
                    if stage.get("updated_at") is not None and (not isinstance(stage.get("updated_at"), str) or not _DATE.match(stage["updated_at"])): errors.append(sw + ".updated_at must be an ISO timestamp")


def validate_project_directory(root: Path, check_files: bool = False) -> List[str]:
    root = Path(root).resolve()
    manifest_path = root / "project.json"
    if not manifest_path.is_file(): return ["project.json is missing"]
    try: manifest = migrate_manifest(json.loads(manifest_path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc: return ["project.json cannot be read: %s" % exc]
    errors = validate_manifest(manifest)
    if check_files and not errors:
        paths = []
        for item in manifest.get("inputs", []): paths.append(item.get("path"))
        # Copied references/reads live inside the project and must exist;
        # linked (external) files are reported by check_inputs instead, so a
        # moved raw file never blocks opening the project.
        for item in manifest.get("references", []):
            if item.get("mode") == "copied": paths.append(item.get("path"))
        for item in manifest.get("samples", []):
            reads = item.get("reads") or {}
            if reads.get("mode") == "copied": paths.append(reads.get("path"))
        # Artifact entries are provenance references and normally repeat a run
        # output path; they are checked for existence below but are not treated
        # as duplicate archive members.
        for item in manifest.get("artifacts", []): paths.append(item.get("path"))
        for run in manifest.get("runs", []): paths.extend(run.get("output_paths", [])); paths.extend(run.get("log_paths", []))
        seen = set()
        artifact_paths = {item.get("path") for item in manifest.get("artifacts", [])}
        for relative in paths:
            if not safe_relative_path(relative):
                continue
            normal = relative.replace("\\", "/")
            if normal in seen and relative not in artifact_paths:
                errors.append("duplicate project path: %s" % relative)
            seen.add(normal)
            candidate = (root / normal).resolve()
            if root not in candidate.parents and candidate != root:
                errors.append("project path escapes root: %s" % relative)
            elif not candidate.is_file():
                errors.append("missing project file: %s" % relative)
    return errors


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()


def import_input(root: Path, source: Path, *, role: str = "other", label: str = "") -> Dict[str, Any]:
    """Copy an input into ``inputs/`` and append its portable manifest record.

    The source is read only; project references always point at the copied file.
    This makes an opened project self-contained and prevents later edits to an
    arbitrary external file from silently changing a saved analysis.
    """
    root = Path(root).expanduser().resolve()
    source = Path(source).expanduser().resolve()
    if not source.is_file():
        raise ValueError("input file does not exist: %s" % source)
    if role not in {"hyb", "fasta", "fastq", "sam", "reference", "constraints", "other"}:
        raise ValueError("invalid input role")
    if not (root / "project.json").is_file():
        raise ValueError("project.json is missing")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", source.name).strip("._") or "input"
    # Copy and hash *before* taking the manifest lock: a multi-GB copy must not
    # block every other project mutation.  The temp name is registered (renamed)
    # under the lock.
    temp, digest = copy_into_project(root, source, "inputs")
    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        inputs_dir = root / "inputs"
        destination = inputs_dir / stem
        if destination.exists():
            for item in manifest["inputs"]:
                if item.get("path") == "inputs/" + stem and item.get("sha256") == digest:
                    temp.unlink()
                    return item
            destination = inputs_dir / (Path(stem).stem + "-" + uuid.uuid4().hex[:8] + Path(stem).suffix)
        os.replace(temp, destination)
        item = {"id": "input-" + uuid.uuid4().hex[:12], "role": role, "path": destination.relative_to(root).as_posix(),
                "format": detect_input_format(source), "sha256": digest, "size_bytes": destination.stat().st_size,
                "label": (label or source.stem)[:200], "imported_at": _now()}
        manifest["inputs"].append(item)
        return item
    try:
        return _mutate_manifest(root, mutate)
    finally:
        if temp.exists():
            temp.unlink()


_INPUT_FORMATS = {".hyb": "hyb", ".fasta": "fasta", ".fa": "fasta", ".fna": "fasta", ".fastq": "fastq", ".fq": "fastq", ".sam": "sam",
                  ".ct": "ct", ".dbn": "dbn", ".json": "json", ".tsv": "tsv", ".csv": "csv"}


def detect_input_format(path: Path) -> str:
    """Suffix-based format for a legacy ``inputs[]`` record (gz aware)."""
    name = Path(path).name.lower()
    if name.endswith(".gz"):
        inner = _INPUT_FORMATS.get(Path(name[:-3]).suffix)
        return inner + ".gz" if inner in ("fastq", "fasta") else "other"
    return _INPUT_FORMATS.get(Path(name).suffix, "other")


def copy_into_project(root: Path, source: Path, directory: str) -> "tuple[Path, str]":
    """Copy ``source`` to a hidden temp file in ``root/directory`` while hashing it.

    Single read of the source; no manifest lock is held.  Returns the temp path
    (the caller renames it into place under the lock) and the SHA-256.
    """
    target_dir = Path(root) / directory
    target_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".import-", suffix=".part", dir=str(target_dir))
    digest = hashlib.sha256()
    try:
        with os.fdopen(fd, "wb") as out, Path(source).open("rb") as handle:
            for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
                digest.update(chunk); out.write(chunk)
        shutil.copystat(source, temp)
    except BaseException:
        try: os.unlink(temp)
        except OSError: pass
        raise
    return Path(temp), digest.hexdigest()


def read_input(root: Path, relative: str, *, limit: int = 50_000_000) -> Dict[str, Any]:
    """Read a project input for the integrated desktop analysis workspace."""
    if not safe_relative_path(relative):
        raise ValueError("input path must be relative and traversal-free")
    root = Path(root).expanduser().resolve()
    path = (root / relative).resolve()
    if root not in path.parents or not path.is_file():
        raise ValueError("project input does not exist")
    if path.stat().st_size > limit:
        raise ValueError("project input exceeds desktop preview limit")
    return {"path": relative, "name": path.name, "content": path.read_text(encoding="utf-8", errors="replace")}


def save_analysis_run(root: Path, result: Dict[str, Any]) -> Dict[str, Any]:
    """Persist a compact structure result and register it in project.json."""
    if not isinstance(result, dict): raise ValueError("analysis result must be an object")
    root = Path(root).expanduser().resolve()
    errors = validate_project_directory(root)
    if errors: raise ValueError("invalid project: " + "; ".join(errors))
    run_id = "run-" + uuid.uuid4().hex[:12]
    run_dir = root / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    output = run_dir / "structure-result.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    relative = output.relative_to(root).as_posix()
    run = {"id": run_id, "kind": str(result.get("algorithm", "structure")), "status": "succeeded", "input_ids": [], "parameters": {"engine": result.get("engine"), "constraintMode": result.get("constraintMode")}, "output_paths": [relative], "log_paths": []}
    artifact = {"path": relative, "kind": "structure-result", "sha256": sha256_file(output), "size_bytes": output.stat().st_size}
    def mutate(manifest: Dict[str, Any]) -> None:
        manifest["runs"].append(run); manifest["artifacts"].append(artifact)
    _mutate_manifest(root, mutate)
    return {"run_id": run_id, "path": relative}


def _check_ui_state(value: Any) -> None:
    if isinstance(value, str):
        normal = value.replace("\\", "/")
        if "\x00" in value or normal.startswith("/") or re.match(r"^[A-Za-z]:/", normal) or any(part == ".." for part in normal.split("/")):
            raise ValueError("ui state cannot contain absolute or traversal paths")
    elif isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str): raise ValueError("ui state keys must be strings")
            _check_ui_state(child)
    elif isinstance(value, list):
        for child in value: _check_ui_state(child)
    elif value is not None and not isinstance(value, (bool, int, float)):
        raise ValueError("ui state must contain JSON scalar values")


def update_ui_state(root: Path, state: Dict[str, Any]) -> Dict[str, Any]:
    """Persist bounded, JSON-serializable UI state without absolute paths.

    Accepts the namespaced shape ``{"desktop": {"route": ...}, "analysis": {...}}``
    as well as legacy flat objects; the whole object replaces ``ui_state``.
    """
    if not isinstance(state, dict):
        raise ValueError("ui state must be an object")
    encoded = json.dumps(state, ensure_ascii=False)
    if len(encoded) > 256_000:
        raise ValueError("ui state is too large")
    _check_ui_state(state)
    def mutate(manifest: Dict[str, Any]) -> str:
        manifest["ui_state"] = state
        return manifest["updated_at"]
    return {"updated_at": _mutate_manifest(root, mutate), "ui_state": state}


def _project_relative(root: Path, value: Any) -> Optional[str]:
    """Return a safe project-relative path for an existing file inside ``root``, else None."""
    if not isinstance(value, str) or not value or "\x00" in value:
        return None
    candidate = Path(value) if os.path.isabs(value) else (root / value.replace("\\", "/") if safe_relative_path(value) else None)
    if candidate is None:
        return None
    try:
        resolved = candidate.resolve()
        relative = resolved.relative_to(root).as_posix()
    except (OSError, ValueError):
        return None
    return relative if safe_relative_path(relative) and resolved.is_file() else None


def _path_values(value: Any) -> List[Any]:
    if isinstance(value, dict): return list(value.values())
    if isinstance(value, list): return list(value)
    return [value] if value is not None else []


def _structure_entry(root: Path, task_id: str, result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A ``structures[]`` entry from a structure task's ``result.json`` (None if not one).

    Output paths must be files under ``structures/<task_id>/``; everything is
    re-derived here so a malformed result cannot place arbitrary paths in the
    manifest.
    """
    raw = result.get("structure")
    if not isinstance(raw, dict) or result.get("ok") is False:
        return None
    base = root / "structures" / task_id
    if base.is_symlink() or not base.is_dir():
        return None
    raw_paths = raw.get("paths") if isinstance(raw.get("paths"), dict) else {}
    legacy = result.get("outputs") if isinstance(result.get("outputs"), dict) else {}
    defaults = {"dbn": "structure.dbn", "pairs": "pairs.tsv", "ct": "structure.ct", "meta": "meta.json"}
    paths: Dict[str, Optional[str]] = {}
    for key in STRUCTURE_PATH_KEYS:
        relative = None
        for value in (raw_paths.get(key), legacy.get(key), "structures/%s/%s" % (task_id, defaults[key])):
            candidate = _project_relative(root, value)
            if candidate and candidate.startswith("structures/%s/" % task_id):
                relative = candidate; break
        paths[key] = relative
    if paths["dbn"] is None:
        return None
    sample_ids = raw.get("sample_ids", raw.get("samples", []))
    sample_ids = [s for s in sample_ids if isinstance(s, str)] if isinstance(sample_ids, list) else []
    windows = [{"start": int(w["start"]), "end": int(w["end"])} for w in raw.get("windows") or []
               if isinstance(w, dict) and type(w.get("start")) is int and type(w.get("end")) is int]
    mode = raw.get("mode") if raw.get("mode") in ("genome", "windows") else "genome"
    created = raw.get("created_at") if isinstance(raw.get("created_at"), str) and _DATE.match(raw["created_at"]) else _now()
    parameters = raw.get("parameters") if isinstance(raw.get("parameters"), dict) else {}
    summary = raw.get("summary") if isinstance(raw.get("summary"), dict) else (result.get("summary") if isinstance(result.get("summary"), dict) else {})
    return {"id": task_id, "task_id": task_id, "sample_ids": sample_ids,
            "gene_id": raw.get("gene_id") if isinstance(raw.get("gene_id"), str) else None,
            "mode": mode, "windows": windows, "parameters": json.loads(json.dumps(parameters)), "created_at": created,
            "paths": paths, "summary": json.loads(json.dumps(summary))}


def _comparison_entry(root: Path, task_id: str, result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A ``comparisons[]`` entry from a compare task's ``result.json`` (None if not one).

    Like :func:`_structure_entry`, paths are re-derived under
    ``comparisons/<task_id>/`` and every value is copied by type.
    """
    raw = result.get("comparison")
    if not isinstance(raw, dict) or result.get("ok") is False:
        return None
    base = root / "comparisons" / task_id
    if base.is_symlink() or not base.is_dir():
        return None
    files = {"results": "results.tsv", "significant": "significant.tsv", "interactions": "interactions.tsv",
             "similarity": "similarity.tsv", "summary": "summary.json"}
    paths: Dict[str, Optional[str]] = {}
    for key in COMPARISON_PATH_KEYS:
        target = base / files[key]
        paths[key] = "comparisons/%s/%s" % (task_id, files[key]) if target.is_file() and not target.is_symlink() else None
    if paths["significant"] is None or paths["interactions"] is None:
        return None
    def ids(value: Any) -> List[str]:
        return [s for s in value if isinstance(s, str)] if isinstance(value, list) else []
    def text(value: Any) -> Optional[str]:
        return value if isinstance(value, str) else None
    created = raw.get("created_at") if isinstance(raw.get("created_at"), str) and _DATE.match(raw["created_at"]) else _now()
    parameters = raw.get("parameters") if isinstance(raw.get("parameters"), dict) else {}
    summary = raw.get("summary") if isinstance(raw.get("summary"), dict) else {}
    return {"id": task_id, "task_id": task_id, "samples_one": ids(raw.get("samples_one")), "samples_two": ids(raw.get("samples_two")),
            "label_one": text(raw.get("label_one")), "label_two": text(raw.get("label_two")), "genes": ids(raw.get("genes")),
            "parameters": json.loads(json.dumps(parameters)), "created_at": created,
            "path": "comparisons/%s" % task_id, "paths": paths, "summary": json.loads(json.dumps(summary))}


def _upsert(manifest: Dict[str, Any], key: str, entry: Dict[str, Any]) -> None:
    items = manifest.setdefault(key, [])
    for index, existing in enumerate(items):
        if isinstance(existing, dict) and existing.get("id") == entry["id"]:
            items[index] = entry; return
    items.append(entry)


def register_task_run(root: Path, task_id: str) -> Dict[str, Any]:
    """Upsert a manifest run from the shell-owned ``runs/<task_id>/status.json`` (idempotent)."""
    if not isinstance(task_id, str) or not _ID.match(task_id):
        raise ValueError("task_id must be a safe identifier")
    root = Path(root).expanduser().resolve()
    runs = root / "runs"
    if runs.is_symlink() or not runs.is_dir() or runs.resolve() != runs:
        raise ValueError("project runs directory escapes project (must be a real directory)")
    run_dir = runs / task_id
    if run_dir.is_symlink() or not run_dir.is_dir():
        raise ValueError("task run directory does not exist: %s" % task_id)
    status_path = run_dir / "status.json"
    if status_path.is_symlink() or not status_path.is_file():
        raise ValueError("task status.json does not exist: %s" % task_id)
    status = json.loads(status_path.read_text(encoding="utf-8"))
    if not isinstance(status, dict): raise ValueError("task status.json must be an object")
    result_path = run_dir / "result.json"
    result: Dict[str, Any] = {}
    if result_path.is_file() and not result_path.is_symlink():
        try:
            loaded = json.loads(result_path.read_text(encoding="utf-8"))
            result = loaded if isinstance(loaded, dict) else {}
        except ValueError:
            result = {}
    if status.get("task_id") not in (None, task_id):
        raise ValueError("status.json task_id does not match")
    output = status.get("output")
    candidates = _path_values(output.get("output") if isinstance(output, dict) else output) + _path_values(result.get("output"))
    if result: candidates.append(str(result_path))
    outputs: List[str] = []
    for value in candidates:
        relative = _project_relative(root, value)
        if relative and relative not in outputs: outputs.append(relative)
    logs: List[str] = []
    for value in _path_values(status.get("log_paths")):
        relative = _project_relative(root, value)
        if relative and relative not in logs and relative not in outputs: logs.append(relative)
    entry: Dict[str, Any] = {"id": task_id, "kind": str(status.get("kind") or "custom"), "status": str(status.get("status") or "failed"), "output_paths": outputs, "log_paths": logs}
    if type(status.get("exit_code")) is int: entry["exit_code"] = status["exit_code"]
    for key in ("started_at", "finished_at"):
        if isinstance(status.get(key), str) and _DATE.match(status[key]): entry[key] = status[key]
    error = status.get("error")
    if isinstance(error, str) and error: entry["error"] = {"code": "task_" + entry["status"], "message": error[:4000]}
    elif isinstance(error, dict) and isinstance(error.get("message"), str): entry["error"] = {"code": str(error.get("code", "task_" + entry["status"])), "message": error["message"][:4000]}
    structure = _structure_entry(root, task_id, result) if entry["status"] == "succeeded" else None
    comparison = _comparison_entry(root, task_id, result) if entry["status"] == "succeeded" else None
    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        if structure is not None:
            _upsert(manifest, "structures", structure)
        if comparison is not None:
            _upsert(manifest, "comparisons", comparison)
        for index, existing in enumerate(manifest["runs"]):
            if isinstance(existing, dict) and existing.get("id") == task_id:
                merged = {"input_ids": existing.get("input_ids", []), "parameters": existing.get("parameters", {})}
                merged.update(entry)
                manifest["runs"][index] = merged
                return merged
        record = {"id": task_id, "kind": entry["kind"], "status": entry["status"], "input_ids": [], "parameters": {}}
        record.update(entry)
        manifest["runs"].append(record)
        return record
    return _mutate_manifest(root, mutate)


def new_project(root: Path, name: str, *, description: str = "", app_version: Optional[str] = None) -> Path:
    """Create an empty portable project directory and return its manifest path.

    This is intentionally a small filesystem API for the desktop bridge.  It
    never accepts an input path as a project member; callers import files via
    a later, hash-recording operation.  ``RNAXRAY_APP_VERSION`` (set by the desktop
    host) takes precedence over the built-in default version.
    """
    root = Path(root).expanduser().resolve()
    if not isinstance(name, str) or not name.strip():
        raise ValueError("project name must be non-empty")
    if root.exists() and any(root.iterdir()):
        raise ValueError("project directory must be empty or absent")
    version = app_version or os.environ.get("RNAXRAY_APP_VERSION") or DEFAULT_APP_VERSION
    root.mkdir(parents=True, exist_ok=True)
    for directory in ("inputs", "runs", "exports"):
        (root / directory).mkdir()
    now = _now()
    manifest = {
        "format": "rnaxray-project", "schema_version": SCHEMA_VERSION,
        "project_id": str(uuid.uuid4()), "name": name.strip(),
        "description": description, "created_at": now, "updated_at": now,
        "application": {"name": "RNAxRay Desktop", "version": version},
        "inputs": [], "references": [], "samples": [], "structures": [], "comparisons": [], "runs": [], "artifacts": [],
        "runtime": {"protocol_version": "1.0", "detected_at": now, "detector_version": "unknown",
                     "platform": {"os": "unknown", "architecture": "unknown", "release": "unknown", "wsl": False, "wsl_distributions": []},
                     "capabilities": []},
        "settings": {"max_parallel_tasks": 1}, "ui_state": json.loads(json.dumps(DEFAULT_UI_STATE)), "extensions": {},
    }
    manifest_path = root / "project.json"
    with _manifest_lock(root):
        _atomic_write_json(manifest_path, manifest)
    return manifest_path

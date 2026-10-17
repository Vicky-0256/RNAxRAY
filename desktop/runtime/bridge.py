"""Process bridge used by the independent RNAxRay Desktop entry point.

The desktop shell (desktop/app) launches this module as a long-lived sidecar (``--serve``:
one ``{"id", "request"}`` JSON line in, one ``{"id", "response"}`` line out)
or once per invocation (stdin line, ``--request``, ``--validate-project``).
Keeping the protocol here makes the desktop app testable without a GUI and
avoids shell command construction.
"""
from __future__ import annotations

import argparse
import contextlib
import heapq
import json
import math
import sys
import tempfile
import time
import uuid
import subprocess
import os
from pathlib import Path
from typing import Any

from .detector import cplfold_max_nt, detect_runtime
from .project import _atomic_write_json, is_absolute_path, load_manifest, new_project, safe_relative_path, validate_project_directory, import_input, read_input, register_task_run, save_analysis_run, update_ui_state
from . import samples as _samples
from . import trust as _trust
from .sample_run import ProgressFile, run_sample_index, run_sample_pipeline
import importlib.util

_RUNNER_PATH = Path(__file__).resolve().parents[1] / "task-runner" / "runner.py"
_RUNNER_SPEC = importlib.util.spec_from_file_location("rnaxray_task_runner", _RUNNER_PATH)
_RUNNER_MODULE = importlib.util.module_from_spec(_RUNNER_SPEC)
assert _RUNNER_SPEC.loader is not None
sys.modules["rnaxray_task_runner"] = _RUNNER_MODULE
_RUNNER_SPEC.loader.exec_module(_RUNNER_MODULE)
TaskRunner = _RUNNER_MODULE.TaskRunner
TaskSpec = _RUNNER_MODULE.TaskSpec

# Loaded cplfold_web modules keyed by source path.  Kept for the lifetime of a
# ``--serve`` sidecar so Numba JIT compilation is paid once per process.
_CPLFOLD_MODULES: dict[str, Any] = {}

_TASK_ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"


def _safe_task_id(value: Any, prefix: str) -> str:
    task_id = str(value or (prefix + uuid.uuid4().hex))
    if not task_id or len(task_id) > 64 or not task_id[0].isalpha() or any(c not in _TASK_ID_CHARS for c in task_id):
        raise ValueError("task_id must be a safe identifier")
    return task_id


def _secure_run_dir(project: Path, task_id: str) -> Path:
    """Create a run directory without following a project-controlled symlink."""
    runs = project / "runs"
    if runs.exists() and (runs.is_symlink() or not runs.is_dir()):
        raise ValueError("project runs directory escapes project (must be a real directory)")
    runs.mkdir(mode=0o700, exist_ok=True)
    if runs.is_symlink() or runs.resolve() != runs:
        raise ValueError("project runs directory escapes project")
    target = runs / task_id
    if target.exists() or target.is_symlink():
        raise FileExistsError("task_id already exists")
    target.mkdir(mode=0o700)
    return target


def _load_cplfold_module(root: Path) -> Any:
    source = root / "web" / "cplfold" / "cplfold_web.py"
    key = str(source)
    if key in _CPLFOLD_MODULES:
        return _CPLFOLD_MODULES[key]
    if not source.is_file():
        return None
    spec = importlib.util.spec_from_file_location("rnaxray_native_cplfold", source)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    # cplfold_web imports the vendored CPLfold module by its historical
    # top-level name; make both source layouts visible to that import.
    for extra in (str(root / "third_party" / "cplfold"), str(source.parent)):
        if extra not in sys.path:
            sys.path.insert(0, extra)
    spec.loader.exec_module(module)
    _CPLFOLD_MODULES[key] = module
    return module


def _project_file(project: Path, relative: Any, label: str) -> Path:
    """A project-relative input that must stay inside the project."""
    if not safe_relative_path(relative):
        raise ValueError(f"{label} must be a project-relative path")
    target = (project / relative).resolve()
    if project not in target.parents or not target.is_file():
        raise ValueError(f"{label} does not exist in the project: {relative}")
    return target


MAX_BONUS_ENTRIES = 200_000


def cap_bonus_entries(result: dict[str, Any], limit: int = MAX_BONUS_ENTRIES) -> dict[str, Any]:
    """Keep the ``limit`` largest ``evidence.bonusEntries`` (original order).

    Long sequences give millions of non-zero bonus cells; the WebView only
    needs the strongest.  Sets ``evidence.bonusEntriesTruncated`` and
    ``evidence.bonusEntriesTotal`` (and mirrors the flag at the top level).
    """
    evidence = result.get("evidence")
    if not isinstance(evidence, dict) or not isinstance(evidence.get("bonusEntries"), list):
        return result
    entries = evidence["bonusEntries"]
    total = len(entries)
    truncated = total > limit
    if truncated:
        def value(index: int) -> float:
            entry = entries[index]
            number = entry.get("value") if isinstance(entry, dict) else None
            return float(number) if isinstance(number, (int, float)) and not isinstance(number, bool) else float("-inf")
        keep = sorted(heapq.nlargest(limit, range(total), key=lambda index: (value(index), -index)))
        evidence["bonusEntries"] = [entries[index] for index in keep]
    evidence["bonusEntriesTruncated"] = truncated
    evidence["bonusEntriesTotal"] = total
    result["bonusEntriesTruncated"] = truncated
    return result


def _pipeline_run(request: dict[str, Any], repo_root: Path | None) -> dict[str, Any]:
    """FASTQ/FASTA/SAM -> .hyb with the bundled pure-Python pipeline."""
    raw_path = request.get("project_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("project path must be a non-empty string")
    path = Path(raw_path).expanduser().resolve()
    errors = validate_project_directory(path)
    if errors: raise ValueError("invalid project: " + "; ".join(errors))
    task_id = _safe_task_id(request.get("task_id"), "pipeline-")
    requested_run_dir = request.get("run_dir")
    if requested_run_dir is not None:
        run_dir = Path(str(requested_run_dir)).expanduser().resolve()
        if not run_dir.is_dir() or run_dir.parent != (path / "runs").resolve():
            raise ValueError("run_dir must be an existing direct child of project runs")
    else:
        run_dir = _secure_run_dir(path, task_id)
    reads = _project_file(path, request.get("input"), "pipeline input")
    reference = _project_file(path, request.get("reference"), "pipeline reference")
    params = request.get("parameters") if isinstance(request.get("parameters"), dict) else {}
    bounds = {"blast_threshold": (0.0, 10.0, float), "max_overlap": (0, 1000, int), "max_hits": (1, 10000, int), "threads": (1, 256, int)}
    values: dict[str, Any] = {}
    for key, (lo, hi, kind) in bounds.items():
        if key in params and params[key] is not None:
            value = params[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi or (kind is int and value != int(value)):
                raise ValueError("pipeline parameter out of bounds: " + key)
            values[key] = kind(value)
    if not isinstance(params.get("energy", False), bool):
        raise ValueError("pipeline parameter energy must be a boolean")
    root = Path(repo_root or Path.cwd()).resolve()
    package = root / "pipeline"
    if not (package / "rnaxraypipe" / "__init__.py").is_file():
        return {"ok": False, "status": "unavailable", "error": "the Python RNAxRay pipeline is not bundled", "task_id": task_id}
    if str(package) not in sys.path:
        sys.path.insert(0, str(package))
    # Prefer the Bowtie2 binaries staged into the runtime's bin/ directory.
    os.environ.setdefault("RNAXRAYPIPE_TOOL_DIR", str(root / "bin"))
    from rnaxraypipe import Options, run as run_pipeline
    from rnaxraypipe.energy import EnergyUnavailable
    from rnaxraypipe.inputs import MappingUnavailable

    def progress(stage: str, detail: str) -> None:
        print(json.dumps({"type": "progress", "stage": stage, "detail": detail}), file=sys.stderr, flush=True)

    stem = reads.name
    for suffix in (".gz", ".fastq", ".fq", ".fasta", ".fa", ".sam"):
        stem = stem[: -len(suffix)] if stem.lower().endswith(suffix) else stem
    options = Options(energy=params.get("energy", False) is True, **values)
    try:
        result = run_pipeline(reads, reference, run_dir / (stem or "rnaxray"), options, progress, log=sys.stderr)
    except (EnergyUnavailable, MappingUnavailable) as error:
        return {"ok": False, "status": "failed", "task_id": task_id, "run_dir": str(run_dir), "error": str(error)}
    return {"ok": True, "status": "succeeded", "task_id": task_id, "run_dir": str(run_dir), "output": str(result.hyb),
            "outputs": {"hyb": str(result.hyb), "homodimers": str(result.homodimers), "stats": str(result.stats), "sam": str(result.sam) if result.sam else None},
            "counts": result.counts}


def project_path(request: dict[str, Any]) -> Path:
    value = request.get("path")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("project path must be a non-empty string")
    path = Path(value).expanduser().resolve()
    return path.parent if path.name == "project.json" and path.is_file() else path


def _valid_project(request: dict[str, Any]) -> Path:
    """Project from ``path`` (or ``project_path`` for task-style requests), validated."""
    if not isinstance(request.get("path"), str) and isinstance(request.get("project_path"), str):
        request = {**request, "path": request["project_path"]}
    path = project_path(request)
    errors = validate_project_directory(path)
    if errors: raise ValueError("invalid project: " + "; ".join(errors))
    return path


def _task_run_dir(project: Path, request: dict[str, Any], prefix: str) -> tuple[str, Path]:
    """``(task_id, run_dir)``: an existing shell-created run dir or a fresh secure one."""
    task_id = _safe_task_id(request.get("task_id"), prefix)
    requested = request.get("run_dir")
    if requested is not None:
        run_dir = Path(str(requested)).expanduser().resolve()
        if not run_dir.is_dir() or run_dir.parent != (project / "runs").resolve():
            raise ValueError("run_dir must be an existing direct child of project runs")
        return task_id, run_dir
    return task_id, _secure_run_dir(project, task_id)


def _optional_str(request: dict[str, Any], key: str) -> str | None:
    value = request.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("%s must be a non-empty string" % key)
    return value


def _id_list(value: Any, key: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("%s must be an array of ids" % key)
    return value


# Operations through which the user links files (chosen in a dialog, a sheet
# or a folder they picked): files they add are linked on this computer.
_LINKING_OPS = {"add_reference", "update_reference", "add_sample", "update_sample", "import_sample_sheet",
                "import_sample_rows"}


def _sample_ops(operation: str, request: dict[str, Any], repo_root: Path | None) -> dict[str, Any] | None:
    """_sample_ops_inner, recording the files a linking operation added (F5)."""
    if operation not in _LINKING_OPS or request.get("dry_run") is True:
        return _sample_ops_inner(operation, request, repo_root)
    path = _valid_project(request)
    before = set(_trust.linked_files(load_manifest(path)))
    result = _sample_ops_inner(operation, request, repo_root)
    if result is not None and result.get("ok"):
        _trust.trust(set(_trust.linked_files(load_manifest(path))) - before)
    return result


def _sample_ops_inner(operation: str, request: dict[str, Any], repo_root: Path | None) -> dict[str, Any] | None:
    """Schema 2.0 reference/sample operations (contract R2); None for other operations."""
    if operation == "list_untrusted_links":
        path = _valid_project(request)
        return {"ok": True, "path": str(path), "files": _trust.untrusted(path, load_manifest(path))}
    if operation == "trust_links":
        path = _valid_project(request)
        paths = request.get("paths")
        if not isinstance(paths, list) or not paths or any(not isinstance(p, str) for p in paths):
            raise ValueError("paths must be a non-empty array of paths")
        known = {item["path"] for item in _trust.untrusted(path, load_manifest(path))}
        for value in paths:
            if os.path.realpath(value) not in known:
                raise ValueError("not a file this project links from outside its folder: %s" % value)
        _trust.trust(paths)
        return {"ok": True, "path": str(path), "files": _trust.untrusted(path, load_manifest(path))}
    if operation == "add_reference":
        path = _valid_project(request)
        source = _optional_str(request, "source")
        result = _samples.add_reference(path, Path(source) if source else None, input_id=request.get("input_id"),
                                        label=str(request.get("label") or ""), mode=str(request.get("mode") or "linked"))
        return {"ok": True, "path": str(path), **result}
    if operation == "read_reference_sequence":
        path = _valid_project(request)
        result = _samples.read_reference_sequence(path, str(request.get("reference_id") or ""), str(request.get("name") or ""))
        return {"ok": True, "path": str(path), **result}
    if operation == "update_reference":
        path = _valid_project(request)
        source = _optional_str(request, "source")
        reference = _samples.update_reference(path, str(request.get("reference_id")), label=request.get("label"),
                                              source=Path(source) if source else None)
        return {"ok": True, "path": str(path), "reference": reference}
    if operation == "remove_reference":
        path = _valid_project(request)
        return {"ok": True, "path": str(path), "reference": _samples.remove_reference(path, str(request.get("reference_id")))}
    if operation == "add_sample":
        path = _valid_project(request)
        source, reference = _optional_str(request, "source"), _optional_str(request, "reference")
        sample = _samples.add_sample(
            path, Path(source) if source else None, input_id=request.get("input_id"), name=request.get("name"),
            condition=request.get("condition"), replicate=request.get("replicate"), reference_id=request.get("reference_id"),
            reference=Path(reference) if reference else None, gene_id=request.get("gene_id"),
            mode=str(request.get("mode") or "linked"), settings=request.get("settings"), metadata=request.get("metadata"))
        return {"ok": True, "path": str(path), "sample": sample}
    if operation == "update_sample":
        path = _valid_project(request)
        changes = request.get("changes")
        if changes is None:
            changes = {key: request[key] for key in request if key not in {"operation", "path", "project_path", "sample_id"}}
        return {"ok": True, "path": str(path), "sample": _samples.update_sample(path, str(request.get("sample_id")), changes)}
    if operation == "remove_sample":
        path = _valid_project(request)
        delete_outputs = request.get("delete_outputs", False)
        if not isinstance(delete_outputs, bool):
            raise ValueError("delete_outputs must be a boolean")
        return {"ok": True, "path": str(path), **_samples.remove_sample(path, str(request.get("sample_id")), delete_outputs=delete_outputs)}
    if operation == "import_sample_sheet":
        path = _valid_project(request)
        sheet = _optional_str(request, "sheet")
        if sheet is None:
            raise ValueError("sheet must be a path to a TSV/CSV sample sheet")
        base_dir = _optional_str(request, "base_dir")
        try:
            result = _samples.import_sample_sheet(path, Path(sheet), base_dir=Path(base_dir) if base_dir else None,
                                                  mode=str(request.get("mode") or "linked"),
                                                  condition_column=_optional_str(request, "condition_column"),
                                                  dry_run=request.get("dry_run") is True)
        except _samples.SampleSheetError as error:
            return {"ok": False, "path": str(path), "errors": error.errors, "error": str(error)}
        return {"ok": True, "path": str(path), **result}
    if operation == "scan_data_folder":
        path = _valid_project(request)
        folder = _optional_str(request, "folder")
        if folder is None or not is_absolute_path(folder):
            raise ValueError("folder must be an absolute path")
        return {"ok": True, "path": str(path), **_samples.scan_data_folder(Path(folder))}
    if operation == "import_sample_rows":
        path = _valid_project(request)
        try:
            result = _samples.import_sample_rows(path, request.get("rows"), mode=str(request.get("mode") or "linked"),
                                                 dry_run=request.get("dry_run") is True)
        except _samples.SampleSheetError as error:
            return {"ok": False, "path": str(path), "errors": error.errors, "error": str(error)}
        return {"ok": True, "path": str(path), **result}
    if operation == "list_samples":
        path = _valid_project(request)
        return {"ok": True, "path": str(path), **_samples.list_samples(path),
                "untrusted_links": _trust.untrusted(path, load_manifest(path))}
    if operation == "list_structures":
        from .structure import list_structures
        path = _valid_project(request)
        return {"ok": True, "path": str(path), "structures": list_structures(path)}
    if operation == "read_structure":
        from .structure import read_structure
        path = _valid_project(request)
        structure_id = request.get("structure_id")
        if not isinstance(structure_id, str) or not structure_id:
            raise ValueError("structure_id is required")
        return {"ok": True, "path": str(path), **read_structure(path, structure_id)}
    if operation == "set_reference_annotation":
        from .annotation import set_reference_annotation
        path = _valid_project(request)
        source = _optional_str(request, "source")
        if source is not None and not is_absolute_path(source):
            raise ValueError("source must be an absolute path")
        reference = set_reference_annotation(path, str(request.get("reference_id") or ""), Path(source) if source else None)
        return {"ok": True, "path": str(path), "reference": reference}
    if operation == "read_annotation":
        from .annotation import read_annotation
        path = _valid_project(request)
        return {"ok": True, "path": str(path),
                **read_annotation(path, str(request.get("reference_id") or ""), str(request.get("gene") or ""))}
    if operation == "list_comparisons":
        from .compare import list_comparisons
        path = _valid_project(request)
        return {"ok": True, "path": str(path), "comparisons": list_comparisons(path)}
    if operation == "read_comparison":
        from .compare import read_comparison
        path = _valid_project(request)
        comparison_id = request.get("comparison_id")
        if not isinstance(comparison_id, str) or not comparison_id:
            raise ValueError("comparison_id is required")
        limit = request.get("limit", 250_000)
        return {"ok": True, "path": str(path), **read_comparison(path, comparison_id, limit=limit)}
    if operation == "structure_regions":
        # Local structures of two lineage-enriched regions (desktop/runtime/regions.py).
        from .regions import structure_regions
        path = _valid_project(request)
        return {"ok": True, "path": str(path), **structure_regions(path, request)}
    if operation == "read_energy":
        from .energy import read_energy
        path = _valid_project(request)
        comparison_id = request.get("comparison_id")
        if not isinstance(comparison_id, str) or not comparison_id:
            raise ValueError("comparison_id is required")
        return {"ok": True, "path": str(path), **read_energy(path, comparison_id, request.get("length"))}
    if operation == "check_inputs":
        path = _valid_project(request)
        return {"ok": True, "path": str(path), **_samples.check_inputs(path)}
    if operation == "disk_estimate":
        path = _valid_project(request)
        tmp_dir = _optional_str(request, "tmp_dir")
        result = _samples.disk_estimate(path, _id_list(request.get("sample_ids"), "sample_ids"),
                                        concurrency=request.get("concurrency", 1), tmp_dir=Path(tmp_dir) if tmp_dir else None,
                                        include_completed=request.get("include_completed") is True)
        return {"ok": True, "path": str(path), **result}
    if operation == "hash_inputs":
        path = _valid_project(request)
        ids = _id_list(request.get("ids"), "ids")
        progress = None
        run_dir = None
        task_id = None
        if request.get("task_id") is not None or request.get("run_dir") is not None:
            task_id, run_dir = _task_run_dir(path, request, "hash-")
            writer = ProgressFile(run_dir)
            progress = writer.write
        result = {"ok": True, "path": str(path), **_samples.hash_inputs(path, ids=ids, force=request.get("force") is True, progress=progress)}
        if run_dir is not None:
            result.update({"status": "succeeded", "task_id": task_id, "run_dir": str(run_dir)})
            _atomic_write_json(run_dir / "result.json", result)
        return result
    if operation == "sample_pipeline_run":
        path = _valid_project(request)
        sample_id = request.get("sample_id")
        if not isinstance(sample_id, str) or not sample_id:
            raise ValueError("sample_id is required")
        task_id, run_dir = _task_run_dir(path, request, "sample-")
        params = request.get("parameters") if isinstance(request.get("parameters"), dict) else {}
        root = Path(repo_root or Path.cwd()).resolve()
        return run_sample_pipeline(path, sample_id, task_id, run_dir, params, root)
    if operation == "analysis_index_build":
        path = _valid_project(request)
        sample_id = request.get("sample_id")
        if not isinstance(sample_id, str) or not sample_id:
            raise ValueError("sample_id is required")
        task_id, run_dir = _task_run_dir(path, request, "index-")
        return run_sample_index(path, sample_id, task_id, run_dir, Path(repo_root or Path.cwd()).resolve())
    return None


def handle(request: dict[str, Any], *, repo_root: Path | None = None) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("bridge request must be a JSON object")
    operation = request.get("operation")
    if operation in _ANALYSIS_OPS:
        return _analysis_op(operation, request, repo_root)
    if operation == "detect":
        return {"ok": True, "result": detect_runtime(repo_root).to_dict()}
    if operation in {"validate_project", "open_project"}:
        path = project_path(request)
        errors = validate_project_directory(path, check_files=bool(request.get("check_files", False)))
        if errors:
            return {"ok": False, "path": str(path), "errors": errors, "error": "; ".join(errors)}
        result = {"ok": True, "path": str(path), "errors": []}
        if operation == "open_project":
            # Schema 1.x projects are migrated in memory; the upgrade is saved
            # by the next manifest mutation.  Sample stages left queued/running
            # by a task that is no longer live are shown (and saved) as
            # interrupted.
            manifest, changes = _samples.normalize_stale_stages(path)
            result["manifest"] = manifest
            result["normalized"] = changes
        return result
    if operation == "create_project":
        path = project_path(request)
        manifest = new_project(path, str(request.get("name", "")), description=str(request.get("description", "")))
        return {"ok": True, "manifest": str(manifest)}
    if operation == "cplfold_predict":
        # Execute the shared CPLfold implementation in the bundled Python
        # runtime and return the same result contract as cplfold.worker.mjs.
        sequence = request.get("sequence")
        if not isinstance(sequence, str) or not sequence.strip():
            raise ValueError("sequence must contain RNA bases A/C/G/U/T/N")
        sequence = "".join(sequence.upper().split()).replace("T", "U")
        if not sequence or any(c not in "ACGUN" for c in sequence):
            raise ValueError("sequence must contain RNA bases A/C/G/U/T/N")
        max_nt = cplfold_max_nt()
        if len(sequence) > max_nt:
            raise ValueError(f"sequence exceeds CPLfold safety limit ({max_nt} nt)")
        root = Path(repo_root or Path.cwd()).resolve()
        if not (root / "web" / "cplfold" / "cplfold_web.py").is_file():
            return {"ok": False, "status": "unavailable", "error": "native CPLfold source is not bundled"}
        module = _load_cplfold_module(root)
        if module is None:
            return {"ok": False, "status": "unavailable", "error": "native CPLfold module cannot be loaded"}
        # The shared module keeps the browser's 500 nt ceiling unless a native
        # host raises it; the desktop limit is RNAXRAY_CPLFOLD_MAX_NT.
        if hasattr(module, "set_host_hard_max_sequence_length"):
            module.set_host_hard_max_sequence_length(max_nt)
        params = request.get("parameters") if isinstance(request.get("parameters"), dict) else {}
        allow = params.get("allowPseudoknot", True)
        if not isinstance(allow, bool):
            raise ValueError("allowPseudoknot must be a boolean")
        payload = {
            "sequence": sequence,
            "evidenceMode": request.get("evidenceMode", "none"),
            "evidenceArms": request.get("evidenceArms", []),
            "beamSize": params.get("beamSize", params.get("beam", 20)),
            "maxPhase1": params.get("maxPhase1", params.get("max_phase1", 3)),
            "energyDelta": params.get("energyDelta", params.get("delta", 5)),
            "energyModel": params.get("energyModel", params.get("model", "DP09")),
            "alpha": params.get("alpha", 0.5),
            "beta": params.get("beta", 0),
            "allowPseudoknot": allow,
            "maxSequenceLength": max_nt,
        }
        result = module.fold(payload)
        cap_bonus_entries(result)
        result["runtime"] = "RNAxRay Desktop bundled Python/NumPy/Numba"
        result["native"] = True
        result["ok"] = True
        return result
    if operation == "import_input":
        path = project_path(request)
        errors = validate_project_directory(path)
        if errors: raise ValueError("invalid project: " + "; ".join(errors))
        source = request.get("source")
        if not isinstance(source, str) or not source.strip(): raise ValueError("input source must be a non-empty path")
        item = import_input(path, Path(source), role=str(request.get("role", "other")), label=str(request.get("label", "")))
        return {"ok": True, "path": str(path), "input": item}
    if operation == "read_input":
        path = project_path(request)
        errors = validate_project_directory(path)
        if errors: raise ValueError("invalid project: " + "; ".join(errors))
        return {"ok": True, "path": str(path), "input": read_input(path, str(request.get("relative", "")))}
    if operation == "save_analysis_run":
        path = project_path(request)
        errors = validate_project_directory(path)
        if errors: raise ValueError("invalid project: " + "; ".join(errors))
        return {"ok": True, "path": str(path), "run": save_analysis_run(path, request.get("result", {}))}
    if operation == "update_ui_state":
        path = project_path(request)
        errors = validate_project_directory(path)
        if errors: raise ValueError("invalid project: " + "; ".join(errors))
        result = update_ui_state(path, request.get("ui_state", {}))
        return {"ok": True, "path": str(path), **result}
    if operation == "register_task_run":
        path = project_path(request)
        errors = validate_project_directory(path)
        if errors: raise ValueError("invalid project: " + "; ".join(errors))
        task_id = request.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise ValueError("task_id must be a safe identifier")
        _safe_task_id(task_id, "task-")
        return {"ok": True, "path": str(path), "run": register_task_run(path, task_id)}
    if operation == "run_task":
        raw_path = request.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ValueError("project path must be a non-empty string")
        path = Path(raw_path).expanduser().resolve()
        kind = str(request.get("kind", "validate_project"))
        if kind != "validate_project":
            raise ValueError("unsupported safe task kind: %s" % kind)
        task_id = _safe_task_id(request.get("task_id"), "task-")
        if not path.is_dir() or not (path / "project.json").is_file():
            raise ValueError("project directory with project.json does not exist: %s" % path)
        errors = validate_project_directory(path)
        if errors:
            raise ValueError("invalid project: " + "; ".join(errors))
        run_dir = _secure_run_dir(path, task_id)
        request_file = run_dir / "task-request.json"
        request_file.write_text(json.dumps({"operation": "validate_project", "path": str(path), "check_files": True}), encoding="utf-8")
        events: list[dict[str, object]] = [{"type": "queued", "taskId": task_id, "status": "queued"}]
        def collect(event: dict[str, object]) -> None:
            events.append(event)
        runtime_root = repo_root or Path(__file__).resolve().parents[2]
        spec = TaskSpec.from_values([sys.executable, "-m", "desktop.runtime.bridge", "--repo-root", str(runtime_root), "--request", str(request_file)], cwd=runtime_root, task_id=task_id)
        code = TaskRunner(collect).run(spec)
        (run_dir / "events.jsonl").write_text("".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events), encoding="utf-8")
        result = {"ok": True, "task_id": task_id, "status": "succeeded" if code == 0 else "failed", "exit_code": code, "events": events, "run_dir": str(run_dir)}
        if code:
            result["error"] = "Project validation failed; see the task events for details."
        # status.json is owned by the shell's task scheduler; children report via result.json.
        _atomic_write_json(run_dir / "result.json", result)
        return result
    if operation == "warmup":
        # Fold the CPLfold reference hairpin once so Numba compiles (and
        # caches) every kernel before the user's first prediction.
        started = time.monotonic()
        result = handle({"operation": "cplfold_predict", "sequence": "GGCGCGGCACCGUCCGCGGAACAAACGG",
                         "parameters": {"beam": 20}}, repo_root=repo_root)
        if result.get("status") == "unavailable":
            return result
        return {"ok": True, "status": "warm", "seconds": round(time.monotonic() - started, 2)}
    if operation == "pipeline_run":
        return _pipeline_run(request, repo_root)
    if operation == "structure_run":
        # Evidence-guided CPLfold over a genome or windows (desktop/runtime/structure.py).
        from .structure import structure_run
        return structure_run(request, repo_root)
    if operation == "compare_run":
        # Two-condition DESeq2 comparison of contact maps (desktop/runtime/compare.py).
        from .compare import compare_run
        return compare_run(request, repo_root)
    if operation == "energy_run":
        # RNAcofold energies of a test's enriched interactions (desktop/runtime/energy.py).
        from .energy import energy_run
        return energy_run(request)
    sample_result = _sample_ops(str(operation), request, repo_root)
    if sample_result is not None:
        return sample_result
    if operation == "cplfold_run":
        raw_path = request.get("project_path")
        sequence = request.get("sequence")
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ValueError("project path must be a non-empty string")
        if not isinstance(sequence, str) or not sequence.strip():
            raise ValueError("sequence must contain RNA bases A/C/G/U/T/N")
        sequence = "".join(sequence.upper().split()).replace("T", "U")
        if not sequence or any(c not in "ACGUN" for c in sequence):
            raise ValueError("sequence must contain RNA bases A/C/G/U/T/N")
        no_pk = isinstance(request.get("parameters"), dict) and request["parameters"].get("no_pseudoknot") is True
        max_nt = cplfold_max_nt(not no_pk)
        if len(sequence) > max_nt:
            raise ValueError(f"sequence exceeds CPLfold safety limit ({max_nt} nt)")
        path = Path(raw_path).expanduser().resolve()
        errors = validate_project_directory(path)
        if errors: raise ValueError("invalid project: " + "; ".join(errors))
        task_id = _safe_task_id(request.get("task_id"), "cplfold-")
        requested_run_dir = request.get("run_dir")
        if requested_run_dir is not None:
            run_dir = Path(str(requested_run_dir)).expanduser().resolve()
            runs_root = (path / "runs").resolve()
            if not run_dir.is_dir() or os.path.commonpath([str(run_dir), str(runs_root)]) != str(runs_root) or run_dir.parent != runs_root:
                raise ValueError("run_dir must be an existing direct child of project runs")
        else:
            run_dir = _secure_run_dir(path, task_id)
        root = Path(repo_root or Path.cwd()).resolve(); executable = root / "bin" / "cplfold"
        if not executable.is_file():
            return {"ok": False, "status": "unavailable", "error": "native CPLfold runtime is not bundled", "task_id": task_id}
        sequence_file = run_dir / "sequence.fa"; sequence_file.write_text(">sequence\n" + sequence + "\n", encoding="utf-8")
        # Invoke the script through the interpreter that launched this bridge.
        # The vendored ``bin/cplfold`` shebang is intentionally not trusted:
        # ``/usr/bin/env python3`` would otherwise escape a bundled runtime and
        # silently run the host Python.
        argv = [sys.executable, str(executable), "--sequence-file", str(sequence_file)]
        params = request.get("parameters") if isinstance(request.get("parameters"), dict) else {}
        allowed = {"alpha": "--alpha", "beta": "--beta", "beam": "--beam", "delta": "--delta", "max_phase1": "--max-phase1", "max_phase2": "--max-phase2", "model": "--model"}
        bounds = {"alpha": (-100.0, 100.0), "beta": (-100.0, 100.0), "beam": (1, 5000), "delta": (0.0, 100.0), "max_phase1": (1, 1000), "max_phase2": (1, 1000)}
        for key, flag in allowed.items():
            if key in params:
                value = params[key]
                if not isinstance(value, (int, float, str)) or isinstance(value, bool): raise ValueError("invalid CPLfold parameter: " + key)
                if key in bounds:
                    try: numeric = float(value)
                    except (TypeError, ValueError): raise ValueError("invalid CPLfold parameter: " + key)
                    lo, hi = bounds[key]
                    if numeric < lo or numeric > hi or (key not in {"alpha", "beta", "delta"} and numeric != int(numeric)):
                        raise ValueError("CPLfold parameter out of bounds: " + key)
                argv.extend([flag, str(value)])
        if params.get("no_pseudoknot") is True: argv.append("--no-pseudoknot")
        bonus = request.get("bonus_matrix")
        if bonus is not None:
            if isinstance(bonus, list):
                if len(bonus) > 5000 or any(not isinstance(row, list) or len(row) > 5000 or any(not isinstance(value, (int, float)) or isinstance(value, bool) for value in row) for row in bonus):
                    raise ValueError("bonus_matrix rows must be bounded numeric arrays")
                n = len(bonus)
                if any(len(row) != n for row in bonus): raise ValueError("bonus_matrix must be square")
                entries = ["# RNAxRay CPLfold bonus matrix", f"# sequence_length={len(sequence)}", "# coordinate_system=prepared-sequence-1-based-inclusive", "prepared_position_1\tprepared_position_2\tlog1p_gaussian_hyb_bonus"]
                entries.extend(f"{i+1}\t{j+1}\t{float(value):.8g}" for i, row in enumerate(bonus) for j, value in enumerate(row) if float(value) != 0.0 and i < j)
                bonus = "\n".join(entries) + "\n"
            if not isinstance(bonus, str) or len(bonus) > 20_000_000: raise ValueError("bonus_matrix must be a bounded text matrix or numeric matrix")
            bonus_file = run_dir / "bonus.matrix"; bonus_file.write_text(bonus, encoding="utf-8"); argv.extend(["--bonus-matrix-file", str(bonus_file)])
        output = run_dir / "cplfold.out"
        argv.extend(["--output", str(output), "--quiet"])
        env = os.environ.copy()
        env.setdefault("RNAXRAY_CPLFOLD_MAX_NT", str(max_nt))
        # Keep JIT artifacts inside the project run.  This is writable in
        # packaged apps and prevents a hostile/shared global cache from being
        # reused across projects.
        cache_root = run_dir / "numba-cache"
        cache_root.mkdir(mode=0o700, exist_ok=True)
        env["XDG_CACHE_HOME"] = str(cache_root)
        try:
            completed = subprocess.run(argv, cwd=root, capture_output=True, text=True, timeout=900, check=False, env=env)
        except subprocess.TimeoutExpired as error:
            result = {"ok": False, "status": "failed", "task_id": task_id, "run_dir": str(run_dir), "error": "CPLfold timed out", "exit_code": None, "stdout": (error.stdout or "")[-20000:], "stderr": (error.stderr or "")[-20000:]}
            _atomic_write_json(run_dir / "result.json", result)
            return result
        result = {"ok": completed.returncode == 0, "status": "succeeded" if completed.returncode == 0 else "failed", "task_id": task_id, "run_dir": str(run_dir), "output": str(output) if output.exists() else None, "stdout": completed.stdout[-20000:], "stderr": completed.stderr[-20000:], "exit_code": completed.returncode}
        _atomic_write_json(run_dir / "result.json", result)
        return result
    raise ValueError("unsupported bridge operation: %s" % operation)


# --- analysis queries (R3): aggregated results from per-sample SQLite indexes ---

_ANALYSIS_OPS = {"analysis_summary", "analysis_contact_bins", "analysis_hybrids", "analysis_top",
                 "analysis_viewpoint", "analysis_region", "compare_bins", "analysis_compare_bins"}


def _analysis_module(repo_root: Path | None) -> Any:
    package = Path(repo_root or Path.cwd()).resolve() / "pipeline"
    if not (package / "rnaxrayanalysis" / "__init__.py").is_file():
        raise ValueError("the analysis backend (rnaxrayanalysis) is not bundled")
    if str(package) not in sys.path:
        sys.path.insert(0, str(package))
    import rnaxrayanalysis
    return rnaxrayanalysis


def _analysis_project(request: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    raw_path = request.get("project_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("project path must be a non-empty string")
    project = Path(raw_path).expanduser().resolve()
    if project.name == "project.json":
        project = project.parent
    manifest = json.loads((project / "project.json").read_text(encoding="utf-8"))
    return project, manifest if isinstance(manifest, dict) else {}


def _sample_index_paths(project: Path, manifest: dict[str, Any], sample_ids: Any, key: str = "sample_ids") -> tuple[list[str], list[Path]]:
    """Sample ids -> index files via project.json ``samples[].outputs.index``.

    Relative index paths resolve inside the project; absolute ones (linked
    data) are used as given.
    """
    if not isinstance(sample_ids, list) or not all(isinstance(s, str) and s for s in sample_ids):
        raise ValueError("%s must be a list of sample ids" % key)
    samples = {s.get("id"): s for s in manifest.get("samples") or [] if isinstance(s, dict)}
    paths: list[Path] = []
    ids: list[str] = []
    for sample_id in sample_ids:
        sample = samples.get(sample_id)
        if sample is None:
            raise ValueError("unknown sample: %s" % sample_id)
        index = ((sample.get("outputs") or {}).get("index")) if isinstance(sample.get("outputs"), dict) else None
        if not isinstance(index, str) or not index:
            raise ValueError("sample has no analysis index yet: %s" % sample_id)
        if Path(index).is_absolute():
            _trust.require(project, index, "sample index of %s" % sample_id)
            target = Path(index).resolve()
        else:
            if not safe_relative_path(index):
                raise ValueError("sample index must be a project-relative or absolute path: %s" % sample_id)
            target = (project / index).resolve()
            if project not in target.parents:
                raise ValueError("sample index escapes the project: %s" % sample_id)
        paths.append(target)
        ids.append(sample_id)
    return ids, paths


def _reference_lengths(manifest: dict[str, Any], sample_ids: list[str]) -> dict[str, int]:
    """Gene name -> length from the references of the given samples (project references[].sequences)."""
    references = {r.get("id"): r for r in manifest.get("references") or [] if isinstance(r, dict)}
    lengths: dict[str, int] = {}
    wanted = set(sample_ids)
    for sample in manifest.get("samples") or []:
        if not isinstance(sample, dict) or sample.get("id") not in wanted:
            continue
        reference = references.get(sample.get("reference_id"))
        for sequence in (reference or {}).get("sequences") or []:
            if isinstance(sequence, dict) and isinstance(sequence.get("name"), str) \
                    and type(sequence.get("length")) is int and sequence["length"] >= 0:
                lengths.setdefault(sequence["name"], sequence["length"])
    return lengths


def _existing(paths: list[Path]) -> list[Path]:
    for path in paths:
        if not path.is_file():
            raise ValueError("analysis index not found: %s" % path)
    return paths


def _analysis_index_paths(request: dict[str, Any]) -> tuple[list[str], list[Path], dict[str, int]]:
    """``(sample_ids, index paths, reference lengths)`` for an analysis request.

    ``sample_ids`` resolve through the project; ``index_paths`` may list index
    files directly (no reference lengths are known for those).
    """
    sample_ids = request.get("sample_ids")
    explicit = request.get("index_paths")
    paths: list[Path] = []
    ids: list[str] = []
    lengths: dict[str, int] = {}
    if sample_ids is not None:
        project, manifest = _analysis_project(request)
        ids, paths = _sample_index_paths(project, manifest, sample_ids)
        lengths = _reference_lengths(manifest, ids)
    if explicit is not None:
        if not isinstance(explicit, list) or not all(isinstance(p, str) and p for p in explicit):
            raise ValueError("index_paths must be a list of paths")
        paths.extend(Path(p).expanduser().resolve() for p in explicit)
    if not paths:
        raise ValueError("sample_ids or index_paths is required")
    return ids, _existing(paths), lengths


def _analysis_op(operation: str, request: dict[str, Any], repo_root: Path | None) -> dict[str, Any]:
    analysis = _analysis_module(repo_root)
    query = analysis.query

    def opt_int(name: str, default: Any) -> Any:
        value = request.get(name, default)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("%s must be an integer" % name)
        return value

    def opt_str(name: str) -> Any:
        value = request.get(name)
        if value is not None and not isinstance(value, str):
            raise ValueError("%s must be a string" % name)
        return value

    def opt_types() -> Any:
        value = request.get("types")
        if value is not None and (not isinstance(value, list) or not all(isinstance(t, str) for t in value)):
            raise ValueError("types must be a list of chimera type names")
        return value

    def opt_bool(name: str) -> bool:
        value = request.get(name, False)
        if not isinstance(value, bool):
            raise ValueError("%s must be a boolean" % name)
        return value

    def required_gene() -> str:
        gene = opt_str("gene")
        if not gene:
            raise ValueError("gene is required")
        return gene

    if operation in ("compare_bins", "analysis_compare_bins"):
        project, manifest = _analysis_project(request)
        ids_a, paths_a = _sample_index_paths(project, manifest, request.get("sample_ids_a"), "sample_ids_a")
        ids_b, paths_b = _sample_index_paths(project, manifest, request.get("sample_ids_b"), "sample_ids_b")
        if not ids_a or not ids_b:
            raise ValueError("sample_ids_a and sample_ids_b must each name at least one sample")
        result = query.compare_bins(_existing(paths_a), _existing(paths_b), required_gene(), opt_int("bin_size", 10),
                                    request.get("region"), gene2=opt_str("gene2"), types=opt_types(),
                                    measure=opt_str("measure") or "records", orientation=opt_str("orientation") or "oriented",
                                    max_cells=opt_int("max_cells", None), fixed_bin=opt_bool("fixed_bin"),
                                    lengths=_reference_lengths(manifest, ids_a + ids_b))
        return {"ok": True, "operation": "compare_bins", "sample_ids_a": ids_a, "sample_ids_b": ids_b,
                "indexes_a": [str(p) for p in paths_a], "indexes_b": [str(p) for p in paths_b], "result": result}

    sample_ids, paths, lengths = _analysis_index_paths(request)
    if operation == "analysis_summary":
        result = query.summary(paths, lengths=lengths)
    elif operation == "analysis_contact_bins":
        result = query.contact_bins(paths, required_gene(), opt_int("bin_size", 10), request.get("region"), gene2=opt_str("gene2"),
                                    types=opt_types(), measure=opt_str("measure") or "records",
                                    max_cells=opt_int("max_cells", None), orientation=opt_str("orientation") or "oriented",
                                    fixed_bin=opt_bool("fixed_bin"), lengths=lengths)
    elif operation == "analysis_top":
        result = query.top_interactions(paths, required_gene(), opt_int("bin_size", 10), opt_int("n", 50), gene2=opt_str("gene2"),
                                        region=request.get("region"), types=opt_types(),
                                        measure=opt_str("measure") or "records", orientation=opt_str("orientation") or "oriented")
    elif operation == "analysis_viewpoint":
        result = query.viewpoint(paths, required_gene(), opt_int("start", None), opt_int("end", None), partner=opt_str("partner"),
                                 types=opt_types(), measure=opt_str("measure") or "records", bin_size=opt_int("bin_size", 1),
                                 lengths=lengths)
    elif operation == "analysis_region":
        result = query.region(paths, required_gene(), opt_int("start", None), opt_int("end", None), partner=opt_str("partner"),
                              partner_start=opt_int("partner_start", None), partner_end=opt_int("partner_end", None),
                              overlap=opt_str("overlap") or "any", types=opt_types(), limit=opt_int("limit", 100))
    else:
        filters = {} if request.get("filters") is None else request["filters"]
        if not isinstance(filters, dict):
            raise ValueError("filters must be an object")
        result = query.hybrids(paths, filters, opt_int("limit", 100), opt_int("offset", 0),
                               order=opt_str("order") or "file", with_sequence=request.get("with_sequence", True) is not False)
    return {"ok": True, "operation": operation, "sample_ids": sample_ids, "indexes": [str(p) for p in paths], "result": result}


def _json_safe(value: Any) -> Any:
    """Replace NaN/Infinity (not valid JSON for strict readers) with null."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): _json_safe(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(child) for child in value]
    return value


def _dumps_line(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=True, allow_nan=False)
    except ValueError:
        return json.dumps(_json_safe(value), ensure_ascii=True, allow_nan=False)


def serve(repo_root: Path | None = None, stdin: Any = None, stdout: Any = None) -> int:
    """Long-lived sidecar loop: one JSON request line in, one response line out.

    The protocol stream is a private duplicate of fd 1; fd 1 and ``sys.stdout``
    are pointed at stderr so stray prints (Python or native) cannot corrupt it.
    """
    if stdout is None:
        protocol_fd = os.dup(1)
        sys.stdout.flush()
        os.dup2(2, 1)
        stdout = os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")
    reader = stdin if stdin is not None else sys.stdin.buffer
    while True:
        raw = reader.readline()
        if not raw:
            return 0
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        if not line.strip():
            continue
        request_id: Any = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict) or not isinstance(message.get("request"), dict):
                if isinstance(message, dict) and isinstance(message.get("id"), (int, str)) and not isinstance(message.get("id"), bool):
                    request_id = message["id"]
                raise ValueError("sidecar message must be {\"id\": <int>, \"request\": {...}}")
            request_id = message.get("id")
            with contextlib.redirect_stdout(sys.stderr):
                response = handle(message["request"], repo_root=repo_root)
        except Exception as error:  # noqa: BLE001 - every failure must be a protocol response
            response = {"ok": False, "error": str(error) or error.__class__.__name__}
        stdout.write(_dumps_line({"id": request_id, "response": response}) + "\n")
        stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="RNAxRay Desktop JSON bridge")
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--request", type=Path, help="JSON request file; stdin is used when omitted")
    parser.add_argument("--validate-project", type=Path, help="validate a project directory")
    parser.add_argument("--result-file", type=Path, help="also write the response here (default: result.json beside a task-request.json)")
    parser.add_argument("--serve", action="store_true", help="long-lived line protocol on stdin/stdout")
    args = parser.parse_args()
    if args.serve:
        return serve(args.repo_root)
    try:
        raw = args.request.read_text(encoding="utf-8") if args.request else (json.dumps({"operation": "validate_project", "path": str(args.validate_project), "check_files": True}) if args.validate_project else input())
        result = handle(json.loads(raw), repo_root=args.repo_root)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        result = {"ok": False, "error": str(error)}
    result_file = args.result_file or (args.request.parent / "result.json" if args.request and args.request.name == "task-request.json" else None)
    if result_file is not None:
        try:
            _atomic_write_json(result_file, _json_safe(result))
        except OSError as error:
            print("cannot write result file: %s" % error, file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())

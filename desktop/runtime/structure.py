"""Evidence-guided CPLfold structure runs (bridge operation ``structure_run``).

Two modes share one request shape::

    {"operation": "structure_run", "project_path": ..., "task_id": ..., "run_dir": ...,
     "sample_ids": [...] | "hyb_paths": [...], "reference": <fasta path>, "gene_id": ...,
     "mode": "genome" | "windows", "windows": [{"start": 1, "end": 1500}, ...],
     "parameters": {"alpha": 0.5, "beam": 100, "allow_pseudoknot": ..., ...},
     "workers": <int>, "memory_budget_mb": <int>}

* ``genome`` folds the whole reference sequence once (pseudoknot-free by
  default: Phase 1 only) with the HYB bonus of every intramolecular chimera
  of ``gene_id``.
* ``windows`` folds each window separately (pseudoknots allowed by default),
  with the chimeras whose two arms both lie inside that window, in a process
  pool: one window per process, ``numba.set_num_threads(1)``, and
  ``min(cpu, memory budget / per-window estimate, windows)`` workers.

The .hyb files are streamed in the sidecar; arms never pass through the
WebView.  Results go to ``<project>/structures/<task_id>/`` (structure.dbn,
pairs.tsv, structure.ct, meta.json); the task's ``run_dir`` gets
``progress.json`` while running and ``result.json`` at the end.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from multiprocessing import get_context
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .detector import CPLFOLD_MEMORY_FRACTION, cplfold_limits, cplfold_memory_estimate, memory_snapshot
from .project import _atomic_write_json, load_manifest, safe_relative_path, validate_project_directory
from .samples import _rnaxray_reference_name
from . import trust as _trust

_TASK_ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
MAX_WINDOWS = 512
MAX_HYB_FILES = 64
MIN_WINDOW_NT = 10
DEFAULTS = {
    "alpha": 0.5,
    "beam": 100,
    "max_phase1": 1,
    "energy_delta": 5.0,
    "beta": 0.0,
    "energy_model": "DP09",
}
_BOUNDS = {
    "alpha": (0.0, 1.0, float),
    "beam": (1, 1000, int),
    "max_phase1": (1, 20, int),
    "energy_delta": (0.0, 50.0, float),
    "beta": (0.0, 1.0, float),
}
_ALIASES = {"beamSize": "beam", "maxPhase1": "max_phase1", "energyDelta": "energy_delta", "delta": "energy_delta",
            "energyModel": "energy_model", "model": "energy_model", "allowPseudoknot": "allow_pseudoknot"}
ENERGY_MODELS = {"DP03", "DP09", "CC06", "CC09", "RE"}
BRACKET_CLOSE = {")": "(", "]": "[", "}": "{", ">": "<"}

# cplfold_web modules loaded in this process, keyed by source path.
_MODULES: Dict[str, Any] = {}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _peak_rss_bytes() -> int:
    try:
        import resource  # POSIX only; Windows has no getrusage
    except ImportError:
        return 0
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def load_cplfold_web(root: Path) -> Any:
    """Import ``web/cplfold/cplfold_web.py`` with the vendored CPLfold on the path."""
    source = Path(root) / "web" / "cplfold" / "cplfold_web.py"
    key = str(source)
    if key in _MODULES:
        return _MODULES[key]
    if not source.is_file():
        raise FileNotFoundError("native CPLfold source is not bundled")
    for extra in (str(Path(root) / "third_party" / "cplfold"), str(source.parent)):
        if extra not in sys.path:
            sys.path.insert(0, extra)
    spec = importlib.util.spec_from_file_location("rnaxray_structure_cplfold", source)
    if spec is None or spec.loader is None:
        raise ImportError("native CPLfold module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _MODULES[key] = module
    return module


class ProgressWriter:
    """Atomic ``run_dir/progress.json`` writes, throttled to ~2 per second."""

    def __init__(self, run_dir: Optional[Path], interval: float = 0.5):
        self.path = run_dir / "progress.json" if run_dir is not None else None
        self.interval = interval
        self._last = 0.0
        # What is folded ({lengths, beam, workers}): the desktop estimates
        # the time left from it.
        self.work: Optional[Dict[str, Any]] = None

    def __call__(self, stage: str, detail: str, done: Optional[int] = None, total: Optional[int] = None,
                 *, units: str = "bytes", force: bool = False) -> None:
        now = time.monotonic()
        if self.path is None or (not force and now - self._last < self.interval):
            return
        self._last = now
        payload = {"stage": stage, "detail": detail, "bytes_done": done, "bytes_total": total,
                   "units": units, "updated_at": _now()}
        if self.work:
            payload["work"] = self.work
        try:
            _atomic_write_json(self.path, payload)
        except OSError:
            pass


def _compiled_kernels() -> Optional[int]:
    """Numba's cached kernels (NUMBA_CACHE_DIR), or None when unknown: a fold
    that adds some compiled them, which is not folding speed."""
    cache = os.environ.get("NUMBA_CACHE_DIR")
    if not cache or not Path(cache).is_dir():
        return None
    return sum(1 for _ in Path(cache).rglob("*.nbc"))


def _env_int(name: str) -> Optional[int]:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return None
    return value if value > 0 else None


def _safe_task_id(value: Any) -> str:
    task_id = str(value or ("structure-" + os.urandom(8).hex()))
    if not task_id or len(task_id) > 64 or not task_id[0].isalpha() or any(c not in _TASK_ID_CHARS for c in task_id):
        raise ValueError("task_id must be a safe identifier")
    return task_id


def _real_child_dir(parent: Path, name: str, *, exist_ok: bool) -> Path:
    """``parent/name`` as a real directory, never following a symlink."""
    if parent.exists() and (parent.is_symlink() or not parent.is_dir()):
        raise ValueError(f"project {parent.name} directory must be a real directory")
    parent.mkdir(mode=0o700, exist_ok=True)
    target = parent / name
    if target.is_symlink():
        raise ValueError(f"{parent.name}/{name} must not be a symlink")
    if target.exists():
        if not exist_ok or not target.is_dir():
            raise FileExistsError(f"{parent.name}/{name} already exists")
        return target
    target.mkdir(mode=0o700)
    return target


def _resolve_run_dir(project: Path, task_id: str, requested: Any) -> Path:
    runs_root = (project / "runs").resolve()
    if requested is not None:
        run_dir = Path(str(requested)).expanduser().resolve()
        if not run_dir.is_dir() or run_dir.parent != runs_root:
            raise ValueError("run_dir must be an existing direct child of project runs")
        return run_dir
    return _real_child_dir(project / "runs", task_id, exist_ok=False)


def _input_file(project: Path, value: Any, label: str) -> Path:
    """A project-relative path inside the project, or an absolute path (linked data)."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty path")
    if os.path.isabs(value) or value.startswith("~"):
        _trust.require(project, value, label)
        target = Path(value).expanduser().resolve()
    else:
        if not safe_relative_path(value):
            raise ValueError(f"{label} must be a safe project-relative or absolute path")
        target = (project / value).resolve()
        if project not in target.parents:
            raise ValueError(f"{label} escapes the project")
    if not target.is_file():
        raise ValueError(f"{label} does not exist: {value}")
    return target


def read_fasta(path: Path) -> List[Tuple[str, str]]:
    """``(name, sequence)`` records.  Names follow ``samples.read_fasta_sequences``:
    rnaxray ``|``-headers are renamed the way the pipeline does, so they match
    .hyb gene IDs; otherwise the first header word."""
    headers: List[str] = []
    chunks: List[List[str]] = []
    opener = __import__("gzip").open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if line.startswith(">"):
                headers.append(line[1:].strip())
                chunks.append([])
            elif line and chunks:
                chunks[-1].append(line)
    formatted = any("|" in header for header in headers)
    records = []
    for header, parts in zip(headers, chunks):
        name = _rnaxray_reference_name(header) if formatted else header
        records.append(((name.split() or [""])[0], "".join(parts)))
    return records


def _reference_sequence(path: Path, gene_id: Optional[str]) -> Tuple[str, str]:
    records = read_fasta(path)
    if not records:
        raise ValueError("reference FASTA has no sequences")
    chosen = None
    if gene_id is not None:
        chosen = next((record for record in records if record[0] == gene_id), None)
        if chosen is None:
            # Even with one sequence: folding it under gene_id's name would
            # mislabel the result (e.g. evidence of another reference).
            raise ValueError(f"gene_id {gene_id} is not a sequence of the reference FASTA")
    if chosen is None:
        if len(records) > 1:
            raise ValueError("the reference FASTA has several sequences; give gene_id")
        chosen = records[0]
    name, sequence = chosen
    sequence = sequence.upper().replace("T", "U")
    bad = sorted(set(sequence) - set("ACGU"))
    if bad:
        raise ValueError("CPLfold accepts only A, C, G and U; the reference contains " + ", ".join(bad))
    return gene_id or name, sequence


def _parameters(raw: Any, mode: str) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    values: Dict[str, Any] = dict(DEFAULTS)
    values["allow_pseudoknot"] = mode == "windows"
    for key, value in raw.items():
        key = _ALIASES.get(key, key)
        if key in _BOUNDS:
            lo, hi, kind = _BOUNDS[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
                    or not lo <= value <= hi or (kind is int and value != int(value)):
                raise ValueError(f"structure parameter out of bounds: {key}")
            values[key] = kind(value)
        elif key == "allow_pseudoknot":
            if not isinstance(value, bool):
                raise ValueError("allow_pseudoknot must be a boolean")
            values[key] = value
        elif key == "energy_model":
            model = str(value).upper()
            if model not in ENERGY_MODELS:
                raise ValueError("energy_model must be one of DP03, DP09, CC06, CC09 or RE")
            values[key] = model
        else:
            raise ValueError(f"unknown structure parameter: {key}")
    return values


def _windows(raw: Any, length: int) -> List[Tuple[int, int]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("windows mode needs a non-empty windows list")
    if len(raw) > MAX_WINDOWS:
        raise ValueError(f"at most {MAX_WINDOWS} windows per run")
    windows = []
    for index, window in enumerate(raw):
        try:
            start, end = int(window["start"]), int(window["end"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"window {index + 1} needs integer start and end") from error
        if not 1 <= start <= end <= length:
            raise ValueError(f"window {index + 1} ({start}-{end}) is outside 1-{length}")
        if end - start + 1 < MIN_WINDOW_NT:
            raise ValueError(f"window {index + 1} is shorter than {MIN_WINDOW_NT} nt")
        windows.append((start, end))
    return windows


def _evidence_inputs(project: Path, request: Dict[str, Any]) -> Dict[str, Any]:
    """Resolve .hyb paths, the reference FASTA and gene_id from samples or explicit paths."""
    sample_ids = request.get("sample_ids")
    hyb_paths = request.get("hyb_paths")
    reference = request.get("reference")
    gene_id = request.get("gene_id")
    if gene_id is not None and (not isinstance(gene_id, str) or not gene_id.strip()):
        raise ValueError("gene_id must be a non-empty string")
    samples_used: List[Dict[str, Any]] = []
    paths: List[Path] = []
    if sample_ids:
        if not isinstance(sample_ids, list) or not all(isinstance(item, str) for item in sample_ids):
            raise ValueError("sample_ids must be a list of sample ids")
        manifest = json.loads((project / "project.json").read_text(encoding="utf-8"))
        samples = {sample.get("id"): sample for sample in manifest.get("samples") or [] if isinstance(sample, dict)}
        references = {item.get("id"): item for item in manifest.get("references") or [] if isinstance(item, dict)}
        reference_ids = set()
        genes = set()
        for sample_id in sample_ids:
            sample = samples.get(sample_id)
            if sample is None:
                raise ValueError(f"unknown sample: {sample_id}")
            hyb = (sample.get("outputs") or {}).get("hyb")
            reads = sample.get("reads") or {}
            if not hyb and reads.get("format") == "hyb":
                hyb = reads.get("path")  # a linked or copied .hyb is its own output
            if not hyb:
                raise ValueError(f"sample {sample_id} has no .hyb output yet")
            paths.append(_input_file(project, hyb, f"sample {sample_id} .hyb"))
            reference_ids.add(sample.get("reference_id"))
            if sample.get("gene_id"):
                genes.add(sample["gene_id"])
            samples_used.append({"id": sample_id, "hyb": str(paths[-1]), "reference_id": sample.get("reference_id"),
                                 "gene_id": sample.get("gene_id"), "condition": sample.get("condition")})
        if reference is None:
            if len(reference_ids) != 1 or None in reference_ids:
                raise ValueError("the selected samples must share one reference")
            entry = references.get(next(iter(reference_ids)))
            if not entry or not entry.get("path"):
                raise ValueError("the samples' reference is missing from the project")
            reference = entry["path"]
        if gene_id is None and len(genes) == 1:
            gene_id = next(iter(genes))
        elif gene_id is None and len(genes) > 1:
            raise ValueError("the selected samples have different gene_id values; give gene_id")
    if hyb_paths:
        if not isinstance(hyb_paths, list) or len(hyb_paths) > MAX_HYB_FILES:
            raise ValueError(f"hyb_paths must be a list of at most {MAX_HYB_FILES} paths")
        paths.extend(_input_file(project, value, "hyb path") for value in hyb_paths)
    if not paths:
        raise ValueError("structure_run needs sample_ids or hyb_paths")
    if len(paths) > MAX_HYB_FILES:
        raise ValueError(f"at most {MAX_HYB_FILES} .hyb files per run")
    if reference is None:
        raise ValueError("structure_run needs a reference FASTA (reference) when no samples are given")
    reference_path = _input_file(project, reference, "reference")
    return {"hyb_paths": paths, "reference": reference_path, "gene_id": gene_id, "samples": samples_used}


# ---------------------------------------------------------------------------
# folding (runs in the sidecar for genome mode, in pool workers for windows)
# ---------------------------------------------------------------------------

def _pairs(structure: str) -> List[Tuple[int, int, str]]:
    stacks: Dict[str, List[int]] = {opening: [] for opening in BRACKET_CLOSE.values()}
    pairs = []
    for position, character in enumerate(structure, 1):
        if character in stacks:
            stacks[character].append(position)
        elif character in BRACKET_CLOSE:
            opening = BRACKET_CLOSE[character]
            if not stacks[opening]:
                raise ValueError("CPLfold returned unbalanced dot-bracket notation")
            pairs.append((stacks[opening].pop(), position, opening + character))
    pairs.sort()
    return pairs


def fold_one(module: Any, sequence: str, arms: Any, params: Dict[str, Any]) -> Dict[str, Any]:
    """Build the bonus from compressed arms and fold; returns a JSON-able record."""
    started = time.monotonic()
    bonus, evidence = module.build_hyb_bonus_matrix_fast(len(sequence), arms)
    bonus_seconds = time.monotonic() - started
    started = time.monotonic()
    results = module.two_phase_pseudoknot_fold(
        seq=sequence, beam_size=params["beam"], energy_delta=params["energy_delta"],
        max_phase1=params["max_phase1"], max_phase2=1, energy_model=params["energy_model"],
        output_file=None, verbose=False, lv=True, bonus_matrix=bonus,
        alpha=params["alpha"] if bonus is not None else 0.0, beta=params["beta"],
        allow_pseudoknot=params["allow_pseudoknot"])
    fold_seconds = time.monotonic() - started
    if not results:
        raise ValueError("CPLfold did not produce a structure")
    best = results[0]
    structure = best["structure"]
    pairs = [(i, j, bracket, float(bonus[i - 1, j - 1]) if bonus is not None else 0.0)
             for i, j, bracket in _pairs(structure)]
    del bonus
    return {
        "structure": structure,
        "energy": best.get("energy"),
        "type": best.get("type"),
        "pairs": pairs,
        "evidence": evidence,
        "seconds": {"bonus": round(bonus_seconds, 2), "fold": round(fold_seconds, 2)},
        "peak_rss_bytes": _peak_rss_bytes(),
    }


def _worker_init(root: str) -> None:
    os.environ["NUMBA_NUM_THREADS"] = "1"
    try:
        import numba

        numba.set_num_threads(1)
    except (ImportError, AttributeError, ValueError):
        pass
    load_cplfold_web(Path(root))


def _fold_window(root: str, index: int, sequence: str, blocks: List[Tuple[int, int, int, int]],
                 weights: List[int], params: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
    module = load_cplfold_web(Path(root))
    arms = dict(zip(blocks, weights))
    return index, fold_one(module, sequence, arms, params)


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------

def _atomic_write_text(path: Path, text: str) -> None:
    temporary = path.with_name("." + path.name + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _write_outputs(out_dir: Path, records: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, str]:
    dbn, ct = [], []
    tsv = ["window_start\twindow_end\ti\tj\tbracket\tbonus"]
    mode = "pseudoknot" if params["allow_pseudoknot"] else "pseudoknot-free"
    for record in records:
        start, end = record["start"], record["end"]
        energy = record["energy"]
        energy_text = f"{energy:.2f}" if isinstance(energy, (int, float)) else "NA"
        label = f"{record['gene_id']}:{start}-{end}"
        dbn.append(f">{label} CPLfold {mode}, alpha {params['alpha']}, beam {params['beam']}, energy {energy_text}\n"
                   f"{record['sequence']}\n{record['structure']}\n")
        partner = {}
        for i, j, bracket, bonus in record["pairs"]:
            partner[i], partner[j] = j, i
            tsv.append(f"{start}\t{end}\t{start + i - 1}\t{start + j - 1}\t{bracket}\t{bonus:.4f}")
        n = len(record["sequence"])
        ct.append(f"{n}\tENERGY = {energy_text}\t{label}\n")
        for k, base in enumerate(record["sequence"], 1):
            ct.append(f"{k}\t{base}\t{k - 1}\t{k + 1 if k < n else 0}\t{partner.get(k, 0)}\t{start + k - 1}\n")
    paths = {"dbn": out_dir / "structure.dbn", "pairs": out_dir / "pairs.tsv", "ct": out_dir / "structure.ct"}
    _atomic_write_text(paths["dbn"], "".join(dbn))
    _atomic_write_text(paths["pairs"], "\n".join(tsv) + "\n")
    _atomic_write_text(paths["ct"], "".join(ct))
    return {key: str(value) for key, value in paths.items()}


def _summary(record: Dict[str, Any]) -> Dict[str, Any]:
    evidence = record["evidence"]
    pairs = record["pairs"]
    return {
        "start": record["start"], "end": record["end"], "length": len(record["sequence"]),
        "energy": record["energy"], "structure_type": record["type"],
        "pairs": len(pairs),
        "pairs_with_bonus": sum(1 for pair in pairs if pair[3] > 0),
        "pseudoknot_pairs": sum(1 for pair in pairs if pair[2] != "()"),
        "long_range_pairs_gt_1000": sum(1 for pair in pairs if pair[1] - pair[0] > 1000),
        "evidence": {key: evidence.get(key) for key in (
            "source", "builder", "inputRecords", "uniqueBlocks", "meanArmLength", "gaussianStandardDeviation",
            "nonzeroBonusCells", "maximumBonus", "truncationTail", "transform", "evidenceWeight")},
        "seconds": record["seconds"],
        "peak_rss_bytes": record.get("peak_rss_bytes"),
    }


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def _structure_run(request: Dict[str, Any], repo_root: Optional[Path], state: Dict[str, Any]) -> Dict[str, Any]:
    started = time.monotonic()
    raw_path = request.get("project_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("project path must be a non-empty string")
    project = Path(raw_path).expanduser().resolve()
    errors = validate_project_directory(project)
    if errors:
        raise ValueError("invalid project: " + "; ".join(errors))
    task_id = _safe_task_id(request.get("task_id"))
    mode = request.get("mode", "genome")
    if mode not in {"genome", "windows"}:
        raise ValueError("mode must be 'genome' or 'windows'")
    params = _parameters(request.get("parameters"), mode)
    inputs = _evidence_inputs(project, request)
    gene_id, sequence = _reference_sequence(inputs["reference"], inputs["gene_id"])
    windows = _windows(request.get("windows"), len(sequence)) if mode == "windows" else [(1, len(sequence))]

    budget_mb = request.get("memory_budget_mb")
    if budget_mb is not None and (isinstance(budget_mb, bool) or not isinstance(budget_mb, int) or budget_mb < 64):
        raise ValueError("memory_budget_mb must be an integer >= 64")
    # A scheduled task runs under the scheduler's memory budget (request or
    # RNAXRAY_MEMORY_BUDGET_MB), not the momentary free memory; without one it
    # gets the scheduler's default share of physical memory.
    task_mem_mb = _env_int("RNAXRAY_TASK_MEM_MB")
    if budget_mb is None and task_mem_mb is not None:
        # Budget granted by the desktop scheduler for this task.
        budget_mb = task_mem_mb
    if budget_mb is not None:
        budget: Optional[int] = budget_mb * 1024 * 1024
    elif os.environ.get("RNAXRAY_MEMORY_BUDGET_MB"):
        budget = None
    else:
        total = memory_snapshot().get("total_bytes")
        budget = int(total * CPLFOLD_MEMORY_FRACTION) if total else None
    limits = cplfold_limits(budget)
    key = "pseudoknot_max_nt" if params["allow_pseudoknot"] else "pseudoknot_free_max_nt"
    longest = max(end - start + 1 for start, end in windows)
    if longest > int(limits[key]):
        hint = " Use windows mode for long RNAs." if mode == "genome" else ""
        raise ValueError(f"{longest} nt exceeds the CPLfold limit of {limits[key]} nt for this memory budget "
                         f"({'pseudoknot' if params['allow_pseudoknot'] else 'pseudoknot-free'}).{hint}")

    run_dir = _resolve_run_dir(project, task_id, request.get("run_dir"))
    state.update(run_dir=run_dir, task_id=task_id)
    out_dir = _real_child_dir(project / "structures", task_id, exist_ok=True)
    progress = ProgressWriter(run_dir)
    root = Path(repo_root or Path(__file__).resolve().parents[2]).resolve()

    try:
        module = load_cplfold_web(root)
    except (FileNotFoundError, ImportError) as error:
        result = {"ok": False, "status": "unavailable", "task_id": task_id, "run_dir": str(run_dir), "error": str(error)}
        _atomic_write_json(run_dir / "result.json", result)
        return result

    # What will be folded, known before the evidence is read, so the desktop
    # can estimate the time left from the start.
    estimate = cplfold_memory_estimate(longest, params["allow_pseudoknot"])
    cpu = os.cpu_count() or 1
    task_cpus = _env_int("RNAXRAY_TASK_CPUS")
    if task_cpus is not None:
        cpu = min(cpu, task_cpus)
    requested_workers = request.get("workers")
    if requested_workers is not None and (isinstance(requested_workers, bool) or not isinstance(requested_workers, int) or requested_workers < 1):
        raise ValueError("workers must be a positive integer")
    memory_workers = max(1, int(limits["memory_budget_bytes"]) // max(estimate, 1))
    workers = min(cpu, memory_workers, len(windows))
    if requested_workers is not None:
        workers = min(workers, requested_workers)
    progress.work = {"lengths": [end - start + 1 for start, end in windows], "beam": params.get("beam"), "workers": workers}

    # 1. stream the evidence
    total_bytes = sum(path.stat().st_size for path in inputs["hyb_paths"])
    progress("evidence", "reading .hyb", 0, total_bytes, force=True)
    t0 = time.monotonic()
    collected = module.collect_hyb_arms(
        [str(path) for path in inputs["hyb_paths"]], gene_id, len(sequence),
        windows=windows if mode == "windows" else None,
        progress=lambda done: progress("evidence", "reading .hyb", done, total_bytes))
    evidence_seconds = time.monotonic() - t0
    counters = collected["windows"] if mode == "windows" else [collected["genome"]]
    if not any(counters):
        raise ValueError(f"no intramolecular {gene_id} chimeras fall inside the requested region")
    progress("evidence", "done", total_bytes, total_bytes, force=True)

    # 2. fold
    records: List[Dict[str, Any]] = [None] * len(windows)  # type: ignore[list-item]
    kernels_before = _compiled_kernels()
    t0 = time.monotonic()

    def finish(index: int, record: Dict[str, Any]) -> None:
        start, end = windows[index]
        record.update({"start": start, "end": end, "gene_id": gene_id, "sequence": sequence[start - 1:end]})
        records[index] = record

    if workers <= 1:
        for index, ((start, end), arms) in enumerate(zip(windows, counters)):
            progress("fold", f"window {index + 1}/{len(windows)} ({start}-{end})" if mode == "windows" else "folding",
                     index, len(windows), units="windows", force=True)
            finish(index, fold_one(module, sequence[start - 1:end], arms, params))
    else:
        done = 0
        context = get_context("spawn")
        with ProcessPoolExecutor(max_workers=workers, mp_context=context, initializer=_worker_init,
                                 initargs=(str(root),)) as pool:
            futures = [pool.submit(_fold_window, str(root), index, sequence[start - 1:end],
                                   list(arms.keys()), list(arms.values()), params)
                       for index, ((start, end), arms) in enumerate(zip(windows, counters))]
            progress("fold", f"0/{len(windows)} windows on {workers} workers", 0, len(windows), units="windows", force=True)
            for future in as_completed(futures):
                index, record = future.result()
                finish(index, record)
                done += 1
                progress("fold", f"{done}/{len(windows)} windows on {workers} workers", done, len(windows),
                         units="windows", force=True)
    fold_seconds = time.monotonic() - t0

    # 3. write
    progress("write", "writing results", None, None, units="none", force=True)
    outputs = _write_outputs(out_dir, records, params)
    summaries = [_summary(record) for record in records]
    meta = {
        "version": 1,
        "task_id": task_id,
        "mode": mode,
        "engine": "CPLfold",
        "engine_version": getattr(module, "CPLFOLD_SOURCE_REVISION", None),
        "gene_id": gene_id,
        "reference": {"path": str(inputs["reference"]), "length": len(sequence)},
        "evidence_inputs": {
            "samples": inputs["samples"],
            "hyb": [{"path": str(path), "size_bytes": path.stat().st_size} for path in inputs["hyb_paths"]],
            "rows": "intramolecular chimeras (both arms on gene_id) whose arms lie inside the folded region",
            "out_of_range_rows": collected.get("outOfRangeRows", 0),
        },
        "parameters": {**params, "linear_fold_mode": "Vienna", "max_phase2": 1},
        "coordinates": "1-based inclusive positions on the gene_id reference sequence (windows, pairs.tsv i/j, ct column 6)",
        "windows": [{"start": start, "end": end} for start, end in windows],
        "workers": workers,
        "limits": {key: limits.get(key) for key in ("pseudoknot_free_max_nt", "pseudoknot_max_nt", "memory_budget_bytes", "source")},
        "estimated_peak_bytes_per_fold": estimate,
        "records": summaries,
        "timings": {"evidence_s": round(evidence_seconds, 2), "fold_s": round(fold_seconds, 2),
                    "total_s": round(time.monotonic() - started, 2)},
        "created_at": _now(),
    }
    _atomic_write_json(out_dir / "meta.json", meta)
    outputs["meta"] = str(out_dir / "meta.json")
    relative_dir = f"structures/{task_id}"
    energies = [item["energy"] for item in summaries]
    summary = {"records": len(records), "pairs": sum(item["pairs"] for item in summaries),
               "pairs_with_bonus": sum(item["pairs_with_bonus"] for item in summaries),
               "pseudoknot_pairs": sum(item["pseudoknot_pairs"] for item in summaries),
               "energy": energies[0] if len(energies) == 1 else None, "energies": energies,
               "length": sum(item["length"] for item in summaries),
               "workers": workers, "timings": meta["timings"]}
    performance = {**progress.work, "seconds": round(fold_seconds, 2)}
    kernels_after = _compiled_kernels()
    if kernels_before is None or kernels_after is None or kernels_after > kernels_before:
        performance["compiled"] = True  # includes compiling the kernels (first fold after an install)
    result = {
        "ok": True, "status": "succeeded", "task_id": task_id, "run_dir": str(run_dir),
        "output": outputs["dbn"], "output_dir": str(out_dir), "outputs": outputs,
        "performance": performance,
        # A project.json structures[] entry; register_task_run copies it into
        # the manifest when the task finishes.
        "structure": {"id": task_id, "task_id": task_id, "sample_ids": [sample["id"] for sample in inputs["samples"]],
                      "gene_id": gene_id, "mode": mode, "windows": meta["windows"], "parameters": meta["parameters"],
                      "created_at": meta["created_at"], "path": relative_dir,
                      "paths": {key: f"{relative_dir}/{Path(value).name}" for key, value in outputs.items()},
                      "summary": summary},
        "summary": summary,
    }
    progress("done", "finished", None, None, units="none", force=True)
    _atomic_write_json(run_dir / "result.json", result)
    return result


def structure_run(request: Dict[str, Any], repo_root: Optional[Path] = None) -> Dict[str, Any]:
    """Bridge entry point.  Invalid requests raise ``ValueError``; failures after
    the run directory exists are reported in ``result.json`` and returned."""
    state: Dict[str, Any] = {}
    try:
        return _structure_run(request, repo_root, state)
    except Exception as error:  # noqa: BLE001 - every failure must reach result.json
        run_dir = state.get("run_dir")
        if run_dir is None:
            raise
        result = {"ok": False, "status": "failed", "task_id": state.get("task_id"), "run_dir": str(run_dir),
                  "error": str(error) or error.__class__.__name__}
        ProgressWriter(run_dir)("failed", result["error"], None, None, units="none", force=True)
        _atomic_write_json(run_dir / "result.json", result)
        return result


# ---------------------------------------------------------------------------
# registered results (bridge operations list_structures / read_structure)
# ---------------------------------------------------------------------------

def _structure_file(project: Path, entry: Dict[str, Any], key: str) -> Optional[Path]:
    """A registered output file under ``structures/``, or None when absent/unsafe."""
    relative = (entry.get("paths") or {}).get(key) if isinstance(entry.get("paths"), dict) else None
    if not safe_relative_path(relative):
        return None
    target = (project / relative).resolve()
    base = (project / "structures").resolve()
    if base not in target.parents or not target.is_file():
        return None
    return target


def list_structures(project: Path) -> List[Dict[str, Any]]:
    """``structures[]`` of the manifest, newest first, each with ``available``
    (its dot-bracket file still exists)."""
    project = Path(project).expanduser().resolve()
    manifest = load_manifest(project)
    out = []
    for entry in manifest.get("structures") or []:
        if isinstance(entry, dict):
            out.append({**entry, "available": _structure_file(project, entry, "dbn") is not None})
    out.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return out


def parse_dbn(text: str) -> List[Dict[str, Any]]:
    """Records (header, sequence, structure triples) of a structure.dbn from :func:`_write_outputs`."""
    lines = [line.rstrip("\r") for line in text.splitlines() if line.strip()]
    if len(lines) % 3:
        raise ValueError("structure.dbn is malformed (expected header, sequence, structure triples)")
    records = []
    for index in range(0, len(lines), 3):
        header, sequence, structure = lines[index], lines[index + 1], lines[index + 2]
        if not header.startswith(">") or len(sequence) != len(structure):
            raise ValueError("structure.dbn is malformed near record %d" % (index // 3 + 1))
        words = header[1:].split()
        label = words[0] if words else ""
        start = 1
        gene, _, span = label.rpartition(":")
        if gene and "-" in span:
            try:
                start = int(span.split("-", 1)[0])
            except ValueError:
                start = 1
        energy = None
        if "energy " in header:
            try:
                energy = float(header.rsplit("energy ", 1)[1].split()[0])
            except (ValueError, IndexError):
                energy = None
        records.append({"label": label, "window_start": start, "window_end": start + len(sequence) - 1,
                        "sequence": sequence, "dbn": structure, "energy": energy})
    return records


def _pair_bonus(path: Optional[Path]) -> Dict[Tuple[int, int, int], float]:
    """``(window_start, i, j) -> bonus`` from a pairs.tsv of :func:`_write_outputs`."""
    out: Dict[Tuple[int, int, int], float] = {}
    if path is None:
        return out
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    for line in lines[1:]:
        cells = line.split("\t")
        if len(cells) < 6:
            continue
        try:
            out[(int(cells[0]), int(cells[2]), int(cells[3]))] = float(cells[5])
        except ValueError:
            continue
    return out


def read_structure(project: Path, structure_id: str) -> Dict[str, Any]:
    """``{structure, meta, records: [{window_start, window_end, sequence, dbn, pairs, bonus, energy}]}``.

    Coordinates are 1-based positions on the gene: ``window_start``/``window_end``
    bound each folded window and ``pairs`` lists ``[i, j]`` gene positions.
    """
    project = Path(project).expanduser().resolve()
    manifest = load_manifest(project)
    entry = next((item for item in manifest.get("structures") or []
                  if isinstance(item, dict) and item.get("id") == structure_id), None)
    if entry is None:
        raise ValueError("structure does not exist: %s" % structure_id)
    dbn_path = _structure_file(project, entry, "dbn")
    if dbn_path is None:
        raise ValueError("structure files are missing: %s" % structure_id)
    meta_path = _structure_file(project, entry, "meta")
    meta: Dict[str, Any] = {}
    if meta_path is not None:
        try:
            loaded = json.loads(meta_path.read_text(encoding="utf-8"))
            meta = loaded if isinstance(loaded, dict) else {}
        except ValueError:
            meta = {}
    parsed = parse_dbn(dbn_path.read_text(encoding="utf-8"))
    bonus = _pair_bonus(_structure_file(project, entry, "pairs"))
    summaries = meta.get("records") if isinstance(meta.get("records"), list) else []
    records = []
    for index, record in enumerate(parsed):
        start = record["window_start"]
        summary = summaries[index] if index < len(summaries) and isinstance(summaries[index], dict) else {}
        if type(summary.get("start")) is int:
            start = summary["start"]
        energy = summary["energy"] if "energy" in summary else record["energy"]
        pairs = [[start + i - 1, start + j - 1] for i, j, _ in _pairs(record["dbn"])]
        records.append({
            "window_start": start, "window_end": start + len(record["sequence"]) - 1,
            "sequence": record["sequence"], "dbn": record["dbn"], "pairs": pairs,
            # chimera evidence (HYB bonus) of each pair, from pairs.tsv; null when unknown
            "bonus": [bonus.get((start, i, j)) for i, j in pairs] if bonus else None,
            "energy": energy,
        })
    return {"structure": entry, "meta": meta, "records": records}

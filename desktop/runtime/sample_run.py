"""``sample_pipeline_run``: reads -> .hyb -> contact/index for one project sample.

Runs rnaxraypipe.run into ``samples/<sample_id>/<name>`` (stable prefix so the
pipeline's own checkpoint can resume across task ids), then, when the
``rnaxrayanalysis`` package is importable, ``coverage.write_contact`` and
``index.build`` (contract R3).  ``samples[].stages``/``outputs`` are updated
with the locked manifest writer at every stage transition, and every progress
event is written atomically to ``run_dir/progress.json``.
"""
from __future__ import annotations

import dataclasses
import importlib
import importlib.util
import inspect
import json
import os
import re
import signal
import sys
import traceback
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .project import _atomic_write_json, _now, load_manifest, safe_relative_path
from .samples import check_record, disk_estimate, resolve_record_path, read_stem, set_sample_stage

# Stages reported by rnaxraypipe after mapping has finished.
_POST_MAP_STAGES = {"filter", "blast", "rank", "hybrids", "annotate", "energy", "collapse", "dedup", "done"}
_BYTE_EVENT_INTERVAL = 0.2  # seconds; stage changes are always written


class ProgressFile:
    """Atomic ``run_dir/progress.json`` writer (also mirrors events to stderr as JSON lines)."""

    def __init__(self, run_dir: Path):
        self.path = Path(run_dir) / "progress.json"
        self.last_stage: Optional[str] = None
        self.last_write = 0.0
        # Time per stage ("wait": waiting for the map slot) for the speed
        # history, and the input the desktop estimates remaining time from.
        self.started = time.monotonic()
        self.stage_seconds: Dict[str, float] = {}
        self.current: Optional[str] = None
        self.since = self.started
        self.work: Optional[Dict[str, Any]] = None

    def _clock(self, stage: str, detail: str, now: float) -> None:
        key = "wait" if detail.startswith("waiting") else stage
        if key != self.current:
            if self.current is not None:
                self.stage_seconds[self.current] = self.stage_seconds.get(self.current, 0.0) + now - self.since
            self.current, self.since = key, now

    def active_seconds(self) -> float:
        """Seconds so far, without waiting for the map slot."""
        now = time.monotonic()
        self._clock("", "", now)  # close the running stage
        return now - self.started - self.stage_seconds.get("wait", 0.0)

    def write(self, stage: str, detail: str = "", bytes_done: Optional[int] = None, bytes_total: Optional[int] = None) -> None:
        now = time.monotonic()
        self._clock(stage, detail, now)
        if stage == self.last_stage and bytes_done is not None and now - self.last_write < _BYTE_EVENT_INTERVAL and bytes_done != bytes_total:
            return
        self.last_stage, self.last_write = stage, now
        payload = {"stage": stage, "detail": detail, "bytes_done": bytes_done, "bytes_total": bytes_total, "updated_at": _now()}
        if self.work:
            payload["work"] = self.work
        try:
            _atomic_write_json(self.path, payload)
        except OSError as error:  # progress is advisory; never fail the task for it
            print("cannot write progress.json: %s" % error, file=sys.stderr)
        print(json.dumps({"type": "progress", **payload}), file=sys.stderr, flush=True)


class MapSlot:
    """The machine-wide right to run Bowtie2 (an exclusive lock on the file
    in ``RNAXRAY_MAP_SLOT``, set by the desktop scheduler). A sample started
    early collapses its reads while another sample maps, then waits here, so
    mappings never compete for the cores. The OS drops the lock when the
    process ends, also when it is cancelled. Without the variable it is a
    no-op."""

    def __init__(self, path: Optional[str]):
        self.path = path
        self.handle = None

    def _try(self) -> bool:
        if os.name == "nt":
            import msvcrt
            try:
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
                return True
            except OSError:
                return False
        import fcntl
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def acquire(self, waiting: Any = None) -> None:
        if not self.path or self.handle is not None:
            return
        self.handle = open(self.path, "a+b")
        if not self._try():
            if waiting is not None:
                waiting()
            while not self._try():
                time.sleep(0.5)

    def release(self) -> None:
        if self.handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        self.handle.close()
        self.handle = None


_PIPELINE_BOUNDS = {"blast_threshold": (0.0, 10.0, float), "max_overlap": (0, 1000, int), "max_hits": (1, 10000, int),
                    "threads": (1, 256, int), "memory_mb": (64, 1_048_576, int)}


def build_options(options_cls: Any, settings: Dict[str, Any]) -> "tuple[Any, list[str]]":
    """Bounded Options from sample settings; keys the installed Options lacks are reported, not passed."""
    fields = {field.name for field in dataclasses.fields(options_cls)}
    values: Dict[str, Any] = {}
    for key, (lo, hi, kind) in _PIPELINE_BOUNDS.items():
        if settings.get(key) is not None:
            value = settings[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi or (kind is int and value != int(value)):
                raise ValueError("pipeline parameter out of bounds: " + key)
            values[key] = kind(value)
    for key in ("energy", "resume"):
        if key in settings and settings[key] is not None:
            if not isinstance(settings[key], bool):
                raise ValueError("pipeline parameter %s must be a boolean" % key)
            values[key] = settings[key]
    if settings.get("keep_sam") is not None:
        if settings["keep_sam"] not in ("none", "gz", "plain"):
            raise ValueError("keep_sam must be none, gz or plain")
        values["keep_sam"] = settings["keep_sam"]
    if settings.get("tmp_dir") is not None:
        tmp = settings["tmp_dir"]
        if not isinstance(tmp, str) or not Path(tmp).is_absolute() or not Path(tmp).is_dir():
            raise ValueError("tmp_dir must be an existing absolute directory")
        values["tmp_dir"] = Path(tmp)
    ignored = sorted(key for key in values if key not in fields)
    return options_cls(**{key: value for key, value in values.items() if key in fields}), ignored


def _safe_component(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._") or "sample"


def _relative(project: Path, path: Optional[Path]) -> Optional[str]:
    if path is None:
        return None
    try:
        return Path(path).resolve().relative_to(project).as_posix()
    except ValueError:
        return None


@dataclasses.dataclass
class _State:
    stage: str = "map"


def _install_term_handler():
    """Turn SIGTERM into SystemExit so stages can be marked ``interrupted``."""
    if threading.current_thread() is not threading.main_thread() or not hasattr(signal, "SIGTERM"):
        return None
    def raise_exit(signum, frame):  # noqa: ARG001
        raise SystemExit(128 + signum)
    try:
        return signal.signal(signal.SIGTERM, raise_exit)
    except (ValueError, OSError):
        return None


def _index_stage(project: Path, sample: Dict[str, Any], task_id: str, sample_dir: Path, stem: str, hyb_path: Path,
                 progress: "ProgressFile") -> Dict[str, Optional[str]]:
    """contact.txt (when the sample has a gene_id) + analysis index; records outputs and stages.index."""
    coverage = importlib.import_module("rnaxrayanalysis.coverage")
    index = importlib.import_module("rnaxrayanalysis.index")
    sample_id = sample["id"]
    set_sample_stage(project, sample_id, "index", "running", task_id=task_id)
    stage_outputs: Dict[str, Optional[str]] = {}
    gene_id = sample.get("gene_id")
    if gene_id:
        progress.write("contact", "writing contact map for %s" % gene_id)
        contact = sample_dir / ("%s.%s.contact.txt" % (stem, _safe_component(gene_id)))
        coverage.write_contact(hyb_path, gene_id, contact)
        stage_outputs["contact"] = _relative(project, contact)
    progress.write("index", "building analysis index")
    index_path = sample_dir / (stem + ".index.sqlite")
    total = hyb_path.stat().st_size

    def on_bytes(done: int, size: int) -> None:
        progress.write("index", "building analysis index", done, size)

    try:
        takes_progress = "progress" in inspect.signature(index.build).parameters
    except (TypeError, ValueError):
        takes_progress = False
    index.build(hyb_path, index_path, **({"progress": on_bytes} if takes_progress else {}))
    progress.write("index", "analysis index built", total, total)
    stage_outputs["index"] = _relative(project, index_path)
    set_sample_stage(project, sample_id, "index", "succeeded", task_id=task_id, outputs=stage_outputs)
    return stage_outputs


def _sample_dir(project: Path, sample_id: str) -> Path:
    sample_dir = project / "samples" / sample_id
    samples_root = project / "samples"
    if samples_root.is_symlink() or (sample_dir.exists() and sample_dir.is_symlink()):
        raise ValueError("project samples directory must not be a symlink")
    sample_dir.mkdir(parents=True, exist_ok=True)
    if sample_dir.resolve().parent != samples_root.resolve() or project not in sample_dir.resolve().parents:
        raise ValueError("sample output directory escapes the project")
    return sample_dir


def run_sample_index(project: Path, sample_id: str, task_id: str, run_dir: Path, repo_root: Path) -> Dict[str, Any]:
    """``analysis_index_build``: contact + index for a sample's existing .hyb.

    The .hyb is ``samples[].outputs.hyb`` (project-relative), or the sample's
    reads file when its format is ``hyb``.
    """
    project = Path(project).resolve()
    manifest = load_manifest(project)
    sample = next((s for s in manifest["samples"] if s.get("id") == sample_id), None)
    if sample is None:
        raise ValueError("sample does not exist: %s" % sample_id)
    base = {"task_id": task_id, "run_dir": str(run_dir), "sample_id": sample_id}

    def finish(result: Dict[str, Any]) -> Dict[str, Any]:
        result = {**base, **result}
        _atomic_write_json(Path(run_dir) / "result.json", result)
        return result

    progress = ProgressFile(run_dir)
    progress.write("check", "locating the sample .hyb")
    hyb_rel = (sample.get("outputs") or {}).get("hyb")
    reads = sample.get("reads") or {}
    if hyb_rel:
        if not safe_relative_path(hyb_rel):
            raise ValueError("sample .hyb output must be project-relative")
        hyb_path = (project / hyb_rel).resolve()
        if project not in hyb_path.parents:
            raise ValueError("sample .hyb output escapes the project")
        stem = _safe_component(sample.get("name") or read_stem(hyb_path))
    elif reads.get("format") == "hyb":
        hyb_path = resolve_record_path(project, reads)
        stem = _safe_component(sample.get("name") or read_stem(hyb_path))
    else:
        return finish({"ok": False, "status": "failed", "error": "sample %s has no .hyb yet" % sample_id})
    if not hyb_path.is_file():
        return finish({"ok": False, "status": "failed", "error": "sample .hyb not found: %s" % hyb_path})
    package = Path(repo_root).resolve() / "pipeline"
    if str(package) not in sys.path:
        sys.path.insert(0, str(package))
    if importlib.util.find_spec("rnaxrayanalysis") is None:
        set_sample_stage(project, sample_id, "index", "failed", task_id=task_id)
        return finish({"ok": False, "status": "unavailable", "error": "the analysis backend (rnaxrayanalysis) is not bundled"})
    previous_handler = _install_term_handler()
    try:
        outputs = _index_stage(project, sample, task_id, _sample_dir(project, sample_id), stem, hyb_path, progress)
        progress.write("done", "sample %s indexed" % sample_id)
        stages = next(s for s in load_manifest(project)["samples"] if s["id"] == sample_id)["stages"]
        return finish({"ok": True, "status": "succeeded", "output": str(project / outputs["index"]),
                       "outputs": {key: str(project / value) for key, value in outputs.items() if value}, "stages": stages})
    except BaseException as error:
        interrupted = isinstance(error, (KeyboardInterrupt, SystemExit))
        try:
            set_sample_stage(project, sample_id, "index", "interrupted" if interrupted else "failed", task_id=task_id)
        except Exception as nested:  # noqa: BLE001 - keep the original error
            print("cannot record stage failure: %s" % nested, file=sys.stderr)
        if interrupted:
            raise
        traceback.print_exc(file=sys.stderr)
        progress.write("failed", str(error)[:500])
        return finish({"ok": False, "status": "failed", "error": "%s: %s" % (error.__class__.__name__, error), "stage": "index"})
    finally:
        if previous_handler is not None:
            try:
                signal.signal(signal.SIGTERM, previous_handler)
            except (ValueError, OSError):
                pass


def run_sample_pipeline(project: Path, sample_id: str, task_id: str, run_dir: Path, parameters: Dict[str, Any],
                        repo_root: Path) -> Dict[str, Any]:
    project = Path(project).resolve()
    manifest = load_manifest(project)
    sample = next((s for s in manifest["samples"] if s.get("id") == sample_id), None)
    if sample is None:
        raise ValueError("sample does not exist: %s" % sample_id)
    reads_record = sample["reads"]
    fmt = reads_record["format"]
    reference = None
    if sample.get("reference_id") is not None:
        reference = next((r for r in manifest["references"] if r.get("id") == sample["reference_id"]), None)
    # A run that stops before its first stage starts still marks that stage
    # failed with this task, so the Data page shows the failure and its
    # reason instead of a sample that looks as if it was never run.
    first_stage = {"sam": "hyb", "hyb": "index"}.get(fmt, "map")

    def stopped_early() -> None:
        set_sample_stage(project, sample_id, first_stage, "failed", task_id=task_id)

    if reference is None and fmt != "hyb":
        stopped_early()
        raise ValueError("sample %s has no reference" % sample_id)
    settings = dict(sample.get("settings") or {})
    settings.update(parameters or {})
    # The desktop scheduler grants this task a CPU budget; use it unless threads were set explicitly.
    cpus = os.environ.get("RNAXRAY_TASK_CPUS", "")
    if settings.get("threads") is None and cpus.isdigit() and int(cpus) >= 1:
        settings["threads"] = min(int(cpus), 256)
    base = {"task_id": task_id, "run_dir": str(run_dir), "sample_id": sample_id}

    def finish(result: Dict[str, Any]) -> Dict[str, Any]:
        result = {**base, **result}
        _atomic_write_json(Path(run_dir) / "result.json", result)
        return result

    progress = ProgressFile(run_dir)
    progress.work = {"format": fmt, "input_bytes": reads_record.get("size_bytes"), "cpu": settings.get("threads")}
    progress.write("check", "checking input files")
    for kind, record in (("reads", reads_record), ("reference", reference)):
        if record is None:
            continue
        status, detail = check_record(project, record)
        if status != "ok" and not settings.get("allow_changed_inputs"):
            stopped_early()
            return finish({"ok": False, "status": "failed", "error": "%s file is %s: %s (%s)" % (kind, status, record.get("path"), detail)})
    reads_path = resolve_record_path(project, reads_record)
    reference_path = resolve_record_path(project, reference) if reference is not None else None

    if not settings.get("skip_disk_check"):
        estimate = disk_estimate(project, [sample_id], include_completed=True)
        if not estimate["fits"]:
            volume = next(v for v in estimate["volumes"] if not v["ok"])
            stopped_early()
            return finish({"ok": False, "status": "failed", "disk_estimate": estimate,
                           "error": "not enough disk space on %s: need ~%d MB, %d MB free" % (
                               volume["path"], volume["required_bytes"] // 1_000_000, volume["free_bytes"] // 1_000_000)})

    sample_dir = _sample_dir(project, sample_id)
    stem = _safe_component(sample.get("name") or read_stem(reads_path))
    out_prefix = sample_dir / stem

    package = Path(repo_root).resolve() / "pipeline"
    if str(package) not in sys.path:
        sys.path.insert(0, str(package))
    state = _State(stage=first_stage)
    outputs: Dict[str, Optional[str]] = {}
    counts: Dict[str, Any] = {}
    ignored: list = []
    previous_handler = _install_term_handler()
    slot = MapSlot(os.environ.get("RNAXRAY_MAP_SLOT"))
    try:
        # ---- map + hyb (rnaxraypipe) -------------------------------------------
        if fmt == "hyb":
            hyb_path = reads_path
            set_sample_stage(project, sample_id, "map", "skipped", task_id=task_id, extra_stages={"hyb": "skipped"})
        else:
            if not (package / "rnaxraypipe" / "__init__.py").is_file():
                set_sample_stage(project, sample_id, "map" if fmt != "sam" else "hyb", "failed", task_id=task_id)
                return finish({"ok": False, "status": "unavailable", "error": "the Python RNAxRay pipeline is not bundled"})

            os.environ.setdefault("RNAXRAYPIPE_TOOL_DIR", str(Path(repo_root).resolve() / "bin"))
            from rnaxraypipe import Options, run as run_pipeline
            options, ignored = build_options(Options, settings)
            if fmt == "sam":
                state.stage = "hyb"
                set_sample_stage(project, sample_id, "hyb", "running", task_id=task_id, extra_stages={"map": "skipped", "index": "pending"})
            else:
                set_sample_stage(project, sample_id, "map", "running", task_id=task_id, extra_stages={"hyb": "pending", "index": "pending"})

            def on_progress(stage: str, detail: str = "", *extra: Any) -> None:
                if stage == "map":
                    slot.acquire(lambda: progress.write("map", "waiting: another sample is mapping"))
                if stage in _POST_MAP_STAGES:
                    slot.release()
                if state.stage == "map" and stage in _POST_MAP_STAGES:
                    state.stage = "hyb"
                    set_sample_stage(project, sample_id, "map", "succeeded", task_id=task_id, extra_stages={"hyb": "running"})
                done = extra[0] if len(extra) >= 1 and isinstance(extra[0], int) else None
                total = extra[1] if len(extra) >= 2 and isinstance(extra[1], int) else None
                progress.write(stage, detail, done, total)

            def on_bytes(stage: str, done: int, total: int) -> None:
                progress.write(stage, "", done, total)

            kwargs: Dict[str, Any] = {}
            try:
                if "progress_bytes" in inspect.signature(run_pipeline).parameters:
                    kwargs["progress_bytes"] = on_bytes
            except (TypeError, ValueError):
                pass
            result = run_pipeline(reads_path, reference_path, out_prefix, options, on_progress, log=sys.stderr, **kwargs)
            hyb_path = Path(result.hyb)
            counts = dict(getattr(result, "counts", {}) or {})
            outputs = {"hyb": _relative(project, result.hyb), "homodimers": _relative(project, result.homodimers),
                       "stats": _relative(project, result.stats)}
            done_stages = {"hyb": "succeeded"}
            if fmt != "sam":
                done_stages["map"] = "succeeded"
            state.stage = "index"
            set_sample_stage(project, sample_id, "index", "pending", task_id=task_id, outputs=outputs, extra_stages=done_stages)

        # ---- contact + index (rnaxrayanalysis, optional) -----------------------
        state.stage = "index"
        if importlib.util.find_spec("rnaxrayanalysis") is None:
            progress.write("index", "rnaxrayanalysis is not available; contact/index skipped")
            set_sample_stage(project, sample_id, "index", "skipped", task_id=task_id)
            index_status = "skipped"
        else:
            outputs.update(_index_stage(project, sample, task_id, sample_dir, stem, hyb_path, progress))
            index_status = "succeeded"
        progress.write("done", "sample %s finished" % sample_id)
        final = load_manifest(project)
        stages = next(s for s in final["samples"] if s["id"] == sample_id)["stages"]
        absolute = {key: str(project / value) for key, value in outputs.items() if value}
        response = {"ok": True, "status": "succeeded", "output": str(hyb_path), "outputs": absolute, "counts": counts,
                    "stages": stages, "index_status": index_status}
        seconds = progress.active_seconds()
        response["performance"] = {**progress.work, "seconds": round(seconds, 2),
                                   "stage_seconds": {k: round(v, 2) for k, v in progress.stage_seconds.items() if k}}
        if ignored:
            response["ignored_parameters"] = ignored
        return finish(response)
    except BaseException as error:
        interrupted = isinstance(error, (KeyboardInterrupt, SystemExit))
        try:
            set_sample_stage(project, sample_id, state.stage, "interrupted" if interrupted else "failed", task_id=task_id)
        except Exception as nested:  # noqa: BLE001 - keep the original error
            print("cannot record stage failure: %s" % nested, file=sys.stderr)
        if interrupted:
            raise
        traceback.print_exc(file=sys.stderr)
        progress.write("failed", str(error)[:500])
        return finish({"ok": False, "status": "failed", "error": "%s: %s" % (error.__class__.__name__, error), "stage": state.stage})
    finally:
        slot.release()
        if previous_handler is not None:
            try:
                signal.signal(signal.SIGTERM, previous_handler)
            except (ValueError, OSError):
                pass

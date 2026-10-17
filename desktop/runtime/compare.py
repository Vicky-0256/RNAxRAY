"""Differential comparison of two conditions (bridge operation ``compare_run``).

Request::

    {"operation": "compare_run", "project_path": ..., "task_id": ..., "run_dir": ...,
     "samples_one": [sample ids], "samples_two": [sample ids],
     "parameters": {"min_count": 2, "range": 100, "padj_cutoff": 0.05, "similarity_min": 1,
                    "label_one": "...", "label_two": "...", "gene_id": null}}

Each sample contributes its contact.txt (10-nt cells of its own target gene,
as in ``rnaxray_compare``; ``gene_id`` forces one gene for every sample).  A
sample whose contact.txt is missing, or was made for another gene, gets one
made from its .hyb under the comparison directory.  The statistics are
:mod:`rnaxrayanalysis.differential` (DESeq2 Wald test, condition one vs two).

Results go to ``<project>/comparisons/<task_id>/`` (results.tsv,
significant.tsv, interactions.tsv, similarity.tsv, summary.json, contacts/);
similarity.tsv is RNAxRay's similarity heatmap (bin/plot_similarity_map) of
the two conditions' merged maps, cells below ``similarity_min`` dropped; the task's
``run_dir`` gets ``progress.json`` and ``result.json``.  ``register_task_run``
copies the ``comparison`` entry of the result into ``comparisons[]``.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .project import _atomic_write_json, load_manifest, safe_relative_path, validate_project_directory
from .structure import ProgressWriter, _env_int, _input_file, _now, _real_child_dir, _resolve_run_dir, _safe_task_id

MAX_SAMPLES = 64
PATH_KEYS = ("results", "significant", "interactions", "similarity", "summary")
_FILES = {"results": "results.tsv", "significant": "significant.tsv", "interactions": "interactions.tsv",
          "similarity": "similarity.tsv", "summary": "summary.json"}


def _pipeline_path(repo_root: Optional[Path]) -> None:
    root = Path(repo_root or Path(__file__).resolve().parents[2]).resolve()
    pipeline = str(root / "pipeline")
    if pipeline not in sys.path:
        sys.path.insert(0, pipeline)


def _parameters(raw: Any) -> Dict[str, Any]:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError("parameters must be an object")
    known = {"min_count", "range", "padj_cutoff", "similarity_min", "label_one", "label_two", "gene_id"}
    unknown = sorted(set(raw) - known)
    if unknown:
        raise ValueError("unknown compare parameters: " + ", ".join(unknown))
    params: Dict[str, Any] = {"min_count": 2, "range": 100, "padj_cutoff": 0.05, "similarity_min": 1}
    for key, (low, high) in {"min_count": (0, 1_000_000), "range": (0, 100_000),
                             "similarity_min": (1, 1_000_000)}.items():
        if key in raw:
            value = raw[key]
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f"{key} must be an integer between {low} and {high}")
            params[key] = value
    if "padj_cutoff" in raw:
        value = raw["padj_cutoff"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 1:
            raise ValueError("padj_cutoff must be a number in (0, 1]")
        params["padj_cutoff"] = float(value)
    for key in ("label_one", "label_two", "gene_id"):
        value = raw.get(key)
        if value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 256):
            raise ValueError(f"{key} must be a non-empty string of at most 256 characters")
        params[key] = value.strip() if isinstance(value, str) else None
    return params


def _sample_list(value: Any, label: str) -> List[str]:
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        raise ValueError(f"{label} must be a non-empty list of sample ids")
    if len(set(value)) != len(value):
        raise ValueError(f"{label} lists a sample twice")
    return list(value)


def _contact_inputs(project: Path, out_dir: Path, sample_ids: List[str], gene_override: Optional[str],
                    progress: ProgressWriter) -> List[Dict[str, Any]]:
    from rnaxrayanalysis import coverage

    manifest = load_manifest(project)
    samples = {sample.get("id"): sample for sample in manifest.get("samples") or [] if isinstance(sample, dict)}
    inputs = []
    for sample_id in sample_ids:
        sample = samples.get(sample_id)
        if sample is None:
            raise ValueError(f"unknown sample: {sample_id}")
        gene = gene_override or sample.get("gene_id")
        if not gene:
            raise ValueError(f"sample {sample_id} has no target gene (gene_id); set it on the Data page")
        outputs = sample.get("outputs") or {}
        contact: Optional[Path] = None
        if outputs.get("contact") and gene == sample.get("gene_id"):
            try:
                contact = _input_file(project, outputs["contact"], f"sample {sample_id} contact map")
            except ValueError:
                contact = None
        made = False
        if contact is None:
            hyb = outputs.get("hyb")
            reads = sample.get("reads") or {}
            if not hyb and reads.get("format") == "hyb":
                hyb = reads.get("path")
            if not hyb:
                raise ValueError(f"sample {sample_id} has no .hyb output yet; run it first")
            hyb_path = _input_file(project, hyb, f"sample {sample_id} .hyb")
            contacts_dir = _real_child_dir(out_dir, "contacts", exist_ok=True)
            safe_gene = "".join(c if c.isalnum() or c in "._-" else "_" for c in gene)
            contact = contacts_dir / f"{sample_id}.{safe_gene}.contact.txt"
            progress("contacts", f"contact map of {sample_id} ({gene})", None, None, units="none", force=True)
            coverage.write_contact(hyb_path, gene, contact)
            made = True
        inputs.append({"id": sample_id, "gene_id": gene, "contact": contact, "generated": made,
                       "condition": sample.get("condition")})
    return inputs


def _compare_run(request: Dict[str, Any], repo_root: Optional[Path], state: Dict[str, Any]) -> Dict[str, Any]:
    started = time.monotonic()
    raw_path = request.get("project_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("project path must be a non-empty string")
    project = Path(raw_path).expanduser().resolve()
    errors = validate_project_directory(project)
    if errors:
        raise ValueError("invalid project: " + "; ".join(errors))
    task_id = _safe_task_id(request.get("task_id") or ("compare-" + os.urandom(8).hex()))
    one = _sample_list(request.get("samples_one"), "samples_one")
    two = _sample_list(request.get("samples_two"), "samples_two")
    if set(one) & set(two):
        raise ValueError("a sample cannot be in both conditions")
    if len(one) + len(two) < 3:
        raise ValueError("a comparison needs at least three samples (two replicates in one condition)")
    if len(one) + len(two) > MAX_SAMPLES:
        raise ValueError(f"at most {MAX_SAMPLES} samples per comparison")
    params = _parameters(request.get("parameters"))

    run_dir = _resolve_run_dir(project, task_id, request.get("run_dir"))
    state.update(run_dir=run_dir, task_id=task_id)
    out_dir = _real_child_dir(project / "comparisons", task_id, exist_ok=True)
    progress = ProgressWriter(run_dir)
    _pipeline_path(repo_root)
    cpus = _env_int("RNAXRAY_TASK_CPUS")
    if cpus:
        try:
            import numba

            numba.set_num_threads(max(1, min(cpus, numba.config.NUMBA_NUM_THREADS)))
        except ImportError:
            pass
    from rnaxrayanalysis import differential

    progress("contacts", "collecting contact maps", None, None, units="none", force=True)
    inputs = _contact_inputs(project, out_dir, one + two, params["gene_id"], progress)

    def say(stage: str, detail: str) -> None:
        progress(stage, detail, None, None, units="none", force=True)

    summary = differential.compare(
        [item["contact"] for item in inputs], [item["id"] for item in inputs],
        [item["id"] in one for item in inputs], out_dir,
        min_count=params["min_count"], radius=params["range"], padj_cutoff=params["padj_cutoff"],
        similarity_min=params["similarity_min"], progress=say)
    created = _now()
    relative_dir = f"comparisons/{task_id}"
    label_one = params["label_one"] or ", ".join(one)
    label_two = params["label_two"] or ", ".join(two)
    meta_extra = {"task_id": task_id, "label_one": label_one, "label_two": label_two,
                  "inputs": [{"id": item["id"], "gene_id": item["gene_id"], "contact": str(item["contact"]),
                              "generated": item["generated"]} for item in inputs],
                  "created_at": created}
    summary.update(meta_extra)
    _atomic_write_json(out_dir / "summary.json", summary)
    genes = sorted({item["gene_id"] for item in inputs})
    compact = {key: summary[key] for key in ("cells_tested", "significant", "significant_up", "significant_down",
                                             "interactions", "interactions_up", "interactions_down", "max_coordinate",
                                             "similarity_cells", "similarity_cap")}
    compact["timings"] = summary["timings"]
    comparison = {
        "id": task_id, "task_id": task_id, "samples_one": one, "samples_two": two,
        "label_one": label_one, "label_two": label_two, "genes": genes,
        "parameters": {key: params[key] for key in ("min_count", "range", "padj_cutoff", "similarity_min", "gene_id")},
        "created_at": created, "path": relative_dir,
        "paths": {key: f"{relative_dir}/{name}" for key, name in _FILES.items()},
        "summary": compact,
    }
    result = {"ok": True, "status": "succeeded", "task_id": task_id, "run_dir": str(run_dir),
              "output": str(out_dir / "significant.tsv"), "output_dir": str(out_dir),
              "comparison": comparison, "summary": compact,
              "seconds": round(time.monotonic() - started, 2)}
    progress("done", "finished", None, None, units="none", force=True)
    _atomic_write_json(run_dir / "result.json", result)
    return result


def compare_run(request: Dict[str, Any], repo_root: Optional[Path] = None) -> Dict[str, Any]:
    """Bridge entry point.  Invalid requests raise ``ValueError``; failures after
    the run directory exists are reported in ``result.json`` and returned."""
    state: Dict[str, Any] = {}
    try:
        return _compare_run(request, repo_root, state)
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
# registered results (list_comparisons / read_comparison)
# ---------------------------------------------------------------------------

def _comparison_file(project: Path, entry: Dict[str, Any], key: str) -> Optional[Path]:
    relative = (entry.get("paths") or {}).get(key) if isinstance(entry.get("paths"), dict) else None
    if not safe_relative_path(relative):
        return None
    target = (project / relative).resolve()
    base = (project / "comparisons").resolve()
    if base not in target.parents or not target.is_file():
        return None
    return target


def list_comparisons(project: Path) -> List[Dict[str, Any]]:
    """``comparisons[]`` newest first, each with ``available`` (its files still exist)."""
    project = Path(project).expanduser().resolve()
    manifest = load_manifest(project)
    out = []
    for entry in manifest.get("comparisons") or []:
        if isinstance(entry, dict):
            out.append({**entry, "available": _comparison_file(project, entry, "significant") is not None})
    out.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return out


def read_comparison(project: Path, comparison_id: str, *, limit: Optional[int] = 250_000) -> Dict[str, Any]:
    """``{comparison, summary, cells: {x, y, log2FoldChange, padj, baseMean}, cells_total,
    truncated, interactions: [...], similarity: {x, y, count} | null}``; cells are the
    significant 10-nt cells by padj; similarity is null for comparisons made
    before it existed."""
    _pipeline_path(None)
    from rnaxrayanalysis import differential

    project = Path(project).expanduser().resolve()
    manifest = load_manifest(project)
    entry = next((item for item in manifest.get("comparisons") or []
                  if isinstance(item, dict) and item.get("id") == comparison_id), None)
    if entry is None:
        raise ValueError("comparison does not exist: %s" % comparison_id)
    significant = _comparison_file(project, entry, "significant")
    interactions = _comparison_file(project, entry, "interactions")
    if significant is None or interactions is None:
        raise ValueError("comparison files are missing: %s" % comparison_id)
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 1):
        raise ValueError("limit must be a positive integer")
    summary: Dict[str, Any] = {}
    summary_path = _comparison_file(project, entry, "summary")
    if summary_path is not None:
        try:
            loaded = json.loads(summary_path.read_text(encoding="utf-8"))
            summary = loaded if isinstance(loaded, dict) else {}
        except ValueError:
            summary = {}
    cells = differential.read_significant(significant, limit=limit)
    total = int(summary.get("significant", len(cells["x"])))
    similarity_path = _comparison_file(project, entry, "similarity")
    similarity = differential.read_similarity(similarity_path, limit=limit) if similarity_path is not None else None
    return {"comparison": entry, "summary": summary, "cells": cells, "cells_total": total,
            "truncated": len(cells["x"]) < total, "interactions": differential.read_interactions(interactions),
            "similarity": similarity}

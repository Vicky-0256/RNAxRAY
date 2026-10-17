"""Port of ``bin/rnaxray_compare`` (statistics and interaction split, no plots).

``rnaxray_compare -i table -o OUT -m MIN -r RANGE`` turns each sample's
contact.txt (10-nt cells, see :mod:`coverage`) into one count table keyed by
``x_y``, runs ``DESeq_run.R`` (rows with ``rowSums > MIN``,
condition_one vs condition_two, ``alpha=0.01``), keeps ``padj < 0.05`` and
then ``DESeq_interaction_split_select.py`` merges significant cells into
interactions: walking the cells by increasing padj, a cell is kept unless it
lies within ``RANGE`` nt (in both x and y) of a cell already kept with the
same direction.

Differences from the legacy script, all intentional:

- statistics come from :mod:`deseq` (numpy port of DESeq2 1.46; padj rank
  correlation with R is 1.0 on the ZIKV comparisons);
- the legacy split prepends a dummy cell (0, 0) to both lists, which hides
  real interactions within RANGE of the origin; it is not reproduced;
- cells are compared as integers, and ties in padj keep table order.

Outputs (``compare`` writes them into one directory)::

    results.tsv        all tested cells, by padj (NA last): x y <counts...>
                       baseMean log2FoldChange lfcSE stat pvalue padj
    significant.tsv    the padj < cutoff rows of results.tsv
    interactions.tsv   merged interactions: direction x y log2FoldChange padj
                       baseMean (direction "up" = higher in condition one)
    summary.json       counts, size factors, dispersion trend, timings
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np

from . import deseq

PathLike = Union[str, "os.PathLike[str]"]
Progress = Optional[Callable[[str, str], None]]

DEFAULTS = {"min_count": 2, "range": 100, "alpha": 0.01, "padj_cutoff": 0.05}
_SHIFT = np.int64(1) << np.int64(32)


def read_contact(path: PathLike) -> Tuple[np.ndarray, np.ndarray]:
    """``(keys, counts)`` of a contact.txt; header and comment lines are skipped.

    ``keys`` packs ``x << 32 | y`` (cells are non-negative 10-nt bin starts).
    """
    raw = Path(path).read_bytes()
    lines = raw.split(b"\n")
    body = [line for line in lines if line and not line.startswith(b"#") and line[:1].isdigit()]
    if not body:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64)
    values = np.array(b"\t".join(body).replace(b"\t", b" ").split(), dtype=np.int64)
    if len(values) % 3:
        raise ValueError(f"{path}: expected x, y, count on every line")
    values = values.reshape(-1, 3)
    if (values[:, :2] < 0).any() or (values[:, :2] >= _SHIFT).any():
        raise ValueError(f"{path}: cell coordinates out of range")
    return values[:, 0] * _SHIFT + values[:, 1], values[:, 2]


def count_table(contacts: Sequence[PathLike]) -> Tuple[np.ndarray, np.ndarray]:
    """``(keys, counts[cells, samples])`` over the union of cells (missing = 0)."""
    parts = [read_contact(path) for path in contacts]
    keys = np.unique(np.concatenate([part[0] for part in parts])) if parts else np.zeros(0, dtype=np.int64)
    table = np.zeros((len(keys), len(parts)), dtype=np.int64)
    for column, (part_keys, part_counts) in enumerate(parts):
        index = np.searchsorted(keys, part_keys)
        np.add.at(table[:, column], index, part_counts)
    return keys, table


def split_interactions(x: np.ndarray, y: np.ndarray, lfc: np.ndarray, padj: np.ndarray, radius: int) -> List[int]:
    """Indices of the cells kept by the greedy interaction split, by padj.

    Cells are visited by increasing padj; one is kept unless an already kept
    cell of the same direction lies within ``radius`` in both x and y.
    """
    order = np.argsort(padj, kind="stable")
    kept: List[int] = []
    width = radius + 1  # kept cells bucketed on this grid: only 3 x 3 buckets to search
    for direction in (1, -1):
        grid: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
        for index in order:
            if np.sign(lfc[index]) != direction:
                continue
            xi, yi = int(x[index]), int(y[index])
            bx, by = xi // width, yi // width
            if any(abs(cx - xi) <= radius and abs(cy - yi) <= radius
                   for gx in (bx - 1, bx, bx + 1) for gy in (by - 1, by, by + 1)
                   for cx, cy in grid.get((gx, gy), ())):
                continue
            grid.setdefault((bx, by), []).append((xi, yi))
            kept.append(int(index))
    return kept


def _fmt(value: float) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "NA"
    return repr(float(value))


def _atomic_text(path: Path, write: Callable[[Any], None]) -> None:
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            write(handle)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def compare(contacts: Sequence[PathLike], names: Sequence[str], condition_one: Sequence[bool], out_dir: PathLike,
            *, min_count: int = 2, radius: int = 100, alpha: float = 0.01, padj_cutoff: float = 0.05,
            similarity_min: int = 1, progress: Progress = None) -> Dict[str, Any]:
    """Run the comparison and write the five outputs into ``out_dir``."""
    started = time.monotonic()
    say = progress or (lambda stage, detail: None)
    if len(contacts) != len(names) or len(names) != len(condition_one):
        raise ValueError("contacts, names and condition_one must have the same length")
    one = np.asarray(condition_one, dtype=bool)
    if one.sum() < 1 or (~one).sum() < 1 or len(one) < 3:
        raise ValueError("a comparison needs both conditions and at least three samples")
    if isinstance(min_count, bool) or not isinstance(min_count, int) or min_count < 0:
        raise ValueError("min_count must be a non-negative integer")
    if isinstance(radius, bool) or not isinstance(radius, int) or radius < 0:
        raise ValueError("range must be a non-negative integer")
    if isinstance(similarity_min, bool) or not isinstance(similarity_min, int) or similarity_min < 1:
        raise ValueError("similarity_min must be a positive integer")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    say("table", "reading %d contact maps" % len(contacts))
    t0 = time.monotonic()
    keys, table = count_table(contacts)
    total_cells = len(keys)
    sim = similarity(keys, table, one, similarity_min)
    keep = table.sum(axis=1) > min_count
    keys, table = keys[keep], table[keep]
    if len(keys) < 2:
        raise ValueError("fewer than two cells pass the minimum count; nothing to test")
    table_seconds = time.monotonic() - t0

    say("deseq", "DESeq2 Wald test on %d cells" % len(keys))
    t0 = time.monotonic()
    res = deseq.deseq_two_conditions(table, one, alpha=alpha)
    test_seconds = time.monotonic() - t0

    say("write", "writing results")
    x = (keys // _SHIFT).astype(np.int64)
    y = (keys % _SHIFT).astype(np.int64)
    padj = res["padj"]
    sort_key = np.where(np.isnan(padj), np.inf, padj)
    order = np.argsort(sort_key, kind="stable")
    columns = ["baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj"]
    header = "\t".join(["x", "y"] + list(names) + columns) + "\n"
    significant = order[sort_key[order] < padj_cutoff]

    def rows(indices):
        for i in indices:
            yield "\t".join([str(int(x[i])), str(int(y[i]))] + [str(int(v)) for v in table[i]]
                            + [_fmt(res[c][i]) for c in columns]) + "\n"

    def write_all(handle):
        handle.write(header)
        handle.writelines(rows(order))

    def write_significant(handle):
        handle.write(header)
        handle.writelines(rows(significant))

    _atomic_text(out / "results.tsv", write_all)
    _atomic_text(out / "significant.tsv", write_significant)

    kept = split_interactions(x[significant], y[significant], res["log2FoldChange"][significant],
                              padj[significant], radius)
    interactions = [int(significant[k]) for k in kept]

    def write_interactions(handle):
        handle.write("direction\tx\ty\tlog2FoldChange\tpadj\tbaseMean\n")
        for i in interactions:
            direction = "up" if res["log2FoldChange"][i] > 0 else "down"
            handle.write("\t".join([direction, str(int(x[i])), str(int(y[i])), _fmt(res["log2FoldChange"][i]),
                                    _fmt(padj[i]), _fmt(res["baseMean"][i])]) + "\n")

    _atomic_text(out / "interactions.tsv", write_interactions)

    def write_similarity(handle):
        handle.write("x\ty\tcount\tcount_one\tcount_two\n")
        for row in zip(sim["x"], sim["y"], sim["count"], sim["count_one"], sim["count_two"]):
            handle.write("\t".join(str(int(v)) for v in row) + "\n")

    _atomic_text(out / "similarity.tsv", write_similarity)
    lfc_sig = res["log2FoldChange"][significant]
    up = sum(1 for i in interactions if res["log2FoldChange"][i] > 0)
    summary = {
        "version": 1,
        "samples": [{"name": name, "condition": "one" if flag else "two"} for name, flag in zip(names, one)],
        "parameters": {"min_count": min_count, "range": radius, "alpha": alpha, "padj_cutoff": padj_cutoff,
                       "similarity_min": similarity_min},
        "cells_total": int(total_cells),
        "cells_tested": int(len(keys)),
        "cells_with_padj": int(np.sum(~np.isnan(padj))),
        "significant": int(len(significant)),
        "significant_up": int(np.sum(lfc_sig > 0)),
        "significant_down": int(np.sum(lfc_sig < 0)),
        "interactions": len(interactions),
        "interactions_up": up,
        "interactions_down": len(interactions) - up,
        "similarity_cells": int(len(sim["x"])),
        "similarity_cap": sim["cap"],
        "size_factors": [float(v) for v in res["sizeFactors"]],
        "dispersion_trend": ({"type": "parametric", "asymptDisp": float(res["trend"][0]), "extraPois": float(res["trend"][1])}
                             if res["fitType"] == "parametric" else {"type": "local"}),
        "disp_prior_var": float(res["dispPriorVar"]),
        "filter_threshold": float(res["filterThreshold"]),
        "max_coordinate": int(max(x.max(), y.max())) if len(x) else 0,
        "engine": "rnaxrayanalysis.deseq (numpy port of DESeq2 1.46 Wald test)",
        "timings": {"table_s": round(table_seconds, 2), "test_s": round(test_seconds, 2),
                    "total_s": round(time.monotonic() - started, 2)},
    }
    _atomic_text(out / "summary.json", lambda handle: json.dump(summary, handle, indent=2))
    return summary


def similarity(keys: np.ndarray, table: np.ndarray, condition_one: np.ndarray, minimum: int = 1) -> Dict[str, Any]:
    """RNAxRay's similarity heatmap (bin/plot_similarity_map + similarity_heatmap.R).

    The original runs on two contact maps; given one merged map per condition
    (the condition's .hyb files concatenated, i.e. its samples' counts summed)
    it keeps every cell present in both and reports the smaller count.  Cells
    below ``minimum`` are dropped from each map first (1 keeps all).  ``cap``
    is the 95% quantile of the counts (R's default quantile), the top of
    similarity_heatmap.R's colour scale.
    """
    one = np.asarray(condition_one, dtype=bool)
    count_one = table[:, one].sum(axis=1)
    count_two = table[:, ~one].sum(axis=1)
    keep = (count_one >= max(1, minimum)) & (count_two >= max(1, minimum))
    count = np.minimum(count_one, count_two)[keep]
    k = keys[keep]
    return {"x": (k // _SHIFT).astype(np.int64), "y": (k % _SHIFT).astype(np.int64), "count": count,
            "count_one": count_one[keep], "count_two": count_two[keep],
            "cap": float(np.quantile(count, 0.95)) if len(count) else 0.0}


def read_similarity(path: PathLike, *, limit: Optional[int] = None) -> Dict[str, List[int]]:
    """Columns x, y, count of similarity.tsv, strongest cells first when limited."""
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        handle.readline()
        for line in handle:
            parts = line.split("\t")
            rows.append((int(parts[0]), int(parts[1]), int(parts[2])))
    if limit is not None and len(rows) > limit:
        rows.sort(key=lambda row: -row[2])
        rows = rows[:limit]
    return {"x": [r[0] for r in rows], "y": [r[1] for r in rows], "count": [r[2] for r in rows]}


def read_significant(path: PathLike, *, limit: Optional[int] = None) -> Dict[str, List[Any]]:
    """Columns x, y, log2FoldChange, padj, baseMean of significant.tsv (padj order)."""
    out: Dict[str, List[Any]] = {"x": [], "y": [], "log2FoldChange": [], "padj": [], "baseMean": []}
    with open(path, "r", encoding="utf-8") as handle:
        header = handle.readline().rstrip("\n").split("\t")
        col = {name: index for index, name in enumerate(header)}
        for n, line in enumerate(handle):
            if limit is not None and n >= limit:
                break
            parts = line.rstrip("\n").split("\t")
            out["x"].append(int(parts[0]))
            out["y"].append(int(parts[1]))
            for name in ("log2FoldChange", "padj", "baseMean"):
                value = parts[col[name]]
                out[name].append(None if value == "NA" else float(value))
    return out


def read_interactions(path: PathLike) -> List[Dict[str, Any]]:
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        handle.readline()
        for line in handle:
            direction, x, y, lfc, padj, base = line.rstrip("\n").split("\t")
            rows.append({"direction": direction, "x": int(x), "y": int(y),
                         "log2FoldChange": None if lfc == "NA" else float(lfc),
                         "padj": None if padj == "NA" else float(padj),
                         "baseMean": None if base == "NA" else float(base)})
    return rows

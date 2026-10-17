"""Queries over one or more analysis indexes (replicates are merged by summing).

Every function takes ``indexes``: a list of index paths.  Gene and type names
are resolved per index, so indexes built from different files merge by name.

``compare_bins`` puts two such merged groups (conditions) on one bin grid.

Contact maps use the legacy ``plot_hybrids_3.awk USE_ENTIRE_HYBRIDS=1``
rule at the requested bin size: a hybrid adds one to every
``bin(arm 1) x bin(arm 2)`` cell its two arms cover, where
``bin(p) = bin_size * floor(p / bin_size)``.  At ``bin_size=10`` the cells
equal ``contact.txt`` exactly.
"""
from __future__ import annotations

import heapq
import json
import os
import sqlite3
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

import numpy as np

from .index import FORMAT, RECT_COLUMNS, VERSION

PathLike = Union[str, "os.PathLike[str]"]

MAX_GRID_CELLS = 25_000_000
MAX_LIMIT = 10_000
_RECT_CACHE_BYTES = 512 * 1024 * 1024


class IndexError_(ValueError):
    """A missing, stale or foreign index."""


class _Index:
    def __init__(self, path: Path):
        self.path = path
        stat = path.stat()
        self.stamp = (stat.st_size, stat.st_mtime_ns)
        # as_uri escapes "#", "%" and "?" in folder names; the index opens read-only.
        self.con = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True, check_same_thread=False)
        try:
            self.meta = {k: json.loads(v) for k, v in self.con.execute("SELECT key, value FROM meta")}
        except sqlite3.DatabaseError as error:
            self.con.close()
            raise IndexError_("not an analysis index: %s (%s)" % (path, error))
        if self.meta.get("format") != FORMAT or self.meta.get("version") != VERSION:
            self.con.close()
            raise IndexError_("unsupported analysis index: %s" % path)
        self.genes = {name: (gid, max_end) for gid, name, max_end in self.con.execute("SELECT id, name, max_end FROM genes")}
        self.gene_names = {gid: name for name, (gid, _) in self.genes.items()}
        self.types = {name: tid for tid, name in self.con.execute("SELECT id, name FROM types")}
        self.type_names = {tid: name for name, tid in self.types.items()}
        self.spans = {(g1, g2): (s1, s2) for g1, g2, s1, s2 in self.con.execute("SELECT g1, g2, max_span1, max_span2 FROM pairs")}

        self._extents: Optional[Dict[str, Tuple[int, int]]] = None

    def gene(self, name: str) -> Optional[int]:
        entry = self.genes.get(name)
        return entry[0] if entry else None

    def extents(self) -> Dict[str, Tuple[int, int]]:
        """``{gene: (smallest arm start, largest arm end)}`` over both arms."""
        if self._extents is None:
            try:
                rows = self.con.execute("SELECT name, min_start, max_end FROM genes").fetchall()
                extents = {name: (lo, hi) for name, lo, hi in rows if lo is not None}
            except sqlite3.OperationalError:  # index built before genes.min_start existed
                lows: Dict[int, int] = {}
                for (g1, g2) in self.spans:
                    row = self.con.execute("SELECT min(s1) FROM hybrids WHERE g1 = ? AND g2 = ?", (g1, g2)).fetchone()
                    if row[0] is not None:
                        lows[g1] = min(lows.get(g1, row[0]), row[0])
                    row = self.con.execute("SELECT min(s2) FROM hybrids WHERE g1 = ? AND g2 = ?", (g1, g2)).fetchone()
                    if row[0] is not None:
                        lows[g2] = min(lows.get(g2, row[0]), row[0])
                extents = {name: (lows[gid], max_end) for name, (gid, max_end) in self.genes.items() if gid in lows}
            self._extents = extents
        return self._extents


_lock = threading.Lock()
_open: Dict[str, _Index] = {}
_rects: "OrderedDict[Tuple[str, Tuple[int, int], int, int], Dict[str, np.ndarray]]" = OrderedDict()
_rect_bytes = 0


def _get(path: PathLike) -> _Index:
    key = os.path.abspath(os.fspath(path))
    p = Path(key)
    if not p.is_file():
        raise IndexError_("analysis index not found: %s" % key)
    stat = p.stat()
    with _lock:
        index = _open.get(key)
        if index is not None and index.stamp == (stat.st_size, stat.st_mtime_ns):
            return index
        if index is not None:
            index.con.close()
        index = _open[key] = _Index(p)
        return index


def _indexes(indexes: Sequence[PathLike]) -> List[_Index]:
    if isinstance(indexes, (str, os.PathLike)):
        indexes = [indexes]
    if not indexes:
        raise ValueError("at least one analysis index is required")
    return [_get(path) for path in indexes]


def close_all() -> None:
    global _rect_bytes
    with _lock:
        for index in _open.values():
            index.con.close()
        _open.clear()
        _rects.clear()
        _rect_bytes = 0


# --------------------------------------------------------------------------
# summary


def _single_summary(index: _Index) -> Dict[str, Any]:
    con = index.con
    extents = index.extents()
    genes = [{"name": n, "length": m, "max_end": m, "min_start": extents.get(n, (None, m))[0], "records": r, "reads": rd}
             for n, m, r, rd in con.execute("SELECT name, max_end, records, reads FROM genes ORDER BY records DESC, name")]
    types = [{"name": n, "records": r, "reads": rd}
             for n, r, rd in con.execute("SELECT name, records, reads FROM types ORDER BY records DESC, name")]
    pairs = [{"gene1": index.gene_names[g1], "gene2": index.gene_names[g2], "records": r, "reads": rd}
             for g1, g2, r, rd in con.execute("SELECT g1, g2, records, reads FROM pairs ORDER BY records DESC")]
    meta = index.meta
    return {
        "index": str(index.path), "source": meta.get("source_path"), "built_at": meta.get("built_at"),
        "records": meta["records"], "reads": meta["reads"], "records_with_reads": meta["records_with_reads"],
        "with_dg": meta["with_dg"], "intra_records": meta["intra_records"], "inter_records": meta["inter_records"],
        "invalid": meta["invalid"], "skipped": meta["skipped"], "errors": meta.get("errors", []),
        "genes": genes, "types": types, "pairs": pairs,
    }


def _merge_named(lists: Iterable[List[Dict[str, Any]]], keys: Sequence[str], sums: Sequence[str],
                 maxes: Sequence[str] = (), mins: Sequence[str] = ()) -> List[Dict[str, Any]]:
    merged: Dict[tuple, Dict[str, Any]] = {}
    for items in lists:
        for item in items:
            key = tuple(item[k] for k in keys)
            entry = merged.get(key)
            if entry is None:
                merged[key] = dict(item)
                continue
            for name in sums:
                entry[name] += item[name]
            for name in maxes:
                entry[name] = max(entry[name], item[name])
            for name in mins:
                if item[name] is not None:
                    entry[name] = item[name] if entry[name] is None else min(entry[name], item[name])
    return sorted(merged.values(), key=lambda item: (-item["records"],) + tuple(item[k] for k in keys))


def _check_lengths(lengths: Optional[Dict[str, int]]) -> Dict[str, int]:
    if lengths is None:
        return {}
    if not isinstance(lengths, dict) or any(not isinstance(k, str) or isinstance(v, bool) or not isinstance(v, int) or v < 0
                                            for k, v in lengths.items()):
        raise ValueError("lengths must map gene names to non-negative integers")
    return lengths


def _apply_lengths(genes: List[Dict[str, Any]], lengths: Dict[str, int]) -> Dict[str, Dict[str, Any]]:
    """Set ``length`` from the reference when known; return ``{gene: {min, max}}`` extents."""
    extents = {}
    for gene in genes:
        known = lengths.get(gene["name"])
        gene["length"] = known if known is not None else gene["max_end"]
        gene["length_source"] = "reference" if known is not None else "observed"
        extents[gene["name"]] = {"min": gene["min_start"], "max": gene["max_end"]}
    return extents


def summary(indexes: Sequence[PathLike], lengths: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """Per-index summaries plus a merged total (``merged``).

    ``genes[]`` rows are ``{name, length, length_source, max_end, min_start,
    records, reads}``: ``length`` is the reference length from ``lengths``
    (gene name -> nt) when known, otherwise the largest arm end seen
    (``length_source`` says which).  Each part and ``merged`` also carry
    ``extents: {gene: {min, max}}``, the observed arm coordinate range.
    """
    lengths = _check_lengths(lengths)
    parts = [_single_summary(index) for index in _indexes(indexes)]
    merged = {name: sum(part[name] for part in parts)
              for name in ("records", "reads", "records_with_reads", "with_dg", "intra_records", "inter_records", "invalid", "skipped")}
    merged["genes"] = _merge_named((p["genes"] for p in parts), ("name",), ("records", "reads"), ("length", "max_end"), ("min_start",))
    merged["types"] = _merge_named((p["types"] for p in parts), ("name",), ("records", "reads"))
    merged["pairs"] = _merge_named((p["pairs"] for p in parts), ("gene1", "gene2"), ("records", "reads"))
    for part in parts:
        part["extents"] = _apply_lengths(part["genes"], lengths)
    merged["extents"] = _apply_lengths(merged["genes"], lengths)
    return {"indexes": parts, "merged": merged}


# --------------------------------------------------------------------------
# contact bins


def _load_rects(index: _Index, g1: int, g2: int) -> Optional[Dict[str, np.ndarray]]:
    global _rect_bytes
    key = (str(index.path), (g1, g2)) + index.stamp
    with _lock:
        cached = _rects.get(key)
        if cached is not None:
            _rects.move_to_end(key)
            return cached
    row = index.con.execute("SELECT n, dtypes, %s FROM rects WHERE g1 = ? AND g2 = ?" % ", ".join(RECT_COLUMNS), (g1, g2)).fetchone()
    if row is None:
        return None
    dtypes = json.loads(row[1])
    arrays = {name: np.frombuffer(blob, dtype=dtypes[name]) for name, blob in zip(RECT_COLUMNS, row[2:])}
    size = sum(array.nbytes for array in arrays.values())
    with _lock:
        _rects[key] = arrays
        _rect_bytes += size
        while _rect_bytes > _RECT_CACHE_BYTES and len(_rects) > 1:
            _, old = _rects.popitem(last=False)
            _rect_bytes -= sum(array.nbytes for array in old.values())
    return arrays


def _region(region: Any) -> Optional[Tuple[int, int, int, int]]:
    """``{"x": [start, end], "y": [start, end]}`` (nt, inclusive); either may be omitted."""
    if region is None:
        return None
    if not isinstance(region, dict):
        raise ValueError("region must be an object with x and/or y [start, end]")
    out = []
    for axis in ("x", "y"):
        span = region.get(axis)
        if span is None:
            out.extend((0, None))
            continue
        if (not isinstance(span, (list, tuple)) or len(span) != 2
                or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in span)):
            raise ValueError("region.%s must be [start, end]" % axis)
        start, end = int(span[0]), int(span[1])
        if start > end:
            raise ValueError("region.%s start must not exceed end" % axis)
        out.extend((max(0, start), end))
    return tuple(out)  # type: ignore[return-value]


def _type_mask(index: _Index, rects: Dict[str, np.ndarray], types: Optional[Sequence[str]]) -> Optional[np.ndarray]:
    if not types:
        return None
    wanted = [index.types[name] for name in types if name in index.types]
    return np.isin(rects["type"], np.asarray(wanted, dtype=rects["type"].dtype))


def _rasterise(parts: List[Tuple[np.ndarray, ...]], bin_size: int, bounds: Tuple[int, int, int, int]):
    """Sum rectangles into a dense grid (2-D difference array + cumulative sums)."""
    bx0, bx1, by0, by1 = bounds
    nx, ny = bx1 - bx0 + 1, by1 - by0 + 1
    if nx <= 0 or ny <= 0:
        return np.zeros((0, 0), dtype=np.int64)
    if nx * ny > MAX_GRID_CELLS:
        raise ValueError("contact map would need %d cells; increase bin_size or narrow the region" % (nx * ny))
    width = ny + 1
    corners, weights = [], []
    for s1, e1, s2, e2, weight in parts:
        a = np.clip(s1 // bin_size, bx0, None) - bx0
        b = np.clip(e1 // bin_size, None, bx1) - bx0 + 1
        e = np.clip(s2 // bin_size, by0, None) - by0
        f = np.clip(e2 // bin_size, None, by1) - by0 + 1
        w = weight.astype(np.float64)
        corners += [a * width + e, a * width + f, b * width + e, b * width + f]
        weights += [w, -w, -w, w]
    diff = np.bincount(np.concatenate(corners), weights=np.concatenate(weights), minlength=(nx + 1) * width)
    del corners, weights
    grid = np.rint(diff).astype(np.int64).reshape(nx + 1, width)
    del diff
    np.cumsum(grid, axis=0, out=grid)
    np.cumsum(grid, axis=1, out=grid)
    return grid[:nx, :ny]


ORIENTATIONS = ("oriented", "both")


def _pair_rects(index: _Index, g1: Optional[int], g2: Optional[int], swapped: bool) -> Optional[Dict[str, np.ndarray]]:
    """Rectangles of the oriented pair ``(g1, g2)``; ``swapped`` loads ``(g2, g1)`` with the arms exchanged."""
    if g1 is None or g2 is None:
        return None
    rects = _load_rects(index, g2, g1) if swapped else _load_rects(index, g1, g2)
    if rects is None or not swapped:
        return rects
    out = dict(rects)
    out["s1"], out["e1"], out["s2"], out["e2"] = rects["s2"], rects["e2"], rects["s1"], rects["e1"]
    return out


def _contact_grid(indexes: List[_Index], gene: str, gene2: Optional[str], bin_size: int, region,
                  types: Optional[Sequence[str]], measure: str, orientation: str = "oriented"):
    """Per-index rectangle selections and the merged grid.

    ``orientation="both"`` adds the hybrids whose arm 1 is on ``gene2`` and
    arm 2 on ``gene`` with the arms swapped (the browser's "normalised"
    pairs).  For an intramolecular map (``gene2 == gene``) both settings keep
    the legacy rule: x = arm 1, y = arm 2, no mirroring.
    """
    if isinstance(bin_size, bool) or not isinstance(bin_size, int) or not 1 <= bin_size <= 100_000:
        raise ValueError("bin_size must be an integer between 1 and 100000")
    if measure not in ("records", "reads"):
        raise ValueError("measure must be 'records' or 'reads'")
    if orientation not in ORIENTATIONS:
        raise ValueError("orientation must be 'oriented' or 'both'")
    gene2 = gene2 or gene
    bounds_nt = _region(region)
    selections = []
    length_x = length_y = 0
    for index in indexes:
        g1, g2 = index.gene(gene), index.gene(gene2)
        if g1 is not None:
            length_x = max(length_x, index.genes[gene][1])
        if g2 is not None:
            length_y = max(length_y, index.genes[gene2][1])
        found = [rects for rects in (_pair_rects(index, g1, g2, False),
                                     _pair_rects(index, g1, g2, True) if orientation == "both" and gene2 != gene else None)
                 if rects is not None]
        if not found:
            selections.append(None)
            continue
        s1, e1, s2, e2 = (np.concatenate([rects[k].astype(np.int64) for rects in found]) for k in ("s1", "e1", "s2", "e2"))
        weight = np.concatenate([rects["count" if measure == "records" else "reads"].astype(np.int64) for rects in found])
        masks = [_type_mask(index, rects, types) for rects in found]
        mask = None if masks[0] is None else np.concatenate(masks)
        if bounds_nt is not None:
            x0, x1, y0, y1 = bounds_nt
            # keep rectangles that reach the region's bins
            keep = np.ones(len(s1), dtype=bool)
            keep &= e1 // bin_size >= x0 // bin_size
            if x1 is not None:
                keep &= s1 // bin_size <= x1 // bin_size
            keep &= e2 // bin_size >= y0 // bin_size
            if y1 is not None:
                keep &= s2 // bin_size <= y1 // bin_size
            mask = keep if mask is None else (mask & keep)
        if mask is not None:
            s1, e1, s2, e2, weight = s1[mask], e1[mask], s2[mask], e2[mask], weight[mask]
        selections.append((s1, e1, s2, e2, weight))
    present = [sel for sel in selections if sel is not None and len(sel[0])]
    if bounds_nt is not None:
        x0, x1, y0, y1 = bounds_nt
        bx0, by0 = x0 // bin_size, y0 // bin_size
        bx1 = (x1 if x1 is not None else max([int(sel[1].max()) for sel in present] or [x0])) // bin_size
        by1 = (y1 if y1 is not None else max([int(sel[3].max()) for sel in present] or [y0])) // bin_size
    else:
        bx0 = by0 = 0
        bx1 = max([int(sel[1].max()) for sel in present] or [0]) // bin_size
        by1 = max([int(sel[3].max()) for sel in present] or [0]) // bin_size
    return selections, (bx0, bx1, by0, by1), (length_x, length_y)


def _cells(grid: np.ndarray, bounds, bin_size: int):
    ix, iy = np.nonzero(grid)
    return (ix + bounds[0]) * bin_size, (iy + bounds[2]) * bin_size, grid[ix, iy]


def _lengths_for(lengths: Dict[str, int], gene: str, gene2: Optional[str], observed: Tuple[int, int]) -> Tuple[int, int]:
    return (lengths.get(gene, observed[0]), lengths.get(gene2 or gene, observed[1]))


def contact_bins(indexes: Sequence[PathLike], gene: str, bin_size: int = 10, region: Any = None, *,
                 gene2: Optional[str] = None, types: Optional[Sequence[str]] = None, measure: str = "records",
                 max_cells: Optional[int] = None, orientation: str = "oriented", fixed_bin: bool = False,
                 lengths: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """Non-empty contact-map cells for ``gene`` (x = arm 1, y = arm 2).

    Returns ``{gene, gene2, bin_size, requested_bin_size, adjusted, measure,
    orientation, fixed_bin, length, length2, region, cells, total, max, x: [],
    y: [], count: []}`` where ``x``/``y`` are bin starts in nt (row-major
    order) and ``total`` is the summed weight of the hybrids drawn.  With
    ``max_cells`` the bin size is doubled until the map has at most that many
    non-empty cells, unless ``fixed_bin`` (then the requested bin is kept, so
    maps of several datasets line up; the dense-grid guard still applies).
    ``length``/``length2`` are reference lengths from ``lengths`` when known,
    otherwise the largest arm end seen.
    """
    if not isinstance(fixed_bin, bool):
        raise ValueError("fixed_bin must be a boolean")
    lengths = _check_lengths(lengths)
    opened = _indexes(indexes)
    requested = bin_size
    while True:
        selections, bounds, observed = _contact_grid(opened, gene, gene2, bin_size, region, types, measure, orientation)
        parts = [sel for sel in selections if sel is not None and len(sel[0])]
        grid = _rasterise(parts, bin_size, bounds) if parts else np.zeros((0, 0), dtype=np.int64)
        cells = int(np.count_nonzero(grid))
        if fixed_bin or max_cells is None or cells <= max_cells or bin_size >= 100_000:
            break
        bin_size *= 2
    x, y, count = _cells(grid, bounds, bin_size)
    length, length2 = _lengths_for(lengths, gene, gene2, observed)
    return {
        "gene": gene, "gene2": gene2 or gene, "bin_size": bin_size, "requested_bin_size": requested,
        "adjusted": bin_size != requested, "measure": measure, "orientation": orientation, "fixed_bin": fixed_bin,
        "length": length, "length2": length2,
        "region": region, "cells": cells, "total": int(sum(int(sel[4].sum()) for sel in parts)),
        "max": int(count.max()) if len(count) else 0,
        "x": x.tolist(), "y": y.tolist(), "count": count.tolist(),
    }


def _union_bounds(*bounds: Tuple[int, int, int, int]) -> Tuple[int, int, int, int]:
    return (min(b[0] for b in bounds), max(b[1] for b in bounds), min(b[2] for b in bounds), max(b[3] for b in bounds))


def _side_grid(selections, bin_size: int, bounds) -> np.ndarray:
    parts = [sel for sel in selections if sel is not None and len(sel[0])]
    if parts:
        return _rasterise(parts, bin_size, bounds)
    nx, ny = bounds[1] - bounds[0] + 1, bounds[3] - bounds[2] + 1
    if nx * ny > MAX_GRID_CELLS:
        raise ValueError("contact map would need %d cells; increase bin_size or narrow the region" % (nx * ny))
    return np.zeros((nx, ny), dtype=np.int64)


def compare_bins(indexes_a: Sequence[PathLike], indexes_b: Sequence[PathLike], gene: str, bin_size: int = 10,
                 region: Any = None, *, gene2: Optional[str] = None, types: Optional[Sequence[str]] = None,
                 measure: str = "records", orientation: str = "oriented", max_cells: Optional[int] = None,
                 fixed_bin: bool = False, lengths: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """Two conditions on one shared bin grid (descriptive, no statistics).

    Each side's indexes are merged by summing; counts are normalized to
    counts per million of that side's library (total records, or total reads
    for ``measure="reads"``).  Cells non-empty on either side are returned
    in row-major order::

        {gene, gene2, bin_size, requested_bin_size, adjusted, measure, orientation,
         length, length2, region, cells, library_a, library_b, pseudocount,
         x: [], y: [], a: [], b: [], a_count: [], b_count: [], log2ratio: []}

    ``a``/``b`` are the normalized values, ``a_count``/``b_count`` the raw
    ones and ``log2ratio = log2((b + p) / (a + p))`` with ``p`` the
    normalized value of one count in the smaller library.  ``max_cells``
    doubles the shared bin size (unless ``fixed_bin``) until the union has at
    most that many cells.
    """
    if not isinstance(fixed_bin, bool):
        raise ValueError("fixed_bin must be a boolean")
    lengths = _check_lengths(lengths)
    side_a, side_b = _indexes(indexes_a), _indexes(indexes_b)
    key = "records" if measure == "records" else "reads"
    library_a = sum(int(index.meta[key]) for index in side_a)
    library_b = sum(int(index.meta[key]) for index in side_b)
    requested = bin_size
    while True:
        sel_a, bounds_a, observed_a = _contact_grid(side_a, gene, gene2, bin_size, region, types, measure, orientation)
        sel_b, bounds_b, observed_b = _contact_grid(side_b, gene, gene2, bin_size, region, types, measure, orientation)
        bounds = _union_bounds(bounds_a, bounds_b)
        grid_a = _side_grid(sel_a, bin_size, bounds)
        grid_b = _side_grid(sel_b, bin_size, bounds)
        ix, iy = np.nonzero((grid_a != 0) | (grid_b != 0))
        if fixed_bin or max_cells is None or len(ix) <= max_cells or bin_size >= 100_000:
            break
        del grid_a, grid_b
        bin_size *= 2
    count_a, count_b = grid_a[ix, iy], grid_b[ix, iy]
    del grid_a, grid_b
    norm_a = count_a * (1e6 / library_a) if library_a else np.zeros(len(ix))
    norm_b = count_b * (1e6 / library_b) if library_b else np.zeros(len(ix))
    smallest = min([lib for lib in (library_a, library_b) if lib] or [1_000_000])
    pseudocount = 1e6 / smallest
    ratio = np.log2((norm_b + pseudocount) / (norm_a + pseudocount))
    observed = (max(observed_a[0], observed_b[0]), max(observed_a[1], observed_b[1]))
    length, length2 = _lengths_for(lengths, gene, gene2, observed)
    return {
        "gene": gene, "gene2": gene2 or gene, "bin_size": bin_size, "requested_bin_size": requested,
        "adjusted": bin_size != requested, "measure": measure, "orientation": orientation,
        "normalization": "per_million_" + key, "length": length, "length2": length2, "region": region,
        "cells": int(len(ix)), "library_a": library_a, "library_b": library_b, "pseudocount": pseudocount,
        "x": ((ix + bounds[0]) * bin_size).tolist(), "y": ((iy + bounds[2]) * bin_size).tolist(),
        "a": np.round(norm_a, 6).tolist(), "b": np.round(norm_b, 6).tolist(),
        "a_count": count_a.tolist(), "b_count": count_b.tolist(), "log2ratio": np.round(ratio, 6).tolist(),
    }


def top_interactions(indexes: Sequence[PathLike], gene: str, bin_size: int = 10, n: int = 50, *,
                     gene2: Optional[str] = None, region: Any = None, types: Optional[Sequence[str]] = None,
                     measure: str = "records", orientation: str = "oriented") -> Dict[str, Any]:
    """The ``n`` strongest contact cells, with the per-index counts behind each.

    Ties are broken by position (x, then y).  Each row is
    ``{x, y, x_end, y_end, count, per_index: [..]}``.
    """
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= MAX_LIMIT:
        raise ValueError("n must be an integer between 1 and %d" % MAX_LIMIT)
    opened = _indexes(indexes)
    selections, bounds, lengths = _contact_grid(opened, gene, gene2, bin_size, region, types, measure, orientation)
    grids = [(_rasterise([sel], bin_size, bounds) if sel is not None and len(sel[0]) else None) for sel in selections]
    shape = (bounds[1] - bounds[0] + 1, bounds[3] - bounds[2] + 1)
    total = np.zeros(shape, dtype=np.int64)
    for grid in grids:
        if grid is not None:
            total += grid
    flat = total.reshape(-1)
    nonzero = np.flatnonzero(flat)
    if len(nonzero) > n:
        # partial selection, then exact ordering of the candidates (ties included)
        threshold = np.partition(flat[nonzero], len(nonzero) - n)[len(nonzero) - n]
        nonzero = nonzero[flat[nonzero] >= threshold]
    order = nonzero[np.lexsort((nonzero, -flat[nonzero]))][:n]
    rows = []
    for cell in order.tolist():
        ix, iy = divmod(cell, shape[1])
        x, y = (ix + bounds[0]) * bin_size, (iy + bounds[2]) * bin_size
        rows.append({"x": x, "y": y, "x_end": x + bin_size - 1, "y_end": y + bin_size - 1, "count": int(flat[cell]),
                     "per_index": [int(g[ix, iy]) if g is not None else 0 for g in grids]})
    return {"gene": gene, "gene2": gene2 or gene, "bin_size": bin_size, "measure": measure,
            "length": lengths[0], "length2": lengths[1], "indexes": [str(i.path) for i in opened], "rows": rows}


# --------------------------------------------------------------------------
# hybrids


_ORDERS = {
    "file": ("id", False),
    "reads": ("reads", True),
    "position": ("s1", False),
    "dg": ("dg", False),
}


def _filter_sql(index: _Index, filters: Dict[str, Any]) -> Optional[Tuple[str, list]]:
    """WHERE clause for one index; ``None`` when the filter cannot match."""
    clauses: List[str] = []
    params: list = []
    g1 = g2 = None
    if filters.get("gene1") is not None:
        g1 = index.gene(str(filters["gene1"]))
        if g1 is None:
            return None
        clauses.append("g1 = ?")
        params.append(g1)
    if filters.get("gene2") is not None:
        g2 = index.gene(str(filters["gene2"]))
        if g2 is None:
            return None
        clauses.append("g2 = ?")
        params.append(g2)
    if filters.get("gene") is not None:
        g = index.gene(str(filters["gene"]))
        if g is None:
            return None
        clauses.append("(g1 = ? OR g2 = ?)")
        params.extend((g, g))
    if filters.get("intra") is not None:
        clauses.append("g1 = g2" if filters["intra"] else "g1 != g2")
    region = _region(filters.get("region"))
    if region is not None:
        x0, x1, y0, y1 = region
        if filters.get("region", {}).get("x") is not None:
            clauses.append("e1 >= ? AND s1 <= ?")
            params.extend((x0, x1))
            # bound the start so SQLite can range-scan the (g1, g2, s1) index
            if g1 is not None and g2 is not None:
                span = index.spans.get((g1, g2), (0, 0))[0]
                clauses.append("s1 >= ?")
                params.append(x0 - span)
        if filters.get("region", {}).get("y") is not None:
            clauses.append("e2 >= ? AND s2 <= ?")
            params.extend((y0, y1))
    types = filters.get("types")
    if types:
        if not isinstance(types, (list, tuple)):
            raise ValueError("types must be a list of chimera type names")
        ids = [index.types[t] for t in types if t in index.types]
        if not ids:
            return None
        clauses.append("type IN (%s)" % ",".join("?" * len(ids)))
        params.extend(ids)
    for key, column, op in (("min_reads", "reads", ">="), ("max_reads", "reads", "<="),
                            ("min_dg", "dg", ">="), ("max_dg", "dg", "<=")):
        value = filters.get(key)
        if value is not None:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("%s must be a number" % key)
            clauses.append("%s %s ?" % (column, op))
            params.append(value)
    return (" WHERE " + " AND ".join(clauses) if clauses else ""), params


def _read_lines(source: Optional[str], meta: Dict[str, Any], offsets: List[int]) -> Dict[int, Tuple[str, str]]:
    """(name, sequence) for rows, read back from the .hyb when it is unchanged."""
    if not source or not offsets:
        return {}
    try:
        stat = os.stat(source)
        if stat.st_size != meta.get("source_size") or stat.st_mtime_ns != meta.get("source_mtime_ns"):
            return {}
        out = {}
        with open(source, "rb") as handle:
            for offset in sorted(set(offsets)):
                handle.seek(offset)
                cols = handle.readline().rstrip(b"\r\n").split(b"\t")
                out[offset] = (cols[0].decode("utf-8", "replace"), cols[1].decode("utf-8", "replace") if len(cols) > 1 else "")
        return out
    except OSError:
        return {}


_ROW_COLUMN = {"id": 0, "s1": 2, "reads": 7, "dg": 8}


def _merge_key(row: tuple, column: str, descending: bool, number: int) -> tuple:
    """Sort key matching each index's SQL ORDER BY, extended across indexes."""
    if column == "id":
        return (number, row[0])
    value = row[_ROW_COLUMN[column]]
    if value is None:
        return (True, 0, number, row[0])
    return (False, -value if descending else value, number, row[0])


def hybrids(indexes: Sequence[PathLike], filters: Optional[Dict[str, Any]] = None, limit: int = 100, offset: int = 0, *,
            order: str = "file", with_sequence: bool = True) -> Dict[str, Any]:
    """Filtered hybrid rows across indexes.

    ``filters``: ``gene1``, ``gene2``, ``gene`` (either arm), ``intra`` (bool),
    ``region`` (``{"x": [s, e], "y": [s, e]}``, overlap with arm 1 / arm 2),
    ``types`` (list), ``min_reads``/``max_reads``, ``min_dg``/``max_dg``.
    ``order``: ``file`` (index order, then file order), ``reads`` (desc),
    ``position`` (arm 1 start), ``dg`` (asc, missing last).
    Returns ``{total, limit, offset, order, rows: [{index, id, name, sequence,
    gene1, start1, end1, gene2, start2, end2, reads, dg, overlap, type}]}``.
    """
    filters = dict(filters or {})
    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= MAX_LIMIT:
        raise ValueError("limit must be an integer between 0 and %d" % MAX_LIMIT)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    if order not in _ORDERS:
        raise ValueError("order must be one of %s" % ", ".join(sorted(_ORDERS)))
    column, descending = _ORDERS[order]
    opened = _indexes(indexes)
    total = 0
    streams = []
    for number, index in enumerate(opened):
        where = _filter_sql(index, filters)
        if where is None:
            continue
        clause, params = where
        total += index.meta["records"] if not clause else index.con.execute("SELECT count(*) FROM hybrids" + clause, params).fetchone()[0]
        if limit == 0:
            continue
        sort = "%s IS NULL, %s %s, id" % (column, column, "DESC" if descending else "ASC")
        rows = index.con.execute(
            "SELECT id, g1, s1, e1, g2, s2, e2, reads, dg, overlap, type, offset FROM hybrids%s ORDER BY %s LIMIT ?"
            % (clause, sort), params + [offset + limit]).fetchall()
        streams.append([(_merge_key(row, column, descending, number), number, row) for row in rows])
    merged = list(heapq.merge(*streams, key=lambda item: item[0]))[offset:offset + limit] if streams else []
    lookups: Dict[int, Dict[int, Tuple[str, str]]] = {}
    if with_sequence:
        for number, index in enumerate(opened):
            offs = [row[11] for _, n, row in merged if n == number]
            lookups[number] = _read_lines(index.meta.get("source_path"), index.meta, offs)
    out = []
    for _, number, row in merged:
        index = opened[number]
        name, sequence = lookups.get(number, {}).get(row[11], (None, None))
        out.append({"index": number, "id": row[0], "name": name, "sequence": sequence,
                    "gene1": index.gene_names[row[1]], "start1": row[2], "end1": row[3],
                    "gene2": index.gene_names[row[4]], "start2": row[5], "end2": row[6],
                    "reads": row[7], "dg": row[8], "overlap": row[9], "type": index.type_names.get(row[10])})
    return {"total": total, "limit": limit, "offset": offset, "order": order, "rows": out}


# --------------------------------------------------------------------------
# viewpoint and region (aggregated over the rectangles, so a sample of
# millions of hybrids answers in well under a second)


MAX_PROFILE_BINS = 30_000
OVERLAP_RULES = ("any", "contained")


def _anchor_parts(opened: List[_Index], gene: str, partner: Optional[str], types: Optional[Sequence[str]]):
    """Rectangles of every pair with ``gene`` on either arm (``partner`` on the other).

    Yields ``(rects, on1, on2, name1, name2)``: ``on1`` when arm 1 is the
    anchor (``gene``), ``on2`` when arm 2 is; ``name1``/``name2`` are the
    pair's gene names.  An intramolecular pair has both arms on the anchor.
    """
    for index in opened:
        anchor = index.gene(gene)
        if anchor is None:
            continue
        other = index.gene(partner) if partner else None
        if partner and other is None:
            continue
        for (g1, g2) in sorted(index.spans):
            on1 = g1 == anchor and (other is None or g2 == other)
            on2 = g2 == anchor and (other is None or g1 == other)
            if not (on1 or on2):
                continue
            rects = _load_rects(index, g1, g2)
            if rects is None or not len(rects["s1"]):
                continue
            mask = _type_mask(index, rects, types)
            if mask is not None:
                rects = {key: value[mask] for key, value in rects.items()}
                if not len(rects["s1"]):
                    continue
            yield rects, on1, on2, index.gene_names[g1], index.gene_names[g2]


def _anchor_range(opened: List[_Index], gene: str, lengths: Dict[str, int]) -> Tuple[Optional[int], Optional[int], Optional[int]]:
    """``(observed min, observed max, length)`` of ``gene`` over the indexes."""
    lows, highs = [], []
    for index in opened:
        extent = index.extents().get(gene)
        if extent is not None:
            lows.append(extent[0])
            highs.append(extent[1])
    observed_max = max(highs) if highs else None
    return (min(lows) if lows else None), observed_max, lengths.get(gene, observed_max)


def _span(value: Any, name: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
        raise ValueError("%s must be an integer" % name)
    if value < 0:
        raise ValueError("%s must not be negative" % name)
    return int(value)


def _overlaps(start: np.ndarray, end: np.ndarray, lo: int, hi: int, rule: str) -> np.ndarray:
    if rule == "contained":
        return (start >= lo) & (end <= hi)
    return (start <= hi) & (end >= lo)


def _bin_means(diff: np.ndarray, lo: int, hi: int, width: int) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-nt coverage from a difference array -> (bin starts, bin ends, mean per nt)."""
    span = hi - lo + 1
    per_nt = np.cumsum(diff[:span])
    count = -(-span // width)
    padded = np.zeros(count * width, dtype=np.float64)
    padded[:span] = per_nt
    sums = padded.reshape(count, width).sum(axis=1)
    starts = lo + np.arange(count, dtype=np.int64) * width
    ends = np.minimum(starts + width - 1, hi)
    return starts, ends, sums / (ends - starts + 1)


def _partner_rows(partners: Dict[str, List[int]]) -> List[Dict[str, Any]]:
    rows = [{"name": name, "records": int(v[0]), "reads": int(v[1])} for name, v in partners.items() if v[0]]
    return sorted(rows, key=lambda row: (-row["reads"], -row["records"], row["name"]))


def viewpoint(indexes: Sequence[PathLike], gene: str, start: Optional[int] = None, end: Optional[int] = None, *,
              partner: Optional[str] = None, types: Optional[Sequence[str]] = None, measure: str = "records",
              bin_size: int = 1, lengths: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """Interaction coverage along ``gene`` (the viewpoint) and its partners.

    Every arm on ``gene`` (both arms of an intramolecular hybrid) adds its
    weight (1 per record, or its reads for ``measure="reads"``) to each
    nucleotide it covers inside ``[start, end]`` (inclusive; default: the
    observed start to the reference length).  ``bin_size`` > 1 reports the
    mean per nucleotide of each bin, as the web Viewpoint does; the bin grows
    so there are at most 30,000 bins (``adjusted``).

    Returns ``{gene, partner, start, end, length, measure, requested_bin_size,
    bin_size, adjusted, records, reads, arms, max, bins: {start: [], end: [],
    value: []}, partners: [{name, records, reads}]}``; ``records``/``reads``
    count the hybrids with an arm in the range, ``arms`` the arms (records).
    """
    if measure not in ("records", "reads"):
        raise ValueError("measure must be 'records' or 'reads'")
    if isinstance(bin_size, bool) or not isinstance(bin_size, int) or not 1 <= bin_size <= 100_000:
        raise ValueError("bin_size must be an integer between 1 and 100000")
    lengths = _check_lengths(lengths)
    opened = _indexes(indexes)
    low, _, length = _anchor_range(opened, gene, lengths)
    lo = _span(start, "start")
    hi = _span(end, "end")
    lo = lo if lo is not None else (low if low is not None else 1)
    hi = hi if hi is not None else length
    out = {"gene": gene, "partner": partner, "length": length, "measure": measure, "requested_bin_size": bin_size,
           "bin_size": bin_size, "adjusted": False, "records": 0, "reads": 0, "arms": 0, "max": 0.0,
           "start": lo, "end": hi, "bins": {"start": [], "end": [], "value": []}, "partners": []}
    if hi is None:
        return out
    if lo > hi:
        raise ValueError("start must not exceed end")
    span = hi - lo + 1
    width = max(bin_size, -(-span // MAX_PROFILE_BINS))
    diff = np.zeros(span + 1, dtype=np.float64)
    partners: Dict[str, List[int]] = {}
    records = reads = arms = 0
    for rects, on1, on2, name1, name2 in _anchor_parts(opened, gene, partner, types):
        count = rects["count"].astype(np.int64)
        weight = (count if measure == "records" else rects["reads"].astype(np.int64)).astype(np.float64)
        matched = {}
        for arm, on in (("1", on1), ("2", on2)):
            if not on:
                continue
            s = rects["s" + arm].astype(np.int64)
            e = rects["e" + arm].astype(np.int64)
            keep = (s <= hi) & (e >= lo)
            matched[arm] = keep
            if not keep.any():
                continue
            s, e, w = np.maximum(s[keep], lo) - lo, np.minimum(e[keep], hi) - lo + 1, weight[keep]
            diff += np.bincount(s, weights=w, minlength=span + 1)[:span + 1]
            diff -= np.bincount(e, weights=w, minlength=span + 1)[:span + 1]
            arms += int(count[keep].sum())
        none = np.zeros(len(count), dtype=bool)
        first, second = matched.get("1", none), matched.get("2", none)
        hit = first | second
        records += int(count[hit].sum())
        reads += int(rects["reads"][hit].astype(np.int64).sum())
        # partner: arm 2's gene where arm 1 is the anchor in range, else arm 1's
        for name, mask in ((name2, first), (name1, second & ~first)):
            if not mask.any():
                continue
            entry = partners.setdefault(name, [0, 0])
            entry[0] += int(count[mask].sum())
            entry[1] += int(rects["reads"][mask].astype(np.int64).sum())
    starts, ends, values = _bin_means(diff, lo, hi, width)
    values = np.round(values, 4)
    out.update({"bin_size": width, "adjusted": width != bin_size, "records": records, "reads": reads, "arms": arms,
                "max": float(values.max()) if len(values) else 0.0,
                "bins": {"start": starts.tolist(), "end": ends.tolist(), "value": values.tolist()},
                "partners": _partner_rows(partners)})
    return out


def _top(reads: np.ndarray, count: np.ndarray, s1: np.ndarray, rows: np.ndarray, k: int) -> np.ndarray:
    """Up to ``k`` of ``rows`` by reads, then records, then position (the
    rectangles are stored sorted by arm 1 start, so by row number)."""
    if len(rows) > k:
        values = reads[rows]
        cut = np.partition(values, len(values) - k)[len(values) - k]
        above, tied = rows[values > cut], rows[values == cut]
        need = k - len(above)
        if len(tied) > need:
            counts = count[tied]
            cut = np.partition(counts, len(counts) - need)[len(counts) - need]
            more = tied[counts > cut]
            tied = np.concatenate([more, tied[counts == cut][:need - len(more)]])
        rows = np.concatenate([above, tied])
    return rows[np.lexsort((rows, -count[rows], -reads[rows]))]


def _lookup(part: Dict[str, Any], key: tuple) -> Tuple[int, int]:
    """(records, reads) of one distinct interaction in a part (0, 0 when absent)."""
    s1 = part["s1"]
    lo, hi = np.searchsorted(s1, key[0], "left"), np.searchsorted(s1, key[0], "right")
    if lo == hi:
        return 0, 0
    window = slice(lo, hi)
    match = (part["e1"][window] == key[1]) & (part["s2"][window] == key[2]) & (part["e2"][window] == key[3]) \
        & (part["types"][part["type"][window]] == key[4]) & part["hit"][window]
    return int(part["count"][window][match].sum()), int(part["reads"][window][match].sum())


def region(indexes: Sequence[PathLike], gene: str, start: int, end: int, *, partner: Optional[str] = None,
           partner_start: Optional[int] = None, partner_end: Optional[int] = None, overlap: str = "any",
           types: Optional[Sequence[str]] = None, limit: int = 100) -> Dict[str, Any]:
    """Hybrids with an arm on ``gene:[start, end]`` (and the other arm on
    ``partner``, inside ``[partner_start, partner_end]`` when given), as the
    web Region Explorer: either arm order matches.

    ``overlap``: ``any`` (the arm overlaps the range) or ``contained``.
    Returns ``{gene, start, end, partner, partner_start, partner_end, overlap,
    records, reads, distinct, partners: [{name, records, reads}],
    profile: {bin_size, adjusted, start: [], end: [], value: []}, rows: [...],
    rows_exact}``.  The profile adds each matching hybrid's reads to every
    bin of ``[start, end]`` its anchor arm covers.  ``rows`` are the
    ``limit`` strongest distinct interactions (same genes, coordinates and
    type, summed over the indexes): ``{gene1, start1, end1, gene2, start2,
    end2, type, records, reads}`` by reads, then records, then arm 1 start.
    Over several indexes they come from each index's strongest candidates;
    ``rows_exact`` is false in the rare case that bound cannot prove the
    order, and ``distinct`` (the number of distinct interactions) is only
    given for one index.
    """
    lo, hi = _span(start, "start"), _span(end, "end")
    if lo is None or hi is None:
        raise ValueError("start and end are required")
    if lo > hi:
        raise ValueError("start must not exceed end")
    plo, phi = _span(partner_start, "partner_start"), _span(partner_end, "partner_end")
    if (plo is None) != (phi is None):
        raise ValueError("partner_start and partner_end go together")
    if plo is not None and not partner:
        raise ValueError("a partner range needs a partner gene")
    if plo is not None and plo > phi:
        raise ValueError("partner_start must not exceed partner_end")
    if overlap not in OVERLAP_RULES:
        raise ValueError("overlap must be 'any' or 'contained'")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= MAX_LIMIT:
        raise ValueError("limit must be an integer between 0 and %d" % MAX_LIMIT)
    opened = _indexes(indexes)
    span = hi - lo + 1
    requested = 50 if span > 1000 else 25 if span > 500 else 10
    width = max(requested, -(-span // MAX_PROFILE_BINS))
    nbins = -(-span // width)
    diff = np.zeros(nbins + 1, dtype=np.float64)
    partners: Dict[str, List[int]] = {}
    records = reads = 0
    per_index: List[List[Dict[str, Any]]] = []
    for index in opened:
        parts = []
        type_names = np.asarray([index.type_names.get(t, "") for t in range(max(index.type_names, default=0) + 1)], dtype=object)
        for rects, on1, on2, name1, name2 in _anchor_parts([index], gene, partner, types):
            s1 = rects["s1"].astype(np.int64)
            if len(s1) > 1 and not bool(np.all(s1[1:] >= s1[:-1])):  # indexes store them sorted; _lookup needs it
                order = np.argsort(s1, kind="stable")
                rects = {key: value[order] for key, value in rects.items()}
                s1 = s1[order]
            count = rects["count"].astype(np.int64)
            weight = rects["reads"].astype(np.int64)
            e1 = rects["e1"].astype(np.int64)
            s2, e2 = rects["s2"].astype(np.int64), rects["e2"].astype(np.int64)
            none = np.zeros(len(s1), dtype=bool)
            forward = _overlaps(s1, e1, lo, hi, overlap) if on1 else none
            reverse = _overlaps(s2, e2, lo, hi, overlap) if on2 else none
            if plo is not None:
                forward = forward & _overlaps(s2, e2, plo, phi, overlap)
                reverse = reverse & _overlaps(s1, e1, plo, phi, overlap)
            hit = forward | reverse
            if not hit.any():
                continue
            records += int(count[hit].sum())
            reads += int(weight[hit].sum())
            for name, mask in ((name2, forward), (name1, reverse & ~forward)):
                if mask.any():
                    entry = partners.setdefault(name, [0, 0])
                    entry[0] += int(count[mask].sum())
                    entry[1] += int(weight[mask].sum())
            # profile: every anchor arm of a matching hybrid, clipped to the range
            for anchored, s, e in ((name1 == gene, s1, e1), (name2 == gene, s2, e2)):
                if not anchored:
                    continue
                keep = hit & (s <= hi) & (e >= lo)
                if keep.any():
                    first = (np.maximum(s[keep], lo) - lo) // width
                    last = (np.minimum(e[keep], hi) - lo) // width
                    w = weight[keep].astype(np.float64)
                    diff += np.bincount(first, weights=w, minlength=nbins + 1)[:nbins + 1]
                    diff -= np.bincount(last + 1, weights=w, minlength=nbins + 1)[:nbins + 1]
            parts.append({"name1": name1, "name2": name2, "s1": s1, "e1": e1, "s2": s2, "e2": e2,
                          "type": rects["type"].astype(np.int64), "types": type_names, "count": count, "reads": weight,
                          "hit": hit, "rows": np.flatnonzero(hit)})
        per_index.append(parts)

    def key_of(part: Dict[str, Any], i: int) -> tuple:
        return (int(part["s1"][i]), int(part["e1"][i]), int(part["s2"][i]), int(part["e2"][i]),
                part["types"][part["type"][i]], part["name1"], part["name2"])

    rows: List[Dict[str, Any]] = []
    exact = True
    distinct = sum(len(part["rows"]) for part in per_index[0]) if len(opened) == 1 and per_index else None
    if limit:
        k = limit if len(opened) == 1 else max(4 * limit, 200)
        candidates: Dict[tuple, List[int]] = {}
        bound = 0
        for parts in per_index:
            best: List[Tuple[int, int, int, tuple]] = []
            for part in parts:
                for i in _top(part["reads"], part["count"], part["s1"], part["rows"], k).tolist():
                    best.append((-int(part["reads"][i]), -int(part["count"][i]), int(part["s1"][i]), key_of(part, i)))
            best.sort()
            best = best[:k]
            if len(best) == k:
                bound += -best[-1][0]
            for item in best:
                candidates.setdefault(item[3], [0, 0])
        for item_key, total in candidates.items():
            for parts in per_index:
                for part in parts:
                    if part["name1"] == item_key[5] and part["name2"] == item_key[6]:
                        got = _lookup(part, item_key)
                        total[0] += got[0]
                        total[1] += got[1]
        ranked = sorted(candidates.items(), key=lambda kv: (-kv[1][1], -kv[1][0], kv[0][0], kv[0]))[:limit]
        if len(opened) > 1 and len(ranked) == limit and ranked[-1][1][1] < bound:
            exact = False
        for item_key, (n, r) in ranked:
            rows.append({"gene1": item_key[5], "start1": item_key[0], "end1": item_key[1], "gene2": item_key[6],
                         "start2": item_key[2], "end2": item_key[3], "type": item_key[4] or None, "records": n, "reads": r})
    starts = lo + np.arange(nbins, dtype=np.int64) * width
    return {"gene": gene, "start": lo, "end": hi, "partner": partner, "partner_start": plo, "partner_end": phi,
            "overlap": overlap, "records": records, "reads": reads, "distinct": distinct,
            "partners": _partner_rows(partners),
            "profile": {"bin_size": width, "adjusted": width != requested, "start": starts.tolist(),
                        "end": np.minimum(starts + width - 1, hi).tolist(),
                        "value": np.rint(np.cumsum(diff[:nbins])).astype(np.int64).tolist()},
            "rows": rows, "rows_exact": exact}

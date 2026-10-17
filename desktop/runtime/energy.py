"""Folding energy of lineage-enriched interactions in both lineages.

Bridge operations: ``energy_run`` (a task) and ``read_energy`` (a project
operation).  Request of the task::

    {"operation": "energy_run", "project_path": ..., "task_id": ..., "run_dir": ...,
     "comparison_id": ..., "parameters": {"length": 40, "padj": 0.01}}

As ``reproduce_zikv/analysis/folding_energy.py``: for each merged interaction
of a Compare test with padj below the cutoff, a fragment of ``length`` nt is
centred on each arm at (bin start + 5) on condition one's reference; the two
fragments are joined with "&" and cofolded (ViennaRNA RNAcofold, default
model, 37 C) once with condition one's sequence and once with condition two's
sequence at the aligned positions (:mod:`seqmap`, the Structure page's
alignment; a centre facing a gap takes the base after the previous aligned
one, as the script's ``align_map``).
Fragments that run off either end are skipped.  Per direction (enriched in
one / in two) the dG of the two lineages are compared with a paired t-test.

Results go to ``comparisons/<id>/energy_L<length>.tsv`` (columns length side
x y log2FoldChange padj dG_one dG_two, as the script) and
``energy_L<length>.json`` (parameters, versions, per-side statistics).
"""
from __future__ import annotations

import math
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .project import _atomic_write_json, validate_project_directory
from .regions import Aligner, comparison_dir, comparison_entry, comparison_interactions, group_gene, map_note
from .structure import ProgressWriter, _now, _resolve_run_dir, _safe_task_id

SIDES = ("enriched_in_one", "enriched_in_two")
DEFAULTS = {"length": 40, "padj": 0.01}
COLUMNS = ("length", "side", "x", "y", "log2FoldChange", "padj", "dG_one", "dG_two")


# ---------------------------------------------------------------------------
# statistics: paired t-test with the Student t distribution
# ---------------------------------------------------------------------------

def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction of the incomplete beta function (modified Lentz)."""
    tiny = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    d = 1.0 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 10_000):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > tiny else tiny)
        c = 1.0 + aa / c
        c = c if abs(c) > tiny else tiny
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > tiny else tiny)
        c = 1.0 + aa / c
        c = c if abs(c) > tiny else tiny
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    return h


def betainc(a: float, b: float, x: float) -> float:
    """Regularized incomplete beta function I_x(a, b)."""
    if not (a > 0 and b > 0):
        raise ValueError("a and b must be positive")
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    log_front = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x)
    if x < (a + 1.0) / (a + b + 2.0):
        return math.exp(log_front) * _betacf(a, b, x) / a
    return 1.0 - math.exp(log_front) * _betacf(b, a, 1.0 - x) / b


def t_two_sided(t: float, df: float) -> float:
    """Two-sided p-value of Student's t with df degrees of freedom."""
    if math.isinf(t):
        return 0.0
    return betainc(df / 2.0, 0.5, df / (df + t * t))


def paired_t_test(one: Sequence[float], two: Sequence[float]) -> Optional[Dict[str, float]]:
    """R's ``t.test(one, two, paired = TRUE)``: t, df, p, means; None when n < 2."""
    if len(one) != len(two):
        raise ValueError("paired samples must have the same length")
    n = len(one)
    if n < 2:
        return None
    diff = [a - b for a, b in zip(one, two)]
    mean = math.fsum(diff) / n
    var = math.fsum((d - mean) ** 2 for d in diff) / (n - 1)
    se = math.sqrt(var / n)
    out = {"n": n, "mean_dG_one": math.fsum(one) / n, "mean_dG_two": math.fsum(two) / n,
           "mean_diff_one_minus_two": mean, "t": math.nan, "df": n - 1, "p": math.nan}
    if se < 10 * sys.float_info.epsilon * abs(mean):
        # where R stops with "data are essentially constant"
        out["note"] = "differences are constant"
    elif se > 0:
        out["t"] = mean / se
        out["p"] = t_two_sided(out["t"], n - 1)
    return out


# ---------------------------------------------------------------------------
# fragments and cofolding
# ---------------------------------------------------------------------------

def fragment(sequence: str, centre: int, length: int) -> Optional[str]:
    """``length`` nt centred on the 0-based ``centre`` (start = centre - length // 2); None off the ends."""
    start = centre - length // 2
    if start < 0 or start + length > len(sequence):
        return None
    return sequence[start:start + length]


def cofold(a: str, b: str) -> float:
    """MFE of the dimer a&b (RNAcofold defaults), rounded as RNAcofold prints it."""
    import RNA

    _, mfe = RNA.cofold(a + "&" + b)
    return round(float(mfe), 2)


def vienna_version() -> Optional[str]:
    try:
        import RNA
    except ImportError:
        return None
    return str(getattr(RNA, "__version__", "") or "") or None


def forward(amap: Any, position: int, length_two: int) -> int:
    """1-based ``position`` of condition one moved onto condition two: the aligned base, or for a base
    facing a gap the base after the previous aligned one (the script's ``align_map``), at most
    ``length_two``; 0 out of range."""
    if amap is None:
        return position
    if position < 1 or position > len(amap.to):
        return 0
    if amap.to[position - 1] > 0:
        return int(amap.to[position - 1])
    for p in range(position - 1, 0, -1):
        if amap.to[p - 1] > 0:
            return min(length_two, int(amap.to[p - 1]) + 1)
    return 1


def fragment_jobs(rows: Sequence[Dict[str, Any]], one: str, two: str, amap: Any, length: int) -> Tuple[List[Tuple], int]:
    """``(jobs, skipped)``; a job is (side, x, y, lfc, padj, (one_a, one_b), (two_a, two_b))."""
    jobs, skipped = [], 0
    for row in rows:
        x, y = row["x"], row["y"]
        cx, cy = x + 5, y + 5  # 1-based centres on condition one's reference
        ox, oy = forward(amap, cx, len(two)), forward(amap, cy, len(two))
        qa, qb = fragment(one, cx - 1, length), fragment(one, cy - 1, length)
        oa = fragment(two, ox - 1, length) if ox else None
        ob = fragment(two, oy - 1, length) if oy else None
        if None in (qa, qb, oa, ob):
            skipped += 1
            continue
        side = "enriched_in_one" if row["direction"] == "up" else "enriched_in_two"
        jobs.append((side, x, y, row.get("log2FoldChange"), row["padj"], (qa, qb), (oa, ob)))
    return jobs, skipped


def side_stats(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    out = {}
    for side in SIDES:
        part = [r for r in rows if r["side"] == side]
        test = paired_t_test([r["dG_one"] for r in part], [r["dG_two"] for r in part])
        out[side] = test or {"n": len(part)}
    return out


# ---------------------------------------------------------------------------
# task
# ---------------------------------------------------------------------------

def _parameters(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    unknown = sorted(set(raw) - set(DEFAULTS))
    if unknown:
        raise ValueError("unknown energy parameters: " + ", ".join(unknown))
    length = raw.get("length", DEFAULTS["length"])
    if isinstance(length, bool) or not isinstance(length, (int, float)) or int(length) != length or not 4 <= length <= 400:
        raise ValueError("length must be an integer between 4 and 400")
    padj = raw.get("padj", DEFAULTS["padj"])
    if isinstance(padj, bool) or not isinstance(padj, (int, float)) or not 0 < padj <= 1:
        raise ValueError("padj must be a number in (0, 1]")
    return {"length": int(length), "padj": float(padj)}


def _fmt(value: Any) -> str:
    if value is None:
        return "NA"
    return repr(float(value)) if isinstance(value, float) else str(value)


def _energy_run(request: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
    started = time.monotonic()
    raw_path = request.get("project_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("project path must be a non-empty string")
    project = Path(raw_path).expanduser().resolve()
    errors = validate_project_directory(project)
    if errors:
        raise ValueError("invalid project: " + "; ".join(errors))
    task_id = _safe_task_id(request.get("task_id") or ("energy-" + os.urandom(8).hex()))
    comparison_id = request.get("comparison_id")
    if not isinstance(comparison_id, str) or not comparison_id:
        raise ValueError("comparison_id is required")
    params = _parameters(request.get("parameters"))
    entry = comparison_entry(project, comparison_id)
    out_dir = comparison_dir(project, entry)
    run_dir = _resolve_run_dir(project, task_id, request.get("run_dir"))
    state.update(run_dir=run_dir, task_id=task_id)
    progress = ProgressWriter(run_dir)

    progress("prepare", "reading the test and the references", None, None, units="none", force=True)
    interactions = comparison_interactions(project, entry)
    gene_one, ref_one = group_gene(project, entry, "samples_one")
    gene_two, ref_two = group_gene(project, entry, "samples_two")
    aligner = Aligner(project)
    from .regions import gene_sequence

    aligner.sequences[gene_one] = gene_sequence(project, gene_one, ref_one)
    aligner.sequences[gene_two] = gene_sequence(project, gene_two, ref_two)
    progress("align", f"aligning {gene_one} to {gene_two}", None, None, units="none", force=True)
    amap = aligner.map(gene_one, gene_two)
    rows = [r for r in interactions if r.get("padj") is not None and r["padj"] < params["padj"]
            and r.get("direction") in ("up", "down")]
    rows.sort(key=lambda r: r["direction"] != "up")  # enriched in one first, table order within
    jobs, skipped = fragment_jobs(rows, aligner.sequences[gene_one], aligner.sequences[gene_two], amap, params["length"])

    results: List[Dict[str, Any]] = []
    total = len(jobs)
    for k, (side, x, y, lfc, padj, frag_one, frag_two) in enumerate(jobs):
        results.append({"length": params["length"], "side": side, "x": x, "y": y, "log2FoldChange": lfc, "padj": padj,
                         "dG_one": cofold(*frag_one), "dG_two": cofold(*frag_two)})
        progress("cofold", f"{k + 1} of {total} interactions", k + 1, total, units="interactions")

    progress("write", "writing results", None, None, units="none", force=True)
    stem = f"energy_L{params['length']}"
    lines = ["\t".join(COLUMNS)]
    for r in results:
        lines.append("\t".join(_fmt(r[c]) for c in COLUMNS))
    tsv = out_dir / f"{stem}.tsv"
    temporary = tsv.with_name("." + tsv.name + ".tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(temporary, tsv)
    summary = {
        "version": 1, "comparison_id": comparison_id, "task_id": task_id,
        "label_one": entry.get("label_one"), "label_two": entry.get("label_two"),
        "gene_one": gene_one, "gene_two": gene_two,
        "parameters": {**params, "centre": "bin start + 5 on condition one's reference", "joined": "&",
                       "folding": "RNAcofold MFE, ViennaRNA default model (37 C)"},
        "vienna_version": vienna_version(),
        "alignment": map_note(gene_one, gene_two, amap),
        "interactions": len(rows), "folded": len(results), "skipped": skipped,
        "sides": side_stats(results),
        "files": {"tsv": f"{entry.get('path') or 'comparisons/' + comparison_id}/{stem}.tsv"},
        "created_at": _now(),
        "seconds": round(time.monotonic() - started, 2),
    }
    _atomic_write_json(out_dir / f"{stem}.json", _json_safe(summary))
    result = {"ok": True, "status": "succeeded", "task_id": task_id, "run_dir": str(run_dir), "output": str(tsv),
              "output_dir": str(out_dir), "summary": _json_safe(summary), "seconds": summary["seconds"]}
    progress("done", "finished", None, None, units="none", force=True)
    _atomic_write_json(run_dir / "result.json", result)
    return result


def _json_safe(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def energy_run(request: Dict[str, Any]) -> Dict[str, Any]:
    """Bridge entry point; failures after the run directory exists go to result.json."""
    state: Dict[str, Any] = {}
    try:
        return _energy_run(request, state)
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
# read_energy
# ---------------------------------------------------------------------------

def read_energy(project: Path, comparison_id: str, length: Any = None) -> Dict[str, Any]:
    """``{lengths: [...], summary, rows: {side, x, y, log2FoldChange, padj, dG_one, dG_two}}`` of one length
    (the requested one, else 40, else the first); summary and rows are null when none was computed."""
    import json

    project = Path(project).expanduser().resolve()
    entry = comparison_entry(project, comparison_id)
    try:
        directory = comparison_dir(project, entry)
    except ValueError:
        return {"comparison_id": comparison_id, "lengths": [], "summary": None, "rows": None}
    lengths = []
    for path in directory.glob("energy_L*.json"):
        try:
            lengths.append(int(path.stem[len("energy_L"):]))
        except ValueError:
            continue
    lengths.sort()
    if length is not None and (isinstance(length, bool) or not isinstance(length, int)):
        raise ValueError("length must be an integer")
    chosen = length if length in lengths else (40 if 40 in lengths else (lengths[0] if lengths else None))
    if chosen is None:
        return {"comparison_id": comparison_id, "lengths": [], "summary": None, "rows": None}
    summary = json.loads((directory / f"energy_L{chosen}.json").read_text(encoding="utf-8"))
    rows: Dict[str, List[Any]] = {"side": [], "x": [], "y": [], "log2FoldChange": [], "padj": [], "dG_one": [], "dG_two": []}
    tsv = directory / f"energy_L{chosen}.tsv"
    if tsv.is_file():
        with open(tsv, encoding="utf-8") as handle:
            header = handle.readline().rstrip("\n").split("\t")
            col = {name: header.index(name) for name in rows if name in header}
            for line in handle:
                cells = line.rstrip("\n").split("\t")
                if len(cells) < len(header):
                    continue
                rows["side"].append(cells[col["side"]])
                for name in ("x", "y"):
                    rows[name].append(int(cells[col[name]]))
                for name in ("log2FoldChange", "padj", "dG_one", "dG_two"):
                    value = cells[col[name]]
                    rows[name].append(None if value == "NA" else float(value))
    return {"comparison_id": comparison_id, "lengths": lengths, "length": chosen, "summary": summary, "rows": rows}

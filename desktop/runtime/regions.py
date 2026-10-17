"""Local structures of two lineage-enriched regions (bridge operation ``structure_regions``).

Request::

    {"operation": "structure_regions", "path": ..., "comparison_id": ...,
     "structure_one": <structure id>, "structure_two": <structure id>,
     "padj": 0.01, "reach": 50, "flank": 15, "choice": {"up": <rank>, "down": <rank>}}

Structure one is condition one's lineage (its reference is "A"), structure two
condition two's; a structure folded on another reference is moved onto A's
coordinates by the same banded alignment as the Structure page
(:mod:`seqmap`, a port of the app's Go package).

For each direction of the Compare test (``up``: higher in condition one,
whose own fold is structure one; ``down``: higher in condition two, fold two),
the merged interactions with padj below the cutoff are ranked by padj.  An
interaction is a 10-nt cell; its arms are ``a = min(x, y) + 5`` and
``b = max(x, y) + 5`` on the reference of the condition whose samples it came
from (higher in one: condition one's, else condition two's), moved onto A's
coordinates like the Structure page's differential arcs.  A candidate is an
interaction the enriched lineage's own fold forms: at least one base pair
``(i, j)`` with ``|i - a| <= reach`` and ``|j - b| <= reach``.  The most
significant candidate is chosen unless ``choice`` names another rank.  Its two
windows are the extent of those pairs plus ``flank`` nt.  The same windows are
cut from both folds (on fold two's own reference, by alignment) and laid out
as one 2D diagram each: the windows are joined by a 3-nt unpaired linker for
the layout only (``RNA.get_xy_coordinates``, as
``reproduce_zikv/analysis/window_from_structure.py``).  Pairs with one base
outside the windows are reported as outside partners (runs of partners within
5 nt merged into ranges).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import seqmap
from .project import load_manifest, safe_relative_path
from .structure import _pairs, _structure_file, parse_dbn

LINKER = 3
RUN_GAP = 5
MAX_CANDIDATES = 60
DEFAULTS = {"padj": 0.01, "reach": 50, "flank": 15}


# ---------------------------------------------------------------------------
# shared project helpers (also used by energy.py)
# ---------------------------------------------------------------------------

def comparison_entry(project: Path, comparison_id: str) -> Dict[str, Any]:
    manifest = load_manifest(project)
    entry = next((item for item in manifest.get("comparisons") or []
                  if isinstance(item, dict) and item.get("id") == comparison_id), None)
    if entry is None:
        raise ValueError("comparison does not exist: %s" % comparison_id)
    return entry


def comparison_dir(project: Path, entry: Dict[str, Any]) -> Path:
    """``comparisons/<id>/`` of a registered test (a real directory inside the project)."""
    relative = entry.get("path") or "comparisons/%s" % entry.get("id")
    if not safe_relative_path(relative):
        raise ValueError("comparison path is not project-relative")
    target = (project / relative).resolve()
    base = (project / "comparisons").resolve()
    if base not in target.parents or not target.is_dir():
        raise ValueError("comparison files are missing: %s" % entry.get("id"))
    return target


def comparison_interactions(project: Path, entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    from .compare import _comparison_file, _pipeline_path

    _pipeline_path(None)
    from rnaxrayanalysis import differential

    path = _comparison_file(project, entry, "interactions")
    if path is None:
        raise ValueError("comparison files are missing: %s" % entry.get("id"))
    return differential.read_interactions(path)


def group_gene(project: Path, entry: Dict[str, Any], key: str) -> Tuple[str, str]:
    """``(gene, reference_id)`` a group of the test (``samples_one`` / ``samples_two``) was analysed on."""
    manifest = load_manifest(project)
    samples = {s.get("id"): s for s in manifest.get("samples") or [] if isinstance(s, dict)}
    parameters = entry.get("parameters") if isinstance(entry.get("parameters"), dict) else {}
    gene = parameters.get("gene_id") if isinstance(parameters.get("gene_id"), str) else None
    reference = None
    for sample_id in entry.get(key) or []:
        sample = samples.get(sample_id) or {}
        if not gene and sample.get("gene_id"):
            gene = sample["gene_id"]
        if gene and sample.get("gene_id") == gene and sample.get("reference_id"):
            reference = sample["reference_id"]
            break
    if not gene and entry.get("genes"):
        gene = entry["genes"][0]
    if not gene:
        raise ValueError("the test's %s have no target gene" % key.replace("_", " "))
    return gene, reference or reference_of(manifest, gene)


def reference_of(manifest: Dict[str, Any], gene: str) -> str:
    for reference in manifest.get("references") or []:
        for sequence in reference.get("sequences") or []:
            if isinstance(sequence, dict) and sequence.get("name") == gene:
                return str(reference.get("id"))
    raise ValueError("no reference holds %s" % gene)


def gene_sequence(project: Path, gene: str, reference_id: Optional[str] = None) -> str:
    from .samples import read_reference_sequence

    if reference_id is None:
        reference_id = reference_of(load_manifest(project), gene)
    sequence = read_reference_sequence(project, reference_id, gene)["sequence"]
    if not sequence:
        raise ValueError("the sequence of %s is empty" % gene)
    return sequence.upper().replace("T", "U")


class Aligner:
    """Gene-to-gene maps, aligned once each."""

    def __init__(self, project: Path):
        self.project = project
        self.sequences: Dict[str, str] = {}
        self.maps: Dict[Tuple[str, str], seqmap.Map] = {}

    def sequence(self, gene: str) -> str:
        if gene not in self.sequences:
            self.sequences[gene] = gene_sequence(self.project, gene)
        return self.sequences[gene]

    def map(self, source: str, target: str) -> Optional[seqmap.Map]:
        """None when the genes are the same (identity)."""
        if source == target:
            return None
        key = (source, target)
        if key not in self.maps:
            self.maps[key] = seqmap.align(self.sequence(source), self.sequence(target))
        return self.maps[key]


def map_note(source: str, target: str, m: Optional[seqmap.Map]) -> Optional[Dict[str, Any]]:
    if m is None:
        return None
    return {"from": source, "to": target, "identity": round(m.identity, 5), "mismatches": m.mismatches,
            "gaps": m.gaps, "same": m.same}


# ---------------------------------------------------------------------------
# structures
# ---------------------------------------------------------------------------

def read_fold(project: Path, structure_id: str) -> Dict[str, Any]:
    """A registered whole-RNA fold: ``{id, gene_id, sequence, partner, pairs, entry}``."""
    manifest = load_manifest(project)
    entry = next((item for item in manifest.get("structures") or []
                  if isinstance(item, dict) and item.get("id") == structure_id), None)
    if entry is None:
        raise ValueError("structure does not exist: %s" % structure_id)
    path = _structure_file(project, entry, "dbn")
    if path is None:
        raise ValueError("structure files are missing: %s" % structure_id)
    records = parse_dbn(path.read_text(encoding="utf-8"))
    if entry.get("mode") != "genome" or len(records) != 1 or records[0]["window_start"] != 1:
        raise ValueError("structure %s is not a whole-RNA (genome) fold" % structure_id)
    record = records[0]
    pairs = [(i, j) for i, j, _ in _pairs(record["dbn"])]
    partner: Dict[int, int] = {}
    for i, j in pairs:
        partner[i], partner[j] = j, i
    return {"id": structure_id, "gene_id": str(entry.get("gene_id") or ""), "sequence": record["sequence"].upper().replace("T", "U"),
            "pairs": pairs, "partner": partner, "entry": entry, "energy": record.get("energy")}


def move_pairs(pairs: Sequence[Tuple[int, int]], m: Optional[seqmap.Map]) -> List[Tuple[int, int]]:
    """Pairs on another reference (pairs with an end facing a gap are dropped), as the Structure page."""
    if m is None:
        return list(pairs)
    out = []
    for i, j in pairs:
        a, b = m.pos(i), m.pos(j)
        if a and b:
            out.append((min(a, b), max(a, b)))
    return out


# ---------------------------------------------------------------------------
# selection
# ---------------------------------------------------------------------------

def near(pairs: Sequence[Tuple[int, int]], a: int, b: int, reach: int) -> List[Tuple[int, int]]:
    return [(i, j) for i, j in pairs if abs(i - a) <= reach and abs(j - b) <= reach]


def arms(x: int, y: int, m: Optional[seqmap.Map]) -> Tuple[int, int]:
    """The arms (cell centres) of a merged interaction on A's coordinates; (0, 0) when unaligned."""
    a, b = min(x, y) + 5, max(x, y) + 5
    if m is not None:
        a, b = m.nearest(a, 10), m.nearest(b, 10)
    return a, b


def ranked(interactions: Sequence[Dict[str, Any]], direction: str, padj: float) -> List[Dict[str, Any]]:
    """The test's interactions of one direction with padj < cutoff, by padj (ties keep table order)."""
    rows = [r for r in interactions if r.get("direction") == direction and r.get("padj") is not None and r["padj"] < padj]
    rows.sort(key=lambda r: r["padj"])
    return rows


def candidates(rows: Sequence[Dict[str, Any]], own: Sequence[Tuple[int, int]], other: Sequence[Tuple[int, int]],
               m: Optional[seqmap.Map], reach: int, limit: int = MAX_CANDIDATES) -> List[Dict[str, Any]]:
    """Interactions the enriched lineage's own fold forms (>= 1 pair within reach of both arms)."""
    out = []
    for rank, row in enumerate(rows, 1):
        a, b = arms(row["x"], row["y"], m)
        if not a or not b:
            continue
        hit = near(own, a, b, reach)
        if not hit:
            continue
        out.append({"rank": rank, "x": row["x"], "y": row["y"], "a": a, "b": b,
                    "cell_a": min(row["x"], row["y"]) + 5, "cell_b": max(row["x"], row["y"]) + 5,
                    "log2FoldChange": row.get("log2FoldChange"), "padj": row["padj"],
                    "pairs_own": len(hit), "pairs_other": len(near(other, a, b, reach)), "hit": hit})
        if len(out) >= limit:
            break
    return out


def windows_of(hit: Sequence[Tuple[int, int]], flank: int, length: int) -> List[Tuple[int, int]]:
    """Window X around the 5' ends of the pairs, Y around the 3' ends (merged when they touch)."""
    x0, x1 = max(1, min(i for i, _ in hit) - flank), min(length, max(i for i, _ in hit) + flank)
    y0, y1 = max(1, min(j for _, j in hit) - flank), min(length, max(j for _, j in hit) + flank)
    if y0 <= x1 + 1:
        return [(x0, max(x1, y1))]
    return [(x0, x1), (y0, y1)]


def move_windows(windows: Sequence[Tuple[int, int]], m: Optional[seqmap.Map]) -> List[Tuple[int, int]]:
    if m is None:
        return list(windows)
    out = []
    for start, end in windows:
        s, e = m.nearest(start, 50), m.nearest(end, 50)
        if not s or not e or e < s:
            raise ValueError("window %d-%d does not align to the other reference" % (start, end))
        out.append((s, e))
    return out


# ---------------------------------------------------------------------------
# cutting and layout
# ---------------------------------------------------------------------------

def runs(values: Sequence[int], gap: int = RUN_GAP) -> List[List[int]]:
    """Sorted values merged into [start, end] runs when within ``gap`` of the previous."""
    out: List[List[int]] = []
    for v in sorted(values):
        if out and v - out[-1][1] <= gap:
            out[-1][1] = v
        else:
            out.append([v, v])
    return out


def runs_text(values: Sequence[int]) -> str:
    return "; ".join(f"{a}-{b}" if a != b else f"{a}" for a, b in runs(values)) or "-"


def _nested(pairs: Sequence[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """A nested subset (the layout needs one): pairs crossing an earlier kept pair are left out."""
    kept: List[Tuple[int, int]] = []
    for i, j in sorted(pairs, key=lambda p: (p[1] - p[0], p[0])):
        if all(not (a < i < b < j or i < a < j < b) for a, b in kept):
            kept.append((i, j))
    return sorted(kept)


def layout(structure: str) -> List[Tuple[float, float]]:
    import RNA

    xy = RNA.get_xy_coordinates(structure)
    return [(round(xy.get(k).X, 2), round(xy.get(k).Y, 2)) for k in range(len(structure))]


def cut(sequence: str, partner: Dict[int, int], windows: Sequence[Tuple[int, int]], linker: int = LINKER) -> Dict[str, Any]:
    """Cut windows (1-based inclusive, in order) from a fold and lay them out as one diagram.

    Returns arrays over the windows' bases (``pos``, ``base``, ``window`` index,
    ``x``, ``y``, ``partner`` = local index of a partner inside the windows or
    -1, ``outside`` = genome partner outside the windows or 0) and the counts
    of window_from_structure.py.
    """
    pos: List[int] = []
    window: List[int] = []
    for w, (start, end) in enumerate(windows):
        for p in range(start, end + 1):
            pos.append(p)
            window.append(w)
    local = {p: k for k, p in enumerate(pos)}
    inside = [(local[p], local[partner[p]]) for p in pos if partner.get(p, 0) > p and partner[p] in local]
    layout_pairs = _nested(inside)
    # local index -> index in the layout string (windows joined by unpaired linkers)
    offset = [k + window[k] * linker for k in range(len(pos))]
    total = len(pos) + (len(windows) - 1) * linker
    chars = ["."] * total
    for i, j in layout_pairs:
        chars[offset[i]], chars[offset[j]] = "(", ")"
    coords = layout("".join(chars))
    partners = [-1] * len(pos)
    for i, j in inside:
        partners[i], partners[j] = j, i
    outside = [partner[p] if p in partner and partner[p] not in local else 0 for p in pos]
    counts = [0] * len(windows)
    between = 0
    for i, j in inside:
        if window[i] == window[j]:
            counts[window[i]] += 1
        else:
            between += 1
    outside_partners = [q for q in outside if q]
    return {
        "windows": [[s, e] for s, e in windows],
        "pos": pos, "window": window,
        "base": "".join(sequence[p - 1] for p in pos),
        "x": [coords[offset[k]][0] for k in range(len(pos))],
        "y": [coords[offset[k]][1] for k in range(len(pos))],
        "partner": partners, "outside": outside,
        "linker": [[coords[offset[k] + d][0], coords[offset[k] + d][1]]
                   for k in range(len(pos) - 1) if window[k + 1] != window[k] for d in range(1, linker + 1)],
        "pairs_in_window": counts,
        "inter_window_pairs": between,
        "not_drawn": len(inside) - len(layout_pairs),
        "bases_paired_outside": len(outside_partners),
        "outside_partners": runs(outside_partners),
        "outside_partners_text": runs_text(outside_partners),
    }


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def _number(raw: Dict[str, Any], key: str, low: float, high: float, integer: bool) -> Any:
    value = raw.get(key, DEFAULTS[key])
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ValueError(f"{key} must be a number between {low} and {high}")
    if integer:
        if int(value) != value:
            raise ValueError(f"{key} must be an integer")
        return int(value)
    return float(value)


def structure_regions(project: Path, request: Dict[str, Any]) -> Dict[str, Any]:
    project = Path(project).expanduser().resolve()
    comparison_id = request.get("comparison_id")
    if not isinstance(comparison_id, str) or not comparison_id:
        raise ValueError("comparison_id is required")
    ids = []
    for key in ("structure_one", "structure_two"):
        value = request.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"{key} is required")
        ids.append(value)
    padj = _number(request, "padj", 1e-300, 1.0, False)
    reach = _number(request, "reach", 0, 5000, True)
    flank = _number(request, "flank", 0, 1000, True)
    choice = request.get("choice") if isinstance(request.get("choice"), dict) else {}

    entry = comparison_entry(project, comparison_id)
    interactions = comparison_interactions(project, entry)
    gene_one, _ = group_gene(project, entry, "samples_one")
    gene_two, _ = group_gene(project, entry, "samples_two")
    folds = [read_fold(project, ids[0]), read_fold(project, ids[1])]
    aligner = Aligner(project)
    for fold in folds:
        aligner.sequences.setdefault(fold["gene_id"], fold["sequence"])
    gene_a = folds[0]["gene_id"]
    length_a = len(folds[0]["sequence"])
    two_on_a = aligner.map(folds[1]["gene_id"], gene_a)
    a_on_two = aligner.map(gene_a, folds[1]["gene_id"])
    on_a = [folds[0]["pairs"], move_pairs(folds[1]["pairs"], two_on_a)]
    cell_maps = [aligner.map(gene_one, gene_a), aligner.map(gene_two, gene_a)]
    labels = [entry.get("label_one") or "condition one", entry.get("label_two") or "condition two"]

    regions = []
    for k, direction in enumerate(("up", "down")):
        rows = ranked(interactions, direction, padj)
        found = candidates(rows, on_a[k], on_a[1 - k], cell_maps[k], reach)
        region: Dict[str, Any] = {"direction": direction, "enriched": k, "label": labels[k], "tested": len(rows),
                                  "candidates": [{key: value for key, value in c.items() if key != "hit"} for c in found],
                                  "chosen": None, "panels": []}
        if found:
            wanted = choice.get(direction)
            chosen = next((c for c in found if c["rank"] == wanted), found[0])
            region["chosen"] = chosen["rank"]
            windows = windows_of(chosen["hit"], flank, length_a)
            region["windows"] = [[s, e] for s, e in windows]
            for which in (k, 1 - k):
                fold = folds[which]
                own = windows if which == 0 else move_windows(windows, a_on_two)
                panel = cut(fold["sequence"], fold["partner"], own)
                panel.update({"structure": which, "structure_id": fold["id"], "gene_id": fold["gene_id"],
                              "enriched": which == k})
                region["panels"].append(panel)
        regions.append(region)
    return {
        "comparison": {"id": comparison_id, "label_one": labels[0], "label_two": labels[1],
                       "gene_one": gene_one, "gene_two": gene_two},
        "structures": [{"id": f["id"], "gene_id": f["gene_id"], "length": len(f["sequence"]), "pairs": len(f["pairs"]),
                        "energy": f["energy"]} for f in folds],
        "parameters": {"padj": padj, "reach": reach, "flank": flank, "linker": LINKER, "run_gap": RUN_GAP},
        "alignment": [map_note(source, target, m) for (source, target), m in aligner.maps.items()],
        "regions": regions,
    }

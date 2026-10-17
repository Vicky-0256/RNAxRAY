"""Final .hyb annotation: homopolymer filter, bit overlap, chimera type,
homodimer selection and summary statistics."""
from __future__ import annotations

import re
from typing import Dict, Iterable, List

from . import awk

_HOMOPOLYMER = re.compile("|".join(base * 15 for base in "ACGTacgt"))


def filter_homopolymers(lines: Iterable[str]) -> List[str]:
    """Port of ``filter_homopolymers.awk`` (any 15-nt run anywhere in the line)."""
    return [line for line in lines if not _HOMOPOLYMER.search(line)]


def _min(a: str, b: str) -> str:
    return a if awk.compare(a, b) < 0 else b


def _max(a: str, b: str) -> str:
    return a if awk.compare(a, b) > 0 else b


def add_overlaps(lines: Iterable[str]) -> List[str]:
    """Port of ``hyb_mapped_position_overlaps_3.awk``."""
    out = []
    for line in lines:
        f = awk.fields(line)
        get = lambda n: awk.field(f, n)
        if awk.compare(get(4), get(10)) == 0:
            value = 1 + awk.to_num(_min(get(8), get(14))) - awk.to_num(_max(get(7), get(13)))
            out.append(line + "\t" + awk.num_str(value))
        else:
            out.append(line + "\t.")
    return out


def add_chimera_types(lines: Iterable[str]) -> List[str]:
    """Port of ``hyb_chim_types.awk``; intramolecular rows matching no rule are dropped."""
    out = []
    for line in lines:
        f = awk.fields(line)
        get = lambda n: awk.field(f, n)
        same = awk.compare(get(4), get(10)) == 0
        c = lambda x, y: awk.compare(get(x), get(y))
        kind = None
        if same:
            rules = [
                ("Type_1", c(7, 13) < 0 and c(8, 13) < 0),
                ("Type_2", c(7, 14) > 0 and c(8, 14) > 0),
                ("Type_3", c(7, 13) < 0 and c(8, 13) > 0 and c(8, 14) < 0),
                ("Type_4", c(7, 13) < 0 and c(8, 14) == 0),
                ("Type_5", c(7, 13) < 0 and c(8, 14) > 0),
                ("Type_6", c(7, 13) == 0 and c(8, 14) > 0),
                ("Type_7", c(7, 14) < 0 and c(8, 14) > 0),
                ("Type_8", c(7, 13) == 0 and c(8, 14) == 0),
                ("Type_9", c(7, 13) > 0 and c(8, 14) == 0),
                ("Type_10", c(7, 13) == 0 and c(8, 14) < 0),
                ("Type_11", c(7, 13) > 0 and c(8, 14) < 0),
                ("Type_12", c(7, 13) < 0 and c(8, 13) == 0),
                ("Type_13", c(7, 14) == 0 and c(8, 14) > 0),
            ]
            kind = next((name for name, hit in rules if hit), None)
        else:
            kind = "Intermolecular"
        if kind:
            out.append(line + "\t" + kind)
    return out


def homodimers(lines: Iterable[str]) -> List[str]:
    """``awk '$16>=5'``: intramolecular hybrids whose bits overlap by >= 5 nt."""
    return [line for line in lines if awk.compare_const(awk.field(awk.fields(line), 16), 5) >= 0]


def _type_name(gene: str) -> str:
    last = awk.split(gene, r"\|")
    parts = awk.split(last[-1] if last else "", "_")
    return parts[-1] if parts else ""


def hybrid_stats(lines: Iterable[str]) -> List[str]:
    """Port of ``hybrid_stats_2`` (unsorted biotype pairs)."""
    collapsed: Dict[str, float] = {}
    total: Dict[str, float] = {}
    for line in lines:
        f = awk.fields(line)
        count = awk.split(awk.field(f, 1), "_")
        name = _type_name(awk.field(f, 4)) + ":" + _type_name(awk.field(f, 10))
        collapsed[name] = collapsed.get(name, 0) + 1
        total[name] = total.get(name, 0) + awk.to_num(count[1] if len(count) > 1 else "")
    rows = ["%s\t%s\t%s" % (name, awk.num_str(collapsed[name]), awk.num_str(total[name])) for name in collapsed]
    return ["type1:type2\tcollapsed\tall"] + awk.sort_numeric_desc_by_field2(rows)

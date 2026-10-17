"""BLAST-table stages: ``mtophits_blast`` and ``create_reference_file.pl``."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

from . import awk, extsort
from .collapse import iter_file


def mtophits(lines: Iterable[str]) -> List[str]:
    """Port of ``mtophits_blast``.  Note the original keeps a single global
    ``eval`` that is only refreshed on the first hit of each read."""
    count: Dict[str, int] = {}
    best = ""
    out: List[str] = []
    for line in lines:
        f = awk.fields(line)
        read_id = awk.field(f, 1)
        count[read_id] = count.get(read_id, 0) + 1
        if count[read_id] == 1:
            out.append(line)
            best = awk.field(f, 11)
        if count[read_id] != 1 and awk.compare(awk.field(f, 11), best) == 0:
            out.append(line)
    return out


_EXCLUDED = re.compile(r"_pr-tr|pseudo|different|all_hits")


def reference_ranking(lines: Sequence[str]) -> List[str]:
    """Port of ``create_reference_file.pl``: gene names ranked by sense read
    counts.  Perl iterated an unordered hash, so ties had no defined order;
    here ties keep first-seen order to stay deterministic."""
    total = 0.0
    seen = set()
    for line in lines:
        fld = awk.perl_split(line, "\t")
        if fld[0] not in seen:
            seen.add(fld[0])
            total += awk.to_num((awk.perl_split(fld[0], "_") or [""])[-1])
    counts: Dict[str, float] = {}
    for line in lines:
        fld = awk.perl_split(line, "\t")
        current = awk.to_num((awk.perl_split(fld[0], "_") or [""])[-1])
        if len(fld) > 9 and awk.to_num(fld[9]) > awk.to_num(fld[8]) and not _EXCLUDED.search(line):
            counts[fld[1]] = counts.get(fld[1], 0.0) + current
    ranked = sorted(counts, key=lambda name: -counts[name])
    return ["%s\t%s\t%s" % (name, awk.num_str(counts[name]), "%.15g" % (100 * counts[name] / total)) for name in ranked]


def ranking_file(collapsed: Path, tmp_dir: Path, memory_mb: float) -> List[str]:
    """``reference_ranking(mtophits(lines))`` over the file written by
    ``collapse.collapse_file`` from the BLAST table, with bounded memory.

    ``mtophits`` needs to know whether a line is the first of its read ID;
    an external sort of (read ID, line number) marks those lines in a bit
    set, then one pass replays ``mtophits`` (including its single global
    ``best``) and the ranking.  Only the gene order is used downstream, so
    the returned lines carry only the gene names.
    """
    def records():
        for number, line in enumerate(iter_file(collapsed)):
            yield "%s\0%012d" % (awk.field(awk.fields(line), 1), number)

    ordered = extsort.sort_records(records(), tmp_dir, memory_mb)
    first = extsort.BitSet(ordered.count)
    previous = None
    for record in ordered:
        read_id, number = record.rsplit("\0", 1)
        if read_id != previous:
            first.add(int(number))
            previous = read_id
    counts: Dict[str, float] = {}
    best = ""
    for number, line in enumerate(iter_file(collapsed)):
        f = awk.fields(line)
        if number in first:
            best = awk.field(f, 11)
        elif awk.compare(awk.field(f, 11), best) != 0:
            continue
        # create_reference_file.pl on a line mtophits kept
        fld = awk.perl_split(line, "\t")
        current = awk.to_num((awk.perl_split(fld[0], "_") or [""])[-1])
        if len(fld) > 9 and awk.to_num(fld[9]) > awk.to_num(fld[8]) and not _EXCLUDED.search(line):
            counts[fld[1]] = counts.get(fld[1], 0.0) + current
    return sorted(counts, key=lambda name: -counts[name])

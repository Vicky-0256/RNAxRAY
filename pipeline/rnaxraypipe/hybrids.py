"""Hybrid calling: ``get_mtop_hybrids.pl``, ``getseqs_sam`` + ``txt2hyb.awk``
and ``remove_duplicate_hybrids_hOH5_2.pl``."""
from __future__ import annotations

import re
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

from . import awk

_ANY_ALNUM = re.compile(r"[a-zA-Z0-9]")


def _overlap(a: float, b: float, c: float, d: float) -> float:
    return 1 + min(b, d) - max(a, c)


def mtop_hybrids(blast_lines: Iterable[str], *, blast_threshold: float = 0.1, mode: int = 2,
                 max_overlap: float = 4, max_hits: int = 10) -> List[str]:
    """Port of ``get_mtop_hybrids.pl`` with OUTPUT_FORMAT=HYB (header omitted)."""
    caller = MtopCaller(blast_threshold=blast_threshold, mode=mode, max_overlap=max_overlap, max_hits=max_hits)
    out: List[str] = []
    for line in blast_lines:
        out.extend(caller.feed(line))
    out.extend(caller.finish())
    return out


class MtopCaller:
    """``get_mtop_hybrids.pl`` as a streaming state machine.  The script only
    keeps the alignments of the current read (consecutive lines with the same
    read ID), so ``feed`` returns the hybrids of the previous read when a new
    one starts, and ``finish`` those of the last read."""

    def __init__(self, *, blast_threshold: float = 0.1, mode: int = 2, max_overlap: float = 4, max_hits: int = 10) -> None:
        self.blast_threshold, self.mode, self.max_overlap, self.max_hits = blast_threshold, mode, max_overlap, max_hits
        self.name: Optional[str] = None
        self.arr: List[str] = []
        self.min_start = self.max_end = 0.0
        self.curr_overlap = 0.0
        self.threshold = 0.0
        self.nbits = 0

    def _flush(self) -> List[str]:
        if self.nbits > 1 and len(self.arr) <= self.max_hits:
            rows = [(line, awk.perl_split(line, "\t")) for line in self.arr]
            rows.sort(key=lambda row: awk.to_num(row[1][6] if len(row[1]) > 6 else ""))
            return _hyb_format([fields for _, fields in rows], self.max_overlap)
        return []

    def feed(self, line: str) -> List[str]:
        out: List[str] = []
        fld = line.rstrip("\n").split("\t")
        f6, f7 = awk.to_num(fld[6]), awk.to_num(fld[7])
        evalue = awk.to_num(fld[10])
        if fld[0] != (self.name if self.name is not None else ""):
            out = self._flush()
            self.arr = []
            self.name = fld[0]
            self.min_start, self.max_end = f6, f7
            self.curr_overlap = 0.0
            self.threshold = 0.0
            self.nbits = 0
        else:
            self.curr_overlap = _overlap(self.min_start, self.max_end, f6, f7)
            if evalue <= self.blast_threshold:
                self.min_start = min(self.min_start, f6)
                self.max_end = max(self.max_end, f7)
        mode, max_overlap, curr_overlap = self.mode, self.max_overlap, self.curr_overlap
        if awk.to_num(fld[8]) > awk.to_num(fld[9]) and mode in (2, 3):
            return out
        if evalue <= self.threshold:
            self.arr.append(line)
        if evalue > self.blast_threshold:
            return out
        if mode in (0, 3) and curr_overlap > max_overlap:
            return out
        if mode in (1, 2) and (curr_overlap > max_overlap or curr_overlap < -max_overlap):
            return out
        self.nbits += 1
        if evalue != self.threshold:
            self.threshold = evalue
            self.arr.append(line)
        return out

    def finish(self) -> List[str]:
        out = self._flush()
        self.arr = []
        self.nbits = 0
        return out


def _hyb_format(rows: Sequence[List[str]], max_overlap: float) -> List[str]:
    def get(row: List[str], j: int) -> str:
        return row[j] if j < len(row) else ""

    out = []
    for i, x in enumerate(rows):
        for y in rows[i + 1:]:
            ovl = abs(_overlap(awk.to_num(get(x, 6)), awk.to_num(get(x, 7)), awk.to_num(get(y, 6)), awk.to_num(get(y, 7))))
            if ovl <= max_overlap:
                out.append("\t".join([get(x, 0), ".", ".", get(x, 1), get(x, 6), get(x, 7), get(x, 8), get(x, 9), get(x, 10),
                                      get(y, 1), get(y, 6), get(y, 7), get(y, 8), get(y, 9), get(y, 10)]))
    return out


def attach_sequences(hybrid_lines: Sequence[str], sam_lines: Iterable[str]) -> List[str]:
    """Port of ``getseqs_sam`` + ``txt2hyb.awk``: replace column 2 with the
    read sequence from the SAM file (the last alignment of a read wins)."""
    wanted = {awk.field(awk.fields(line), 1) for line in hybrid_lines}
    seq: Dict[str, str] = {}
    for line in sam_lines:
        f = awk.fields(line)
        key = awk.field(f, 1)
        if key in wanted:
            seq[key] = awk.field(f, 10)
    out = []
    for line in hybrid_lines:
        f = awk.fields(line)
        value = seq.get(awk.field(f, 1), "")
        if awk.truthy(value):
            out.append("".join((value if i == 1 else item) + "\t" for i, item in enumerate(f)))
    return out


def attach_sequence(hybrid_line: str, value: str) -> Optional[str]:
    """``attach_sequences`` for one hybrid whose read's last SAM SEQ is ``value``."""
    if not awk.truthy(value):
        return None
    return "".join((value if i == 1 else item) + "\t" for i, item in enumerate(awk.fields(hybrid_line)))


class _Hybrid:
    __slots__ = ("line", "seq_id", "bit1", "bit2", "evalue_sum")

    def __init__(self, line: str) -> None:
        cols = line.split("\t")
        get = lambda i: cols[i] if i < len(cols) else ""
        self.line = line
        self.seq_id = get(0)
        self.bit1 = cols[3] if len(cols) > 3 else None
        self.bit2 = cols[9] if len(cols) > 9 else None
        self.evalue_sum = awk.to_num(get(8)) + awk.to_num(get(14))

    def match(self, text: str) -> Optional[str]:
        if self.bit1 is not None and text in self.bit1:
            return self.bit1
        if self.bit2 is not None and text in self.bit2:
            return self.bit2
        return None


def remove_duplicate_hybrids(reference_lines: Sequence[str], hybrid_lines: Iterable[str], *, prefer_mim: bool = True) -> List[str]:
    """Port of ``remove_duplicate_hybrids_hOH5_2.pl``: one hybrid per read."""
    return list(iter_unique_hybrids(reference_lines, hybrid_lines, prefer_mim=prefer_mim))


def iter_unique_hybrids(reference_lines: Sequence[str], hybrid_lines: Iterable[str], *, prefer_mim: bool = True) -> Iterator[str]:
    """Streaming ``remove_duplicate_hybrids`` (keeps one read's lines at a time)."""
    rank: Dict[str, int] = {}
    for number, line in enumerate(reference_lines, 1):
        rank[line.split("\t")[0]] = number

    def ordered(x: Optional[str], y: Optional[str]) -> Tuple[Optional[int], Optional[int]]:
        rx, ry = rank.get(x) if x is not None else None, rank.get(y) if y is not None else None
        if rx is None and ry is None:
            return None, None
        if ry is None:
            return rx, None
        if rx is None:
            return ry, None
        return (rx, ry) if rx <= ry else (ry, rx)

    def better(x: _Hybrid, y: _Hybrid) -> _Hybrid:
        if x.evalue_sum != y.evalue_sum:
            return x if x.evalue_sum < y.evalue_sum else y
        if prefer_mim:
            x_mim = x.match("_mRNA") is not None and x.match("_microRNA") is not None
            y_mim = y.match("_mRNA") is not None and y.match("_microRNA") is not None
            if x_mim and not y_mim:
                return x
            if y_mim and not x_mim:
                return y
        x_top, x_bottom = ordered(x.bit1, x.bit2)
        y_top, y_bottom = ordered(y.bit1, y.bit2)
        for a, b in ((x_top, y_top), (x_bottom, y_bottom)):
            if a is not None and b is not None and a != b:
                return x if a < b else y
            if a is not None and b is None:
                return x
            if a is None and b is not None:
                return y
        return x

    group: List[_Hybrid] = []
    previous = ""
    for raw in hybrid_lines:
        line = raw.rstrip("\n")
        if line.startswith("#") or not _ANY_ALNUM.search(line):
            continue
        hit = _Hybrid(line)
        if hit.seq_id != previous:
            if group:
                yield _best(group, better).line
            group = []
            previous = hit.seq_id
        group.append(hit)
    if group:
        yield _best(group, better).line


def _best(group: List[_Hybrid], better) -> _Hybrid:
    best = group[0]
    for item in group[1:]:
        best = better(best, item)
    return best

"""Parsing of .hyb records, mirroring ``web/parser.worker.js``.

A rnaxray ``sam2hyb`` line has 18 TAB-separated columns::

    1 id (<read>_<count>)   2 sequence   3 dG or "."
    4 gene 1   5-6 read start/end   7-8 gene start/end   9 e-value
    10 gene 2  11-12 read start/end  13-14 gene start/end  15 e-value
    16 "" (txt2hyb.awk leaves it empty)  17 overlap score  18 chimera type

17-column files carry the overlap score and type in columns 16 and 17; older
15/16-column files have neither, and the type is inferred from coordinates.
"""
from __future__ import annotations

import re
from typing import NamedTuple, Optional

_DIGITS = re.compile(rb"^\d+$")


class Record(NamedTuple):
    gene1: bytes
    start1: int
    end1: int
    gene2: bytes
    start2: int
    end2: int
    reads: int          # raw read count from the id suffix, 0 when absent
    dg: Optional[float]
    overlap: Optional[float]
    chimera_type: bytes


def _coordinate(value: bytes) -> int:
    value = value.strip()
    if not _DIGITS.match(value):
        raise ValueError("coordinate")
    number = int(value)
    if number < 1:
        raise ValueError("coordinate")
    return number


def _optional_number(value: bytes) -> Optional[float]:
    value = value.strip()
    if not value or value == b".":
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if number == number and abs(number) != float("inf") else None


def raw_read_count(identifier: bytes) -> int:
    parts = identifier.strip().split(b"_")
    if len(parts) < 2 or not _DIGITS.match(parts[1]):
        return 0
    return int(parts[1])


def infer_type(g1: bytes, s1: int, e1: int, g2: bytes, s2: int, e2: int) -> bytes:
    """``inferChimeraType`` from the web parser."""
    if g1 != g2:
        return b"Intermolecular"
    if s1 < s2 and e1 < s2: return b"Type_1"
    if s1 > e2 and e1 > e2: return b"Type_2"
    if s1 < s2 and s2 < e1 < e2: return b"Type_3"
    if s1 < s2 and e1 == e2: return b"Type_4"
    if s1 < s2 and e1 > e2: return b"Type_5"
    if s1 == s2 and e1 > e2: return b"Type_6"
    if s1 < e2 and e1 > e2: return b"Type_7"
    if s1 == s2 and e1 == e2: return b"Type_8"
    if s1 > s2 and e1 == e2: return b"Type_9"
    if s1 == s2 and e1 < e2: return b"Type_10"
    if s1 > s2 and e1 < e2: return b"Type_11"
    if s1 < s2 and e1 == s2: return b"Type_12"
    if s1 == e2 and e1 > e2: return b"Type_13"
    return b"Unclassified intramolecular"


def _type_name(value: bytes) -> bytes:
    value = value.strip()
    return b"" if not value or value == b"." or value.lower() == b"na" else value


def parse(line: bytes) -> Optional[Record]:
    """Parse one line; ``None`` for blank/comment lines, ``ValueError`` if invalid."""
    line = line.rstrip(b"\r\n")
    if not line.strip() or line.lstrip().startswith(b"#"):
        return None
    cols = line.split(b"\t")
    if len(cols) < 15:
        raise ValueError("expected at least 15 tab-separated columns")
    g1, g2 = cols[3].strip(), cols[9].strip()
    if not g1 or not g2:
        raise ValueError("missing RNA name")
    s1, e1, s2, e2 = _coordinate(cols[6]), _coordinate(cols[7]), _coordinate(cols[12]), _coordinate(cols[13])
    if s1 > e1 or s2 > e2:
        raise ValueError("invalid RNA coordinates")
    overlap = None
    ctype = b""
    if len(cols) >= 18 and cols[15].strip() == b"":
        overlap, ctype = _optional_number(cols[16]), _type_name(cols[17])
    elif len(cols) >= 17:
        overlap, ctype = _optional_number(cols[15]), _type_name(cols[16])
    return Record(g1, s1, e1, g2, s2, e2, raw_read_count(cols[0]), _optional_number(cols[2]),
                  None if overlap is None else (int(overlap) if overlap.is_integer() else overlap),
                  ctype or infer_type(g1, s1, e1, g2, s2, e2))

"""Exact emulation of the awk / sort / perl behaviours the legacy shell
pipeline depends on.

The legacy ``sam2hyb`` output is only reproducible if a few implementation
details are copied faithfully:

* one-true-awk (macOS ``awk version 20200816``) iterates ``for (k in a)`` in
  hash-bucket order, and ``collapse_*`` keeps whichever line that order
  yields first;
* awk compares two fields numerically only when both look numeric;
* ``sort -kN`` compares the key from field N to end of line and, on ties,
  falls back to a byte-wise comparison of the whole line (C/C.UTF-8 locale).
"""
from __future__ import annotations

import re
from typing import Iterable, List, Sequence

_NUMBER = re.compile(r"^[ \t\n]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[ \t\n]*$")
_PREFIX = re.compile(r"^[ \t\n]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)")

# one-true-awk tran.c constants
_NSYMTAB = 50
_FULLTAB = 2
_GROWTAB = 4


def fields(line: str) -> List[str]:
    """awk default field splitting (runs of blanks/newlines separate fields)."""
    return line.split()


def field(parts: Sequence[str], n: int) -> str:
    """``$n`` for 1-based n; missing fields are empty strings."""
    return parts[n - 1] if 0 < n <= len(parts) else ""


def is_strnum(value: str) -> bool:
    return bool(_NUMBER.match(value))


def to_num(value: str) -> float:
    """awk/perl string-to-number: the longest numeric prefix, else 0."""
    match = _PREFIX.match(value)
    return float(match.group(0)) if match else 0.0


def compare(left: str, right: str) -> int:
    """awk comparison of two field values (strnum vs strnum is numeric)."""
    if is_strnum(left) and is_strnum(right):
        a, b = float(left), float(right)
    else:
        a, b = left, right
    return (a > b) - (a < b)


def compare_const(value: str, constant: float) -> int:
    """awk comparison of a field value with a numeric constant."""
    if is_strnum(value):
        a = float(value)
        return (a > constant) - (a < constant)
    other = num_str(constant)
    return (value > other) - (value < other)


def truthy(value: str) -> bool:
    if is_strnum(value):
        return float(value) != 0
    return value != ""


def num_str(value: float) -> str:
    """awk output conversion of a number (integers print as %d, else %.6g)."""
    if value == int(value) and abs(value) < 1e16:
        return "%d" % int(value)
    return "%.6g" % value


def split(text: str, sep: str) -> List[str]:
    """awk ``split(text, arr, sep)`` with a literal or regex separator."""
    if text == "":
        return []
    if len(sep) == 1 and sep != " ":
        return text.split(sep)
    return re.split(sep, text)


def substr(text: str, start: float, length: float | None = None) -> str:
    """awk ``substr`` with its 1-based, clipping semantics."""
    m = int(round(start))
    n_end = len(text) + 1 if length is None else m + int(round(length))
    m = max(m, 1)
    n_end = min(n_end, len(text) + 1)
    return text[m - 1:n_end - 1] if n_end > m else ""


def _hash(key: str, size: int) -> int:
    value = 0
    for ch in key.encode("utf-8"):
        value = (ch + 31 * value) & 0xFFFFFFFF
    return value % size


class BwkArray:
    """An awk associative array that iterates like one-true-awk."""

    def __init__(self) -> None:
        self.size = _NSYMTAB
        self.tab: List[List[str]] = [[] for _ in range(self.size)]
        self.values: dict = {}

    def __setitem__(self, key: str, value) -> None:
        if key not in self.values:
            if len(self.values) + 1 > _FULLTAB * self.size:
                self._grow()
            # new symbols are pushed on the head of their bucket chain
            self.tab[_hash(key, self.size)].insert(0, key)
        self.values[key] = value

    def __getitem__(self, key: str):
        return self.values[key]

    def __len__(self) -> int:
        return len(self.values)

    def _grow(self) -> None:
        size = _GROWTAB * self.size
        tab: List[List[str]] = [[] for _ in range(size)]
        for chain in self.tab:
            for key in chain:
                tab[_hash(key, size)].insert(0, key)
        self.size, self.tab = size, tab

    def keys(self) -> Iterable[str]:
        for chain in self.tab:
            yield from chain


def sort_key_from_field(line: str, n: int) -> str:
    """The text compared by ``sort -kN`` (field N with its leading blanks to EOL)."""
    pos, length = 0, len(line)
    for _ in range(n - 1):
        while pos < length and line[pos] in " \t":
            pos += 1
        while pos < length and line[pos] not in " \t":
            pos += 1
    return line[pos:]


def sort_lines_by_field(lines: Iterable[str], n: int) -> List[str]:
    """``LC_ALL=C sort -kN``: key, then whole line, both byte-wise."""
    return sorted(lines, key=lambda line: (sort_key_from_field(line, n).encode("utf-8"), line.encode("utf-8")))


def sort_numeric_desc_by_field2(lines: Iterable[str]) -> List[str]:
    """``sort -k 2nr`` for the small stats tables."""
    def key(line: str):
        return (-to_num(sort_key_from_field(line, 2)), line.encode("utf-8"))
    return sorted(lines, key=key)


def perl_split(text: str, sep: str) -> List[str]:
    """Perl ``split`` with a literal separator: trailing empty fields dropped."""
    parts = text.split(sep)
    while parts and parts[-1] == "":
        parts.pop()
    return parts

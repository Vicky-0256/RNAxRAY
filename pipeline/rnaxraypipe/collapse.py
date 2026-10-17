"""``collapse_blast_2.sh`` / ``collapse_hyb_2.sh``.

Both scripts only choose one representative line per key.  The read-count
arithmetic in the original is discarded by its own ``cut -f3-20``, so read IDs
are never changed; what matters is *which* line wins, and that depends on the
original's quirks (first line of each group dropped, one-true-awk hash order,
``sed -n 2p`` prepended, the last line re-emitted in END).
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional, Sequence, Tuple

from . import awk, extsort

KeyFn = Callable[[List[str]], Tuple[str, ...]]


def _tally_order(sorted_lines: Sequence[str], same: Callable[[List[str], Tuple[str, ...]], bool], key: KeyFn) -> List[str]:
    """Lines in the order the first awk program of the collapse scripts prints them."""
    emitted: List[str] = []
    group = awk.BwkArray()
    n = 0
    last: Tuple[str, ...] = ()
    for index, line in enumerate(sorted_lines):
        f = awk.fields(line)
        if index == 0:
            n = 0
            group["0"] = line
        if index > 0 and same(f, last):
            n += 1
            group[str(n)] = line
        else:
            for k in group.keys():
                emitted.append(group[k])
            n = 0
            group = awk.BwkArray()
        last = key(f)
    if sorted_lines:
        f = awk.fields(sorted_lines[-1])
        if awk.truthy(awk.field(f, 2)):
            emitted.append(sorted_lines[-1])
    return emitted


def _collapse(lines: Sequence[str], sort_field: int, key: KeyFn) -> List[str]:
    def same(f: List[str], last: Tuple[str, ...]) -> bool:
        current = key(f)
        return all(awk.compare(x, y) == 0 for x, y in zip(current, last))

    ordered = _tally_order(awk.sort_lines_by_field(lines, sort_field), same, key)
    # cut -f3-20 after prefixing two columns: the original line, at most 18 fields
    ordered = ["\t".join(line.split("\t")[:18]) for line in ordered]
    candidates = ordered[1:2] + ordered + list(lines)
    seen = set()
    result: List[str] = []
    for line in candidates:
        k = tuple(key(awk.fields(line)))
        if k not in seen:
            result.append(line)
        seen.add(k)
    return result


def collapse_blast(lines: Sequence[str]) -> List[str]:
    """Port of ``collapse_blast_2.sh`` (unique by gene and mapped sequence)."""
    return _collapse(lines, 13, lambda f: (awk.field(f, 2), awk.field(f, 13)))


def collapse_hyb(lines: Sequence[str]) -> List[str]:
    """Port of ``collapse_hyb_2.sh`` (unique by read sequence)."""
    return _collapse(lines, 2, lambda f: (awk.field(f, 2),))


def blast_key(f: List[str]) -> Tuple[str, ...]:
    return (awk.field(f, 2), awk.field(f, 13))


def hyb_key(f: List[str]) -> Tuple[str, ...]:
    return (awk.field(f, 2),)


class Irregular(Exception):
    """The input breaks an assumption of the streaming implementation; the
    caller falls back to the in-memory port for this step."""


def iter_file(path: Path) -> Iterator[str]:
    with open(path, "r", encoding="utf-8", newline="\n") as handle:
        for line in handle:
            yield line[:-1] if line.endswith("\n") else line


def collapse_file(src: Path, dst: Path, sort_field: int, key: KeyFn, tmp_dir: Path, memory_mb: float) -> int:
    """``_collapse`` over a file with bounded memory: writes exactly the lines
    ``_collapse(lines, sort_field, key)`` returns, and returns their count.

    ``_collapse`` emits ``ordered[1]``, then the first line per key in tally
    order (the lines sorted like ``sort -kN``), then, in input order, the
    first line of every key the tally order never emitted.  Every key ends
    with the field the sort starts at (the read sequence), so all lines of a
    key are adjacent after sorting ("blocks"); per-block bookkeeping decides
    which input lines survive and a bit set over input line numbers replays
    them in order.  Inputs that break this (checked) use the in-memory port.
    """
    try:
        return _collapse_file(src, dst, sort_field, key, tmp_dir, memory_mb)
    except Irregular:
        lines = list(iter_file(src))
        result = _collapse(lines, sort_field, key)
        with open(dst, "w", encoding="utf-8", newline="\n") as out:
            for line in result:
                out.write(line + "\n")
        return len(result)


def _collapse_file(src: Path, dst: Path, sort_field: int, key: KeyFn, tmp_dir: Path, memory_mb: float) -> int:
    def records() -> Iterator[str]:
        for number, line in enumerate(iter_file(src)):
            if "\0" in line:
                raise Irregular("NUL in line")
            yield "%s\0%s\0%012d" % (awk.sort_key_from_field(line, sort_field), line, number)

    ordered_sorted = extsort.sort_records(records(), tmp_dir, memory_mb)
    keep = extsort.BitSet(ordered_sorted.count)
    out = open(dst, "w", encoding="utf-8", newline="\n", buffering=1 << 20)
    written = 0
    # ordered part: ordered[1] first, then first line per key (keys never span blocks)
    first_emitted: List[Tuple[str, Tuple[str, ...]]] = []
    special: List[Tuple[str, ...]] = []
    seen: set = set()
    seen_block: List[Optional[str]] = [None]
    emitted_keys: Dict[str, set] = {}

    def write_ordered(cut: str, k: Tuple[str, ...]) -> None:
        nonlocal written, seen
        if special and k == special[0]:
            return
        if k[-1] != seen_block[0]:
            seen_block[0] = k[-1]
            seen = set()
        if k not in seen:
            seen.add(k)
            out.write(cut + "\n")
            written += 1

    emitted_count = 0

    def emit(line: str) -> None:
        nonlocal written, emitted_count
        cut = "\t".join(line.split("\t")[:18])
        k = tuple(key(awk.fields(cut)))
        emitted_keys.setdefault(k[-1], set()).add(k)
        emitted_count += 1
        if emitted_count == 1:
            first_emitted.append((cut, k))
        elif emitted_count == 2:
            out.write(cut + "\n")
            written += 1
            special.append(k)
            write_ordered(*first_emitted[0])
        else:
            write_ordered(cut, k)

    first_of_key: Dict[Tuple[str, ...], int] = {}

    def finish_block(value: Optional[str]) -> None:
        emitted = emitted_keys.pop(value, set())
        if emitted_keys:
            raise Irregular("lines of one key are not adjacent after sorting")
        for k, number in first_of_key.items():
            if k not in emitted:
                keep.add(number)
        first_of_key.clear()

    try:
        group = awk.BwkArray()
        n = 0
        last: Tuple[str, ...] = ()
        last_line = ""
        block: Optional[str] = None
        index = -1
        for index, record in enumerate(ordered_sorted):
            _, line, number = record.split("\0")
            f = awk.fields(line)
            k = tuple(key(f))
            new_block = index == 0 or k[-1] != block
            if index > 0 and new_block and (k[-1] + "\t") <= (block + "\t"):
                raise Irregular("blocks out of order")
            # the first awk program of the collapse scripts (see _tally_order)
            if index == 0:
                n = 0
                group["0"] = line
            if index > 0 and all(awk.compare(x, y) == 0 for x, y in zip(k, last)):
                if new_block:
                    raise Irregular("awk-equal keys in different blocks")
                n += 1
                group[str(n)] = line
            else:
                for g in group.keys():
                    emit(group[g])
                n = 0
                group = awk.BwkArray()
                if index > 0 and new_block:
                    finish_block(block)
            block = k[-1]
            number = int(number)
            prior = first_of_key.get(k)
            if prior is None or number < prior:
                first_of_key[k] = number
            last = k
            last_line = line
        if index >= 0:
            if awk.truthy(awk.field(awk.fields(last_line), 2)):
                emit(last_line)
            finish_block(block)
        if emitted_count == 1:
            write_ordered(*first_emitted[0])
        # input lines whose key never reached the ordered part, in input order
        for number, line in enumerate(iter_file(src)):
            if number in keep:
                out.write(line + "\n")
                written += 1
    finally:
        out.close()
        ordered_sorted.close()
    return written

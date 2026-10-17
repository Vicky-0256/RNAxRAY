"""Bounded-memory building blocks: external sort, bit sets, a Bloom filter.

Records are ``str`` without newlines and are ordered by plain ``str``
comparison.  Python compares strings by code point, which is the same order
as comparing their UTF-8 bytes, so callers that need ``sort``'s byte-wise
order encode their key into the record (``key + "\\0" + payload``) instead of
passing a key function; that keeps the merge in C.
"""
from __future__ import annotations

import heapq
import os
import shutil
import tempfile
from pathlib import Path
from typing import Iterable, Iterator, List, Optional

# CPython: a compact ASCII str costs 49 bytes + its length, plus a list slot.
_RECORD_OVERHEAD = 57
_FAN_IN = 64


def _read_run(path: Path) -> Iterator[str]:
    with open(path, "r", encoding="utf-8", newline="\n") as handle:
        for line in handle:
            yield line[:-1]


def _write_run(directory: Path, records: Iterable[str], number: int) -> Path:
    path = directory / ("run%06d" % number)
    with open(path, "w", encoding="utf-8", newline="\n", buffering=1 << 20) as handle:
        for record in records:
            handle.write(record)
            handle.write("\n")
    return path


class SortedRecords:
    """Iterate the sorted records once; temp files are removed when done or on ``close``."""

    def __init__(self, records: Iterable[str], tmp_dir: Path, memory_mb: float) -> None:
        self._dir: Optional[Path] = None
        self._tmp_dir = Path(tmp_dir)
        self._budget = max(1.0, memory_mb) * 2 ** 20
        self._runs: List[Path] = []
        self._memory: Optional[List[str]] = None
        self.count = 0
        self._spill(records)

    def _run_dir(self) -> Path:
        if self._dir is None:
            self._tmp_dir.mkdir(parents=True, exist_ok=True)
            self._dir = Path(tempfile.mkdtemp(prefix="sort-", dir=self._tmp_dir))
        return self._dir

    def _spill(self, records: Iterable[str]) -> None:
        chunk: List[str] = []
        size = 0
        budget = self._budget
        for record in records:
            chunk.append(record)
            size += len(record) + _RECORD_OVERHEAD
            if size >= budget:
                chunk.sort()
                self._runs.append(_write_run(self._run_dir(), chunk, len(self._runs)))
                self.count += len(chunk)
                chunk, size = [], 0
        chunk.sort()
        self.count += len(chunk)
        if not self._runs:
            self._memory = chunk
            return
        if chunk:
            self._runs.append(_write_run(self._run_dir(), chunk, len(self._runs)))
        del chunk
        # keep the final merge's fan-in bounded (open files, heap size)
        while len(self._runs) > _FAN_IN:
            merged: List[Path] = []
            for start in range(0, len(self._runs), _FAN_IN):
                group = self._runs[start:start + _FAN_IN]
                if len(group) == 1:
                    merged.append(group[0])
                    continue
                target = _write_run(self._run_dir(), heapq.merge(*[_read_run(p) for p in group]),
                                    10 ** 5 + len(merged) + start)
                for path in group:
                    path.unlink()
                merged.append(target)
            self._runs = merged

    def __iter__(self) -> Iterator[str]:
        try:
            if self._memory is not None:
                memory, self._memory = self._memory, []
                yield from memory
            else:
                yield from heapq.merge(*[_read_run(p) for p in self._runs])
        finally:
            self.close()

    def close(self) -> None:
        self._memory = None
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)
            self._dir = None


def sort_records(records: Iterable[str], tmp_dir: Path, memory_mb: float) -> SortedRecords:
    return SortedRecords(records, tmp_dir, memory_mb)


class BitSet:
    """A fixed-size bit set (one bit per line of a file)."""

    def __init__(self, size: int) -> None:
        self.bits = bytearray((size >> 3) + 1)

    def add(self, index: int) -> None:
        self.bits[index >> 3] |= 1 << (index & 7)

    def __contains__(self, index: int) -> bool:
        return bool(self.bits[index >> 3] & (1 << (index & 7)))


class Bloom:
    """A Bloom filter over strings: no false negatives, rare false positives.
    Uses Python's ``hash`` (salted per process), so it lives in one process."""

    def __init__(self, megabytes: float = 32, hashes: int = 3) -> None:
        self.size = int(megabytes * 2 ** 23)
        self.bits = bytearray((self.size >> 3) + 1)
        self.hashes = hashes

    def _indexes(self, key: str):
        value = hash(key) & 0xFFFFFFFFFFFFFFFF
        step = (value >> 32) | 1
        size = self.size
        for i in range(self.hashes):
            yield (value + i * step) % size

    def add(self, key: str) -> bool:
        """Add ``key``; returns True if it was (probably) present already."""
        present = True
        bits = self.bits
        for index in self._indexes(key):
            mask = 1 << (index & 7)
            if not bits[index >> 3] & mask:
                present = False
                bits[index >> 3] |= mask
        return present

    def __contains__(self, key: str) -> bool:
        bits = self.bits
        return all(bits[index >> 3] & (1 << (index & 7)) for index in self._indexes(key))


def free_tmp(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    elif path.exists():
        os.unlink(path)

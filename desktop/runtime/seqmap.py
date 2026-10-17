"""Positions of one RNA sequence on a related one by a banded global alignment.

A port of the app's Go package ``desktop/app/seqmap`` (same band, scores,
tie-breaking and traceback), so the Python panels move a structure or a
Compare cell from one reference onto another exactly as the Structure page
does.  The two references of a comparison are usually collinear with a few
indels (ZIKV African KX377335 vs French Polynesian KJ776791: one 1-nt indel
at 72), so a band of ``|len(a) - len(b)| + BAND`` around the diagonal holds the
optimal path.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

import numpy as np

BAND = 300
MAX_LENGTH = 400_000
MATCH, MISMATCH, GAP = 2, -1, -3
_NEG = -(1 << 40)
_VALID = _NEG // 2


@dataclass
class Map:
    """``to[i]`` is the 1-based position in the second sequence aligned to
    position ``i + 1`` of the first, 0 when it faces a gap."""

    to: List[int] = field(default_factory=list)
    identity: float = 0.0
    matches: int = 0
    mismatches: int = 0
    gaps: int = 0
    same: bool = False

    def pos(self, i: int) -> int:
        """Maps a 1-based position; 0 when it is unaligned or out of range."""
        if i < 1 or i > len(self.to):
            return 0
        return int(self.to[i - 1])

    def nearest(self, i: int, reach: int) -> int:
        """Maps a position to the closest aligned one within ``reach`` nt; 0 when none."""
        for d in range(reach + 1):
            p = self.pos(i - d)
            if p > 0:
                return p + d
            p = self.pos(i + d)
            if p > 0:
                return max(1, p - d)
        return 0


def identity_map(n: int) -> Map:
    return Map(to=list(range(1, n + 1)), identity=1.0, matches=n, same=True)


def _normalise(s: str) -> str:
    return s.upper().replace("T", "U")


def align(source: str, target: str) -> Map:
    """Maps ``source`` onto ``target`` (Go ``seqmap.Align``)."""
    a, b = _normalise(source), _normalise(target)
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        raise ValueError("empty sequence")
    if a == b:
        return identity_map(n)
    if n > MAX_LENGTH or m > MAX_LENGTH:
        raise ValueError("sequences longer than 400,000 nt are not aligned")
    w = BAND + abs(n - m)
    width = 2 * w + 2

    def lo(i: int) -> int:
        return max(0, i * m // n - w)

    def hi(i: int) -> int:
        return min(m, i * m // n + w)

    av = np.frombuffer(a.encode("ascii"), dtype=np.uint8)
    bv = np.frombuffer(b.encode("ascii"), dtype=np.uint8)
    trace = np.zeros((n + 1, width), dtype=np.uint8)  # 0 diagonal, 1 up, 2 left
    l0, h0 = lo(0), hi(0)
    prev = np.full(width, _NEG, dtype=np.int64)
    cols = np.arange(l0, h0 + 1, dtype=np.int64)
    prev[: len(cols)] = cols * GAP
    trace[0, : len(cols)] = 2
    prev_lo, prev_hi = l0, h0
    for i in range(1, n + 1):
        l, h = lo(i), hi(i)
        j = np.arange(l, h + 1, dtype=np.int64)
        count = len(j)
        base = np.full(count, _NEG, dtype=np.int64)
        direction = np.zeros(count, dtype=np.uint8)
        # diagonal from (i-1, j-1)
        jd = j - 1
        ok = (j > 0) & (jd >= prev_lo) & (jd <= prev_hi) & (jd - prev_lo < width)
        if ok.any():
            values = np.full(count, _NEG, dtype=np.int64)
            values[ok] = prev[jd[ok] - prev_lo]
            ok &= values > _VALID
            score = np.where(av[i - 1] == bv[np.clip(jd, 0, m - 1)], MATCH, MISMATCH)
            base = np.where(ok, values + score, base)
        # up from (i-1, j)
        ok = (j >= prev_lo) & (j <= prev_hi) & (j - prev_lo < width)
        if ok.any():
            values = np.full(count, _NEG, dtype=np.int64)
            values[ok] = prev[j[ok] - prev_lo]
            up = values + GAP
            take = ok & (values > _VALID) & (up > base)
            base = np.where(take, up, base)
            direction[take] = 1
        if l == 0:
            base[0] = i * GAP
            direction[0] = 1
        # left: cur[k] = max(base[k], cur[k-1] + GAP), taken only when strictly better
        k = np.arange(count, dtype=np.int64)
        cur = np.maximum.accumulate(base - k * GAP) + k * GAP
        cur = np.maximum(cur, base)
        left = np.full(count, _NEG, dtype=np.int64)
        left[1:] = cur[:-1] + GAP
        valid_left = np.zeros(count, dtype=bool)
        valid_left[1:] = cur[:-1] > _VALID
        take = valid_left & (left > base)
        cur = np.where(take, left, base)
        direction[take] = 2
        cur = np.where(cur > _VALID, cur, _NEG)
        trace[i, :count] = direction
        row = np.full(width, _NEG, dtype=np.int64)
        row[:count] = cur
        prev, prev_lo, prev_hi = row, l, h
    if m < lo(n) or m > hi(n):
        raise ValueError("alignment band does not reach the end")
    out = Map(to=[0] * n)
    i, j = n, m
    while i > 0 or j > 0:
        d = 2
        if i > 0 and lo(i) <= j <= hi(i):
            d = int(trace[i, j - lo(i)])
        elif i > 0:
            d = 1
        if i == 0:
            d = 2
        if j == 0 and i > 0:
            d = 1
        if d == 0:
            out.to[i - 1] = j
            if a[i - 1] == b[j - 1]:
                out.matches += 1
            else:
                out.mismatches += 1
            i, j = i - 1, j - 1
        elif d == 1:
            out.gaps += 1
            i -= 1
        else:
            out.gaps += 1
            j -= 1
    columns = out.matches + out.mismatches + out.gaps
    if columns:
        out.identity = out.matches / columns
    return out

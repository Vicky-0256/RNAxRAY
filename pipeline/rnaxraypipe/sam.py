"""SAM stages: ``sam_filt`` and ``sam2blast_3``."""
from __future__ import annotations

import re
from math import log
from typing import Iterable, Iterator, List, Optional

from . import awk


def sam_filt(lines: Iterable[str]) -> Iterator[str]:
    """Port of ``bin/sam_filt``: drop multi-splice reads, split single-splice
    reads into two alignments, and normalise read IDs."""
    a: List[str] = []
    n = 0
    id_parts: List[str] = []
    id_n = 0
    for raw in lines:
        line = raw.rstrip("\n")
        f = awk.fields(line)
        # awk 1: keep CIGARs with at most one N
        if len(awk.split(awk.field(f, 6), "N")) >= 3:
            continue
        # awk 2: splice splitting
        out: List[str] = []
        cigar = awk.field(f, 6)
        if "N" in cigar:
            a = awk.split(cigar, "N")
            n = len(a)
        b = awk.split(a[n - 2] if n >= 2 else "", "[A-Z]")
        m = len(b)
        c = awk.split(a[n - 1] if n >= 1 else "", "M")
        o = len(c)

        def at(arr: List[str], i: int) -> str:
            return arr[i - 1] if 1 <= i <= len(arr) else ""

        first = f[0] if f else ""
        if first.startswith("@") or "N" not in cigar:
            out.append(line)
        if not first.startswith("@") and "N" in cigar and "NM:i:" in line and "AS:i:" in line:
            flag = awk.field(f, 2)
            head = [awk.field(f, i) for i in range(1, 6)]
            tail = [awk.field(f, i) for i in range(7, 21)]
            cig1 = "0" + at(b, m - 2) + "S" + at(b, m - 1) + "M" + at(b, m) + "S" + at(c, o - 1) + "S" + at(c, o)
            cig2 = "0" + at(b, m - 2) + "S" + at(b, m - 1) + "S" + at(c, o - 1) + "M" + at(c, o)
            pos2 = awk.num_str(awk.to_num(awk.field(f, 4)) + awk.to_num(at(b, m)) + awk.to_num(at(b, m - 1)) + awk.to_num(at(b, m - 2)))
            flag_value = awk.to_num(flag)
            second_flag = None
            if awk.compare_const(flag, 16) <= 0 and awk.compare_const(flag, 4) != 0:
                second_flag = awk.num_str(flag_value + 256)
            elif awk.compare_const(flag, 256) >= 0 and awk.compare_const(flag, 272) <= 0:
                second_flag = awk.num_str(flag_value - 256)
            if second_flag is not None:
                out.append("\t".join(head[:5] + [cig1] + tail))
                out.append("\t".join([head[0], second_flag, head[2], pos2, head[4], cig2] + tail))
        # awk 3 + cut -f1,3-25 + sed: read ID normalisation
        for item in out:
            g = awk.fields(item)
            g1 = g[0] if g else ""
            if not g1.startswith("@"):
                id_parts = awk.split(g1, ":")
                id_n = len(id_parts)
            emitted: List[str] = []
            if g1.startswith("@") or ":" not in g1:
                emitted.append(g1 + "\t" + item)
            if ":" in g1 and awk.compare_const(awk.field(g, 2), 2048) < 0:
                def part(i: int) -> str:
                    return id_parts[i - 1] if 1 <= i <= len(id_parts) else ""
                emitted.append(part(id_n - 2) + "-" + part(id_n - 1) + "-" + part(id_n) + "_1" + "\t" + item)
            for value in emitted:
                cols = value.split("\t")
                if len(cols) > 1:
                    value = "\t".join([cols[0]] + cols[2:25])
                yield _fix_read_id(value)


_ID_SEP = re.compile(r"^([^\s]*)[/.]([^\s]*)")


def _fix_read_id(line: str) -> str:
    return _ID_SEP.sub(r"\1_\2", line, count=1)


def sam2blast(lines: Iterable[str]) -> Iterator[str]:
    """Port of ``bin/sam2blast_3``.  The reference length is the running sum of
    ``@SQ LN`` headers seen so far, exactly as the original computed it."""
    dblen = 0
    for line in lines:
        li = line.strip()
        if not li.startswith("@"):
            arr = li.split()
            flag = int(arr[1])
            if flag in (0, 256):
                yield _blast_line_fast(arr, "f", dblen)
            elif flag in (16, 272):
                yield _blast_line_fast(arr, "r", dblen)
            elif flag == 4:
                pass
            else:
                raise ValueError("unknown SAM flag %s" % arr[1])
        elif li.startswith("@SQ"):
            dblen += int(li.split("LN:")[1])


_CIGAR_OP = re.compile(r"(\d+)([MISHD])")
_CIGAR_FULL = re.compile(r"(?:\d+[MISHD])+")


def blast_row(arr: List[str], dblen: int) -> Optional[str]:
    """One ``sam2blast_3`` row for a split SAM line (None for unmapped)."""
    flag = int(arr[1])
    if flag in (0, 256):
        return _blast_line_fast(arr, "f", dblen)
    if flag in (16, 272):
        return _blast_line_fast(arr, "r", dblen)
    if flag == 4:
        return None
    raise ValueError("unknown SAM flag %s" % arr[1])


def _blast_line_fast(arr: List[str], flag: str, dblen: int) -> str:
    """``_blast_line`` without expanding the CIGAR base by base; any CIGAR
    other than plain ``(\\d+[MISHD])+`` goes through ``_blast_line``."""
    cigar = arr[5]
    if not _CIGAR_FULL.fullmatch(cigar):
        return _blast_line(arr, flag, dblen)
    len_read = ref_len = gaps = 0
    lead = trail = 0  # soft/hard clipped bases before the first / after the last aligned base
    aligned = False
    for count_text, op in _CIGAR_OP.findall(cigar):
        count = int(count_text)
        if op == "M" or op == "I":
            len_read += count
            if op == "M":
                ref_len += count
            else:
                gaps += 1
            if count:
                aligned = True
                trail = 0
        elif op == "D":
            ref_len += count
            gaps += 1
        else:
            len_read += count
            if aligned:
                trail += count
            else:
                lead += count
    if aligned:
        align_start, align_end = lead, len_read - trail
    else:
        align_start, align_end = len_read, 0
    len_align = align_end - align_start
    ref_start = int(arr[3])
    if flag == "f":
        ref_end = ref_start + ref_len - 1
    else:
        ref_end = ref_start
        ref_start = ref_start + ref_len - 1
        align_start, align_end = len_read - align_end, len_read - align_start
    mismatches = int([x for x in arr if x.startswith("NM:i:")][0].split("NM:i:")[1])
    identity = ((abs(align_end - align_start) - mismatches) / float(len_align)) * 100
    align_score = int(re.split(r"AS:i:", [x for x in arr if x.startswith("AS:i:")][0])[1])
    n, m = dblen, len_read
    np_ = n - log(0.46 * n * m) / 0.85
    mp = m - log(0.46 * n * m) / 0.85
    if mp < 0:
        mp = 0.1
    bit_score = ((1.28 * float(align_score)) - log(0.46)) / log(2)
    evalue = mp * np_ * 2 ** -bit_score
    return "%s\t%s\t%.2f\t%i\t%i\t%i\t%i\t%i\t%i\t%i\t%.2g\t%.1f\t%s" % (
        arr[0], arr[2], identity, len_align, mismatches, gaps, align_start + 1,
        align_end, ref_start, ref_end, evalue, bit_score, arr[9])


def _blast_line(arr: List[str], flag: str, dblen: int) -> str:
    cigar: List[int] = []
    gaps = 0
    numbers = re.findall(r"\d+", arr[5])
    ops = re.findall(r"\D", arr[5])
    ref_len = 0
    for i, op in enumerate(ops):
        count = int(numbers[i])
        if op == "M":
            cigar.extend([1] * count)
            ref_len += count
        elif op == "I":
            cigar.extend([1] * count)
            gaps += 1
        elif op in ("S", "H"):
            cigar.extend([0] * count)
        elif op == "D":
            ref_len += count
            gaps += 1
        else:
            raise ValueError("unknown cigar operator %s" % op)
    len_read = len(cigar)
    align_start, align_end = 0, len_read
    for x in cigar:
        if x == 1:
            break
        align_start += 1
    for x in reversed(cigar):
        if x == 1:
            break
        align_end -= 1
    len_align = align_end - align_start
    ref_start = int(arr[3])
    if flag == "f":
        ref_end = ref_start + ref_len - 1
    else:
        ref_end = ref_start
        ref_start = ref_start + ref_len - 1
        align_start, align_end = len_read - align_end, len_read - align_start
    mismatches = int([x for x in arr if x.startswith("NM:i:")][0].split("NM:i:")[1])
    identity = ((abs(align_end - align_start) - mismatches) / float(len_align)) * 100
    align_score = int(re.split(r"AS:i:", [x for x in arr if re.search(r"^AS:i:", x)][0])[1])
    lam, k, h, n, m = 1.28, 0.46, 0.85, dblen, len_read
    np_ = n - log(k * n * m) / h
    mp = m - log(k * n * m) / h
    if mp < 0:
        mp = 0.1
    bit_score = ((lam * float(align_score)) - log(k)) / log(2)
    evalue = mp * np_ * 2 ** -bit_score
    return "%s\t%s\t%.2f\t%i\t%i\t%i\t%i\t%i\t%i\t%i\t%.2g\t%.1f\t%s" % (
        arr[0], arr[2], identity, len_align, mismatches, gaps, align_start + 1,
        align_end, ref_start, ref_end, evalue, bit_score, arr[9])

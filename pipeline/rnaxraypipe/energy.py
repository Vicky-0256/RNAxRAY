"""Optional folding energy (``sam2hyb -e 1``): ``rnaxrayfasta_bits_allRNAs.awk``,
``RNAcofold`` and ``add_dG_hyb_2.pl``.

Deliberate fix: the legacy ``sed 's/ /\\t/g'`` turned RNAcofold's ``( -9.50)``
into a dG value with an embedded TAB, shifting every later column for
|dG| < 10.  Here dG is always written as a plain ``%.2f`` number.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from . import awk

Folder = Callable[[Sequence[Tuple[str, str]]], List[Optional[float]]]


class EnergyUnavailable(RuntimeError):
    pass


def reference_table(fasta_lines: Iterable[str]) -> Dict[str, str]:
    """``fasta2tab.awk`` followed by awk ``seq[$1] = $2`` (first header word)."""
    rows: List[List[str]] = []
    for raw in fasta_lines:
        line = raw.rstrip("\n")
        if line.startswith("#") or line == "":
            continue
        if line.startswith(">"):
            rows.append([line[1:] + "\t"])
        elif rows:
            rows[-1].append(line)
    table: Dict[str, str] = {}
    for row in rows:
        f = awk.fields("".join(row))
        table[awk.field(f, 1)] = awk.field(f, 2)
    return table


def bit_pairs(hyb_lines: Iterable[str], table: Dict[str, str]) -> List[Tuple[str, str, str]]:
    """(energy_key, bit1_seq, bit2_seq) for every sense/sense hybrid."""
    return [pair for pair in (bit_pair(line, table) for line in hyb_lines) if pair is not None]


def bit_pair(line: str, table: Dict[str, str]) -> Optional[Tuple[str, str, str]]:
    f = awk.fields(line)
    get = lambda n: awk.field(f, n)
    if awk.compare(get(8), get(7)) < 0 or awk.compare(get(14), get(13)) < 0:
        return None
    s1 = awk.substr(table.get(get(4), ""), awk.to_num(get(7)), 1 + awk.to_num(get(8)) - awk.to_num(get(7)))
    s2 = awk.substr(table.get(get(10), ""), awk.to_num(get(13)), 1 + awk.to_num(get(14)) - awk.to_num(get(13)))
    return (pair_key(f), s1, s2)


def pair_key(f: List[str]) -> str:
    # add_dG keys energies by the first two '_'-separated parts of the bit name
    key = _PAIR_KEY.match("%s_%s_%s_%s" % (awk.field(f, 1), awk.field(f, 4), awk.field(f, 7), awk.field(f, 8)))
    return key.group(1) if key else ""


_PAIR_KEY = re.compile(r"^([^_]*_[^_]*)")
_SIMPLE_ID = re.compile(r"[^_]*_[^_]*")
_ALNUM = re.compile(r"[a-zA-Z0-9]")
_DIGIT = re.compile(r"[0-9]")


def _passthrough(cols: List[str]) -> bool:
    return cols[0].startswith("#") or not _ALNUM.search(cols[0])


def _with_dg(cols: List[str], value: str) -> str:
    if len(cols) < 3:
        cols += [""] * (3 - len(cols))
    cols[2] = value if _DIGIT.search(value) else "."
    return "\t".join(cols)


def add_energies_file(src: Path, dst: Path, fasta_lines: Iterable[str], tmp_dir: Path, folder: Optional[Folder] = None,
                      workers: Optional[int] = None, chunk: int = 50000) -> None:
    """``add_energies`` over a file, folding ``chunk`` hybrids at a time.

    ``add_energies`` looks dG up by the whole read ID in a table keyed by
    the first two '_'-parts of each pair's name, the last pair winning.  A
    line can only receive its own pair's dG unless keys repeat or cross
    between lines; a first pass with a Bloom filter finds such keys
    (``shared``) and only those go through an exact global table.
    """
    from .collapse import iter_file
    from .extsort import Bloom

    folder = folder or default_folder(workers)
    table = reference_table(fasta_lines)
    seen = Bloom(16)
    shared = set()
    for line in iter_file(src):
        cols = line.split("\t")
        f = awk.fields(line)
        lookup = None if _passthrough(cols) else cols[0]
        own = pair_key(f) if not (awk.compare(awk.field(f, 8), awk.field(f, 7)) < 0
                                  or awk.compare(awk.field(f, 14), awk.field(f, 13)) < 0) else None
        if lookup is not None and _SIMPLE_ID.fullmatch(lookup):
            if seen.add(lookup):
                shared.add(lookup)
        if own is not None and own != lookup and seen.add(own):
            shared.add(own)
    shared_dg: Dict[str, str] = {}
    staged = Path(str(dst) + ".stage") if shared else dst
    with open(staged, "w", encoding="utf-8", newline="\n") as out:
        def flush(lines: List[str]) -> None:
            pairs = [bit_pair(line, table) for line in lines]
            energies = iter(folder([(p[1], p[2]) for p in pairs if p is not None]))
            for line, pair in zip(lines, pairs):
                value = next(energies) if pair is not None else None
                own = "" if value is None else "%.2f" % value
                if pair is not None and value is not None and pair[0] in shared:
                    shared_dg[pair[0]] = own
                cols = line.split("\t")
                if shared:
                    out.write("%s\0%s\0%s\n" % (pair[0] if pair is not None else "", own, line))
                elif _passthrough(cols):
                    out.write(line + "\n")
                else:
                    # not shared: dg[cols[0]] exists only as this line's own pair
                    out.write(_with_dg(cols, own if pair is not None and pair[0] == cols[0] else "") + "\n")

        batch: List[str] = []
        for line in iter_file(src):
            batch.append(line)
            if len(batch) >= chunk:
                flush(batch)
                batch = []
        flush(batch)
    if not shared:
        return
    with open(dst, "w", encoding="utf-8", newline="\n") as out:
        for record in iter_file(staged):
            key, own, line = record.split("\0", 2)
            cols = line.split("\t")
            if _passthrough(cols):
                out.write(line + "\n")
            elif cols[0] in shared:
                out.write(_with_dg(cols, shared_dg.get(cols[0], "")) + "\n")
            else:
                out.write(_with_dg(cols, own if key == cols[0] else "") + "\n")
    staged.unlink()


def _vienna_chunk(pairs: Sequence[Tuple[str, str]]) -> List[float]:
    import RNA  # type: ignore
    return [RNA.fold_compound(a + "&" + b).mfe_dimer()[1] for a, b in pairs]


def default_folder(workers: Optional[int] = None) -> Folder:
    """ViennaRNA Python bindings (spread over ``workers`` processes, default one
    per CPU), else an
    ``RNAcofold`` executable.  Each pair folds independently, so the result
    does not depend on the number of workers."""
    try:
        import RNA  # type: ignore  # noqa: F401

        def fold(pairs):
            pairs = list(pairs)
            # ~6.9x faster with 8 workers on 3000 pairs (10-core Mac), output unchanged.
            count = max(1, min(workers or os.cpu_count() or 1, len(pairs) // 200 or 1))
            if count == 1:
                return _vienna_chunk(pairs)
            size = -(-len(pairs) // (count * 4))
            chunks = [pairs[i:i + size] for i in range(0, len(pairs), size)]
            with ProcessPoolExecutor(max_workers=count) as pool:
                return [value for chunk in pool.map(_vienna_chunk, chunks) for value in chunk]
        return fold
    except ImportError:
        pass
    exe = shutil.which("RNAcofold")
    if exe:
        def fold(pairs):
            if not pairs:
                return []
            text = "".join(">p%d\n%s&%s\n" % (i, a, b) for i, (a, b) in enumerate(pairs))
            done = subprocess.run([exe, "--noconv", "--noPS"], input=text, capture_output=True, text=True, check=True)
            values = [float(m) for m in re.findall(r"\(\s*(-?\d+\.\d+)\)\s*$", done.stdout, re.M)]
            if len(values) != len(pairs):
                raise EnergyUnavailable("RNAcofold returned %d energies for %d pairs" % (len(values), len(pairs)))
            return values
        return fold
    raise EnergyUnavailable("folding energy needs the ViennaRNA Python package or RNAcofold on PATH")


def add_energies(hyb_lines: Sequence[str], fasta_lines: Iterable[str], folder: Optional[Folder] = None,
                 workers: Optional[int] = None) -> List[str]:
    folder = folder or default_folder(workers)
    pairs = bit_pairs(hyb_lines, reference_table(fasta_lines))
    energies = folder([(a, b) for _, a, b in pairs])
    dg: Dict[str, str] = {}
    for (key, _, _), value in zip(pairs, energies):
        if value is not None:
            dg[key] = "%.2f" % value
    out = []
    for line in hyb_lines:
        cols = line.split("\t")
        if cols[0].startswith("#") or not re.search(r"[a-zA-Z0-9]", cols[0]):
            out.append(line)
            continue
        value = dg.get(cols[0], "")
        if len(cols) < 3:
            cols += [""] * (3 - len(cols))
        cols[2] = value if re.search(r"[0-9]", value) else "."
        out.append("\t".join(cols))
    return out

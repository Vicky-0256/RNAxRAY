"""Port of ``bin/rnaxray_coverage`` (single gene, no zoom): contact.txt and forTable.

``rnaxray_coverage -i X.hyb -a GENE`` runs::

    plot_hybrids_3.awk USE_ENTIRE_HYBRIDS=1 BIN_SIZE=10 GENE_1=GENE GENE_2=GENE X.hyb \
        | sed '2s/^/x\\ty\\tcount\\n/' > X.GENE.contact.txt

and ``rnaxray_compare`` later derives ``X.GENE.forTable.txt`` from it with::

    sort -k3,3nr X.GENE.contact.txt | awk -v a=NAME '!/^#/{print $1 "_" $2 "\\t" a "=" $3}'

The awk script counts, for every hybrid with ``$4 == $10 == GENE``, each
10 x 10 nt cell covered by arm 1 (``$7..$8``) x arm 2 (``$13..$14``) and prints
the cells in one-true-awk ``for (k in a)`` order (``/usr/bin/awk`` on macOS).
That order depends only on the order in which cells were first touched, so the
port records each cell's first touch and replays the hash table at the end.

The fast path streams the file in chunks with numpy and keeps two dense
cell grids (count and first touch); memory is bounded by the gene length, not
by the number of hybrids.  Unusual input (negative or non-integer
coordinates, genes too long for a dense grid) falls back to an exact
line-by-line port built on :class:`rnaxraypipe.awk.BwkArray`'s rules.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import BinaryIO, Iterable, List, Optional, Tuple, Union

import numpy as np

PathLike = Union[str, "os.PathLike[str]"]

BIN_SIZE = 10
_CHUNK = 16384
_MAX_GRID_CELLS = 64_000_000  # about 1 GB for the two grids; beyond this use the exact fallback
_NO_TOUCH = np.iinfo(np.int64).max

# one-true-awk tran.c constants (see rnaxraypipe.awk)
_NSYMTAB = 50
_FULLTAB = 2
_GROWTAB = 4


class _Fallback(Exception):
    pass


def contact_path(hyb: PathLike, gene_id: str) -> Path:
    """``${HYB/.hyb/.GENE.contact.txt}`` (bash replaces the first ``.hyb``)."""
    text = str(hyb)
    return Path(text.replace(".hyb", "." + gene_id + ".contact.txt", 1))


# --------------------------------------------------------------------------
# awk number semantics for the few values we read


def _awk_num(value: bytes) -> float:
    from rnaxraypipe import awk  # local import: rnaxraypipe sits next to this package
    return awk.to_num(value.decode("utf-8", "replace"))


def _awk_bin(value: bytes) -> int:
    """``BIN_SIZE * int($n / BIN_SIZE)`` (awk int() truncates toward zero)."""
    try:
        number = int(value)
    except ValueError:
        number = _awk_num(value)
        quotient = number / BIN_SIZE
        return BIN_SIZE * int(quotient)
    quotient = abs(number) // BIN_SIZE
    return BIN_SIZE * (quotient if number >= 0 else -quotient)


# --------------------------------------------------------------------------
# one-true-awk iteration order


def _hash_keys(keys: List[bytes]) -> np.ndarray:
    """tran.c ``hash()`` before the modulo, for every key (unsigned 32 bit)."""
    if not keys:
        return np.zeros(0, dtype=np.uint64)
    width = max(len(key) for key in keys)
    lengths = np.fromiter((len(key) for key in keys), dtype=np.int64, count=len(keys))
    chars = np.frombuffer(b"".join(key.ljust(width, b"\0") for key in keys), dtype=np.uint8).reshape(len(keys), width)
    value = np.zeros(len(keys), dtype=np.uint64)
    for column in range(width):
        active = lengths > column
        updated = (chars[:, column].astype(np.uint64) + np.uint64(31) * value) & np.uint64(0xFFFFFFFF)
        value = np.where(active, updated, value)
    return value


def bwk_order(hashes: np.ndarray) -> np.ndarray:
    """Iteration order of a one-true-awk array whose keys were inserted in order.

    ``hashes[k]`` is the unsigned hash of the k-th inserted key.  New keys are
    pushed on the head of their bucket chain; when the element count exceeds
    ``FULLTAB * size`` the table grows ``GROWTAB``-fold and is rehashed by
    walking the old buckets in order and pushing each key on its new chain.
    Returns the insertion indices in ``for (k in a)`` order.
    """
    total = len(hashes)
    if total == 0:
        return np.zeros(0, dtype=np.int64)
    index = np.arange(total, dtype=np.int64)
    rank = np.zeros(total, dtype=np.int64)
    size, start = _NSYMTAB, 0
    while True:
        end = min(total, _FULLTAB * size)
        present = index[:end]
        bucket = (hashes[:end] % np.uint64(size)).astype(np.int64)
        old = present < start
        # chain order: keys inserted in this epoch (newest first), then the
        # rehashed keys in reverse of the previous traversal
        secondary = np.where(old, -rank[:end], -present)
        order = np.lexsort((secondary, old, bucket))
        if end == total:
            return order
        rank[order] = np.arange(end, dtype=np.int64)
        start, size = end, size * _GROWTAB


# --------------------------------------------------------------------------
# fast path


def _iter_matching(handle: BinaryIO, gene: bytes):
    """Yield (s1, e1, s2, e2) byte fields of hybrids with $4 == $10 == gene."""
    for line in handle:
        parts = line.split(None, 14)
        if len(parts) < 14 or parts[3] != gene or parts[9] != gene:
            continue
        yield parts[6], parts[7], parts[12], parts[13]


def _count_dense(path: PathLike, gene: bytes):
    """Return (x, y, count, first_touch) arrays for the touched cells, in bin units."""
    rows = cols = 0
    counts = np.zeros((0, 0), dtype=np.int64)
    first = np.zeros((0, 0), dtype=np.int64)
    position = 0  # running index of cell increments, i.e. awk's touch order

    def grow(need_rows: int, need_cols: int):
        nonlocal rows, cols, counts, first
        if need_rows <= rows and need_cols <= cols:
            return
        new_rows = max(need_rows, rows + rows // 2, 64)
        new_cols = max(need_cols, cols + cols // 2, 64)
        if new_rows * new_cols > _MAX_GRID_CELLS:
            raise _Fallback("gene too long for a dense grid")
        new_counts = np.zeros((new_rows, new_cols), dtype=np.int64)
        new_first = np.full((new_rows, new_cols), _NO_TOUCH, dtype=np.int64)
        new_counts[:rows, :cols] = counts
        new_first[:rows, :cols] = first
        rows, cols, counts, first = new_rows, new_cols, new_counts, new_first

    def flush(batch: List[Tuple[int, int, int, int]]):
        nonlocal position
        arr = np.asarray(batch, dtype=np.int64)
        if arr.min() < 0:
            raise _Fallback("negative coordinates")
        a, b, e, f = (arr[:, k] // BIN_SIZE for k in range(4))
        na = np.maximum(b - a + 1, 0)
        ne = np.maximum(f - e + 1, 0)
        cells = na * ne
        keep = cells > 0
        if not keep.any():
            return
        a, b, e, f, na, ne, cells = a[keep], b[keep], e[keep], f[keep], na[keep], ne[keep], cells[keep]
        grow(int(b.max()) + 1, int(f.max()) + 1)
        total = int(cells.sum())
        owner = np.repeat(np.arange(len(cells)), cells)
        offset = np.arange(total, dtype=np.int64) - np.repeat(np.cumsum(cells) - cells, cells)
        x = a[owner] + offset // ne[owner]
        y = e[owner] + offset % ne[owner]
        flat = x * cols + y
        counts.reshape(-1)[:] += np.bincount(flat, minlength=rows * cols)
        first_flat = first.reshape(-1)
        fresh = first_flat[flat] == _NO_TOUCH
        if fresh.any():
            where = np.flatnonzero(fresh)
            uniq, idx = np.unique(flat[where], return_index=True)
            first_flat[uniq] = position + where[idx]
        position += total

    batch: List[Tuple[int, int, int, int]] = []
    with open(path, "rb") as handle:
        for s1, e1, s2, e2 in _iter_matching(handle, gene):
            try:
                batch.append((int(s1), int(e1), int(s2), int(e2)))
            except ValueError:
                raise _Fallback("non-integer coordinates")
            if len(batch) >= _CHUNK:
                flush(batch)
                batch = []
        if batch:
            flush(batch)
    touched = np.flatnonzero(first.reshape(-1) != _NO_TOUCH) if rows else np.zeros(0, dtype=np.int64)
    x, y = (touched // cols, touched % cols) if rows else (touched, touched)
    return x, y, counts.reshape(-1)[touched], first.reshape(-1)[touched]


def _contact_lines_fast(path: PathLike, gene: bytes) -> Iterable[bytes]:
    x, y, count, first = _count_dense(path, gene)
    insertion = np.argsort(first, kind="stable")
    x, y, count = x[insertion] * BIN_SIZE, y[insertion] * BIN_SIZE, count[insertion]
    keys = [b"%d\t%d" % pair for pair in zip(x.tolist(), y.tolist())]
    order = bwk_order(_hash_keys(keys))
    counts = count.tolist()
    return (keys[k] + b"\t%d" % counts[k] for k in order.tolist())


# --------------------------------------------------------------------------
# exact fallback: line-by-line port of plot_hybrids_3.awk


def _contact_lines_reference(path: PathLike, gene: bytes) -> Iterable[bytes]:
    order: dict = {}
    with open(path, "rb") as handle:
        for line in handle:
            parts = line.split()
            field = lambda n: parts[n - 1] if n <= len(parts) else b""  # noqa: E731
            if field(4) != gene or field(10) != gene:
                continue
            a, b, e, f = (_awk_bin(field(n)) for n in (7, 8, 13, 14))
            for i in range(a, b + 1, BIN_SIZE) if b >= a else ():
                for j in range(e, f + 1, BIN_SIZE) if f >= e else ():
                    key = b"%d\t%d" % (i, j)
                    order[key] = order.get(key, 0) + 1
    keys = list(order)
    return (keys[k] + b"\t%d" % order[keys[k]] for k in bwk_order(_hash_keys(keys)).tolist())


def contact_lines(hyb: PathLike, gene_id: str, *, exact_fallback_only: bool = False) -> Iterable[bytes]:
    """The ``x<TAB>y<TAB>count`` lines of contact.txt, in legacy order."""
    gene = gene_id.encode("utf-8")
    if not exact_fallback_only:
        try:
            return _contact_lines_fast(hyb, gene)
        except _Fallback:
            pass
    return _contact_lines_reference(hyb, gene)


def _atomic_writer(out: Path):
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + out.name + ".", suffix=".tmp", dir=str(out.parent))
    return os.fdopen(fd, "wb", buffering=1 << 20), Path(tmp)


def write_contact(hyb: PathLike, gene_id: str, out: Optional[PathLike] = None) -> Path:
    """Write ``<hyb>.<gene_id>.contact.txt`` byte-identical to ``rnaxray_coverage``."""
    target = Path(out) if out is not None else contact_path(hyb, gene_id)
    handle, tmp = _atomic_writer(target)
    try:
        with handle:
            handle.write(b"# hybrids between %s and %s\n" % (gene_id.encode("utf-8"), gene_id.encode("utf-8")))
            first = True
            for line in contact_lines(hyb, gene_id):
                if first:  # sed '2s/^/x\ty\tcount\n/' only fires when there is a line 2
                    handle.write(b"x\ty\tcount\n")
                    first = False
                handle.write(line + b"\n")
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return target


def for_table_name(contact: PathLike) -> str:
    """The NAME rnaxray_compare uses: the contact path without ``.contact.txt``."""
    text = str(contact)
    return text.replace(".contact.txt", "", 1)


def write_for_table(contact: PathLike, out: Optional[PathLike] = None, name: Optional[str] = None) -> Path:
    """Write the forTable that ``rnaxray_compare`` derives from a contact.txt.

    ``sort -k3,3nr`` orders cells by count (descending), then by the whole
    line byte-wise; the ``#`` line is dropped and the ``x y count`` header,
    whose count sorts as 0, ends up last.  ``name`` defaults to the contact
    path without ``.contact.txt``, exactly as rnaxray_compare passes it.
    """
    contact = Path(contact)
    label = (name if name is not None else for_table_name(contact)).encode("utf-8")
    target = Path(out) if out is not None else Path(for_table_name(contact) + ".forTable.txt")
    from rnaxraypipe import awk

    lines = contact.read_bytes().split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    keyed = sorted((-awk.to_num(_field(line, 3).decode("utf-8", "replace")), line) for line in lines)
    handle, tmp = _atomic_writer(target)
    try:
        with handle:
            for _, line in keyed:
                if line.startswith(b"#"):
                    continue
                handle.write(_field(line, 1) + b"_" + _field(line, 2) + b"\t" + label + b"=" + _field(line, 3) + b"\n")
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return target


def _field(line: bytes, n: int) -> bytes:
    parts = line.split()
    return parts[n - 1] if n <= len(parts) else b""

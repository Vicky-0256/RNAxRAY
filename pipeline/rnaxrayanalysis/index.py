"""Build the per-sample SQLite analysis index of a .hyb file.

Layout (``FORMAT`` / ``VERSION`` in table ``meta``):

``meta(key, value)``
    source path/size/mtime, record counts, build time, invalid-line samples.
``genes(id, name, max_end, records, reads, min_start)``
    gene names are stored once; ``max_end`` (largest arm end seen) stands in
    for the gene length and ``min_start`` is the smallest arm start (added
    after version 1 shipped: readers fall back when the column is absent).  ``records``/``reads`` count both arms, like the web
    parser's per-RNA table.
``types(id, name, records, reads)``
    chimera types (column 18, or inferred from coordinates).
``pairs(g1, g2, records, reads, max_span1, max_span2)``
    oriented gene pairs; the spans bound region queries on the start index.
``hybrids(id, g1, s1, e1, g2, s2, e2, reads, dg, overlap, type, offset)``
    one row per valid record in file order; ``offset`` is the byte offset of
    the line in the .hyb so names and sequences are read back on demand
    rather than stored.  Indexed on ``(g1, g2, s1, e1)`` (covers arm-1 region counts).
``rects(g1, g2, n, dtypes, s1, e1, s2, e2, type, count, reads)``
    per oriented gene pair, the distinct (arm 1, arm 2, type) rectangles with
    their record and read totals, as little-endian numpy column blobs.  Any
    contact map is a rasterisation of these rectangles, so a query never
    touches the per-hybrid table.

The build streams the file once (bounded memory), inserts in large
transactions with the rollback journal off, and writes to a temporary file
that replaces ``index_path`` only when complete.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple, Union

import numpy as np

from . import hybfile

FORMAT = "rnaxrayanalysis-index"
VERSION = 1
_BATCH = 100_000
_ERROR_SAMPLES = 20

PathLike = Union[str, "os.PathLike[str]"]

SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE genes(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, max_end INTEGER, records INTEGER, reads INTEGER,
                   min_start INTEGER);
CREATE TABLE types(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, records INTEGER, reads INTEGER);
CREATE TABLE pairs(g1 INTEGER, g2 INTEGER, records INTEGER, reads INTEGER, max_span1 INTEGER, max_span2 INTEGER,
                   PRIMARY KEY(g1, g2)) WITHOUT ROWID;
CREATE TABLE hybrids(id INTEGER PRIMARY KEY, g1 INTEGER, s1 INTEGER, e1 INTEGER, g2 INTEGER, s2 INTEGER, e2 INTEGER,
                     reads INTEGER, dg REAL, overlap NUMERIC, type INTEGER, offset INTEGER);
CREATE TABLE rects(id INTEGER PRIMARY KEY, g1 INTEGER, g2 INTEGER, n INTEGER, dtypes TEXT,
                   s1 BLOB, e1 BLOB, s2 BLOB, e2 BLOB, type BLOB, count BLOB, reads BLOB, UNIQUE(g1, g2));
"""

RECT_COLUMNS = ("s1", "e1", "s2", "e2", "type", "count", "reads")


def _number(value: bytes):
    try:
        return int(value)
    except ValueError:
        return hybfile._optional_number(value)


def _fast_parse(cols: List[bytes]):
    """The common 18-column sam2hyb layout; ``None`` sends the line to hybfile.parse."""
    if len(cols) != 18 or cols[15] or not (cols[6].isdigit() and cols[7].isdigit() and cols[12].isdigit() and cols[13].isdigit()):
        return None
    g1, g2 = cols[3], cols[9]
    if not g1 or not g2 or g1 != g1.strip() or g2 != g2.strip():
        return None
    s1, e1, s2, e2 = int(cols[6]), int(cols[7]), int(cols[12]), int(cols[13])
    if s1 < 1 or s2 < 1 or s1 > e1 or s2 > e2:
        return None
    name = cols[0].split(b"_", 2)
    reads = int(name[1]) if len(name) > 1 and name[1].isdigit() else 0
    dg = None if cols[2] == b"." else hybfile._optional_number(cols[2])
    ctype = cols[17].rstrip(b"\r\n").strip()
    if not ctype or ctype == b"." or ctype.lower() == b"na":
        ctype = hybfile.infer_type(g1, s1, e1, g2, s2, e2)
    overlap = _number(cols[16].strip()) if cols[16].strip() and cols[16] != b"." else None
    return g1, s1, e1, g2, s2, e2, reads, dg, overlap, ctype


def build(hyb: PathLike, index_path: PathLike, *, progress: Optional[Callable[[int, int], None]] = None) -> Dict:
    """Index ``hyb`` into ``index_path`` (replaced atomically). Returns the meta dict."""
    hyb = Path(hyb).resolve()
    index_path = Path(index_path)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = index_path.with_name(index_path.name + ".tmp-%d" % os.getpid())
    tmp.unlink(missing_ok=True)
    started = time.monotonic()
    stat = hyb.stat()
    try:
        con = sqlite3.connect(str(tmp), isolation_level=None)
        try:
            meta = _build(con, hyb, stat.st_size, progress)
            meta.update({"format": FORMAT, "version": VERSION, "source_path": str(hyb), "source_size": stat.st_size,
                         "source_mtime_ns": stat.st_mtime_ns, "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                         "build_seconds": round(time.monotonic() - started, 2)})
            con.execute("BEGIN")
            con.executemany("INSERT INTO meta VALUES (?, ?)", [(k, json.dumps(v)) for k, v in meta.items()])
            con.execute("COMMIT")
            con.execute("ANALYZE")
        finally:
            con.close()
        os.replace(tmp, index_path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return meta


def _build(con: sqlite3.Connection, hyb: Path, total_bytes: int, progress) -> Dict:
    for pragma in ("journal_mode=OFF", "synchronous=OFF", "locking_mode=EXCLUSIVE", "temp_store=FILE",
                   "cache_size=-65536", "page_size=8192"):
        con.execute("PRAGMA " + pragma)
    con.executescript(SCHEMA)

    genes: Dict[bytes, List[int]] = {}   # name -> [id, max_end, records, reads, min_start]
    types: Dict[bytes, List[int]] = {}   # name -> [id, records, reads]
    pairs: Dict[Tuple[int, int], List[int]] = {}
    counters = {"records": 0, "invalid": 0, "skipped": 0, "reads": 0, "records_with_reads": 0, "with_dg": 0,
                "intra_records": 0, "inter_records": 0}
    errors: List[Dict] = []

    def gene_id(name: bytes, start: int, end: int, reads: int) -> int:
        entry = genes.get(name)
        if entry is None:
            entry = genes[name] = [len(genes) + 1, 0, 0, 0, start]
        if end > entry[1]:
            entry[1] = end
        if start < entry[4]:
            entry[4] = start
        entry[2] += 1
        entry[3] += reads
        return entry[0]

    insert = "INSERT INTO hybrids VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    batch: List[tuple] = []
    offset = 0
    line_no = 0
    con.execute("BEGIN")
    with open(hyb, "rb", buffering=1 << 20) as handle:
        for line in handle:
            line_no += 1
            here = offset
            offset += len(line)
            parsed = _fast_parse(line.split(b"\t"))
            if parsed is None:
                try:
                    record = hybfile.parse(line)
                except ValueError as error:
                    counters["invalid"] += 1
                    if len(errors) < _ERROR_SAMPLES:
                        errors.append({"line": line_no, "error": str(error),
                                       "content": line[:300].decode("utf-8", "replace").rstrip("\n")})
                    continue
                if record is None:
                    counters["skipped"] += 1
                    continue
                parsed = tuple(record)
            g1n, s1, e1, g2n, s2, e2, reads, dg, overlap, ctype = parsed
            g1 = gene_id(g1n, s1, e1, reads)
            g2 = gene_id(g2n, s2, e2, reads)
            tentry = types.get(ctype)
            if tentry is None:
                tentry = types[ctype] = [len(types) + 1, 0, 0]
            tentry[1] += 1
            tentry[2] += reads
            pentry = pairs.get((g1, g2))
            if pentry is None:
                pentry = pairs[(g1, g2)] = [0, 0, 0, 0]
            pentry[0] += 1
            pentry[1] += reads
            if e1 - s1 > pentry[2]:
                pentry[2] = e1 - s1
            if e2 - s2 > pentry[3]:
                pentry[3] = e2 - s2
            counters["records"] += 1
            counters["reads"] += reads
            if reads:
                counters["records_with_reads"] += 1
            if dg is not None:
                counters["with_dg"] += 1
            counters["intra_records" if g1 == g2 else "inter_records"] += 1
            batch.append((counters["records"], g1, s1, e1, g2, s2, e2, reads, dg, overlap, tentry[0], here))
            if len(batch) >= _BATCH:
                con.executemany(insert, batch)
                batch = []
                if progress:
                    progress(offset, total_bytes)
    if batch:
        con.executemany(insert, batch)
    con.executemany("INSERT INTO genes VALUES (?,?,?,?,?,?)",
                    [(v[0], k.decode("utf-8", "replace"), v[1], v[2], v[3], v[4]) for k, v in genes.items()])
    con.executemany("INSERT INTO types VALUES (?,?,?,?)",
                    [(v[0], k.decode("utf-8", "replace"), v[1], v[2]) for k, v in types.items()])
    con.executemany("INSERT INTO pairs VALUES (?,?,?,?,?,?)", [(k[0], k[1], *v) for k, v in pairs.items()])
    con.execute("COMMIT")
    con.execute("CREATE INDEX hybrids_pos ON hybrids(g1, g2, s1, e1)")
    _build_rects(con)
    if progress:
        progress(total_bytes, total_bytes)
    counters["errors"] = errors
    counters["genes"] = len(genes)
    return counters


def _dtype_for(maximum: int, smallest: str = "<u2") -> str:
    if smallest == "<u1" and maximum < 1 << 8:
        return "<u1"
    if smallest in ("<u1", "<u2") and maximum < 1 << 16:
        return "<u2"
    if maximum < 1 << 32:
        return "<u4"
    return "<i8"


# rects column -> (position in the GROUP BY row, chunk dtype, smallest stored dtype)
_RECT_LAYOUT = {"s1": (2, np.int64, "<u2"), "e1": (3, np.int64, "<u2"), "s2": (4, np.int64, "<u2"),
                "e2": (5, np.int64, "<u2"), "type": (6, np.int64, "<u1"), "count": (7, np.int64, "<u4"),
                "reads": (8, np.int64, "<u4")}
_RECT_CHUNK = 100_000


def _build_rects(con: sqlite3.Connection) -> None:
    """Group hybrids into distinct rectangles per gene pair (SQLite sorts on disk).

    Rows arrive in pair order; each pair's columns are collected in compact
    chunks, so memory is bounded by the largest pair's distinct rectangles.
    """
    cursor = con.execute(
        "SELECT g1, g2, s1, e1, s2, e2, type, count(*), sum(reads) FROM hybrids "
        "GROUP BY g1, g2, s1, e1, s2, e2, type ORDER BY g1, g2, s1, e1, s2, e2, type")
    current: Optional[Tuple[int, int]] = None
    chunks: Dict[str, List[np.ndarray]] = {name: [] for name in RECT_COLUMNS}
    pending: List[tuple] = []
    rows_in_pair = 0

    def compact():
        if not pending:
            return
        for name, (position, dtype, _) in _RECT_LAYOUT.items():
            column = np.fromiter((row[position] for row in pending), dtype=dtype, count=len(pending))
            chunks[name].append(column.astype(np.uint32) if column.max() < 1 << 32 and column.min() >= 0 else column)
        pending.clear()

    def flush_pair():
        nonlocal rows_in_pair
        if current is None:
            return
        compact()
        columns = {name: np.concatenate(chunks[name]) for name in RECT_COLUMNS}
        for name in RECT_COLUMNS:
            chunks[name] = []
        coord_max = max(int(columns[c].max()) for c in ("s1", "e1", "s2", "e2"))
        dtypes = {name: _dtype_for(coord_max if name in ("s1", "e1", "s2", "e2") else int(columns[name].max()),
                                   _RECT_LAYOUT[name][2]) for name in RECT_COLUMNS}
        blobs = [columns[name].astype(dtypes[name]).tobytes() for name in RECT_COLUMNS]
        del columns
        con.execute("INSERT INTO rects(g1, g2, n, dtypes, s1, e1, s2, e2, type, count, reads) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (current[0], current[1], rows_in_pair, json.dumps(dtypes), *blobs))
        rows_in_pair = 0

    con.execute("BEGIN")
    while True:
        rows = cursor.fetchmany(_RECT_CHUNK)
        if not rows:
            break
        for row in rows:
            key = (row[0], row[1])
            if key != current:
                flush_pair()
                current = key
            pending.append(row)
            rows_in_pair += 1
        compact()
    flush_pair()
    con.execute("COMMIT")

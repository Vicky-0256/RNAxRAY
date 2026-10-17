"""Input preparation: ``fasta_rnaxray_formatting``, ``solexa2fasta.awk`` +
``fasta2tab.awk`` + ``make_comp_fasta.pl``, and the Bowtie2 mapping step."""
from __future__ import annotations

import gzip
import heapq
import io
import os
import re
import shutil
import subprocess
import time
import zlib
from pathlib import Path
from typing import Callable, Dict, Iterable, Iterator, List, Optional, TextIO, Tuple

from . import awk

BOWTIE2_ARGS = ["-D", "20", "-R", "3", "-N", "0", "-L", "16", "-k", "20", "--local", "-i", "S,1,0.50",
                "--score-min", "L,18,0", "--ma", "1", "--np", "0", "--mp", "2,2", "--rdg", "5,1", "--rfg", "5,1", "--reorder"]


class MappingUnavailable(RuntimeError):
    pass


def open_text(path: Path) -> TextIO:
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace", newline="")
    return open(path, "r", encoding="utf-8", errors="replace", newline="")


def needs_formatting(fasta: Path) -> bool:
    with open_text(fasta) as handle:
        return any("|" in line for line in handle)


def format_reference(lines: Iterable[str]) -> List[str]:
    """Port of ``fasta_rnaxray_formatting``: rename biotype separators, join
    sequence lines, and drop ``unknown``/``pseudogene`` records (GNU sed
    ``/re/,+1 d``).  Returns lines without newlines; the original wrote no
    final newline."""
    renamed = []
    for raw in lines:
        line = raw.rstrip("\n").replace("_", "-").replace("protein-coding", "mRNA").replace("|", "_")
        renamed.append(line.replace("__", "_unknown_"))
    # awk: first line + "\n", headers as "\n" + header + "\n", sequence lines unterminated
    text = "".join((line + "\n") if number == 0 else ("\n" + line + "\n") if line.startswith(">") else line
                   for number, line in enumerate(renamed))
    joined = text.split("\n")
    if joined and joined[-1] == "":
        joined.pop()
    out: List[str] = []
    ends: Dict[str, int] = {}
    for number, line in enumerate(joined, 1):
        deleted = False
        for name in ("unknown", "pseudogene"):
            end = ends.get(name)
            if end is not None and number <= end:
                deleted = True
                break
            ends.pop(name, None)
            if name in line:
                ends[name] = number + 1
                deleted = True
                break
        if not deleted:
            out.append(line)
    return out


def fastq_to_rows(lines: Iterable[str]) -> List[List[str]]:
    """``solexa2fasta.awk | fasta2tab.awk``: [name, sequence] per read."""
    it = iter(lines)
    fasta: List[str] = []
    for raw in it:
        line = raw.rstrip("\r\n")
        if not line.startswith("@"):
            continue
        f = awk.fields(line)
        f[0] = ">" + f[0]
        header = " ".join(f)
        fasta.append(header)
        seq = next(it, None)
        fasta.append(header if seq is None else seq.rstrip("\r\n"))
        next(it, None)
        next(it, None)
    rows: List[List[str]] = []
    for line in fasta:
        if line.startswith("#") or line == "":
            continue
        if line.startswith(">"):
            rows.append([line[1:], ""])
        elif rows:
            rows[-1][1] += line
    return rows


def collapse_reads(rows: List[List[str]]) -> List[str]:
    """Port of ``make_comp_fasta.pl``: unique sequences named ``rank_count``."""
    barcodes = bool(rows) and re.match(r"^[^\t]*_[A-Z]*\t", rows[0][0] + "\t" + rows[0][1]) is not None
    counts: Dict[str, int] = {}
    barcoded: Dict[str, int] = {}
    seen = set()
    for name, seq in rows:
        counts[seq] = counts.get(seq, 0) + 1
        if barcodes:
            code = name.split("_")[-1]
            if (seq, code) not in seen:
                seen.add((seq, code))
                barcoded[seq] = barcoded.get(seq, 0) + 1
    if barcodes:
        lines = ["%s\t%d\t%d" % (seq, counts[seq], barcoded[seq]) for seq in counts]
        lines.sort(key=lambda line: (-counts[line.split("\t")[0]], -barcoded[line.split("\t")[0]], line.encode()))
    else:
        lines = ["%s\t%d" % (seq, counts[seq]) for seq in counts]
        lines.sort(key=lambda line: (-counts[line.split("\t")[0]], line.encode()))
    out = []
    for number, line in enumerate(lines, 1):
        f = awk.fields(line)
        if barcodes:
            out += [">%d-%s_%s" % (number, awk.field(f, 3), awk.field(f, 2)), awk.field(f, 1)]
        else:
            out += [">%d_%s" % (number, awk.field(f, 2)), awk.field(f, 1)]
    return out


def _tool(*names: str) -> Optional[str]:
    """``RNAXRAYPIPE_TOOL_DIR`` (the desktop bundle's ``bin/``) first, then PATH."""
    bundled = os.environ.get("RNAXRAYPIPE_TOOL_DIR")
    for name in names:
        if bundled:
            found = shutil.which(name, path=bundled)
            if found:
                return found
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def bowtie2_index(fasta: Path, prefix: Path, log: Optional[TextIO] = None) -> Path:
    if Path(str(prefix) + ".1.bt2").exists() or Path(str(prefix) + ".1.bt2l").exists():
        return prefix
    # bowtie2-build is a Python wrapper; the -s binary works without it (Windows).
    exe = _tool("bowtie2-build-s", "bowtie2-build")
    if not exe:
        raise MappingUnavailable("bowtie2-build was not found; install Bowtie2 or provide a SAM file")
    subprocess.run([exe, str(fasta), str(prefix)], check=True, stdout=log or subprocess.DEVNULL, stderr=log or subprocess.DEVNULL)
    return prefix


def bowtie2_map(reads_fasta: Path, index: Path, sam: Path, *, threads: Optional[int] = None, log: Optional[TextIO] = None) -> None:
    # The bowtie2 wrapper is Perl; call the aligner binary directly when present.
    exe = _tool("bowtie2-align-s", "bowtie2")
    if not exe:
        raise MappingUnavailable("bowtie2 was not found; install Bowtie2 or provide a SAM file")
    args = [exe] + BOWTIE2_ARGS + ["-p", str(threads or os.cpu_count() or 1), "-x", str(index), "-f", str(reads_fasta)]
    with open(sam, "w", encoding="utf-8", newline="\n") as out:
        subprocess.run(args, check=True, stdout=out, stderr=log or subprocess.DEVNULL)


def iter_lines(path: Path) -> Iterator[str]:
    with open_text(path) as handle:
        for line in handle:
            yield line.rstrip("\r\n")


class ProgressReader:
    """``iter_lines`` that also reports how many bytes of the file (compressed
    bytes for .gz) have been read, for progress reporting."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.total = self.path.stat().st_size
        self._raw = open(self.path, "rb")
        stream = gzip.GzipFile(fileobj=self._raw, mode="rb") if str(path).endswith(".gz") else self._raw
        self._text = io.TextIOWrapper(stream, encoding="utf-8", errors="replace", newline="")

    def position(self) -> int:
        try:
            return self._raw.tell()
        except (OSError, ValueError):
            return 0

    def __iter__(self) -> Iterator[str]:
        try:
            for line in self._text:
                yield line.rstrip("\r\n")
        finally:
            self.close()

    def close(self) -> None:
        self._text.close()
        self._raw.close()


class Throttle:
    """Calls ``callback(stage, done, total)`` at most every ``interval`` seconds."""

    def __init__(self, callback: Optional[Callable[[str, int, int], None]], stage: str, interval: float = 0.5) -> None:
        self.callback, self.stage, self.interval = callback, stage, interval
        self.next = 0.0

    def __call__(self, done: int, total: int, force: bool = False) -> None:
        if self.callback is None:
            return
        now = time.monotonic()
        if force or now >= self.next:
            self.next = now + self.interval
            self.callback(self.stage, int(done), int(total))


def iter_fastq_rows(lines: Iterable[str], names=True) -> Iterator[Tuple[Optional[str], str]]:
    """Streaming ``fastq_to_rows``: (name, sequence) per row.  ``names`` may
    be a one-item list that the caller flips to False to skip building names
    (only barcoded collapsing reads them); the name is then None."""
    want = names if isinstance(names, list) else [names]
    it = iter(lines)
    for raw in it:
        if not raw.startswith("@"):
            continue
        line = raw.rstrip("\r\n")
        # solexa2fasta: '>' + the header's fields joined by single spaces
        name = " ".join(line.split()) if want[0] else None
        seq = next(it, None)
        next(it, None)
        next(it, None)
        if seq is None:
            # the header is printed twice and becomes two empty records
            yield name, ""
            yield name, ""
            continue
        seq = seq.rstrip("\r\n")
        # fasta2tab skips '' and '#' lines and starts a record at '>'
        if seq == "" or seq.startswith("#"):
            yield name, ""
        elif seq.startswith(">"):
            yield name, ""
            yield (seq[1:] if want[0] else None), ""
        else:
            yield name, seq


_BARCODED = re.compile(r"^[^\t]*_[A-Z]*\t")
_MAX_COUNT = 10 ** 15
_ENTRY_BYTES = 250  # rough CPython cost of one dict entry with its key, beyond the sequence


def _rank_record(seq: str, count: int, barcoded: Optional[int]) -> str:
    """``collapse_reads``' sort key (-count[, -barcodes], line) as a plain string."""
    if barcoded is None:
        return "%015d%s\t%d" % (_MAX_COUNT - count, seq, count)
    return "%015d%015d%s\t%d\t%d" % (_MAX_COUNT - count, _MAX_COUNT - barcoded, seq, count, barcoded)


def _bucket_run(bucket: str, barcodes: bool, out: str) -> Tuple[str, int]:
    """Sum one bucket's spilled counts and write its sorted rank records."""
    counts: Dict[str, int] = {}
    if barcodes:
        pairs: Dict[Tuple[str, str], int] = {}
        with open(bucket, "r", encoding="utf-8", newline="\n") as handle:
            for record in handle:
                seq, code, count = record[:-1].rsplit("\0", 2)
                pairs[(seq, code)] = 1
                counts[seq] = counts.get(seq, 0) + int(count)
        barcoded: Dict[str, int] = {}
        for seq, _ in pairs:
            barcoded[seq] = barcoded.get(seq, 0) + 1
        del pairs
        records = [_rank_record(seq, count, barcoded[seq]) for seq, count in counts.items()]
    else:
        with open(bucket, "r", encoding="utf-8", newline="\n") as handle:
            for record in handle:
                seq, count = record[:-1].rsplit("\0", 1)
                counts[seq] = counts.get(seq, 0) + int(count)
        records = [_rank_record(seq, count, None) for seq, count in counts.items()]
    del counts
    records.sort()
    with open(out, "w", encoding="utf-8", newline="\n", buffering=1 << 20) as handle:
        for record in records:
            handle.write(record + "\n")
    os.unlink(bucket)
    return out, len(records)


def collapse_fastq(source: Path, out_fasta: Path, tmp_dir: Path, memory_mb: float = 1024, workers: int = 1,
                   progress_bytes: Optional[Callable[[str, int, int], None]] = None) -> Dict[str, int]:
    """``collapse_reads(fastq_to_rows(...))`` written to ``out_fasta`` with
    bounded memory.  Counts are kept in a dict; when it outgrows half of
    ``memory_mb`` it is spilled into hash buckets on disk, each bucket is
    summed and rank-sorted on its own (in ``workers`` processes) and the
    sorted buckets are merged.  Output is identical to ``collapse_reads``."""
    reader = ProgressReader(source)
    report = Throttle(progress_bytes, "reads")
    budget = max(memory_mb, 1e-6) * 2 ** 20 / 2
    first = None
    want_names = [True]
    rows = iter_fastq_rows(reader, names=want_names)
    for first in rows:
        break
    barcodes = first is not None and _BARCODED.match(first[0] + "\t" + first[1]) is not None
    want_names[0] = barcodes
    counts: Dict = {}
    size = 0
    reads = 0
    buckets: List[Path] = []
    spill_dir = Path(tmp_dir) / "collapse"

    def spill() -> None:
        nonlocal counts, size
        if not buckets:
            fraction = max(reader.position() / max(reader.total, 1), 1e-6)
            estimate = (size / fraction) * 1.2
            number = int(min(256, max(4, -(-estimate // budget))))
            spill_dir.mkdir(parents=True, exist_ok=True)
            buckets.extend(spill_dir / ("bucket%03d" % i) for i in range(number))
        handles = [open(path, "a", encoding="utf-8", newline="\n", buffering=1 << 18) for path in buckets]
        try:
            number = len(buckets)
            if barcodes:
                for (seq, code), count in counts.items():
                    handles[zlib.crc32(seq.encode("utf-8", "surrogatepass")) % number].write("%s\0%s\0%d\n" % (seq, code, count))
            else:
                for seq, count in counts.items():
                    handles[zlib.crc32(seq.encode("utf-8", "surrogatepass")) % number].write("%s\0%d\n" % (seq, count))
        finally:
            for handle in handles:
                handle.close()
        counts, size = {}, 0

    def chained():
        if first is not None:
            yield first
        yield from rows

    try:
        for name, seq in chained():
            reads += 1
            key = (seq, name.split("_")[-1]) if barcodes else seq
            count = counts.get(key)
            if count is None:
                counts[key] = 1
                size += len(seq) + _ENTRY_BYTES
                if size > budget:
                    spill()
            else:
                counts[key] = count + 1
            if not reads & 0xFFFF:
                report(reader.position(), reader.total)
    finally:
        reader.close()
    report(reader.total, reader.total, force=True)

    if buckets:
        spill()
        runs: List[str] = []
        jobs = [(str(path), barcodes, str(path) + ".sorted") for path in buckets if path.exists()]
        workers = max(1, min(workers, len(jobs), 4))
        if workers > 1:
            from concurrent.futures import ProcessPoolExecutor
            with ProcessPoolExecutor(max_workers=workers) as pool:
                runs = [path for path, _ in pool.map(_bucket_run, *zip(*jobs))]
        else:
            runs = [_bucket_run(*job)[0] for job in jobs]
        handles = [open(path, "r", encoding="utf-8", newline="\n") for path in runs]
        ranked: Iterable[str] = heapq.merge(*[(line[:-1] for line in handle) for handle in handles])
    else:
        handles = []
        if barcodes:
            per_seq: Dict[str, int] = {}
            per_bc: Dict[str, int] = {}
            for (seq, _), count in counts.items():
                per_seq[seq] = per_seq.get(seq, 0) + count
                per_bc[seq] = per_bc.get(seq, 0) + 1
            records = [_rank_record(seq, count, per_bc[seq]) for seq, count in per_seq.items()]
            del per_seq, per_bc
        else:
            records = [_rank_record(seq, count, None) for seq, count in counts.items()]
        counts = {}
        records.sort()
        ranked = records
    prefix = 30 if barcodes else 15
    unique = 0
    try:
        with open(out_fasta, "w", encoding="utf-8", newline="\n", buffering=1 << 20) as out:
            for unique, record in enumerate(ranked, 1):
                f = awk.fields(record[prefix:])
                if barcodes:
                    out.write(">%d-%s_%s\n%s\n" % (unique, awk.field(f, 3), awk.field(f, 2), awk.field(f, 1)))
                else:
                    out.write(">%d_%s\n%s\n" % (unique, awk.field(f, 2), awk.field(f, 1)))
    finally:
        for handle in handles:
            handle.close()
        if buckets:
            shutil.rmtree(spill_dir, ignore_errors=True)
    return {"reads": reads, "unique_reads": unique}


class Bowtie2Stream:
    """Bowtie2 with its SAM output read line by line from a pipe."""

    def __init__(self, reads_fasta: Path, index: Path, *, threads: Optional[int] = None, log: Optional[TextIO] = None) -> None:
        exe = _tool("bowtie2-align-s", "bowtie2")
        if not exe:
            raise MappingUnavailable("bowtie2 was not found; install Bowtie2 or provide a SAM file")
        args = [exe] + BOWTIE2_ARGS + ["-p", str(threads or os.cpu_count() or 1), "-x", str(index), "-f", str(reads_fasta)]
        self.args = args
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=log or subprocess.DEVNULL)
        self._text = io.TextIOWrapper(self.proc.stdout, encoding="utf-8", errors="replace", newline="")

    def __iter__(self) -> Iterator[str]:
        for line in self._text:
            if not line.endswith("\n"):
                # Bowtie2 ends every SAM line with a newline; a cut-off last
                # line means it died mid-write, so report that, not the
                # parse error the partial record would cause downstream.
                code = self.proc.wait()
                if code:
                    raise subprocess.CalledProcessError(code, self.args)
            yield line.rstrip("\r\n")
        code = self.proc.wait()
        if code:
            raise subprocess.CalledProcessError(code, self.args)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        self._text.close()

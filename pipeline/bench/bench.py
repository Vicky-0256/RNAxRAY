"""Benchmark one ``python -m rnaxraypipe`` run: wall time, peak RSS, peak temp disk.

    python pipeline/bench/bench.py --python PY -i reads.fastq -d ref.fasta -o OUT/prefix \
        [--tool-dir DIR] [--label 2M] [--json results.jsonl] [-- extra rnaxraypipe args]

Peak RSS comes from ``/usr/bin/time -l`` (macOS) or ``/usr/bin/time -v`` (Linux)
and covers the pipeline process and its children (Bowtie2, worker pools) as
reported by the OS for the largest single process; ``--sample`` also polls the
summed RSS of the whole process tree.  Temp disk is the peak size of the
output directory plus the ``--tmp-dir`` given to rnaxraypipe, sampled twice a
second.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]


def dir_size(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def tree_rss_kb(pid: int) -> int:
    """Summed RSS (KiB) of ``pid`` and all its descendants (``ps``)."""
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss="], capture_output=True, text=True).stdout
    except OSError:
        return 0
    children, rss = {}, {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3:
            p, pp, r = map(int, parts)
            children.setdefault(pp, []).append(p)
            rss[p] = r
    total, stack = 0, [pid]
    while stack:
        p = stack.pop()
        total += rss.get(p, 0)
        stack.extend(children.get(p, []))
    return total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--tool-dir")
    parser.add_argument("-i", required=True)
    parser.add_argument("-d", required=True)
    parser.add_argument("-o", required=True)
    parser.add_argument("--tmp-dir", help="also passed to rnaxraypipe --tmp-dir and included in the disk figure")
    parser.add_argument("--label", default="")
    parser.add_argument("--json", help="append one JSON result line to this file")
    parser.add_argument("extra", nargs="*", help="extra rnaxraypipe arguments (after --)")
    args = parser.parse_args()

    out = Path(args.o)
    out.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONPATH=str(PIPELINE))
    if args.tool_dir:
        env["RNAXRAYPIPE_TOOL_DIR"] = args.tool_dir
    cmd = [args.python, "-m", "rnaxraypipe", "-i", args.i, "-d", args.d, "-o", str(out)] + args.extra
    if args.tmp_dir:
        Path(args.tmp_dir).mkdir(parents=True, exist_ok=True)
        cmd += ["--tmp-dir", args.tmp_dir]
    mac = platform.system() == "Darwin"
    timefile = tempfile.NamedTemporaryFile(prefix="rnaxraybench", suffix=".time", delete=False)
    timefile.close()
    full = ["/usr/bin/time", "-l" if mac else "-v", "-o", timefile.name] + cmd

    watched = [out.parent] + ([Path(args.tmp_dir)] if args.tmp_dir else [])
    base_disk = sum(dir_size(p) for p in watched)
    peak = {"disk": 0, "tree_rss_kb": 0}
    stop = threading.Event()
    start = time.time()
    proc = subprocess.Popen(full, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def poll() -> None:
        while not stop.is_set():
            peak["disk"] = max(peak["disk"], sum(dir_size(p) for p in watched) - base_disk)
            peak["tree_rss_kb"] = max(peak["tree_rss_kb"], tree_rss_kb(proc.pid))
            stop.wait(0.5)

    marks = []
    lines = []

    def read_stderr() -> None:
        for line in proc.stderr:
            lines.append(line)
            match = re.match(r"^\[([^\]]+)\] (.*)$", line)
            if match:
                marks.append((round(time.time() - start, 1), match.group(1), match.group(2).strip()))

    thread = threading.Thread(target=poll, daemon=True)
    thread.start()
    reader = threading.Thread(target=read_stderr, daemon=True)
    reader.start()
    stdout = proc.stdout.read()
    proc.wait()
    reader.join()
    stderr = "".join(lines)
    wall = time.time() - start
    stop.set()
    thread.join()
    timing = Path(timefile.name).read_text()
    os.unlink(timefile.name)
    if mac:
        match = re.search(r"(\d+)\s+maximum resident set size", timing)
        peak_rss = int(match.group(1)) if match else 0  # bytes
    else:
        match = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", timing)
        peak_rss = int(match.group(1)) * 1024 if match else 0
    result = {
        "label": args.label, "input": args.i, "returncode": proc.returncode, "wall_s": round(wall, 1),
        "peak_rss_mb": round(peak_rss / 2**20), "peak_tree_rss_mb": round(peak["tree_rss_kb"] / 1024),
        "peak_disk_mb": round(peak["disk"] / 2**20), "stages": marks, "command": cmd,
    }
    if proc.returncode:
        sys.stderr.write(stderr[-4000:])
    print(json.dumps(result))
    if args.json:
        with open(args.json, "a") as handle:
            handle.write(json.dumps(result) + "\n")
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())

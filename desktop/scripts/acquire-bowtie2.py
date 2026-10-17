#!/usr/bin/env python3
"""Download a pinned, hash-verified Bowtie2 release and keep only what the
desktop pipeline runs: ``bowtie2-align-s`` and ``bowtie2-build-s``.

The ``-s`` binaries are called directly, so neither the Perl ``bowtie2``
wrapper nor the Python ``bowtie2-build`` wrapper is needed on any platform.
Hashes are the SHA-256 digests GitHub publishes for the v2.5.5 assets.
Bowtie2 is GPL-3.0; its LICENSE is staged next to the binaries.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import stat
import tempfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "2.5.5"
BASE = "https://github.com/BenLangmead/bowtie2/releases/download/v%s/" % VERSION
RELEASES = {
    "macos-aarch64": ("bowtie2-2.5.5-macos-arm64.zip", "6f10939b56e7d94b30b0c55705b5be62e3a43a6fbd14e1774d630831e6cd013a", ""),
    "linux-x86_64": ("bowtie2-2.5.5-linux-x86_64.zip", "38472e806f56ed23d32cbe7a7fe1b7260680f892647aa78c2f6882f8f272a026", ""),
    "linux-aarch64": ("bowtie2-2.5.5-linux-aarch64.zip", "d6fd63a46b92308aca32ddcc562f3e7897303ab48656693972a2543bffa07fcc", ""),
    "windows-x86_64": ("bowtie2-2.5.5-mingw-x86_64.zip", "77bfac3a84c54f4032ee851c19917802decc1b28083ce17a5f92a0c4d729bdba", ".exe"),
}
BINARIES = ("bowtie2-align-s", "bowtie2-build-s")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=sorted(RELEASES))
    parser.add_argument("--output", required=True, type=Path, help="empty or absent directory")
    parser.add_argument("--archive", type=Path, help="use a local copy of the release zip (air-gapped builds)")
    args = parser.parse_args()
    name, expected, suffix = RELEASES[args.platform]
    output = args.output.absolute()
    if output.exists() and any(output.iterdir()):
        parser.error("output must be empty or absent: %s" % output)
    with tempfile.TemporaryDirectory(prefix="bowtie2-") as tmp:
        archive = args.archive or Path(tmp) / name
        if not args.archive:
            urllib.request.urlretrieve(BASE + name, archive)
        actual = digest(archive)
        if actual != expected:
            raise SystemExit("SHA-256 mismatch for %s: %s != %s" % (name, actual, expected))
        top = name[:-len(".zip")]
        wanted = {top + "/" + binary + suffix: Path("bin") / (binary + suffix) for binary in BINARIES}
        wanted[top + "/LICENSE"] = Path("LICENSE")
        (output / "bin").mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as bundle:
            missing = set(wanted) - set(bundle.namelist())
            if missing:
                raise SystemExit("release archive lacks: " + ", ".join(sorted(missing)))
            for member, relative in wanted.items():
                target = output / relative
                with bundle.open(member) as source, target.open("wb") as sink:
                    shutil.copyfileobj(source, sink)
                if relative.parent.name == "bin":
                    target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        (output / "VERSION").write_text("%s\n%s sha256=%s\n" % (VERSION, BASE + name, expected), encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

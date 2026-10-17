"""Write the first N reads of a FASTQ(.gz) to a plain FASTQ file.

    python pipeline/bench/make_subset.py ../zika_files/ZAFR_REP1.fastq 2000000 out/zafr_2m.fastq

Prints the sha256 of the subset.  ``pipeline/tests/golden/zafr_rep1_2m.json``
records the expected digest of the 2M-read ZAFR_REP1 subset.
"""
from __future__ import annotations

import gzip
import hashlib
import sys
from pathlib import Path


def find_zika_files() -> Path | None:
    """``$RNAXRAY_ZIKA_DIR``, else a ``zika_files`` directory next to any parent of this checkout."""
    import os
    env = os.environ.get("RNAXRAY_ZIKA_DIR")
    if env:
        return Path(env) if Path(env).is_dir() else None
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "zika_files"
        if candidate.is_dir():
            return candidate
    return None


def write_subset(source: Path, reads: int, target: Path) -> str:
    """Copy the first ``4 * reads`` lines; returns the sha256 of what was written."""
    digest = hashlib.sha256()
    opener = gzip.open if str(source).endswith(".gz") else open
    target.parent.mkdir(parents=True, exist_ok=True)
    remaining = 4 * reads
    with opener(source, "rb") as src, open(target, "wb") as out:
        for line in src:
            if remaining == 0:
                break
            out.write(line)
            digest.update(line)
            remaining -= 1
    return digest.hexdigest()


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    print(write_subset(Path(argv[0]), int(argv[1]), Path(argv[2])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

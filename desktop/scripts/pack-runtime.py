#!/usr/bin/env python3
"""Pack the staged native runtime into one archive for the desktop app.

    python3 desktop/scripts/pack-runtime.py --platform darwin-arm64 \
        [--runtime desktop/resources/native] [--app desktop/app]

MyGo leaves hidden files out of an app's resources, and the runtime needs
some (numpy/.dylibs, numpy/.libs), so the app ships the runtime as
desktop/app/resources/<platform>/native.tar.gz plus native.tar.gz.sha256 and
unpacks it on first launch (desktop/app/core/archive.go).  The archive is
deterministic: sorted entries, fixed times and owners, no __pycache__ or
.pyc, hard links stored as files, symlinks kept (relative, inside the tree).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLATFORMS = ("darwin-arm64", "darwin-amd64", "windows-amd64", "linux-amd64", "linux-arm64")


def entries(runtime: Path):
    for dirpath, dirnames, filenames in os.walk(runtime, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        here = Path(dirpath)
        # symlinked directories are walked as links, not descended
        for name in list(dirnames):
            if (here / name).is_symlink():
                dirnames.remove(name)
                yield here / name
        if here != runtime:
            yield here
        for name in sorted(filenames):
            if name.endswith(".pyc"):
                continue
            yield here / name


def tarinfo(path: Path, runtime: Path) -> tarfile.TarInfo:
    rel = path.relative_to(runtime).as_posix()
    info = tarfile.TarInfo(rel)
    info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
    if path.is_symlink():
        target = os.readlink(path)
        resolved = (path.parent / target).resolve()
        if os.path.isabs(target) or runtime.resolve() not in resolved.parents:
            raise SystemExit(f"{rel}: link {target!r} leaves the runtime")
        info.type, info.linkname, info.mode = tarfile.SYMTYPE, target, 0o777
    elif path.is_dir():
        info.type, info.mode = tarfile.DIRTYPE, 0o755
    elif path.is_file():
        info.type = tarfile.REGTYPE
        info.size = path.stat().st_size
        info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
    else:
        raise SystemExit(f"{rel}: unsupported file type")
    return info


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--platform", required=True, choices=PLATFORMS, help="MyGo resource directory name")
    parser.add_argument("--runtime", type=Path, default=ROOT / "desktop/resources/native")
    parser.add_argument("--app", type=Path, default=ROOT / "desktop/app")
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    if not (runtime / "desktop/runtime/bridge.py").is_file() or not (runtime / "native-manifest.json").is_file():
        raise SystemExit(f"{runtime} is not a staged runtime (run stage-native.py first)")
    out_dir = args.app / "resources" / args.platform
    out_dir.mkdir(parents=True, exist_ok=True)
    stale = out_dir / "native"
    if stale.is_symlink() or stale.exists():
        raise SystemExit(f"remove {stale}: the runtime now ships as {out_dir / 'native.tar.gz'}")
    target = out_dir / "native.tar.gz"
    tmp = target.with_suffix(".tmp")
    count = 0
    with open(tmp, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0, filename="") as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
                for path in entries(runtime):
                    info = tarinfo(path, runtime)
                    if info.isreg():
                        with open(path, "rb") as handle:
                            tar.addfile(info, handle)
                    else:
                        tar.addfile(info)
                    count += 1
    digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
    os.replace(tmp, target)
    (out_dir / "native.tar.gz.sha256").write_text(f"{digest}  native.tar.gz\n")
    print(f"{target}: {count} entries, {target.stat().st_size / 2**20:.1f} MiB, sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

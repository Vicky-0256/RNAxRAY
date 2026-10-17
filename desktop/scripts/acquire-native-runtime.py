#!/usr/bin/env python3
"""Download and unpack a *verified* CPython runtime archive.

This is deliberately a boring acquisition primitive.  It never guesses a URL,
never installs packages, and refuses to unpack an archive whose SHA-256 does
not match the value supplied by the release workflow.
"""
from __future__ import annotations
import argparse, hashlib, os, shutil, stat, tarfile, tempfile, urllib.request, zipfile
from pathlib import Path

PLATFORMS = {
    "windows-x86_64": ("windows", "x86_64"),
    "linux-x86_64": ("linux", "x86_64"),
    "macos-aarch64": ("darwin", "aarch64"),
    "macos-x86_64": ("darwin", "x86_64"),
}

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def safe_member(name: str) -> bool:
    p = Path(name)
    return not p.is_absolute() and "\\" not in name and all(x not in ("", ".", "..") for x in p.parts)

def safe_link(member: tarfile.TarInfo) -> bool:
    """Regular files and directories pass; links only when they stay inside
    the archive (python-build-standalone ships bin/python3 -> python3.11);
    devices and FIFOs never."""
    if member.isfile() or member.isdir():
        return True
    if member.issym():
        target = member.linkname
        if not target or target.startswith(("/", "\\")) or "\\" in target:
            return False
        resolved = (Path(member.name).parent / target).parts
        depth = 0
        for part in resolved:
            depth += -1 if part == ".." else 0 if part in ("", ".") else 1
            if depth < 0:
                return False
        return True
    if member.islnk():
        return safe_member(member.linkname)
    return False


def unpack(archive: Path, destination: Path) -> None:
    # Detect the format from the content: a --url download lands in a temp
    # file whose name says nothing about the archive type.
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            if any(not safe_member(x) for x in z.namelist()):
                raise SystemExit("archive contains an unsafe path")
            z.extractall(destination)
    else:
        with tarfile.open(archive, "r:*") as t:  # transparent gz/bz2/xz
            if any(not safe_member(m.name) or not safe_link(m) for m in t.getmembers()):
                raise SystemExit("archive contains unsafe paths or links")
            t.extractall(destination)

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--platform", required=True, choices=sorted(PLATFORMS))
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--url")
    src.add_argument("--archive", type=Path)
    ap.add_argument("--sha256", required=True, help="64 lowercase/uppercase hex characters")
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    if len(args.sha256) != 64 or any(c not in "0123456789abcdefABCDEF" for c in args.sha256):
        ap.error("--sha256 must be a 64-character hexadecimal digest")
    archive = args.archive
    temporary = None
    if archive is None:
        temporary = tempfile.NamedTemporaryFile(prefix="rnaxray-runtime-", suffix=".archive", delete=False)
        temporary.close(); archive = Path(temporary.name)
        try:
            with urllib.request.urlopen(args.url, timeout=120) as response, archive.open("wb") as out:
                shutil.copyfileobj(response, out)
        except Exception:
            archive.unlink(missing_ok=True); raise
    try:
        actual = digest(archive)
        if actual.lower() != args.sha256.lower():
            raise SystemExit(f"SHA256 mismatch: expected {args.sha256}, got {actual}")
        if args.output.exists() and any(args.output.iterdir()):
            raise SystemExit(f"output must be a new or empty directory: {args.output}")
        args.output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="rnaxray-runtime-extract-", dir=args.output.parent) as tmp:
            unpack(archive, Path(tmp))
            # Some tar writers emit harmless metadata files (for example
            # .DS_Store) beside the top-level directory.  Determine the
            # directory from archive contents while still rejecting archives
            # containing more than one payload root.
            entries = [p for p in Path(tmp).iterdir()
                       if p.name not in (".DS_Store", "__MACOSX") and not p.name.startswith("._")]
            if len(entries) != 1 or not entries[0].is_dir():
                raise SystemExit("runtime archive must contain exactly one top-level directory")
            shutil.copytree(entries[0], args.output, dirs_exist_ok=True)
        print(f"acquired {args.platform} runtime: {args.output}")
        print(f"archive_sha256={actual}")
        return 0
    finally:
        if temporary is not None:
            archive.unlink(missing_ok=True)

if __name__ == "__main__":
    raise SystemExit(main())

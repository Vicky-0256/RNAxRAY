#!/usr/bin/env python3
"""Strict preflight for a distributable RNAxRay native runtime.

This command intentionally rejects development-external-python staging.  It is
safe to run from CI before building the desktop app (go tool mygo build).
"""
from __future__ import annotations
import argparse, hashlib, json, platform, subprocess, sys, re, importlib.util
from pathlib import PurePosixPath, PureWindowsPath
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PINS = {"numpy":"1.24.4", "numba":"0.58.1", "llvmlite":"0.41.1"}
EXPECTED = "..(((((..[[[[)))))......]]]]"
LICENSE_FILES = ["LICENSE", "AUTHORS", "THIRD_PARTY_NOTICES.md", "pipeline/LICENSE", "pipeline/NOTICE.md",
                 "third_party/bowtie2/LICENSE",
                 "third_party/cplfold/LICENSE",
                 "third_party/cplfold/THIRD_PARTY_NOTICES.md",
                 "third_party/cplfold/LICENSES/LinearFold-LICENSE.txt",
                 "third_party/cplfold/LICENSES/GPL-2.0-or-later.txt"]


def fail(message: str) -> int:
    print("native release preflight: FAILED", file=sys.stderr)
    print(message, file=sys.stderr)
    print("Acquire a verified relocatable CPython 3.11.x distribution for this platform,\n"
          "install the pinned binary wheels from desktop/runtime/requirements-native.txt\n"
          "and desktop/runtime/requirements-evidence.txt (--require-hashes),\n"
          "then stage it with desktop/scripts/stage-native.py --standalone-python ...\n"
          "--source-id 'URL; sha256=...' .", file=sys.stderr)
    return 2


def safe_relative(value):
    return (isinstance(value, str) and bool(value) and "\\" not in value
            and "\0" not in value and not PureWindowsPath(value).drive
            and not PurePosixPath(value).is_absolute()
            and all(part not in ("", ".", "..") for part in value.split("/")))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--resource-root", type=Path, default=ROOT / "desktop/resources/native")
    args = ap.parse_args()
    root = args.resource_root.resolve()
    if not root.is_dir():
        return fail(f"bundled native resource directory is missing: {root}")
    manifest_path = root / "native-manifest.json"
    if not manifest_path.is_file():
        return fail(f"native-manifest.json is missing: {manifest_path}")
    try: manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e: return fail(f"manifest is not valid JSON: {e}")
    if not isinstance(manifest, dict) or manifest.get("manifest_version") != "1.0":
        return fail("manifest must be an object with manifest_version 1.0")
    if manifest.get("portable") is not True or manifest.get("mode") != "standalone":
        return fail("runtime is not portable standalone (development-external-python is never release-ready)")
    if not isinstance(manifest.get("source_id"), str) or not re.search(r"sha256=[a-fA-F0-9]{64}(?:$|[ ;])", manifest["source_id"]):
        return fail("portable manifest lacks source_id with an archive SHA256")
    expected_arch = {"x86_64":"x86_64", "AMD64":"x86_64", "aarch64":"aarch64", "arm64":"aarch64"}.get(platform.machine(), platform.machine())
    recorded = manifest.get("architecture")
    recorded = {"AMD64":"x86_64", "arm64":"aarch64"}.get(recorded, recorded)
    if manifest.get("platform") != platform.system():
        return fail("runtime platform does not match this host")
    if recorded != expected_arch:
        return fail(f"runtime architecture {recorded!r} does not match host {expected_arch!r}")
    pyrel = manifest.get("python_executable")
    if not safe_relative(pyrel):
        return fail("manifest python_executable is not a safe relative path")
    interpreter = root / pyrel
    if not interpreter.is_file(): return fail(f"bundled interpreter missing: {interpreter}")
    files = manifest.get("files", {})
    if not isinstance(files, dict) or not files: return fail("manifest files index is missing or empty")
    for path in root.rglob("*"):
        if path.is_symlink() and not path.resolve().is_relative_to(root):
            return fail(f"external or broken resource symlink: {path}")
    actual_files = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and not p.is_symlink() and p != manifest_path}
    if actual_files != set(files): return fail("manifest file inventory does not match resource contents")
    for rel, digest in files.items():
        if not safe_relative(rel) or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            return fail("invalid manifest file path or SHA256")
        path = root / rel
        if not path.is_file() or path.is_symlink(): return fail(f"manifest file missing or symlinked: {rel}")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest: return fail(f"SHA256 mismatch: {rel}")
    # The bundle carries a copy of the repository sources; a stale copy silently
    # ships an old bridge protocol, so every staged source must match the repo.
    stage_spec = importlib.util.spec_from_file_location("native_stage_dirs", Path(__file__).with_name("stage-native.py"))
    stage_module = importlib.util.module_from_spec(stage_spec)
    stage_spec.loader.exec_module(stage_module)
    for rel, digest in files.items():
        if any(rel.startswith(prefix + "/") for prefix in stage_module.SOURCE_DIRS) or rel == "bin/cplfold":
            source = ROOT / rel
            if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                return fail(f"bundled source is stale (re-run stage-native.py): {rel}")
    for rel in LICENSE_FILES:
        if not (root / rel).is_file(): return fail(f"required license notice missing: {rel}")
    # Use the same real JIT/reference-fold checks as staging. The probe uses an
    # isolated interpreter, validates module origins, and keeps caches in temp.
    spec = importlib.util.spec_from_file_location("native_stage", Path(__file__).with_name("stage-native.py"))
    staging = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(staging)
    try:
        details = staging.smoke(root, interpreter, portable=True)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return fail(f"native runtime smoke failed: {error}")
    if not details.get("viennarna"):
        return fail("ViennaRNA 2.7.2 is not installed in the bundled Python (needed for pipeline -e 1)")
    evidence = details.get("evidence")
    if not evidence:
        return fail("RNAcentral evidence packages (mcp, rnacentral-mcp-server) are not installed in the bundled Python:\n"
                    "install desktop/runtime/requirements-evidence.txt with --require-hashes")
    pins = staging.evidence_pins()
    if (evidence.get("mcp"), evidence.get("rnacentral-mcp-server")) != (pins["mcp"], pins["rnacentral-mcp-server"]) \
            or evidence.get("packages") != len(pins) or evidence.get("worker_status") != "passed":
        return fail(f"evidence runtime does not match requirements-evidence.txt: {evidence}")
    if not details.get("bowtie2"):
        return fail("Bowtie2 is not bundled: stage with --bowtie2 <acquire-bowtie2.py output>")
    print(json.dumps({"ok":True,"resource_root":str(root),"portable":True,"platform":platform.system(),"architecture":expected_arch,"runtime":details,"cplfold":"passed"}, indent=2))
    return 0

if __name__ == "__main__": sys.exit(main())

#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_directory="$repository_root/web/vendor/pyodide-cplfold"
source_directory="$repository_root/third_party/cplfold"
bridge_source="$repository_root/web/cplfold/cplfold_web.py"
pyodide_version="0.29.4"
pyodide_base_url="https://cdn.jsdelivr.net/pyodide/v${pyodide_version}/full"
pyodide_license_url="https://raw.githubusercontent.com/pyodide/pyodide/${pyodide_version}/LICENSE"
build_commit="${GITHUB_SHA:-local}"
build_directory="$(mktemp -d)"
download_directory="$build_directory/downloads"
staging_directory="$build_directory/cplfold"

cleanup() {
  rm -rf "$build_directory"
}
trap cleanup EXIT

if command -v sha256sum >/dev/null 2>&1; then
  rnaxray_sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  rnaxray_sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  printf 'Missing SHA-256 tool: install coreutils or use macOS shasum.\n' >&2
  exit 1
fi

mkdir -p "$download_directory" "$staging_directory/Utils/energy_params" "$output_directory"

download_and_verify() {
  local name="$1"
  local expected="$2"
  local url="$3"
  local cached="${RNAXRAY_PYODIDE_CACHE:-}/$name"
  local destination="$download_directory/$name"

  if [[ -n "${RNAXRAY_PYODIDE_CACHE:-}" && -f "$cached" ]]; then
    cp "$cached" "$destination"
  else
    curl -L --fail --silent --show-error "$url" -o "$destination"
  fi
  # macOS ships a BSD ``sha256sum`` compatibility command without GNU's
  # ``--check --status`` flags. Compute the digest explicitly so the same
  # reproducible build works on macOS and Linux.
  local actual
  actual="$(shasum -a 256 "$destination" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Checksum failed for %s (expected %s, got %s)\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
  cp "$destination" "$output_directory/$name"
}

download_and_verify "pyodide.mjs" "8fdfed5eaf81bde14bcdeaeea11f2672675b2362248f8537446b6fda5e4a4751" "$pyodide_base_url/pyodide.mjs"
download_and_verify "pyodide.asm.js" "fe75e97ef2c7a10c41f23b96344c553c7c1c62821bb206080dbb24941c06d5f3" "$pyodide_base_url/pyodide.asm.js"
download_and_verify "pyodide.asm.wasm" "10090fe41e019ae669d512e1f747021a8db2aaab0f6dd6f85fa9368c55d681e3" "$pyodide_base_url/pyodide.asm.wasm"
download_and_verify "python_stdlib.zip" "92cb24faa546818f3ef4050fd5bd2b6487bd2042efed2113af141d035f30efb4" "$pyodide_base_url/python_stdlib.zip"
download_and_verify "pyodide-lock.json" "14d2c2dba101277999e17135e653d8f15389ad1437f53eae213bf0c3cdff723d" "$pyodide_base_url/pyodide-lock.json"
download_and_verify "numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl" "800c98edc0c864dfa49f07005680c699b4b42b84eae1f8cb19d35b3634e7f05c" "$pyodide_base_url/numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
download_and_verify "Pyodide-LICENSE.txt" "1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5" "$pyodide_license_url"

cp "$source_directory/CPLfold.py" "$staging_directory/CPLfold.py"
cp "$source_directory/CPLfold_parser.py" "$staging_directory/CPLfold_parser.py"
cp "$bridge_source" "$staging_directory/cplfold_web.py"
cp "$source_directory"/Utils/*.py "$staging_directory/Utils/"
cp "$source_directory"/Utils/energy_params/* "$staging_directory/Utils/energy_params/"
cp "$source_directory/THIRD_PARTY_NOTICES.md" "$output_directory/CPLfold-THIRD_PARTY_NOTICES.md"
cp "$source_directory/LICENSES/GPL-2.0-or-later.txt" "$output_directory/CPLfold-GPL-2.0-or-later.txt"
cp "$source_directory/LICENSES/LinearFold-LICENSE.txt" "$output_directory/CPLfold-LinearFold-LICENSE.txt"

archive_staging="$build_directory/cplfold-python.zip"
(
  cd "$build_directory"
  zip -q -r "$archive_staging" cplfold
)

archive_hash="$(rnaxray_sha256 "$archive_staging")"
archive_file="cplfold-python-${archive_hash}.zip"
cp "$archive_staging" "$output_directory/$archive_file"
printf '{\n  "pyodide": "%s",\n  "python": "3.13.2",\n  "numpy": "2.2.5",\n  "cplfoldRevision": "24bab52",\n  "bridgeVersion": "5",\n  "buildCommit": "%s",\n  "cplfoldArchiveFile": "%s",\n  "cplfoldArchiveSha256": "%s"\n}\n' \
  "$pyodide_version" "$build_commit" "$archive_file" "$archive_hash" > "$output_directory/build-manifest.json"

# Record hashes for every shipped static asset, not only the Python archive.
python3 - "$output_directory" <<'PY_ASSET_MANIFEST'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
manifest_path = root / "build-manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
names = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip",
         "pyodide-lock.json", "numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl",
         "Pyodide-LICENSE.txt", "CPLfold-THIRD_PARTY_NOTICES.md",
         "CPLfold-GPL-2.0-or-later.txt", "CPLfold-LinearFold-LICENSE.txt",
         manifest["cplfoldArchiveFile"]]
manifest["assets"] = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY_ASSET_MANIFEST

printf 'Built browser CPLfold runtime in %s\n' "$output_directory"

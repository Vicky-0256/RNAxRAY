#!/usr/bin/env bash

# Build a narrow RNAlib WebAssembly module for the static RNAxRay Web site.
#
# Requirements: curl, tar, shasum/sha256sum, pkg-config and an active Emscripten SDK
# (emcc, emconfigure, emmake). The deployment workflow supplies the pinned SDK.

set -euo pipefail

readonly RNAXRAY_REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly VIENNA_VERSION="2.7.2"
readonly VIENNA_TARBALL="ViennaRNA-${VIENNA_VERSION}.tar.gz"
readonly VIENNA_SOURCE_URL="https://www.tbi.univie.ac.at/RNA/download/sourcecode/2_7_x/${VIENNA_TARBALL}"
readonly VIENNA_SHA256="1ab5f4a4f76fc85a2243546088e45f5d85f2d7a56cc656e969b005cce9bfab5f"
readonly OUTPUT_DIRECTORY="${RNAXRAY_REPOSITORY_ROOT}/web/vendor/viennarna"
readonly WRAPPER_SOURCE="${OUTPUT_DIRECTORY}/rnaxray_vienna_fold.c"

for rnaxray_command in curl tar pkg-config emcc emconfigure emmake node; do
  command -v "${rnaxray_command}" >/dev/null || {
    printf 'Missing required command: %s\n' "${rnaxray_command}" >&2
    exit 1
  }
done

if command -v sha256sum >/dev/null 2>&1; then
  rnaxray_sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  rnaxray_sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  printf 'Missing SHA-256 tool: install coreutils (sha256sum) or use the macOS shasum command.\n' >&2
  exit 1
fi

if [[ ! -f "${WRAPPER_SOURCE}" ]]; then
  printf 'Missing ViennaRNA wrapper source: %s\n' "${WRAPPER_SOURCE}" >&2
  exit 1
fi

rnaxray_created_build_directory=0
if [[ -n "${RNAXRAY_VIENNA_BUILD_DIR:-}" ]]; then
  rnaxray_build_directory="${RNAXRAY_VIENNA_BUILD_DIR}"
  mkdir -p "${rnaxray_build_directory}"
else
  rnaxray_build_directory="$(mktemp -d "${TMPDIR:-/tmp}/rnaxray-vienna-wasm.XXXXXX")"
  rnaxray_created_build_directory=1
fi

cleanup() {
  if [[ "${rnaxray_created_build_directory}" -eq 1 && "${RNAXRAY_VIENNA_KEEP_BUILD:-0}" != "1" ]]; then
    rm -rf -- "${rnaxray_build_directory}"
  fi
}
trap cleanup EXIT

rnaxray_tarball_path="${rnaxray_build_directory}/${VIENNA_TARBALL}"
rnaxray_source_directory="${rnaxray_build_directory}/ViennaRNA-${VIENNA_VERSION}"

printf 'Downloading ViennaRNA %s source…\n' "${VIENNA_VERSION}"
curl --fail --location --retry 3 --silent --show-error \
  --output "${rnaxray_tarball_path}" "${VIENNA_SOURCE_URL}"
rnaxray_actual_sha256="$(rnaxray_sha256 "${rnaxray_tarball_path}")"
if [[ "${rnaxray_actual_sha256}" != "${VIENNA_SHA256}" ]]; then
  printf 'ViennaRNA source SHA-256 mismatch: expected %s, got %s\n' "${VIENNA_SHA256}" "${rnaxray_actual_sha256}" >&2
  exit 1
fi

tar -xzf "${rnaxray_tarball_path}" -C "${rnaxray_build_directory}"
test -d "${rnaxray_source_directory}"

pushd "${rnaxray_source_directory}" >/dev/null
emconfigure ./configure \
  --host=wasm32-unknown-emscripten \
  --disable-shared \
  --enable-static \
  --disable-pthreads \
  --disable-openmp \
  --disable-simd \
  --disable-naview \
  --without-svm \
  --without-swig \
  --without-perl \
  --without-python \
  --without-kinfold \
  --without-forester \
  --without-rnalocmin \
  --without-rnaxplorer \
  --without-doc \
  --disable-unittests
emmake make -C src/ViennaRNA -j2 libRNA.la
popd >/dev/null

rnaxray_library="${rnaxray_source_directory}/src/ViennaRNA/.libs/libRNA.a"
if [[ ! -f "${rnaxray_library}" ]]; then
  printf 'Expected static RNAlib archive was not built: %s\n' "${rnaxray_library}" >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIRECTORY}"
rm -f -- "${OUTPUT_DIRECTORY}/vienna-rna.js" \
  "${OUTPUT_DIRECTORY}/vienna-rna.wasm" \
  "${OUTPUT_DIRECTORY}/build-manifest.json" \
  "${OUTPUT_DIRECTORY}/COPYING-ViennaRNA.txt"

emcc "${WRAPPER_SOURCE}" "${rnaxray_library}" \
  -I"${rnaxray_source_directory}" \
  -I"${rnaxray_source_directory}/src" \
  -O3 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createRNAxRayVienna \
  -s ENVIRONMENT='web,worker,node' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s NO_EXIT_RUNTIME=1 \
  -s EXPORTED_FUNCTIONS='["_rnaxray_vienna_mfe","_rnaxray_vienna_mfe_constrained","_rnaxray_vienna_cofold","_rnaxray_vienna_version","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["lengthBytesUTF8","stringToUTF8","UTF8ToString"]' \
  "-DRNAXRAY_VIENNA_VERSION=\"${VIENNA_VERSION}\"" \
  -o "${OUTPUT_DIRECTORY}/vienna-rna.js"

cp "${rnaxray_source_directory}/COPYING" "${OUTPUT_DIRECTORY}/COPYING-ViennaRNA.txt"
printf '{\n  "package": "ViennaRNA",\n  "version": "%s",\n  "source": "%s",\n  "sourceSha256": "%s",\n  "buildToolchain": "Emscripten 3.1.57",\n  "entry": "vienna-rna.js"\n}\n' \
  "${VIENNA_VERSION}" "${VIENNA_SOURCE_URL}" "${VIENNA_SHA256}" > "${OUTPUT_DIRECTORY}/build-manifest.json"

node "${RNAXRAY_REPOSITORY_ROOT}/scripts/verify-vienna-wasm.cjs" "${OUTPUT_DIRECTORY}/vienna-rna.js"
printf 'Built ViennaRNA WebAssembly assets in %s\n' "${OUTPUT_DIRECTORY}"

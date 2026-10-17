# Native runtime acquisition and release matrix

The native sidecar is built **on the target operating system and CPU**.  The
repository does not contain guessed download URLs or generated binaries.

## Acquire a verified archive

Obtain a relocatable CPython 3.11 `install_only` archive from the approved
upstream release, record its exact URL and SHA-256, then run on the matching
runner:

```bash
python3 desktop/scripts/acquire-native-runtime.py \
  --platform linux-x86_64 \
  --url "$CPYTHON_URL" \
  --sha256 "$CPYTHON_SHA256" \
  --output /tmp/cpython-runtime
```

Use `--archive path/to/archive.tar.gz` for an air-gapped build.  The command
rejects mismatched hashes, path traversal, links, and archives with multiple
top-level directories.  It does not install Python packages.

Install only the pinned wheels with the acquired interpreter, then stage and
verify on the same runner:

```bash
/tmp/cpython-runtime/bin/python3 -m pip install --no-index --only-binary=:all: \
  --find-links "$WHEELHOUSE" -r desktop/runtime/requirements-native.txt
/tmp/cpython-runtime/bin/python3 -m pip install --only-binary=:all: --require-hashes \
  -r desktop/runtime/requirements-evidence.txt
python3 desktop/scripts/acquire-bowtie2.py --platform linux-x86_64 --output /tmp/bowtie2
python3 desktop/scripts/stage-native.py \
  --standalone-python /tmp/cpython-runtime \
  --source-id "$CPYTHON_URL; sha256=$CPYTHON_SHA256" \
  --bowtie2 /tmp/bowtie2 \
  --output desktop/resources/native
python3 desktop/scripts/verify-native-release.py
```

Windows uses `python/python.exe` and `--platform windows-x86_64`; Linux and
macOS use the corresponding Unix platform identifier.  Never run `stage-native`
with a runtime downloaded for another OS or architecture: it executes a real
Numba and CPLfold smoke test and records the target platform in the manifest.

## Required release matrix

| target | runner | platform argument |
|---|---|---|
| Windows 11 x64 | `windows-2022` | `windows-x86_64` |
| Ubuntu x64 | `ubuntu-22.04` | `linux-x86_64` |
| macOS Intel | `macos-13` | `macos-x86_64` |
| macOS Apple Silicon | `macos-14` | `macos-aarch64` |

Each job must publish the staged `native-manifest.json` and the archive SHA256
as build artifacts.  A missing URL/SHA or an unavailable target wheel is a
failed release, never a reason to fall back to a host virtualenv.

## Bowtie2

`acquire-bowtie2.py` downloads the pinned Bowtie2 2.5.5 release for the
target and checks it against the SHA-256 that GitHub publishes for that
release. It keeps only `bowtie2-align-s` and `bowtie2-build-s` (plus `.exe`
on Windows) and the GPL-3.0 `LICENSE`. These binaries run without the Perl
and Python wrappers, so FASTQ mapping works on Windows with no extra
installs.

`stage-native.py --bowtie2 DIR` copies them to `bin/` and checks them by
building an index and aligning a probe read. `verify-native-release.py`
fails if Bowtie2 is missing, and if any repository source copied into the
bundle (the `SOURCE_DIRS` list in `stage-native.py`) is stale.

Bowtie2 publishes no macOS x86_64 build. An Intel Mac release needs a
self-built binary, or that target ships without FASTQ mapping (SAM input
still works).

## ViennaRNA

`requirements-native.txt` pins `ViennaRNA==2.7.2` next to NumPy and Numba.
It is used for folding energy (`pipeline -e 1`), and binary wheels exist for
every target. `stage-native.py` checks the import with a dimer-fold smoke
test, and `verify-native-release.py` fails if ViennaRNA is missing.

## Evidence worker (RNAcentral MCP)

`requirements-evidence.txt` locks the evidence worker's stack
(`desktop/runtime/evidence/`, contract `desktop/spec/EVIDENCE.md`): the MCP
Python SDK v1 (`mcp[cli]==1.30.0`), `rnacentral-mcp-server==0.1.1` and every
transitive dependency, 46 exact pins (`colorama` and `pywin32` only on
Windows). Each line carries the SHA-256 of every wheel pip selects for
CPython 3.11 on macOS arm64 (macOS 11 to 26 tags), Windows amd64 and Linux
x86_64 (manylinux 2.17 to 2.35), so `--require-hashes` installs succeed on all
three targets. pip and setuptools are not part of the lock. On Linux, pip on
`ubuntu-22.04` picks the `manylinux_2_34` cryptography wheel, so the shipped
runtime then needs glibc 2.34 or newer.

`stage-native.py` checks every applicable pin with `importlib.metadata`,
confirms the modules come from the staged tree, and runs the worker once
(`status` with `connect: true`, then `shutdown`): this starts the fixed
RNAcentral server and lists its tools, without a network request.
`verify-native-release.py` fails when the packages are missing or off-pin.

To change a pin: resolve the new set in a scratch venv made from the bundled
CPython, then for each target run
`pip download --only-binary=:all: --platform <tag> --python-version 3.11
--implementation cp --abi cp311 --abi abi3 --abi none -r <pins> -d <dir>`
(macOS `macosx_11_0_arm64`, `macosx_14_0_arm64` and `macosx_26_0_arm64`;
`win_amd64`; Linux `manylinux_2_17_x86_64` plus `manylinux2014_x86_64`, and
again with every `manylinux_2_NN_x86_64` from 2_35 down). Add the
Windows-only dependencies with `--no-deps`, because pip evaluates environment
markers against the host. Write each wheel's SHA-256 into the file, then
check it with `pip download --require-hashes` for each tag set and
`pip install --require-hashes --target <scratch>` on the host.

# RNAxRay Desktop runtime prototype

`detector.py` is a no-dependency reference implementation for the desktop
runtime bridge. It detects the host platform, the WSL adapter, commands on
`PATH`, repository scripts/jars, and the optional R/DESeq2 package. It emits a
capability matrix that the desktop UI can show at first launch and copy into a
project manifest.

Run it from the repository root:

```bash
python3 -m desktop.runtime.detector --repo-root . --pretty
```

The output is JSON with `platform`, `probes`, and user-facing `capabilities`.
Capability statuses are `available`, `degraded`, `unavailable`, or `unknown`.
`web.analysis` and `web.structure` are always available because they run in the
embedded web layer. Native capabilities only become available when their
required executable or repository component is found.

The detector uses `subprocess.run([executable, *args], shell=False)` and bounds
version probes with a timeout. It is safe to use as a diagnostic source, but a
task runner must still use an explicit command allow-list and validated project
paths. The `CapabilityMatrix.supports(id, allow_degraded=False)` helper makes
this distinction explicit.

`language.numpy` and `language.numba` are probed with the detector's Python
interpreter. The desktop CPLfold capability is available when the native
CPLfold entry point, Python, and NumPy are present. Numba is reported as a
separate acceleration capability: if it is missing, the runtime remains usable
with NumPy but is marked `degraded` and reports that JIT acceleration is off.
The desktop shell can use the native capability to skip the browser-only
CPLfold capacity benchmark; the web build continues to measure Pyodide
capacity in the browser.

[`bundle-manifest.json`](bundle-manifest.json) is the contract for the future
per-platform sidecar. Its startup checks must pass before the adapter advertises
`cplfoldNative=true`.

## Platform behavior

On Windows, `wsl.exe --list --quiet` is queried and the distribution names are
stored in `platform.wsl_distributions`. A configured WSL distribution may make
a later task adapter usable even when a native command is absent. On macOS and
Linux, native commands are preferred; no assumptions are made about package
managers or shell profiles.

## Manifest checks

`project.py` contains the small bootstrap validation subset needed before a
project is handed to the full JSON Schema validator. It rejects absolute paths,
drive-letter paths, NUL bytes, `.`/`..` traversal, duplicate IDs, malformed
hashes, and missing required fields. `validate_project_directory(path,
check_files=True)` additionally checks that referenced inputs, outputs and logs
exist.

## Desktop IPC

`runtime_detect`, `project_create`, `project_validate`, and `project_open` run
their Python call off the UI thread (the Go shell's goroutines) so detection and
file validation do not block the interface. `project_open` accepts a
project directory or its `project.json` and returns `{ok, path, manifest}` only
after validation. Missing or invalid manifests return readable errors.

Release builds resolve `native/desktop/runtime/bridge.py` and
`native/python/bin/python3` (`native/python/python.exe` on Windows) beneath
the app's resource directory (`App.Path(PathResources)`). Missing bundled resources are reported explicitly.
Development builds can fall back to the checkout. For an explicit development
override set `RNAXRAY_REPOSITORY_ROOT` and optionally `RNAXRAY_PYTHON`; an override
does not make the bundle portable or establish native folding support.

## Native runtime staging

`python3 desktop/scripts/stage-native.py` stages the Python bridge, CPLfold source,
parameter tables, licenses and a runtime into `desktop/resources/native/`. `go tool mygo build`
copies this directory (a platform resource of `desktop/app`) into the application resources under `native/`.

The earlier proposed Python 3.13 / Numba 0.60 combination was incompatible. Release
staging now requires CPython 3.11.x with the exact wheel versions in
`requirements-native.txt`. Each operating system and architecture must be built
and checked on that target; this script does not cross-compile Python.

### Development checkout

```bash
python3 desktop/scripts/stage-native.py \
  --development-python "$PWD/.venv-cplfold/bin/python"
```

This uses the existing host interpreter via a small launcher. The manifest says
`portable: false` and `mode: development-external-python`. An app built from
this staging directory **still requires that original local environment**. It is
not a standalone installer. The checked local environment is CPython 3.9.6 with
NumPy 1.24.4, Numba 0.58.1 and llvmlite 0.41.1.

### Standalone release candidate

Obtain a pinned, relocatable CPython 3.11 distribution for the target platform
(for example a verified python-build-standalone install-only archive). Record
its exact source URL and SHA256. Install dependencies into that distribution
using its own interpreter and a target-platform wheelhouse:

```bash
/path/to/python/bin/python3 -m pip install --no-index --only-binary=:all: \
  --find-links /path/to/wheelhouse -r desktop/runtime/requirements-native.txt
python3 desktop/scripts/stage-native.py \
  --standalone-python /path/to/python \
  --source-id 'exact archive URL; sha256=verified archive digest' \
  --output desktop/resources/native-release
```

Use a fresh destination: staging refuses to overwrite existing resources. Once
validated, arrange the selected release directory at `desktop/resources/native`
before building the app (`go tool mygo build`). Do not copy a Homebrew installation or a venv and label it
portable. The script rejects venvs, escaping Python symlinks and imported modules
or base prefixes outside the staged bundle. No download or dependency install is
silently performed by staging.

Every staging operation checks exact package versions, executes real Numba
`njit` code, and runs the CPLfold reference sequence, expecting the reference
pseudoknot structure and -8.02 kcal/mol energy. It writes a `native-manifest.json`
with mode, interpreter, architecture, test evidence, source identifier, and
SHA256 hashes of all regular staged files. Temporary JIT caches stay outside the
application resources. These checks establish that the runtime works on the
build machine; standalone candidates also need relocation and clean-machine
checks, plus platform signing, before release. Source identifiers are recorded,
not independently downloaded or verified by this script. Preserve the vendored
`THIRD_PARTY_NOTICES.md` distribution constraints.

## Release preflight

Before a release build, run:

```bash
python3 desktop/scripts/verify-native-release.py \
  --resource-root desktop/resources/native
```

The preflight is intentionally strict. It fails when the directory is missing,
the manifest is absent or nonportable, the source archive SHA256 is missing,
the target architecture differs, any manifest hash or required license notice is
missing, or the bundled interpreter cannot import the pinned packages, execute
Numba JIT, and reproduce the CPLfold reference fold. A development manifest that
points at `.venv-cplfold` always fails. On this checkout the expected result is a
failure until a real relocatable CPython 3.11 runtime is supplied; this is
intentional and prevents a developer build from being released as a standalone
APP.

## Task lifecycle IPC

The desktop IPC exposes `task_start`, `task_status`, and `task_cancel`. The
current release allowlists `validate_project` and invokes the bundled Python
bridge through an argv array; unsupported engines return an explicit
unavailable error. Every task has `runs/<task-id>/status.json` (written only
by the Go task scheduler, `desktop/app/core/tasks.go`), `stdout.log`, and `stderr.log`; the Python child
(`bridge --request runs/<task-id>/task-request.json`) writes its own response
to `runs/<task-id>/result.json`. When a task finishes, the scheduler calls the bridge
operation `register_task_run {path, task_id}`, which idempotently upserts the
manifest `runs` entry. IDs are validated and run directories are confined to
the project. When the finished task is a successful `structure` run, its
`result.json` `structure` entry is also upserted into `structures[]`
(`{id, task_id, sample_ids, gene_id, mode, windows, parameters, created_at,
paths: {dbn, pairs, ct, meta}, summary}`, paths project-relative under
`structures/<task_id>/`).

`open_project` and `list_samples` normalize stale sample stages: a stage left
`queued`/`running` whose `runs/<task_id>/status.json` (read only; the scheduler writes
it) is missing or terminal is saved as `interrupted` (`failed`/`cancelled`
when the task record says so). Queued/running task records are left alone.

## Project read operations (desktop UI)

- `list_samples {path}` -> `{samples: [<sample> + {ready, stage_summary}],
  conditions: [{name, sample_ids}], references: [<reference> incl.
  sequences [{name, length}]], normalized: [...]}`. `ready` = the analysis
  index exists; `stage_summary` is `pending|running|done|failed|interrupted`.
- `list_structures {path}` -> `{structures: [<structures[] entry> +
  {available}]}`, newest first.
- `read_structure {path, structure_id}` -> `{structure, meta, records:
  [{window_start, window_end, sequence, dbn, pairs: [[i, j]], energy}]}`;
  coordinates are 1-based gene positions.
- `compare_bins {project_path, sample_ids_a, sample_ids_b, gene, bin_size,
  region?, max_cells?, fixed_bin?, gene2?, types?, measure?, orientation?}`
  (alias `analysis_compare_bins`) -> `{result: {bin_size, length, x, y, a, b,
  log2ratio, a_count, b_count, library_a, library_b, pseudocount, ...}}`;
  `a`/`b` are counts per million records of each side.
- `analysis_contact_bins` also takes `orientation: "oriented"|"both"` and
  `fixed_bin`; `analysis_summary` reports `extents: {gene: {min, max}}` and
  reference `length`s for genes of the samples' references.

## Sidecar mode

`python -m desktop.runtime.bridge --repo-root <root> --serve` reads one
`{"id": <int>, "request": {...}}` JSON line per request from stdin and writes
exactly one `{"id": <int>, "response": {...}}` line to stdout. Errors become
`{"ok": false, "error": "..."}`; an unparseable line is answered with
`"id": null`. Everything else printed while handling a request goes to stderr.
EOF on stdin exits with status 0. The loaded CPLfold module is cached for the
process lifetime so Numba JIT work is reused; `NUMBA_CACHE_DIR` is honoured.

`project.json` writes take an exclusive lock on `project.json.lock`, re-read
the manifest inside the lock, and replace it atomically.

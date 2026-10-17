# RNAxRay Desktop

The desktop product: one local project, from raw chimeric reads to RNA
structure. It is a Go program using [MyGo](https://mygo.egoist.dev) native UI
(no webview, no cgo) over a bundled Python runtime. It works offline and does
not share code with the web deployment (`web/`) beyond the Python analysis
packages and the project format.

| Directory | Contents |
|---|---|
| `app/` | The application (Go module `rnaxraydesktop`): `core/` runtime link, task scheduler, preferences; `views/` the native pages; `widgets/` heatmap, arc and profile widgets; `model/` typed project data |
| `runtime/` | `bridge.py`, the Python process boundary (project, samples, analysis queries, `compare_run`, `structure_run`) and its tests |
| `resources/native/` | The staged runtime (CPython 3.11 + numpy/numba/ViennaRNA, Bowtie2, the Python sources), made by `scripts/stage-native.py`; not in git |
| `scripts/` | Runtime acquisition, staging and release verification |
| `spec/` | Project, task, capability and result schemas (`PROTOCOL.md`) |
| `task-runner/` | The structured child-process contract used by the bridge |

See `../MYGO_DESKTOP_PLAN.md` for the migration from the former Tauri shell and
`../RAWDATA_APP_PLAN.md` for the product plan.

## Prerequisites

- Go 1.27 or newer. MyGo itself is pinned in `app/go.mod` and its CLI runs as
  `go tool mygo`.
- For running against real data: the staged runtime in `resources/native/`
  (see below). Development builds fall back to it automatically.

Native UI needs nothing else on macOS and Windows; on Linux it needs GTK 3.

## Run and build

```bash
cd desktop/app
go tool mygo dev                      # development app with live reload
go tool mygo build -skip-dmg          # build/darwin-arm64/RNAxRay Desktop.app
go tool mygo build -platform windows/amd64,linux/amd64
```

The runtime ships as one archive per platform,
`app/resources/<platform>/native.tar.gz` with its `.sha256` (not in git),
because MyGo leaves hidden files out of resources and the runtime needs some
(`numpy/.dylibs`, `numpy/.libs`). The app unpacks it on first launch into its
cache directory (`runtime/runtime-<sha>/native`, a few seconds) and reuses it
afterwards. Stage and pack it with:

```bash
python3 desktop/scripts/stage-native.py --standalone-python <cpython> \
  --bowtie2 <bowtie2 dir> --source-id "<source id>" --output <empty dir>
python3 desktop/scripts/verify-native-release.py
python3 desktop/scripts/pack-runtime.py --platform darwin-arm64   # or windows-amd64, linux-amd64
```

In development builds `RNAXRAY_REPOSITORY_ROOT` / `RNAXRAY_PYTHON` select another
runtime; packaged builds ignore them.

## How it works

- `core.Runtime` keeps two persistent Python sidecars (`bridge --serve`,
  newline JSON, contract C1): `control` for project operations and `compute`
  for analysis queries, so Numba stays warm (`NUMBA_CACHE_DIR` in the app
  cache).
- Long jobs (`sample_pipeline`, `analysis_index`, `structure`, `compare`, ...)
  run as one child process each under `core.Scheduler`: a CPU/memory budget
  (Preferences), FIFO admission, `runs/<id>/status.json` written by Go,
  `progress.json` and `result.json` by Python, cancel of the whole process
  tree, resume from the stored request, and registration in `project.json`
  when a task ends. Tasks still running at exit become `interrupted`.
- Samples: one maps at a time with every CPU (a machine-wide map slot,
  `RNAXRAY_MAP_SLOT`); while it maps, the next sample starts early and
  prepares its reads on one core (6–15% faster batches on an M1 Pro,
  `TestOverlapBenchmark`).
- Time estimates (`core/perf.go`): every finished sample adds its active
  time to `performance.json` beside the preferences; the Run dialog shows
  the expected time of a batch and the task drawer the time left, from
  this computer's speed (a built-in rate until the first sample is done).
  Structure folds likewise: the New fold form shows the expected time and
  memory (time ~ length^1.7 x beam), folds that compiled the Numba kernels
  (the first after an install, ~1 min) are not recorded as speed.
- Project and analysis operations are allowlisted in `core/service.go`.
- `project.json` writes are locked and atomic (Python side).

## Pages

One project, one navigation; the top bar holds the reference, gene and the
current selection (a sample, or a condition = its replicates merged), the
task drawer and Preferences.

1. **Data**: references and samples; import a data folder (samples,
   conditions, replicates and references matched from the file names and
   reviewed before import), single raw files or a sample sheet (dry-run
   preview); run/resume pipelines after a disk estimate, check and relink
   inputs. A new project can name its data folder on the start page.
2. **QC**: per-sample and merged counts.
3. **Explore**: contact map, interactions, viewpoint and region, from the
   per-sample SQLite indexes.
4. **Compare**: the DESeq2 differential test (numpy port, validated against
   R), rnaxray's similarity heatmap of the two groups (bin/plot_similarity_map
   on each group's merged map; identical to the CLI on the ZIKV ZAFR vs ZILM
   virion data) and the CPM quick view; Locate, Region and Fold A & B.
   Two panels per test, for a lineage comparison figure:
   - *Enriched regions*: for each direction, the most significant merged
     interaction (padj < 0.01) that the enriched lineage's own whole-RNA
     fold forms (a pair within ±50 nt of both arms), its two windows
     (those pairs ± 15 nt) cut from both lineages' folds and drawn as 2D
     diagrams (RNAplot layout, windows joined by a 3-nt linker), with pairs
     inside / between the windows and the partners outside; another
     candidate, the reach and flank can be chosen (`structure_regions`,
     `runtime/regions.py`).  B's fold, and cells of condition two, move onto
     A's coordinates by the Structure page's alignment (`runtime/seqmap.py`
     is a port of `app/seqmap`).
   - *Folding energy*: an `energy` task cofolds (RNAcofold, ViennaRNA
     defaults) 2 × 40 nt around the arms of every interaction with
     padj < 0.01 in both lineages' sequences and shows violins with a paired
     t-test per direction (`runtime/energy.py`; stored as
     `comparisons/<id>/energy_L40.tsv/.json`, also in the HTML report).
   On ZIKV AFR vs ILM both reproduce reproduce_zikv/analysis
   (select_regions_cplfold.py, window_from_structure.py,
   folding_energy.py + folding_energy_stats.R).
5. **Structure**: CPLfold genome and window folds with chimera evidence, and
   the arc viewer comparing two structures.  A structure folded on another
   reference (another strain) is moved onto A's coordinates by a banded
   global alignment (`app/seqmap`), so arcs and shared pairs compare the
   same nucleotides.  A Compare test can be overlaid as differential arcs
   (higher in condition one above, two below, padj cutoff), with the
   structures in one colour, and the reference's gene annotation (GenBank,
   GFF/GTF, BED or TSV, attached with "Gene annotation…") is drawn as a
   track; a GenBank file's own sequence is aligned to the reference first.
6. **Report**: the project summary and its HTML export.

## Checks

```bash
cd desktop/app
CGO_ENABLED=0 go test ./... && go vet ./... && go tool mygo vet . && gofmt -l .
RNAXRAY_SNAPSHOT_DIR=/tmp/snap CGO_ENABLED=0 go test ./views/   # PNG snapshots of the pages
RNAXRAY_E2E_SHEET=<samples.tsv> CGO_ENABLED=0 go test -tags e2e -run TestEndToEnd -timeout 60m -v .

cd ../..
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s desktop/runtime/tests -p 'test_*.py'
```

The view tests run headless (`ui.NewTester`) against a fake backend with
fixtures captured from a real project; `integration_test.go` and the e2e test
drive the views against the real core and bridge. CI runs all of this on
Windows, Linux and macOS (`.github/workflows/desktop-native.yml`).

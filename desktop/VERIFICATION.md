# Desktop verification — 2026-10-14 (MyGo native shell)

Scope: the native desktop app in `desktop/app` (MyGo v0.4.8, Go 1.27.2,
no cgo) over the bundled runtime, replacing the Tauri shell. The earlier
Tauri verification (2026-10-08) is in git history.

## Environment

- macOS 26.6.2, Apple Silicon arm64, 10 cores, 32 GB
- Go 1.27.2 (Homebrew), MyGo v0.4.8 (`app/go.mod`)
- Bundled runtime: CPython 3.11.17 (python-build-standalone), numpy 1.24.4,
  numba 0.58.1, ViennaRNA 2.7.2, Bowtie2 2.5.5

## Checks

| Check | Result |
|---|---|
| `CGO_ENABLED=0 go test ./...` (app, core, views, widgets) | Passed |
| `go vet ./...`, `go tool mygo vet .`, `gofmt -l .` | Clean |
| `GOOS=windows` / `GOOS=linux` `go vet` and `go test -c` | Passed (compile only) |
| core: ported tasks.rs / prefs.rs / main.rs tests, real-bridge task end to end, cancel kills the whole process tree | Passed |
| `integration_test.go`: views on the real core and bridge (create project, add sample, index task, sample becomes selectable) | Passed, 1.2 s |
| `e2e_test.go` (tag `e2e`): ZIKV data through the views — new project, sample sheet import (preview), pipelines for 2 FASTQ subsets + 2 linked .hyb from the Data page after the disk estimate, QC counts, DESeq2 test, contact map, window fold shown in the arc viewer | Passed, 102 s |
| Python runtime and pipeline tests (bundled interpreter, `PYTHONDONTWRITEBYTECODE=1`) | Passed |
| `go tool mygo build -skip-dmg` | `build/darwin-arm64/RNAxRay Desktop.app`, 211 MB, no `.pyc` |
| Launch the built app: sidecars start from the bundle, stop on quit | Passed |
| Page snapshots (headless tester PNGs, light and dark) reviewed for every page | Done |

## Not verified here

- Running the app on Windows and Linux (CI workflow `desktop-native.yml`
  covers build, vet and tests there).
- Clicking through the real window on macOS: this host's terminal has no
  screen-recording or accessibility permission, so interaction was verified
  with the headless tester instead.
- Signing and notarization (builds are ad-hoc signed).

# New-user flow acceptance — 2026-10-16

`flow_acceptance_test.go` (tag `e2e`) drives the native views over the real
core and bundled runtime with real ZIKV reads (subsets of `ZAFR_REP1.fastq`
and `ZAFR.fasta`), offline, and checks that task status, files on disk and
the page agree at each step. Repeat it with:

```bash
# data: main/{ok,moved}_rep1.fastq (20k reads each), big_rep1.fastq (3M reads),
#       broken_rep1.fastq.gz (truncated gzip), ZAFR.fasta; extra/noref_rep1.fastq
cd desktop/app && go test -c -tags e2e -o /tmp/flow.test .
RNAXRAY_FLOW_DATA=<data> RNAXRAY_FLOW_OUT=<empty dir> RNAXRAY_SNAPSHOT_DIR=<dir> \
  sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))' \
  /tmp/flow.test -test.run '^TestAcceptanceFlow$' -test.v
```

`<out>/flow-result.json` records every step; the PNGs are headless renders.

| Case | Checked | Result |
|---|---|---|
| Success | task succeeded, map/hyb/index done, .hyb and index files exist, Explore shows the .hyb's 153 hybrids | Pass |
| No reference | import warns, Check inputs counts it, row shows No reference, Run leaves it out and says so, no task | Pass |
| Moved reads file | Check inputs shows missing + Relink; run fails with the reason in the row, map failed, no index | Pass after fix (was shown as pending) |
| Failing task (truncated .gz) | task failed, map failed with the EOFError reason, Resume, no Explore, no index | Pass |
| Cancel (3M reads, while mapping) | task cancelled, map cancelled, no .hyb/index, Resume | Pass |
| Offline lookup | lookup shows RNAcentral error / nothing concluded, not "not found"; connection test does not claim RNAcentral was reached | Pass after fix (said "Connected") |
| Reopen (new runtime, Recent projects) | every row keeps its status, the still-moved file is marked missing with Relink (inputs are checked on open), Explore shows the same hybrids, Report says 5 (1 analysed) | Pass after fix (missing was shown only after Check inputs) |
| Report: pipeline settings and inputs (reopened) | ok_rep1 shows the settings from its run checkpoint (blast_threshold 0.1 · max_overlap 4 · max_hits 10 · energy off · pipeline format …); a failed sample says "no hybrids: the last run failed at map", not "not run"; each input file has its size and fingerprint | Pass (added 2026-10-16, run final-d exit 0) |
| Damaged index | Explore shows "Could not load…", not an empty result | Pass |

Also: the built app (`mygo build -skip-dmg` with the packed runtime) launched,
unpacked its runtime, showed the start page in its real window (window
capture by id) and stopped its sidecars on quit. Its window was not clicked:
this host denies accessibility access to scripted input.

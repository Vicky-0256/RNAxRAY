<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/assets/rnaxray-wordmark-dark.svg">
    <img src="web/assets/rnaxray-wordmark.svg" alt="RNAxRay" height="72">
  </picture>
</p>

<p align="center"><strong>Explore RNA–RNA interactions from proximity-ligation experiments, and fold RNA structures guided by them.</strong></p>

<p align="center">
  <a href="https://vicky-0256.github.io/RNAxRAY/"><strong>Open RNAxRay Web</strong></a> ·
  <a href="https://github.com/Vicky-0256/RNAxRAY/releases/latest"><strong>Download RNAxRay Desktop</strong></a>
</p>

RNAxRay reads the chimeric reads of CLASH, PARIS, COMRADES and similar experiments, shows where two RNAs (or two parts of one RNA) touch, compares conditions, and folds structures with **CPLfold**, which turns the chimeric reads into soft evidence for base pairs and can predict pseudoknots.

It comes in two forms that share the same analysis pages and folding engine:

| | **RNAxRay Web** | **RNAxRay Desktop** |
|---|---|---|
| Runs | In the browser, nothing to install | On your computer (macOS, Windows, Linux) |
| Starts from | `.hyb` / `.hyb.gz` files | Raw reads: FASTQ, FASTA or SAM, plus a reference FASTA |
| Pipeline | — | Bowtie2 mapping → hybrid calling → QC → `.hyb` |
| Analysis | Overview, Interactions, Contact Map, Viewpoint, Region Explorer, Compare, RNA Structure, Report | The same, saved as projects on disk |
| CPLfold | 75 nt, up to 500 nt after a one-time capacity test | Native; the limit is set by memory, about 6,500 nt with 8 GB |
| Your data | Stays in the browser tab | Stays on your computer; works offline |

## RNAxRay Web

**https://vicky-0256.github.io/RNAxRAY/**

Drop a `.hyb` file on the start page (up to about 50 MB works comfortably), optionally add the reference FASTA, and enter the analysis. No account is needed and no file leaves the browser: the page has no upload endpoint, and parsing, statistics and folding all run locally in Web Workers and WebAssembly. To see it without data, choose **Try example**, the ZIKV virion data set (ZAFR vs ZASI).

| Page | What it shows |
|---|---|
| Overview | Records, RNAs, chimera types and the top partners of the loaded files |
| Interactions | Every interaction, filterable and sortable, with the two arms of each read |
| Contact Map | Where the two arms land, as a heatmap for one RNA or a pair of RNAs |
| Viewpoint | How often one region contacts every position of its partner |
| Region Explorer | One region's sequence, coverage and partners |
| Compare | Two conditions: DESeq2 differential contacts (in the browser), similarity heatmap, arc map, and folding energies around the arms |
| RNA Structure | Fold a region with ViennaRNA (up to 2,000 nt, 3,000 with confirmation) or CPLfold, optionally guided by the HYB reads; five views of the structure and exports (DBN, CT, base pairs, SVG, PNG) |
| Report | Every result in one place, exported for people (PDF, HTML), for AI tools (README, JSON, TSV) and for further analysis |

**How long can the browser fold with CPLfold?** CPLfold runs in the browser through Pyodide. It folds 75 nt straight away; **Test** on the RNA Structure page measures this browser once (about 15 MB to download, up to a minute), after which it folds up to 500 nt. The result is remembered for this browser and these CPLfold settings. For longer RNAs, use RNAxRay Desktop.

## RNAxRay Desktop

**[Download the latest release](https://github.com/Vicky-0256/RNAxRAY/releases/latest)**

| System | Installer |
|---|---|
| macOS, Apple silicon (M1 or later) | [`RNAxRay-Desktop-macOS-arm64.dmg`](https://github.com/Vicky-0256/RNAxRAY/releases/latest/download/RNAxRay-Desktop-macOS-arm64.dmg) |
| Windows 10/11, 64-bit | [`RNAxRay-Desktop-Windows-x64-Setup.exe`](https://github.com/Vicky-0256/RNAxRAY/releases/latest/download/RNAxRay-Desktop-Windows-x64-Setup.exe) |
| Linux x86-64 (Debian/Ubuntu) | [`RNAxRay-Desktop-Linux-x64.deb`](https://github.com/Vicky-0256/RNAxRAY/releases/latest/download/RNAxRay-Desktop-Linux-x64.deb) |
| Linux x86-64 (other) | [`RNAxRay-Desktop-Linux-x64.tar.gz`](https://github.com/Vicky-0256/RNAxRAY/releases/latest/download/RNAxRay-Desktop-Linux-x64.tar.gz) |

Check a download against [`SHA256SUMS.txt`](https://github.com/Vicky-0256/RNAxRAY/releases/latest/download/SHA256SUMS.txt). Intel Macs and ARM Linux/Windows have no installer yet; use the [command-line pipeline](bin/README.md) there.

The app is not code-signed yet. On first launch, macOS asks you to allow it in **System Settings → Privacy & Security → Open Anyway**; Windows SmartScreen asks under **More info → Run anyway**.

The installer bundles everything it needs (Python, NumPy, Numba, ViennaRNA, Bowtie2), so there is no conda environment to set up. One project holds the whole analysis:

1. **Data**: add references and samples, or import a data folder (samples, conditions and replicates are matched from the file names and shown for review). The app checks the disk space, then maps the reads and calls the hybrids; runs can be resumed.
2. **QC**: read and hybrid counts per sample and per condition.
3. **Explore**: contact map, interactions, viewpoint and region.
4. **Compare**: DESeq2 differential test between two conditions, similarity heatmap, enriched regions drawn from both conditions' folds, and folding energies around the interacting arms.
5. **Structure**: CPLfold for a whole RNA or windows of it, with the chimeric reads of chosen samples as evidence; the arc viewer compares two structures, also across strains, with differential contacts and gene annotation as tracks.
6. **Report**: the project summary and its HTML export.

Native CPLfold has no capacity test. The page shows how long one fold may be on this computer, from the memory budget in Preferences (about 6,500 nt pseudoknot-free with 8 GB, 13,000 nt with 32 GB); longer RNAs are folded in windows.

## CPLfold

CPLfold builds on LinearFold. Phase 1 enumerates a few nested scaffolds under an objective that adds a bonus to base pairs supported by chimeric reads (weight α); Phase 2 adds crossing pairs under the scaffold constraints; the candidates are then re-scored with a pseudoknot energy model (DP09 by default), with β biasing the choice towards pseudoknots. Decoding is near-linear in length, so a 10,807-nt viral genome folds in one run.

The browser and desktop builds run the same Python sources (`third_party/cplfold`, `web/cplfold`); the desktop build adds Numba-compiled kernels with byte-identical results. See [bin/cplfold-python.md](bin/cplfold-python.md).

## Repository

| Path | Contents |
|---|---|
| `web/` | RNAxRay Web, a static site deployed to GitHub Pages by `.github/workflows/deploy-pages.yml` ([web/README.md](web/README.md)) |
| `desktop/` | RNAxRay Desktop: the Go app (`app/`), its Python runtime bridge (`runtime/`), project schemas (`spec/`) and release scripts ([desktop/README.md](desktop/README.md)) |
| `pipeline/` | The Python pipeline (`rnaxraypipe`: reads → `.hyb`) and analysis (`rnaxrayanalysis`: indexes, coverage, DESeq2), with golden tests |
| `third_party/cplfold/` | CPLfold |
| `bin/` | The original command-line tools ([bin/README.md](bin/README.md)) |
| `scripts/` | Build scripts for the browser's WebAssembly runtimes and the web checks |
| `data/` | Small test data |

## Development

```bash
# the website, locally
python3 -m http.server 4173 --directory web        # open http://localhost:4173/

# the web checks (ViennaRNA's needs its built module)
for f in scripts/verify-*.cjs; do
  arg=; [ "$f" = scripts/verify-vienna-wasm.cjs ] && arg=web/vendor/viennarna/vienna-rna.js
  node "$f" $arg || break
done

# the desktop app (Go 1.27+; MyGo is pinned in go.mod)
cd desktop/app
go tool mygo dev                                    # development app
go test ./... && go vet ./... && go tool mygo vet .

# the Python pipeline and desktop runtime
python3 -m unittest discover -s pipeline/tests -p 'test_*.py'
python3 -m unittest discover -s desktop/runtime/tests -p 'test_*.py'
```

The browser's ViennaRNA and CPLfold runtimes are built by `scripts/build-vienna-wasm.sh` and `scripts/build-cplfold-web.sh` (CI builds them on every deploy). A version tag `v<version>` (the version in `desktop/app/mygo.json`) builds and publishes the desktop installers.

## Licence

RNAxRay is free software under the [MIT licence](LICENSE), copyright the RNAxRay authors ([`AUTHORS`](AUTHORS)); to cite it, see [`CITATION.cff`](CITATION.cff). This covers the web app, the desktop app and the build scripts. Three parts keep the licence of the code they come from:

- `pipeline/` ports scripts from [hyb](https://github.com/gkudla/hyb) and is GPL-3.0-or-later ([`pipeline/NOTICE.md`](pipeline/NOTICE.md)).
- `bin/` contains scripts from hyb and [comrades](https://github.com/gkudla/comrades) and is GPL-3.0, apart from the three RNAxRay files listed in [`bin/NOTICE.md`](bin/NOTICE.md).
- `third_party/cplfold/` is described below.

Every third-party component in the repository, the website and the desktop app is listed, with its licence, in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

CPLfold's own code is licensed GPL-2.0-or-later by its author ([`third_party/cplfold/LICENSE`](third_party/cplfold/LICENSE)), as is its HotKnots-derived energy evaluator. Its LinearFold-derived parser keeps LinearFold's terms, which add conditions beyond the GPL, so the combination does not yet have one resolved licence; see [`third_party/cplfold/THIRD_PARTY_NOTICES.md`](third_party/cplfold/THIRD_PARTY_NOTICES.md), with the upstream texts in `third_party/cplfold/LICENSES`. The bundled ViennaRNA, Bowtie2, Pyodide and other components keep their own licences, listed with their files.

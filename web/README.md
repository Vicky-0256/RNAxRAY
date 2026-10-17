# RNAxRay Web

This directory is a static application intended for GitHub Pages. The deployed
artifact self-hosts its pinned WebAssembly/Python runtimes and makes no runtime
CDN or backend requests.

## Local preview

Run a static server from the repository root:

~~~bash
python3 -m http.server 4173 --directory web
~~~

Then open http://localhost:4173/.

## Deployment

The repository workflow at `.github/workflows/deploy-pages.yml` builds and
verifies this directory. Public artifact upload and deployment stay disabled
unless the repository Actions variable `CPLFOLD_DISTRIBUTION_APPROVED` is set
to `true`. Set it only after the CPLfold combined-distribution boundary below
has qualified licence review or the required permission. The published source
is the dedicated `feature/cplfold-web` branch; `main` remains unchanged. Choose
**GitHub Actions** as the publishing source in **Settings → Pages** before the
first deployment.

## Data access and embedding the analysis pages

Analysis pages (Overview, Interactions, Contact Map, Viewpoint, Region
Explorer, Compare, RNA Structure, Report) read data only through a
**DataProvider**; they never read files or parsed rows. The full contract,
with exact argument and return shapes, is the header comment of
`data-provider.js`. In short, every method is async and takes a selection
`{ datasetIds: [...] }` (one dataset, or several merged with counts summed):

| Method | Returns |
|---|---|
| `listDatasets()` | `[{ id, label, fileName, fileSize, sha256, condition, primary, validRecords, supportInteractions, rnaNames, reference }]` |
| `getSummary(sel)` | parser summary shape + `rnaExtents` |
| `getContactBins(sel, { rnaX, rnaY, binSize, measure, orientation, chimeraType, homodimer, maxCells?, region? })` | `{ binSize, length, length2, x: [], y: [], count: [], records: [], support: [], total, max, ... }` |
| `queryHybrids(sel, { filters?, region?, cell?, indices?, order?, offset, limit })` | `{ total, offset, limit, order, rows }` |
| `getTopInteractions(sel, { by: "partner" \| "pair" \| "bin", ... })` | `{ total, rows }` |
| `getSequence(sel, { rna, start?, end? })` | `{ rna, referenceId, start, end, length, sequence }` or `null` |
| `getArms(sel, { rna?, partner?, chimeraType?, homodimer?, start?, end? })` | columnar `{ total, index, id, rnaOne, oneStart, oneEnd, rnaTwo, twoStart, twoEnd, support, homodimer, chimeraType }` |

`BrowserProvider` implements it over the rows parsed by `parser.worker.js`;
the website shell registers each parsed file with `addDataset()` (Compare
files become extra datasets). `page-data.js` turns provider results into the
view state the synchronous page renderers use.

`app.js` auto-mounts the website on `#app`. A host can instead mount only the
analysis pages:

~~~js
window.RNAXRAY_AUTO_MOUNT = false; // before app.js loads
await RNAxRayWeb.ready();
const view = RNAxRayWeb.mount(hostElement, {
  provider,                       // any DataProvider implementation
  shell: false,                   // no landing page, nav, uploads or help pages
  selection: { datasetIds: ["sample-1"] },
  page: "overview",
  onNavigate: ({ pageId, previousPageId, reason }) => {},
  onRequestFold: ({ source, region, partnerRegion, arms, selection }) => {}
});
view.navigate("contact-map");
await view.setSelection({ datasetIds: ["s1", "s2"] });
await view.refresh();   // re-query the provider (e.g. after new results)
// Cross-page paths: open a page focused on a bin or a region.
view.focus({ page: "contact-map", contact: { rnaX, rnaY, binSize, selection: { x, y } } });
view.focus({ page: "region", region: { rna, start, end, partner, partnerStart, partnerEnd } });
view.destroy();
~~~

With `onRequestFold`, Contact Map, Region Explorer and Compare offer "Fold this
region" and hand the region to the host instead of opening the structure page.
`RNAxRayWeb.loadProjectFiles()` and `restoreSession()` still work for the current
desktop build but are deprecated.

## Privacy model

The page has no analytics, API call, runtime CDN request, or server-side upload path. HYB data and folding inputs are processed in Web Workers and held in tab memory only. ViennaRNA, Pyodide, NumPy, and the CPLfold source archive are served from the same GitHub Pages artifact.

The landing flow is intentionally two-stage: after the HYB file is parsed, the page stays on a local file-review screen. Users can add or replace the optional reference FASTA there, then click **Enter analysis** to open the workspace. Interaction tables and contact maps do not require FASTA; reference-based RNA structure and full-reference Viewpoint do.

## Shared UI conventions

`ui-kit.js` / `ui-kit.css` hold what the pages share: colour bars
(`RNAxRayUiKit.legend.html / svg / drawCanvas`, drawn into PNG and SVG exports
as well as on the page), round axis ticks (`RNAxRayUiKit.niceTicks`), and the
Export menu (`<details class="export-menu">`: every download of a page sits
in one menu, closed by an outside click, Escape or a chosen item). Tables
mark number columns `.num` (right-aligned, tabular figures) and long names
`.cell-truncate` with the full name in `title`. Image exports are drawn in
the light theme whatever the page's theme. Labels use the `--text-label`
(12px) and `--text-caps` (11px, uppercase) tokens in `styles.css`.
`scripts/ui-screenshots.py` takes before/after screenshots with the example
loaded and both Compare tests run; `scripts/verify-ui-kit.cjs` checks the kit.

## Report and result exports

After entering the workspace, choose **Report** in the header or sidebar. The
report page consolidates the current session's summary, validation, interaction
filters, Contact Map, Viewpoint, Region Explorer, Compare (with panels A to G
of the summary figure) and RNA Structure state, with the scope, version and
generation time at the top.

Everything the report states comes from one result record (`results.js`):
13 steps (S01 to S13) and 41 results (R01 to R41) with fixed ids, units,
definitions and a status (`ok`, `no_result`, `not_run`, `running`, `failed`,
`stale`, `pending`). A step that did not run is `not_run` and its results are
null, never 0. The page is in five parts with a contents
list: analysis objects and status (with each step's scope and an optional
purpose the researcher writes), main results, figures and data, methods and
sources, limitations and warnings. Numbers carry their result ids (for
example "Cells · R10") and every chart and table names the data file behind
it.

**Export** offers three packages, all built in the tab without uploading:

- **For people**: Print / Save PDF, or one offline HTML file with the styles
  and images inlined.
- **For AI**: `README.md`, a template `report.md` (no language model),
  `summary.json`, `data_dictionary.json`, `provenance.json`, `evidence.json`,
  bounded tables and `manifest.json` (sizes and SHA-256), as a ZIP or file by
  file, plus **Copy AI summary**.
- **For further analysis**: the full tables (every filtered record up to one
  million, every comparison cell, significant cells, regions, folding
  energies), the structures as dot-bracket and the figure SVGs, with the same
  dictionary, provenance and manifest.

Both packages carry `schema/` with a JSON Schema (2020-12) for each RNAxRay
JSON file (summary, provenance, data dictionary, evidence, structure; each
file names its own in `$schema`) and, under `results/`, every structure as
dot-bracket and as JSON with base pairs, coordinates and candidates.

Every result also has a `nature` (count, setting, descriptive,
statistical_test, prediction, derived_from_prediction, external_source),
each step its completion time where the module keeps one, and the record a
run id that changes when the inputs, settings, step results or completion
times change. Explanatory notes cite the steps, results or sources they
rest on. Unticking steps under Analysis status makes a "Selected results
report": the page and every export leave those steps out and say so. The
export panel lists each file's fields and lets the researcher leave files
out; README.md and manifest.json record what was left out. The input files
are never included, only their names and digests.
`scripts/verify-results.cjs` checks that the report page, Markdown, JSON and
tables agree; `verify-example.cjs` checks the record on the included example.

## Included example

**Try example** on the landing page loads the ZIKV virion comparison of the
ZAFR vs ZASI summary figure (`example.js`, files in
`assets/examples/zikv-virion/`, 6.9 MB, fetched only when it is used):
1-in-10 subsets (every 10th record) of ZAFR_REP1/2 (African lineage,
`ZIKV_African_KX377335-1_virusRNA`) and ZILM_REP2/3 (ZASI, French Polynesian,
`ZIKV_FrenchPolynesian_KJ776791-2_virusRNA`), gzip-compressed and
decompressed by the parser worker (`DecompressionStream`; any `.hyb.gz` can
be opened the same way), the African genome FASTA, CPLfold pseudoknot-free
genome folds of both lineages (`ZAFR.dbn`, `ZILM.dbn`) and the NC_035889
GenBank record. ZAFR_REP1 is the primary file; once it is parsed the other
three replicates are fetched and parsed in workers for the Compare page
(conditions ZAFR / ZASI, 10-nt bins, similarity minimum 10) and the arc map
gets both folds and the gene track. When the differential test finishes, an
arc map that has structures but no interaction table draws its merged
interactions, so panels A–G of the summary figure need no further file.
Because the data are a subset the numbers are not the published ones; the
original pipeline on the same subsets (`scripts/make-example-reference.sh`:
`plot_hybrids_3.awk`, `bin/rnaxray_compare` with R DESeq2, `plot_similarity_map`,
`select_regions_cplfold.py`, `folding_energy.py`) gives the reference that
`scripts/verify-example.cjs` checks the browser code against: 20,958
similarity cells with cap 45; 8,353 significant cells (the browser has one
more, a cell at padj 0.05000 in R and 0.04999 here), 133 / 243 merged
interactions at padj < 0.05 and 66 / 153 at padj < 0.01 (one ZAFR-enriched
interaction is the exactly tied neighbour of R's pick); region A 355↔10265
(29 pairs in ZAFR, 0 in ZASI), region B 1625↔1905 (27 in ZASI, 0 in ZAFR);
folding energies n 66 / 153, paired t-test p 2.63e-8 (R on rnaxray_compare's
interactions: 3.21e-8, the tie) / 3.22e-21. With
`RNAXRAY_EXAMPLE_REFERENCE=<dir>` it also compares the similarity map, the
significant cells, the interactions and every RNAcofold energy one by one.

FASTA parsing removes layout whitespace only. Unsupported symbols are preserved and reported instead of being deleted, so reference coordinates never shift silently; structure folding rejects a selected region that contains them.

## HYB semantics and analysis coverage

- Standard 17-column RNAxRay files retain column 16 as `overlap_score` and column 17 as `chimera_type`. Overlap scores are annotations, not read counts.
- For collapsed RNAxRay IDs, the second underscore-delimited ID field is recovered separately as the source raw-read count. It is provenance/summary information, never a Contact Map or Viewpoint weight; those views count one per row in record mode or use explicitly selected legacy cluster support.
- Legacy clustered 16-column files retain `count_total=…` metadata as cluster support. Positive-integer legacy column 16 inputs are marked as ambiguous in Validation because they lack the standard column-17 type field; zero, negative, or decimal numeric values are retained as overlap scores from a partial 17-column row.
- The original RNAxRay homodimer proxy is exposed separately from chimera type: both arms must name the same RNA and the column-16 overlap score must be at least 5.
- The workspace includes interaction filtering by chimera type and homodimer proxy, a single large, zoomable contact map, a per-nucleotide Viewpoint graph, and local multi-file comparison maps. Viewpoint can use selected coordinates or the full mapped reference range after a matching FASTA is loaded.
- The Compare page provides descriptive library-size-normalised effect sizes and the RNAxRay similarity heatmap. The similarity heatmap follows `bin/plot_similarity_map` and `bin/similarity_heatmap.R` run on one merged contact map per condition: each condition's datasets are summed (as if their .hyb files were concatenated), bins below the chosen similarity minimum are dropped from each map, a bin present in both maps scores the smaller raw count, and the counts are capped at their 95% quantile and drawn with `scale_fill_gradient(low = "white", high = "forestgreen")` over the data range (white is the smallest plotted count, not zero; forestgreen is the cap; CIELAB interpolation as in ggplot2). As in R, those smallest bins vanish on the white panel; the "Similarity panel" option draws the map on ggplot's grey panel (#EBEBEB) instead, changing only the display. The similarity minimum is a display filter: it equals running `awk '$3 >= MIN'` on each condition's merged contact.txt before `plot_similarity_map` (1 keeps every bin, the RNAxRay default). On the ZIKV human (Livefire1-3) vs mosquito (Aag1-2) data with minimum 30 it reproduces all 201,576 bins of that reproduction (one merged, filtered contact.txt per condition passed to `plot_similarity_map -a A -i B`) exactly. This one-map-per-condition definition is the same as `plot_similarity_map` with one file per side and RNAxRay Desktop's `differential.py`, and it intentionally differs from `bin/rnaxray_compare` with several replicates per side: rnaxray_compare concatenates the replicate contact.txt files and pairs consecutive occurrences of each bin (A1/A2, A2/B1, B1/B2, ...), so its minima mix within-condition replicate pairs with between-condition ones. The comparison holds up to 1,500,000 distinct cells (4,000,000 dataset cells): a whole ~10.8 kb genome works at 10 nt (the included example covers 838,111 cells). Results above 100,000 cells keep each dataset's values in typed arrays and build a cell's per-dataset values on demand (look cells up with `RNAxRayData.comparisonCellAt(result, x, y)`; `cellMap` is only filled for smaller results), the canvas maps are drawn once into a cached layer, and the effect-map SVG keeps the 100,000 strongest bins. For a homodimer comparison (RNA X = RNA Y) a dataset without that RNA contributes its own RNA with the closest name (another strain's genome, as ZAFR vs ZILM) and is compared bin by bin on its own coordinates, as `bin/rnaxray_compare` compares each dataset's contact map by position (`RNAxRayData.comparisonRnaPlan`); the page says so, and the differential test card below uses the same choice and lets you change it. It exports `rnaxray-web.table.txt` plus the two-column, headerless `rnaxray-web_names.table` expected by the existing `bin/DESeq_run.R`, and a separate extended metadata TSV for audit or custom R adapters. Counts that cannot survive the legacy R integer conversion are rejected instead of being rounded or silently converted to zero. Adjusted p-values on the Compare page come only from the in-browser differential test below (a port, not R; the pinned WebR package image remains behind its feasibility gate).
- A recorded manual browser smoke ran the official WebR 0.6.0 release asset and base R 4.6.0 from a local static origin with `PostMessage`. The site does not vendor that runtime and deployment CI does not rerun the smoke. The stable package repository lacks DESeq2; a separate R-universe development probe for DESeq2 1.53.2 resolved 42 of 43 packages and missed `locfit`, but it is explicitly not evidence for the pinned DESeq2 1.52.0 target. Reproducible harness, recorded result, package-index snapshot, and release gate are in `vendor/webr-deseq2/` and `../scripts/webr-smoke/`.
- The Compare page runs the **RNAxRay differential test** in the browser (`deseq.js`, `deseq-card.js`, `deseq.worker.js`): a JavaScript port of RNAxRay Desktop's numpy port of the DESeq2 1.46 Wald test (`pipeline/rnaxrayanalysis/deseq.py`, `differential.py`) followed by rnaxray_compare's greedy merge of significant cells (padj order, within the merge range in x and y, per direction). Each dataset's arms are binned into 10-nt cells with the RNAxRay coverage rule (record counts, identical to `plot_hybrids_3.awk USE_ENTIRE_HYBRIDS=1` contact.txt on the ZIKV files), independently of the descriptive maps; rows with a summed count above the min count are tested. It needs three or more datasets with two replicates in at least one condition; datasets can be left out, and a homodimer map may use another strain's genome in the datasets that lack the selected RNA. The test runs in a worker that spreads the per-row fits over helper workers (bit-identical results). Output: panel A, the differential coverage map (significant cells, red higher in A, blue higher in B, opacity by -log10 padj as Desktop), SVG/PNG, the merged interactions (`interactions.tsv` format) and significant cells as TSV, "Use in arc map", and a section in the printable report and the parameters JSON. Validation (`scripts/verify-deseq.cjs`, real data with `RNAXRAY_DESEQ_REAL`): on ZAFR_REP1/2 vs ZILM_REP2/3 (1,038,539 tested cells) it gives the same 83,023 significant cells as R (20,660 up / 62,363 down), 668 / 1,725 merged interactions at padj < 0.05 and 378 / 1,243 at padj < 0.01 (one interaction is an exactly tied neighbour of R's pick: ties are merged in table order, as the Desktop port does), size factors 1.0299, 1.6076, 0.8491, 0.8093; over every tested cell log2 fold changes agree with the numpy port to 2e-9 and padj to 3e-7 (relative). A whole genome takes about 20 s single-threaded in Node.
- The Compare page also holds an **Arc map**: one or two structures (.dbn, windows placed by `name:start-end` headers, or .ct), the merged differential interactions of a comparison (RNAxRay Desktop `interactions.tsv` or rnaxray_compare `*_enrichment.txt`; padj cutoff, higher in condition one above, two below) and a gene track (GenBank, GFF3/GTF, BED or TSV), drawn as a PARIS-style SVG. Structure B, the cells of either condition and a GenBank annotation may sit on another reference (another strain): they are moved onto A's coordinates by a banded global alignment of the sequences (`arc-map.js`, the same algorithm as RNAxRay Desktop's `seqmap`), and shared pairs are counted on A's coordinates. On the ZIKV ZAFR and ZILM genome folds it maps ZILM i to ZAFR i-1 after the indel at 72 and draws the 378 / 1,243 interactions with padj < 0.01 of the AFR vs ILM virion test; NC_035889's mature peptides land on ZAFR one nucleotide earlier.
- Below the arc map, two cards use the same files. **Region structures (D, E)** (`region-panels.js`) picks, for each direction, the most significant interaction (padj cutoff, sorted by padj) that the enriched lineage's own structure forms (a pair within ±reach nt of both arms, B's pairs moved onto A by alignment), cuts windows (extent of those pairs ± flank) from both structures and draws them joined by a 3-nt linker (ViennaRNA's simple polygon layout), with inter-window pairs in the lineage colour and bases paired outside hollow; a dropdown overrides the interaction. It reproduces `select_regions_cplfold.py` / `window_from_structure.py` exactly on the ZIKV folds. **Folding energy (F, G)** (`folding-energy.js`, `folding-energy.worker.js`) folds 2 × L-nt fragments of every significant interaction with RNAcofold (ViennaRNA WebAssembly, 37 °C) in both lineages and draws violins with a paired t-test (Student t via the regularised incomplete beta); on AFR vs ILM all 1,616 × 2 energies equal the RNAcofold CLI's and the p-values equal R's. FASTA references can be loaded when a structure file has no sequence. Checks: `scripts/verify-region-panels.cjs`, `scripts/verify-folding-energy.cjs` (`RNAXRAY_PANELS_REAL=<dir>` for the real data).
- Standard ViennaRNA MFE and RNAcofold are built as one static WebAssembly asset during deployment. HYB-guided structure mode runs one RNAcofold observation per eligible HYB row, aggregates base-pair frequencies, merges touching pairs into ranked stems, fits compatible hard constraints iteratively, optionally evaluates up to 1,000 seeded random orders, scores every result by COMRADES support, and colours the selected structure by evidence. UNAFold remains an optional external CLI compatibility path.
- Pure-Python CPLfold is available as a separate browser engine. Sequence-only mode predicts nested and pseudoknotted candidates. HYB-guided mode converts the two prepared intervals from every eligible HYB row into CPLfold's IRIS-style Gaussian, symmetric outer-product, thresholded `log1p` bonus matrix; overlap score and collapsed source-read count are never reused as weights. The result includes a bonus-matrix view, switchable ranked candidates, pseudoknot-aware arc layers, CT/DBN/SVG/PNG output, base-pair TSV, bonus TSV, candidate TSV, and a provenance report.

## Local structure prediction

The structure workspace loads a pinned ViennaRNA 2.7.2 RNAlib build in a dedicated Web Worker. It reports a global MFE in kcal/mol, dot-bracket notation, CT and base-pair exports, and interactive SVG views for arc, radial, circular-contact, and symmetric base-pair matrix layouts. Arc remains the default; all views share nucleotide inspection, HYB/RNAcofold evidence colouring, CPLfold layer styling, and SVG/PNG export. For ViennaRNA, the normal UI accepts up to 2,000 nt; users may explicitly continue up to 3,000 nt after a browser-memory warning. CPLfold is the default engine and starts in pseudoknot-free mode; the **web** path has a separate 500-nt hard safety ceiling and a session-specific capacity recommendation measured in the browser. The desktop app can advertise a validated bundled Python/NumPy/CPLfold runtime, optionally with Numba JIT acceleration; when that capability is present, the app skips browser capacity measurement and delegates resource limits to its native task runner. Users may enable CPLfold pseudoknot search explicitly. ViennaRNA remains available for nested MFE, COMRADES(ViennaRNA), and manual hard base pairs; an expert may instead choose **Manual hard base pairs** and enter one 1-based `i-j` pair per line, relative to the prepared sequence.

Manual pairs must be in range, non-crossing canonical or G–U pairs, satisfy the selected minimum-loop size, and never reuse a nucleotide. The controller validates them before starting the worker; ViennaRNA enforces them, and the result is checked and labelled in the diagram and base-pair export. Report JSON records `constraintSource: "manual-user-input"` and explicitly marks automatic HYB/RNAcofold evidence generation as false for that mode.

**COMRADES(ViennaRNA)** requires a loaded HYB file and mapped reference FASTA. Single-region mode covers short-range intramolecular interactions. Paired-region mode reproduces the original two-fragment assembly with the 100-nt `50 A + 50 U` RNA spacer and supports long-range, intermolecular, and overlap-score-defined homodimer subsets. Every eligible HYB row contributes one observation, independent of overlap score or collapsed-read provenance. The browser preserves the original 1,001-row evidence-selection nuance and 75-stem default. General pseudoknots remain outside the ViennaRNA dot-bracket result.

**Optional CPLfold pseudoknot search** runs the vendored pure-Python two-phase
algorithm in Pyodide 0.29.4 with NumPy 2.2.5. Pyodide does not ship Numba, so
the browser bridge replaces `numba.njit` with an identity decorator. The
structure page measures a representative local run when a longer request is
needed and derives a conservative session-specific length recommendation. The
bridge and worker retain a 500-nt hard safety ceiling because CPLfold allocates
quadratic sequence-state arrays. CPLfold uses its bundled 37 °C energy tables;
the separate ViennaRNA temperature control does not apply. HYB block evidence is currently restricted to
one mapped reference region; this avoids the original Vienna workflow's 100-nt
artificial spacer becoming foldable CPLfold sequence. Longer or Numba-accelerated
CPLfold jobs use the local `bin/cplfold` command.

The vendored CPLfold snapshot has an unresolved combined-distribution licence
boundary. Review `third_party/cplfold/THIRD_PARTY_NOTICES.md` and obtain the
necessary permission or exception before publishing this branch publicly.

The molecule-like RNA secondary-structure view uses the locally vendored
`fornac` 1.2.0 renderer from ViennaRNA (Apache-2.0) with D3 3.5.17. The pinned
browser assets and license texts are stored under `vendor/fornac/` and
`vendor/d3/`; sequence and dot-bracket data remain in the browser.

FASTQ/SAM alignment and HYB construction remain in the local CLI. The static application starts at `.hyb`; it never uploads those files or invokes a backend.

For an engine-enabled local preview, install `curl`, `tar`, `zip`, `sha256sum`,
`pkg-config`, and Node, activate Emscripten, then run
`bash scripts/build-vienna-wasm.sh` and `bash scripts/build-cplfold-web.sh`
before serving `web/`. The deployment workflow pins Emscripten 3.1.57,
Pyodide 0.29.4, Python 3.13.2, and NumPy 2.2.5, verifies downloaded hashes,
packages the Python bridge under a content-addressed filename, verifies that
archive again inside the browser worker, and performs both builds
automatically.

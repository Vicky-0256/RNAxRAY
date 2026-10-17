"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const repository = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(repository, "web", "app.js"), "utf8");
const analysisPagesSource = fs.readFileSync(path.join(repository, "web", "analysis-pages.js"), "utf8");
const overviewPageSource = fs.readFileSync(path.join(repository, "web", "overview-page.js"), "utf8");
const reportPageSource = fs.readFileSync(path.join(repository, "web", "report-page.js"), "utf8");
const reportCssSource = fs.readFileSync(path.join(repository, "web", "report.css"), "utf8");
const indexSource = fs.readFileSync(path.join(repository, "web", "index.html"), "utf8");
const localCplfoldSource = fs.readFileSync(path.join(repository, "web", "local-cplfold.html"), "utf8");
const workflowSource = fs.readFileSync(path.join(repository, ".github", "workflows", "deploy-pages.yml"), "utf8");
// the included example (web/example.js; scripts/verify-example.cjs checks it in depth)
const example = require(path.join(repository, "web", "example.js"));
example.files().forEach(function (file) {
  const full = path.join(repository, "web", example.directory, file);
  assert.ok(fs.existsSync(full) && fs.statSync(full).size > 0, "the landing-page example file " + file + " must be present");
  assert.ok(fs.statSync(full).size < 100 * 1024 * 1024, file + " must remain below GitHub's single-file limit");
});
const exampleHybLines = zlib.gunzipSync(fs.readFileSync(path.join(repository, "web", example.directory, example.primary.file))).toString("utf8").trimEnd().split(/\r?\n/);
const exampleFastaSource = fs.readFileSync(path.join(repository, "web", example.directory, example.reference.file), "utf8");
assert.equal(exampleHybLines.length, example.primary.records,
  "the landing-page HYB example must be the checked-in 1-in-10 ZAFR_REP1 subset");
assert.match(exampleHybLines[0], /ZIKV_African_KX377335-1_virusRNA/,
  "the landing-page HYB example must use the ZIKV reference name");
assert.equal(exampleFastaSource.split(/\r?\n/, 1)[0], ">ZIKV_African_KX377335-1_virusRNA",
  "the landing-page FASTA example must match the ZIKV reference name used in the HYB file");
const context = vm.createContext({
  Intl,
  Number,
  String,
  Boolean,
  Object,
  Array,
  Math,
  RegExp,
  Set,
  Map,
  window: {}
});

vm.runInContext(
  fs.readFileSync(path.join(repository, "web", "analysis-ui.js"), "utf8"),
  context,
  { filename: "analysis-ui.js" }
);
context.window.RNAXRAY_BUILD = { commit: "test-commit" };

function invokeEmptyExport(action, state) {
  const events = { downloads: [], toasts: [] };
  const handled = context.window.RNAxRayUI.handleAction(
    state,
    { dataset: { featureAction: action } },
    {
      download: function () { events.downloads.push("text"); },
      downloadBlob: function () { events.downloads.push("blob"); },
      showToast: function (message) { events.toasts.push(message); }
    }
  );

  assert.equal(handled, true, action + " should be handled");
  assert.deepEqual(events.downloads, [], action + " should not download an empty visual");
  assert.equal(events.toasts.length, 1, action + " should explain why no file was downloaded");
  assert.match(events.toasts[0], /with data before downloading/);
}

const emptyStates = {
  contact: { contact: { matrix: null } },
  viewpoint: { viewpoint: { results: { ready: false, bins: [] } } },
  comparison: { comparison: { result: { ready: false, cells: [] } } }
};

["contact-download-svg", "contact-download-png"].forEach(function (action) {
  invokeEmptyExport(action, emptyStates.contact);
});
["viewpoint-download-svg", "viewpoint-download-png"].forEach(function (action) {
  invokeEmptyExport(action, emptyStates.viewpoint);
});
["comparison-download-svg", "comparison-download-png"].forEach(function (action) {
  invokeEmptyExport(action, emptyStates.comparison);
});
invokeEmptyExport("comparison-export-tsv", emptyStates.comparison);
invokeEmptyExport("comparison-export-deseq-counts", emptyStates.comparison);
invokeEmptyExport("comparison-export-rnaxray-names", emptyStates.comparison);
invokeEmptyExport("comparison-export-deseq-metadata", emptyStates.comparison);

assert.equal(context.window.RNAxRayUI.visualExportReady({ contact: { matrix: { cells: [{ x: 0, y: 0 }] } } }, "contact"), true);
assert.equal(context.window.RNAxRayUI.visualExportReady({ viewpoint: { results: { ready: true, bins: [{ start: 1 }] } } }, "viewpoint"), true);
assert.equal(context.window.RNAxRayUI.visualExportReady({ comparison: { result: { ready: true, cells: [{ x: 0, y: 0 }] } } }, "comparison"), true);

assert.deepEqual(
  JSON.parse(JSON.stringify(context.window.RNAxRayUI.contactYAxisLabels({ yStart: 10, yEnd: 30 }, 10))),
  { top: 10, bottom: 39 },
  "Contact Y-axis labels must follow the same top-to-bottom order as cell rendering and hit testing"
);
const capParameters = context.window.RNAxRayUI.contactParameters({
  summary: { fileName: "fixture.hyb", sha256: "abc" },
  contact: {
    rnaX: "A", rnaY: "B", binSize: 10, measure: "records", colourCap: "custom", customCap: "",
    scale: "linear", orientation: "normalised", chimeraType: "all", homodimer: "all", matrix: { cap: 7 }
  }
});
assert.equal(capParameters.parameters.customCap, null, "a blank custom cap must not be exported as zero");
assert.equal(capParameters.parameters.effectiveColourCap, 7, "parameter export must record the cap actually applied");
const contactExportState = {
  summary: { fileName: "fixture.hyb", fileSize: 88, sha256: "abc" },
  contact: {
    rnaX: "RNA_A", rnaY: "RNA_B", binSize: 10, measure: "records", colourCap: "max", customCap: "",
    scale: "linear", orientation: "normalised", chimeraType: "all", homodimer: "all",
    // The contact map is a single canvas. Its visible extent is the canonical
    // overviewView regardless of how the user reached it (drag, click, or wheel).
    zoomSelection: { x: 30, y: 130 },
    overviewView: { xStart: 20, xEnd: 40, yStart: 120, yEnd: 150 },
    selection: { x: 30, y: 130 },
    matrix: {
      xMin: 0, xMax: 90, yMin: 100, yMax: 190, binSize: 10, cap: 1, max: 1,
      cells: [{ x: 20, y: 120, value: 1 }]
    }
  }
};
const contactExportParameters = context.window.RNAxRayUI.contactParameters(contactExportState);
assert.deepEqual(JSON.parse(JSON.stringify(contactExportParameters.parameters.exportedView)), {
  stage: "overview", xStart: 20, xEnd: 49, yStart: 120, yEnd: 159
});
assert.deepEqual(JSON.parse(JSON.stringify(contactExportParameters.parameters.selectedCell)), {
  xStart: 30, xEnd: 39, yStart: 130, yEnd: 139
});
assert.equal(contactExportParameters.sourceHyb.fileSize, 88);
const contactSvg = context.window.RNAxRayUI.buildContactSvg(contactExportState);
assert.match(contactSvg, />120<\/text>/, "Contact SVG must label the top Y coordinate");
assert.match(contactSvg, />159<\/text>/, "Contact SVG must label the bottom Y coordinate");
assert.match(contactSvg, />RNA_A position \(nt\)<\/text>/, "Contact SVG must title the X axis");
assert.match(contactSvg, />RNA_B position \(nt\)<\/text>/, "Contact SVG must title the Y axis");
{
  // B1/B4: with the UI kit loaded the Contact SVG carries the colour bar
  const kitContext = vm.createContext({ Intl, Number, String, Boolean, Object, Array, Math, RegExp, Set, Map, window: {} });
  vm.runInContext(fs.readFileSync(path.join(repository, "web", "ui-kit.js"), "utf8"), kitContext, { filename: "ui-kit.js" });
  vm.runInContext(fs.readFileSync(path.join(repository, "web", "analysis-ui.js"), "utf8"), kitContext, { filename: "analysis-ui.js" });
  const kitSvg = kitContext.window.RNAxRayUI.buildContactSvg(contactExportState);
  assert.match(kitSvg, /<g class="chart-legend"/, "the Contact SVG has a colour bar");
  assert.match(kitSvg, />Record count \(linear\)<\/text>/, "the colour bar names the measure and the scale");
  assert.match(kitSvg, /<rect width="100%" height="100%" fill="#ffffff"\/>/, "the Contact SVG is light");
  assert.ok((kitSvg.match(/<line x1="[\d.]+" x2="[\d.]+" y1="[\d.]+" y2="[\d.]+" stroke/g) || []).length >= 8, "the Contact SVG axes carry interior ticks (K5)");
}
contactExportState.contact.overviewView = null;
contactExportState.contact.overviewView = { xStart: 10, xEnd: 60, yStart: 110, yEnd: 170 };
const overviewExport = context.window.RNAxRayUI.contactParameters(contactExportState);
assert.deepEqual(JSON.parse(JSON.stringify(overviewExport.parameters.exportedView)), {
  stage: "overview", xStart: 10, xEnd: 69, yStart: 110, yEnd: 179
}, "the single map export must describe the visible overview canvas");

const reproducibilityState = {
  summary: { fileName: "primary.hyb", fileSize: 321, sha256: "primary-sha" },
  // Provider-fed view model (web/page-data.js): DatasetInfo.reference and the
  // queryHybrids total for the current filters.
  reference: { fileName: "reference.fa", fileSize: 99, sha256: "fasta-sha", mapping: { RNA_A: "ref_A" } },
  filters: { rna: "RNA_A", chimeraType: "Type_2", minSupport: "3" },
  view: { interactions: { total: 2, offset: 0, rows: [] } },
  viewpoint: {
    rna: "RNA_A", partner: "RNA_B", chimeraType: "Type_2", homodimer: "exclude",
    rangeMode: "reference", start: "5", end: "40", binSize: "10", measure: "support",
    results: { start: 1, end: 80, binSize: 10, records: [{}, {}], armContributions: 2, totalCoverage: 44 }
  },
  region: {
    rna: "RNA_A", start: "5", end: "40", partner: "RNA_B", overlap: "contained",
    results: { profileBinSize: 2, records: [{}], support: 7, partners: [{ name: "RNA_B" }] }
  },
  comparison: {
    conditionALabel: "Control", conditionBLabel: "Treatment", rnaX: "RNA_A", rnaY: "RNA_B",
    binSize: "25", measure: "records", normalise: "none",
    datasets: [
      { id: "primary", label: "P", condition: "A", fileName: "primary.hyb", fileSize: 321, summary: { sha256: "primary-sha", validRecords: 4, supportInteractions: 5 } },
      { id: "secondary", label: "S", condition: "B", fileName: "second.hyb", fileSize: 123, sha256: "second-sha", summary: { validRecords: 3, supportInteractions: 6 } }
    ],
    selection: { x: 50, y: 75 },
    result: { ready: true, binSize: 25, cells: [{ x: 50, y: 75 }], conservedCells: [] }
  }
};
const interactionReport = context.window.RNAxRayUI.interactionParameters(reproducibilityState);
assert.equal(interactionReport.version, "0.5.0");
assert.equal(interactionReport.buildCommit, "test-commit");
assert.equal(interactionReport.sourceHyb.sha256, "primary-sha");
assert.equal(interactionReport.sourceHyb.sha256Status, "available");
assert.equal(interactionReport.parameters.chimeraType, "Type_2");
assert.equal(interactionReport.result.matchingRecords, 2);
const viewpointReport = context.window.RNAxRayUI.viewpointParameters(reproducibilityState);
assert.equal(viewpointReport.sourceFasta.mappedReferenceId, "ref_A");
assert.equal(viewpointReport.parameters.measure, "cluster-support");
assert.equal(viewpointReport.parameters.effectiveEnd, 80);
const regionReport = context.window.RNAxRayUI.regionParameters(reproducibilityState);
assert.equal(regionReport.parameters.overlapRule, "contained");
assert.equal(regionReport.result.clusterSupport, 7);
const comparisonReport = context.window.RNAxRayUI.comparisonParameters(reproducibilityState);
assert.equal(comparisonReport.parameters.conditionALabel, "Control");
assert.equal(comparisonReport.parameters.conditionBLabel, "Treatment");
assert.equal(comparisonReport.parameters.normalisation, "none");
assert.equal(comparisonReport.parameters.pseudocount, 0.5);
assert.equal(comparisonReport.datasets[1].sha256, "second-sha");
assert.deepEqual(JSON.parse(JSON.stringify(comparisonReport.result.selectedBin)), { xStart: 50, xEnd: 74, yStart: 75, yEnd: 99 });
assert.equal(comparisonReport.methodScope.replicateAwareStatisticalTesting, false);
// A DESeq2 result whose inputs changed since the run must not be reported as
// a current replicate-aware test.
context.window.RNAxRayDeseqCard = { parameters: function () { return { result: { current: false } }; } };
const staleTestReport = context.window.RNAxRayUI.comparisonParameters(reproducibilityState);
assert.equal(staleTestReport.methodScope.replicateAwareStatisticalTesting, false, "a stale differential test is not a current test");
assert.equal(staleTestReport.methodScope.adjustedPValues, false, "a stale differential test gives no current adjusted p-values");
context.window.RNAxRayDeseqCard = { parameters: function () { return { result: { current: true } }; } };
assert.equal(context.window.RNAxRayUI.comparisonParameters(reproducibilityState).methodScope.adjustedPValues, true);
delete context.window.RNAxRayDeseqCard;
// Similarity colours: similarity_heatmap.R puts white at the smallest plotted
// count and forestgreen at the 95% quantile cap (CIELAB ramp).
const similarityScale = { similarityCap: 10, similarityFloor: 2, conservedCells: [] };
assert.equal(context.window.RNAxRayUI.conservedRatio(2, similarityScale), 0, "the smallest count is white");
assert.equal(context.window.RNAxRayUI.conservedRatio(6, similarityScale), 0.5);
assert.equal(context.window.RNAxRayUI.conservedRatio(40, similarityScale), 1, "counts above the cap take the cap colour");
assert.equal(context.window.RNAxRayUI.conservedRatio(3, { similarityCap: 3, similarityFloor: 3 }), 0.5,
  "a single-valued scale maps to the midpoint, like scales::rescale");
assert.equal(context.window.RNAxRayUI.conservedRatio(4, { similarityCap: 8, conservedCells: [{ similarity: 4 }, { similarity: 8 }] }), 0,
  "without similarityFloor the floor is the smallest conserved cell");
assert.equal(context.window.RNAxRayUI.conservedColor(0), "rgb(255, 255, 255)");
assert.equal(context.window.RNAxRayUI.conservedColor(1), "rgb(34, 139, 34)");
assert.equal(context.window.RNAxRayUI.conservedColor(0.5), "rgb(153, 197, 143)", "the ramp interpolates in CIELAB");
// The panel behind the similarity heatmap is display only: R's white by
// default, ggplot's grey on request; changing it keeps the computed result.
// Large maps are rasterised into one pixel buffer: every cell covers at
// least one device pixel, later cells over earlier ones.
{
  const canvas = { width: 20, height: 10 };
  const buffer = new Uint8ClampedArray(20 * 10 * 4);
  let put = null;
  const fake = {
    canvas: canvas,
    getImageData: function (x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData: function (image, x, y) { put = { image: image, x: x, y: y }; }
  };
  const geometry = { left: 0, top: 0, plotWidth: 10, plotHeight: 5, cellWidth: 0.5, cellHeight: 0.5, xStart: 0, yStart: 0 };
  // cells are drawn 0.9 css px (1.8 device px) wide, so they overlap as with fillRect
  const cells = [{ x: 0, y: 0, c: "rgb(1, 2, 3)" }, { x: 0, y: 0, c: "rgb(7, 8, 9)" }, { x: 10, y: 0, c: "rgb(4, 5, 6)" }];
  context.window.RNAxRayUI.rasterComparisonCells(fake, { width: 10, height: 5 }, geometry, { binSize: 10 }, cells, 0.9, 0.9,
    function (cell) { return cell.c; });
  assert.ok(put && put.x === 0 && put.y === 0, "the plot area is written back");
  const px = put.image.data;
  assert.deepEqual(Array.from(px.slice(0, 4)), [7, 8, 9, 255], "the later cell wins its pixel");
  assert.deepEqual(Array.from(px.slice(4, 8)), [4, 5, 6, 255], "the next cell starts at its own device pixel");
  assert.deepEqual(Array.from(px.slice(12, 16)), [0, 0, 0, 0], "beyond the last cell nothing is written");
  void buffer;
}
{
  // the raster's packed effect colours are effectColor()'s
  const pack = context.window.RNAxRayUI.effectPacker(false);
  for (let k = -1200; k <= 1200; k += 7) {
    const value = k / 1000;
    const rgb = context.window.RNAxRayUI.effectColor(value).match(/\d+/g).map(Number);
    const p = pack(value);
    assert.deepEqual([p & 255, (p >>> 8) & 255, (p >>> 16) & 255, p >>> 24], rgb.concat(255), "effect " + value);
  }
}
{
  // B2: the Contact Map scale is the "Teal–violet sequential" ramp; relative
  // luminance is monotonic (falling on the light surface, rising on dark)
  const luminance = function (rgb) {
    const lin = rgb.map(function (c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  [["light", -1], ["dark", 1]].forEach(function (entry) {
    let previous = null;
    for (let step = 0; step <= 64; step += 1) {
      const value = luminance(Array.from(context.window.RNAxRayUI.viridisRgb(step / 64, entry[0])));
      if (previous !== null) {
        assert.ok((value - previous) * entry[1] > 0, entry[0] + " contact scale luminance must be monotonic at " + step + "/64");
      }
      previous = value;
    }
  });
  assert.equal(context.window.RNAxRayUI.viridis(1, "light"), "rgb(45, 27, 105)");
}
assert.equal(context.window.RNAxRayUI.similarityPanelColor({}), "#ffffff");
assert.equal(context.window.RNAxRayUI.similarityPanelColor({ similarityPanel: "grey" }), "#ebebeb");
assert.match(comparisonReport.parameters.similarityPanel, /^white/);
{
  const displayState = { comparison: { similarityPanel: "white", result: { ready: true }, selection: { x: 1, y: 1 } } };
  let rendered = 0;
  const handled = context.window.RNAxRayUI.handleChange(displayState, { dataset: { feature: "comparison-display", key: "similarityPanel" }, value: "grey" }, { render: function () { rendered += 1; } });
  assert.equal(handled, true);
  assert.equal(displayState.comparison.similarityPanel, "grey");
  assert.ok(displayState.comparison.result && displayState.comparison.selection, "the panel colour does not drop the result");
  assert.equal(rendered, 1);
}
assert.equal(comparisonReport.methodScope.webRBaseRuntimeSmoke, "recorded-manual-pass");
assert.equal(comparisonReport.methodScope.webRRuntimeValidated, false);
assert.equal(comparisonReport.methodScope.webRRuntimeVendored, false);
assert.equal(comparisonReport.methodScope.webRDeploymentCiSmoke, false);
assert.equal(comparisonReport.methodScope.pinnedDeSeq2ClosureValidated, false);
assert.equal(comparisonReport.methodScope.deSeq2WasmReady, false);
assert.match(comparisonReport.methodScope.releaseBlocker, /DESeq2 1\.52\.0 WebAssembly closure.*numerical parity/);
assert.equal(comparisonReport.methodScope.localCliExportAvailable, true);
assert.equal(comparisonReport.datasets[1].sha256Status, "available");
assert.match(analysisPagesSource, /renderNoContactData\(contact, matrix\)/);
assert.match(analysisPagesSource, /matrix && matrix\.limitExceeded && matrix\.reason/,
  "a contact work-limit failure must surface its actionable reason instead of claiming there were no records");
assert.match(overviewPageSource, /data-action="download-rna-counts"/,
  "Overview must expose the planned RNA-count CSV export");
assert.match(overviewPageSource, /data-action="download-rna-pairs"/,
  "Overview must expose the planned RNA-pair CSV export");
["interactions-export-params", "viewpoint-export-params", "region-export-params", "comparison-export-params"].forEach(function (action) {
  assert.match(analysisPagesSource, new RegExp('data-feature-action="' + action + '"'),
    action + " must expose a companion reproducibility report");
});
assert.match(analysisPagesSource, /data-feature-action="comparison-export-selected"/,
  "a selected comparison bin must expose its per-dataset values for audit and export");
assert.match(analysisPagesSource, /data-feature-action="comparison-export-deseq-counts"/,
  "Compare must expose its raw feature-by-sample matrix for the validated local DESeq2 fallback");
assert.match(analysisPagesSource, /data-feature-action="comparison-export-rnaxray-names"/,
  "Compare must expose the two-column headerless names.table required by the legacy RNAxRay CLI");
assert.match(analysisPagesSource, /data-feature-action="comparison-export-deseq-metadata"/,
  "Compare must retain extended headered metadata for audit and custom R workflows");
assert.doesNotMatch(overviewPageSource, /single-region HYB block bonus matrix/,
  "the Overview structure text must not imply that CPLfold uses one HYB block only");
assert.match(overviewPageSource, /bonus matrix built from all eligible HYB rows in one selected reference region/,
  "the Overview structure text must describe the full eligible-row bonus-matrix scope");
assert.doesNotMatch(overviewPageSource, /structure workspace accepts reference regions, HYB record sequences, and pasted sequences/,
  "the Overview structure text must not imply that every structure mode exposes every sequence source");
assert.match(overviewPageSource, /provides reference-region input for HYB-guided modes and supports HYB record or pasted sequence input in compatible sequence-only and ViennaRNA modes/,
  "the Overview structure text must qualify sequence-source availability by mode");
assert.doesNotMatch(fs.readFileSync(path.join(repository, "web", "local-cplfold.html"), "utf8"), /bonus matrix from the selected HYB block/,
  "the local CPLfold guide must not imply that the bonus matrix comes from one HYB block");
assert.match(fs.readFileSync(path.join(repository, "web", "local-cplfold.html"), "utf8"), /all eligible HYB rows in the selected reference region/,
  "the local CPLfold guide must describe the full eligible-row bonus-matrix scope");
assert.match(analysisPagesSource, /headerless RNAxRay names\.table[\s\S]*?Extended metadata has a header/,
  "Compare must distinguish legacy CLI input from extended metadata");

const comparisonExportState = {
  comparison: { datasets: [{ id: "a", condition: "A" }], result: { ready: true, cells: [{ x: 0, y: 0 }] } }
};
const comparisonExportEvents = { downloads: [], toasts: [] };
context.window.RNAxRayData = {
  comparisonCountMatrixToTsv: function () { return "counts"; },
  comparisonLegacyNamesToTsv: function () { return "names"; },
  comparisonSampleMetadataToTsv: function () { return "metadata"; }
};
const comparisonExportApi = {
  download: function (name, contents, mediaType) {
    comparisonExportEvents.downloads.push({ name: name, contents: contents, mediaType: mediaType });
  },
  showToast: function (message) { comparisonExportEvents.toasts.push(message); }
};
context.window.RNAxRayUI.handleAction(
  comparisonExportState,
  { dataset: { featureAction: "comparison-export-deseq-counts" } },
  comparisonExportApi
);
context.window.RNAxRayUI.handleAction(
  comparisonExportState,
  { dataset: { featureAction: "comparison-export-rnaxray-names" } },
  comparisonExportApi
);
context.window.RNAxRayUI.handleAction(
  comparisonExportState,
  { dataset: { featureAction: "comparison-export-deseq-metadata" } },
  comparisonExportApi
);
assert.deepEqual(JSON.parse(JSON.stringify(comparisonExportEvents.downloads)), [
  { name: "rnaxray-web.table.txt", contents: "counts", mediaType: "text/tab-separated-values" },
  { name: "rnaxray-web_names.table", contents: "names", mediaType: "text/tab-separated-values" },
  { name: "deseq2-sample-metadata.tsv", contents: "metadata", mediaType: "text/tab-separated-values" }
]);
comparisonExportEvents.downloads.length = 0;
comparisonExportEvents.toasts.length = 0;
context.window.RNAxRayData.comparisonCountMatrixToTsv = function () {
  throw new Error("Cannot export RNAxRay/DESeq2 counts: count exceeds the legacy R integer maximum.");
};
context.window.RNAxRayUI.handleAction(
  comparisonExportState,
  { dataset: { featureAction: "comparison-export-deseq-counts" } },
  comparisonExportApi
);
assert.deepEqual(comparisonExportEvents.downloads, [], "An invalid count matrix must not trigger a download");
assert.match(comparisonExportEvents.toasts[0], /exceeds the legacy R integer maximum/,
  "Count-export failures must surface an actionable error to the user");
assert.match(analysisPagesSource, /item \? item\.rawValue : 0/,
  "the selected-bin breakdown must display explicit zeroes for datasets without that bin");
assert.match(appSource, /pageData\.queryHybrids\(\{ offset: 0, limit: null \}\)/,
  "the RNA-count and RNA-pair exports must request every row from the DataProvider");
assert.match(appSource, /withAllRows\(function \(rows\) \{\s*downloadText\("rna_counts\.csv", window\.RNAxRayData\.rnaCountsToCsv\(rows\), "text\/csv"\)/,
  "the RNA-count control must download a complete record-derived CSV");
assert.match(appSource, /withAllRows\(function \(rows\) \{\s*downloadText\("rna_pairs\.csv", window\.RNAxRayData\.rnaPairsToCsv\(rows\), "text\/csv"\)/,
  "the RNA-pair control must download a complete record-derived CSV");

const comparisonCells = [
  { x: 0, y: 0, presentDatasets: 2, similarity: 3 },
  { x: 20, y: 0, presentDatasets: 2, similarity: 1 },
  { x: 0, y: 10, presentDatasets: 1, similarity: 0 },
  { x: 20, y: 20, presentDatasets: 2, similarity: 2 }
];
const comparisonState = {
  comparison: {
    result: {
      ready: true,
      cells: comparisonCells,
      conservedCells: comparisonCells.filter(function (cell) { return cell.similarity > 0; })
    },
    selection: null,
    activeMap: null
  }
};

assert.equal(context.window.RNAxRayUI.moveComparisonSelection(comparisonState, "effect", "ArrowRight"), true);
assert.equal(comparisonState.comparison.selection.x, 20);
assert.equal(comparisonState.comparison.selection.y, 0);
assert.equal(comparisonState.comparison.activeMap, "effect");
assert.equal(context.window.RNAxRayUI.moveComparisonSelection(comparisonState, "effect", "ArrowDown"), true);
assert.equal(comparisonState.comparison.selection.x, 20);
assert.equal(comparisonState.comparison.selection.y, 20);
comparisonState.comparison.selection = null;
assert.equal(context.window.RNAxRayUI.moveComparisonSelection(comparisonState, "conserved", "ArrowDown"), true);
assert.equal(comparisonState.comparison.selection.x, 20);
assert.equal(comparisonState.comparison.selection.y, 20);
assert.equal(comparisonState.comparison.activeMap, "conserved");

const comparisonRemovalState = {
  comparison: {
    datasets: [
      { id: "primary", summary: { rnaNames: ["RNA_A", "RNA_B"] } },
      { id: "secondary", summary: { rnaNames: ["RNA_UNIQUE"] } }
    ],
    rnaX: "RNA_UNIQUE",
    rnaY: "RNA_UNIQUE",
    result: { stale: true },
    selection: { x: 1, y: 1 }
  }
};
context.window.RNAxRayUI.handleAction(
  comparisonRemovalState,
  { dataset: { featureAction: "remove-comparison-dataset", datasetId: "secondary" } },
  { render: function () {}, showToast: function () {} }
);
assert.equal(comparisonRemovalState.comparison.rnaX, "RNA_A");
assert.equal(comparisonRemovalState.comparison.rnaY, "RNA_A");
assert.equal(comparisonRemovalState.comparison.result, null);
assert.equal(comparisonRemovalState.comparison.selection, null);

const typedComparisonState = { comparison: { conditionALabel: "Old", result: { stale: true }, selection: { x: 1, y: 1 } } };
assert.equal(context.window.RNAxRayUI.handleInput(typedComparisonState, {
  dataset: { feature: "comparison-control", key: "conditionALabel" }, value: "New label"
}), true);
assert.equal(typedComparisonState.comparison.conditionALabel, "New label",
  "delegated input must persist unblurred text before an asynchronous render");
assert.deepEqual(typedComparisonState.comparison.result, { stale: true },
  "condition labels are display only: typing one keeps a (whole-genome) comparison result");
assert.equal(context.window.RNAxRayUI.handleInput(typedComparisonState, {
  dataset: { feature: "comparison-control", key: "binSize" }, value: "25"
}), true);
assert.equal(typedComparisonState.comparison.result, null, "an analysis setting invalidates the result");

const partnerSelectionState = { filters: { partner: "" }, selectedRecordIndex: 7, interactionScrollTop: 12 };
context.window.RNAxRayUI.handleAction(partnerSelectionState, {
  dataset: { featureAction: "select-partner", partner: "RNA_B" }
}, { updateInteractionHash: function () {}, render: function () {} });
assert.equal(partnerSelectionState.selectedRecordIndex, null,
  "selecting a partner must close a record drawer that may not belong to the filtered results");

context.window.RNAxRayPages = {
  findRecord: function () {
    return { rnaOne: "RNA_A", rnaOneStart: 11, rnaOneEnd: 20, rnaTwo: "RNA_B", rnaTwoStart: 31, rnaTwoEnd: 40 };
  }
};
const navigationApi = {
  chooseHybCalls: 0,
  removeFastaCalls: 0,
  toasts: [],
  lastNavigation: null,
  navigate: function (page) { this.lastNavigation = page; },
  render: function () {},
  showToast: function (message) { this.toasts.push(message); },
  chooseHyb: function () { this.chooseHybCalls += 1; },
  removeFasta: function () {
    this.removeFastaCalls += 1;
    fastaState.fasta = null;
    fastaState.viewpoint.results = null;
    fastaState.viewpoint.rangeMode = "coordinates";
  }
};
const regionState = {
  records: [],
  region: { results: { stale: true } },
  contact: { rnaX: "RNA_A", rnaY: "RNA_B", selection: { x: 10, y: 30 }, matrix: { binSize: 10 } },
  viewpoint: { rna: "RNA_A", partner: "RNA_B", selection: { start: 11 }, results: { bins: [{ start: 11, end: 20 }] } },
  comparison: { rnaX: "RNA_A", rnaY: "RNA_B", selection: { x: 10, y: 30 }, result: { binSize: 10 } }
};
["record-region", "contact-explore-region", "viewpoint-explore-region", "comparison-explore-region"].forEach(function (action) {
  regionState.region.results = { stale: true };
  context.window.RNAxRayUI.handleAction(regionState, { dataset: { featureAction: action, recordIndex: "0", arm: "1" } }, navigationApi);
  assert.equal(regionState.region.results, null, action + " should invalidate cached region results");
});
assert.equal(regionState.region.partnerStart, 30,
  "map-to-region navigation must retain the selected Y-bin start");
assert.equal(regionState.region.partnerEnd, 39,
  "map-to-region navigation must retain the selected Y-bin end");
regionState.region.results = { stale: true };
assert.equal(
  context.window.RNAxRayUI.handleAction(regionState, { dataset: { featureAction: "explore-region" } }, navigationApi),
  true,
  "the Region Explorer primary action must be live"
);
assert.equal(regionState.region.results, null, "exploring a region should invalidate its cached result before rendering");

context.window.RNAxRayData = {
  findFastaEntry: function (fasta, rna) {
    const id = fasta && fasta.mapping && fasta.mapping[rna];
    return id && (fasta.sequences || []).find(function (entry) { return entry.id === id; }) || null;
  }
};
const fastaState = {
  summary: { rnaNames: ["RNA_A", "RNA_B"] },
  fasta: {
    mapping: {}, sequences: [{ id: "reference_A", sequence: "ACGU" }],
    mappingEditorRna: "RNA_A", mappingEditorReference: ""
  },
  viewpoint: { rna: "RNA_A", rangeMode: "reference", results: { stale: true } }
};
assert.equal(context.window.RNAxRayUI.handleInput(fastaState, {
  dataset: { feature: "fasta-mapping-editor", key: "mappingEditorReference" }, value: "reference_A"
}), true);
assert.equal(fastaState.fasta.mappingEditorReference, "reference_A",
  "search-input text must be synchronised before an asynchronous render");
const mappingReferenceInput = { value: "stale-reference" };
let mappingEditorRenderCalls = 0;
assert.equal(context.window.RNAxRayUI.handleChange(fastaState, {
  dataset: { feature: "fasta-mapping-editor", key: "mappingEditorRna" },
  value: "RNA_B",
  closest: function () {
    return { querySelector: function () { return mappingReferenceInput; } };
  }
}, {
  render: function () { mappingEditorRenderCalls += 1; }
}), true);
assert.equal(fastaState.fasta.mappingEditorRna, "RNA_B");
assert.equal(fastaState.fasta.mappingEditorReference, "",
  "changing the edited RNA should synchronise its current mapping");
assert.equal(mappingReferenceInput.value, "",
  "the mounted reference input should be updated without replacing either editor control");
assert.equal(mappingEditorRenderCalls, 0,
  "moving between FASTA mapping search fields must not rebuild the dialog DOM");
fastaState.fasta.mappingEditorRna = "RNA_A";
fastaState.fasta.mappingEditorReference = "reference_A";
context.window.RNAxRayUI.handleAction(
  fastaState,
  { dataset: { featureAction: "apply-fasta-mapping" } },
  navigationApi
);
assert.equal(fastaState.fasta.mapping.RNA_A, "reference_A",
  "the bounded FASTA editor must apply an exact mapping");
assert.equal(fastaState.viewpoint.rangeMode, "reference",
  "applying a valid mapping should retain full-reference Viewpoint mode");
context.window.RNAxRayUI.handleAction(
  fastaState,
  { dataset: { featureAction: "remove-current-fasta-mapping" } },
  navigationApi
);
assert.equal(fastaState.fasta.mapping.RNA_A, undefined,
  "the bounded FASTA editor must remove the currently edited mapping");
context.window.RNAxRayUI.handleAction(
  fastaState,
  { dataset: { featureAction: "edit-fasta-mapping", rna: "RNA_B" } },
  navigationApi
);
assert.equal(fastaState.fasta.mappingEditorRna, "RNA_B");
fastaState.viewpoint.rangeMode = "reference";
context.window.RNAxRayUI.handleChange(
  fastaState,
  { dataset: { feature: "fasta-mapping", rna: "RNA_A" }, value: "reference_A" },
  navigationApi
);
assert.equal(fastaState.viewpoint.results, null, "FASTA mapping changes should invalidate viewpoint results");
assert.equal(fastaState.viewpoint.rangeMode, "reference", "a valid mapping should retain full-reference mode");
context.window.RNAxRayUI.handleChange(
  fastaState,
  { dataset: { feature: "fasta-mapping", rna: "RNA_A" }, value: "" },
  navigationApi
);
assert.equal(fastaState.viewpoint.rangeMode, "coordinates", "removing the anchor mapping should leave full-reference mode");
fastaState.viewpoint.rangeMode = "reference";
fastaState.viewpoint.results = { stale: true };
context.window.RNAxRayUI.handleAction(fastaState, { dataset: { featureAction: "remove-fasta" } }, navigationApi);
assert.equal(navigationApi.removeFastaCalls, 1, "removing FASTA should delegate to the app session owner");
assert.equal(fastaState.fasta, null, "removing FASTA should clear the loaded reference");
assert.equal(fastaState.viewpoint.results, null, "removing FASTA should invalidate viewpoint results");
assert.equal(fastaState.viewpoint.rangeMode, "coordinates", "removing FASTA should leave full-reference mode");

const replaceState = { dialog: "files" };
context.window.RNAxRayUI.handleAction(replaceState, { dataset: { featureAction: "replace-hyb" } }, navigationApi);
assert.equal(replaceState.dialog, null, "replacing HYB must close the Files dialog before landing renders");
assert.equal(navigationApi.chooseHybCalls, 1);

let structureResetCount = 0;
const structureResetOptions = [];
context.window.RNAxRayStructure = {
  reset: function (state, options) {
    structureResetCount += 1;
    structureResetOptions.push(options || {});
    state.structure.result = null;
    state.structure.selectedNucleotide = null;
    if (options && options.clearConstraints) {
      state.structure.constraintText = "";
    }
  }
};
const structureControlState = {
  structure: { source: "paste", pastedSequence: "AAAA", constraintMode: "none", constraintText: "", selectedNucleotide: 3, result: { stale: true } }
};
context.window.RNAxRayUI.handleChange(
  structureControlState,
  { dataset: { feature: "structure-control", key: "constraintMode" }, type: "select-one", value: "manual-hard-base-pairs" },
  navigationApi
);
assert.equal(structureControlState.structure.constraintMode, "manual-hard-base-pairs");
assert.equal(structureControlState.structure.result, null);
context.window.RNAxRayUI.handleChange(
  structureControlState,
  { dataset: { feature: "structure-control", key: "constraintText" }, type: "textarea", value: "4-18\n7-15" },
  navigationApi
);
assert.equal(structureControlState.structure.constraintText, "4-18\n7-15");
assert.equal(structureResetCount, 2, "Manual constraint controls should invalidate an old structure result");
assert.equal(structureResetOptions[1].clearConstraints, false,
  "editing constraints for the same sequence must not clear the constraint editor");
context.window.RNAxRayUI.handleInput(
  structureControlState,
  { dataset: { feature: "structure-control", key: "pastedSequence" }, type: "textarea", value: "CCCC" }
);
assert.equal(structureResetOptions.at(-1).clearConstraints, true);
assert.equal(structureControlState.structure.constraintMode, "manual-hard-base-pairs");
assert.equal(structureControlState.structure.constraintText, "",
  "changing the folded sequence must clear constraints authored for its predecessor");
assert.equal(structureControlState.structure.selectedNucleotide, null);

Object.assign(structureControlState.structure, {
  engine: "viennarna",
  source: "paste",
  cplfoldEvidence: "hyb-blocks",
  constraintText: "4-18"
});
context.window.RNAxRayUI.handleChange(
  structureControlState,
  { dataset: { feature: "structure-control", key: "engine" }, type: "select-one", value: "cplfold" },
  navigationApi
);
assert.equal(structureControlState.structure.engine, "cplfold");
assert.equal(structureControlState.structure.source, "reference",
  "HYB-guided CPLfold must use a mapped reference region");
assert.equal(structureControlState.structure.constraintText, "",
  "switching engines must clear coordinate-specific ViennaRNA hard pairs");
context.window.RNAxRayUI.handleChange(
  structureControlState,
  { dataset: { feature: "structure-control", key: "source" }, type: "select-one", value: "paste" },
  navigationApi
);
assert.equal(structureControlState.structure.cplfoldEvidence, "none",
  "a non-reference CPLfold source must switch to sequence-only evidence semantics");
context.window.RNAxRayUI.handleChange(
  structureControlState,
  { dataset: { feature: "structure-control", key: "cplfoldAllowPseudoknot" }, type: "radio", value: "false" },
  navigationApi
);
assert.equal(structureControlState.structure.cplfoldAllowPseudoknot, false,
  "the pseudoknot radio control must store a boolean false rather than the truthy string 'false'");

Object.assign(structureControlState.structure, {
  engine: "cplfold",
  source: "reference",
  selectedRecordIndex: null,
  constraintMode: "hyb-guided",
  cplfoldEvidence: "hyb-blocks",
  result: { stale: true }
});
context.window.RNAxRayUI.handleAction(
  structureControlState,
  { dataset: { featureAction: "record-fold", recordIndex: "7" } },
  navigationApi
);
assert.equal(structureControlState.structure.source, "record");
assert.equal(structureControlState.structure.selectedRecordIndex, 7);
assert.equal(structureControlState.structure.constraintMode, "none",
  "folding a read must not retain reference-coordinate ViennaRNA evidence");
assert.equal(structureControlState.structure.cplfoldEvidence, "none",
  "folding a read must not retain reference-coordinate CPLfold evidence");
assert.equal(navigationApi.lastNavigation, "structure");

assert.match(appSource, /addEventListener\("hashchange", handleHashChange\)/);
assert.match(appSource, /addEventListener\("input", handleInput\)/,
  "text controls must synchronise state before blur so asynchronous renders cannot erase typing");
assert.match(appSource, /element\.type === "search"/,
  "searchable large-list and FASTA mapping controls must synchronise input before blur");
assert.match(appSource, /if \(isTextEntry\(event\.target\)\) \{\s*api\.render = function \(\) \{ scheduleCommittedInputRender\(event\.target\); \};/,
  "text-field blur must use the committed-input rendering path");
assert.match(appSource, /addEventListener\("pointerdown", handlePointerDown\)[\s\S]*?addEventListener\("click", finishPointerAction\)/,
  "pointer actions must keep a blur-triggered render from replacing their click target");
assert.match(analysisPagesSource, /available\.length > 750/,
  "large RNA collections must switch away from an unbounded native select");
assert.match(analysisPagesSource, /rnas\.slice\(0, 500\)/);
assert.match(analysisPagesSource, /fasta\.sequences\.slice\(0, 500\)/);
assert.match(analysisPagesSource, /data-feature-action="probe-cplfold-capacity"/);
assert.match(analysisPagesSource, /data-feature-action="download-local-cplfold-input"/);
assert.match(analysisPagesSource, /data-key="cplfoldAllowPseudoknot"/);
assert.match(analysisPagesSource, /Secondary structure only/);
assert.match(analysisPagesSource, /Download local inputs/);
assert.match(analysisPagesSource, /cplfold-bonus-matrix\.tsv/);
assert.match(fs.readFileSync(path.join(repository, "bin", "cplfold"), "utf8"), /--sequence-file/);
assert.match(fs.readFileSync(path.join(repository, "third_party", "cplfold", "CPLfold.py"), "utf8"), /--bonus-matrix-file/);
assert.match(fs.readFileSync(path.join(repository, "web", "cplfold.worker.mjs"), "utf8"), /cplfold-capacity/);
assert.match(fs.readFileSync(path.join(repository, "web", "cplfold.worker.mjs"), "utf8"), /cplfold-bonus-matrix/);
assert.match(fs.readFileSync(path.join(repository, "web", "cplfold.worker.mjs"), "utf8"), /allowPseudoknot/);
assert.match(fs.readFileSync(path.join(repository, "web", "cplfold", "cplfold_web.py"), "utf8"), /allow_pseudoknot/);
assert.match(fs.readFileSync(path.join(repository, "third_party", "cplfold", "CPLfold.py"), "utf8"), /--no-pseudoknot/);
assert.doesNotMatch(analysisPagesSource, /rnas\.map[\s\S]{0,300}fasta\.sequences\.map/,
  "FASTA mapping controls must not build an RNA-by-reference Cartesian option set");
assert.match(appSource, /function handleHashChange\(\)\s*{\s*const previousPage = state\.activePage;\s*syncRoute\(\);\s*render\(\);[\s\S]*?previousPage !== state\.activePage[\s\S]*?window\.scrollTo\(0, 0\)/,
  "page navigation must reveal the new page heading instead of retaining another page's scroll offset");
assert.doesNotMatch(appSource, /<div class="pop-layer" data-action="close-dialog">/);
assert.match(appSource, /dialogLayer && event\.target === dialogLayer/);
assert.match(appSource, /state\.dialog === "files" && state\.summary/,
  "Files dialog rendering must be defensive while a replacement HYB is loading");
assert.match(appSource, /state\.dialog = null;\s*state\.file = file;/,
  "starting any HYB parse must close an open workspace dialog");
assert.match(appSource, /state\.summary = null;\s*state\.records = \[\];\s*state\.filters = null;\s*state\.interactionResults = \[\];/,
  "replacing a HYB must release old primary records and derived interaction state before parsing");
assert.match(appSource, /rebuildFastaMapping\(summary\)/,
  "replacing HYB must rebuild the retained FASTA mapping for the new RNA names");
assert.match(appSource, /state\.parseSession === parseSession && state\.file === file/,
  "primary-file parsing must guard delayed callbacks with a session identity");

const fastaLoaderMatch = appSource.match(/async function loadFasta\(file\)\s*{([\s\S]*?)\n  async function loadComparisonFiles/);
assert.ok(fastaLoaderMatch, "The FASTA loader should remain available for session-safety checks");
const fastaLoaderSource = fastaLoaderMatch[1];
assert.match(fastaLoaderSource, /const primaryFile = state\.file;/);
assert.match(fastaLoaderSource, /const primarySummary = state\.summary;/);
assert.match(fastaLoaderSource, /if \(!state\.analysisEntered\) \{\s*render\(\);\s*\}/,
  "the file-review stage must show that a FASTA is being read before analysis opens");
assert.match(fastaLoaderSource, /state\.fastaLoadSession = fastaLoadSession;/);
assert.match(
  fastaLoaderSource,
  /return state\.fastaLoadSession === fastaLoadSession &&\s*state\.file === primaryFile &&\s*state\.summary === primarySummary;/,
  "FASTA loads must belong to the same token, primary file, and parsed summary"
);
assert.match(fastaLoaderSource, /const text = await file\.text\(\);\s*if \(!fastaLoadSessionIsCurrent\(\)\)/,
  "FASTA text reads must re-check their captured analysis session");
assert.match(fastaLoaderSource, /const mapping = window\.RNAxRayData\.buildFastaMapping\(primarySummary\.rnaNames \|\| \[\], sequences\)/,
  "FASTA mapping must use the captured summary rather than a replacement analysis");
assert.match(fastaLoaderSource, /const hash = await digestFile\(file\);\s*if \(state\.fasta !== loadedFasta\)/,
  "FASTA digest completion must use file identity so a retained reference can finish hashing across a primary-HYB replacement");
assert.match(fastaLoaderSource, /if \(state\.fastaLoadSession === fastaLoadSession\) \{\s*invalidateFastaLoad\(\);\s*}/,
  "an old retained-FASTA digest must not invalidate a newer FASTA load token");
assert.match(fastaLoaderSource, /state\.dialog === "files" \|\| !state\.analysisEntered/,
  "the file-review stage must refresh when FASTA loading or fingerprinting finishes");
assert.match(fastaLoaderSource, /catch \(error\) \{\s*if \(loadedFasta\) \{\s*if \(state\.fasta !== loadedFasta\)/,
  "FASTA hash failures must update only the same retained reference object");
assert.match(fastaLoaderSource, /loadedFasta\.sha256Unavailable = true;[\s\S]*?render\(\);[\s\S]*?fingerprint is unavailable/,
  "a FASTA hash failure must leave an explicit terminal unavailable state");
assert.match(appSource, /digestFile\(file\)\.then[\s\S]*?state\.summary\.sha256Unavailable = !hash;[\s\S]*?\.catch[\s\S]*?state\.summary\.sha256Unavailable = true;/,
  "primary HYB hashing must handle failures without an unhandled rejection or a permanent pending label");
assert.match(analysisPagesSource, /sha256Unavailable \? "Unavailable" : "Calculating locally…"/,
  "the Files drawer must distinguish terminal hash failure from pending calculation");
assert.match(indexSource, /<script src="\.\/build-info\.js" defer><\/script>/);
assert.match(appSource, /data-action="start-over"/,
  "the Data panel must expose a start-over action");
assert.match(appSource, /action === "start-over"\) \{\s*state\.dialog = "clear";/,
  "start-over must ask before it discards the session");
assert.match(appSource, /action === "confirm-clear"\) \{\s*resetToLanding\(\);/,
  "confirming must clear state and return to the landing upload screen");
// Data, Help, Display and Privacy share one drawer; the header has no
// destructive control and no bare glyph button.
["files", "display", "privacy"].forEach(function (id) {
  assert.match(appSource, new RegExp('state\\.dialog === "' + id + '"[\\s\\S]{0,200}?renderDrawer\\("' + id + '"'), id + " must open as a drawer");
});
assert.match(appSource, /return renderDrawer\("help"/, "help must open as a drawer");
const workspaceHeader = appSource.match(/function renderWorkspaceHeader\(\) \{([\s\S]*?)\n  \}/)[1];
assert.doesNotMatch(workspaceHeader, /start-over|toggle-theme/, "the header keeps Start over and the theme switch in their panels");
assert.match(workspaceHeader, /data-action="open-files">Data</);
assert.match(appSource, /const PAGE_HELP = \{[\s\S]*?"contact-map"[\s\S]*?compare[\s\S]*?structure/, "help must explain the analysis pages");
assert.match(indexSource, /vendor\/d3\/d3\.v3\.min\.js/,
  "the folded RNA view must load its pinned local D3 dependency");
assert.match(indexSource, /vendor\/fornac\/fornac\.js/,
  "the folded RNA view must load the pinned local fornac renderer");
assert.ok(fs.existsSync(path.join(repository, "web", "vendor", "fornac", "LICENSE.txt")),
  "the vendored fornac renderer must include its Apache-2.0 license");
assert.ok(fs.existsSync(path.join(repository, "web", "vendor", "d3", "LICENSE.txt")),
  "the vendored D3 dependency must include its license");
assert.match(workflowSource, /GITHUB_SHA[\s\S]*?> web\/build-info\.js/,
  "the Pages artifact must record the exact deployed Git commit");
assert.match(workflowSource, /Version static assets for browser cache refresh[\s\S]*?app\.js\?build=\$\{GITHUB_SHA\}[\s\S]*?styles\.css\?build=\$\{GITHUB_SHA\}/,
  "the deployed HTML must version CSS and JavaScript URLs with the exact Git commit");
assert.match(workflowSource, /Configure GitHub Pages[\s\S]*?if: \$\{\{ vars\.CPLFOLD_DISTRIBUTION_APPROVED == 'true' \}\}/,
  "Pages configuration must remain behind the CPLfold redistribution approval gate");
assert.match(workflowSource, /Upload GitHub Pages artifact[\s\S]*?if: \$\{\{ vars\.CPLFOLD_DISTRIBUTION_APPROVED == 'true' \}\}/,
  "the browser CPLfold artifact must not be published without explicit licence approval");
assert.match(workflowSource, /deploy:\s*\n\s*if: \$\{\{ vars\.CPLFOLD_DISTRIBUTION_APPROVED == 'true' \}\}/,
  "the deploy job must remain behind the CPLfold redistribution approval gate");
assert.match(analysisPagesSource, /Git commit:/,
  "the Files drawer must display deployed build provenance");
assert.match(appSource, /data-action="load-example"/,
  "the landing page must expose the included example action");
assert.match(appSource, /analysisEntered: false/,
  "the app must begin in the file-preparation stage");
assert.match(appSource, /const workspaceOpen = !!state\.summary && state\.analysisEntered;/,
  "a parsed HYB must not open the workspace until the user confirms");
assert.match(appSource, /if \(!state\.summary \|\| !state\.analysisEntered\) \{\s*state\.activePage = "landing";/,
  "unconfirmed parsed files must remain on the landing review stage even if the hash changes");
assert.match(appSource, /state\.summary && !state\.analysisEntered\) \{\s*return renderPreparedFilePanel\(\);/,
  "the landing page must render the file-review stage after HYB parsing");
assert.match(indexSource, /stylesheet" href="\.\/report\.css"/,
  "the report stylesheet must be included in the static application");
assert.match(indexSource, /script src="\.\/report-page\.js" defer/,
  "the report page module must load before the app controller");
assert.match(appSource, /const reportPage = \{ id: "report"/,
  "the app must register a dedicated report route");
assert.match(appSource, /workspacePages\.some\(function \(page\) \{ return page\.id === candidate; \}\)/,
  "the report route must be accepted by workspace navigation");
assert.match(appSource, /data-action="navigate" data-page="report">Report/,
  "the workspace header must expose the consolidated report action");
assert.match(appSource, /action === "print-report"/,
  "the report must invoke the browser print dialog");
assert.match(appSource, /action === "download-full-report"/,
  "the report must expose a machine-readable download action");
assert.match(appSource, /window\.RNAxRayReport\.afterRender\(state, featureApi\(\)\)/,
  "the report must receive its post-render structure visualisation hook");
assert.match(reportPageSource, /data-report-page/,
  "the report page must have a stable root marker");
assert.match(reportPageSource, /Print \/ Save PDF/,
  "the report page must expose browser PDF instructions");
assert.match(reportPageSource, /Executive summary/,
  "the report page must include an executive summary");
assert.match(reportPageSource, /Contact Map/,
  "the report page must include Contact Map state");
assert.match(reportPageSource, /RNA Structure/,
  "the report page must include RNA Structure state");
assert.match(reportCssSource, /@media print/,
  "the report must have print-specific CSS");
assert.match(reportCssSource, /\.workspace-header[\s\S]*\.sidebar[\s\S]*\.report-actions/,
  "print CSS must remove workspace chrome and report-only controls");
assert.match(workflowSource, /scripts\/verify-report-render\.cjs/,
  "the deployment workflow must track report render changes");
assert.match(workflowSource, /node scripts\/verify-report-render\.cjs/,
  "the deployment workflow must run the report render contract");
["verify-deseq", "verify-arc-map", "verify-region-panels", "verify-folding-energy"].forEach(function (script) {
  assert.ok(workflowSource.includes('"scripts/' + script + '.cjs"'), "the deployment workflow must track " + script);
  assert.ok(workflowSource.includes("node scripts/" + script + ".cjs"), "the deployment workflow must run " + script);
});
assert.ok(workflowSource.indexOf("bash scripts/build-vienna-wasm.sh") < workflowSource.indexOf("node scripts/verify-folding-energy.cjs"),
  "verify-folding-energy must run after the ViennaRNA build so it folds instead of skipping");

// Loading or closing a file resets the arc map, region panels and folding
// energy states and stops the DESeq2 and RNAcofold workers.
const resetSites = appSource.match(/state\.comparison = null;\s*resetAnalysisModules\(\);/g) || [];
assert.equal(resetSites.length, 4, "resetDataState, startParsing, clearSession and resetToLanding must reset the analysis modules");
assert.match(appSource, /function unmount\(\)[\s\S]*?stopAnalysisWorkers\(\);[\s\S]*?\n  }/,
  "unmounting must stop the analysis workers");
const moduleResetSource = appSource.match(/  function stopAnalysisWorkers\(\) \{[\s\S]*?\n  function cancelComparisonLoads/);
assert.ok(moduleResetSource, "app.js must define stopAnalysisWorkers/resetAnalysisModules");
const resetCalls = [];
const resetContext = vm.createContext({
  state: { arcMap: { a: "old" }, regionPanels: { padj: "0.5" }, foldingEnergy: { running: true } },
  window: {
    RNAxRayDeseqCard: { stop: function () { resetCalls.push("deseq"); } },
    RNAxRayFoldingEnergy: { stop: function (fe) { resetCalls.push("energy"); fe.running = false; }, defaultState: function () { return { fresh: "energy" }; } },
    RNAxRayArcMap: { defaultState: function () { return { fresh: "arc" }; } },
    RNAxRayRegionPanels: { defaultState: function () { return { fresh: "panels" }; } }
  }
});
vm.runInContext(moduleResetSource[0].replace(/\n  function cancelComparisonLoads$/, "") + "\nresetAnalysisModules();", resetContext);
assert.deepEqual(resetCalls, ["deseq", "energy"], "the reset stops both analysis workers");
assert.equal(JSON.stringify(resetContext.state), JSON.stringify({ arcMap: { fresh: "arc" }, regionPanels: { fresh: "panels" }, foldingEnergy: { fresh: "energy" } }),
  "the reset restores the modules' default states");
const bareResetContext = vm.createContext({ state: { arcMap: { a: 1 } }, window: {} });
vm.runInContext(moduleResetSource[0].replace(/\n  function cancelComparisonLoads$/, "") + "\nresetAnalysisModules();", bareResetContext);
assert.equal(bareResetContext.state.arcMap, null, "without the modules the reset still clears their state");
assert.match(appSource, /data-action="enter-analysis">Enter analysis/,
  "the file-review stage must expose a separate analysis-entry action");
{
  // First screen: the drop zone comes before the example, and Enter
  // analysis comes before the (long) list of loaded files.
  const filePanel = appSource.slice(appSource.indexOf("function renderFilePanel()"), appSource.indexOf("function renderExampleStrip()"));
  assert.ok(filePanel.indexOf('class="dropzone"') > 0 && filePanel.indexOf('class="dropzone"') < filePanel.indexOf("renderExampleStrip()"),
    "the HYB drop zone must come before the example");
  const prepared = appSource.slice(appSource.indexOf("function renderPreparedFilePanel()"));
  assert.ok(prepared.indexOf('class="prepared-next-step"') < prepared.indexOf('class="prepared-file-list"'),
    "Enter analysis must come before the file list");
  assert.match(appSource, /<details class="example-more"[\s\S]*?class="example-files"/,
    "the example's description and downloads must be folded");
}
assert.match(appSource, /data-action="reload-page">Reload page/,
  "a landing load error must offer Reload page");
assert.match(appSource, /action === "reload-page"\)\s*\{\s*window\.location\.reload\(\);/,
  "Reload page must reload the page");
assert.match(appSource, /error\.source === "example"[\s\S]*?data-action="load-example">Try again/,
  "a failed example load must offer Try again");
assert.match(appSource, /function enterAnalysis\(\)\s*\{[\s\S]*?state\.analysisEntered = true;[\s\S]*?navigate\("overview"\);/,
  "entering analysis must be an explicit state transition");
assert.match(appSource, /state\.loading = null;\s*state\.analysisEntered = false;\s*state\.activePage = "landing";\s*setRouteHash\("#\/"\);\s*if \(parseSession\.referenceFile\)/,
  "HYB parsing must finish on the review stage instead of navigating directly to Overview");
assert.match(appSource, /example\.downloads\.map\(/,
  "the included example must visibly list its files with download links");
assert.match(appSource, /\[example\.primary\.file, example\.reference\.file\]\.map\(function \(name\) \{\s*return fetchExampleFile\(name/,
  "the included example must load both HYB and FASTA assets");
assert.match(appSource, /startParsing\(files\[0\], \{ referenceFile: files\[1\], example: true \}\)/,
  "the example HYB is parsed like an upload, with its FASTA");
assert.match(appSource, /id="fasta-file-input"[^>]*accept="\.fa,\.fasta,\.fna,\.fas,text\/plain"/,
  "the landing page must expose an optional FASTA file input");
assert.match(appSource, /state\.landingFastaFile = file;[\s\S]*?render\(\);/,
  "a FASTA selected before the primary HYB must be retained on the landing page");
assert.match(appSource, /const referenceFile = parseOptions\.referenceFile \|\| state\.landingFastaFile \|\| null;/,
  "primary HYB parsing must carry a landing-page FASTA into the workspace");
assert.match(appSource, /if \(parseSession\.referenceFile\) \{\s*loadFasta\(parseSession\.referenceFile\);\s*\}/,
  "a retained example or landing-page FASTA must load after HYB parsing");
assert.match(analysisPagesSource, /href="\.\/local-cplfold\.html"[^>]*>Open local run guide<\/a>/,
  "the CPLfold setup must link to the dedicated local-run guide page");
assert.match(localCplfoldSource, /<h1 id="local-run-title">Run longer sequences locally<\/h1>/,
  "the dedicated local-run guide page must have a clear title");
assert.match(localCplfoldSource, /--bonus-matrix-file cplfold-bonus-matrix\.tsv/,
  "the local-run guide must document the HYB-derived bonus matrix input");
assert.match(localCplfoldSource, /RNAXRAY_CPLFOLD_MAX_NT=2000 bin\/cplfold/,
  "the local-run guide must document deliberate local sequence-limit override");
assert.match(appSource, /removeFasta: removeFasta/,
  "the feature UI must delegate FASTA removal to the app session owner");
assert.match(appSource, /function startParsing\(file(?:,\s*options)?\)\s*{\s*terminateWorker\(\);\s*cancelComparisonLoads\(\);\s*invalidateFastaLoad\(\);/,
  "starting a replacement primary HYB must cancel pending parser and FASTA work");
assert.match(appSource, /function removeFasta\(\)\s*{\s*invalidateFastaLoad\(\);/,
  "removing the reference must cancel pending FASTA work");
assert.match(appSource, /function clearSession\(\)\s*{\s*terminateWorker\(\);\s*cancelComparisonLoads\(\);\s*invalidateFastaLoad\(\);/,
  "clearing the analysis must cancel pending comparison and FASTA work");
assert.match(appSource, /function resetToLanding\(\)\s*{\s*terminateWorker\(\);\s*cancelComparisonLoads\(\);\s*invalidateFastaLoad\(\);/,
  "resetting to the landing page must cancel pending comparison and FASTA work");
const resetSource = appSource.match(/function resetToLanding\(\)\s*{([\s\S]*?)\n  function terminateWorker/);
assert.ok(resetSource);
assert.match(resetSource[1], /state\.activePage = "landing";[\s\S]*?setRouteHash\("#\/"\);/,
  "resetting the analysis must also return the browser route to the landing hash");
["summary", "records", "fasta", "filters", "interactionResults", "contact", "region", "viewpoint", "comparison", "structure", "analysisEntered"].forEach(function (field) {
  assert.match(resetSource[1], new RegExp("state\\." + field + "\\s*="),
    "resetting after a failed replacement must release " + field);
});

const comparisonLoaderMatch = appSource.match(/async function loadComparisonFiles\(files(?:, options)?\)\s*{([\s\S]*?)\n  function parseComparisonFile/);
assert.ok(comparisonLoaderMatch, "The comparison loader should remain available for session-safety checks");
const comparisonLoaderSource = comparisonLoaderMatch[1];
assert.match(comparisonLoaderSource, /const comparisonSession = state\.comparison;/);
assert.match(comparisonLoaderSource, /const primaryFile = state\.file;/);
assert.match(comparisonLoaderSource, /cancelComparisonLoads\(\);\s*const comparisonLoadSession = \{\};\s*state\.comparisonLoadSession = comparisonLoadSession;/,
  "a new comparison batch must cancel and supersede any prior batch");
assert.match(comparisonLoaderSource, /state\.comparison === comparisonSession &&\s*state\.file === primaryFile &&\s*state\.comparisonLoadSession === comparisonLoadSession;/,
  "comparison callbacks must belong to the captured dataset, primary file, and load token");
assert.match(comparisonLoaderSource, /const parsed = await parseComparisonFile\(file\);\s*if \(!comparisonSessionIsCurrent\(\)\)\s*{\s*return;/);
assert.ok(
  (comparisonLoaderSource.match(/comparisonSessionIsCurrent\(\)/g) || []).length >= 5,
  "Every asynchronous comparison phase should verify that its primary session is still current"
);
assert.doesNotMatch(
  comparisonLoaderSource,
  /state\.comparison\.(?:datasets|error|loading|result)/,
  "Comparison mutations must target the captured session, never a replacement session"
);

const comparisonParserSource = appSource.match(/function parseComparisonFile\(file\)\s*{([\s\S]*?)\n  function cancelComparisonLoads/);
assert.ok(comparisonParserSource, "Comparison parsing should expose a cancellable operation boundary");
assert.match(comparisonParserSource[1], /state\.comparisonParsers\.add\(parser\)/,
  "each comparison worker must be registered while active");
assert.match(comparisonParserSource[1], /state\.comparisonParsers\.delete\(parser\)/,
  "settled comparison workers must leave the active registry");
assert.match(comparisonParserSource[1], /error\.name = "AbortError";\s*reject\(error\);/,
  "cancelling comparison parsing must settle its pending Promise");
assert.match(appSource, /function cancelComparisonLoads\(\)\s*{\s*state\.comparisonLoadSession = null;\s*Array\.from\(state\.comparisonParsers\)\.forEach[\s\S]*?parser\.cancel\(\);[\s\S]*?state\.comparisonParsers\.clear\(\);\s*}/,
  "comparison cancellation must terminate every active parser and invalidate its batch token");

// The Compare page builds whole-genome comparisons in comparison.worker.js
// (checked against the in-thread result in verify-example.cjs) and pages the
// data table from a cached order instead of sorting every cell per render.
const pageDataSource = fs.readFileSync(path.join(repository, "web", "page-data.js"), "utf8");
assert.match(pageDataSource, /"comparison\.worker\.js\?build=" \+ encodeURIComponent\(root\.RNAXRAY_BUILD && root\.RNAXRAY_BUILD\.commit \|\| "local"\)/,
  "the comparison worker URL carries the build cache-buster");
assert.match(pageDataSource, /function invalidate\(\) \{[\s\S]*?cancelComparisonJob\(\);/, "invalidating the page data cancels a running comparison");
assert.match(fs.readFileSync(path.join(repository, "web", "comparison.worker.js"), "utf8"), /importScripts\("\.\/analysis-data\.js" \+ BUILD_QUERY/,
  "the worker loads analysis-data.js with the page's build query");
assert.doesNotMatch(analysisPagesSource, /result\.cells\.slice\(\)\.sort/, "the comparison data table must not sort every cell on render");
assert.match(analysisPagesSource, /data-comparison-progress/, "the Compare placeholder shows the comparison progress");

process.stdout.write("ui-contract: ok\n");

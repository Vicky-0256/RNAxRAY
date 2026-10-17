#!/usr/bin/env node
// Checks the included "Try example" (web/example.js): the manifest, that every
// file it names is in web/, that the landing page and app use it, and then the
// example end to end in node, through the same code the browser runs:
//
//   parser.worker.js (gzip .hyb)  ->  BrowserProvider  ->  Compare page
//   (comparisonRnaPlan + getContactBins + buildComparisonResults: effect map
//   and similarity heatmap, panel B)  ->  differential test card (deseq-card.js
//   run() on the provider's arms, panel A)  ->  arc map fed by the result
//   (panel C)  ->  region structures (D, E)  ->  folding energies with the
//   ViennaRNA WebAssembly build (F, G; skipped when it is not built).
//
// The expected numbers come from the original RNAxRay pipeline on the same four
// 1-in-10 subsets (scripts/make-example-reference.sh): plot_hybrids_3.awk
// contact maps, bin/rnaxray_compare (DESeq_run.R, R DESeq2 1.46, -m 2 -r 100),
// plot_similarity_map on the merged maps with bins >= 10, and
// reproduce_zikv/analysis/select_regions_cplfold.py / folding_energy.py with
// R's t.test.  With RNAXRAY_EXAMPLE_REFERENCE=<dir> (that script's output) the
// similarity map, significant cells, interactions and energies are compared
// cell by cell as well.
//
// The differential test takes ~15 s; RNAXRAY_EXAMPLE_QUICK=1 stops after the
// Compare maps.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const repository = path.resolve(__dirname, "..");
const web = function (file) { return path.join(repository, "web", file); };
const example = require(web("example.js"));
const reference = process.env.RNAXRAY_EXAMPLE_REFERENCE || "";

// R / rnaxray on the subsets (see the header)
const EXPECTED = {
  records: { ZAFR_REP1: 22416, ZAFR_REP2: 34939, ZILM_REP2: 57636, ZILM_REP3: 18466 },
  // plot_hybrids_3.awk 10-nt cells per replicate
  cells: { ZAFR_REP1: 378442, ZAFR_REP2: 432622, ZILM_REP2: 412893, ZILM_REP3: 429777 },
  similarity: { cells: 20958, cap: 45, floor: 10 },
  // R finds 8,353 significant cells (2,755 up): one more cell, 4810_4740,
  // sits on the cutoff (padj 0.0500069 in R, 0.0499966 here; the port's padj
  // agree with R to ~1e-3 relative, see verify-deseq.cjs).  The merged
  // interactions are the same.
  deseq: { significant: 8354, significantUp: 2756, significantDown: 5598, interactionsUp: 133, interactionsDown: 243, strictUp: 66, strictDown: 153 },
  deseqR: { significant: 8353, significantUp: 2755, borderline: ["4810_4740"] },
  regionA: { rank: 2, a: 355, b: 10265, own: 29, other: 0, windows: { X0: 341, X1: 415, Y0: 10252, Y1: 10318 } },
  regionB: { rank: 17, a: 1625, b: 1905, own: 27, other: 0, windows: { X0: 1578, X1: 1643, Y0: 1873, Y1: 1934 } },
  // folding_energy.py + R t.test on rnaxray_compare's interactions
  energy: {
    enriched_in_one: { n: 66, t: -6.27730439553, p: 3.21057241079e-08 },
    enriched_in_two: { n: 153, t: 11.0549466297, p: 3.22040717566e-21 }
  },
  // the browser's interactions: one ZAFR-enriched interaction is the exactly
  // tied neighbour of R's pick (R padj 0.00196743622441416 for 6350_7110 and
  // 6350_7120; ties are merged in table order here), so panel F's t-test
  // differs slightly; R's t.test on the browser's dG gives these numbers
  energyWeb: {
    enriched_in_one: { n: 66, t: -6.3268449064, p: 2.63298940991e-08 },
    enriched_in_two: { n: 153, t: 11.0549466297, p: 3.22040717566e-21 }
  },
  tieSwaps: [["up", "6350_7110", "6350_7120"]]
};

const same = function (actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message || "");
};
const signif = function (value, digits) { return Number(Number(value).toPrecision(digits)); };

// ---- manifest and landing page
const files = example.files();
assert.ok(files.length >= 9, "the example names its files");
files.forEach(function (file) {
  const full = web(example.directory + file);
  assert.ok(fs.existsSync(full) && fs.statSync(full).size > 0, "example file missing in web/: " + example.directory + file);
  assert.ok(fs.statSync(full).size < 50 * 1024 * 1024, file + " stays well below GitHub's file size limit");
});
const shipped = fs.readdirSync(web(example.directory));
same(shipped.slice().sort(), files.slice().sort(), "every shipped example file is used and listed");
const total = files.reduce(function (sum, file) { return sum + fs.statSync(web(example.directory + file)).size; }, 0);
assert.ok(total < 10 * 1024 * 1024, "the example stays below 10 MB (" + total + " bytes)");
assert.equal(example.url("ZAFR.dbn"), "./assets/examples/zikv-virion/ZAFR.dbn");
[example.primary].concat(example.replicates).forEach(function (item) {
  assert.match(item.file, /\.hyb\.gz$/, "replicates ship gzip-compressed");
  const head = fs.readFileSync(web(example.directory + item.file)).subarray(0, 2);
  assert.ok(head[0] === 0x1f && head[1] === 0x8b, item.file + " is gzip");
});
same(example.replicates.map(function (item) { return item.condition; }), ["A", "B", "B"]);
same(example.labels, { A: "ZAFR", B: "ZASI" });
assert.equal(example.primary.condition, "A");

const appSource = fs.readFileSync(web("app.js"), "utf8");
const indexSource = fs.readFileSync(web("index.html"), "utf8");
assert.ok(indexSource.indexOf('src="./example.js"') > 0 && indexSource.indexOf('src="./example.js"') < indexSource.indexOf('src="./app.js"'),
  "index.html loads example.js before app.js");
assert.match(appSource, /window\.RNAxRayExample/);
assert.match(appSource, /1-in-10 subset/, "the landing page says the example is a subset");
assert.match(appSource, /reproduce the method, not the published numbers/);
assert.match(appSource, /continueExample\(file\)/, "the replicates and arc map files load after the primary file is parsed");
assert.match(appSource, /renderExampleFileRows\(\)/, "the review step lists every example file, not only the primary HYB and FASTA");
assert.match(appSource, /example\.replicates\.map\(function \(item, index\)/);
assert.match(appSource, /example\.arcMap\.annotation, detail:/);
// in the workspace the header, sidebar and Files dialog name the other datasets
assert.match(appSource, /renderHeaderDatasets\(\)/);
assert.match(appSource, /renderSidebarDatasets\(\)/);
assert.match(fs.readFileSync(web("analysis-pages.js"), "utf8"), /renderCompareFiles\(state\)/);
assert.doesNotMatch(appSource, /ZIKV_1-10807|Livefire/, "the former example is gone");
assert.ok(!fs.existsSync(web("assets/examples/ZIKV_1-10807_example.hyb")));
// fetched lazily: nothing of the example is requested before "Try example"
assert.doesNotMatch(indexSource, /zikv-virion/);
assert.match(fs.readFileSync(path.join(repository, ".github", "workflows", "deploy-pages.yml"), "utf8"), /path: \.\/web/,
  "GitHub Pages publishes web/, assets included");

// ---- browser code in node
function parseHyb(file) {
  const context = vm.createContext({ TextDecoder, TransformStream, DecompressionStream, self: { postMessage: function () {} } });
  vm.runInContext(fs.readFileSync(web("parser.worker.js"), "utf8"), context, { filename: "parser.worker.js" });
  return new Promise(function (resolve, reject) {
    context.self.postMessage = function (message) {
      if (message.type === "complete") resolve(message);
      if (message.type === "error") reject(new Error(message.message));
    };
    context.self.onmessage({ data: { file: new File([fs.readFileSync(file)], path.basename(file)) } });
  });
}

// Loaded with runInThisContext (see verify-deseq.cjs: a separate vm context
// is ~10x slower on a genome).
const win = { navigator: { deviceMemory: 8, hardwareConcurrency: 4 } };
const documentStub = { querySelector: function () { return null; }, getElementById: function () { return null; } };
["analysis-data.js", "data-provider.js", "page-data.js", "deseq.js", "arc-map.js", "deseq-card.js", "region-panels.js", "folding-energy.js", "results.js"].forEach(function (file) {
  const source = fs.readFileSync(web(file), "utf8");
  vm.runInThisContext("(function (window, self, module, document, navigator) {" + source + "\n})", { filename: file })(win, win, undefined, documentStub, win.navigator);
});
const data = win.RNAxRayData;
const D = win.RNAxRayDeseq;
const arc = win.RNAxRayArcMap;
const card = win.RNAxRayDeseqCard;
const rp = win.RNAxRayRegionPanels;
const fe = win.RNAxRayFoldingEnergy;

function readReference(name) {
  const file = path.join(reference, name);
  return reference && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

// ---- comparison.worker.js through page-data.js, against the in-thread result
// A Worker stand-in: runs comparison.worker.js in this process, messages
// cross by structuredClone with the transfer lists (buffers are detached, as
// in a browser).
function makeWorkerClass(log, delay) {
  return function FakeWorker(url) {
    assert.match(url, /^\.\/comparison\.worker\.js\?build=local$/, "the worker URL carries the build cache-buster");
    const outer = this;
    const entry = { done: false, terminatedEarly: false, progress: 0 };
    if (log) log.push(entry);
    let terminated = false;
    const scope = { location: { search: "?build=local" }, navigator: win.navigator };
    scope.self = scope;
    scope.postMessage = function (message, transfer) {
      const copy = structuredClone(message, { transfer: transfer || [] });
      if (message.type === "done") {
        entry.done = true;
        assert.ok(transfer && transfer.length >= 11, "the worker transfers its typed arrays");
      }
      if (message.type === "progress") entry.progress += 1;
      setImmediate(function () { if (!terminated && outer.onmessage) outer.onmessage({ data: copy }); });
    };
    scope.importScripts = function () {
      Array.from(arguments).forEach(function (file) {
        assert.match(file, /^\.\/(analysis-data|data-provider)\.js\?build=local$/, "worker scripts carry the build query");
        const name = file.replace(/^\.\//, "").replace(/\?.*$/, "");
        vm.runInThisContext("(function (window, self, module, navigator) {" + fs.readFileSync(web(name), "utf8") + "\n})", { filename: name })(scope, scope, undefined, scope.navigator);
      });
    };
    vm.runInThisContext("(function (self, importScripts) {" + fs.readFileSync(web("comparison.worker.js"), "utf8") + "\n})", { filename: "comparison.worker.js" })(scope, scope.importScripts);
    this.postMessage = function (message, transfer) {
      const copy = structuredClone(message, { transfer: transfer || [] });
      setTimeout(function () { if (!terminated) scope.onmessage({ data: copy }); }, delay || 0);
    };
    this.terminate = function () { terminated = true; entry.terminatedEarly = !entry.done; };
  };
}

function sameComparison(actual, expected, label) {
  same(Object.keys(actual), Object.keys(expected), label + ": result fields");
  Object.keys(expected).forEach(function (key) {
    if (key === "cells" || key === "conservedCells" || key === "cellMap") return;
    if (key === "groupA" || key === "groupB") {
      same(actual[key].map(function (d) { return d.id; }), expected[key].map(function (d) { return d.id; }), label + ": " + key);
      return;
    }
    same(actual[key], expected[key], label + ": " + key);
  });
  ["cells", "conservedCells"].forEach(function (key) {
    assert.equal(actual[key].length, expected[key].length, label + ": " + key);
    for (let index = 0; index < expected[key].length; index += 1) {
      if (JSON.stringify(actual[key][index]) !== JSON.stringify(expected[key][index])) {
        assert.fail(label + ": " + key + "[" + index + "] " + JSON.stringify(actual[key][index]) + " vs " + JSON.stringify(expected[key][index]));
      }
    }
  });
  for (let index = 0; index < expected.cells.length; index += 997) {
    const cell = expected.cells[index];
    same(actual.cells[index].datasets, cell.datasets, label + ": per-dataset values");
    assert.equal(data.comparisonCellAt(actual, cell.x, cell.y), actual.cells[index], label + ": cell lookup");
  }
  same(Array.from(data.comparisonOrder(actual, "effect")), Array.from(data.comparisonOrder(expected, "effect")), label + ": effect order");
}

async function settle(controller, pageId) {
  let pending = controller.ensure(pageId);
  for (let round = 0; pending && round < 10; round += 1) {
    await pending;
    pending = controller.ensure(pageId);
  }
  assert.equal(pending, null, pageId + " data settles");
}

async function compareWorkerPath(provider, comparison, expected) {
  const pageData = win.RNAxRayPageData;
  const run = async function (WorkerClass, edit, source) {
    win.Worker = WorkerClass;
    const state = { selection: null, summary: null, comparison: Object.assign({}, comparison, { result: null, datasets: comparison.datasets.slice() }) };
    const controller = pageData.createController({ state: state });
    controller.setProvider(source || provider);
    await controller.setSelection({ datasetIds: ["primary"] });
    if (edit) await edit(state, controller);
    await settle(controller, "compare");
    controller.destroy();
    delete win.Worker;
    return state;
  };
  // the worker path
  const workers = [];
  const viaWorker = await run(makeWorkerClass(workers));
  assert.equal(workers.length, 1, "one worker per comparison");
  assert.ok(workers[0].done && workers[0].progress >= 5, "the worker reports progress per dataset and finishes");
  assert.equal(viaWorker.comparison.progress, null, "progress is cleared when the comparison is done");
  sameComparison(viaWorker.comparison.result, expected, "worker");
  // packed records are cached in the provider and copied, not detached
  const packed = await provider.getContactRecords({ datasetIds: ["primary"] });
  assert.equal(packed.oneStart.length, EXPECTED.records.ZAFR_REP1, "the provider's packed records stay usable");
  // supersede: a changed bin size while the first run is in the worker
  const terminations = [];
  const superseded = await run(makeWorkerClass(terminations, 200), async function (state, controller) {
    const first = controller.ensure("compare");
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    assert.equal(terminations.length, 1, "the first run is in its worker");
    assert.ok(state.comparison.progress && /Reading|Binning/.test(state.comparison.progress.stage), "the Compare page has a progress stage while the worker runs");
    state.comparison.binSize = "100";
    state.comparison.result = null;
    controller.ensure("compare");
    await first;
  });
  assert.equal(terminations.length, 2, "a second run for the new inputs");
  assert.ok(terminations[0].terminatedEarly && !terminations[1].terminatedEarly, "the stale worker is terminated before it finishes");
  assert.equal(superseded.comparison.result.binSize, 100, "the newest inputs win");
  // a provider without getContactRecords (the desktop app): its contact
  // bins go to the worker as transferred typed arrays
  const binsOnly = Object.create(provider, { getContactRecords: { value: undefined } });
  const viaBins = await run(makeWorkerClass(), null, binsOnly);
  sameComparison(viaBins.comparison.result, expected, "worker from contact bins");
  // a worker that cannot load: the page builds the comparison itself
  const failing = function () {
    const self = this;
    this.postMessage = function () { setImmediate(function () { self.onerror({ message: "404", preventDefault: function () {} }); }); };
    this.terminate = function () {};
  };
  const fallback = await run(failing);
  sameComparison(fallback.comparison.result, expected, "fallback");
}

// ---- the comparison data table: one virtual-scroll window per render from a cached order
let tableRenderMs = 0;
function comparisonTableTiming(result) {
  const context = { window: { RNAxRayData: data }, document: documentStub, console: console, Intl: Intl };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(web("analysis-pages.js"), "utf8"), context, { filename: "analysis-pages.js" });
  const pages = context.window.RNAxRayPages;
  assert.equal(typeof pages.renderComparisonDataTable, "function", "analysis-pages.js exposes the data table renderer");
  const comparison = { conditionALabel: "ZAFR", conditionBLabel: "ZASI", tableSort: "effect", tableScrollTop: 0 };
  const first = pages.renderComparisonDataTable(result, comparison);
  // the first page equals the former cells.slice().sort(|effect|).slice(0, 150)
  const reference = result.cells.slice().sort(function (left, right) { return Math.abs(right.effect) - Math.abs(left.effect); }).slice(0, 150);
  const rows = data.comparisonOrderedCells(result, "effect", 0, 150);
  assert.ok(rows.every(function (cell, index) { return cell === reference[index]; }), "the data table keeps the |effect| order");
  const firstWindow = pages.comparisonTableWindow(result.cells.length, pages.comparisonRowHeight(), 0, 640);
  assert.equal((first.match(/class="comparison-row/g) || []).length, firstWindow.count, "only the visible window of bins is rendered");
  assert.ok(firstWindow.count > 0 && firstWindow.count < 60, "the window holds " + firstWindow.count + " bins, not the whole table");
  let slowest = 0;
  for (let round = 0; round < 5; round += 1) {
    comparison.tableScrollTop = round * 150000 * pages.comparisonRowHeight();
    const started = process.hrtime.bigint();
    pages.renderComparisonDataTable(result, comparison);
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - started) / 1e6);
  }
  tableRenderMs = slowest;
  assert.ok(slowest < 20, "a data table render after the first takes " + slowest.toFixed(1) + " ms (< 20 ms)");
  comparison.tableSort = "similarity";
  comparison.tableScrollTop = 0;
  pages.renderComparisonDataTable(result, comparison);
  const bySimilarity = data.comparisonOrderedCells(result, "similarity", 0, 50);
  const similarityReference = result.cells.slice().sort(function (left, right) { return right.similarity - left.similarity; }).slice(0, 50);
  assert.ok(bySimilarity.every(function (cell, index) { return cell === similarityReference[index]; }), "the similarity order is a stable sort");
  const started = process.hrtime.bigint();
  pages.renderComparisonDataTable(result, comparison);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 20, "the similarity order is cached as well");
}

async function main() {
  const started = Date.now();
  const log = function (text) { process.stdout.write("example: " + text + " (" + ((Date.now() - started) / 1000).toFixed(1) + " s)\n"); };

  // gzip and plain text parse alike
  const plainText = zlib.gunzipSync(fs.readFileSync(web(example.directory + example.replicates[2].file))).toString("utf8");
  const items = [example.primary].concat(example.replicates);
  const parsed = await Promise.all(items.map(function (item) { return parseHyb(web(example.directory + item.file)); }));
  const plain = await new Promise(function (resolve, reject) {
    const context = vm.createContext({ TextDecoder, self: { postMessage: function () {} } });
    vm.runInContext(fs.readFileSync(web("parser.worker.js"), "utf8"), context, { filename: "parser.worker.js" });
    context.self.postMessage = function (message) {
      if (message.type === "complete") resolve(message);
      if (message.type === "error") reject(new Error(message.message));
    };
    context.self.onmessage({ data: { file: new File([plainText], "ZILM_REP3.hyb") } });
  });
  assert.equal(plain.summary.validRecords, parsed[3].summary.validRecords, "the gzip file parses to the same records as its text");
  same(plain.records.slice(0, 50).map(function (r) { return r.id; }), parsed[3].records.slice(0, 50).map(function (r) { return r.id; }));
  items.forEach(function (item, index) {
    assert.equal(parsed[index].summary.validRecords, EXPECTED.records[item.label], item.label + " records");
    assert.equal(parsed[index].summary.invalidRecords, 0, item.label + " has no invalid records");
    assert.equal(item.records, EXPECTED.records[item.label], "manifest record count of " + item.label);
  });
  log("parsed " + parsed.map(function (p) { return p.summary.validRecords; }).join(" + ") + " records");

  // the website's registration: the primary file plus three comparison datasets
  const provider = new win.RNAxRayProvider.BrowserProvider({ data: data });
  items.forEach(function (item, index) {
    provider.addDataset({
      id: index ? "comparison_" + index : "primary", primary: !index, condition: item.condition, label: item.label,
      fileName: item.file, summary: parsed[index].summary, records: parsed[index].records
    });
  });
  const listed = await provider.listDatasets();
  same(listed.map(function (d) { return d.label; }), ["ZAFR_REP1", "ZAFR_REP2", "ZILM_REP2", "ZILM_REP3"]);

  // Compare page state as app.js continueExample() leaves it
  const comparison = data.defaultComparisonState(parsed[0].summary, null);
  comparison.conditionALabel = example.labels.A;
  comparison.conditionBLabel = example.labels.B;
  comparison.binSize = example.comparison.binSize;
  comparison.similarityMinimum = example.comparison.similarityMinimum;
  comparison.datasets = listed.map(function (d) {
    return { id: d.id, label: d.label, fileName: d.fileName, condition: d.condition,
      summary: { fileName: d.fileName, validRecords: d.validRecords, supportInteractions: d.supportInteractions, rnaNames: d.rnaNames } };
  });
  const afr = "ZIKV_African_KX377335-1_virusRNA";
  const ilm = "ZIKV_FrenchPolynesian_KJ776791-2_virusRNA";
  same([comparison.rnaX, comparison.rnaY], [afr, afr], "the primary file's top pair: the African genome");
  const plan = data.comparisonRnaPlan(comparison);
  same(plan.map(function (item) { return [item.rnaX, item.substituted]; }), [[afr, false], [afr, false], [ilm, true], [ilm, true]],
    "ZILM replicates contribute their own genome, compared by position");
  same(card.rnaPlan(comparison).map(function (item) { return item.rnaX; }), plan.map(function (item) { return item.rnaX; }),
    "the Compare maps and the differential test use the same RNA per dataset");

  // effect map and similarity heatmap (panel B), as page-data.js fetches them
  const binsList = [];
  for (let index = 0; index < comparison.datasets.length; index += 1) {
    const dataset = comparison.datasets[index];
    const bins = await provider.getContactBins({ datasetIds: [dataset.id] }, data.comparisonContactQuery(comparison, dataset));
    assert.equal(bins.ready, true, dataset.label + ": " + bins.reason);
    assert.equal(bins.binSize, 10);
    assert.equal(bins.x.length, EXPECTED.cells[dataset.label], dataset.label + " 10-nt cells = plot_hybrids_3.awk");
    binsList.push(bins);
  }
  const result = data.buildComparisonResults(Object.assign({}, comparison, {
    datasets: comparison.datasets.map(function (dataset, index) { return Object.assign({}, dataset, { contactBins: binsList[index] }); })
  }));
  assert.equal(result.ready, true, result.reason);
  assert.equal(result.binSize, 10);
  assert.equal(result.similarityMinimum, 10);
  assert.equal(result.conservedCells.length, EXPECTED.similarity.cells, "similarity cells (plot_similarity_map, merged maps >= 10)");
  assert.equal(result.similarityCap, EXPECTED.similarity.cap, "similarity cap (95% quantile)");
  assert.equal(result.similarityFloor, EXPECTED.similarity.floor);
  assert.equal(result.rnaPairs.length, 2);
  assert.ok(result.cells.length > 800000 && result.cells.length < 900000, "whole-genome effect map: " + result.cells.length + " cells");
  const similarityReference = readReference("sim_ZAFR_ZILM_min10.contact.txt");
  if (similarityReference) {
    const rows = similarityReference.trim().split("\n").slice(1);
    assert.equal(rows.length, result.conservedCells.length);
    rows.forEach(function (line) {
      const p = line.split("\t").map(Number);
      const cell = data.comparisonCellAt(result, p[0], p[1]);
      assert.ok(cell && cell.similarity === p[2], "similarity at " + p[0] + "," + p[1] + ": " + (cell && cell.similarity) + " vs " + p[2]);
    });
    log("similarity map equals plot_similarity_map cell by cell");
  }
  log("Compare maps: " + result.cells.length + " cells, " + result.conservedCells.length + " similarity cells, cap " + result.similarityCap);
  await compareWorkerPath(provider, comparison, result);
  comparisonTableTiming(result);
  log("comparison.worker.js gives the in-thread result; the data table renders a window in " + tableRenderMs.toFixed(1) + " ms");
  if (process.env.RNAXRAY_EXAMPLE_QUICK) {
    return;
  }

  // differential test (panel A) through the card, as the Run button does
  const state = { comparison: comparison, arcMap: arc.defaultState() };
  const files = {};
  ["a", "b", "annotation"].forEach(function (key) { files[key] = example.arcMap[key]; });
  Object.keys(files).forEach(function (key) {
    const text = fs.readFileSync(web(example.directory + files[key]), "utf8");
    state.arcMap[key] = key === "annotation" ? arc.parseAnnotation(text, files[key]) : arc.parseStructure(text, files[key]);
  });
  state.arcMap.labelOne = example.labels.A;
  state.arcMap.labelTwo = example.labels.B;
  assert.equal(arc.build(state.arcMap).ready, true, "arc map with the two folds and the gene track");
  const toasts = [];
  const api = {
    render: function () {},
    showToast: function (message) { toasts.push(message); },
    getArms: function (selection, query) { return provider.getArms(selection, query); }
  };
  assert.equal(card.eligibility(comparison).ok, true, card.eligibility(comparison).reason);
  card.run(state, api);
  const deseq = comparison.deseq;
  while (deseq.status === "running") {
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
  }
  assert.equal(deseq.status, "done", deseq.error);
  const s = deseq.result.summary;
  const strict = deseq.result.interactions.filter(function (row) { return row.padj < 0.01; });
  same({
    significant: s.significant, significantUp: s.significantUp, significantDown: s.significantDown, interactionsUp: s.interactionsUp, interactionsDown: s.interactionsDown,
    strictUp: strict.filter(function (row) { return row.direction === "up"; }).length, strictDown: strict.filter(function (row) { return row.direction === "down"; }).length
  }, EXPECTED.deseq, "differential test = R DESeq2 via rnaxray_compare");
  log("differential test: " + s.significant + " significant cells, " + s.interactionsUp + " / " + s.interactionsDown + " interactions");
  const heat = readReference("DESeq_sub_significant.padj_heatmap.txt");
  if (heat) {
    const sig = deseq.result.significant;
    const mine = new Map();
    for (let i = 0; i < sig.x.length; i += 1) {
      mine.set(sig.x[i] + "_" + sig.y[i], [sig.log2FoldChange[i], sig.padj[i]]);
    }
    const rows = heat.trim().split("\n").slice(1);
    assert.equal(rows.length, EXPECTED.deseqR.significant);
    assert.equal(mine.size - rows.length, EXPECTED.deseqR.borderline.length);
    EXPECTED.deseqR.borderline.forEach(function (key) {
      assert.ok(mine.has(key) && Math.abs(mine.get(key)[1] - 0.05) < 1e-3 * 0.05, "borderline cell " + key + " has padj at the cutoff");
    });
    rows.forEach(function (line) {
      const p = line.split("\t").map(Number);
      const m = mine.get(p[0] + "_" + p[1]);
      assert.ok(m, "significant cell " + p[0] + "," + p[1]);
      assert.ok(Math.abs(m[0] - p[3]) <= 1e-4 * Math.abs(p[3]) && Math.abs(m[1] - p[4]) <= 1e-2 * p[4], "cell " + p[0] + "," + p[1] + " log2FC / padj");
    });
    log("significant cells equal R cell by cell");
  }

  const enrichment = { up: readReference("sub_100range_pos_enrichment.txt"), down: readReference("sub_100range_neg_enrichment.txt") };
  if (enrichment.up && enrichment.down) {
    ["up", "down"].forEach(function (direction) {
      const rKeys = enrichment[direction].trim().split("\n").slice(1).map(function (line) { const p = line.split("\t"); return p[0] + "_" + p[1]; });
      const mine = deseq.result.interactions.filter(function (row) { return row.direction === direction; }).map(function (row) { return row.x + "_" + row.y; });
      const onlyR = rKeys.filter(function (key) { return mine.indexOf(key) < 0; });
      const onlyHere = mine.filter(function (key) { return rKeys.indexOf(key) < 0; });
      const swaps = EXPECTED.tieSwaps.filter(function (swap) { return swap[0] === direction; });
      same([onlyR, onlyHere], [swaps.map(function (swap) { return swap[1]; }), swaps.map(function (swap) { return swap[2]; })],
        direction + " interactions = rnaxray_compare's, up to exactly tied neighbours");
    });
    log("merged interactions equal rnaxray_compare's (one exactly tied neighbour)");
  }

  // the result fed the arc map (panel C): it had structures but no table
  assert.equal(deseq.arcMapFed, true);
  assert.equal(state.arcMap.interactions.rows.length, s.interactionsUp + s.interactionsDown);
  const arcModel = arc.build(state.arcMap);
  assert.equal(arcModel.ready, true);
  assert.ok(arcModel.features.length >= 10, "gene track from NC_035889");
  const arcSvg = arc.svg(state.arcMap, arcModel);
  assert.match(arcSvg, /^<svg/);

  // region structures (panels D, E)
  const regions = rp.select(state.arcMap, rp.defaultState());
  [["regionA", regions.regions[0]], ["regionB", regions.regions[1]]].forEach(function (entry) {
    const e = EXPECTED[entry[0]];
    const region = entry[1];
    assert.ok(region && region.chosen, entry[0] + " found");
    same([region.chosen.rank, region.chosen.a, region.chosen.b, region.chosen.own.length, region.chosen.other.length], [e.rank, e.a, e.b, e.own, e.other],
      entry[0] + " = select_regions_cplfold.py");
    same(region.windows, e.windows, entry[0] + " windows");
    assert.equal(region.panels.length, 2, entry[0] + " is drawn in both folds");
  });
  assert.match(rp.svg(regions), /^<svg/);
  log("regions A " + regions.regions[0].chosen.a + "-" + regions.regions[0].chosen.b + ", B " + regions.regions[1].chosen.a + "-" + regions.regions[1].chosen.b);

  // folding energies (panels F, G)
  const plan2 = fe.buildJobs(state.arcMap, rp.defaultState(), fe.defaultState());
  assert.equal(plan2.considered, EXPECTED.energy.enriched_in_one.n + EXPECTED.energy.enriched_in_two.n);
  assert.equal(plan2.jobs.length, plan2.considered, "every interaction is folded (none off an end)");
  const entry = web("vendor/viennarna/vienna-rna.js");
  let energyRows = null;
  if (!fs.existsSync(entry)) {
    log("ViennaRNA WebAssembly not built; folding energies skipped");
  } else {
    const create = require(entry);
    const vienna = await create({ locateFile: function (file) { return path.join(path.dirname(entry), file); }, print: function () {}, printErr: function () {} });
    const dG = [];
    plan2.jobs.forEach(function (job) { dG.push(fe.cofold(vienna, job.one[0], job.one[1]), fe.cofold(vienna, job.two[0], job.two[1])); });
    const rows = fe.attach(plan2.jobs, dG);
    energyRows = rows;
    fe.summarise(rows).forEach(function (st) {
      const e = EXPECTED.energyWeb[st.side];
      assert.equal(st.n, e.n, st.side + " n");
      assert.equal(signif(st.t, 6), signif(e.t, 6), st.side + " t");
      assert.equal(signif(st.p, 4), signif(e.p, 4), st.side + " p");
      log(st.side + ": n " + st.n + ", paired t " + st.t.toFixed(3) + ", p " + st.p.toPrecision(4));
    });
    const cli = readReference("AFR_vs_ILM_sub.tsv");
    if (cli) {
      const expected = new Map();
      cli.trim().split("\n").slice(1).forEach(function (line) {
        const p = line.split("\t");
        expected.set(p[1] + ":" + p[2] + ":" + p[3], [Number(p[6]), Number(p[7])]);
      });
      assert.equal(expected.size, rows.length);
      let shared = 0;
      rows.forEach(function (row) {
        const e = expected.get(row.side + ":" + row.x + ":" + row.y);
        if (e) {
          shared += 1;
          same(e, [row.dG_one, row.dG_two], "dG of " + row.side + " " + row.x + "," + row.y + " = RNAcofold CLI");
        }
      });
      assert.equal(rows.length - shared, EXPECTED.tieSwaps.length);
      // the CLI's own table through our t-test = R's t.test
      const cliRows = [];
      expected.forEach(function (value, key) { cliRows.push({ side: key.split(":")[0], dG_one: value[0], dG_two: value[1] }); });
      fe.summarise(cliRows).forEach(function (st) {
        const e = EXPECTED.energy[st.side];
        same([st.n, signif(st.t, 6), signif(st.p, 4)], [e.n, signif(e.t, 6), signif(e.p, 4)], st.side + " t-test on the CLI table = R");
      });
      log("dG equal folding_energy.py (RNAcofold CLI) for all " + shared + " shared interactions; R's t-test reproduced on its table");
    }
    assert.match(fe.svg({ rows: rows, length: 40 }, { one: "ZAFR", two: "ZASI" }), /^<svg/);
  }

  // the result record of this session (results.js, behind the Report page
  // and its exports) carries the same numbers and statuses
  const R = win.RNAxRayResults;
  const primarySummary = parsed[0].summary;
  const session = {
    summary: primarySummary, filters: {}, view: { report: { filteredTotal: primarySummary.validRecords, filteredSample: [], partnerCounts: [] } },
    comparison: Object.assign({}, comparison, { result: result }), arcMap: state.arcMap, regionPanels: rp.defaultState(),
    foldingEnergy: energyRows ? Object.assign(fe.defaultState(), { results: { rows: energyRows, length: 40 } }) : fe.defaultState()
  };
  const record = R.build(session, {});
  const value = function (id) { return record.results.find(function (r) { return r.id === id; }).value; };
  const stepStatus = function (key) { return record.steps.find(function (st) { return st.key === key; }).status; };
  same({ significant: value("R23"), significantUp: value("R24"), significantDown: value("R25"), interactionsUp: value("R26"), interactionsDown: value("R27") },
    { significant: EXPECTED.deseq.significant, significantUp: EXPECTED.deseq.significantUp, significantDown: EXPECTED.deseq.significantDown,
      interactionsUp: EXPECTED.deseq.interactionsUp, interactionsDown: EXPECTED.deseq.interactionsDown }, "result record = differential test");
  assert.equal(value("R01"), EXPECTED.records.ZAFR_REP1);
  assert.equal(value("R20"), result.cells.length);
  assert.equal(value("R21"), result.conservedCells.length);
  ["parse", "comparison", "differential_test", "arc_map", "region_structures"].forEach(function (key) { assert.equal(stepStatus(key), "ok", key); });
  ["contact_map", "viewpoint", "structure", "literature_search"].forEach(function (key) { assert.equal(stepStatus(key), "not_run", key); });
  assert.equal(value("R31"), regions.regions[0].chosen.a + "\u2194" + regions.regions[0].chosen.b);
  assert.equal(value("R32"), regions.regions[1].chosen.a + "\u2194" + regions.regions[1].chosen.b);
  if (energyRows) {
    assert.equal(stepStatus("folding_energy"), "ok");
    const stats = fe.summarise(energyRows);
    assert.equal(value("R34"), stats[0].p);
    assert.equal(value("R36"), stats[1].p);
    assert.equal(value("R33"), EXPECTED.energyWeb.enriched_in_one.n);
  } else {
    assert.equal(stepStatus("folding_energy"), "not_run");
    assert.equal(value("R34"), null, "no energies: p is null, not 0");
  }
  const aiFiles = R.files(record, "ai");
  const schema = JSON.parse(aiFiles.find(function (f) { return f.path === "schema/summary.schema.json"; }).text);
  const problems = require("./json-schema-lite.cjs").validate(schema, JSON.parse(aiFiles.find(function (f) { return f.path === "summary.json"; }).text));
  assert.deepEqual(problems, [], "the example's summary.json is valid against its schema: " + problems.slice(0, 3).join("; "));
  aiFiles.concat(R.files(record, "analysis")).filter(function (f) { return /\.json$/.test(f.path) && !/^schema\//.test(f.path); }).forEach(function (f) {
    const doc = JSON.parse(f.text);
    const own = aiFiles.find(function (g) { return g.path === doc.$schema; });
    assert.ok(own, f.path + " names a schema in the package");
    const issues = require("./json-schema-lite.cjs").validate(JSON.parse(own.text), doc);
    assert.deepEqual(issues, [], "the example's " + f.path + ": " + issues.slice(0, 3).join("; "));
  });
  const foldA = JSON.parse(aiFiles.find(function (f) { return f.path === "results/structure_A.json"; }).text);
  assert.equal(foldA.pairs.length, record.results.find(function (r) { return r.id === "R28"; }).value, "structure A's base pairs = R28");
  const md = aiFiles.find(function (f) { return f.path === "report.md"; }).text;
  assert.ok(md.indexOf("| R23 | S08 | Significant cells | " + EXPECTED.deseq.significant.toLocaleString("en-US") + " | cells | `ok` |") >= 0, "report.md has R23");
  const table = record.tables.find(function (t) { return t.file === "tables/differential_interactions.tsv"; });
  assert.equal(table.rowCount, EXPECTED.deseq.interactionsUp + EXPECTED.deseq.interactionsDown);
  assert.ok(aiFiles.some(function (f) { return f.path === "tables/regions.tsv"; }), "the AI package has the chosen regions");
  const analysisFiles = R.files(record, "analysis");
  ["figures/A_differential_map.svg", "figures/C_arc_map.svg", "figures/DE_region_structures.svg", "results/structure_A.dbn", "tables/compare_cells.tsv", "tables/differential_significant_cells.tsv"].forEach(function (file) {
    assert.ok(analysisFiles.some(function (f) { return f.path === file; }), file + " in the analysis package");
  });
  log("result record: R23 " + value("R23") + ", R31 " + value("R31") + ", R32 " + value("R32") + "; " + aiFiles.length + " AI files, " + analysisFiles.length + " analysis files");
}

main().then(function () {
  process.stdout.write("verify-example: ok\n");
}).catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exit(1);
});

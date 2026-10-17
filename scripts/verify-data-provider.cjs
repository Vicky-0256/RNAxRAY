"use strict";

// DataProvider contract (RAWDATA_APP_PLAN.md R4): BrowserProvider shapes,
// equivalence with the legacy record-based analysis, the page-data layer, and
// the rule that analysis pages never read rows or files directly.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const repository = path.resolve(__dirname, "..");
const web = function (file) { return path.join(repository, "web", file); };

// the first 10,000 records of the included example's primary file
function exampleText() {
  const lines = zlib.gunzipSync(fs.readFileSync(web("assets/examples/zikv-virion/ZAFR_REP1_1in10.hyb.gz"))).toString("utf8").split("\n");
  return lines.slice(0, 10000).join("\n") + "\n";
}

async function parseExample() {
  const parserContext = vm.createContext({
    Number, String, Boolean, Object, Array, Math, RegExp, Intl, TextDecoder,
    self: { postMessage: function () {} }
  });
  vm.runInContext(fs.readFileSync(web("parser.worker.js"), "utf8"), parserContext, { filename: "parser.worker.js" });
  const text = exampleText();
  return new Promise(function (resolve, reject) {
    parserContext.self.postMessage = function (message) {
      if (message.type === "complete") resolve(message);
      if (message.type === "error") reject(new Error(message.message));
    };
    parserContext.self.onmessage({ data: { file: new File([text], "ZAFR_REP1_1in10.hyb", { type: "text/plain" }) } });
  });
}

function loadAnalysisContext() {
  const context = vm.createContext({
    Intl, Number, String, Boolean, Object, Array, Math, RegExp, Set, Map, JSON, Promise, Float64Array, Date, Error,
    console,
    window: {}
  });
  context.globalThis = context;
  ["analysis-data.js", "data-provider.js", "page-data.js"].forEach(function (file) {
    vm.runInContext(fs.readFileSync(web(file), "utf8"), context, { filename: file });
  });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const parsed = await parseExample();
  const context = loadAnalysisContext();
  const data = context.window.RNAxRayData;
  const api = context.window.RNAxRayProvider;
  const pageDataApi = context.window.RNAxRayPageData;
  assert.ok(data && api && pageDataApi, "analysis-data.js, data-provider.js and page-data.js must load in one context");

  const records = parsed.records.map(function (record, index) { record.index = index; return record; });
  const summary = parsed.summary;
  const fastaText = fs.readFileSync(web("assets/examples/zikv-virion/ZAFR.fasta"), "utf8");
  const sequences = data.parseFasta(fastaText);
  const fasta = { fileName: "ZAFR.fasta", fileSize: fastaText.length, sha256: "fasta-sha", sequences: sequences, mapping: data.buildFastaMapping(summary.rnaNames, sequences) };

  // ---- Interface ----
  const provider = new api.BrowserProvider({ data: data });
  assert.deepEqual(plain(api.METHODS), ["listDatasets", "getSummary", "getContactBins", "queryHybrids", "getTopInteractions", "getSequence", "getArms"]);
  assert.ok(api.implementsProvider(provider), "BrowserProvider must implement every DataProvider method");
  api.METHODS.forEach(function (method) {
    assert.equal(provider[method].constructor.name, "AsyncFunction", method + " must be async");
  });
  assert.deepEqual(plain(api.normaliseSelection("a")), { datasetIds: ["a"] });
  assert.deepEqual(plain(api.normaliseSelection(["a", "b"])), { datasetIds: ["a", "b"] });
  assert.deepEqual(plain(api.normaliseSelection({ datasetId: "a" })), { datasetIds: ["a"] });

  const changes = [];
  provider.subscribe(function (detail) { changes.push(detail); });
  provider.addDataset({ id: "primary", primary: true, condition: "A", label: "Primary", summary: summary, records: records });
  provider.setReference(fasta);
  assert.equal(changes.length, 2, "registration must notify subscribers");
  const primary = { datasetIds: ["primary"] };

  // ---- listDatasets ----
  const datasets = await provider.listDatasets();
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].id, "primary");
  assert.equal(datasets[0].primary, true);
  assert.equal(datasets[0].validRecords, summary.validRecords);
  assert.equal(datasets[0].reference.sequenceCount, 1);
  const zikv = summary.rnaNames[0];
  assert.equal(datasets[0].reference.mapped[zikv].length, sequences[0].sequence.length);

  // ---- getSummary ----
  const single = await provider.getSummary(primary);
  assert.equal(single, summary, "single-dataset summaries keep the parser summary identity");
  assert.equal(Object.keys(single).indexOf("rnaExtents"), -1, "rnaExtents must not change JSON exports of the parser summary");
  assert.deepEqual(plain(single.rnaExtents[zikv]), plain(data.getRnaExtent(records, zikv)));

  // ---- getContactBins equals the legacy contact matrix ----
  const contact = data.defaultContactState(summary);
  const bins = await provider.getContactBins(primary, contact);
  ["x", "y", "count", "records", "support"].forEach(function (key) {
    assert.ok(Array.isArray(bins[key]), "contact bins need a " + key + " array");
    assert.equal(bins[key].length, bins.x.length);
  });
  assert.equal(bins.binSize, 10);
  assert.equal(bins.length, sequences[0].sequence.length, "length is the mapped reference length");
  assert.equal(bins.total, bins.count.reduce(function (sum, value) { return sum + value; }, 0));
  const legacyMatrix = data.buildContactMatrix(records, contact);
  const providerMatrix = data.contactMatrixFromBins(bins, contact);
  assert.deepEqual(plain(providerMatrix.cells), plain(legacyMatrix.cells), "provider contact cells must equal the legacy matrix");
  assert.equal(providerMatrix.cap, legacyMatrix.cap);
  assert.equal(providerMatrix.recordsUsed, legacyMatrix.recordsUsed);
  const capped = await provider.getContactBins(primary, Object.assign({}, contact, { maxCells: Math.max(1, Math.floor(bins.x.length / 3)) }));
  assert.ok(capped.binSize > 10 && capped.binSizeAdjusted, "maxCells must double the bin size until the map fits");
  assert.ok(capped.x.length <= Math.floor(bins.x.length / 3));
  const windowed = await provider.getContactBins(primary, Object.assign({}, contact, { region: { x: [1, 2000], y: [1, 2000] } }));
  assert.ok(windowed.x.every(function (x, index) { return x <= 2000 && windowed.y[index] <= 2000; }));

  // ---- queryHybrids ----
  const filters = Object.assign(data.defaultInteractionFilters(), { rna: zikv, minSupport: "1" });
  const legacyFiltered = data.getFilteredRecords({ records: records, filters: filters });
  const page = await provider.queryHybrids(primary, { filters: filters, offset: 5, limit: 7 });
  assert.equal(page.total, legacyFiltered.length);
  assert.equal(page.rows.length, 7);
  assert.equal(page.rows[0], legacyFiltered[5], "rows are paged in file order");
  const all = await provider.queryHybrids(primary, { filters: filters, limit: null });
  assert.equal(all.rows.length, legacyFiltered.length);
  const byIndex = await provider.queryHybrids(primary, { indices: [42] });
  assert.equal(byIndex.rows[0].index, 42);
  const top = await provider.queryHybrids(primary, { order: "reads", limit: 3 });
  assert.ok(top.rows[0].supportCount >= top.rows[2].supportCount, "order=reads sorts by support");
  const region = { rna: zikv, start: 100, end: 400, partner: "", partnerStart: "", partnerEnd: "", overlap: "any" };
  const regionRows = await provider.queryHybrids(primary, { region: region, limit: null });
  assert.deepEqual(
    plain(data.regionResultsFromRecords(regionRows.rows, region).partners),
    plain(data.getRegionResults({ records: records, region: region }).partners)
  );
  const cell = { rnaX: contact.rnaX, rnaY: contact.rnaY, binSize: 10, orientation: "normalised", chimeraType: "all", homodimer: "all", x: providerMatrix.cells[0].x, y: providerMatrix.cells[0].y };
  const cellRows = await provider.queryHybrids(primary, { cell: cell, limit: null });
  assert.equal(cellRows.total, providerMatrix.cells[0].records, "a contact cell's records equal its queryHybrids rows");

  // ---- getTopInteractions ----
  const partners = await provider.getTopInteractions(primary, { by: "partner", rna: zikv, filters: filters, countMode: "support" });
  assert.deepEqual(plain(partners.rows), plain(data.getPartnerCounts(legacyFiltered, zikv, "support")));
  const topBins = await provider.getTopInteractions(primary, Object.assign({ by: "bin", limit: 5 }, contact));
  assert.equal(topBins.rows.length, 5);
  assert.equal(topBins.rows[0].xEnd, topBins.rows[0].x + 9);
  assert.ok(topBins.rows[0].count >= topBins.rows[4].count);

  // ---- getSequence ----
  const slice = await provider.getSequence(primary, { rna: zikv, start: 11, end: 20 });
  assert.equal(slice.sequence, data.extractReference(fasta, zikv, 11, 20).sequence);
  assert.equal(slice.length, sequences[0].sequence.length);
  assert.equal(await provider.getSequence(primary, { rna: "not-mapped" }), null);

  // ---- getArms (viewpoint) equals the legacy viewpoint ----
  const viewpoint = Object.assign(data.defaultViewpointState(summary, records), { binSize: "10" });
  const legacyViewpoint = data.getViewpointResults({ records: records, summary: summary, fasta: fasta, viewpoint: viewpoint });
  const range = data.viewpointRange(viewpoint, { extent: single.rnaExtents[zikv], referenceLength: null });
  const arms = await provider.getArms(primary, { rna: zikv, start: range.start, end: range.end });
  ["index", "id", "rnaOne", "oneStart", "oneEnd", "rnaTwo", "twoStart", "twoEnd", "support", "homodimer", "chimeraType"].forEach(function (key) {
    assert.equal(arms[key].length, arms.total, "arms." + key + " must be a column of length total");
  });
  const providerViewpoint = data.viewpointResultsFromRecords(viewpoint, api.armsToRecords(arms), { extent: single.rnaExtents[zikv], referenceLength: null });
  assert.deepEqual(plain(providerViewpoint.bins), plain(legacyViewpoint.bins));
  assert.equal(providerViewpoint.records.length, legacyViewpoint.records.length);

  // ---- merged selections sum counts ----
  provider.addDataset({ id: "copy", condition: "B", summary: Object.assign({}, summary), records: records.map(function (record) { return Object.assign({}, record); }) });
  const merged = { datasetIds: ["primary", "copy"] };
  const mergedSummary = await provider.getSummary(merged);
  assert.equal(mergedSummary.validRecords, summary.validRecords * 2);
  assert.equal(mergedSummary.rnaCounts[0].support, summary.rnaCounts[0].support * 2);
  const mergedBins = await provider.getContactBins(merged, contact);
  assert.equal(mergedBins.total, bins.total * 2);
  const mergedRows = await provider.queryHybrids(merged, { offset: records.length, limit: 1 });
  assert.equal(mergedRows.rows[0].datasetId, "copy");
  assert.equal(mergedRows.rows[0].index, records.length);
  provider.removeDataset("copy");

  // ---- page-data layer fills every page through the provider ----
  const state = { selection: null, summary: null, density: "comfortable", interactionScrollTop: 0, selectedRecordIndex: 3 };
  let updates = 0;
  const controller = pageDataApi.createController({ state: state, initialiseOnSelection: true, onUpdate: function () { updates += 1; } });
  controller.setProvider(provider);
  await controller.setSelection(primary);
  assert.equal(state.summary, summary);
  assert.equal(state.reference.mapping[zikv], sequences[0].id);
  assert.ok(state.filters && state.contact && state.region && state.viewpoint && state.comparison && state.structure, "embedded selections initialise page state");
  state.selectedRecordIndex = 3;
  for (const pageId of pageDataApi.PAGE_IDS) {
    let pending = controller.ensure(pageId);
    for (let round = 0; pending && round < 5; round += 1) {
      await pending;
      pending = controller.ensure(pageId);
    }
    assert.equal(pending, null, pageId + " data must settle");
  }
  assert.equal(state.view.interactions.total, records.length);
  assert.equal(state.view.selectedRecord.record.index, 3);
  assert.deepEqual(plain(state.contact.matrix.cells), plain(data.buildContactMatrix(records, state.contact).cells));
  assert.deepEqual(plain(state.viewpoint.results.bins), plain(data.getViewpointResults({ records: records, summary: summary, fasta: fasta, viewpoint: state.viewpoint }).bins));
  assert.equal(state.region.results.records.length, data.getRegionResults({ records: records, region: state.region }).records.length);
  assert.ok(state.view.regionReference && state.view.regionReference.sequence.length > 0);
  assert.equal(state.comparison.datasets.length, 1);
  assert.equal(state.comparison.result.ready, false, "one dataset cannot form a comparison");
  assert.equal(state.view.report.filteredTotal, records.length);
  assert.ok(state.view.structureEvidence && state.view.structureEvidence.fasta.sequences.length === 1);
  state.contact.binSize = 25;
  state.contact.matrix = null;
  await controller.ensure("contact-map");
  assert.equal(state.contact.matrix.binSize, 25, "invalidated slots are refetched with the new query");
  const windowLoaded = await controller.loadInteractionWindow(2000);
  assert.equal(windowLoaded, true);
  assert.ok(state.view.interactions.offset <= 2000 && state.view.interactions.offset + state.view.interactions.rows.length > 2000);
  state.comparison.binSize = "50";
  provider.addDataset({ id: "second", condition: "B", label: "Second", summary: Object.assign({}, summary), records: records.slice(0, 500) });
  await Promise.resolve();
  await controller.ensure("compare");
  let comparePending = controller.ensure("compare");
  while (comparePending) { await comparePending; comparePending = controller.ensure("compare"); }
  assert.equal(state.comparison.datasets.length, 2, "Compare lists datasets from listDatasets()");
  assert.equal(state.comparison.result.ready, true, String(state.comparison.result.reason) + JSON.stringify(state.comparison.datasets.map(function (d) { return [d.id, d.condition]; })));
  assert.ok(updates >= 1, "provider changes notify the page layer");
  controller.destroy();

  // ---- pages read data only through the provider ----
  ["analysis-pages.js", "analysis-ui.js", "overview-page.js", "report-page.js", "structure-ui.js", "structure-controller.js"].forEach(function (file) {
    const source = fs.readFileSync(web(file), "utf8");
    assert.doesNotMatch(source, /state\.records|\.records\s*\|\|\s*\[\]\)\.slice/, file + " must not read parsed rows directly");
    assert.doesNotMatch(source, /FileReader|\.arrayBuffer\(\)|file\.text\(\)/, file + " must not read files");
    assert.doesNotMatch(source, /RNAxRayData\.(buildContactMatrix|getFilteredRecords|getRegionResults|getViewpointResults|getCellRecords)\(/, file + " must not compute from in-memory rows");
  });

  process.stdout.write("data-provider-contract: ok\n");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});

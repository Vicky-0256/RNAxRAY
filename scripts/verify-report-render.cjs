"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repository = path.resolve(__dirname, "..");
const context = vm.createContext({
  Intl,
  Number,
  String,
  Boolean,
  Object,
  Array,
  Math,
  Date,
  RegExp,
  Set,
  Map,
  JSON,
  window: {}
});

context.window.RNAXRAY_BUILD = { commit: "report-test-commit" };
context.window.RNAxRayData = {
  getFilteredRecords: function (state) { return state.records.filter(function (record) { return !state.filters || !state.filters.rna || record.rnaOne === state.filters.rna || record.rnaTwo === state.filters.rna; }); },
  getPartnerCounts: function () { return [{ name: "RNA_B", records: 2, support: 5 }]; },
  buildContactMatrix: function () {
    return {
      ready: true,
      cells: [{ x: 10, y: 20, value: 3, records: 2, support: 5 }],
      cellMap: { "10:20": { x: 10, y: 20, value: 3, records: 2, support: 5 } },
      binSize: 10,
      xMin: 10,
      xMax: 19,
      yMin: 20,
      yMax: 29,
      recordsUsed: 2,
      totalSupport: 5,
      cellContributions: 2,
      maximumCells: 100000,
      maximumBinContributions: 2000000,
      max: 3,
      cap: 3
    };
  },
  getViewpointResults: function () {
    return {
      ready: true,
      rna: "RNA_A",
      start: 10,
      end: 30,
      binSize: 1,
      records: [{ id: "read_1" }],
      armContributions: 2,
      max: 2,
      totalCoverage: 20,
      bins: [{ start: 10, end: 10, value: 2 }, { start: 11, end: 11, value: 1 }]
    };
  },
  getRegionResults: function () {
    return {
      records: [{ id: "read_1", rnaOne: "RNA_A", rnaOneStart: 10, rnaOneEnd: 12, rnaTwo: "RNA_B", rnaTwoStart: 20, rnaTwoEnd: 22, supportCount: 3 }],
      support: 3,
      partners: [{ name: "RNA_B", records: 1, support: 3 }],
      profile: [{ start: 10, end: 12, value: 3 }],
      profileBinSize: 3
    };
  },
  buildComparisonResults: function () {
    const cell = { x: 10, y: 20, conditionA: 3, conditionB: 1, effect: 1.5, presentDatasets: 2, rawA: 3, rawB: 1, similarity: 1, datasets: [] };
    return {
      ready: true,
      groupA: [{ id: "primary" }],
      groupB: [{ id: "secondary" }],
      cells: [cell],
      cellMap: { "10:20": cell },
      conservedCells: [cell],
      binSize: 10,
      effectCap: 2,
      similarityCap: 1
    };
  },
  findFastaEntry: function () { return null; },
  extractReference: function () { return null; }
};
context.window.RNAxRayUI = {
  contactParameters: function (state) { return { parameters: { rnaX: state.contact.rnaX, rnaY: state.contact.rnaY, binSize: 10 } }; },
  viewpointParameters: function () { return { parameters: { rna: "RNA_A" }, result: { matchingRecords: 1 } }; },
  regionParameters: function () { return { parameters: { rna: "RNA_A", overlapRule: "any" }, result: { matchingRecords: 1 } }; },
  comparisonParameters: function () { return { parameters: { rnaX: "RNA_A", rnaY: "RNA_B" }, result: { ready: true } }; }
};
context.window.RNAxRayStructureUI = {
  structureReport: function (state, result) {
    return {
      source: { label: result.label, type: result.source },
      prediction: { topology: result.topology, structureType: result.structureType },
      sourceHyb: { fileName: state.summary.fileName }
    };
  }
};

vm.runInContext(fs.readFileSync(path.join(repository, "web", "results.js"), "utf8"), context, { filename: "results.js" });
vm.runInContext(fs.readFileSync(path.join(repository, "web", "report-page.js"), "utf8"), context, { filename: "report-page.js" });

const state = {
  summary: {
    fileName: "<bad>.hyb",
    fileSize: 1234,
    validRecords: 2,
    invalidRecords: 1,
    skippedBlankLines: 1,
    skippedCommentLines: 1,
    withDg: 2,
    overlapScoreRecords: 2,
    rawReadCountRecords: 1,
    homodimerRecords: 0,
    supportInteractions: 5,
    uniqueRNAs: 2,
    uniquePairs: 1,
    rnaNames: ["RNA_A", "RNA_B"],
    errors: [{ line: 4, error: "bad row", content: "<invalid>" }]
  },
  records: [
    { id: "read_1", rnaOne: "RNA_A", rnaOneStart: 10, rnaOneEnd: 12, rnaTwo: "RNA_B", rnaTwoStart: 20, rnaTwoEnd: 22, supportCount: 3, rawReadCount: 2, chimeraType: "Type_1", dg: -3.2 },
    { id: "read_2", rnaOne: "RNA_A", rnaOneStart: 11, rnaOneEnd: 13, rnaTwo: "RNA_B", rnaTwoStart: 21, rnaTwoEnd: 23, supportCount: 2, rawReadCount: null, chimeraType: "Type_1", dg: null }
  ],
  filters: { rna: "RNA_A", partner: "RNA_B", type: "all", chimeraType: "all", minSupport: "1", countMode: "support" },
  fasta: { fileName: "reference.fasta", fileSize: 99, sha256: "fasta-sha", sequences: [{ id: "RNA_A", sequence: "ACGU" }], mapping: { RNA_A: "RNA_A" } },
  contact: { rnaX: "RNA_A", rnaY: "RNA_B", binSize: 10, measure: "records", scale: "linear", orientation: "normalised", chimeraType: "all", homodimer: "all", selection: { x: 10, y: 20 }, matrix: null },
  viewpoint: { rna: "RNA_A", rangeMode: "coordinates", start: 10, end: 30, binSize: "1", measure: "records", results: null },
  region: { rna: "RNA_A", start: 10, end: 30, overlap: "any", results: null },
  comparison: {
    rnaX: "RNA_A", rnaY: "RNA_B", binSize: "10", measure: "records", normalise: "library", conditionALabel: "Control", conditionBLabel: "Treatment", result: null,
    datasets: [
      { id: "primary", fileName: "primary.hyb", label: "Primary", condition: "A", summary: { validRecords: 2, supportInteractions: 5 }, records: [] },
      { id: "secondary", fileName: "secondary.hyb", label: "Secondary", condition: "B", summary: { validRecords: 2, supportInteractions: 4 }, records: [] }
    ]
  },
  structure: {
    engine: "cplfold",
    source: "reference",
    rna: "RNA_A",
    start: 1,
    end: 4,
    cplfoldAllowPseudoknot: true,
    constraintMode: "none",
    result: {
      engine: "CPLfold",
      source: "reference",
      sequence: "ACGU",
      dotBracket: "(())",
      pairs: [{ left: 1, right: 4, leftBase: "A", rightBase: "U", type: "A-U" }],
      energy: -2.1,
      energyUnit: "kcal/mol",
      topology: "nested",
      crossingPairs: 0,
      selectedCandidate: 0,
      candidates: [{ type: "nested", topology: "nested", energy: -2.1, pairs: [{ left: 1, right: 4 }], crossingPairs: 0, dotBracket: "(())" }]
    }
  }
};

// The report reads analysis data that web/page-data.js fetched through the
// DataProvider: page result slots, state.reference (DatasetInfo.reference)
// and state.view.report (top filtered rows, total, partner counts).
state.contact.matrix = context.window.RNAxRayData.buildContactMatrix();
state.viewpoint.results = context.window.RNAxRayData.getViewpointResults();
state.region.results = context.window.RNAxRayData.getRegionResults();
state.comparison.result = context.window.RNAxRayData.buildComparisonResults();
state.reference = { fileName: "reference.fasta", fileSize: 99, sha256: "fasta-sha", sequenceCount: 1, mapping: { RNA_A: "RNA_A" }, mapped: { RNA_A: { referenceId: "RNA_A", length: 4 } } };
state.view = {
  report: {
    filteredTotal: 2,
    filteredSample: context.window.RNAxRayData.getFilteredRecords(state),
    partnerCounts: context.window.RNAxRayData.getPartnerCounts()
  }
};

const report = context.window.RNAxRayReport;
const html = report.render(state);
assert.match(html, /data-report-page/);
assert.match(html, /assets\/rnaxray-logo\.png/);
assert.match(html, /Print \/ Save PDF/);
["Executive summary", "Validation", "HYB File Format", "Interactions", "Contact Map", "Viewpoint", "Region Explorer", "Compare", "RNA Structure"].forEach(function (heading) {
  assert.match(html, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), heading + " must be present in the report");
});
assert.match(html, /&lt;bad&gt;\.hyb/, "user-controlled file names must be escaped");
assert.doesNotMatch(html, />undefined</, "report markup must not expose undefined values");
// similarity_heatmap.R: a single-valued scale (floor = cap) maps to the
// midpoint of the white-to-forestgreen CIELAB ramp, like scales::rescale.
assert.match(html, /fill="rgb\(153, 197, 143\)"><title>[^<]*; similarity 1</,
  "the similarity heatmap must use similarity_heatmap.R's data-range colour scale");
// the similarity panel is R's white unless the grey display panel is chosen
const similaritySvg = function (markup) { return markup.slice(markup.lastIndexOf('<svg class="report-svg report-heatmap-svg"')); };
assert.match(similaritySvg(html), /<rect x="52" y="24" width="650" height="300" fill="#ffffff"/, "white similarity panel by default");
state.comparison.similarityPanel = "grey";
assert.match(similaritySvg(report.render(state)), /<rect x="52" y="24" width="650" height="300" fill="#ebebeb"/, "grey similarity panel");
delete state.comparison.similarityPanel;

// section status chips come from the result record (results.js)
assert.match(html, /data-step="S04" data-status="ok"/, "the contact map chip is the record's S04 status");
assert.match(html, /data-step="S12" data-status="ok"/);
assert.match(html, /Results at a glance/);

const data = report.getData(state);
assert.equal(data.application, "RNAxRay Web");
assert.equal(data.reportScope.kind, "consolidated-session-snapshot");
assert.equal(data.sourceHyb.fileName, "<bad>.hyb");
assert.equal(data.analyses.interactions.result.matchingRecords, 2);
assert.equal(data.analyses.contactMap.result.cells, 1);
assert.equal(data.analyses.viewpoint.result.bins.length, 2);
assert.equal(data.analyses.region.result.matchingRecords, 1);
assert.equal(data.analyses.comparison.result.comparableBins, 1);
assert.equal(data.analyses.structure.sourceHyb.fileName, "<bad>.hyb");

console.log("Report render contract passed.");

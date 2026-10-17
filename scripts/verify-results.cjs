#!/usr/bin/env node
// Checks web/results.js, the result record behind the Report page and its
// exports:
//   - a step that did not run is not_run and its results are null, never 0;
//   - the Report page's status chips and "Results at a glance" values, the
//     Markdown report, summary.json and the TSV tables agree with the record;
//   - the AI package leaves out the analysis-only tables; the manifest's
//     sizes and SHA-256 match the files; the ZIP reads back byte for byte.
// The same checks on the real ZAFR vs ZASI example run in verify-example.cjs.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const schemaCheck = require("./json-schema-lite.cjs");

const repository = path.resolve(__dirname, "..");
const web = function (file) { return path.join(repository, "web", file); };

function load(context, files) {
  files.forEach(function (file) {
    vm.runInContext(fs.readFileSync(web(file), "utf8"), context, { filename: file });
  });
}

const context = vm.createContext({
  Intl, Number, String, Boolean, Object, Array, Math, Date, RegExp, Set, Map, WeakMap, JSON, Promise, Uint8Array, Uint32Array, DataView, TextEncoder, Blob,
  crypto: globalThis.crypto, console,
  window: {}
});
context.window.window = context.window;
context.window.crypto = globalThis.crypto;
context.window.RNAXRAY_BUILD = { commit: "0123456789abcdef0123" };
context.window.RNAxRayData = {
  recordsToCsv: function (records) {
    return ["sequence_id,rna_1,rna_1_start,rna_1_end,rna_2,rna_2_start,rna_2_end,support_count,dG"].concat(records.map(function (r) {
      return [r.id, r.rnaOne, r.rnaOneStart, r.rnaOneEnd, r.rnaTwo, r.rnaTwoStart, r.rnaTwoEnd, r.supportCount, r.dg === null ? "" : r.dg].map(function (v) {
        const text = String(v);
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      }).join(",");
    })).join("\n");
  }
};
// results.js reads window.*; report-page.js needs the helpers below
load(context, ["results.js"]);
context.window.RNAxRayUI = {};
// the Structure page's own report (structure-ui.js), exported unchanged
context.window.RNAxRayStructureUI = { structureReport: function (state, result) { return { application: "RNAxRay Web", engine: result.engine, dotBracket: result.dotBracket }; } };
load(context, ["report-page.js"]);
const R = context.window.RNAxRayResults;
const report = context.window.RNAxRayReport;

// ---- an empty session: nothing beyond parsing ran
const summary = {
  fileName: "sample.hyb", fileSize: 4096, validRecords: 120, invalidRecords: 0, uniqueRNAs: 3, uniquePairs: 2, supportInteractions: 150,
  inferredChimeraTypeRecords: 0, rnaNames: ["RNA_A", "RNA_B", "RNA_C"],
  rnaCounts: [{ name: "RNA_A", records: 100, support: 120 }], pairCounts: [{ rnaOne: "RNA_A", rnaTwo: "RNA_B", records: 90, support: 110 }]
};
const empty = { summary: summary, filters: {}, view: { report: { filteredTotal: 120, filteredSample: [], partnerCounts: [] } } };
const bare = R.build(empty, { generatedAt: "2026-10-16T00:00:00.000Z" });
const status = function (record, key) { return record.steps.find(function (s) { return s.key === key; }).status; };
const result = function (record, id) { return record.results.find(function (r) { return r.id === id; }); };
assert.equal(bare.schema, "rnaxray-result/1.0");
assert.equal(bare.steps.length, R.STEPS.length);
assert.equal(bare.results.length, R.RESULTS.length, "every catalog result is listed, run or not");
assert.equal(status(bare, "parse"), "ok");
["contact_map", "viewpoint", "region", "comparison", "differential_test", "arc_map", "region_structures", "folding_energy", "structure", "literature_search"].forEach(function (key) {
  assert.equal(status(bare, key), "not_run", key + " did not run");
});
bare.results.forEach(function (r) {
  const step = bare.steps.find(function (s) { return s.id === r.step; });
  if (step.status === "not_run") {
    assert.equal(r.value, null, r.id + " of a step that did not run is null, not 0");
    assert.equal(r.status, "not_run");
  }
});
assert.equal(result(bare, "R01").value, 120);
assert.equal(result(bare, "R06").value, 0, "a counted zero stays 0");
assert.deepEqual(JSON.parse(JSON.stringify(bare.literatureSearch)), { status: "not_run", lookups: 0, includedInReport: 0, hit_count: null },
  "no literature search: status not_run and hit_count null, not 0");
// data still arriving from the DataProvider is pending, not not_run
const loadingState = { summary: summary, filters: {}, viewpoint: { rna: "RNA_A" }, region: { rna: "RNA_A" } };
const loading = R.build(loadingState, {});
["interactions", "viewpoint", "region"].forEach(function (key) { assert.equal(status(loading, key), "pending", key + " while its data loads"); });
assert.equal(result(loading, "R09").value, null);
assert.equal(result(loading, "R09").status, "pending");
const waitingHtml = report.render(Object.assign({}, loadingState, { reportExport: { audience: "ai", status: "ready", list: [] } }));
assert.match(waitingHtml, /data-export-waiting>Still being prepared: S03 /, "the export panel names the steps still being prepared");
// fixed ids: the same key has the same id in every record
assert.equal(result(bare, "R23").key, "significant_cells");
assert.equal(bare.steps.find(function (s) { return s.key === "differential_test"; }).id, "S08");
assert.ok(bare.warnings.some(function (w) { return /No reference FASTA/.test(w.text); }));

// ---- a session with analyses
const records = [
  { id: "r1", rnaOne: "RNA_A", rnaOneStart: 1, rnaOneEnd: 20, rnaTwo: "RNA_B", rnaTwoStart: 50, rnaTwoEnd: 70, supportCount: 3, dg: -10.5 },
  { id: "r2", rnaOne: "RNA_A", rnaOneStart: 5, rnaOneEnd: 25, rnaTwo: "RNA_B", rnaTwoStart: 55, rnaTwoEnd: 75, supportCount: 1, dg: null },
  { id: "r3,odd", rnaOne: "RNA_A", rnaOneStart: 9, rnaOneEnd: 30, rnaTwo: "RNA_C", rnaTwoStart: 2, rnaTwoEnd: 22, supportCount: 2, dg: -3 }
];
const full = {
  summary: summary,
  filters: { rna: "RNA_A", minSupport: "1" },
  view: { report: { filteredTotal: 3, filteredSample: records, partnerCounts: [] } },
  reference: { fileName: "ref.fa", fileSize: 99, sha256: "ab".repeat(32), sequenceCount: 2, mapping: { RNA_A: "RNA_A", RNA_B: "RNA_B" } },
  contact: { rnaX: "RNA_A", rnaY: "RNA_B", binSize: 10, matrix: { ready: true, cells: [{ x: 1, y: 51, value: 2, records: 2, support: 4 }, { x: 11, y: 61, value: 1, records: 1, support: 1 }], recordsUsed: 2, binSize: 10, cap: 2 } },
  viewpoint: { rna: "RNA_A", results: { ready: true, rna: "RNA_A", start: 1, end: 30, binSize: 10, max: 0, records: [], bins: [{ start: 1, end: 10, value: 0 }] } },
  comparison: {
    conditionALabel: "Control", conditionBLabel: "Treated", binSize: "10",
    datasets: [{ id: "primary", fileName: "sample.hyb", condition: "A", summary: { validRecords: 120 } }, { id: "d2", fileName: "other.hyb", label: "T1", condition: "B", summary: { validRecords: 80 } }],
    result: { ready: true, groupA: [{}], groupB: [{}], cells: [{ x: 1, y: 51, conditionA: 2, conditionB: 1, effect: 1, similarity: 1, presentDatasets: 2 }], conservedCells: [] },
    deseq: { status: "error", error: "Each condition needs at least two replicates.", minCount: "2", radius: "100", padjCutoff: "0.05" }
  },
  reportPurpose: "  Which RNA_A contacts change on treatment? | check  ",
  structure: { engine: "vienna", source: "reference", rna: "RNA_A", start: 11, end: 18, result: { engine: "ViennaRNA", sequence: "GGGAAACC", dotBracket: "(((..)))", energy: -1.2, pairs: [[1, 8], [2, 7], [3, 6]], crossingPairs: 0, selectedCandidate: 1, completedAt: "2026-10-16T12:34:56.000Z",
    candidates: [{ type: "mfe", topology: "nested", energy: -1.0, pairs: [[1, 8]], crossingPairs: 0, dotBracket: "(......)" }, { type: "suboptimal", topology: "nested", energy: -1.2, pairs: [{ left: 1, right: 8 }, { left: 2, right: 7 }, { left: 3, right: 6 }], crossingPairs: 0, dotBracket: "(((..)))" }] } },
  evidence: { cards: [{ status: "no_match", include_in_report: false, hit_count: 0, entries: [] }] }
};
const record = R.build(full, { generatedAt: "2026-10-16T00:00:00.000Z", interactionRows: records, interactionTotal: 3 });
assert.equal(status(record, "contact_map"), "ok");
assert.equal(status(record, "viewpoint"), "no_result", "a profile of zeros is a result with nothing in it");
assert.equal(status(record, "differential_test"), "failed");
assert.equal(record.steps.find(function (s) { return s.key === "differential_test"; }).detail, "Each condition needs at least two replicates.");
["R22", "R23", "R26"].forEach(function (id) { assert.equal(result(record, id).value, null, id + " of a failed test is null"); });
assert.equal(status(record, "structure"), "ok");
assert.equal(result(record, "R39").value, 3);
assert.equal(status(record, "literature_search"), "no_result", "a lookup with no match ran and found nothing");
assert.equal(record.literatureSearch.hit_count, null, "no card added: hit_count unknown, not 0");
assert.equal(result(record, "R41").value, 0, "the search ran: zero cards added is a count");

// results carry type and scope; purpose is the researcher's text
record.results.forEach(function (r) {
  assert.ok(["integer", "number", "string"].indexOf(r.type) >= 0, r.id + " type");
  const step = record.steps.find(function (s) { return s.id === r.step; });
  assert.equal(r.scope, step.scope, r.id + " scope = its step's scope");
  if (r.value !== null) {
    assert.equal(r.type === "string" ? typeof r.value === "string" : typeof r.value === "number" && (r.type === "number" || Number.isInteger(r.value)), true, r.id + " value matches its type");
  }
});
assert.equal(record.steps.find(function (s) { return s.key === "contact_map"; }).scope, "sample.hyb: RNA_A × RNA_B, 10-nt bins");
assert.equal(record.steps.find(function (s) { return s.key === "viewpoint"; }).scope, "sample.hyb: RNA_A 1-30");
assert.deepEqual(JSON.parse(JSON.stringify(record.scope.purpose)), { text: "Which RNA_A contacts change on treatment? | check", source: "researcher" });
assert.equal(bare.scope.purpose, null, "no purpose typed: null");

// nature, completion time and run id
record.results.forEach(function (r) { assert.ok(R.NATURE_TEXT[r.nature], r.id + " has a known nature"); });
assert.equal(result(record, "R23").nature, "statistical_test");
assert.equal(result(record, "R38").nature, "prediction");
assert.equal(result(record, "R20").nature, "descriptive");
assert.equal(record.steps.find(function (s) { return s.key === "structure"; }).completedAt, "2026-10-16T12:34:56.000Z");
assert.equal(record.steps.find(function (s) { return s.key === "contact_map"; }).completedAt, null, "computed on demand: no completion time");
assert.match(record.run.id, /^run-[0-9a-f]{16}$/);
assert.equal(R.build(full, { generatedAt: "2026-10-17T00:00:00.000Z", interactionRows: records, interactionTotal: 3 }).run.id, record.run.id, "same inputs and results: same run id, whatever the export time");
const changed = JSON.parse(JSON.stringify(full));
changed.contact.matrix.cells.pop();
assert.notEqual(R.build(changed, { interactionRows: records, interactionTotal: 3 }).run.id, record.run.id, "a different result: a different run id");

// the Report page shows the record's statuses and values
const html = report.render(full);
assert.ok(html.indexOf("<strong>Run</strong> <code>" + record.run.id + "</code>") > 0, "the header shows the run id");
// every explanatory note in parts 3 and 4 names what it rests on
const notesFrom = html.indexOf('id="report-part-figures"');
const notesTo = html.indexOf('id="report-part-limitations"');
const notes = html.slice(notesFrom, notesTo).match(/<p class="report-note"[^>]*>/g) || [];
assert.ok(notes.length >= 3, "there are notes to check");
notes.forEach(function (tag) { assert.match(tag, /data-cites="(?:[SREWT][0-9]{2} ?)+"/, "note cites its source: " + tag); });
// five parts in order, with a table of contents linking to each
const partAt = ["objects", "results", "figures", "methods", "limitations"].map(function (id) {
  assert.ok(html.indexOf('data-target="report-part-' + id + '"') > 0, "contents link to part " + id);
  return html.indexOf('id="report-part-' + id + '"');
});
partAt.reduce(function (previous, at) { assert.ok(at > previous, "parts in order"); return at; }, -1);
const sectionAt = function (id) { return html.indexOf('id="report-' + id + '"'); };
assert.ok(sectionAt("status") > partAt[0] && sectionAt("status") < partAt[1], "Analysis status in part 1");
assert.ok(sectionAt("results-index") > partAt[1] && sectionAt("results-index") < partAt[2], "Results in part 2");
assert.ok(sectionAt("contact-map") > partAt[2] && sectionAt("structure") < partAt[3], "figures in part 3");
assert.ok(sectionAt("source") > partAt[3] && sectionAt("methods") < partAt[4], "methods and sources in part 4");
assert.ok(sectionAt("review") > partAt[4] && sectionAt("limitations") > partAt[4], "limitations and warnings in part 5");
record.limitations.forEach(function (text) { assert.ok(html.indexOf(text.replace(/'/g, "&#39;")) > sectionAt("limitations"), "limitation shown: " + text.slice(0, 30)); });
record.warnings.forEach(function (w) { assert.ok(html.indexOf("<code>" + w.id + "</code>") > sectionAt("limitations"), w.id + " shown in part 5"); });
// every chart and table with data names it
[["Printable heatmap", "tables/contact_map_cells.tsv"], ["Printable coverage profile", "tables/viewpoint_bins.tsv"], ["B · Similarity heatmap", "tables/compare_cells.tsv"],
  ["Top matching records", "tables/interactions.tsv"], ["Top interacting RNAs", "tables/top_rnas.tsv"], ["Printable secondary-structure view", "results/structure_prediction.json"]].forEach(function (pair) {
  const at = html.indexOf("<h3>" + pair[0] + "</h3>");
  assert.ok(at > 0, pair[0] + " is in the report");
  const note = html.indexOf('report-data-note">Data: <code>', at);
  assert.ok(note > at && html.slice(note, note + 400).indexOf(pair[1]) > 0, pair[0] + " links " + pair[1]);
});
assert.match(html, /Cells · R10/, "numbers carry their result ids");
html.replace(/data-result-ref="(R\d\d)">([^<]*)</g, function (all, id, value) {
  assert.equal(value, R.formatValue(result(record, id)), id + " in a section = record");
  return all;
});
assert.match(html, /<textarea id="report-purpose"[^>]*>  Which RNA_A contacts change on treatment\? \| check  <\/textarea>/, "the purpose box shows what was typed");
const chips = {};
html.replace(/data-step="(S\d\d)" data-status="([a-z_]+)"/g, function (all, id, value) { chips[id] = chips[id] || new Set(); chips[id].add(value); return all; });
record.steps.forEach(function (step) {
  assert.ok(chips[step.id], step.id + " has a status chip on the Report page");
  assert.deepEqual(Array.from(chips[step.id]), [step.status], step.id + " chip = record status");
});
const shown = {};
html.replace(/data-result="(R\d\d)">([^<]*)</g, function (all, id, value) { shown[id] = value; return all; });
record.results.forEach(function (r) {
  assert.equal(shown[r.id], R.formatValue(r), r.id + " on the Report page = record");
});
assert.match(html, /Results at a glance/);
assert.match(html, /data-audience="ai"/);
assert.match(html, /Version<\/strong> <code>RNAxRay Web 0\.5\.0 · 0123456789ab/);
assert.match(html, /<strong>Scope<\/strong> Session report/);

// Markdown, summary.json and tables from the same record
const ai = R.files(record, "ai");
const analysis = R.files(record, "analysis");
const byPath = function (list, p) { return list.find(function (f) { return f.path === p; }); };
const md = byPath(ai, "report.md").text;
record.results.forEach(function (r) {
  const row = "| " + r.id + " | " + r.step + " | " + r.label.replace(/\|/g, "\\|") + " | " + R.formatValue(r) + " | ";
  assert.ok(md.indexOf(row) >= 0, r.id + " in report.md: " + row);
});
record.steps.forEach(function (s) { assert.ok(md.indexOf("| " + s.id + " | ") >= 0 && md.indexOf("`" + s.status + "`") >= 0); });
assert.match(md, /not generated by a language model|not by a language model/);
assert.ok(md.indexOf("- Purpose: Which RNA_A contacts change on treatment? | check (written by the researcher)") >= 0, "report.md has the purpose");
assert.ok(R.reportMarkdown(bare).indexOf("- Purpose: not stated by the researcher.") >= 0);
assert.ok(md.indexOf("| S04 | Contact map | `ok` | sample.hyb: RNA_A × RNA_B, 10-nt bins |") >= 0, "report.md steps have their scope");
// every RNAxRay JSON file against its schema; each names it in $schema
const schemaFor = function (list, fileText) {
  const named = JSON.parse(fileText).$schema;
  const file = list.find(function (f) { return f.path === named; });
  assert.ok(file, "the package carries " + named);
  return JSON.parse(file.text);
};
[["ai", record], ["analysis", record], ["ai", bare], ["ai", loading]].forEach(function (pair) {
  const list = R.files(pair[1], pair[0]);
  list.filter(function (f) { return /\.json$/.test(f.path) && !/^schema\//.test(f.path) && f.path !== "results/structure_prediction_method.json"; }).forEach(function (f) {
    const problems = schemaCheck.validate(schemaFor(list, f.text), JSON.parse(f.text));
    assert.deepEqual(problems, [], pair[0] + " " + f.path + ": " + problems.slice(0, 3).join("; "));
  });
});
assert.ok(R.files(record, "ai").some(function (f) { return f.path === "results/structure_prediction_method.json"; }), "the method's own record is kept, unchecked");
// fields per file, for the export preview
assert.deepEqual(Array.from(byPath(ai, "tables/top_rnas.tsv").fields), ["name", "records", "support"]);
assert.ok(byPath(ai, "summary.json").fields.indexOf("results") >= 0);
assert.ok(byPath(ai, "report.md").fields.indexOf("Results") >= 0);
// leaving files out: README and manifest stay, and both say what was left out
const trimmed = R.files(record, "ai", { exclude: { "tables/top_rnas.tsv": true, "evidence.json": true, "README.md": true } });
assert.ok(!byPath(trimmed, "tables/top_rnas.tsv") && !byPath(trimmed, "evidence.json") && byPath(trimmed, "README.md"), "left out files go; README stays");
assert.deepEqual(Array.from(trimmed.omitted).sort(), ["evidence.json", "tables/top_rnas.tsv"]);
assert.ok(!JSON.parse(byPath(trimmed, "data_dictionary.json").text).tables.some(function (t) { return t.file === "tables/top_rnas.tsv"; }), "the dictionary describes only tables that stay");
assert.match(byPath(trimmed, "README.md").text, /## Left out by the researcher\n\n- `evidence\.json`/);

// a selected-results report keeps only the chosen steps, and says so everywhere
const selected = R.build(full, { generatedAt: "2026-10-16T00:00:00.000Z", interactionRows: records, interactionTotal: 3, steps: ["contact_map"] });
assert.equal(selected.scope.kind, "selected_results");
assert.equal(selected.scope.label, "Selected results report");
assert.deepEqual(JSON.parse(JSON.stringify(selected.steps.map(function (s) { return s.id; }))), ["S01", "S04"], "parsing always stays");
assert.ok(selected.results.every(function (r) { return r.step === "S01" || r.step === "S04"; }));
assert.ok(selected.tables.every(function (t) { return t.step === "S01" || t.step === "S04"; }));
assert.equal(result(selected, "R10").id, "R10", "ids are not renumbered");
assert.equal(selected.run.id, record.run.id, "a selection is a view of the same run");
assert.ok(selected.scope.omittedSteps.indexOf("S12") >= 0);
assert.match(R.reportMarkdown(selected), /Scope: \*\*Selected results report\*\*\. Only the steps the researcher chose/);
const selectedFiles = R.files(selected, "ai");
assert.match(byPath(selectedFiles, "README.md").text, /\*\*This is a selected-results package, not the whole session\.\*\*/);
assert.ok(!byPath(selectedFiles, "results/structure_prediction.json"), "a left-out step's structure is not exported");
assert.deepEqual(schemaCheck.validate(schemaFor(selectedFiles, byPath(selectedFiles, "summary.json").text), JSON.parse(byPath(selectedFiles, "summary.json").text)), []);
const selectedHtml = report.render(Object.assign({}, full, { reportSelection: { parse: true, contact_map: true } }));
assert.match(selectedHtml, /<strong>Scope<\/strong> Selected results report/);
assert.ok(selectedHtml.indexOf('id="report-contact-map"') > 0 && selectedHtml.indexOf('id="report-viewpoint"') < 0 && selectedHtml.indexOf('id="report-structure"') < 0, "left-out sections are not shown");
assert.equal((selectedHtml.match(/data-action="report-select" data-step=/g) || []).length, 13, "every step can be ticked back in");
assert.match(selectedHtml, /data-step="viewpoint"(?! checked)[^>]*>/);
assert.match(selectedHtml, /left out<\/em>/);

// summary.json against its JSON Schema (shipped in both packages)
const schemaFile = byPath(ai, "schema/summary.schema.json");
assert.ok(schemaFile && byPath(analysis, "schema/summary.schema.json"), "the schema is in both packages");
const schema = JSON.parse(schemaFile.text);
[record, bare, loading].forEach(function (rec, index) {
  const problems = schemaCheck.validate(schema, JSON.parse(R.files(rec, "ai").find(function (f) { return f.path === "summary.json"; }).text));
  assert.deepEqual(problems, [], "summary.json " + index + " is valid: " + problems.slice(0, 3).join("; "));
});
const broken = JSON.parse(byPath(ai, "summary.json").text);
broken.results[0].status = "done";
broken.results[1].value = 0.5;
broken.results[1].type = "boolean";
broken.steps[0].extra = 1;
const brokenProblems = schemaCheck.validate(schema, broken);
assert.deepEqual(brokenProblems, ["$.steps[0]: unexpected property extra", '$.results[0].status: "done" not in enum', '$.results[1].type: "boolean" not in enum'], brokenProblems.join("; "));
assert.equal(brokenProblems.length, 3, "the schema catches a wrong status, type and an extra field");
// structures: dot-bracket and base pairs with coordinates and candidates, in both packages
const structureJson = JSON.parse(byPath(ai, "results/structure_prediction.json").text);
assert.deepEqual(structureJson.pairs, [[1, 8], [2, 7], [3, 6]]);
assert.equal(structureJson.positionOffset, 10, "a reference window starting at 11 adds 10");
assert.match(structureJson.coordinates, /add 10 for the position on RNA_A/);
assert.equal(structureJson.selectedCandidate, 2, "candidate numbers are 1-based");
assert.deepEqual(structureJson.candidates.map(function (c) { return [c.rank, c.pairs, c.energy]; }), [[1, 1, -1], [2, 3, -1.2]]);
assert.ok(byPath(ai, "results/structure_prediction.dbn") && byPath(analysis, "results/structure_prediction.json"));
const summaryJson = JSON.parse(byPath(ai, "summary.json").text);
assert.deepEqual(summaryJson.results, JSON.parse(JSON.stringify(record.results)), "summary.json results = record");
assert.deepEqual(summaryJson.steps.map(function (s) { return s.status; }), JSON.parse(JSON.stringify(record.steps.map(function (s) { return s.status; }))));
assert.equal(summaryJson.literature_search.hit_count, null);
record.tables.forEach(function (t) {
  const inAi = !!byPath(ai, t.file);
  const inAnalysis = !!byPath(analysis, t.file);
  assert.equal(inAi, t.audience.indexOf("ai") >= 0, t.file + " in the AI package only when meant for it");
  assert.equal(inAnalysis, t.audience.indexOf("analysis") >= 0, t.file + " in the analysis package only when meant for it");
  const text = (byPath(ai, t.file) || byPath(analysis, t.file)).text;
  const lines = text.trim().split("\n");
  assert.equal(lines.length - 1, t.rowCount, t.file + " rows = rowCount");
  lines.forEach(function (line) { assert.equal(line.split("\t").length, t.columns.length, t.file + " columns per row"); });
});
assert.ok(!byPath(ai, "tables/interactions.tsv") && byPath(analysis, "tables/interactions.tsv"), "all filtered records only in the analysis package");
const interactions = byPath(analysis, "tables/interactions.tsv").text.split("\n");
assert.equal(interactions[3].split("\t")[0], "r3,odd", "a quoted CSV field becomes one TSV cell");
assert.equal(interactions[2].split("\t")[8], "NA", "a missing dG is NA");
const dictionary = JSON.parse(byPath(ai, "data_dictionary.json").text);
assert.equal(dictionary.conventions.missing.tsv, "NA");
dictionary.tables.forEach(function (t) { t.columns.forEach(function (c) { assert.ok(c.description, t.file + " column " + c.name + " is described"); }); });
const provenance = JSON.parse(byPath(ai, "provenance.json").text);
assert.equal(provenance.inputs[1].sha256, "ab".repeat(32));
assert.equal(provenance.inputs[0].sha256Status, "pending", "a digest not yet computed is pending, not empty");
assert.ok(byPath(analysis, "results/structure_prediction.dbn").text.indexOf("(((..)))") > 0);
assert.ok(byPath(ai, "README.md").text.indexOf("never 0") > 0);

// app.js wires the export buttons: every action it names exists in the
// report markup, and the handlers read the clicked node (actionNode)
const appSource = fs.readFileSync(web("app.js"), "utf8");
["report-export", "report-export-close", "report-export-zip", "report-export-file", "report-export-copy", "report-export-html"].forEach(function (action) {
  assert.ok(appSource.indexOf('action === "' + action + '"') > 0, action + " is handled in app.js");
});
const handlers = appSource.slice(appSource.indexOf('if (action === "report-export")'), appSource.indexOf('if (action === "report-export-html")'));
assert.doesNotMatch(handlers, /\belement\./, "the click handler's node is actionNode");
// report-only actions draw at once: render() otherwise keeps the old page
// while any prefetched page data is still loading, and the click looks lost
const selectHandler = appSource.slice(appSource.indexOf('if (action === "report-select" || action === "report-select-all")'));
assert.match(selectHandler.slice(0, selectHandler.indexOf("return;\n    }")), /render\(REPORT_NOW\)/, "step selection redraws immediately");
assert.match(appSource, /&& !\(options && options\.immediate\)\) \{/, "render() honours options.immediate");
assert.match(fs.readFileSync(web("index.html"), "utf8"), /src="\.\/results\.js"[^]*src="\.\/report-page\.js"/, "index.html loads results.js before report-page.js");

async function main() {
  // manifest digests and the ZIP
  const withManifest = await R.withManifest(ai, record);
  const manifest = JSON.parse(withManifest.find(function (f) { return f.path === "manifest.json"; }).text);
  assert.equal(manifest.files.length, ai.length);
  manifest.files.forEach(function (entry) {
    const file = byPath(ai, entry.path);
    const bytes = Buffer.from(file.text, "utf8");
    assert.equal(entry.bytes, bytes.length, entry.path + " size");
    assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"), entry.path + " SHA-256");
  });
  const zip = Buffer.from(R.zipBytes(withManifest, "rnaxray-result"));
  // read the central directory back
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = zip.readUInt16LE(endAt + 10);
  let at = zip.readUInt32LE(endAt + 16);
  assert.equal(entries, withManifest.length);
  for (let i = 0; i < entries; i += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.slice(at + 46, at + 46 + nameLength).toString("utf8");
    const localName = zip.readUInt16LE(local + 26);
    const data = zip.slice(local + 30 + localName, local + 30 + localName + size);
    const file = withManifest.find(function (f) { return "rnaxray-result/" + f.path === name; });
    assert.ok(file, name + " is a package file");
    assert.equal(data.toString("utf8"), file.text, name + " content");
    assert.equal(crc, R.crc32(new Uint8Array(data)), name + " CRC-32");
    assert.equal(crc, zlibCrc(data), name + " CRC-32 = zlib");
    at += 46 + nameLength;
  }
  process.stdout.write("verify-results: ok (" + record.steps.length + " steps, " + record.results.length + " results, " + record.tables.length + " tables; ZIP " + zip.length + " bytes)\n");
}

function zlibCrc(buffer) {
  return require("node:zlib").crc32 ? require("node:zlib").crc32(buffer) : R.crc32(new Uint8Array(buffer));
}

main().catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exit(1);
});

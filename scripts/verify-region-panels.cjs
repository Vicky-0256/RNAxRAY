#!/usr/bin/env node
// Checks web/region-panels.js (region structures, panels D and E): partner
// runs, window cutting (as window_from_structure.py), the polygon layout,
// region selection (as select_regions_cplfold.py) with B moved by alignment,
// candidate overrides and the card / SVG.
// With RNAXRAY_PANELS_REAL=<dir> it also runs on ZAFR.dbn, ZILM.dbn and
// interactions.tsv (AFR vs ILM) in that folder and asserts the regions of
// the ZIKV summary figure.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repository = path.resolve(__dirname, "..");
const context = vm.createContext({ Number, String, Boolean, Object, Array, Math, RegExp, Set, Map, Int32Array, Uint8Array, Float64Array, Error, Infinity, window: {} });
["arc-map.js", "region-panels.js"].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(repository, "web", file), "utf8"), context, { filename: file });
});
const arc = context.window.RNAxRayArcMap;
const rp = context.window.RNAxRayRegionPanels;
const same = function (actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message || "");
};

function randomRNA(seed, n) {
  let x = seed;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += "ACGU"[(x >>> 16) % 4];
  }
  return out;
}

function dotBracket(length, pairs) {
  const chars = new Array(length).fill(".");
  pairs.forEach(function (p) { chars[p[0] - 1] = "("; chars[p[1] - 1] = ")"; });
  return chars.join("");
}

function helix(i, j, n) {
  const out = [];
  for (let k = 0; k < n; k += 1) { out.push([i + k, j - k]); }
  return out;
}

// ---- runs (window_from_structure.runs, gap 5)
same(rp.runs([10, 3, 12, 17, 23, 30, 31, 40]), [[3, 3], [10, 17], [23, 23], [30, 31], [40, 40]]);
same(rp.runs([]), []);

// ---- layout: polygon loops are regular, pairs and backbone have unit length
{
  const xy = rp.simpleLayout("((((....))))..((...))");
  const d = function (i, j) { return Math.hypot(xy.x[i] - xy.x[j], xy.y[i] - xy.y[j]); };
  [[0, 11], [1, 10], [3, 8], [14, 20], [4, 5], [12, 13]].forEach(function (p) { assert.ok(Math.abs(d(p[0], p[1]) - 1) < 1e-9, "unit distance " + p); });
  const loop = [3, 4, 5, 6, 7, 8];
  const cx = loop.reduce(function (s, i) { return s + xy.x[i]; }, 0) / 6;
  const cy = loop.reduce(function (s, i) { return s + xy.y[i]; }, 0) / 6;
  loop.forEach(function (i) { assert.ok(Math.abs(Math.hypot(xy.x[i] - cx, xy.y[i] - cy) - 1) < 1e-9, "hexagon hairpin"); });
  const open = rp.simpleLayout("..........");
  assert.equal(open.x.length, 10);
}

// ---- window summary
{
  // 1-based: X window 11-20, Y window 51-60; pairs 12-58, 13-57 (between),
  // 14-18 (in X), 52-56 (in Y), 19-35 and 55-80 (outside), 30-40 (ignored)
  const pairs = [[12, 58], [13, 57], [14, 18], [52, 56], [19, 35], [55, 80], [30, 40]];
  const pt = rp.pairTable(pairs, 100);
  const s = rp.windowSummary(pt, randomRNA(3, 100), 11, 20, 51, 60);
  assert.equal(s.pairsX, 1);
  assert.equal(s.pairsY, 1);
  assert.equal(s.between, 2);
  assert.equal(s.outsideCount, 2);
  assert.equal(s.outsidePartners, "35; 80");
  assert.equal(s.dbn.length, 20);
  assert.equal(s.layoutDbn.length, 23);
  assert.equal(s.dbn, ".(((...).." + ".(...)))..");
  // given the other way round the windows are swapped
  const r = rp.windowSummary(pt, "", 51, 60, 11, 20);
  same([r.X0, r.Y0, r.between], [11, 51, 2]);
  // pseudoknot: the crossing pair is left out of the layout (as Desktop's _nested)
  same(rp.nested([[11, 31], [21, 91], [12, 30]]), [[11, 31], [12, 30]]);
  const pk = rp.windowSummary(rp.pairTable([[11, 31], [21, 91]], 120), "", 5, 35, 80, 100);
  assert.equal(pk.dbn.replace(/\./g, ""), "()", "only the nested pair is bracketed");
  assert.equal(pk.notDrawn, 1);
  assert.equal(pk.between, 1, "the crossing pair is still counted");
  // windows that touch are merged into one, without a linker
  const m = rp.windowSummary(pt, "", 11, 30, 31, 40);
  same([m.merged, m.X0, m.X1, m.Y0, m.Y1, m.win, m.linker, m.layoutDbn.length], [true, 11, 40, null, null, 30, 0, 30]);
  assert.match(rp.summaryText({ name: "s", summary: m }), /window_X\t11-40\nwindow_Y\t-\n/);
}

// ---- a local hairpin: overlapping windows become one (Desktop windows_of)
{
  const n = 300;
  const seq = randomRNA(5, n);
  const pairs = helix(100, 135, 8);
  const a = arc.parseStructure(">a\n" + seq + "\n" + dotBracket(n, pairs) + "\n", "a.dbn");
  const b = arc.parseStructure(">b\n" + seq + "\n" + dotBracket(n, pairs) + "\n", "b.dbn");
  const state = arc.defaultState();
  state.a = a;
  state.b = b;
  state.interactions = arc.parseInteractions("x\ty\tpadj\tdirection\n101\t121\t0.001\tup\n", "i.tsv");
  const model = rp.select(state, rp.defaultState());
  const region = model.regions[0];
  same(region.windows, { X0: 85, X1: 150, Y0: null, Y1: null });
  assert.match(region.note, /overlap and are cut as one/);
  region.panels.forEach(function (panel) {
    const sm = panel.summary;
    same([sm.merged, sm.X0, sm.X1, sm.pairsX, sm.between, sm.bases.length, sm.layoutDbn.length], [true, 85, 150, 8, 0, 66, 66]);
    assert.equal(new Set(sm.bases.map(function (base) { return base.pos; })).size, 66, "no base twice");
  });
  assert.equal(rp.panelsTsv(model).trim().split("\n").length, 1 + 2 * 66);
  assert.match(rp.regionsTsv(model), /\t85\t150\t-\t-\n/);
  assert.match(rp.svg(model), /^<svg/);
  // windows near the ends are clamped on both sides
  state.interactions = arc.parseInteractions("x\ty\tpadj\tdirection\n96\t126\t0.001\tup\n", "i.tsv");
  const far = rp.select(state, Object.assign(rp.defaultState(), { flank: "400" }));
  same(far.regions[0].windows, { X0: 1, X1: 300, Y0: null, Y1: null });
}

// ---- selection on a synthetic pair of lineages
{
  const seqA = randomRNA(7, 1200);
  // B: 2 nt inserted after A position 300 (B = A + 2 after 300)
  const seqB = seqA.slice(0, 300) + "GA" + seqA.slice(300);
  const toB = function (p) { return p > 300 ? p + 2 : p; };
  // A forms 150 <-> 900 (helix of 6); B forms 500 <-> 1000 (A coordinates)
  const pairsA = helix(148, 905, 6).concat(helix(600, 650, 4));
  const pairsBonA = helix(498, 1004, 5);
  const a = arc.parseStructure(">A:1-1200\n" + seqA + "\n" + dotBracket(1200, pairsA) + "\n", "A.dbn");
  const b = arc.parseStructure(">B\n" + seqB + "\n" + dotBracket(1202, pairsBonA.map(function (p) { return [toB(p[0]), toB(p[1])]; })) + "\n", "B.dbn");
  const tsv = ["direction\tx\ty\tlog2FoldChange\tpadj\tbaseMean",
    "up\t700\t1100\t6\t1e-9\t10", // most significant up, formed by neither
    "up\t890\t140\t5\t1e-6\t10", // formed by A (x > y on purpose)
    "up\t490\t995\t4\t1e-5\t10", // formed by B only
    "down\t490\t995\t-5\t1e-7\t10", // formed by B
    "down\t140\t890\t-4\t0.02\t10" // above the cutoff
  ].join("\n");
  const state = arc.defaultState();
  state.a = a;
  state.b = b;
  state.twoOn = "a";
  state.labelOne = "L1";
  state.labelTwo = "L2";
  state.interactions = arc.parseInteractions(tsv, "i.tsv");
  const opts = rp.defaultState();
  const model = rp.select(state, opts);
  assert.equal(model.ready, true, model.reason);
  const [A, B] = model.regions;
  assert.equal(A.chosen.rank, 2);
  same([A.chosen.a, A.chosen.b], [145, 895]);
  assert.equal(A.chosen.own.length, 6);
  assert.equal(A.chosen.other.length, 0);
  same(A.windows, { X0: 148 - 15, X1: 153 + 15, Y0: 900 - 15, Y1: 905 + 15 });
  assert.equal(A.panels[0].structure, "a");
  assert.equal(A.panels[0].summary.between, 6);
  assert.equal(A.panels[1].summary.between, 0);
  same([A.panels[1].summary.X0, A.panels[1].summary.Y0], [133, 887], "B's windows through the alignment (+2 after 300)");
  assert.equal(B.chosen.rank, 1);
  assert.equal(B.chosen.own.length, 5);
  assert.equal(B.panels[0].structure, "b");
  assert.equal(B.panels[0].summary.between, 5);
  same([B.windows.X0, B.windows.X1, B.windows.Y0, B.windows.Y1], [498 - 15, 502 + 15, 1000 - 15, 1004 + 15]);
  same([B.panels[0].summary.X0, B.panels[0].summary.Y1], [485, 1021], "B's own coordinates (+2 after 300)");
  // reach: 3 nt is too short for the A helix (arms at 145 / 895, pairs 148-153)
  const near = rp.select(state, Object.assign(rp.defaultState(), { reach: "3" }));
  assert.equal(near.regions[0].chosen, null);
  assert.match(near.regions[0].reason, /No interaction/);
  // override: pick the up interaction formed only by B; windows from B's pairs
  const pick = rp.select(state, Object.assign(rp.defaultState(), { pickOne: "3" }));
  assert.equal(pick.regions[0].chosen.rank, 3);
  assert.equal(pick.regions[0].chosen.own.length, 0);
  assert.equal(pick.regions[0].panels[1].summary.between, 5);
  // a pick made in the card lapses when another file is loaded in the Arc map card
  {
    const ui = { regionPanels: rp.defaultState(), arcMap: state };
    const api = { render: function () {} };
    rp.handleChange(ui, { dataset: { feature: "regions-control", key: "pickOne" }, value: "3" }, api);
    assert.equal(rp.select(state, ui.regionPanels).regions[0].chosen.rank, 3);
    const interactions = state.interactions;
    state.interactions = arc.parseInteractions(tsv, "again.tsv");
    assert.equal(rp.select(state, ui.regionPanels).regions[0].chosen.rank, 2, "stale pick ignored");
    rp.renderCard(state, ui.regionPanels);
    same([ui.regionPanels.pickOne, ui.regionPanels.pickFor], ["auto", null]);
    state.interactions = interactions;
  }
  // flank
  const wide = rp.select(state, Object.assign(rp.defaultState(), { flank: "30" }));
  assert.equal(wide.regions[0].windows.X0, 118);
  // cells of condition two read on B's reference move by -2 after 300
  state.twoOn = "b";
  const onB = rp.select(state, opts);
  same([onB.regions[1].chosen.a, onB.regions[1].chosen.b], [493, 998]);
  state.twoOn = "a";
  // outputs
  assert.match(rp.regionsTsv(model), /^label\tlineage\trank/);
  assert.match(rp.regionsTsv(model), /\nA\tL1\t2\t145\t895\t5\.00\t1\.00e-6\t6\t0\t133\t168\t885\t920\n/);
  assert.match(rp.summaryText(A.panels[0]), /inter_window_pairs\t6/);
  const layout = rp.panelsTsv(model).trim().split("\n");
  assert.equal(layout.length, 1 + 2 * (36 + 36) + 2 * (35 + 35));
  const svg = rp.svg(model);
  assert.match(svg, /^<svg[^>]+xmlns/);
  assert.match(svg, /Region A · L1-enriched #2/);
  const html = rp.renderCard(state, opts);
  assert.match(html, /D, E · Region structures/);
  assert.match(html, /data-regions-figure/);
  assert.match(html, /<option value="2"/);
  // missing inputs
  assert.match(rp.renderCard(arc.defaultState(), opts), /Load structure A and structure B/);
  // without sequences: FASTA inputs are offered and used for the alignment
  const noSeq = arc.defaultState();
  noSeq.a = arc.parseStructure(dotBracket(1200, pairsA), "A.dbn");
  noSeq.b = arc.parseStructure(dotBracket(1202, pairsBonA.map(function (p) { return [toB(p[0]), toB(p[1])]; })), "B.dbn");
  noSeq.interactions = state.interactions;
  noSeq.twoOn = "a";
  assert.match(rp.renderCard(noSeq, rp.defaultState()), /Reference of A \(FASTA\)/);
  const withFasta = Object.assign(rp.defaultState(), { fastaA: rp.parseFasta(">a\n" + seqA.replace(/U/g, "T").toLowerCase() + "\n"), fastaB: rp.parseFasta(">b\n" + seqB + "\n>c\nAAAA\n") });
  assert.equal(withFasta.fastaA.sequence, seqA);
  assert.equal(withFasta.fastaB.sequence, seqB);
  const viaFasta = rp.select(noSeq, withFasta);
  assert.equal(viaFasta.regions[1].panels[0].summary.between, 5);
  assert.equal(viaFasta.regions[0].panels[1].summary.X0, 133);
}

// ---- real data (optional)
const real = process.env.RNAXRAY_PANELS_REAL;
if (real) {
  const read = function (name) { return fs.readFileSync(path.join(real, name), "utf8"); };
  const state = arc.defaultState();
  state.a = arc.parseStructure(read("ZAFR.dbn"), "ZAFR.dbn");
  state.b = arc.parseStructure(read("ZILM.dbn"), "ZILM.dbn");
  state.interactions = arc.parseInteractions(read("interactions.tsv"), "interactions.tsv");
  state.labelOne = "ZAFR";
  state.labelTwo = "ZASI";
  // default state: the reproduction reads all cells on ZAFR
  same([state.oneOn, state.twoOn], ["a", "a"]);
  const started = Date.now();
  const model = rp.select(state, rp.defaultState());
  process.stdout.write("real: regions in " + (Date.now() - started) + " ms\n" + rp.regionsTsv(model));
  const [A, B] = model.regions;
  same([A.chosen.rank, A.chosen.a, A.chosen.b, A.chosen.log2FoldChange.toFixed(2), A.chosen.padj.toExponential(2), A.chosen.own.length, A.chosen.other.length],
    [2, 365, 10305, "7.31", "7.31e-9", 29, 0], "region A");
  same(A.windows, { X0: 341, X1: 415, Y0: 10252, Y1: 10318 });
  same([B.chosen.rank, B.chosen.a, B.chosen.b, B.chosen.log2FoldChange.toFixed(2), B.chosen.padj.toExponential(2), B.chosen.own.length, B.chosen.other.length],
    [7, 9365, 10015, "-7.93", "2.69e-9", 13, 0], "region B");
  same(B.windows, { X0: 9323, X1: 9369, Y0: 9985, Y1: 10031 });
  // compare every panel with the reproduction's .txt summaries when present
  const expected = {
    "A:a": { file: "regionA_ZAFR.txt", between: 29, partners: "264-274; 8300-8310; 10090-10097; 10334-10344" },
    "A:b": { file: "regionA_ZASI.txt", between: 0, partners: "256-257; 527-530; 543-600; 10079-10092; 10099-10111; 10358-10384" },
    "B:b": { file: "regionB_ZASI.txt", between: 13, partners: "9183-9195; 9578-9592; 9821-9839; 10057-10074" },
    "B:a": { file: "regionB_ZAFR.txt", between: 0, partners: "9577-9616; 9853-9892; 9898-9901" }
  };
  model.regions.forEach(function (region) {
    region.panels.forEach(function (panel) {
      const e = expected[region.label + ":" + panel.structure];
      assert.equal(panel.summary.between, e.between, region.label + " " + panel.lineage + " inter-window pairs");
      assert.equal(panel.summary.outsidePartners, e.partners, region.label + " " + panel.lineage + " outside partners");
      if (fs.existsSync(path.join(real, e.file))) {
        assert.equal(rp.summaryText(panel), read(e.file), e.file);
      }
    });
  });
  // with condition-two cells read on ZILM the same regions are found
  state.twoOn = "b";
  const onB = rp.select(state, rp.defaultState());
  same([onB.regions[1].chosen.rank, onB.regions[1].windows.X0, onB.regions[1].windows.Y1], [7, 9323, 10031]);
  fs.writeFileSync(path.join(real, "regions.svg"), rp.svg(model));
}

process.stdout.write("region-panels: ok\n");

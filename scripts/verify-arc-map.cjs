#!/usr/bin/env node
// Checks web/arc-map.js: parsers, the banded alignment (as RNAxRay Desktop's
// seqmap), moving B / cells / gene track onto A's coordinates, and the SVG.
// With RNAXRAY_ARCMAP_REAL=<dir> it also runs on real files in that folder:
// ZAFR.dbn, ZILM.dbn, interactions.tsv, NC_035889.gb.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repository = path.resolve(__dirname, "..");
const context = vm.createContext({ Number, String, Boolean, Object, Array, Math, RegExp, Set, Map, Int32Array, Uint8Array, Error, Promise, window: {} });
vm.runInContext(fs.readFileSync(path.join(repository, "web", "arc-map.js"), "utf8"), context, { filename: "arc-map.js" });
const arc = context.window.RNAxRayArcMap;
// values made inside the vm context have its own prototypes: compare as JSON
const same = function (actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
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

// ---- alignment: an insertion, a deletion and a mismatch
{
  const to = randomRNA(1, 3000);
  // delete a base unlike both neighbours, so the gap has one place
  let d = 1000;
  while (to[d - 1] === to[d] || to[d] === to[d + 1]) {
    d += 1;
  }
  // insert "CC" after to position 2000 where neither neighbour is C
  let g = 2000;
  while (to[g - 1] === "C" || to[g] === "C") {
    g += 1;
  }
  let from = to.slice(0, d) + to.slice(d + 1, g) + "CC" + to.slice(g);
  const k = 2499 - 1 + 1; // to position 2500 -> from index (one deleted, two inserted)
  from = from.slice(0, k) + (from[k] === "A" ? "C" : "A") + from.slice(k + 1);
  const map = arc.align(from, to);
  assert.equal(arc.mapPosition(map, 1), 1);
  assert.equal(arc.mapPosition(map, d), d);
  assert.equal(arc.mapPosition(map, d + 1), d + 2, "after the deletion");
  assert.equal(arc.mapPosition(map, g), 0, "inserted base faces a gap");
  assert.equal(arc.mapPosition(map, g + 2), g + 1);
  assert.equal(arc.mapPosition(map, 2501), 2500);
  assert.equal(map.gaps, 3);
  assert.equal(map.mismatches, 1);
  assert.ok(arc.mapNearest(map, 2000, 5) > 0);
  assert.equal(arc.align("acgt", "ACGU").same, true);
}

// ---- alignment: equal length, 400 nt extra at the 5' end and 400 missing
// at the 3' end; the k-mer seed widens the band so the shift is found
{
  const to = randomRNA(7, 10794);
  const from = "ACGU".repeat(100) + to.slice(0, to.length - 400);
  const map = arc.align(from, to);
  assert.equal(arc.mapPosition(map, 401), 1);
  assert.equal(arc.mapPosition(map, 5401), 5001);
  assert.equal(arc.mapPosition(map, 400), 0);
  assert.equal(map.gaps, 800);
  // the reverse direction is the inverse of this map, without a second DP
  const back = arc.align(to, from);
  assert.equal(back.to.length, to.length);
  assert.equal(arc.mapPosition(back, 1), 401);
  assert.equal(arc.mapPosition(back, 5001), 5401);
  assert.equal(arc.mapPosition(back, to.length), 0, "the 3' end missing from from faces a gap");
  assert.equal(back.gaps, 800);
  assert.equal(back.identity, map.identity);
  for (let i = 1; i <= from.length; i += 1) {
    const j = arc.mapPosition(map, i);
    if (j) {
      assert.equal(arc.mapPosition(back, j), i);
    }
  }
}

// ---- structures: dbn with windows, ct
{
  const dbn = arc.parseStructure(">gene:101-110 -3.2\nGGGAAACCCU\n(((...))).\n>gene:201-206\nGGAACC\n((..))\n", "w.dbn");
  same(Array.from(dbn.pairs, function (p) { return Array.from(p); }),
    [[103, 107], [102, 108], [101, 109], [202, 205], [201, 206]]);
  assert.equal(dbn.sequence, "", "windows give no full-length sequence");
  assert.equal(dbn.length, 206);
  const bare = arc.parseStructure(">x\n((((....\n))))\n", "w.dbn");
  assert.equal(bare.length, 12, "a structure without a sequence may wrap");
  assert.equal(bare.pairs.length, 4);
  const full = arc.parseStructure(">ZAFR\nGGGAAACCC\n(((...))) (-1.2)\n", "a.dbn");
  assert.equal(full.sequence, "GGGAAACCC");
  const ct = arc.parseStructure("6 test\n1 G 0 2 6 1\n2 G 1 3 5 2\n3 A 2 4 0 3\n4 A 3 5 0 4\n5 C 4 6 2 5\n6 C 5 0 1 6\n", "t.ct");
  same(Array.from(ct.pairs, function (p) { return Array.from(p); }), [[1, 6], [2, 5]]);
  assert.equal(ct.sequence, "GGAACC");
  assert.equal(ct.note, undefined);
  // RNAstructure: several structures in one CT file, the first is used
  const multi = arc.parseStructure("3 ENERGY = -1.0 s1\n1 G 0 2 3 1\n2 A 1 3 0 2\n3 C 2 4 1 3\n3 ENERGY = -0.5 s1\n1 G 0 2 0 1\n2 A 1 3 0 2\n3 C 2 4 0 3\n", "m.ct");
  assert.equal(multi.sequence, "GAC");
  same(Array.from(multi.pairs, function (p) { return Array.from(p); }), [[1, 3]]);
  assert.match(multi.note, /holds 2 structures; the first is used/);
  // IUPAC codes in the sequence line are a sequence, not pseudoknot brackets
  const iupac = arc.parseStructure(">x\nACGRYNNACG\n((......))\n", "x.dbn");
  assert.equal(iupac.sequence, "ACGRYNNACG");
  same(Array.from(iupac.pairs, function (p) { return Array.from(p); }), [[2, 9], [1, 10]]);
  assert.equal(iupac.length, 10);
  // RNAfold -p: only the MFE structure, not the ensemble / centroid / MEA lines
  const rnafold = arc.parseStructure(">x\nGGGAAACCC\n(((...))) (-1.20)\n((.....)) [-1.50]\n.((...)). {-1.20 d=0.5}\n(((...))) {-1.20 MEA=9.00}\n frequency of mfe structure in ensemble 0.5; ensemble diversity 1.0\n", "p.dbn");
  assert.equal(rnafold.length, 9);
  same(Array.from(rnafold.pairs, function (p) { return Array.from(p); }), [[3, 7], [2, 8], [1, 9]]);
  // a structure wrapped over two lines is still joined
  const wrapped = arc.parseStructure(">x\nGGGAAA\nCCC\n(((...\n)))\n", "w.dbn");
  assert.equal(wrapped.pairs.length, 3);
}

// ---- interactions: Desktop interactions.tsv and rnaxray_compare enrichment
{
  const desktop = arc.parseInteractions("direction\tx\ty\tlog2FoldChange\tpadj\tbaseMean\nup\t1920\t4870\t6.9\t7e-9\t365\ndown\t5720\t3890\t-8.2\t5e-12\t1214\n", "i.tsv");
  same(desktop.rows.map(function (r) { return [r.x, r.up]; }), [[1920, true], [5720, false]]);
  const legacy = arc.parseInteractions("x\ty\tlog2FoldChange\tpadj\n360\t10300\t7.3\t7.3e-9\n", "pos_enrichment.txt");
  assert.equal(legacy.rows[0].up, true);
  assert.throws(function () { arc.parseInteractions("a\tb\n1\t2\n", "bad.tsv"); }, /columns x, y, padj/);
}

// ---- annotation: GenBank keeps outer mature peptides, prM label
const genbank = [
  "LOCUS       NC_000001              60 bp    RNA     linear   VRL 01-JAN-2020",
  "VERSION     NC_000001.1",
  "FEATURES             Location/Qualifiers",
  "     source          1..60",
  "     5'UTR           1..9",
  "     CDS             10..51",
  "                     /gene=\"POLY\"",
  "     mat_peptide     10..30",
  "                     /product=\"anchored capsid protein C\"",
  "     mat_peptide     10..25",
  "                     /product=\"capsid protein C\"",
  "     mat_peptide     31..51",
  "                     /product=\"membrane glycoprotein precursor M\"",
  "     3'UTR           52..60",
  "ORIGIN",
  "        1 acgtacgtac gtacgtacgt acgtacgtac gtacgtacgt acgtacgtac gtacgtacgt",
  "//",
  ""
].join("\n");
{
  const annotation = arc.parseAnnotation(genbank, "a.gb");
  const track = arc.trackFeatures(annotation);
  same(track.features.map(function (f) { return [f.name, f.start, f.end]; }),
    [["5'UTR", 1, 9], ["C", 10, 30], ["prM", 31, 51], ["3'UTR", 52, 60]]);
  assert.equal(track.sequence.length, 60);
  const tsv = arc.parseAnnotation("gene\tstart\tend\nC\t107\t472\nprM\t473\t976\n", "genes.tsv");
  same(arc.trackFeatures(tsv).features.map(function (f) { return f.name; }), ["C", "prM"]);
  // remote parts of a join are skipped; the last feature's name has no
  // trailing quote although the table ends in a blank line
  const remote = arc.parseAnnotation("LOCUS       X 100 bp RNA\nFEATURES             Location/Qualifiers\n     CDS             join(AB012345.1:1..20,30..60)\n                     /gene=\"g\"\n     CDS             complement(<5..>40)\n                     /gene=\"h\"\n\nORIGIN\n        1 acgt\n//\n", "g.gb");
  same(remote.features.map(function (f) { return [f.name, f.start, f.end]; }), [["g", 30, 60], ["h", 5, 40]]);
}

// ---- axis: whole-nucleotide ticks on a short span
{
  const state = arc.defaultState();
  state.a = arc.parseStructure(">a\n" + "ACGU".repeat(50) + "\n" + "(".repeat(10) + ".".repeat(180) + ")".repeat(10) + "\n", "a.dbn");
  state.start = "100";
  state.end = "103";
  const ticks = (arc.svg(state, arc.build(state)).match(/>[0-9.]+<\/text>/g) || []).map(function (t) { return t.slice(1, -7); });
  same(ticks, ["100", "101", "102", "103"]);
}

// ---- defaults: all cells on A's reference, also after B is loaded (the
// rnaxray_compare cell table has one coordinate system)
{
  const state = arc.defaultState();
  same([state.oneOn, state.twoOn], ["a", "a"]);
  const file = { name: "B.dbn", text: function () { return Promise.resolve(">B\nGGGAAACCC\n(((...)))\n"); } };
  arc.loadFile(state, "b", file).then(function () {
    assert.equal(state.b.pairs.length, 3);
    assert.equal(state.twoOn, "a", "loading B keeps the cells on A's reference");
  }).catch(function (error) { process.exitCode = 1; process.stderr.write(String(error && error.stack || error) + "\n"); });
}

// ---- low identity: a visible warning
{
  const state = arc.defaultState();
  const a = randomRNA(11, 600);
  const b = randomRNA(12, 600);
  state.a = arc.parseStructure(">A\n" + a + "\n" + ".".repeat(600) + "\n", "A.dbn");
  state.b = arc.parseStructure(">B\n" + b + "\n" + ".".repeat(600) + "\n", "B.dbn");
  const model = arc.build(state);
  assert.ok(model.notes.some(function (n) { return /^Warning: B aligns to A with only/.test(n); }), model.notes.join("\n"));
}

// ---- build: B on another reference, cells of condition two on B's (set explicitly)
{
  const a = randomRNA(7, 2000);
  const b = a.slice(0, 72) + "A" + a.slice(72, 1999); // B i -> A i-1 after 72
  const dbnA = ">A\n" + a + "\n" + "(".repeat(10) + ".".repeat(1980) + ")".repeat(10) + "\n";
  const structB = "." + "(".repeat(10) + ".".repeat(1979) + ")".repeat(10);
  const state = arc.defaultState();
  state.a = arc.parseStructure(dbnA, "A.dbn");
  state.b = arc.parseStructure(">B\n" + b + "\n" + structB + "\n", "B.dbn");
  state.twoOn = "b";
  state.interactions = arc.parseInteractions("direction\tx\ty\tlog2FoldChange\tpadj\nup\t100\t900\t3\t1e-5\ndown\t300\t1500\t-3\t1e-5\ndown\t310\t1510\t-3\t0.5\n", "i.tsv");
  state.labelOne = "AFR";
  state.labelTwo = "ASI";
  const model = arc.build(state);
  assert.equal(model.ready, true);
  // B's pairs (2..11 with 1991..2000 on B) land on A's 1..10 with 1990..1999
  assert.equal(model.stats.pairsB, 10);
  assert.ok(model.notes.some(function (n) { return n.indexOf("B is shown on A's coordinates by alignment") === 0; }), model.notes.join("\n"));
  same(model.overlay.map(function (o) { return [o.i, o.j, o.up]; }), [[105, 905, true], [304, 1504, false]],
    "condition-two cells move -1 from B's reference; padj >= 0.01 is dropped");
  const svg = arc.svg(state, model);
  assert.match(svg, /higher in AFR/);
  assert.match(svg, /higher in ASI/);
  assert.match(svg, /^<svg xmlns/);
  const html = arc.renderCard(state);
  assert.match(html, /data-arcmap-figure/);
  // the model is kept while the inputs are the same, and rebuilt when one changes
  assert.equal(arc.renderCard(state), html, "same inputs, same card");
  state.labelOne = "AFR2";
  assert.match(arc.renderCard(state), /higher in AFR2/, "a changed setting rebuilds the figure");
  state.labelOne = "AFR";
  assert.match(html, /Download arc map SVG/);
}

// ---- real data (optional)
const real = process.env.RNAXRAY_ARCMAP_REAL;
if (real) {
  const read = function (name) { return fs.readFileSync(path.join(real, name), "utf8"); };
  const state = arc.defaultState();
  state.a = arc.parseStructure(read("ZAFR.dbn"), "ZAFR.dbn");
  state.b = arc.parseStructure(read("ZILM.dbn"), "ZILM.dbn");
  state.interactions = arc.parseInteractions(read("interactions.tsv"), "interactions.tsv");
  state.annotation = arc.parseAnnotation(read("NC_035889.gb"), "NC_035889.gb");
  state.labelOne = "ZAFR";
  state.labelTwo = "ZASI";
  // default state: every cell on ZAFR's coordinates, as the reproduction
  same([state.oneOn, state.twoOn], ["a", "a"]);
  const started = Date.now();
  const model = arc.build(state);
  const up = model.overlay.filter(function (o) { return o.up; }).length;
  const down = model.overlay.length - up;
  process.stdout.write("real: " + JSON.stringify(model.stats) + " up " + up + " down " + down + " in " + (Date.now() - started) + " ms\n");
  model.notes.forEach(function (n) { process.stdout.write("  " + n + "\n"); });
  process.stdout.write("  features " + model.features.map(function (f) { return f.name + " " + f.start + "-" + f.end; }).join(", ") + "\n");
  assert.equal(up, 378);
  assert.equal(down, 1243);
  const c = model.features.find(function (f) { return f.name === "C"; });
  same([c.start, c.end], [107, 472], "NC_035889 C 108-473 lands on ZAFR 107-472");
  assert.ok(!model.notes.some(function (n) { return /^Warning/.test(n); }), "89.1% identity gives no warning");
  // condition-two cells read on ZILM instead (the alignment moves them)
  state.twoOn = "b";
  const onB = arc.build(state);
  assert.equal(onB.overlay.filter(function (o) { return !o.up; }).length, 1243);
  state.twoOn = "a";
  fs.writeFileSync(path.join(real, "arc-map.svg"), arc.svg(state, model));
}

process.stdout.write("arc-map: ok\n");

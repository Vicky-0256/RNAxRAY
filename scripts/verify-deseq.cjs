#!/usr/bin/env node
// Checks web/deseq.js, the JavaScript port of RNAxRay Desktop's numpy DESeq2
// port (pipeline/rnaxrayanalysis/deseq.py + differential.py).
//
// Always: special functions, BH, lowess, contact binning, the interaction
// split, and three synthetic tables (3 vs 3 with Cook's outliers, 2 vs 2,
// 2 vs 1) against values produced by pipeline/rnaxrayanalysis/deseq.py.
//
// With RNAXRAY_DESEQ_REAL=<dir> holding the four ZIKV virion contact maps
// (ZAFR_REP1/2 vs ZILM_REP2/3 *.contact.txt) it runs the whole comparison and
// asserts the R DESeq2 1.46 / numpy-port numbers; when the rnaxray_compare R
// outputs (*_100range_pos/neg_enrichment.txt,
// DESeq_*_significant.padj_heatmap.txt) are in the same folder they are
// compared cell by cell.  RNAXRAY_DESEQ_NUMPY=<results.tsv> (written by
// rnaxrayanalysis.differential.compare) adds a cell-by-cell comparison of every
// tested cell with the numpy port.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repository = path.resolve(__dirname, "..");
// Loaded with vm into this context (a separate vm context makes every global
// lookup go through the context's interceptors, ~10x slower on a genome).
const win = {};
["deseq.js", "arc-map.js"].forEach(function (file) {
  const source = fs.readFileSync(path.join(repository, "web", file), "utf8");
  vm.runInThisContext("(function (window, module) {" + source + "\n})", { filename: file })(win, undefined);
});
const D = win.RNAxRayDeseq;
const arc = win.RNAxRayArcMap;
const same = function (actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
};
const close = function (actual, expected, rel, message) {
  if (expected === null || Number.isNaN(expected)) {
    assert.ok(actual === null || Number.isNaN(actual), message + ": expected NA, got " + actual);
    return;
  }
  const err = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);
  assert.ok(err <= rel, message + ": " + actual + " vs " + expected + " (rel " + err + ")");
};

// ---- special functions
close(D.lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-15, "lgamma(0.5)");
close(D.lgamma(10), Math.log(362880), 1e-15, "lgamma(10)");
close(D.lgamma(1e8 + 0.5), 1742068075.3141751, 1e-15, "lgamma(1e8 + 0.5)");
assert.equal(D.lgamma(1), 0);
assert.equal(D.lgamma(2), 0);
assert.equal(D.erfc(0), 1);
close(D.erfc(1), 0.15729920705028516, 1e-15, "erfc(1)");
close(D.erfc(5), 1.5374597944280349e-12, 1e-14, "erfc(5)");
close(D.erfc(20), 5.3958656116079005e-176, 1e-13, "erfc(20)");
close(D.digamma(1), -0.5772156649015329, 1e-12, "digamma(1) (series as deseq.py)");
close(D.trigamma(1), Math.PI * Math.PI / 6, 1e-10, "trigamma(1) (series as deseq.py)");
assert.equal(D.median(Float64Array.from([3, 1, 2, 10])), 2.5);

// ---- R p.adjust(p, "BH"), NaN kept out of the count (values from deseq.p_adjust_bh)
{
  const p = Float64Array.from([0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, NaN, 0.042]);
  const expected = [0.009000000000000001, 0.036000000000000004, 0.063, 0.063, 0.063, 0.07714285714285715, 0.08324999999999999, 0.205, NaN, 0.063];
  const adj = D.pAdjustBH(p);
  expected.forEach(function (value, i) { close(adj[i], value, 1e-15, "BH " + i); });
}

// ---- R lowess (values from deseq.lowess)
{
  const fit = D.lowess([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 3, 2, 5, 4, 6, 8, 7, 9, 12], 0.5);
  [1.283796734305262, 2.1721377962723505, 3.1581244387769525, 3.843077482914688, 4.860225815496957, 6.0,
    7.130139350154154, 7.865004333303602, 9.565729442349475, 11.51657364683544].forEach(function (value, i) {
    close(fit[i], value, 1e-13, "lowess " + i);
  });
}

// ---- contact cells: RNAxRay coverage rule, dense and sparse paths agree
{
  // arms (inclusive): x 5..14 covers bins 0 and 10; y 21..21 bin 20
  const arms = Int32Array.from([5, 14, 21, 21, 10, 12, 20, 29, 1, 1, 1, 1]);
  const cells = D.binArms(arms, 10);
  same(Array.from(cells.x), [0, 0, 10]);
  same(Array.from(cells.y), [0, 20, 20]);
  same(Array.from(cells.count), [1, 1, 2]);
  // same records far out on the genome take the sparse path
  const far = Int32Array.from([5, 14, 21, 21, 10, 12, 20, 29, 1, 1, 1, 1, 90000000, 90000000, 90000000, 90000000]);
  const sparse = D.binArms(far, 10);
  same(Array.from(sparse.count), [1, 1, 2, 1]);
  same(Array.from(sparse.x).slice(-1), [90000000]);
  const columns = D.cellsFromColumns([10, 0, 0, 10], [20, 0, 20, 20], [1, 1, 1, 1], 10);
  same(Array.from(columns.key), Array.from(cells.key));
  same(Array.from(columns.count), [1, 1, 2]);
  const parsed = D.parseContactText("# hybrids between A and A\nx\ty\tcount\n10\t20\t2\n0\t0\t1\n0\t20\t1\n", 10);
  same(Array.from(parsed.count), [1, 1, 2]);
  const table = D.countTable([cells, D.cellsFromColumns([0, 30], [0, 30], [5, 7], 10)]);
  same(Array.from(table.table), [1, 5, 1, 0, 2, 0, 0, 7]);
  assert.throws(function () { D.cellsFromColumns([5], [0], [1], 10); }, /multiples of the bin size/);
}

// ---- greedy interaction split (padj order, per direction, both axes within range)
{
  const x = [100, 150, 100, 400, 120, 300];
  const y = [100, 150, 260, 400, 110, 300];
  const lfc = [2, 1, 3, -1, -2, 0];
  const padj = [0.01, 0.001, 0.02, 0.03, 0.005, 0.0001];
  // up by padj: 1 (150,150) kept, 0 (100,100) within 100 of it -> dropped,
  // 2 (100,260) |260-150| > 100 -> kept; down: 4 kept, 3 kept; 5 has lfc 0
  same(Array.from(D.splitInteractions(x, y, lfc, padj, 100)), [1, 2, 4, 3]);
  same(Array.from(D.splitInteractions(x, y, lfc, padj, 0)), [1, 0, 2, 4, 3]);
}

// ---- deterministic synthetic tables vs pipeline/rnaxrayanalysis/deseq.py
function synth(seed, rows, sf, one, outliers) {
  let s = seed >>> 0;
  const rand = function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  const normal = function () { return Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()); };
  const poisson = function (lambda) {
    if (lambda > 50) {
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal()));
    }
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do { k += 1; p *= rand(); } while (p > L);
    return k - 1;
  };
  const m = sf.length;
  const table = new Float64Array(rows * m);
  for (let i = 0; i < rows; i += 1) {
    const mu = Math.exp(6 * rand());
    const u = rand();
    const effect = u < 0.05 ? 3 : (u < 0.1 ? 1 / 3 : 1);
    const spike = outliers && rand() < outliers ? Math.floor(rand() * m) : -1;
    for (let j = 0; j < m; j += 1) {
      table[i * m + j] = poisson(mu * sf[j] * (one[j] ? effect : 1) * Math.exp(0.4 * normal()) * (j === spike ? 25 : 1));
    }
  }
  return table;
}

const SYNTH = {
  c33: { seed: 11, rows: 3000, sf: [1, 1.3, 0.8, 1.1, 0.9, 1.2], one: [1, 1, 1, 0, 0, 0], outliers: 0.03,
    expected: {"n": 2992, "sizeFactors": [0.9852440226110933, 1.2771823873225883, 0.7736896326442463, 1.052414958869837, 0.8735804647362988, 1.165862323721165], "trend": [0.20063388320375491, 1.6035699596389201], "filterThreshold": 21.139768375401477, "pvalueNaN": 59, "padjBelow01": 94, "padjBelow001": 38, "withPadj": 1485, "rows": {"0": [-0.3028240230171213, 1.0406166660386602, 0.7710479584106926, null], "1": [-0.4096258465105392, 1.2990041679052327, 0.7525047610074616, null], "2": [0.17639903840478074, 0.4892228407087599, 0.7184209822993747, 0.978543502135763], "3": [-1.1938397780711638, 0.692597206772622, 0.08475941430788704, 0.5594121344320544], "4": [-0.7325025124164917, 0.44809544956765335, 0.10211154014845628, 0.6065425484818303], "302": [2.612917694407357, 0.46467256085444475, 1.8752004209229803e-08, 1.4554094828838102e-05], "2436": [5.77304882647219, 1.7772371284934785, null, null]}} },
  c22: { seed: 12, rows: 3000, sf: [1, 1.4, 0.7, 1.1], one: [1, 1, 0, 0],
    expected: {"n": 2965, "sizeFactors": [1.0, 1.414213562373095, 0.6953877596103817, 1.0737881416139679], "trend": [0.13754801203001882, 2.928208341109857], "filterThreshold": 0.5303300858899107, "pvalueNaN": 0, "padjBelow01": 32, "padjBelow001": 6, "withPadj": 2965, "rows": {"0": [0.968701640556789, 1.3354589487923154, 0.46822517213630843, 0.997538541717159], "1": [1.3275284660014364, 1.9734743056314712, 0.5011470989347054, 0.997538541717159], "2": [-0.9897294217980284, 0.5903873563726185, 0.09365852364518873, 0.8787896285062803], "3": [-0.37846105626664284, 0.6371829838447942, 0.5525390231358251, 0.997538541717159], "4": [0.8973381245243932, 1.7398775501910033, 0.6060305224414395, 0.997538541717159], "337": [3.056231098976566, 0.561420928793455, 5.2172557542215e-08, 0.00015469163311266748], "2567": [-5.125248187043785, 2.171647608200602, 0.018271309688865242, 0.46702097609901244]}} },
  c21: { seed: 13, rows: 2000, sf: [1, 1.2, 0.9], one: [1, 1, 0],
    expected: {"n": 1951, "sizeFactors": [0.9865935572575623, 1.1983048008010897, 0.8855488076521758], "trend": [0.1475411913497903, 5.832897563994059], "filterThreshold": 0.8345122203728809, "pvalueNaN": 0, "padjBelow01": 2, "padjBelow001": 2, "withPadj": 1951, "rows": {"0": [0.006493535243420268, 2.124082146379918, 0.9975607895135818, 0.9986731863285512], "1": [-2.3322991337252876, 4.416370431655323, 0.5974277450782208, 0.9986731863285512], "2": [2.06880145085215, 1.3438148257519096, 0.12368254535582597, 0.9986731863285512], "3": [-0.8379447715449734, 0.6759019391520863, 0.21507042666300674, 0.9986731863285512], "4": [1.4711250782177383, 0.9025387551339941, 0.103104562953789, 0.9986731863285512], "1730": [3.1780991325975307, 0.662207850513134, 1.592631701639995e-06, 0.00310722444989963], "1281": [5.812755540049866, 2.613987969030634, 0.02616784986442057, 0.8864190074322297]}} }
};

Object.keys(SYNTH).forEach(function (name) {
  const c = SYNTH[name];
  const e = c.expected;
  const m = c.sf.length;
  const raw = synth(c.seed, c.rows, c.sf, c.one, c.outliers);
  const rows = [];
  for (let i = 0; i < c.rows; i += 1) {
    let s = 0;
    for (let j = 0; j < m; j += 1) { s += raw[i * m + j]; }
    if (s > 2) { rows.push(i); }
  }
  assert.equal(rows.length, e.n, name + " rows passing the minimum count");
  const table = new Float64Array(rows.length * m);
  rows.forEach(function (i, r) { table.set(raw.subarray(i * m, i * m + m), r * m); });
  const r = D.deseqTwoConditions(table, rows.length, m, c.one.map(Boolean), { alpha: 0.01 });
  e.sizeFactors.forEach(function (value, j) { close(r.sizeFactors[j], value, 1e-14, name + " size factor " + j); });
  close(r.trend[0], e.trend[0], 1e-6, name + " asymptDisp");
  close(r.trend[1], e.trend[1], 1e-6, name + " extraPois");
  close(r.filterThreshold, e.filterThreshold, 1e-12, name + " filter threshold");
  let nanP = 0;
  let below01 = 0;
  let below001 = 0;
  let withPadj = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (Number.isNaN(r.pvalue[i])) { nanP += 1; }
    if (r.padj[i] < 0.1) { below01 += 1; }
    if (r.padj[i] < 0.01) { below001 += 1; }
    if (!Number.isNaN(r.padj[i])) { withPadj += 1; }
  }
  assert.equal(nanP, e.pvalueNaN, name + " Cook's-filtered p-values");
  assert.equal(below01, e.padjBelow01, name + " padj < 0.1");
  assert.equal(below001, e.padjBelow001, name + " padj < 0.01");
  assert.equal(withPadj, e.withPadj, name + " cells kept by independent filtering");
  Object.keys(e.rows).forEach(function (key) {
    const i = Number(key);
    const v = e.rows[key];
    close(r.log2FoldChange[i], v[0], 1e-6, name + " row " + i + " log2FoldChange");
    close(r.lfcSE[i], v[1], 1e-6, name + " row " + i + " lfcSE");
    close(r.pvalue[i], v[2], 1e-5, name + " row " + i + " pvalue");
    close(r.padj[i], v[3], 1e-5, name + " row " + i + " padj");
  });
});

// prior variance for 1-3 residual degrees of freedom (deseq._prior_var_few_df;
// expected values from DESeq2 1.46's estimateDispersionsPriorVar code in R 4.4.3)
{
  let s = 99;
  const rand = function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  const resid = Float64Array.from({ length: 5000 }, function () { return 1.6 * Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand()) - 0.3; });
  close(D.priorVarFewDf(resid, 1), 1.057057057057057, 1e-12, "prior var df 1");
  close(D.priorVarFewDf(resid, 2), 1.5135135135135136, 1e-12, "prior var df 2");
  close(D.priorVarFewDf(resid, 3), 1.7857857857857857, 1e-12, "prior var df 3");
}

// ---- R stops when no cell is non-zero in every sample (no size factors)
{
  const table = Float64Array.from([5, 0, 3, 4, 2, 6, 0, 1, 0, 7, 8, 9, 3, 3, 3, 0]);
  assert.throws(function () { D.deseqTwoConditions(table, 4, 4, [true, true, false, false]); }, /zero count in at least one sample.*size factors/);
  const cells = function (count) { return D.cellsFromColumns([0, 10, 20], [0, 10, 20], count, 10); };
  assert.throws(function () {
    D.compare([cells([5, 6, 7]), cells([4, 3, 9]), cells([8, 2, 1]), D.cellsFromColumns([], [], [], 10)].map(function (c, j) { return { name: "s" + j, cells: c }; }),
      [true, true, false, false]);
  }, /size factors/, "a sample without records");
}

// ---- locfit trend outside the fitted means (DESeq2's local fallback)
// pipeline/tests/golden/deseq/local_extrapolation: the trend is fitted on
// means up to ~8 and evaluated at ~300; R DESeq2 1.46 gives dispFit ~1.07 and
// padj ~0.002 for the strong block (locfit continues the boundary value and
// slope with the global quadratic's curvature, not the Hermite cubic, which
// gave dispFit ~1e37 and padj ~1)
{
  const golden = path.join(repository, "pipeline", "tests", "golden", "deseq", "local_extrapolation");
  const lines = function (file) { return fs.readFileSync(golden + file, "utf8").trim().split("\n").slice(1).map(function (l) { return l.split("\t"); }); };
  const counts = lines(".counts.tsv");
  const expected = lines(".R.tsv");
  const n = counts.length;
  const table = new Float64Array(n * 4);
  counts.forEach(function (row, i) { for (let j = 0; j < 4; j += 1) { table[i * 4 + j] = Number(row[j + 1]); } });
  const r = D.deseqTwoConditions(table, n, 4, [true, true, false, false], { alpha: 0.01 });
  assert.equal(r.fitType, "local");
  let worst = 0;
  expected.forEach(function (row, i) {
    assert.equal(row[0], counts[i][0]);
    worst = Math.max(worst, Math.abs(r.dispFit[i] / Number(row[6]) - 1));
  });
  assert.ok(worst < 1e-5, "dispFit as R within 1e-5 (worst " + worst + ")");
  ["100_300", "100_310", "110_300", "110_310"].forEach(function (cell) {
    const i = counts.findIndex(function (row) { return row[0] === cell; });
    close(r.dispFit[i], Number(expected[i][6]), 1e-5, cell + " dispFit");
    close(r.padj[i], Number(expected[i][5]), 1e-3, cell + " padj");
  });
  // the fitted curve itself, far outside the data on both sides
  const out = D.localFit(Float64Array.from([1, 2, 4, 8]), Float64Array.from([2, 1, 0.6, 0.5]), Float64Array.from([1e-3, 1e6]));
  assert.ok(out.every(Number.isFinite), "extrapolation stays finite");
}

// ---- locfit's span at a floating-point edge: the trend is fitted on 690
// cells, 690 * 0.7 is 482.999... and locfit takes the 483rd nearest point
// (golden bandwidth_690, R DESeq() defaults;
// columns baseMean lfc padj dispFit dispersion)
{
  const golden = path.join(repository, "pipeline", "tests", "golden", "deseq", "bandwidth_690");
  const lines = function (file) { return fs.readFileSync(golden + file, "utf8").trim().split("\n").slice(1).map(function (l) { return l.split("\t"); }); };
  const counts = lines(".counts.tsv");
  const expected = lines(".R.tsv");
  const n = counts.length;
  const table = new Float64Array(n * 6);
  counts.forEach(function (row, i) { for (let j = 0; j < 6; j += 1) { table[i * 6 + j] = Number(row[j + 1]); } });
  const r = D.deseqTwoConditions(table, n, 6, [true, true, true, false, false, false]);
  assert.equal(r.fitType, "local");
  expected.forEach(function (row, i) {
    assert.equal(row[0], counts[i][0]);
    close(r.dispFit[i], Number(row[4]), 1e-6, row[0] + " dispFit");
    close(r.dispersion[i], Number(row[5]), 1e-6, row[0] + " dispersion");
  });
}

// ---- locfit on a handful of points (golden local_small_fits: R locfit on
// 2-8 points, random, wide, tied and equispaced means; p is NA where R stops
// with "newsplit: out of vertex space").  Windows with one or two points, a
// vertex with no points and nearly collinear windows are solved as locfit
// does (one Newton step from the weighted mean, eigen solve that leaves
// eigenvalues <= 1e-8 * max undivided, previous fit kept for an empty window).
{
  const golden = path.join(repository, "pipeline", "tests", "golden", "deseq", "local_small_fits");
  const lines = function (file) { return fs.readFileSync(golden + file, "utf8").trim().split("\n").slice(1).map(function (l) { return l.split("\t"); }); };
  const data = {};
  const pred = {};
  lines(".data.tsv").forEach(function (row) { (data[row[0]] = data[row[0]] || []).push([Number(row[1]), Number(row[2])]); });
  lines(".R.tsv").forEach(function (row) { (pred[row[0]] = pred[row[0]] || []).push([Number(row[1]), row[2] === "NA" ? NaN : Number(row[2])]); });
  Object.keys(data).forEach(function (name) {
    const means = Float64Array.from(data[name], function (r) { return r[0]; });
    const disps = Float64Array.from(data[name], function (r) { return r[1]; });
    const q = Float64Array.from(pred[name], function (r) { return r[0]; });
    if (pred[name].every(function (r) { return Number.isNaN(r[1]); })) {
      assert.throws(function () { D.localFit(means, disps, q); }, /out of vertex space/, name);
      return;
    }
    const out = D.localFit(means, disps, q);
    pred[name].forEach(function (r, i) { close(out[i], r[1], 1e-8, name + " at " + r[0]); });
  });
}

// ---- DESeq2 end to end with a locfit trend on 4 points (golden
// local_four_points, R DESeq() defaults; columns baseMean lfc padj dispFit
// dispersion), and a 3-row table where R stops with locfit's "newsplit: out
// of vertex space" (local_vertex_space)
{
  const golden = path.join(repository, "pipeline", "tests", "golden", "deseq");
  const lines = function (file) { return fs.readFileSync(path.join(golden, file), "utf8").trim().split("\n").slice(1).map(function (l) { return l.split("\t"); }); };
  const table = function (counts) {
    const t = new Float64Array(counts.length * 6);
    counts.forEach(function (row, i) { for (let j = 0; j < 6; j += 1) { t[i * 6 + j] = Number(row[j + 1]); } });
    return t;
  };
  const counts = lines("local_four_points.counts.tsv");
  const expected = lines("local_four_points.R.tsv");
  const r = D.deseqTwoConditions(table(counts), counts.length, 6, [true, true, true, false, false, false]);
  assert.equal(r.fitType, "local");
  expected.forEach(function (row, i) {
    assert.equal(row[0], counts[i][0]);
    close(r.dispFit[i], Number(row[4]), 1e-9, row[0] + " dispFit");
    close(r.dispersion[i], Number(row[5]), 1e-5, row[0] + " dispersion");
    close(r.padj[i], Number(row[3]), 1e-4, row[0] + " padj");
  });
  const tiny = lines("local_vertex_space.counts.tsv");
  assert.throws(function () { D.deseqTwoConditions(table(tiny), tiny.length, 6, [true, true, true, false, false, false]); }, /out of vertex space/);
  // estimateDispersionsFit stops when no gene-wise estimate is above 100 * minDisp
  assert.throws(function () {
    D.deseqTwoConditions(Float64Array.from([5, 15, 2, 9, 1, 1, 2, 2, 18, 29, 7, 11]), 3, 4, [true, true, false, false]);
  }, /within 2 orders of magnitude/);
}

// ---- MAP dispersion against R (golden map_*: 1-3 residual degrees of freedom,
// where dispPriorVar comes from DESeq2's simulation after set.seed(2), and small
// MAP dispersions, where the order of the lgamma terms of the log posterior
// decides the line search; columns baseMean lfc padj dispGeneEst dispFit
// dispersion dispPriorVar; R DESeq() defaults, rowSums > 2, alpha 0.01)
{
  const golden = path.join(repository, "pipeline", "tests", "golden", "deseq");
  const lines = function (file) { return fs.readFileSync(path.join(golden, file), "utf8").trim().split("\n").map(function (l) { return l.split("\t"); }); };
  ["map_two_vs_two", "map_three_vs_two", "map_one_vs_two", "map_small_dispersion"].forEach(function (name) {
    const counts = lines(name + ".counts.tsv");
    const columns = counts.shift().slice(1);
    const conditions = {};
    lines(name + ".conditions.tsv").forEach(function (row) { conditions[row[0]] = row[1]; });
    const kept = counts.filter(function (row) { return row.slice(1).reduce(function (a, v) { return a + Number(v); }, 0) > 2; });
    const m = columns.length;
    const t = new Float64Array(kept.length * m);
    kept.forEach(function (row, i) { for (let j = 0; j < m; j += 1) { t[i * m + j] = Number(row[j + 1]); } });
    const r = D.deseqTwoConditions(t, kept.length, m, columns.map(function (c) { return conditions[c] === "condition_one"; }));
    const expected = lines(name + ".R.tsv").slice(1);
    close(r.dispPriorVar, Number(expected[0][7]), 1e-12, name + " dispPriorVar");
    expected.forEach(function (row, i) {
      assert.equal(row[0], kept[i][0]);
      close(r.dispGeneEst[i], Number(row[4]), 1e-9, name + " " + row[0] + " dispGeneEst");
      close(r.dispFit[i], Number(row[5]), 1e-8, name + " " + row[0] + " dispFit");
      // The MAP line search stops within its own tolerance, so the last ulp of
      // the log posterior (V8's x64 and arm64 builds differ there) can move a
      // small dispersion by ~5e-7 relative; padj and log2FoldChange below are
      // unaffected at 1e-4.
      close(r.dispersion[i], Number(row[6]), name === "map_small_dispersion" ? 2e-6 : 1e-8, name + " " + row[0] + " dispersion");
      close(r.log2FoldChange[i], Number(row[2]), 1e-4, name + " " + row[0] + " log2FoldChange");
      close(r.padj[i], row[3] === "NA" ? NaN : Number(row[3]), 1e-4, name + " " + row[0] + " padj");
    });
  });
  // R's lgamma (%a), and DESeq2's simulated histogram for df 2, grid value 101
  [["0x1p-1", "0x1.250d048e7a1bdp-1"], ["0x1.5p+3", "0x1.be199a0f64394p+3"], ["0x1.81cd6c8b43958p+13", "0x1.9617eb7eee0bcp+16"],
    ["0x1.2d3106p+22", "0x1.0f4b6983eb25bp+26"], ["0x1.7d78404p+24", "0x1.7e4a2083b2ce5p+28"],
    ["0x1.7d7841cp+26", "0x1.9f57678c31c43p+30"], ["0x1.6345785d8ap+57", "0x1.af2da8ce803abp+62"]].forEach(function (pair) {
    const hex = function (h) {
      const q = h.match(/^0x([01])\.?([0-9a-f]*)p([+-]\d+)$/);
      return parseInt(q[1] + q[2], 16) / Math.pow(16, q[2].length) * Math.pow(2, Number(q[3]));
    };
    const x = hex(pair[0]);
    assert.equal(x <= 10 ? D.lgammaRSmall(x) : D.lgammaR(x), hex(pair[1]), "R lgamma(" + x + ")");
  });
}

// ---- the bucketed interaction split = the plain quadratic one
{
  let s = 7;
  const rand = function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let t = 0; t < 200; t += 1) {
    const n = 1 + Math.floor(rand() * 1500);
    const span = [50, 500, 5000, 1e6][t % 4];
    const radius = [0, 1, 10, 100, 250][t % 5];
    const x = [];
    const y = [];
    const lfc = [];
    const padj = [];
    for (let i = 0; i < n; i += 1) {
      x.push(Math.floor(rand() * span / 10) * 10 - (t % 7 === 0 ? span / 2 : 0));
      y.push(Math.floor(rand() * span / 10) * 10);
      lfc.push(rand() < 0.05 ? 0 : rand() - 0.5);
      padj.push(rand() < 0.2 ? 0.01 : rand() * 0.05);
    }
    same(Array.from(D.splitInteractions(x, y, lfc, padj, radius)), Array.from(D.splitInteractionsPlain(x, y, lfc, padj, radius)), "split case " + t);
  }
}

// ---- compare(): input rules, outputs and the arc-map hand-off
{
  const cellsOf = function (seed) {
    const raw = synth(seed, 400, [1, 1, 1, 1], [1, 1, 0, 0]);
    const x = [];
    const y = [];
    const count = [];
    for (let i = 0; i < 400; i += 1) {
      x.push(10 * (i % 20) * 7);
      y.push(10 * Math.floor(i / 20) * 7);
      count.push(raw[i * 4]);
    }
    return D.cellsFromColumns(x, y, count, 10);
  };
  const samples = [cellsOf(21), cellsOf(22), cellsOf(23), cellsOf(24)].map(function (cells, j) { return { name: "s" + j, cells: cells }; });
  assert.throws(function () { D.compare(samples.slice(0, 2), [true, false]); }, /at least three samples/);
  assert.throws(function () { D.compare(samples.slice(0, 3), [true, true, true]); }, /both conditions/);
  assert.throws(function () { D.compare(samples, [true, true, false, false], { minCount: -1 }); }, /min count/);
  const out = D.compare(samples, [true, true, false, false], { padjCutoff: 1 });
  assert.equal(out.summary.cellsTested + 0 <= 400, true);
  assert.equal(out.summary.significant, out.significant.x.length);
  assert.equal(out.summary.interactions, out.interactions.length);
  const tsv = D.interactionsToTsv(out.interactions);
  assert.equal(tsv.split("\n")[0], "direction\tx\ty\tlog2FoldChange\tpadj\tbaseMean");
  // the arc map gets the rows parseInteractions makes of interactions.tsv
  const parsed = arc.parseInteractions(tsv, "interactions.tsv");
  same(D.arcMapInteractions(out.interactions, "interactions.tsv"), parsed);
  assert.equal(D.significantToTsv(out.significant).split("\n").length, out.significant.x.length + 2);
}

console.log("verify-deseq: synthetic checks passed");

// ---- the worker protocol (deseq.worker.js) with arms in, transferable result out
async function workerAndCard() {
  const messages = [];
  const workerScope = { postMessage: function (message, transfer) { messages.push({ message: message, transfer: transfer }); } };
  workerScope.self = workerScope;
  workerScope.location = { search: "?build=abc123" };
  workerScope.importScripts = function (file) {
    assert.equal(file, "./deseq.js?build=abc123", "deseq.js is loaded with the worker's build query");
    const source = fs.readFileSync(path.join(repository, "web", "deseq.js"), "utf8");
    vm.runInThisContext("(function (self, window, module) {" + source + "\n})", { filename: "deseq.js" })(workerScope, undefined, undefined);
  };
  const workerSource = fs.readFileSync(path.join(repository, "web", "deseq.worker.js"), "utf8");
  vm.runInThisContext("(function (self, importScripts) {" + workerSource + "\n})", { filename: "deseq.worker.js" })(workerScope, workerScope.importScripts);
  // four samples of records on one 300-nt RNA; arms in 1..300
  const armsOf = function (seed, boost) {
    let s = seed;
    const rand = function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const list = [];
    for (let r = 0; r < 3000; r += 1) {
      const hot = rand() < boost;
      const x0 = hot ? 40 + Math.floor(rand() * 10) : 1 + Math.floor(rand() * 270);
      const y0 = hot ? 200 + Math.floor(rand() * 10) : 1 + Math.floor(rand() * 270);
      list.push(x0, x0 + 12 + Math.floor(rand() * 15), y0, y0 + 12 + Math.floor(rand() * 15));
    }
    return Int32Array.from(list);
  };
  const finished = new Promise(function (resolve) {
    workerScope.postMessage = function (message, transfer) {
      messages.push({ message: message, transfer: transfer });
      if (message.type === "done" || message.type === "error") {
        resolve();
      }
    };
  });
  workerScope.onmessage({ data: { samples: [
    { name: "a1", arms: armsOf(1, 0.2) }, { name: "a2", arms: armsOf(2, 0.2) }, { name: "b1", arms: armsOf(3, 0) }, { name: "b2", arms: armsOf(4, 0) }
  ], conditionOne: [true, true, false, false], options: { minCount: 2, radius: 100, padjCutoff: 0.05 } } });
  await finished;
  const done = messages.find(function (m) { return m.message.type === "done"; });
  assert.ok(done, "worker finished: " + JSON.stringify(messages.filter(function (m) { return m.message.type === "error"; })));
  assert.ok(messages.some(function (m) { return m.message.type === "progress"; }), "worker reports progress");
  assert.equal(done.transfer.length, 5, "significant columns are transferred");
  const up = done.message.result.interactions.filter(function (row) { return row.direction === "up"; });
  assert.ok(up.length >= 1, "the enriched block is found");
  assert.ok(up[0].x >= 30 && up[0].x <= 70 && up[0].y >= 190 && up[0].y <= 230, "top up interaction in the enriched block: " + JSON.stringify(up[0]));
  workerScope.lastResult = done.message.result;

  // ---- the Compare card (deseq-card.js): plan, render, exports, arc map hand-off, report
  const documentStub = { querySelector: function () { return null; }, getElementById: function () { return null; } };
  const cardWindow = { RNAxRayDeseq: D, RNAxRayArcMap: arc };
  const cardSource = fs.readFileSync(path.join(repository, "web", "deseq-card.js"), "utf8");
  vm.runInThisContext("(function (window, document) {" + cardSource + "\n})", { filename: "deseq-card.js" })(cardWindow, documentStub);
  const card = cardWindow.RNAxRayDeseqCard;
  assert.match(cardSource, /"deseq\.worker\.js\?build=" \+ encodeURIComponent\(window\.RNAXRAY_BUILD && window\.RNAXRAY_BUILD\.commit \|\| "local"\)/,
    "the worker URL carries the build query");
  assert.match(workerSource, /new Worker\("\.\/deseq\.worker\.js" \+ BUILD_QUERY\)/, "helper workers carry the build query");
  const ds = function (id, condition, rnas) {
    return { id: id, label: id, fileName: id + ".hyb", condition: condition, summary: { validRecords: 10, rnaNames: rnas } };
  };
  const afr = "ZIKV_African_KX377335-1_virusRNA";
  const ilm = "ZIKV_FrenchPolynesian_KJ776791-2_virusRNA";
  const state = { comparison: { rnaX: afr, rnaY: afr, conditionALabel: "ZAFR", conditionBLabel: "ZILM",
    datasets: [ds("ZAFR_REP1", "A", [afr]), ds("ZILM_REP2", "B", ["host", ilm])] } };
  assert.match(card.eligibility(state.comparison).reason, /at least three datasets/);
  state.comparison.datasets.splice(1, 0, ds("ZAFR_REP2", "A", [afr, "host"]));
  assert.equal(card.eligibility(state.comparison).ok, true, "2 + 1 replicates are enough");
  state.comparison.datasets.push(ds("ZILM_REP3", "B", [ilm]));
  assert.equal(card.eligibility(state.comparison).ok, true);
  state.comparison.datasets.push(ds("primary", "A", ["other"]));
  card.handleChange(state, { dataset: { feature: "deseq-include", datasetId: "primary" }, checked: false }, { render: function () {} });
  assert.equal(card.rnaPlan(state.comparison).length, 4, "a dataset left out of the test is not used");
  const plan = card.rnaPlan(state.comparison);
  same(plan.map(function (item) { return [item.rnaX, item.substituted]; }), [[afr, false], [afr, false], [ilm, true], [ilm, true]]);
  same(Array.from(card.collectArms({ index: [0, 1, 2], rnaOne: [ilm, ilm, "host"], rnaTwo: [ilm, "host", ilm], oneStart: [5, 1, 1], oneEnd: [9, 2, 2], twoStart: [30, 3, 3], twoEnd: [44, 4, 4] }, plan[2])),
    [5, 9, 30, 44], "only the homodimer rows of the chosen RNA, in file orientation");
  const html0 = card.renderCard(state);
  assert.match(html0, /data-feature-action="deseq-run"/);
  assert.match(html0, /JavaScript port of RNAxRay Desktop/);
  assert.match(html0, /data-feature="deseq-rna"/, "a substituted RNA can be changed");
  // a finished run, as run() stores it
  const result = Object.assign({}, workerScope.lastResult);
  result.inputKey = JSON.stringify([card.rnaPlan(state.comparison).map(function (item) {
    return [item.dataset.id, item.dataset.condition, item.rnaX, item.rnaY, 10];
  }), "2", "100", "0.05"]);
  result.labels = { A: "ZAFR", B: "ZILM" };
  result.datasets = plan.map(function (item) { return { id: item.dataset.id, label: item.dataset.label, condition: item.dataset.condition, rnaX: item.rnaX, rnaY: item.rnaY }; });
  state.comparison.deseq.result = result;
  const html = card.renderCard(state);
  assert.match(html, /A · Differential coverage map/);
  assert.match(html, /data-feature-action="deseq-use-arcmap"/);
  assert.match(html, /data-feature-action="deseq-export-interactions"/);
  assert.doesNotMatch(html, /changed after this result/, "a current result is not marked stale");
  const panel = card.panelSvg(state.comparison);
  assert.equal(panel.total, result.significant.x.length);
  assert.equal((panel.svg.match(/<rect x=/g) || []).length, panel.total + 1, "one rect per significant cell plus the frame");
  const downloads = [];
  const api = { render: function () {}, showToast: function () {}, download: function (name, text, type) { downloads.push([name, text, type]); } };
  assert.equal(card.handleAction(state, "deseq-export-interactions", { dataset: {} }, api), true);
  assert.equal(downloads[0][0], "rnaxray-differential-interactions.tsv");
  assert.equal(downloads[0][1], D.interactionsToTsv(result.interactions));
  card.handleAction(state, "deseq-use-arcmap", { dataset: {} }, api);
  same(state.arcMap.interactions.rows, arc.parseInteractions(D.interactionsToTsv(result.interactions)).rows, "arc map rows = parseInteractions of interactions.tsv");
  assert.equal(state.arcMap.labelOne, "ZAFR");
  assert.equal(state.arcMap.labelTwo, "ZILM");
  assert.equal(arc.build(state.arcMap).ready, true);
  const params = card.parameters(state.comparison);
  assert.equal(params.result.current, true);
  assert.equal(params.parameters.mergeRange, 100);
  state.comparison.deseq.minCount = "5";
  assert.equal(card.parameters(state.comparison).result.current, false, "changed inputs mark the result stale");
  assert.match(card.renderCard(state), /changed after this result/);
  const helpers = { escape: function (v) { return String(v); }, formatNumber: function (v) { return String(v); },
    table: function (h, rows) { return "<table>" + rows.length + "</table>"; }, definitionList: function (e) { return "<dl>" + e.length + "</dl>"; },
    visualBlock: function (svg) { return svg; } };
  assert.match(card.reportSection(state.comparison, helpers), /Differential test \(DESeq2 Wald test\)/);
  assert.equal(card.reportData(state.comparison).result.summary.cellsTested, result.summary.cellsTested);

  // empty or non-numeric fields are rejected, not read as 0
  state.comparison.deseq.minCount = "";
  assert.match(card.renderCard(state), /Min count must be a non-negative integer/);
  state.comparison.deseq.minCount = "2";
  state.comparison.deseq.radius = " ";
  assert.match(card.renderCard(state), /Merge range must be/);
  state.comparison.deseq.radius = "100";
  state.comparison.deseq.padjCutoff = "abc";
  assert.match(card.renderCard(state), /padj cutoff must be/);
  state.comparison.deseq.padjCutoff = "0.05";

  // run() without Worker: arms read through api.getArms, test on a timer
  const armsTable = function (arms, rna) {
    const n = arms.length / 4;
    const t = { index: [], rnaOne: [], rnaTwo: [], oneStart: [], oneEnd: [], twoStart: [], twoEnd: [] };
    for (let i = 0; i < n; i += 1) {
      t.index.push(i); t.rnaOne.push(rna); t.rnaTwo.push(rna);
      t.oneStart.push(arms[4 * i]); t.oneEnd.push(arms[4 * i + 1]); t.twoStart.push(arms[4 * i + 2]); t.twoEnd.push(arms[4 * i + 3]);
    }
    return t;
  };
  const armsById = { ZAFR_REP1: armsOf(1, 0.2), ZAFR_REP2: armsOf(2, 0.2), ZILM_REP2: armsOf(3, 0), ZILM_REP3: armsOf(4, 0) };
  const runApi = function (empty) {
    return { render: function () {}, showToast: function (message) { throw new Error("unexpected toast " + message); },
      getArms: function (selection, pair) {
        const id = selection.datasetIds[0];
        return Promise.resolve(armsTable(id === empty ? new Int32Array(0) : armsById[id], pair.rna));
      } };
  };
  const settle = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
  const deseqState = state.comparison.deseq;
  // a dataset without records for the pair: a clear error, no result
  deseqState.result = null;
  card.run(state, runApi("ZILM_REP3"));
  await settle(50);
  assert.equal(deseqState.status, "error");
  assert.match(deseqState.error, /ZILM_REP3 has no .* records.*size factors cannot be computed/);
  assert.equal(deseqState.result, null);
  // stop() abandons a run: the late timer does not store a result
  card.run(state, runApi(null));
  await settle(0);
  card.stop();
  await settle(150);
  assert.equal(deseqState.result, null, "a stopped run does not store its result");
  // an uninterrupted run stores one
  card.run(state, runApi(null));
  for (let wait = 0; wait < 100 && deseqState.status === "running"; wait += 1) {
    await settle(50);
  }
  assert.equal(deseqState.status, "done", deseqState.error);
  assert.ok(deseqState.result.summary.interactionsUp >= 1);

  // split tasks give the same numbers as one task
  {
    const raw = synth(5, 5000, [1, 1.2, 0.8, 1.1], [1, 1, 0, 0]);
    const task = { kind: "fitDisp", rows: 5000, args: { y: raw, mu: Float64Array.from(raw, function (v) { return Math.max(v, 0.5); }), m: 4, group: Int32Array.from([0, 0, 1, 1]),
      logAlpha0: new Float64Array(5000).fill(-1), priorMean: null, priorVar: 1, usePrior: false, minLogAlpha: Math.log(1e-9) } };
    const whole = D.runTask(task);
    const parts = D.splitTask(task, 3).map(function (part) { return D.runTask(part); });
    same(Array.from(D.mergeTask(task, parts).logAlpha), Array.from(whole.logAlpha));
    assert.equal(D.splitTask(task, 3).length, 3);
    // the async driver with tasks split as over helper workers = the sync result
    const cellsOf = function (seed) {
      const t = synth(seed, 3000, [1, 1, 1, 1], [1, 1, 0, 0]);
      const x = [];
      const y = [];
      const count = [];
      for (let i = 0; i < 3000; i += 1) { x.push(10 * (i % 60)); y.push(10 * Math.floor(i / 60)); count.push(t[i * 4]); }
      return { name: "s" + seed, cells: D.cellsFromColumns(x, y, count, 10) };
    };
    const samples = [cellsOf(31), cellsOf(32), cellsOf(33), cellsOf(34)];
    const sync = D.compare(samples, [true, true, false, false], { padjCutoff: 0.5 });
    let split = 0;
    const asyncResult = await D.compareAsync(samples, [true, true, false, false], { padjCutoff: 0.5 }, function (t) {
      const parts = D.splitTask(t, 3);
      split += parts.length;
      return Promise.resolve(D.mergeTask(t, parts.map(function (part) { return D.runTask(part); })));
    });
    assert.ok(split > 3, "the three row-parallel tasks were split");
    assert.equal(D.interactionsToTsv(asyncResult.interactions), D.interactionsToTsv(sync.interactions));
    same(Array.from(asyncResult.significant.padj), Array.from(sync.significant.padj));
  }
}

workerAndCard().then(function () {
  console.log("verify-deseq: worker and Compare card checks passed");
  realChecks();
}).catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

function realChecks() {

// ---- real ZIKV comparison
const realDir = process.env.RNAXRAY_DESEQ_REAL;
if (realDir) {
  const names = fs.readdirSync(realDir);
  const pick = function (prefix) {
    const file = names.find(function (name) { return name.startsWith(prefix) && name.endsWith(".contact.txt"); });
    assert.ok(file, "no " + prefix + "*.contact.txt in " + realDir);
    return path.join(realDir, file);
  };
  const files = ["ZAFR_REP1", "ZAFR_REP2", "ZILM_REP2", "ZILM_REP3"].map(pick);
  const started = Date.now();
  let peak = 0;
  const sample = function () { peak = Math.max(peak, process.memoryUsage().rss); };
  const samples = files.map(function (file) {
    return { name: path.basename(file).split(".")[0], cells: D.parseContactText(fs.readFileSync(file, "utf8"), 10) };
  });
  const parsedMs = Date.now() - started;
  const out = D.compare(samples, [true, true, false, false], { minCount: 2, radius: 100, padjCutoff: 0.05, keepAll: true, progress: sample });
  sample();
  const s = out.summary;
  console.log("real: parse " + parsedMs + " ms, test " + s.timings.totalMs + " ms (" + JSON.stringify(s.timings.stagesMs) + "), peak RSS " + Math.round(peak / 1048576) + " MB");
  assert.equal(s.cellsTested, 1038539);
  assert.equal(s.significant, 83023);
  assert.equal(s.significantUp, 20660);
  assert.equal(s.significantDown, 62363);
  assert.equal(s.interactionsUp, 668);
  assert.equal(s.interactionsDown, 1725);
  const strict = out.interactions.filter(function (row) { return row.padj < 0.01; });
  assert.equal(strict.filter(function (row) { return row.direction === "up"; }).length, 378);
  assert.equal(strict.filter(function (row) { return row.direction === "down"; }).length, 1243);
  [1.0299, 1.6076, 0.8491, 0.8093].forEach(function (value, j) { close(s.sizeFactors[j], value, 1e-4, "size factor " + j); });
  const topUp = out.interactions.find(function (row) { return row.direction === "up"; });
  const topDown = out.interactions.find(function (row) { return row.direction === "down"; });
  same([topUp.x, topUp.y], [1920, 4870]);
  close(topUp.log2FoldChange, 6.90072006577511, 1e-6, "top up log2FoldChange");
  close(topUp.padj, 7.037690078557971e-09, 1e-3, "top up padj vs R");
  same([topDown.x, topDown.y], [5720, 3890]);
  close(topDown.padj, 5.223393802199e-12, 1e-3, "top down padj vs R");

  // R rnaxray_compare outputs, when present
  const rFile = function (suffix) {
    const file = names.find(function (name) { return name.endsWith(suffix); });
    return file ? path.join(realDir, file) : null;
  };
  const readTable = function (file) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const header = lines.shift().split("\t");
    return lines.map(function (line) {
      const parts = line.split("\t");
      const row = {};
      header.forEach(function (name, k) { row[name] = Number(parts[k]); });
      return row;
    });
  };
  // R's merge visits tied padj values in its own order, the ports in table
  // order; a cell R kept may therefore be replaced by an exactly tied
  // neighbour within the merge range.
  const compareRows = function (label, expectedRows, actualRows, radius) {
    const byCell = new Map(actualRows.map(function (row) { return [row.x + "_" + row.y, row]; }));
    assert.equal(actualRows.length, expectedRows.length, label + " row count");
    let lfc = 0;
    let padj = 0;
    let tieSwaps = 0;
    expectedRows.forEach(function (row) {
      let mine = byCell.get(row.x + "_" + row.y);
      if (!mine && radius) {
        mine = actualRows.find(function (other) {
          return !expectedRows.some(function (r) { return r.x === other.x && r.y === other.y; }) &&
            Math.abs(other.x - row.x) <= radius && Math.abs(other.y - row.y) <= radius &&
            Math.abs(other.padj - row.padj) <= 1e-3 * row.padj && Math.abs(other.log2FoldChange - row.log2FoldChange) <= 1e-6 * Math.abs(row.log2FoldChange);
        });
        if (mine) {
          tieSwaps += 1;
        }
      }
      assert.ok(mine, label + ": cell " + row.x + "," + row.y + " missing");
      lfc = Math.max(lfc, Math.abs(mine.log2FoldChange - row.log2FoldChange) / Math.abs(row.log2FoldChange));
      padj = Math.max(padj, Math.abs(mine.padj - row.padj) / row.padj);
    });
    console.log("real vs R " + label + ": " + (expectedRows.length - tieSwaps) + " of " + expectedRows.length + " cells identical" +
      (tieSwaps ? " (" + tieSwaps + " replaced by an exactly tied neighbour, merge order of ties)" : "") +
      "; max rel diff log2FC " + lfc.toExponential(2) + ", padj " + padj.toExponential(2));
    assert.ok(lfc < 1e-4 && padj < 1e-2, label + " differs from R beyond its 4-6 printed digits and DESeq2's own tolerances");
  };
  const pos = rFile("_100range_pos_enrichment.txt");
  const neg = rFile("_100range_neg_enrichment.txt");
  const heat = rFile("_significant.padj_heatmap.txt");
  if (pos && neg) {
    compareRows("up interactions", readTable(pos), out.interactions.filter(function (row) { return row.direction === "up"; }), 100);
    compareRows("down interactions", readTable(neg), out.interactions.filter(function (row) { return row.direction === "down"; }), 100);
  }
  if (heat) {
    const sig = out.significant;
    const rows = [];
    for (let i = 0; i < sig.x.length; i += 1) {
      rows.push({ x: sig.x[i], y: sig.y[i], log2FoldChange: sig.log2FoldChange[i], padj: sig.padj[i] });
    }
    compareRows("significant cells", readTable(heat), rows);
  }

  // the numpy port, every tested cell
  const numpyResults = process.env.RNAXRAY_DESEQ_NUMPY;
  if (numpyResults) {
    const lines = fs.readFileSync(numpyResults, "utf8").split("\n");
    const header = lines[0].split("\t");
    const col = function (name) { return header.indexOf(name); };
    const byCell = new Map();
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]) {
        const parts = lines[i].split("\t");
        byCell.set(parts[0] + "_" + parts[1], parts);
      }
    }
    const all = out.all;
    assert.equal(byCell.size, all.x.length, "numpy port tested cells");
    const worst = {};
    ["baseMean", "log2FoldChange", "lfcSE", "pvalue", "padj"].forEach(function (name) { worst[name] = { abs: 0, rel: 0 }; });
    for (let i = 0; i < all.x.length; i += 1) {
      const parts = byCell.get(all.x[i] + "_" + all.y[i]);
      assert.ok(parts, "cell " + all.x[i] + "," + all.y[i] + " not tested by the numpy port");
      Object.keys(worst).forEach(function (name) {
        const text = parts[col(name)];
        const expected = text === "NA" ? NaN : Number(text);
        const actual = all.result[name][i];
        assert.equal(Number.isNaN(actual), Number.isNaN(expected), name + " NA mismatch at " + all.x[i] + "," + all.y[i]);
        if (!Number.isNaN(expected)) {
          const d = Math.abs(actual - expected);
          worst[name].abs = Math.max(worst[name].abs, d);
          worst[name].rel = Math.max(worst[name].rel, d / Math.max(Math.abs(expected), 1e-300));
        }
      });
    }
    console.log("real vs numpy port, " + all.x.length + " cells: " + Object.keys(worst).map(function (name) {
      return name + " max abs " + worst[name].abs.toExponential(2) + " rel " + worst[name].rel.toExponential(2);
    }).join("; "));
    assert.ok(worst.log2FoldChange.rel < 1e-6, "log2FoldChange vs numpy");
    assert.ok(worst.padj.rel < 1e-6, "padj vs numpy");
  }
  console.log("verify-deseq: real ZIKV comparison passed");
}
}

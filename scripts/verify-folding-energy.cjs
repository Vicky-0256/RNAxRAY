#!/usr/bin/env node
// Checks web/folding-energy.js (folding energy, panels F and G): the t
// distribution and paired t-test against R, quantiles / bandwidth as R,
// fragment jobs (as folding_energy.py) with B moved by alignment, and the
// SVG / TSV.  When the ViennaRNA WebAssembly build is present in
// web/vendor/viennarna it also folds with it, through the same helper the
// browser worker uses.
// With RNAXRAY_PANELS_REAL=<dir> it folds every padj < 0.01 interaction of
// interactions.tsv with ZAFR.dbn / ZILM.dbn (2 x 40 nt) and compares dG,
// n and the paired t-test with AFR_vs_ILM.tsv (folding_energy.py, RNAcofold
// CLI) and R's t.test on it (Rscript on PATH, else the values recorded below).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const childProcess = require("node:child_process");

const repository = path.resolve(__dirname, "..");
const context = vm.createContext({ Number, String, Boolean, Object, Array, Math, RegExp, Set, Map, Int32Array, Uint8Array, Float64Array, Error, Infinity, NaN, window: {} });
["arc-map.js", "region-panels.js", "folding-energy.js"].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(repository, "web", file), "utf8"), context, { filename: file });
});
const arc = context.window.RNAxRayArcMap;
const rp = context.window.RNAxRayRegionPanels;
const fe = context.window.RNAxRayFoldingEnergy;

function close(actual, expected, relative, message) {
  assert.ok(Math.abs(actual - expected) <= relative * Math.abs(expected), (message || "") + ": " + actual + " vs " + expected);
}

function signif3(value) {
  return Number(value.toPrecision(3));
}

// ---- t distribution and t-test (reference values from R 4)
close(fe.tCdf(2, 5), 0.949030260585071, 1e-12, "pt(2, 5)");
close(fe.tTwoSided(2, 5), 0.101939478829858, 1e-12, "2 pt(-2, 5)");
close(fe.tCdf(-3.5, 12), 2.19093471587407e-03, 1e-11, "pt(-3.5, 12)");
close(fe.tTwoSided(8, 1500), 2.46718679784775e-15, 1e-9, "2 pt(-8, 1500)");
close(fe.tTwoSided(0.3, 3), 0.783763292039919, 1e-12, "2 pt(-0.3, 3)");
close(fe.tCdf(1.5, 0.5), 0.746049104675946, 1e-11, "pt(1.5, 0.5)");
close(fe.tTwoSided(14.21625217, 374), 5.678009157e-37, 1e-6, "tiny p");
close(fe.tTwoSided(19.38840641, 1240), 2.362718652e-73, 1e-6, "tinier p");
close(Math.exp(fe.logGamma(10)), 362880, 1e-12, "gamma(10)");
{
  const a = [-10.2, -8.1, -12.5, -9.9, -11, -7.4];
  const b = [-9.1, -8.8, -11.0, -9.0, -10.2, -6.0];
  const t = fe.pairedTTest(a, b);
  close(t.t, -2.5542138420129743, 1e-12, "paired t");
  close(t.p, 0.0510040188618165, 1e-10, "paired p");
  assert.equal(t.df, 5);
  close(fe.bandwidth(a), 1.05606336978541, 1e-12, "bw.nrd0");
  const sorted = a.slice().sort(function (x, y) { return x - y; });
  close(fe.quantile(sorted, 0.25), -10.8, 1e-12, "q1");
  close(fe.quantile(sorted, 0.5), -10.05, 1e-12, "median");
  close(fe.quantile(sorted, 0.75), -8.55, 1e-12, "q3");
  const d = fe.density(a, 512);
  // the density integrates to ~1 over min - 3 bw .. max + 3 bw
  let area = 0;
  for (let i = 1; i < d.x.length; i += 1) { area += (d.x[i] - d.x[i - 1]) * (d.y[i] + d.y[i - 1]) / 2; }
  close(area, 0.997, 0.005, "density area");
  // constant differences: R stops ("data are essentially constant"); NA here
  const flat = fe.pairedTTest([1, 2, 3, 4], [0, 1, 2, 3]);
  assert.ok(Number.isNaN(flat.t) && Number.isNaN(flat.p), "constant differences give NA");
  assert.equal(flat.note, "differences are constant");
  const zero = fe.pairedTTest([1, 2, 3], [1, 2, 3]);
  assert.ok(Number.isNaN(zero.p), "all-zero differences give NA");
  assert.equal(zero.note, undefined, "R gives NaN without stopping when the differences are all zero");
  assert.equal(fe.pairedTTest(a, b).note, undefined);
  const box = fe.boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 50]);
  assert.equal(box.outliers.length, 1);
  assert.equal(box.high, 9);
}

// ---- fragments and jobs
assert.equal(fe.fragment("ACGUACGUAC", 5, 4), "GUAC", "centre 5 (1-based) of 4 nt starts at 3 (0-based centre 4 - 2)");
assert.equal(fe.fragment("ACGUACGUAC", 2, 4), null, "off the 5' end");
assert.equal(fe.fragment("ACGUACGUAC", 9, 4), "GUAC");
assert.equal(fe.fragment("ACGUACGUAC", 10, 4), null, "off the 3' end");

function randomRNA(seed, n) {
  let x = seed;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += "ACGU"[(x >>> 16) % 4];
  }
  return out;
}

const seqA = randomRNA(11, 1500);
// B: 3 nt deleted at A 401-403, a mismatch at A 1000
let seqB = seqA.slice(0, 400) + seqA.slice(403);
seqB = seqB.slice(0, 996) + (seqB[996] === "A" ? "C" : "A") + seqB.slice(997);
const state = arc.defaultState();
state.a = arc.parseStructure(">A\n" + seqA + "\n" + ".".repeat(1500) + "\n", "A.dbn");
state.b = arc.parseStructure(">B\n" + seqB + "\n" + ".".repeat(1497) + "\n", "B.dbn");
state.twoOn = "a";
state.labelOne = "L1";
state.labelTwo = "L2";
state.interactions = arc.parseInteractions(["x\ty\tlog2FoldChange\tpadj",
  "100\t990\t3\t0.001", "500\t1200\t2\t0.005", "10\t700\t2\t0.001", "600\t900\t-2\t0.0001", "300\t1100\t-3\t0.002", "800\t1480\t-1\t0.001",
  "200\t250\t-1\t0.5", "120\t130\t-4\t0.004"].join("\n"), "i.tsv");
{
  const plan = fe.buildJobs(state, rp.defaultState(), fe.defaultState());
  assert.equal(plan.ready, true, plan.reason);
  assert.equal(plan.considered, 7);
  assert.equal(plan.skipped, 2, "10 and 1480 run off an end");
  assert.equal(plan.jobs.length, 5);
  assert.equal(plan.jobs[0].side, "enriched_in_one");
  assert.equal(plan.jobs[2].side, "enriched_in_two");
  const j = plan.jobs[0];
  assert.equal(j.one[0], seqA.slice(105 - 1 - 20, 105 - 1 + 20));
  assert.equal(j.one[1], seqA.slice(995 - 1 - 20, 995 - 1 + 20));
  assert.equal(j.two[0], j.one[0], "before the deletion");
  assert.equal(j.two[1], seqB.slice(992 - 1 - 20, 992 - 1 + 20), "after the deletion: A 995 -> B 992");
  assert.notEqual(j.two[1], j.one[1], "the mismatch at A 1000 is inside");
  const shorter = fe.buildJobs(state, rp.defaultState(), Object.assign(fe.defaultState(), { length: "20", padj: "0.003" }));
  assert.equal(shorter.jobs.length, 5, "20 nt fragments fit at 15 and 1485");
  assert.equal(shorter.jobs[0].one[0].length, 20);
  // a base facing a gap maps to the B base after the previous aligned one
  const map = arc.align(seqA, seqB);
  const gapped = [];
  for (let p = 390; p <= 415; p += 1) {
    if (arc.mapPosition(map, p) === 0) { gapped.push(p); }
  }
  assert.equal(gapped.length, 3, "three A bases face the deletion");
  gapped.forEach(function (p) {
    let q = p - 1;
    while (arc.mapPosition(map, q) === 0) { q -= 1; }
    assert.equal(fe.forward(map, p, seqB.length), arc.mapPosition(map, q) + 1, "gap at " + p);
  });
  assert.equal(fe.forward(map, 500, seqB.length), 497, "aligned base");
  // the stale key follows every base, not only the first 50 nt
  const mutated = Object.assign({}, state, { a: arc.parseStructure(">A\n" + seqA.slice(0, 700) + (seqA[700] === "A" ? "C" : "A") + seqA.slice(701) + "\n" + ".".repeat(1500) + "\n", "A.dbn") });
  assert.notEqual(fe.buildJobs(mutated, rp.defaultState(), fe.defaultState()).key, plan.key, "a base in the middle changes the key");
  const repadj = Object.assign({}, state, { interactions: arc.parseInteractions(["x\ty\tlog2FoldChange\tpadj",
    "100\t990\t3\t0.002", "500\t1200\t2\t0.005", "10\t700\t2\t0.001", "600\t900\t-2\t0.0001", "300\t1100\t-3\t0.002", "800\t1480\t-1\t0.001",
    "200\t250\t-1\t0.5", "120\t130\t-4\t0.004"].join("\n"), "i.tsv") });
  assert.notEqual(fe.buildJobs(repadj, rp.defaultState(), fe.defaultState()).key, plan.key, "a padj changes the key");
  assert.equal(fe.buildJobs(state, rp.defaultState(), fe.defaultState()).key, plan.key, "the key is stable");
  // cells on B that cannot be placed on A are counted apart from fragments off an end
  const onB = Object.assign({}, state, { twoOn: "b", interactions: arc.parseInteractions(["x\ty\tlog2FoldChange\tpadj",
    "600\t900\t-2\t0.0001", "100\t1505\t-2\t0.001"].join("\n"), "i.tsv") });
  const placed = fe.buildJobs(onB, rp.defaultState(), fe.defaultState());
  assert.equal(placed.jobs.length, 1);
  assert.equal(placed.unplaced, 1, "B 1510 is past every aligned base");
  assert.equal(placed.skipped, 0);
  assert.match(fe.renderCard(onB, rp.defaultState(), fe.defaultState()), /1 skipped \(could not be placed on A by alignment\)/);
  // no sequences
  const bare = arc.defaultState();
  bare.interactions = state.interactions;
  assert.equal(fe.buildJobs(bare, rp.defaultState(), fe.defaultState()).ready, false);
  // ... unless FASTA references are given
  const withFasta = Object.assign(rp.defaultState(), { fastaA: rp.parseFasta(">a\n" + seqA), fastaB: rp.parseFasta(">b\n" + seqB) });
  assert.equal(fe.buildJobs(bare, withFasta, fe.defaultState()).jobs.length, 5);
  // card before folding
  const html = fe.renderCard(state, rp.defaultState(), fe.defaultState());
  assert.match(html, /F, G · Folding energy/);
  assert.match(html, /data-feature-action="energy-run"/);
  assert.match(html, /7 interactions with padj &lt; 0\.01; 5 to fold \(10 RNAcofold runs\); 2 skipped/);
  // results, stats, SVG, TSV (synthetic energies)
  const big = [];
  for (let k = 0; k < 40; k += 1) {
    big.push({ side: k % 3 ? "enriched_in_two" : "enriched_in_one", x: k * 10, y: 1000 + k, log2FoldChange: 1, padj: 0.001 });
  }
  const energies = [];
  big.forEach(function (row, k) { energies.push(-10 - (k % 7), -9 - (k % 5)); });
  const rows = fe.attach(big, energies);
  const results = { rows: rows, length: 40, cutoff: 0.01, key: "k", version: "2.7.2" };
  const stats = fe.summarise(rows);
  assert.equal(stats[0].n + stats[1].n, 40);
  const one = rows.filter(function (r) { return r.side === "enriched_in_one"; });
  const check = fe.pairedTTest(one.map(function (r) { return r.dG_one; }), one.map(function (r) { return r.dG_two; }));
  assert.equal(stats[0].p, check.p);
  const tsv = fe.toTsv(results);
  assert.match(tsv, /^length\tside\tx\ty\tlog2FoldChange\tpadj\tdG_one\tdG_two\n40\tenriched_in_one\t0\t1000\t1\t0\.001\t-10\t-9\n/);
  assert.match(fe.statsTsv(results, { one: "L1", two: "L2" }), /L1 vs L2\t40\tL1\t14\t/);
  const svg = fe.svg(results, { one: "L1", two: "L2" });
  assert.match(svg, /^<svg[^>]+xmlns/);
  assert.match(svg, /L1-enriched \(L1 vs L2\), n=14/);
  assert.match(svg, /L2-enriched \(L1 vs L2\), n=26/);
  assert.match(svg, /paired t-test p = /);
  const done = fe.renderCard(state, rp.defaultState(), Object.assign(fe.defaultState(), { results: results }));
  assert.match(done, /data-energy-figure/);
  assert.match(done, /Inputs or settings changed/);
  // panel letters follow the side, not the position among non-empty panels
  const twoOnly = { rows: rows.filter(function (r) { return r.side === "enriched_in_two"; }), length: 40 };
  const twoSvg = fe.svg(twoOnly, { one: "L1", two: "L2" });
  assert.match(twoSvg, /font-weight="700"[^>]*>G<\/text>/);
  assert.doesNotMatch(twoSvg, />F<\/text>/);
  // non-finite values are NA in the table, the SVG and both TSVs
  const flatRows = [0, 1, 2].map(function (k) { return { side: "enriched_in_one", x: k, y: 100 + k, log2FoldChange: 1, padj: 0.001, dG_one: -10 - k, dG_two: -9 - k }; });
  flatRows.push({ side: "enriched_in_two", x: 5, y: 105, log2FoldChange: -1, padj: 0.001, dG_one: NaN, dG_two: -9 });
  const flatResults = { rows: flatRows, length: 40, cutoff: 0.01, key: "k", version: "2.7.2" };
  const flatCard = fe.renderCard(state, rp.defaultState(), Object.assign(fe.defaultState(), { results: flatResults }));
  assert.doesNotMatch(flatCard.split("data-energy-figure")[0], /NaN|Infinity/, "table");
  assert.match(flatCard, /the differences are constant/);
  assert.match(fe.svg(flatResults, { one: "L1", two: "L2" }), /p = NA \(differences are constant\)/);
  assert.doesNotMatch(fe.statsTsv(flatResults, { one: "L1", two: "L2" }), /NaN|Infinity/);
  assert.match(fe.toTsv(flatResults), /\tNA\t-9\n$/);
}

// ---- stop (exported for app.js): terminates the worker, tolerates no state
{
  const st = Object.assign(fe.defaultState(), { running: true });
  fe.stop(st);
  assert.equal(st.running, false);
  fe.stop(undefined);
}

// ---- cofold memory: every allocated pointer is freed, failed allocations are reported
{
  const fakeModule = function (failAt) {
    const m = { calls: 0, freed: [], lengthBytesUTF8: function (v) { return v.length; }, stringToUTF8: function () {},
      _malloc: function () { m.calls += 1; return m.calls === failAt ? 0 : 100 * m.calls; },
      _free: function (p) { m.freed.push(p); },
      _rnaxray_vienna_cofold: function () { return -3.456; } };
    return m;
  };
  const ok = fakeModule(0);
  assert.equal(fe.cofold(ok, "GGG", "CCC"), -3.46);
  assert.deepEqual(ok.freed.slice().sort(), [100, 200, 300]);
  [1, 2, 3].forEach(function (failAt) {
    const m = fakeModule(failAt);
    assert.throws(function () { fe.cofold(m, "GGG", "CCC"); }, /could not allocate memory/);
    assert.equal(m.freed.length, failAt - 1, "frees the " + (failAt - 1) + " earlier allocations");
    assert.ok(m.freed.indexOf(0) < 0, "never frees a null pointer");
  });
}

// ---- ViennaRNA WebAssembly (when built)
const entry = path.join(repository, "web", "vendor", "viennarna", "vienna-rna.js");

async function loadVienna() {
  const create = require(entry);
  return create({ locateFile: function (file) { return path.join(path.dirname(entry), file); }, print: function () {}, printErr: function () {} });
}

function rValues(file) {
  const script = 'd <- read.delim("' + file.replace(/\\/g, "/") + '"); for (s in c("enriched_in_one", "enriched_in_two")) { x <- d[d$length == 40 & d$side == s, ]; ' +
    'tt <- t.test(x$dG_one, x$dG_two, paired = TRUE); cat(s, nrow(x), sprintf("%.12g", tt$statistic), sprintf("%.12g", tt$p.value), "\\n") }';
  try {
    const out = childProcess.execFileSync("Rscript", ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const values = {};
    out.trim().split("\n").forEach(function (line) {
      const p = line.trim().split(/\s+/);
      values[p[0]] = { n: Number(p[1]), t: Number(p[2]), p: Number(p[3]) };
    });
    return { source: "Rscript", values: values };
  } catch (error) {
    // R 4 t.test on reproduce_zikv/analysis/folding_energy/AFR_vs_ILM.tsv, length 40
    return { source: "recorded", values: {
      enriched_in_one: { n: 375, t: -14.21625217, p: 5.678009157e-37 },
      enriched_in_two: { n: 1241, t: 19.38840641, p: 2.362718652e-73 }
    } };
  }
}

async function main() {
  if (!fs.existsSync(entry)) {
    process.stdout.write("folding-energy: ViennaRNA WebAssembly not built; folding checks skipped\n");
  } else {
    const vienna = await loadVienna();
    const version = vienna.UTF8ToString(vienna._rnaxray_vienna_version());
    // a duplex folds to a negative energy, rounded to 2 decimals as the CLI prints
    const duplex = fe.cofold(vienna, "GGGAAACCCGGG", "CCCGGGUUUCCC");
    assert.ok(duplex < 0 && Math.round(duplex * 100) === duplex * 100, "rounded duplex energy " + duplex);
    const plan = fe.buildJobs(state, rp.defaultState(), fe.defaultState());
    const energies = [];
    plan.jobs.forEach(function (job) { energies.push(fe.cofold(vienna, job.one[0], job.one[1]), fe.cofold(vienna, job.two[0], job.two[1])); });
    energies.forEach(function (e) { assert.ok(Number.isFinite(e) && e <= 0); });
    process.stdout.write("folding-energy: ViennaRNA " + version + " WebAssembly folds in node\n");

    const real = process.env.RNAXRAY_PANELS_REAL;
    if (real) {
      const read = function (name) { return fs.readFileSync(path.join(real, name), "utf8"); };
      // the UI's state: the arc map's defaults with the three files loaded, the
      // cell references (oneOn / twoOn) left as the card starts
      const s = arc.defaultState();
      s.a = arc.parseStructure(read("ZAFR.dbn"), "ZAFR.dbn");
      s.b = arc.parseStructure(read("ZILM.dbn"), "ZILM.dbn");
      s.interactions = arc.parseInteractions(read("interactions.tsv"), "interactions.tsv");
      s.labelOne = "ZAFR";
      s.labelTwo = "ZASI";
      if (s.twoOn !== "a") {
        // default after fix/review-arc (rnaxray_compare cells are all on A's reference)
        process.stdout.write("real: arc map default twoOn is \"" + s.twoOn + "\"; using \"a\" (default after fix/review-arc)\n");
        s.twoOn = "a";
      }
      const started = Date.now();
      const realPlan = fe.buildJobs(s, rp.defaultState(), fe.defaultState());
      const dG = [];
      realPlan.jobs.forEach(function (job) { dG.push(fe.cofold(vienna, job.one[0], job.one[1]), fe.cofold(vienna, job.two[0], job.two[1])); });
      const rows = fe.attach(realPlan.jobs, dG);
      process.stdout.write("real: " + realPlan.considered + " interactions with padj < 0.01, " + rows.length + " folded (" + realPlan.skipped + " off an end, " + realPlan.unplaced + " not placed) in " +
        (Date.now() - started) + " ms\n");
      // expected: folding_energy.py (RNAcofold CLI) on the rnaxray_compare tables
      const expected = new Map();
      read("AFR_vs_ILM.tsv").trim().split("\n").slice(1).forEach(function (line) {
        const p = line.split("\t");
        if (p[0] === "40") {
          expected.set(p[1] + ":" + p[2] + ":" + p[3], { dG_one: Number(p[6]), dG_two: Number(p[7]) });
        }
      });
      let compared = 0;
      let mismatches = 0;
      rows.forEach(function (row) {
        const e = expected.get(row.side + ":" + row.x + ":" + row.y);
        if (!e) {
          return;
        }
        compared += 1;
        if (e.dG_one !== row.dG_one || e.dG_two !== row.dG_two) {
          mismatches += 1;
          if (mismatches <= 5) {
            process.stdout.write("  mismatch " + row.side + " " + row.x + " " + row.y + ": " + row.dG_one + "/" + row.dG_two + " vs " + e.dG_one + "/" + e.dG_two + "\n");
          }
        }
      });
      const onlyHere = rows.length - compared;
      process.stdout.write("  dG compared with the CLI for " + compared + " interactions: " + mismatches + " mismatches; " + onlyHere +
        " here only, " + (expected.size - compared) + " there only\n");
      assert.equal(mismatches, 0, "dG must equal RNAcofold CLI values");
      assert.ok(compared >= 1600, "most interactions are shared");
      // the CLI table itself, through our t-test, against R
      const r = rValues(path.join(real, "AFR_vs_ILM.tsv"));
      const cli = [];
      expected.forEach(function (value, key) { cli.push({ side: key.split(":")[0], dG_one: value.dG_one, dG_two: value.dG_two }); });
      const ours = fe.summarise(cli);
      ours.forEach(function (st) {
        const ref = r.values[st.side];
        assert.equal(st.n, ref.n, st.side + " n");
        assert.equal(signif3(st.t), signif3(ref.t), st.side + " t");
        assert.equal(signif3(st.p), signif3(ref.p), st.side + " p");
        process.stdout.write("  " + st.side + ": n " + st.n + ", t " + st.t.toFixed(4) + ", p " + st.p.toPrecision(4) + " (R, " + r.source + ": " + ref.p.toPrecision(4) + ")\n");
      });
      // and on the browser's own interactions
      fe.summarise(rows).forEach(function (st) {
        const ref = r.values[st.side];
        assert.equal(st.n, ref.n, "browser " + st.side + " n");
        assert.equal(signif3(st.p), signif3(ref.p), "browser " + st.side + " p");
        process.stdout.write("  browser rows " + st.side + ": n " + st.n + ", mean " + st.meanOne.toFixed(3) + " vs " + st.meanTwo.toFixed(3) + ", p " + st.p.toPrecision(4) + "\n");
      });
      fs.writeFileSync(path.join(real, "folding-energy.svg"), fe.svg({ rows: rows, length: 40 }, { one: "ZAFR", two: "ZASI" }));
      fs.writeFileSync(path.join(real, "folding-energy.node.tsv"), fe.toTsv({ rows: rows, length: 40 }));
    }
  }
  process.stdout.write("folding-energy: ok\n");
}

main().catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exit(1);
});

#!/usr/bin/env node
// Checks web/ui-kit.js (WEB_UI_FIX_PLAN.md K1, K2, K5, K9): niceTicks gives 4-7
// ticks on 1/2/5 x 10^n with both ends; the legend renders as HTML, SVG and on
// a canvas with its title, ticks and end labels; the export menu closes; the
// RNAxRay Desktop facts (K9) match the release workflow and the desktop runtime.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const web = function (file) { return path.join(__dirname, "..", "web", file); };
const context = vm.createContext({ Number, Math, String, Array, Object, JSON, setTimeout, window: {} });
context.window.window = context.window;
vm.runInContext(fs.readFileSync(web("ui-kit.js"), "utf8"), context, { filename: "ui-kit.js" });
const kit = context.window.RNAxRayUiKit;

// ---- K5
const nice = function (step) {
  const m = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
  return [1, 2, 5, 10].some(function (k) { return Math.abs(m - k) < 1e-6; });
};
[[1, 10807], [0, 45], [0, 1], [-3.2, 3.2], [1, 201], [0, 0.0031], [10, 10807], [0, 22416], [5, 6], [1, 2]].forEach(function (pair) {
  const ticks = Array.from(kit.niceTicks(pair[0], pair[1]));
  assert.equal(ticks[0], pair[0], "first tick is the minimum for " + pair);
  assert.equal(ticks[ticks.length - 1], pair[1], "last tick is the maximum for " + pair);
  assert.ok(ticks.length >= 3 && ticks.length <= 7, ticks.length + " ticks for " + pair + ": " + ticks);
  for (let i = 1; i < ticks.length; i += 1) {
    assert.ok(ticks[i] > ticks[i - 1], "increasing: " + ticks);
  }
  const inner = ticks.slice(1, -1);
  if (inner.length > 1) {
    assert.ok(nice(inner[1] - inner[0]), "interior step on 1/2/5 x 10^n: " + ticks);
  }
});
assert.ok(kit.niceTicks(1, 10807).length >= 4, "a genome axis gets at least 4 ticks");
// no interior tick within half a step of an end (labels would collide)
[[0, 11], [0, 101], [1, 10807], [0, 45], [0, 2.1], [10, 10807]].forEach(function (pair) {
  const ticks = Array.from(kit.niceTicks(pair[0], pair[1], 4));
  if (ticks.length > 3) {
    const step = ticks[2] - ticks[1];
    assert.ok(ticks[1] - ticks[0] >= step / 2 - 1e-9 && ticks[ticks.length - 1] - ticks[ticks.length - 2] > step / 2 - 1e-9, "ends spaced from interior ticks: " + ticks);
  }
});
assert.deepEqual(Array.from(kit.niceTicks(0, 11, 4)), [0, 2, 4, 6, 8, 11]);
assert.deepEqual(Array.from(kit.niceTicks(3, 3)), [3]);
assert.deepEqual(Array.from(kit.niceTicks(NaN, 3)), []);
assert.equal(kit.formatTick(10807), "10,807");
assert.equal(kit.formatTick(0.0412), "0.041");

// ---- K1
const ramp = function (t) { return "rgb(" + Math.round(255 * t) + ",0,0)"; };
const html = kit.legend.html({ kind: "sequential", colorAt: ramp, min: 0, max: 45, title: "Record count", lowLabel: "few", highLabel: "many" });
assert.match(html, /^<div class="chart-legend chart-legend--horizontal chart-legend--sequential" role="img" aria-label="Record count · 0 to 45; low: few; high: many">/);
assert.match(html, /linear-gradient\(to right, rgb\(0,0,0\) 0\.0%/);
assert.match(html, /<span class="chart-legend-tick" style="left:0\.00%">0<\/span>/);
assert.match(html, /<span class="chart-legend-tick" style="left:100\.00%">45<\/span>/);
assert.match(kit.legend.html({ title: "<b>" }), /&lt;b&gt;/, "titles are escaped");
const diverging = kit.legend.svg({ kind: "diverging", colorAt: ramp, max: 2, title: "log2 A/B", lowLabel: "B enriched", highLabel: "A enriched", x: 10, y: 20 });
assert.match(diverging, /^<g class="chart-legend" transform="translate\(10,20\)"/);
assert.match(diverging, />-2<\/text>/, "diverging defaults to min = -max");
assert.match(diverging, />B enriched<\/text>/);
const ids = [kit.legend.svg({}), kit.legend.svg({})].map(function (s) { return s.match(/linearGradient id="([^"]+)"/)[1]; });
assert.notEqual(ids[0], ids[1], "each SVG legend has its own gradient id");
const calls = [];
const ctx = new Proxy({}, {
  get: function (target, name) {
    if (name === "createLinearGradient") return function () { return { addColorStop: function () { calls.push("stop"); } }; };
    if (typeof name === "string" && /^(save|restore|translate|fillText|fillRect|strokeRect|beginPath|moveTo|lineTo|stroke)$/.test(name)) {
      return function () { calls.push(name + (name === "fillText" ? ":" + arguments[0] : "")); };
    }
    return target[name];
  },
  set: function (target, name, value) { target[name] = value; return true; }
});
kit.legend.drawCanvas(ctx, { colorAt: ramp, min: 0, max: 45, title: "Record count" });
assert.ok(calls.indexOf("fillText:Record count") >= 0 && calls.indexOf("fillText:0") >= 0 && calls.indexOf("fillText:45") >= 0, "canvas legend draws title and end ticks");
assert.equal(calls.filter(function (c) { return c === "stop"; }).length, 17, "17 colour stops");
assert.equal(calls[0], "save");
assert.equal(calls[calls.length - 1], "restore");

// ---- K2: index.html loads the kit before the pages, and the stylesheets in order
const index = fs.readFileSync(web("index.html"), "utf8");
assert.ok(index.indexOf('src="./ui-kit.js"') > 0 && index.indexOf('src="./ui-kit.js"') < index.indexOf('src="./analysis-data.js"'), "ui-kit.js before analysis-data.js");
const order = ["evidence.css", "ui-kit.css", "fix-shell.css", "fix-overview.css", "fix-explore.css", "fix-compare.css", "fix-structure.css"].map(function (name) {
  const at = index.indexOf('href="./' + name + '"');
  assert.ok(at > 0, name + " is linked");
  return at;
});
order.reduce(function (previous, at) { assert.ok(at > previous, "stylesheet order"); return at; }, 0);
const kitCss = fs.readFileSync(web("ui-kit.css"), "utf8");
assert.match(kitCss, /\.export-menu-list \{/);
assert.match(kitCss, /\.export-menu\.export-menu--start \.export-menu-list \{\s*right: auto;\s*left: 0;/, "a list that would leave the screen opens rightwards");
assert.match(kitCss, /\.cell-truncate:not\(td\):not\(th\) \{\s*display: block;/, "outside a table, .cell-truncate keeps its width");
assert.match(fs.readFileSync(web("ui-kit.js"), "utf8"), /addEventListener\("toggle"/);

// ---- K9
const desk = kit.desktop;
const releaseWorkflow = path.join(__dirname, "..", ".github", "workflows", "desktop-release.yml");
if (fs.existsSync(releaseWorkflow)) {
  const names = Array.from(fs.readFileSync(releaseWorkflow, "utf8").matchAll(/release_name:\s*(\S+)/g), function (m) { return m[1]; });
  desk.platforms.forEach(function (item) {
    assert.ok(names.some(function (name) { return item.file.indexOf(name) === 0; }), item.file + " matches a release_name");
  });
}
const detector = path.join(__dirname, "..", "desktop", "runtime", "detector.py");
if (fs.existsSync(detector)) {
  // the quoted Desktop limit follows cplfold_limits(): floor(sqrt((0.75 * 8 GiB - base) / c_free)), to 100 nt
  const py = fs.readFileSync(detector, "utf8");
  const base = /CPLFOLD_BASE_BYTES = (\d+) \* 1024 \* 1024/.exec(py);
  const perNt2 = /CPLFOLD_BYTES_PER_NT2 = \{False: ([\d.]+),/.exec(py);
  const fraction = /CPLFOLD_MEMORY_FRACTION = ([\d.]+)/.exec(py);
  assert.ok(base && perNt2 && fraction, "detector.py still has the CPLfold memory model");
  const expected = Math.floor(Math.sqrt((8 * Math.pow(1024, 3) * Number(fraction[1]) - Number(base[1]) * 1024 * 1024) / Number(perNt2[1])) / 100) * 100;
  assert.equal(desk.limits.cplfoldExampleNt, expected, "Desktop CPLfold figure follows detector.py cplfold_limits");
}
assert.equal(desk.detectPlatform("Macintosh; Intel Mac OS X 10_15_7").id, "mac-arm64");
assert.equal(desk.detectPlatform("Windows NT 10.0; Win64; x64").id, "win-x64");
assert.equal(desk.detectPlatform("X11; Linux x86_64").id, "linux-deb");
assert.equal(desk.detectPlatform("Linux; Android 14; Pixel 8"), null, "Android is not desktop Linux");
assert.equal(desk.detectPlatform("iPhone; CPU iPhone OS 17_0"), null);
assert.equal(desk.detectPlatform("Macintosh; Intel Mac OS X 10_15_7", 5), null, "iPadOS Safari reports a Mac with touch points");
assert.equal(desk.detectPlatform("Macintosh; Intel Mac OS X 10_15_7", 0).id, "mac-arm64");
// downloads are public: the latest release's files, and each release's
assert.equal(desk.downloadsAvailable, true);
assert.equal(desk.downloadUrl(desk.platforms[0]), "https://github.com/Vicky-0256/RNAxRAY/releases/latest/download/RNAxRay-Desktop-macOS-arm64.dmg");
assert.equal(desk.checksumsUrl(), "https://github.com/Vicky-0256/RNAxRAY/releases/latest/download/SHA256SUMS.txt");
assert.match(desk.cta("raw-reads"), /^<a class="desktop-cta" href="https:\/\/github\.com\/Vicky-0256\/RNAxRAY\/releases\/latest" data-action="open-desktop".*<strong>Get RNAxRay Desktop<\/strong><\/a>$/);
assert.equal(desk.releaseDownloadUrl("v0.1.4", desk.platforms[1]), "https://github.com/Vicky-0256/RNAxRAY/releases/download/v0.1.4/RNAxRay-Desktop-Windows-x64-Setup.exe");
assert.equal(desk.releases().length, 0, "no web/releases.js loaded: no versions");
context.window.RNAXRAY_RELEASES = [{ tag: "v0.2.0", published: "2026-11-01", files: ["RNAxRay-Desktop-macOS-arm64.dmg"] }, { tag: "broken" }, null];
assert.equal(desk.releases().map(function (release) { return release.tag; }).join(","), "v0.2.0", "malformed entries are left out");
delete context.window.RNAXRAY_RELEASES;
// the generated list, as committed, names only installers the release workflow builds
const releasesSource = fs.readFileSync(web("releases.js"), "utf8");
const releasesContext = { window: {} };
vm.runInNewContext(releasesSource, releasesContext);
assert.ok(releasesContext.window.RNAXRAY_RELEASES.length > 0, "web/releases.js lists the releases");
releasesContext.window.RNAXRAY_RELEASES.forEach(function (release) {
  assert.match(release.tag, /^v\d/);
  release.files.forEach(function (file) {
    assert.ok(file === desk.checksumsFile || desk.platforms.some(function (item) { return item.file === file; }), file + " is a known installer");
  });
});
// with downloads hidden, nothing may link to an installer
desk.downloadsAvailable = false;
assert.equal(desk.downloadUrl(desk.platforms[0]), "");
assert.equal(desk.checksumsUrl(), "");
assert.equal(desk.releaseDownloadUrl("v0.1.4", desk.platforms[0]), "");
["raw-reads", "long-fold", "overview"].forEach(function (name) {
  const cta = desk.cta(name);
  assert.match(cta, /^<a class="desktop-cta" href="#rnaxray-desktop" data-action="open-desktop"/, name);
  assert.match(cta, /<strong>About RNAxRay Desktop<\/strong><\/a>$/, name);
  assert.doesNotMatch(cta, /github\.com/, name);
});
assert.match(desk.cta("long-fold"), /Longer than 500 nt\? RNAxRay Desktop runs CPLfold natively with no capacity test; its limit grows with memory: about 6,500 nt with 8 GB of memory\./);
assert.equal(desk.cta("no-such-context"), "");
context.window.RNAxRayDesktop = { enabled: true };
assert.equal(desk.isInsideDesktop(), true);
assert.equal(desk.cta("raw-reads"), "", "no Desktop links inside Desktop");
delete context.window.RNAxRayDesktop;
assert.match(kitCss, /\.desktop-cta strong \{[^}]*var\(--primary-ink\)/, "the CTA link text uses --primary-ink");

process.stdout.write("ui-kit: ok\n");

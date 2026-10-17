"use strict";

// RNAxRay Desktop entries on the website (WEB_UI_FIX_PLAN.md A13-A18, K9):
// the landing comparison and download section in both release states, the
// Desktop drawer (a link click or a #rnaxray-desktop address opens it and the
// current page stays), and nothing linking to the private release page.

const assert = require("node:assert/strict");
// HTML assertions print the pattern, not the whole page
function has(html, pattern, message) { assert.ok(pattern.test(html), (message || "expected") + ": " + pattern); }
function hasNot(html, pattern, message) { assert.ok(!pattern.test(html), (message || "unexpected") + ": " + pattern); }
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repository = path.resolve(__dirname, "..");
const web = function (file) { return path.join(repository, "web", file); };

function FakeElement(tagName) {
  this.tagName = String(tagName || "div").toUpperCase();
  this.innerHTML = "";
  this.textContent = "";
  this.dataset = {};
  this.scrollTop = 0;
  this.listeners = Object.create(null);
  const classes = new Set();
  this.classList = {
    add: function () { Array.from(arguments).forEach(function (name) { classes.add(name); }); },
    remove: function () { Array.from(arguments).forEach(function (name) { classes.delete(name); }); },
    contains: function (name) { return classes.has(name); }
  };
}
FakeElement.prototype.addEventListener = function (type, listener) {
  (this.listeners[type] = this.listeners[type] || []).push(listener);
};
FakeElement.prototype.removeEventListener = function (type, listener) {
  this.listeners[type] = (this.listeners[type] || []).filter(function (item) { return item !== listener; });
};
FakeElement.prototype.contains = function () { return false; };
FakeElement.prototype.appendChild = function () {};

function createContext(options) {
  const settings = options || {};
  const windowListeners = Object.create(null);
  const replaced = [];
  const location = { hash: settings.hash || "", pathname: "/rnaxray/", search: "" };
  const context = {
    Intl, Number, String, Boolean, Object, Array, Math, RegExp, Set, Map, JSON, Promise, Float64Array, Date, Error, URL,
    URLSearchParams, TextDecoder, Blob, File, console,
    setTimeout, clearTimeout,
    navigator: { userAgent: settings.userAgent || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "" },
    location: location,
    history: {
      replaceState: function (stateObject, title, url) {
        replaced.push(url);
        location.hash = String(url).charAt(0) === "#" ? String(url) : "";
      }
    },
    document: {
      activeElement: null,
      documentElement: { dataset: {} },
      head: new FakeElement("head"),
      body: new FakeElement("body"),
      title: "",
      getElementById: function () { return null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      addEventListener: function () {},
      createElement: function (tag) { return new FakeElement(tag); }
    },
    matchMedia: function () { return { matches: false }; },
    scrollTo: function () {},
    addEventListener: function (type, listener) { (windowListeners[type] = windowListeners[type] || []).push(listener); },
    removeEventListener: function () {},
    dispatchEvent: function () { return true; },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    windowListeners: windowListeners,
    replaced: replaced,
    RNAXRAY_BUILD: { commit: "test" }
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  let kitSource = fs.readFileSync(web("ui-kit.js"), "utf8");
  if (settings.downloadsPublic) {
    assert.match(kitSource, /const DESKTOP_DOWNLOADS_PUBLIC = false;/);
    kitSource = kitSource.replace("const DESKTOP_DOWNLOADS_PUBLIC = false;", "const DESKTOP_DOWNLOADS_PUBLIC = true;");
  }
  if (!settings.withoutKit) {
    vm.runInContext(kitSource, context, { filename: "ui-kit.js" });
  }
  [
    "desktop-adapter.js", "analysis-data.js", "example.js", "data-provider.js", "page-data.js", "comrades-analysis.js",
    "analysis-pages.js", "analysis-ui.js", "overview-page.js", "report-page.js", "app.js"
  ].forEach(function (file) {
    vm.runInContext(fs.readFileSync(web(file), "utf8"), context, { filename: file });
  });
  // as inside RNAxRay Desktop (desktop-adapter.js sets it from the native bridge)
  if (settings.desktop) {
    context.RNAxRayDesktop = settings.desktop;
  }
  return context;
}

function mountSite(context) {
  const host = new FakeElement("div");
  context.window.RNAxRayWeb.mount(host, {});
  return host;
}

// a click on an element carrying `attributes` (closest() answers for it)
function click(host, attributes) {
  let prevented = false;
  const node = { dataset: attributes.dataset || { action: attributes["data-action"] }, getAttribute: function (name) { return attributes[name] || null; } };
  const target = {
    closest: function (selector) {
      if (selector === '[data-action="open-desktop"]' && attributes["data-action"] === "open-desktop") return node;
      if (selector === "[data-action]" && attributes["data-action"]) return node;
      return null;
    },
    matches: function () { return false; }
  };
  (host.listeners.click || []).forEach(function (listener) {
    listener({ target: target, preventDefault: function () { prevented = true; } });
  });
  return prevented;
}

// ---- downloads not public (the release repository is private)
const site = createContext();
const landing = mountSite(site);
const html = landing.innerHTML;
has(html, /<h2 id="landing-ways-title" class="landing-ways-title">Two ways to run RNAxRay<\/h2>/);
has(html, /Up to 500 nt after a capacity test/, "Web's CPLfold limit comes from K9");
has(html, /Set by memory, about 6,500 nt with 8 GB of memory; native, no capacity test/, "Desktop's CPLfold limit comes from K9");
has(html, /RNAxRay Desktop is not available for public download yet\./);
has(html, /Installers planned for macOS · Apple silicon, Windows · 64-bit, Linux \(\.deb, \.tar\.gz\)\./);
hasNot(html, /github\.com\/Vicky-0256\/rnaxray/, "no link to the private repository while downloads are not public");
hasNot(html, /RNAxRay-Desktop-[A-Za-z0-9-]+\.(dmg|exe|deb|tar\.gz)/, "no installer file names while downloads are not public");
hasNot(html, /First launch \(unsigned app\)/);
hasNot(html, /renderDesktopDownloadCard|desktop-download-card|web-capability-card/, "the old Desktop and capability cards are gone");
has(html, /<details class="ways-browser-check"[^>]*><summary>Browser check/);
has(html, /<button class="text-button desktop-entry" type="button" data-action="open-desktop">Desktop app<\/button>\s*<button class="text-button" type="button" data-action="open-help">Help<\/button>/,
  "the landing header has Desktop app left of Help");

// ---- A16: one linked raw-reads sentence (drop zone, parse error, Help)
const rawReadsLink = /<a class="desktop-cta" href="#rnaxray-desktop" data-action="open-desktop" data-desktop-context="raw-reads">Starting from raw reads \(FASTQ, FASTA or SAM\)\? RNAxRay Desktop maps them and writes the \.hyb file\. <strong>About RNAxRay Desktop<\/strong><\/a>/;
has(html, new RegExp('<p class="dropzone-desktop">' + rawReadsLink.source + "</p>"), "the drop zone links raw reads to Desktop");
hasNot(html, /RNAxRay Desktop, below/, "no 'below' pointer");
has(html, /Recommended working size: up to 50 MB\./, "the working-size sentence is unchanged");
const appSource = fs.readFileSync(web("app.js"), "utf8");
assert.match(appSource, /hint: hybFormatHint\(\),\s*rawReadsHint: true/, "the parse error adds the raw-reads sentence");
assert.match(appSource, /landing: \["Start a session", \[[\s\S]*?\{ html: rawReadsSentenceHtml \}/, "Help on the start page uses the same sentence");
assert.match(appSource, /if \(dropzone && !event\.target\.closest\("a\[href\]"\) && \(event\.key === "Enter"/, "Enter on the link follows it instead of opening the file chooser");

// ---- A17: raw-read files given as HYB get their own panel, decided before parsing
const kindSource = /const RAW_READ_EXTENSION = [^\n]+\n\n  function rawReadKind\(name, head\) \{[\s\S]*?\n  \}\n/.exec(appSource);
assert.ok(kindSource, "rawReadKind is in app.js");
const kindContext = vm.createContext({});
vm.runInContext(kindSource[0] + "\nthis.rawReadKind = rawReadKind;", kindContext);
const kind = kindContext.rawReadKind;
[["reads.fastq", "fastq"], ["reads.fq.gz", "fastq"], ["R1.FASTQ.GZ", "fastq"], ["x.sam", "sam"], ["x.bam", "bam"], ["x.sam.gz", "sam"],
 ["ref.fa", "fasta"], ["ref.fasta.gz", "fasta"], ["ref.fna", "fasta"], ["data.hyb", null], ["data.hyb.gz", null], ["data.txt", null]].forEach(function (entry) {
  assert.equal(kind(entry[0]), entry[1], entry[0]);
});
assert.equal(kind("reads.txt", "@r1 1:N:0\nACGTN\n+\nIIIII\n"), "fastq", "FASTQ by its four-line records");
assert.equal(kind("x.txt", "@HD\tVN:1.6\n@SQ\tSN:a\tLN:9\n"), "sam", "SAM by its header");
assert.equal(kind("x.txt", "@SQ\tSN:a\tLN:9\n"), "sam");
assert.equal(kind("x.txt", ">chr1\nACGU\n"), "fasta", "FASTA by its first character");
assert.equal(kind("x.txt", "﻿>chr1\nACGU\n"), "fasta", "a byte-order mark is ignored");
assert.equal(kind("x.txt", "1234_567\tACGU\t-12.3\tRNA_A\t1\t20\t1\t20\tRNA_B\t1\t20\t1\t20\t.\t.\n"), null, "a HYB line is parsed as before");
assert.equal(kind("x.txt", "@r1\nACGU\n"), null, "two lines are not a FASTQ record");
assert.match(appSource, /if \(file\) \{\s*acceptHybFile\(file\);\s*\}\s*event\.target\.value = "";/, "the HYB file input checks for raw reads first");
assert.match(appSource, /const file = event\.dataTransfer && [^\n]+\n\n    if \(file\) \{\s*acceptHybFile\(file\);/, "a dropped file is checked for raw reads first");

// nothing in the site's sources hard-codes an installer or the release page
fs.readdirSync(path.join(repository, "web")).filter(function (file) { return /\.(js|html)$/.test(file) && file !== "ui-kit.js"; }).forEach(function (file) {
  const source = fs.readFileSync(web(file), "utf8");
  hasNot(source, /github\.com\/Vicky-0256\/RNAxRAY\/releases/, file + " must take Desktop links from RNAxRayUiKit.desktop (K9)");
  hasNot(source, /RNAxRay-Desktop-(macOS|Windows|Linux)/, file + " must take installer names from K9");
});

// ---- a Desktop link opens the drawer; the page and the address stay
assert.equal(click(landing, { "data-action": "open-desktop" }), true, "the link's default (#rnaxray-desktop) is prevented");
assert.equal(site.location.hash, "", "the address does not change");
has(landing.innerHTML, /class="dialog drawer desktop-drawer"/, "the Desktop drawer opens");
has(landing.innerHTML, /class="landing/, "the current page stays");
has(landing.innerHTML, /<table class="desktop-compare">/);
has(landing.innerHTML, /Native CPLfold\.<\/strong> Set by memory, about 6,500 nt with 8 GB of memory \(browser: 500 nt\), no capacity test/);
click(landing, { "data-action": "close-dialog" });
hasNot(landing.innerHTML, /desktop-drawer/);

// ---- #rnaxray-desktop in the address (new tab, pasted link): drawer, page kept
site.location.hash = "#rnaxray-desktop";
site.windowListeners.hashchange.forEach(function (listener) { listener({ oldURL: "https://example.test/rnaxray/" }); });
has(landing.innerHTML, /class="dialog drawer desktop-drawer"/, "#rnaxray-desktop opens the drawer");
has(landing.innerHTML, /class="landing/, "#rnaxray-desktop is not a page");
assert.equal(site.location.hash, "", "the previous address is put back");
assert.equal(site.replaced.at(-1), "/rnaxray/");

const opened = createContext({ hash: "#rnaxray-desktop" });
const openedHost = mountSite(opened);
has(openedHost.innerHTML, /desktop-drawer/, "a page opened at #rnaxray-desktop shows the drawer");
has(openedHost.innerHTML, /class="landing/);
assert.equal(opened.location.hash, "");

// ---- downloads public (flip K9 downloadsAvailable): the full download design
[
  ["Macintosh; Intel Mac OS X 10_15_7", "mac-arm64", "Download for macOS · Apple silicon"],
  ["Windows NT 10.0; Win64; x64", "win-x64", "Download for Windows · 64-bit"],
  ["X11; Linux x86_64", "linux-deb", "Download for Linux · .deb"],
  ["X11; FreeBSD amd64", null, null]
].forEach(function (entry) {
  const page = mountSite(createContext({ downloadsPublic: true, userAgent: entry[0] })).innerHTML;
  const primary = /<a class="button desktop-download-primary" href="([^"]+)" data-platform="([^"]+)">([^<]+)<\/a>/.exec(page);
  if (entry[1]) {
    assert.ok(primary, entry[0] + ": one primary download");
    assert.equal(primary[2], entry[1], entry[0]);
    assert.equal(primary[3], entry[2], entry[0]);
    has(page, /Download for another system:/);
  } else {
    assert.equal(primary, null, "an unknown system gets no primary button");
    has(page, /<div class="desktop-download-groups">/, "an unknown system sees the three systems side by side");
  }
  ["RNAxRay-Desktop-macOS-arm64.dmg", "RNAxRay-Desktop-Windows-x64-Setup.exe", "RNAxRay-Desktop-Linux-x64.deb", "RNAxRay-Desktop-Linux-x64.tar.gz"].forEach(function (file) {
    assert.ok(page.indexOf('href="https://github.com/Vicky-0256/RNAxRAY/releases/latest/download/' + file + '"') > -1, entry[0] + ": " + file);
  });
  has(page, /href="https:\/\/github\.com\/Vicky-0256\/RNAxRAY\/releases\/latest\/download\/SHA256SUMS\.txt">Checksums \(SHA256SUMS\.txt\)<\/a>/);
  has(page, /href="https:\/\/github\.com\/Vicky-0256\/RNAxRAY\/releases\/latest">Release notes<\/a>/);
  has(page, /<summary>First launch \(unsigned app\)<\/summary>/);
  has(page, /Intel Macs and ARM Linux\/Windows have no installer yet/);
  hasNot(page, /For this computer|This computer/, "the verb is always Download");
});

// ---- A18: inside RNAxRay Desktop no page offers RNAxRay Desktop
const inside = createContext({ desktop: { enabled: true } });
const insideHost = mountSite(inside);
const noDesktop = /class="desktop-cta|data-action="open-desktop"|landing-ways|ways-desktop/;
hasNot(insideHost.innerHTML, noDesktop, "inside Desktop: landing");
click(insideHost, { "data-action": "open-help" });
has(insideHost.innerHTML, /help-drawer/);
hasNot(insideHost.innerHTML, noDesktop, "inside Desktop: Help");
click(insideHost, { "data-action": "close-dialog" });
click(insideHost, { "data-action": "open-desktop" });
hasNot(insideHost.innerHTML, /desktop-drawer/, "inside Desktop the drawer never opens");
inside.location.hash = "#rnaxray-desktop";
inside.windowListeners.hashchange.forEach(function (listener) { listener({}); });
hasNot(insideHost.innerHTML, /desktop-drawer/, "inside Desktop #rnaxray-desktop opens nothing");
has(insideHost.innerHTML, /class="landing/);
// without the kit (some tests load the pages without ui-kit.js) nothing breaks
const noKit = createContext({ withoutKit: true });
hasNot(mountSite(noKit).innerHTML, noDesktop, "without ui-kit.js");

process.stdout.write("desktop-entry: ok\n");

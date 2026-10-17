"use strict";

// RNAxRayWeb.mount(host, { provider, shell: false }) contract (RAWDATA_APP_PLAN.md
// R4): analysis pages only, host-driven navigation and selection, events for
// cross-page routing, and the deprecated desktop API still present.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

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
FakeElement.prototype.listenerCount = function () {
  const listeners = this.listeners;
  return Object.keys(listeners).reduce(function (total, type) { return total + listeners[type].length; }, 0);
};

function createContext() {
  const windowListeners = Object.create(null);
  const context = {
    Intl, Number, String, Boolean, Object, Array, Math, RegExp, Set, Map, JSON, Promise, Float64Array, Date, Error,
    URLSearchParams, TextDecoder, Blob, File, console,
    setTimeout, clearTimeout,
    navigator: {},
    history: { replaceState: function () { throw new Error("embedded pages must not rewrite the URL"); } },
    location: { hash: "" },
    document: {
      activeElement: null,
      documentElement: { dataset: {} },
      head: new FakeElement("head"),
      body: new FakeElement("body"),
      title: "Host title",
      getElementById: function () { return null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      createElement: function (tag) { return new FakeElement(tag); }
    },
    matchMedia: function () { return { matches: false }; },
    scrollTo: function () {},
    addEventListener: function (type, listener) { (windowListeners[type] = windowListeners[type] || []).push(listener); },
    removeEventListener: function (type, listener) {
      windowListeners[type] = (windowListeners[type] || []).filter(function (item) { return item !== listener; });
    },
    dispatchEvent: function () { return true; },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    windowListeners: windowListeners,
    RNAXRAY_BUILD: { commit: "test" }
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  [
    "desktop-adapter.js", "analysis-data.js", "example.js", "data-provider.js", "page-data.js", "comrades-analysis.js",
    "analysis-pages.js", "analysis-ui.js", "overview-page.js", "report-page.js", "app.js"
  ].forEach(function (file) {
    vm.runInContext(fs.readFileSync(web(file), "utf8"), context, { filename: file });
  });
  return context;
}

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
    parserContext.self.onmessage({ data: { file: new File([text], "ZAFR_REP1_1in10.hyb") } });
  });
}

function settle() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  });
}

function click(host, dataset) {
  const button = { dataset: dataset };
  const target = {
    closest: function (selector) {
      if (selector === "[data-feature-action]" && dataset.featureAction) return button;
      if (selector === "[data-action]" && dataset.action) return button;
      return null;
    },
    matches: function () { return false; }
  };
  (host.listeners.click || []).forEach(function (listener) { listener({ target: target }); });
}

async function main() {
  const context = createContext();
  const rnaxrayWeb = context.window.RNAxRayWeb;
  assert.equal(typeof rnaxrayWeb.mount, "function");
  assert.equal(typeof rnaxrayWeb.loadProjectFiles, "function", "the deprecated desktop API must remain");
  assert.equal(typeof rnaxrayWeb.restoreSession, "function", "the deprecated desktop API must remain");
  assert.deepEqual(JSON.parse(JSON.stringify(rnaxrayWeb.pages.map(function (page) { return page.id; }))),
    ["overview", "interactions", "contact-map", "viewpoint", "region", "compare", "structure", "report"]);

  const parsed = await parseExample();
  const fastaText = fs.readFileSync(web("assets/examples/zikv-virion/ZAFR.fasta"), "utf8");
  const data = context.window.RNAxRayData;
  const sequences = data.parseFasta(fastaText);
  const provider = rnaxrayWeb.createBrowserProvider();
  provider.addDataset({ id: "s1", label: "Sample 1", condition: "A", summary: parsed.summary, records: parsed.records });
  provider.addDataset({ id: "s2", label: "Sample 2", condition: "B", summary: Object.assign({}, parsed.summary, { fileName: "second.hyb" }), records: parsed.records.map(function (record) { return Object.assign({}, record); }) });
  provider.setReference({ fileName: "ZIKV.fasta", sequences: sequences, mapping: data.buildFastaMapping(parsed.summary.rnaNames, sequences) });

  const host = new FakeElement("section");
  const navigations = [];
  const folds = [];
  const controller = rnaxrayWeb.mount(host, {
    provider: provider,
    shell: false,
    selection: { datasetIds: ["s1"] },
    onNavigate: function (detail) { navigations.push(detail); },
    onRequestFold: function (detail) { folds.push(detail); }
  });
  ["navigate", "setSelection", "refresh", "destroy", "on"].forEach(function (method) {
    assert.equal(typeof controller[method], "function", "controller." + method);
  });
  assert.match(host.innerHTML, /Loading analysis data/, "an embedded mount shows a neutral loading state, not the landing page");
  await settle();

  const chrome = [
    [/class="landing/, "landing page"],
    [/class="sidebar/, "sidebar"],
    [/class="workspace-header/, "workspace header"],
    [/class="mobile-nav/, "mobile navigation"],
    [/type="file"/, "upload inputs"],
    [/data-action="(choose-hyb|choose-fasta|open-files|open-help|open-display|open-privacy|start-over|clear-session|load-example)"/, "shell actions"],
    [/data-feature-action="(choose-fasta|choose-comparison-files|replace-hyb)"/, "upload actions"],
    [/data-page="(validation|methods|file-format|privacy)"/, "help pages"],
    [/Tweaks/, "display tweaks"]
  ];
  function assertNoChrome(label) {
    chrome.forEach(function (entry) {
      assert.doesNotMatch(host.innerHTML, entry[0], label + " must not render " + entry[1]);
    });
  }

  assert.match(host.innerHTML, /<h1>Overview<\/h1>/);
  assert.match(host.innerHTML, /workspace-embedded/);
  assertNoChrome("overview");
  assert.equal(context.location.hash, "", "embedded mounting must not touch the URL hash");
  assert.equal((context.windowListeners.hashchange || []).length, 0, "embedded mounting must not listen to hash routing");
  assert.equal(context.document.title, "Host title", "embedded mounting must not retitle the host document");

  const headings = {
    interactions: /<h1>Interactions<\/h1>/,
    "contact-map": /<h1>Contact Map<\/h1>/,
    viewpoint: /<h1>Viewpoint<\/h1>/,
    region: /<h1>Region Explorer<\/h1>/,
    compare: /<h1>Compare<\/h1>/,
    structure: /<h1>RNA Structure<\/h1>/,
    report: /data-report-page/
  };
  for (const pageId of Object.keys(headings)) {
    controller.navigate(pageId);
    await settle();
    assert.equal(controller.getPageId(), pageId);
    assert.match(host.innerHTML, headings[pageId], pageId + " must render");
    assert.doesNotMatch(host.innerHTML, /Preparing the|Loading matching records|Loading the reference/, pageId + " data must arrive through the provider");
    assertNoChrome(pageId);
    assert.equal(navigations.at(-1).pageId, pageId, "the host must be told about navigation");
  }

  controller.navigate("contact-map");
  await settle();
  assert.match(host.innerHTML, /<canvas id="contact-overview-canvas"/, "the contact map must render from provider bins");
  controller.navigate("interactions");
  await settle();
  assert.match(host.innerHTML, /10,000 matching records/);
  assert.match(host.innerHTML, /class="virtual-row"/, "interaction rows must come from queryHybrids");
  controller.navigate("compare");
  await settle();
  assert.match(host.innerHTML, /Sample 2|second/, "Compare lists datasets from provider.listDatasets()");

  const before = controller.getPageId();
  controller.navigate("methods");
  assert.equal(controller.getPageId(), before, "help pages are not part of the embedded page set");

  // Cross-page action: "fold this region" goes to the host.
  controller.navigate("region");
  await settle();
  assert.match(host.innerHTML, /data-feature-action="request-fold"/, "embedded pages offer host-routed folding");
  click(host, { featureAction: "request-fold", source: "region" });
  assert.equal(folds.length, 1);
  assert.equal(folds[0].source, "region");
  assert.ok(folds[0].region && folds[0].region.rna && folds[0].region.start >= 1 && folds[0].region.end >= folds[0].region.start);
  assert.deepEqual(JSON.parse(JSON.stringify(folds[0].selection)), { datasetIds: ["s1"] });
  click(host, { featureAction: "region-send-structure" });
  assert.equal(folds.length, 2, "Send to RNA Structure is routed to the host when it handles folds");
  assert.equal(controller.getPageId(), "region");

  // In-page navigation (Overview -> Interactions) also reaches the host.
  controller.navigate("overview");
  await settle();
  click(host, { action: "navigate", page: "interactions" });
  await settle();
  assert.equal(controller.getPageId(), "interactions");
  assert.equal(navigations.at(-1).pageId, "interactions");

  // Host-driven selection: a merged selection sums both datasets.
  await controller.setSelection({ datasetIds: ["s1", "s2"] });
  await settle();
  controller.navigate("overview");
  await settle();
  assert.match(host.innerHTML, /20,000 valid records/, "merged selections sum record counts");
  await controller.refresh();
  await settle();
  assert.match(host.innerHTML, /<h1>Overview<\/h1>/);

  const off = controller.on("navigate", function () { throw new Error("listener must be removable"); });
  off();
  controller.destroy();
  assert.equal(host.innerHTML, "");
  assert.equal(host.listenerCount(), 0, "destroy must remove host listeners");
  controller.navigate("overview");

  // shell:true keeps the website: landing page with uploads.
  const siteHost = new FakeElement("div");
  rnaxrayWeb.mount(siteHost, {});
  assert.match(siteHost.innerHTML, /class="landing/);
  assert.match(siteHost.innerHTML, /data-action="load-example"/);
  assert.equal((context.windowListeners.hashchange || []).length, 1, "the website keeps hash routing");

  process.stdout.write("embedded-mount-contract: ok\n");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});

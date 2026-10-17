/*
 * RNAxRay Web application controller.
 *
 * Two ways to run it:
 *   - Website (shell:true, the default auto-mount on #app): landing page,
 *     uploads, sidebar navigation, hash routing and help pages. Parsed files
 *     are registered in a BrowserProvider.
 *   - Embedded (shell:false): window.RNAxRayWeb.mount(host, { provider,
 *     shell: false, ... }) renders only the analysis pages; the host owns
 *     navigation, data selection and cross-page routing. See web/README.md
 *     ("Embedding the analysis pages") and data-provider.js for the contract.
 *
 * Analysis pages read their data exclusively through the DataProvider via
 * page-data.js; only this shell reads files.
 */
(function () {
  "use strict";

  let app = null;
  const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
  // The included example (example.js): files are fetched only when it is used.
  const example = window.RNAxRayExample || null;

  // the address K9's Desktop links point at (see syncRoute)
  const DESKTOP_HASH = "#rnaxray-desktop";
  // the route before the last hash change, put back after #rnaxray-desktop
  let lastRouteHash = "";
  // where focus goes when the Desktop drawer closes: the link that opened it
  let desktopReturnSelector = null;
  let renderedDialog = null;

  const state = {
    activePage: "landing",
    analysisEntered: false,
    dialog: null,
    file: null,
    summary: null,
    records: [],
    fasta: null,
    filters: null,
    interactionResults: [],
    interactionScrollTop: 0,
    selectedRecordIndex: null,
    contact: null,
    region: null,
    viewpoint: null,
    comparison: null,
    structure: null,
    worker: null,
    structureWorker: null,
    comparisonParsers: new Set(),
    comparisonLoadSession: null,
    parseSession: null,
    fastaLoadSession: null,
    exampleLoadSession: null,
    // the example's second stage (replicates, arc map files) after the
    // primary HYB is parsed: { stage, done, total, error, ready }
    exampleSetup: null,
    landingFastaFile: null,
    // a raw-read file dropped where a HYB file goes: { name, kind } (A17)
    rawReads: null,
    loading: null,
    error: null,
    // dark by default; the theme button switches, and a restored session
    // keeps the visitor's choice
    theme: "dark",
    density: "comfortable",
    toastTimer: null,
    pointerActionPending: false,
    pendingCommittedInputRender: false,
    pendingSessionSnapshot: null,
    // Provider-facing view model (see page-data.js).
    shell: true,
    selection: null,
    datasets: [],
    reference: null,
    view: null,
    canRequestFold: false
  };
  const PRIMARY_DATASET_ID = "primary";
  let provider = null;
  let pageData = null;
  let mountOptions = {};
  let renderedPage = null;
  let dataWaitToken = 0;
  let mountListeners = Object.create(null);
  let pendingCalls = [];
  let dependenciesLoading = null;

  const analysisPages = [
    { id: "overview", label: "Overview", shortLabel: "OV" },
    { id: "interactions", label: "Interactions", shortLabel: "IX" },
    { id: "contact-map", label: "Contact Map", shortLabel: "CM" },
    { id: "viewpoint", label: "Viewpoint", shortLabel: "VP" },
    { id: "region", label: "Region Explorer", shortLabel: "RX" },
    { id: "compare", label: "Compare", shortLabel: "CP" },
    { id: "structure", label: "RNA Structure", shortLabel: "RS" }
  ];
  const reportPage = { id: "report", label: "Report", shortLabel: "RP" };
  const workspacePages = analysisPages.concat([reportPage]);

  // Folded sections (<details data-open-key>) keep their open state across
  // renders, which replace the whole page.
  window.RNAxRayOpenSections = window.RNAxRayOpenSections || Object.create(null);
  function handleSectionToggle(event) {
    const target = event.target;
    if (target && target.matches && target.matches("details[data-open-key]")) {
      window.RNAxRayOpenSections[target.dataset.openKey] = target.open;
    }
  }

  const hostEvents = [
    ["pointerdown", handlePointerDown],
    ["click", handleClick],
    ["click", finishPointerAction],
    ["pointercancel", finishPointerAction],
    ["input", handleInput],
    ["change", handleChange],
    ["keydown", handleKeydown],
    ["dragover", handleDragOver],
    ["dragleave", handleDragLeave],
    ["drop", handleDrop]
  ];

  // ---- Mounting -----------------------------------------------------------

  // data-provider.js and page-data.js are listed in index.html. Hosts that
  // load an older fixed script list (the current desktop shell) get them
  // fetched here before the first mount.
  function dependenciesReady() {
    return !!(window.RNAxRayProvider && window.RNAxRayPageData);
  }

  function loadDependencies() {
    if (dependenciesReady()) {
      return Promise.resolve();
    }
    if (dependenciesLoading) {
      return dependenciesLoading;
    }
    const base = window.RNAXRAY_ASSET_BASE || "./";
    const files = [];
    if (!window.RNAxRayProvider) files.push("data-provider.js");
    if (!window.RNAxRayPageData) files.push("page-data.js");
    dependenciesLoading = files.reduce(function (chain, file) {
      return chain.then(function () {
        return new Promise(function (resolve, reject) {
          const script = document.createElement("script");
          script.src = base + file;
          script.onload = resolve;
          script.onerror = function () { reject(new Error("Could not load " + file)); };
          document.head.appendChild(script);
        });
      });
    }, Promise.resolve());
    return dependenciesLoading;
  }

  function whenMounted(callback) {
    if (app && pageData) {
      return callback();
    }
    pendingCalls.push(callback);
    return undefined;
  }

  function flushPendingCalls() {
    const calls = pendingCalls;
    pendingCalls = [];
    calls.forEach(function (callback) { callback(); });
  }

  function emit(name, detail) {
    const handlerName = "on" + name.charAt(0).toUpperCase() + name.slice(1);
    if (typeof mountOptions[handlerName] === "function") {
      try {
        mountOptions[handlerName](detail);
      } catch (error) {
        if (window.console) window.console.error(error);
      }
    }
    (mountListeners[name] || []).slice().forEach(function (listener) {
      try {
        listener(detail);
      } catch (error) {
        if (window.console) window.console.error(error);
      }
    });
  }

  function unmount() {
    if (!app) {
      return;
    }
    terminateWorker();
    cancelComparisonLoads();
    stopAnalysisWorkers();
    hostEvents.forEach(function (entry) { app.removeEventListener(entry[0], entry[1]); });
    app.removeEventListener("toggle", handleSectionToggle, true);
    window.removeEventListener("hashchange", handleHashChange);
    if (pageData) {
      pageData.destroy();
    }
    app.innerHTML = "";
    app.classList.remove("rnaxray-embedded", "is-refreshing-data");
    app = null;
    pageData = null;
    provider = null;
    renderedPage = null;
    mountListeners = Object.create(null);
  }

  function resetDataState() {
    state.file = null;
    state.summary = null;
    state.records = [];
    state.fasta = null;
    state.filters = null;
    state.interactionResults = [];
    state.interactionScrollTop = 0;
    state.selectedRecordIndex = null;
    state.contact = null;
    state.region = null;
    state.viewpoint = null;
    state.comparison = null;
    resetAnalysisModules();
    state.structure = null;
    state.loading = null;
    state.error = null;
    state.dialog = null;
    state.selection = null;
    state.datasets = [];
    state.reference = null;
    state.view = window.RNAxRayPageData.freshView();
  }

  /*
   * mount(host, options) -> controller
   *   options.provider   DataProvider (data-provider.js). Default: a new
   *                      BrowserProvider (required for shell:true uploads).
   *   options.shell      true (default): the full website. false: analysis
   *                      pages only (no landing, sidebar/nav, uploads, help).
   *   options.selection  initial selection, e.g. { datasetIds: ["s1"] }.
   *   options.page       initial page id (shell:false; default "overview").
   *   options.onNavigate({ pageId, previousPageId, reason })
   *   options.onRequestFold({ source, region, partnerRegion, arms, selection })
   *                      when set (shell:false), "fold this region" actions
   *                      on Contact Map, Region and Compare go to the host.
   *   options.onError(error)
   * controller = { navigate(pageId), setSelection(selection) -> Promise,
   *   refresh() -> Promise, destroy(), on(event, listener) -> off,
   *   getPageId(), getSelection(), provider }
   */
  function mount(host, options) {
    if (!host || typeof host.addEventListener !== "function") {
      throw new Error("RNAxRayWeb.mount needs a host element.");
    }
    if (!dependenciesReady()) {
      throw new Error("Load data-provider.js and page-data.js before mounting (or use RNAxRayWeb.ready).");
    }
    unmount();
    const settings = options || {};
    const shell = settings.shell !== false;
    const nextProvider = settings.provider || new window.RNAxRayProvider.BrowserProvider();
    if (!window.RNAxRayProvider.implementsProvider(nextProvider)) {
      throw new Error("The provider must implement " + window.RNAxRayProvider.METHODS.join(", ") + ".");
    }
    mountOptions = settings;
    app = host;
    provider = nextProvider;
    resetDataState();
    state.shell = shell;
    state.canRequestFold = !shell && typeof settings.onRequestFold === "function";
    state.analysisEntered = !shell;
    state.activePage = shell ? "landing" : normaliseEmbeddedPage(settings.page);
    if (!shell) {
      app.classList.add("rnaxray-embedded");
    }
    pageData = window.RNAxRayPageData.createController({
      state: state,
      initialiseOnSelection: !shell,
      onUpdate: function () { rerenderPreservingFocus(); },
      onError: function (error) { emit("error", error); }
    });
    pageData.setProvider(provider);
    app.addEventListener("toggle", handleSectionToggle, true);
    app.addEventListener("pointerdown", handlePointerDown);
    app.addEventListener("click", handleClick);
    app.addEventListener("click", finishPointerAction);
    app.addEventListener("pointercancel", finishPointerAction);
    app.addEventListener("input", handleInput);
    app.addEventListener("change", handleChange);
    app.addEventListener("keydown", handleKeydown);
    app.addEventListener("dragover", handleDragOver);
    app.addEventListener("dragleave", handleDragLeave);
    app.addEventListener("drop", handleDrop);
    if (shell) {
      window.addEventListener("hashchange", handleHashChange);
      syncRoute();
    }
    if (settings.selection) {
      pageData.setSelection(settings.selection);
    }
    render();
    flushPendingCalls();
    return controller();
  }

  function normaliseEmbeddedPage(pageId) {
    return workspacePages.some(function (page) { return page.id === pageId; }) ? pageId : "overview";
  }

  function controller() {
    const mountedHost = app;
    const active = function () { return app === mountedHost && !!pageData; };
    return {
      provider: provider,
      navigate: function (pageId) {
        if (active()) navigate(pageId, "host");
      },
      setSelection: function (selection) {
        if (!active()) return Promise.resolve(false);
        const loading = pageData.setSelection(selection);
        render();
        return loading.then(function () { render(); return true; });
      },
      refresh: function () {
        if (!active()) return Promise.resolve(false);
        pageData.invalidate();
        const loading = pageData.ensure(state.analysisEntered ? state.activePage : null);
        render();
        return Promise.resolve(loading).then(function () { return true; });
      },
      destroy: function () {
        if (active()) unmount();
      },
      on: function (name, listener) {
        if (!mountListeners[name]) mountListeners[name] = [];
        mountListeners[name].push(listener);
        return function () {
          mountListeners[name] = (mountListeners[name] || []).filter(function (item) { return item !== listener; });
        };
      },
      getPageId: function () { return state.activePage; },
      getSelection: function () { return state.selection; },
      // Host cross-page paths (shell:false): open a page focused on a place.
      //   focus({ page, contact: { rnaX, rnaY, binSize, selection: { x, y } },
      //           region: { rna, start, end, partner, partnerStart, partnerEnd } })
      // Call after setSelection() has resolved (page state exists then).
      focus: function (target) {
        if (!active() || !target || typeof target !== "object") return false;
        if (target.contact && state.contact) {
          ["rnaX", "rnaY"].forEach(function (key) {
            if (target.contact[key]) state.contact[key] = String(target.contact[key]);
          });
          if (Number(target.contact.binSize) > 0) state.contact.binSize = Math.floor(Number(target.contact.binSize));
          const point = target.contact.selection;
          state.contact.selection = point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
            ? { x: Number(point.x), y: Number(point.y) }
            : null;
          state.contact.overviewSelection = null;
          state.contact.zoomSelection = null;
          state.contact.matrix = null;
        }
        if (target.region && state.region) {
          ["rna", "start", "end", "partner", "partnerStart", "partnerEnd"].forEach(function (key) {
            if (target.region[key] !== undefined && target.region[key] !== null) state.region[key] = target.region[key];
          });
          state.region.results = null;
        }
        navigate(target.page || state.activePage, "host");
        render();
        return true;
      }
    };
  }

  // Desktop uses the same analysis engine in the same document. This small
  // bridge lets the project controller hand imported project inputs directly
  // to the parser without reopening a file picker.
  window.RNAxRayWeb = {
    mount: mount,
    // Resolves when mount() can be called (dependencies loaded).
    ready: function () { return loadDependencies(); },
    createBrowserProvider: function (options) {
      return new window.RNAxRayProvider.BrowserProvider(options);
    },
    pages: workspacePages.map(function (page) { return { id: page.id, label: page.label }; }),
    // Deprecated: the desktop app will feed data through a DataProvider and
    // mount({ shell: false }) instead. Kept until the desktop wave 2 lands.
    loadProjectFiles: function (files) {
      const accepted = !!(files && (files.hyb || files.fasta));
      whenMounted(function () { loadProjectFilesNow(files); });
      return accepted;
    },
    getSessionSnapshot: function () {
      return {
        route: state.activePage,
        theme: state.theme,
        density: state.density,
        filters: state.filters ? {
          rna: state.filters.rna || "",
          partner: state.filters.partner || "",
          minScore: state.filters.minScore || ""
        } : {}
      };
    },
    // Deprecated together with loadProjectFiles.
    restoreSession: function (snapshot) {
      whenMounted(function () { restoreSessionNow(snapshot); });
    },
    refresh: function () {
      if (app) render();
    },
    showSavedStructure: function (result) {
      if (!app) return false;
      return showSavedStructureNow(result);
    }
  };

  function loadProjectFilesNow(files) {
    if (!state.shell || !canRegisterDatasets()) {
      return false;
    }
    const input = files || {};
    const makeFile = function (entry, fallback) {
      if (!entry) return null;
      if (typeof File === "function" && entry instanceof File) return entry;
      if (typeof Blob === "function" && entry.file instanceof Blob) {
        return entry.file instanceof File ? entry.file : new File([entry.file], entry.name || fallback, { type: "text/plain" });
      }
      if (typeof entry.content !== "string") return null;
      return new File([entry.content], entry.name || fallback, { type: "text/plain" });
    };
    const hyb = makeFile(input.hyb, "project.hyb");
    const fasta = makeFile(input.fasta, "reference.fasta");
    if (hyb) {
      startParsing(hyb, { referenceFile: fasta });
    } else if (fasta) {
      state.landingFastaFile = fasta;
      render();
    }
    return !!(hyb || fasta);
  }

  function restoreSessionNow(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    if (!state.summary) {
      state.pendingSessionSnapshot = snapshot;
      return;
    }
    if (snapshot.theme === "dark" || snapshot.theme === "light") state.theme = snapshot.theme;
    if (snapshot.density === "compact" || snapshot.density === "comfortable") state.density = snapshot.density;
    if (state.filters && snapshot.filters && typeof snapshot.filters === "object") Object.assign(state.filters, snapshot.filters);
    if (snapshot.route && snapshot.route !== "landing") {
      if (state.shell) {
        window.location.hash = "#/workspace/" + String(snapshot.route).replace(/^workspace\//, "");
      } else {
        state.activePage = normaliseEmbeddedPage(String(snapshot.route).replace(/^workspace\//, ""));
      }
    }
    render();
  }

  function showSavedStructureNow(result) {
    if (!state.summary || !result || typeof result !== "object" || !result.sequence || !result.dotBracket) return false;
    if (!state.structure) state.structure = window.RNAxRayData.defaultStructureState();
    state.structure.status = "complete";
    state.structure.progress = 100;
    state.structure.operation = null;
    state.structure.result = result;
    state.structure.message = "Restored saved structure result.";
    state.analysisEntered = true;
    if (state.shell) {
      state.activePage = "structure";
      setRouteHash("#/workspace/structure");
      render();
    } else {
      navigate("structure", "saved-structure");
    }
    return true;
  }

  // Website auto-mount on #app (also the current desktop embedding). Set
  // window.RNAXRAY_AUTO_MOUNT = false to mount manually with RNAxRayWeb.mount().
  (function autoMount() {
    const host = document.getElementById("app");
    if (!host || window.RNAXRAY_AUTO_MOUNT === false) {
      return;
    }
    if (dependenciesReady()) {
      mount(host, { shell: true });
      return;
    }
    loadDependencies().then(function () {
      if (!app) mount(host, { shell: true });
    }).catch(function (error) {
      host.textContent = "RNAxRay analysis could not start: " + (error && error.message ? error.message : "missing scripts");
    });
  }());

  function syncRoute() {
    // #rnaxray-desktop (a K9 Desktop link that reached the URL: opened in a new
    // tab, pasted, or clicked before a handler could stop it) is not a page:
    // open the Desktop drawer and put the previous address back, so the
    // routing below keeps the current page.
    if (window.location.hash === DESKTOP_HASH) {
      if (desktopEntriesShown()) {
        state.dialog = "desktop";
      }
      restoreRouteHash(lastRouteHash);
    }
    lastRouteHash = window.location.hash;
    const hash = window.location.hash.replace(/^#\/?/, "");
    const parts = hash.split("?");
    const route = parts[0];
    const query = new URLSearchParams(parts[1] || "");

    if (!state.summary || !state.analysisEntered) {
      state.activePage = "landing";
      return;
    }

    if (!route || route === "workspace/overview") {
      state.activePage = "overview";
      return;
    }

    if (route.indexOf("workspace/") === 0) {
      const candidate = route.slice("workspace/".length);
      state.activePage = workspacePages.some(function (page) { return page.id === candidate; })
        ? candidate
        : "overview";
      if (state.activePage === "interactions" && state.filters) {
        state.filters.rna = query.get("rna") || "";
        state.filters.partner = query.get("partner") || "";
      }
      return;
    }

    state.activePage = ["methods", "file-format", "privacy", "validation"].indexOf(route) > -1
      ? route
      : "overview";
  }

  function openDesktopDrawer() {
    if (desktopEntriesShown()) {
      state.dialog = "desktop";
      render();
    }
  }

  function restoreRouteHash(hash) {
    try {
      window.history.replaceState(null, "", hash && hash !== DESKTOP_HASH ? hash : window.location.pathname + window.location.search);
    } catch (error) {
      // a sandboxed page may refuse to rewrite its URL
    }
  }

  function handleHashChange() {
    const previousPage = state.activePage;
    syncRoute();
    render();
    if (previousPage !== state.activePage) {
      window.scrollTo(0, 0);
      emit("navigate", { pageId: state.activePage, previousPageId: previousPage, reason: "route" });
    }
  }

  // Starts any DataProvider fetches the visible page needs. Returns a Promise
  // while data is loading, otherwise null.
  function requestPageData() {
    if (!pageData) {
      return null;
    }
    if (state.shell && !(state.summary && state.analysisEntered)) {
      return null;
    }
    const page = state.analysisEntered ? state.activePage : null;
    // the Report page reads every page's data: draw each part as it lands
    // instead of waiting for the slowest (the whole comparison)
    return pageData.ensure(page, page === "report" ? schedulePartialRender : null);
  }

  let partialRenderFrame = 0;
  function schedulePartialRender() {
    if (partialRenderFrame || state.activePage !== "report") {
      return;
    }
    partialRenderFrame = window.requestAnimationFrame(function () {
      partialRenderFrame = 0;
      if (state.activePage === "report") {
        const focused = focusIdentity(document.activeElement);
        render({ immediate: true });
        if (focused) {
          restoreFocus(focused, null);
        }
      }
    });
  }

  function rerenderPreservingFocus() {
    if (!app) {
      return;
    }
    const focused = focusIdentity(document.activeElement);
    render();
    if (focused) {
      restoreFocus(focused, null);
    }
  }

  // options.immediate: draw now with the data on hand (and again when the
  // rest arrives), for changes that only concern the page itself, such as
  // the Report page's step selection and export panel
  function render(options) {
    if (!app) {
      return;
    }
    const token = ++dataWaitToken;
    const pendingData = requestPageData();
    if (pendingData) {
      pendingData.then(function () {
        if (token === dataWaitToken) {
          rerenderPreservingFocus();
        }
      });
      // Keep the current page on screen while its data refreshes instead of
      // flashing placeholders (provider calls are async even in the browser).
      if (renderedPage && renderedPage === state.activePage && !(options && options.immediate)) {
        app.classList.add("is-refreshing-data");
        return;
      }
    }
    app.classList.remove("is-refreshing-data");
    const workspaceOpen = !!state.summary && state.analysisEntered;
    if (!state.shell) {
      renderEmbedded(workspaceOpen);
      return;
    }
    const previousNav = typeof app.querySelector === "function" ? app.querySelector(".mobile-nav") : null;
    const navScrollLeft = previousNav ? previousNav.scrollLeft : 0;
    const previousPage = renderedPage;
    // the theme is set first: cards that read theme colours while building
    // their markup (the arc map) must see the new one
    document.documentElement.dataset.theme = state.theme;
    app.innerHTML = workspaceOpen ? renderWorkspace() : renderLanding();
    renderedPage = workspaceOpen ? state.activePage : null;
    if (workspaceOpen) {
      revealActiveMobileNav(navScrollLeft, previousPage !== renderedPage);
    }
    app.dataset.density = state.density;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) {
      themeColor.setAttribute("content", state.theme === "dark" ? "#132c47" : "#f3f7f8");
    }
    document.title = workspaceOpen
      ? pageTitle(state.activePage) + " · RNAxRay Web"
      : "RNAxRay Web";

    if (workspaceOpen && window.RNAxRayUI) {
      window.RNAxRayUI.afterRender(state, featureApi());
    }
    if (workspaceOpen && state.activePage === "report" && window.RNAxRayReport && typeof window.RNAxRayReport.afterRender === "function") {
      window.RNAxRayReport.afterRender(state, featureApi());
    }
    returnFocusFromDesktopDrawer();
    // The first render() runs before window.RNAxRayWeb is defined below.
    if (window.RNAxRayWeb && typeof window.CustomEvent === "function") {
      window.dispatchEvent(new window.CustomEvent("rnaxray:session-change", { detail: window.RNAxRayWeb.getSessionSnapshot() }));
    }
  }

  // interaction.js gives focus back to the first control with the opener's
  // action, which for several Desktop links (or a header entry hidden on
  // phones) is not the one that was used: a frame later, focus that one.
  function returnFocusFromDesktopDrawer() {
    const closed = renderedDialog === "desktop" && state.dialog !== "desktop";
    renderedDialog = state.dialog;
    if (!closed || !desktopReturnSelector) {
      return;
    }
    const selector = desktopReturnSelector;
    desktopReturnSelector = null;
    if (typeof window.requestAnimationFrame !== "function") {
      return;
    }
    window.requestAnimationFrame(function () {
      const target = app && app.querySelector(selector);
      if (target && target.getClientRects().length && !target.closest("[data-dialog]")) {
        target.focus({ preventScroll: true });
      }
    });
  }

  function renderLanding() {
    return [
      '<div class="landing">',
      '  <header class="landing-header">',
      renderBrand(),
      '    <div class="header-actions">',
      '      <button class="local-chip" type="button" data-action="open-privacy" title="What stays on this device">Local only</button>',
      desktopEntriesShown() ? '      <button class="text-button desktop-entry" type="button" data-action="open-desktop">Desktop app</button>' : "",
      '      <button class="text-button" type="button" data-action="open-help">Help</button>',
      renderDisplayButton(),
      "    </div>",
      "  </header>",
      '  <main id="main-content" class="landing-main">',
      '    <section class="landing-copy" aria-labelledby="landing-title">',
      '      <span class="eyebrow" data-scramble>RNA–RNA interaction analysis · HYB files</span>',
      '      <h1 id="landing-title" aria-label="RNAxRay Web. Explore locally."><span class="headline-line" aria-hidden="true"><span class="headline-inner">RNAxRay Web.</span></span><span class="headline-line headline-accent" aria-hidden="true"><span class="headline-inner">Explore locally.</span></span></h1>',
      '      <p class="landing-lede">Inspect RNA–RNA interactions, validate records, compare conditions and fold RNA structures, all in this browser tab.</p>',
      '      <ul class="promise-list">',
      "        <li>No account needed</li>",
      "        <li>Built for HYB-format interaction records</li>",
      "      </ul>",
      '      <figure class="hero-stage" data-hero-stage aria-label="Illustrative arc diagram: many chimeric reads below the sequence, the structure predicted from them above">',
      '        <figcaption class="hero-stage-caption"><span class="hero-stage-live">Illustrative</span><span>Predicted structure above · chimeric reads below</span></figcaption>',
      '        <div class="hero-stage-canvas" data-hero-canvas></div>',
      '        <div class="hero-stage-hud" aria-hidden="true"><span>Chimeric reads <strong data-hero-reads>0</strong></span><span data-hero-probe>Hover the sequence</span></div>',
      "      </figure>",
      "    </section>",
      '    <section class="landing-panel" aria-label="Open a HYB file">',
      renderFilePanel(),
      "    </section>",
      renderWaysToRun(),
      "  </main>",
      renderDialog(),
      '  <div id="toast" class="toast" role="status" aria-live="polite"></div>',
      "</div>"
    ].join("");
  }

  // What the first rejected line looked like, for the parse error.
  function describeParseProblem(problem) {
    const content = String(problem.content || "");
    const columns = content ? content.split("\t").length : 0;
    let text = "Line " + problem.line + ": " + problem.error;
    if (/tab-separated columns/.test(problem.error || "")) {
      text += " (found " + columns + (columns === 1 ? " column" : " columns") + (content.indexOf("\t") === -1 ? "; no tab characters" : "") + ")";
    }
    return text + ".";
  }

  // the parse-error hint; renderFilePanel adds the raw-reads sentence (A16)
  function hybFormatHint() {
    return "A HYB line has 15 or more tab-separated columns: read ID, sequence, ΔG, then name and coordinates of each arm, as written by the hyb pipeline or RNAxRay Desktop.";
  }

  // One sentence wherever raw reads come up (drop zone, parse error, Help):
  // K9's "raw-reads" link to the Desktop drawer. Inside RNAxRay Desktop, which
  // maps raw reads itself, there is nothing to add.
  function rawReadsSentenceHtml() {
    const kit = desktopKit();
    if (!kit) {
      return "Raw FASTQ, FASTA or SAM reads need RNAxRay Desktop first; it turns them into .hyb files.";
    }
    return kit.cta("raw-reads");
  }

  // K9 (web/ui-kit.js) holds every fact about RNAxRay Desktop; some tests load
  // the pages without the kit, and then no Desktop entry is drawn.
  function desktopKit() {
    return window.RNAxRayUiKit && window.RNAxRayUiKit.desktop || null;
  }

  // Desktop entries are left out inside RNAxRay Desktop itself.
  function desktopEntriesShown() {
    const kit = desktopKit();
    return !!kit && !kit.isInsideDesktop();
  }

  function formatNt(value) {
    return Number(value).toLocaleString("en-US") + " nt";
  }

  // "Two ways to run RNAxRay": Web and RNAxRay Desktop side by side, one row
  // per question (where to start, pipeline, analysis, CPLfold, install, data).
  // Replaces the Desktop and Browser capabilities cards under the hero.
  function renderWaysToRun() {
    if (!desktopEntriesShown()) {
      return "";
    }
    const kit = desktopKit();
    const row = function (label, value) {
      return '<p class="ways-row"><span class="ways-label">' + escapeHtml(label) + '</span><span class="ways-value">' + value + "</span></p>";
    };
    const canChoose = !state.loading && !state.error && !state.summary && !state.rawReads;
    return [
      '<section class="landing-ways" aria-labelledby="landing-ways-title">',
      '  <h2 id="landing-ways-title" class="landing-ways-title">Two ways to run RNAxRay</h2>',
      '  <div class="ways-grid">',
      '    <section class="ways-col ways-web" aria-labelledby="ways-web-title">',
      '      <header class="ways-head"><h3 id="ways-web-title">Web</h3><span class="ways-where">in this browser</span></header>',
      row("Start from", ".hyb or .hyb.gz files"),
      row("Pipeline", '<span aria-hidden="true">—</span><span class="visually-hidden">None; it reads finished .hyb files</span>'),
      row("Analysis", "All analysis pages"),
      row("CPLfold", "Up to " + formatNt(kit.limits.webCplfoldNt) + " after a capacity test"),
      row("Install", "None"),
      row("Data", "Stays in this browser tab"),
      '      <div class="ways-actions">',
      canChoose ? '        <button class="button" type="button" data-action="choose-hyb">Choose HYB file</button>' : "",
      renderBrowserCheck(),
      "      </div>",
      "    </section>",
      '    <section class="ways-col ways-desktop" aria-labelledby="ways-desktop-title">',
      '      <header class="ways-head"><h3 id="ways-desktop-title">' + escapeHtml(kit.name) + '</h3><span class="ways-where">on your computer</span></header>',
      row("Start from", "Raw reads: FASTQ, FASTA or SAM, plus a reference"),
      row("Pipeline", "Bowtie2 mapping → hybrid calling → QC → .hyb"),
      row("Analysis", "The same pages, saved as projects on disk"),
      row("CPLfold", "Set by memory, " + kit.limits.cplfoldText + "; native, no capacity test"),
      row("Install", kit.downloadsAvailable ? "An installer, below" : "An installer, not public yet"),
      row("Data", "Stays on this computer, works offline"),
      '      <div class="ways-actions">',
      renderDesktopDownloads(),
      "      </div>",
      "    </section>",
      "  </div>",
      "</section>"
    ].join("");
  }

  // The four browser checks that used to be the "Browser capabilities" card.
  function renderBrowserCheck() {
    const hasFiles = typeof window.File !== "undefined" && typeof window.FileReader !== "undefined";
    const hasWorker = typeof window.Worker !== "undefined";
    const hasWasm = typeof window.WebAssembly !== "undefined";
    const supported = [hasFiles, hasWorker, hasWasm, hasWorker && hasWasm].filter(Boolean).length;
    const status = function (ready, label, supportedLabel) {
      return '<li class="web-capability-item"><span class="web-capability-dot' + (ready ? ' is-ready' : '') + '" aria-hidden="true"></span><span>' + label + '</span><strong>' + (ready ? (supportedLabel || 'Supported') : 'Unavailable') + '</strong></li>';
    };
    return [
      '<details class="ways-browser-check" data-open-key="landing-browser-check"' + (window.RNAxRayOpenSections && window.RNAxRayOpenSections["landing-browser-check"] ? " open" : "") + ">",
      '<summary>Browser check <span class="ways-check-chip">' + (supported === 4 ? "all 4 supported" : supported + " of 4 supported") + "</span></summary>",
      '<ul class="web-capability-list">',
      status(hasFiles, 'File reading'),
      status(hasWorker, 'Background parsing workers'),
      status(hasWasm, 'ViennaRNA WebAssembly folding', 'Load on first run'),
      status(hasWorker && hasWasm, 'CPLfold Pyodide worker · capacity measured when needed', 'Load on first run'),
      '</ul>',
      '<p class="web-capability-note">These checks confirm browser support. Folding engines are loaded and verified when first used; CPLfold capacity is measured separately.</p>',
      "</details>"
    ].join("");
  }

  // Where to get RNAxRay Desktop (A14). With the installers public (K9
  // downloadsAvailable): one "Download for <this system>" button, the other
  // systems as plain links (Linux .deb and .tar.gz together), the systems
  // without an installer, a first-launch note for the unsigned app,
  // checksums and release notes. While they are not public, it says so,
  // lists the planned installers and links nowhere.
  function renderDesktopDownloads(options) {
    const kit = desktopKit();
    const settings = options || {};
    const groups = [
      { os: "mac", name: "macOS" },
      { os: "windows", name: "Windows" },
      { os: "linux", name: "Linux" }
    ].map(function (group) {
      group.platforms = kit.platforms.filter(function (item) { return item.os === group.os; });
      return group;
    });

    if (!kit.downloadsAvailable) {
      const planned = groups.map(function (group) {
        return group.platforms.length > 1
          ? group.name + " (" + group.platforms.map(function (item) { return item.label.split(" · ").pop(); }).join(", ") + ")"
          : group.platforms[0].label;
      });
      return [
        '<div class="desktop-downloads is-unavailable">',
        '<p class="desktop-downloads-status"><strong>' + escapeHtml(kit.notAvailable) + "</strong>" + (settings.tagline === false ? "" : " " + escapeHtml(kit.tagline)) + "</p>",
        '<p class="desktop-downloads-planned">Installers planned for ' + escapeHtml(planned.join(", ")) + ". " + escapeHtml(kit.unavailable) + "</p>",
        "</div>"
      ].join("");
    }

    const mine = kit.detectPlatform();
    const link = function (item, primary) {
      return '<a class="' + (primary ? "button desktop-download-primary" : "desktop-download-link") + '" href="' + escapeAttribute(kit.downloadUrl(item)) +
        '" data-platform="' + escapeAttribute(item.id) + '"' + (primary ? "" : ' aria-label="Download for ' + escapeAttribute(item.label) + '"') + ">" +
        (primary ? "Download for " + escapeHtml(item.label) : escapeHtml(item.label.split(" · ").pop())) + "</a>";
    };
    let choices;
    if (mine) {
      const others = groups.map(function (group) {
        const items = group.platforms.filter(function (item) { return item.id !== mine.id; });
        return items.length ? '<span class="desktop-download-group"><span>' + escapeHtml(group.name) + "</span> " + items.map(function (item) { return link(item); }).join(" ") + "</span>" : "";
      }).filter(Boolean);
      choices = link(mine, true) +
        (others.length ? '<p class="desktop-download-others">Download for another system: ' + others.join('<span aria-hidden="true"> · </span>') + "</p>" : "");
    } else {
      choices = '<div class="desktop-download-groups">' + groups.map(function (group) {
        return '<div class="desktop-download-group"><span>' + escapeHtml(group.name) + "</span>" +
          group.platforms.map(function (item) {
            return '<a class="button button-secondary button-compact desktop-download-link" href="' + escapeAttribute(kit.downloadUrl(item)) + '" data-platform="' + escapeAttribute(item.id) + '" aria-label="Download for ' + escapeAttribute(item.label) + '">Download ' +
              escapeHtml(group.platforms.length > 1 ? item.label.split(" · ").pop() : "") + "</a>";
          }).join("") + "</div>";
      }).join("") + "</div>";
    }
    const versions = desktopVersions(kit);
    return [
      '<div class="desktop-downloads">',
      versions.latest,
      choices,
      '<p class="desktop-download-unavailable">' + escapeHtml(kit.unavailable) + "</p>",
      '<details class="desktop-first-launch" data-open-key="desktop-first-launch"' + (window.RNAxRayOpenSections && window.RNAxRayOpenSections["desktop-first-launch"] ? " open" : "") + ">",
      "<summary>First launch (unsigned app)</summary>",
      "<p><strong>macOS:</strong> the first time, macOS blocks the app. Open System Settings → Privacy &amp; Security and choose Open Anyway next to RNAxRay Desktop.</p>",
      "<p><strong>Windows:</strong> SmartScreen may warn about an unrecognised app. Choose More info → Run anyway.</p>",
      "</details>",
      '<p class="desktop-download-meta"><a href="' + escapeAttribute(kit.checksumsUrl()) + '">Checksums (' + escapeHtml(kit.checksumsFile) + ")</a>" +
        '<span aria-hidden="true"> · </span><a href="' + escapeAttribute(kit.releasesUrl + "/latest") + '">Release notes</a>' +
        '<span aria-hidden="true"> · </span><a href="' + escapeAttribute(kit.releasesUrl) + '">All releases</a></p>',
      versions.earlier,
      "</div>"
    ].join("");
  }

  // The latest version, over the downloads, and the earlier versions
  // (web/releases.js, written when the site is deployed), each with the
  // installers it has, in a closed <details> under them.
  function desktopVersions(kit) {
    const releases = kit.releases();
    if (!releases.length) {
      return { latest: "", earlier: "" };
    }
    const date = function (release) {
      const parsed = release.published ? new Date(release.published + "T00:00:00Z") : null;
      return parsed && !isNaN(parsed) ? parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "";
    };
    const versionLine = function (release) {
      const files = kit.platforms.filter(function (item) { return release.files.indexOf(item.file) !== -1; });
      const links = files.map(function (item) {
        return '<a class="desktop-download-link" href="' + escapeAttribute(kit.releaseDownloadUrl(release.tag, item)) + '" data-platform="' + escapeAttribute(item.id) +
          '" aria-label="Download ' + escapeAttribute(release.tag) + " for " + escapeAttribute(item.label) + '">' + escapeHtml(item.label) + "</a>";
      });
      links.push('<a class="desktop-download-link" href="' + escapeAttribute(kit.releasesUrl + "/tag/" + encodeURIComponent(release.tag)) + '">Release notes</a>');
      return '<li><span class="desktop-version-name">' + escapeHtml(release.tag) + "</span>" +
        (date(release) ? ' <span class="desktop-version-date">' + escapeHtml(date(release)) + "</span>" : "") +
        '<span class="desktop-version-links">' + links.join('<span aria-hidden="true"> · </span>') + "</span></li>";
    };
    const latest = releases[0];
    const earlier = releases.slice(1);
    return {
      latest: '<p class="desktop-download-version">Latest version <strong>' + escapeHtml(latest.tag) + "</strong>" + (date(latest) ? ", " + escapeHtml(date(latest)) : "") + "</p>",
      earlier: earlier.length ? '<details class="desktop-versions" data-open-key="desktop-versions"' + (window.RNAxRayOpenSections && window.RNAxRayOpenSections["desktop-versions"] ? " open" : "") + ">" +
        "<summary>Earlier versions (" + earlier.length + ")</summary>" +
        '<ul class="desktop-version-list">' + earlier.map(versionLine).join("") + "</ul></details>" : ""
    };
  }

  function renderBrand() {
    const logoAsset = state.theme === "dark"
      ? (window.RNAXRAY_ASSET_BASE || "./") + "assets/rnaxray-wordmark-dark.svg"
      : (window.RNAXRAY_ASSET_BASE || "./") + "assets/rnaxray-wordmark.svg";
    return [
      '<a class="brand" href="#/" aria-label="RNAxRay Web home">',
      '  <span class="brand-mark"><img src="' + logoAsset + '" alt="RNAxRay"></span>',
      "  <span>",
      '    <span class="brand-name">Web</span>',
      "  </span>",
      "</a>"
    ].join("");
  }

  function renderFilePanel() {
    if (state.loading) {
      return renderLoadingPanel();
    }

    if (state.error) {
      const error = state.error;
      return [
        '<div class="file-card"><div class="file-card-inner load-state">',
        '  <div class="parse-error" role="alert"><strong>' + escapeHtml(error.title) + "</strong><br>" +
          (error.fileName ? escapeHtml(error.fileName) + ": " : "") + escapeHtml(error.message) +
          (error.detail ? '<span class="parse-error-detail">' + escapeHtml(error.detail) + "</span>" : "") + "</div>",
        error.hint ? '  <p class="parse-error-hint">' + escapeHtml(error.hint) + (error.rawReadsHint && rawReadsSentenceHtml() ? " " + rawReadsSentenceHtml() : "") + "</p>" : "",
        '  <div class="dialog-actions load-error-actions">',
        '    <button class="quiet-button" type="button" data-action="reload-page">Reload page</button>',
        error.source === "example"
          ? '    <button class="button button-secondary" type="button" data-action="reset-file">Choose a file instead</button>' +
            '    <button class="button" type="button" data-action="load-example">Try again</button>'
          : '    <button class="button button-secondary" type="button" data-action="load-example">Try the example instead</button>' +
            '    <button class="button" type="button" data-action="reset-file">Choose another file</button>',
        "  </div>",
        "</div></div>"
      ].join("");
    }

    if (state.rawReads && !state.analysisEntered) {
      return renderRawReadsPanel();
    }

    if (state.summary && !state.analysisEntered) {
      return renderPreparedFilePanel();
    }

    const landingFastaFile = state.landingFastaFile;
    return [
      '<div class="file-card"><div class="file-card-inner">',
      '  <div class="file-card-header">',
      "    <div>",
      "      <h2>Start with interaction data</h2>",
      "      <p>Choose one HYB file. After it is parsed, you can add a reference FASTA before entering analysis.</p>",
      "    </div>",
      "  </div>",
      '  <input id="hyb-file-input" class="visually-hidden" type="file" accept=".hyb,.txt,.gz,text/plain" aria-label="Choose a HYB file">',
      '  <input id="fasta-file-input" class="visually-hidden" type="file" accept=".fa,.fasta,.fna,.fas,text/plain" aria-label="Choose an optional reference FASTA file">',
      '  <div class="dropzone" data-dropzone tabindex="0" aria-label="HYB input drop zone" aria-describedby="file-input-hint">',
      '    <div class="dropzone-content">',
      '      <span class="dropzone-kicker">HYB input</span>',
      '      <h3 class="dropzone-title">Drop a .hyb file here</h3>',
      '      <p class="dropzone-copy">or choose a file from this device</p>',
      '      <button class="button" type="button" data-action="choose-hyb">Choose HYB file</button>',
      '      <span id="file-input-hint" class="dropzone-hint">Accepts .hyb and tab-delimited .txt files (hyb pipeline output, 15+ columns per line), also gzip-compressed (.gz).</span>',
      rawReadsSentenceHtml() ? '      <p class="dropzone-desktop">' + rawReadsSentenceHtml() + "</p>" : "",
      "    </div>",
      "  </div>",
      renderExampleStrip(),
      '  <section class="reference-upload" aria-labelledby="reference-upload-title">',
      '    <div class="reference-upload-copy">',
      '      <span class="reference-upload-kicker">Optional reference</span>',
      '      <h3 id="reference-upload-title">Add a FASTA for RNA structure</h3>',
      '      <p>Choose it now, after HYB parsing, or later from the workspace.</p>',
      "    </div>",
      '    <div class="reference-upload-actions">',
      '      <span class="reference-file-name' + (landingFastaFile ? "" : " is-empty") + '" title="' + escapeAttribute(landingFastaFile ? landingFastaFile.name : "No FASTA selected") + '">' + escapeHtml(landingFastaFile ? landingFastaFile.name : "No FASTA selected") + "</span>",
      '      <button class="button button-secondary button-compact" type="button" data-action="choose-fasta">' + (landingFastaFile ? "Replace FASTA" : "Choose FASTA") + "</button>",
      landingFastaFile ? '      <button class="quiet-button" type="button" data-action="remove-landing-fasta">Remove</button>' : "",
      "    </div>",
      "  </section>",
      '  <p class="privacy-note">Files are read and processed locally in this browser. This page has no upload endpoint.</p>',
      '  <p class="card-footnote">Recommended working size: up to 50 MB. Larger files are streamed to a dedicated worker to keep the interface responsive.</p>',
      "</div></div>"
    ].join("");
  }

  function renderExampleStrip() {
    if (!example) {
      return "";
    }
    return [
      '  <section class="example-strip" aria-labelledby="example-title">',
      '    <div class="example-line">',
      '      <p id="example-title" class="example-line-copy"><strong>No data yet?</strong> Try the ZIKV virion example, ZAFR vs ZASI.</p>',
      '      <button class="button button-secondary" type="button" data-action="load-example">Try example</button>',
      "    </div>",
      '    <details class="example-more" data-open-key="landing-example"' + (window.RNAxRayOpenSections && window.RNAxRayOpenSections["landing-example"] ? " open" : "") + '>',
      '      <summary>What the example contains</summary>',
      '      <span class="example-badge">1-in-10 subset · 4 replicates</span>',
      '      <p class="example-copy">ZIKV virion RNA of the African lineage (ZAFR, replicates 1 and 2) and the Asian lineage (ZASI = ZILM, French Polynesian isolate, replicates 2 and 3): every 10th record of each replicate .hyb (133,457 records, 6.9 MB compressed), each on its own genome. The primary file is ZAFR replicate 1; the Compare page gets all four replicates (10-nt bins, similarity minimum 10) and an arc map preloaded with CPLfold pseudoknot-free genome folds of both lineages and the NC_035889 gene track. Running the differential test there fills every panel of the summary figure. Because the data are a subset, the panels reproduce the method, not the published numbers.</p>',
      '      <div class="example-files" aria-label="Included example files">',
      example.downloads.map(function (item) {
        return '        <div class="example-file"><span class="example-file-kind">' + escapeHtml(item.kind) + '</span><code title="' + escapeAttribute(item.note) + '">' + escapeHtml(item.file) +
          '</code><a class="example-file-link" href="' + escapeAttribute(example.url(item.file)) + '" download aria-label="Download ' + escapeAttribute(item.file) + '">Download</a></div>';
      }).join(""),
      "      </div>",
      '      <p class="example-note">Fetched only when you start it; decompressed and parsed in this tab.</p>',
      "    </details>",
      "  </section>"
    ].join("");
  }

  function renderExampleSetup() {
    const setup = state.exampleSetup;
    if (!setup) {
      return "";
    }
    const text = setup.error
      ? "Example comparison setup stopped: " + setup.error
      : (setup.ready
        ? "Compare page ready: " + example.labels.A + " (ZAFR_REP1, ZAFR_REP2) vs " + example.labels.B + " (ZILM_REP2, ZILM_REP3), 10-nt bins, similarity minimum 10; the arc map has both CPLfold structures and the gene track. On the Compare page, run the differential test to find which contacts differ and to fill the figure panels that depend on it."
        : setup.stage + (setup.total ? " (" + formatNumber(setup.done) + " of " + formatNumber(setup.total) + ")" : "") + "…");
    return '  <p class="prepared-file-note example-setup' + (setup.error ? " is-error" : "") + '" aria-live="polite"><strong>Example.</strong> ' + escapeHtml(text) + "</p>" +
      (setup.error
        ? '  <div class="load-error-actions example-setup-actions"><button class="quiet-button" type="button" data-action="reload-page">Reload page</button><button class="button button-secondary" type="button" data-action="load-example">Load the example again</button></div>'
        : "");
  }

  // The example's other files (replicates for Compare, arc map files) as
  // rows under the primary HYB and FASTA, so the list shows the whole
  // comparison and not only the primary dataset.
  function renderExampleFileRows() {
    const setup = state.exampleSetup;
    if (!example || !setup) {
      return "";
    }
    const datasets = state.comparison && state.comparison.datasets || [];
    const parsing = setup.stage === "Parsing the other replicates";
    const status = function (index) {
      if (setup.ready) {
        return '<span class="prepared-file-status is-ready">Ready</span>';
      }
      if (setup.error) {
        return '<span class="prepared-file-status is-error">Stopped</span>';
      }
      if (index !== undefined && !parsing) {
        return '<span class="prepared-file-status is-loading">' + (index < setup.done ? "Downloaded" : "Downloading") + "</span>";
      }
      if (index !== undefined) {
        return '<span class="prepared-file-status is-loading">Parsing</span>';
      }
      // the arc map files are loaded before the replicates are parsed
      return parsing
        ? '<span class="prepared-file-status is-ready">Ready</span>'
        : '<span class="prepared-file-status is-loading">Downloading</span>';
    };
    const row = function (kind, file, detail, statusMarkup) {
      return [
        '    <div class="prepared-file-row prepared-file-row-example">',
        '      <span class="prepared-file-kind' + (kind === "HYB" ? " prepared-file-kind-hyb" : " prepared-file-kind-structure") + '">' + escapeHtml(kind) + "</span>",
        '      <div class="prepared-file-details"><strong title="' + escapeAttribute(file) + '">' + escapeHtml(file) + "</strong><span>" + escapeHtml(detail) + "</span></div>",
        "      " + statusMarkup,
        "    </div>"
      ].join("");
    };
    const rows = example.replicates.map(function (item, index) {
      const dataset = datasets.find(function (entry) { return entry.fileName === item.file; });
      const records = dataset && dataset.summary ? dataset.summary.validRecords : item.records;
      return row("HYB", item.file, item.label + " · Compare, condition " + item.condition + " (" + example.labels[item.condition] + ") · " + formatNumber(records) + " records", status(index));
    });
    [
      { file: example.arcMap.a, detail: "Arc map structure A · CPLfold genome fold, " + example.labels.A },
      { file: example.arcMap.b, detail: "Arc map structure B · CPLfold genome fold, " + example.labels.B },
      { file: example.arcMap.annotation, detail: "Arc map gene track · GenBank" }
    ].forEach(function (item) {
      rows.push(row(item.file.split(".").pop().toUpperCase(), item.file, item.detail, status()));
    });
    // Folded to one line: the review step stays short enough for Enter
    // analysis and the primary files to fit the first screen.
    const count = rows.length;
    const summaryStatus = setup.ready
      ? '<span class="prepared-file-status is-ready">Ready</span>'
      : (setup.error
        ? '<span class="prepared-file-status is-error">Stopped</span>'
        : '<span class="prepared-file-status is-loading">' + (parsing ? "Parsing" : "Downloading") + "</span>");
    const openKey = "prepared-example-files";
    return [
      '  <details class="prepared-file-list prepared-file-list-example" data-open-key="' + openKey + '"' + (window.RNAxRayOpenSections && window.RNAxRayOpenSections[openKey] ? " open" : "") + ' aria-label="Example files for the Compare page">',
      '    <summary class="prepared-file-row prepared-file-summary">',
      '      <span class="prepared-file-kind prepared-file-kind-structure">+' + count + "</span>",
      '      <div class="prepared-file-details"><strong>' + count + " files " + (setup.ready ? "loaded" : "loading") + " for Compare</strong><span>Example comparison " + escapeHtml(example.labels.A) + " vs " + escapeHtml(example.labels.B) + " · " + example.replicates.length + " more replicates, 2 arc map structures, gene track</span></div>",
      "      " + summaryStatus,
      "    </summary>",
      rows.join(""),
      "  </details>"
    ].join("");
  }

  function renderPreparedFilePanel() {
    const summary = state.summary || {};
    const fasta = state.fasta;
    const fastaLoad = state.fastaLoadSession;
    const loadingFile = fastaLoad && fastaLoad.file;
    const fastaFileName = loadingFile && loadingFile.name || (fasta && fasta.fileName) || "No FASTA selected";
    const mappedCount = fasta
      ? Object.keys(fasta.mapping || {}).filter(function (rna) { return fasta.mapping[rna]; }).length
      : 0;
    const sequenceCount = fasta && Array.isArray(fasta.sequences) ? fasta.sequences.length : 0;
    const fastaStatus = fastaLoad
      ? (fasta ? "Updating" : "Reading")
      : (fasta ? "Ready" : "Optional");
    const fastaDetail = fastaLoad
      ? "The reference file will remain available while you enter the workspace."
      : (fasta ? formatNumber(sequenceCount) + " sequence" + (sequenceCount === 1 ? "" : "s") + " · " + formatNumber(mappedCount) + " RNA mapping" + (mappedCount === 1 ? "" : "s") : "Needed for reference-based RNA structure and full-reference Viewpoint.");
    return [
      '<div class="file-card"><div class="file-card-inner prepared-file-card">',
      '  <div class="file-card-header">',
      "    <div>",
      '      <span class="file-card-kicker">Step 1 complete</span>',
      '      <h2>Review files before analysis</h2>',
      '      <p>The HYB file is parsed. Add an optional reference FASTA now, then open the analysis workspace when you are ready.</p>',
      "    </div>",
      '    <span class="status-chip">Files ready</span>',
      "  </div>",
      '  <section class="prepared-next-step" aria-label="Enter analysis workspace">',
      '    <div><span class="file-card-kicker">Step 2</span><strong>Open the analysis workspace</strong><span>Overview, interactions, contact maps, Compare, RNA structure and the report.</span></div>',
      '    <button class="button" type="button" data-action="enter-analysis">Enter analysis</button>',
      "  </section>",
      '  <section class="prepared-file-list" aria-label="Files ready for analysis">',
      '    <div class="prepared-file-row">',
      '      <span class="prepared-file-kind prepared-file-kind-hyb">HYB</span>',
      '      <div class="prepared-file-details"><strong title="' + escapeAttribute(summary.fileName || "HYB file") + '">' + escapeHtml(summary.fileName || "HYB file") + '</strong><span>' + (example && state.exampleSetup ? escapeHtml("Primary dataset, condition " + example.primary.condition + " (" + example.labels[example.primary.condition] + ")") + " · " : "") + formatBytes(summary.fileSize) + " · " + formatNumber(summary.validRecords) + ' valid records</span></div>',
      '      <span class="prepared-file-status is-ready">Ready</span>',
      "    </div>",
      '    <div class="prepared-file-row prepared-file-row-reference">',
      '      <span class="prepared-file-kind prepared-file-kind-fasta">FASTA</span>',
      '      <div class="prepared-file-details"><strong' + (fasta || loadingFile ? "" : ' class="is-empty"') + ' title="' + escapeAttribute(fastaFileName) + '">' + escapeHtml(fastaFileName) + '</strong><span>' + escapeHtml(fastaDetail) + '</span></div>',
      '      <span class="prepared-file-status' + (fastaLoad ? " is-loading" : (fasta ? " is-ready" : " is-optional")) + '">' + fastaStatus + '</span>',
      '      <button class="button button-secondary button-compact" type="button" data-action="choose-fasta">' + (fasta || fastaLoad ? "Replace FASTA" : "Add FASTA") + '</button>',
      "    </div>",
      "  </section>",
      renderExampleFileRows(),
      '  <p class="prepared-file-note"><strong>FASTA is optional.</strong> Interaction tables and contact maps can run without it; reference-based structure and full-reference coordinate views need a mapped sequence. You can also add or replace it later from the Files panel.</p>',
      renderExampleSetup(),
      '  <div class="prepared-file-actions"><button class="button button-secondary" type="button" data-action="reset-file">Choose another HYB</button></div>',
      '  <input id="fasta-file-input" class="visually-hidden" type="file" accept=".fa,.fasta,.fna,.fas,text/plain" aria-label="Choose an optional reference FASTA file">',
      '  <p class="privacy-note">Files are read and processed locally in this browser. This page has no upload endpoint.</p>',
      "</div></div>"
    ].join("");
  }

  function renderLoadingPanel() {
    const load = state.loading;
    const percent = Math.max(0, Math.min(100, load.percent || 0));
    const stages = [
      "Loading example files",
      "Reading file",
      "Detecting format",
      "Parsing HYB records",
      "Building summary"
    ];
    const stageIndex = load.stage === "Loading example files" ? 0 : load.stage === "Reading file" ? 1 : load.stage === "Detecting format" ? 2 : load.stage === "Building summary" ? 4 : 3;

    return [
      '<div class="file-card"><div class="file-card-inner load-state">',
      '  <p class="load-file-name" title="' + escapeAttribute(load.fileName) + '">' + escapeHtml(load.fileName) + "</p>",
      '  <p class="load-status">' + escapeHtml(load.stage) + " · " + formatNumber(load.parsedRecords || 0) + " valid records found</p>",
      '  <div class="progress-bar" role="progressbar" aria-label="Local HYB parsing progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><span style="width:' + percent + '%"></span></div>',
      '  <ol class="parse-steps">',
      stages.map(function (stage, index) {
        const className = index < stageIndex ? " is-complete" : index === stageIndex ? " is-current" : "";
        return '<li class="parse-step' + className + '">' + stage + "</li>";
      }).join(""),
      "  </ol>",
      '  <p class="card-footnote" aria-live="polite">' + (load.totalBytes ? formatBytes(load.processedBytes || 0) + " of " + formatBytes(load.totalBytes || 0) + " read" : "Preparing the included example") + "</p>",
      "</div></div>"
    ].join("");
  }

  // shell:false — analysis pages only; the host renders navigation and data
  // selection and switches pages through the mount controller.
  function renderEmbedded(workspaceOpen) {
    app.dataset.density = state.density;
    if (!workspaceOpen) {
      const error = state.view && state.view.errors && state.view.errors.base;
      const hasSelection = !!(state.selection && state.selection.datasetIds && state.selection.datasetIds.length);
      app.innerHTML = [
        '<div class="embedded-status placeholder-card"><div class="placeholder-inner">',
        '<span class="placeholder-label">Analysis</span>',
        "<h2>" + escapeHtml(error ? "The analysis data could not be loaded." : (hasSelection ? "Loading analysis data…" : "Select a dataset to analyse.")) + "</h2>",
        error ? "<p>" + escapeHtml(error) + "</p>" : "",
        "</div></div>"
      ].join("");
      renderedPage = null;
      return;
    }
    app.innerHTML = [
      '<div class="workspace workspace-embedded">',
      '  <main class="workspace-main" aria-label="' + escapeAttribute(pageTitle(state.activePage)) + '">',
      '    <div class="content-wrap">',
      renderPage(),
      "    </div>",
      "  </main>",
      '  <div id="toast" class="toast" role="status" aria-live="polite"></div>',
      "</div>"
    ].join("");
    renderedPage = state.activePage;
    if (window.RNAxRayUI) {
      window.RNAxRayUI.afterRender(state, featureApi());
    }
    if (state.activePage === "report" && window.RNAxRayReport && typeof window.RNAxRayReport.afterRender === "function") {
      window.RNAxRayReport.afterRender(state, featureApi());
    }
    if (window.RNAxRayWeb && typeof window.CustomEvent === "function") {
      window.dispatchEvent(new window.CustomEvent("rnaxray:session-change", { detail: window.RNAxRayWeb.getSessionSnapshot() }));
    }
  }

  function renderWorkspace() {
    return [
      '<div class="workspace">',
      renderWorkspaceHeader(),
      renderSidebar(),
      '  <main id="main-content" class="workspace-main">',
      '    <div class="content-wrap">',
      renderPage(),
      "    </div>",
      "  </main>",
      renderMobileNav(),
      renderDialog(),
      '  <input id="hyb-file-input" class="visually-hidden" type="file" accept=".hyb,.txt,.gz,text/plain" aria-label="Replace HYB file">',
      '  <input id="comparison-file-input" class="visually-hidden" type="file" accept=".hyb,.txt,.gz,text/plain" multiple aria-label="Add HYB datasets for comparison">',
      '  <input id="fasta-file-input" class="visually-hidden" type="file" accept=".fa,.fasta,.fna,.fas,text/plain" aria-label="Choose a reference FASTA file">',
      '  <div id="toast" class="toast" role="status" aria-live="polite"></div>',
      "</div>"
    ].join("");
  }

  function renderWorkspaceHeader() {
    const summary = state.summary;
    return [
      '  <header class="workspace-header">',
      '    <div class="workspace-header-left">',
      renderBrand(),
      '      <div class="header-file">',
      '        <span class="header-file-name" title="' + escapeAttribute(summary.fileName) + '">' + escapeHtml(summary.fileName) + "</span>",
      '        <span class="ready-chip">Ready</span>',
      renderHeaderDatasets(),
      "      </div>",
      "    </div>",
      '    <div class="toolbar-actions">',
      '      <button class="local-chip" type="button" data-action="open-privacy" title="What stays on this device">Local only</button>',
      '      <span class="toolbar-divider" aria-hidden="true"></span>',
      '      <button class="text-button" type="button" data-action="open-files">Data</button>',
      '      <button class="text-button report-button" type="button" data-action="navigate" data-page="report">Report</button>',
      '      <span class="toolbar-divider" aria-hidden="true"></span>',
      desktopEntriesShown() ? '      <button class="text-button desktop-entry" type="button" data-action="open-desktop">Desktop app</button>' : "",
      '      <button class="text-button" type="button" data-action="open-help">Help</button>',
      renderDisplayButton(),
      "    </div>",
      "  </header>"
    ].join("");
  }

  // The primary file is one of several when Compare has more datasets (the
  // example loads four replicates): say so next to its name.
  function renderHeaderDatasets() {
    const others = (state.comparison && state.comparison.datasets || []).filter(function (dataset) {
      return dataset.id !== PRIMARY_DATASET_ID;
    });
    if (!others.length) {
      return "";
    }
    const names = others.map(function (dataset) { return dataset.fileName; }).join(", ");
    return '        <button class="header-datasets" type="button" data-action="navigate" data-page="compare" title="' + escapeAttribute("Also on the Compare page: " + names) + '">+' + formatNumber(others.length) + " dataset" + (others.length === 1 ? "" : "s") + " on Compare</button>";
  }

  function renderSidebarDatasets() {
    const comparison = state.comparison || {};
    const others = (comparison.datasets || []).filter(function (dataset) { return dataset.id !== PRIMARY_DATASET_ID; });
    if (!others.length) {
      return "";
    }
    const label = function (condition) {
      return (condition === "B" ? comparison.conditionBLabel : comparison.conditionALabel) || "Condition " + (condition === "B" ? "B" : "A");
    };
    const count = function (condition) {
      return (comparison.datasets || []).filter(function (dataset) { return (dataset.condition === "B" ? "B" : "A") === condition; }).length;
    };
    return '      <span class="sidebar-file-info sidebar-file-compare" title="' + escapeAttribute(others.map(function (dataset) { return dataset.fileName; }).join(", ")) + '">Compare: ' + escapeHtml(label("A")) + " ×" + count("A") + " vs " + escapeHtml(label("B")) + " ×" + count("B") + "</span>";
  }

  function renderDisplayButton() {
    return '      <button class="icon-button display-button" type="button" data-action="open-display" aria-label="Display settings" title="Display settings"><svg viewBox="0 0 20 20" aria-hidden="true" class="display-icon"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/></svg></button>';
  }

  function renderSidebar() {
    const summary = state.summary;
    return [
      '  <aside class="sidebar" aria-label="Workspace navigation">',
      '    <div class="sidebar-file">',
      '      <span class="sidebar-label">Data</span>',
      '      <span class="sidebar-file-name" title="' + escapeAttribute(summary.fileName) + '">' + escapeHtml(summary.fileName) + "</span>",
      '      <span class="sidebar-file-info">' + formatBytes(summary.fileSize) + " · " + formatNumber(summary.validRecords) + " records</span>",
      renderSidebarDatasets(),
      "    </div>",
      '    <nav class="sidebar-nav" aria-label="Analysis">',
      '      <span class="nav-label">Analysis</span>',
      analysisPages.map(renderNavButton).join(""),
      "    </nav>",
      '    <nav class="sidebar-nav" aria-label="Session">',
      '      <span class="nav-label">Session</span>',
      renderActionNavButton("open-files", "Data", "DA"),
      renderNavButton({ id: "validation", label: "Import check", shortLabel: "IC" }),
      renderNavButton(reportPage),
      "    </nav>",
      '    <nav class="sidebar-nav" aria-label="Reference">',
      '      <span class="nav-label">Reference</span>',
      renderNavButton({ id: "methods", label: "Methods", shortLabel: "MT" }),
      renderNavButton({ id: "file-format", label: "File format", shortLabel: "FF" }),
      renderNavButton({ id: "privacy", label: "Privacy", shortLabel: "PR" }),
      "    </nav>",
      "  </aside>"
    ].join("");
  }

  function renderMobileNav() {
    return [
      '<nav class="mobile-nav" aria-label="Analysis">',
      workspacePages.map(renderNavButton).join(""),
      "</nav>"
    ].join("");
  }

  // The phone nav is rebuilt on every render: put it back where it was,
  // then bring the current page's tab to the middle (smoothly only when the
  // page changed and motion is allowed). Scrolls the nav itself, never the
  // page, so it cannot interrupt the Report page's jump scrolling.
  function revealActiveMobileNav(previousScrollLeft, pageChanged) {
    const nav = typeof app.querySelector === "function" ? app.querySelector(".mobile-nav") : null;
    if (!nav || typeof nav.addEventListener !== "function") {
      return;
    }
    const updateEdges = function () {
      const max = nav.scrollWidth - nav.clientWidth;
      nav.classList.toggle("can-scroll-left", nav.scrollLeft > 2);
      nav.classList.toggle("can-scroll-right", nav.scrollLeft < max - 2);
    };
    nav.addEventListener("scroll", updateEdges, { passive: true });
    nav.scrollLeft = previousScrollLeft || 0;
    const active = nav.querySelector(".nav-button.is-active");
    if (!active || nav.scrollWidth <= nav.clientWidth) {
      updateEdges();
      return;
    }
    const target = Math.max(0, Math.min(nav.scrollWidth - nav.clientWidth,
      active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2));
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof nav.scrollTo === "function") {
      nav.scrollTo({ left: target, behavior: pageChanged && !reduce ? "smooth" : "auto" });
    } else {
      nav.scrollLeft = target;
    }
    updateEdges();
  }

  function renderNavButton(page) {
    const active = state.activePage === page.id ? " is-active" : "";
    const shortLabel = page.shortLabel || page.label.slice(0, 2).toUpperCase();
    const current = active ? ' aria-current="page"' : "";
    return '<button class="nav-button' + active + '" type="button" data-action="navigate" data-page="' + page.id + '" aria-label="' + escapeAttribute(page.label) + '" title="' + escapeAttribute(page.label) + '"' + current + '><span class="nav-button-label">' + escapeHtml(page.label) + '</span><span class="nav-button-short" aria-hidden="true">' + escapeHtml(shortLabel) + "</span></button>";
  }

  function renderActionNavButton(action, label, shortLabel) {
    return '<button class="nav-button" type="button" data-action="' + action + '" aria-label="' + escapeAttribute(label) + '" title="' + escapeAttribute(label) + '"><span class="nav-button-label">' + escapeHtml(label) + '</span><span class="nav-button-short" aria-hidden="true">' + escapeHtml(shortLabel) + "</span></button>";
  }

  function renderPage() {
    if (state.activePage === "overview") {
      return window.RNAxRayOverview.render(state);
    }

    if (state.activePage === "validation") {
      return window.RNAxRayOverview.renderValidation(state);
    }

    if (state.activePage === "methods") {
      return window.RNAxRayOverview.renderMethods();
    }

    if (state.activePage === "file-format") {
      return window.RNAxRayOverview.renderFileFormat();
    }

    if (state.activePage === "privacy") {
      return window.RNAxRayOverview.renderPrivacy();
    }

    if (state.activePage === "interactions") {
      return window.RNAxRayPages.renderInteractions(state);
    }

    if (state.activePage === "contact-map") {
      return window.RNAxRayPages.renderContactMap(state);
    }

    if (state.activePage === "viewpoint") {
      return window.RNAxRayPages.renderViewpoint(state);
    }

    if (state.activePage === "region") {
      return window.RNAxRayPages.renderRegion(state);
    }

    if (state.activePage === "compare") {
      return window.RNAxRayPages.renderComparison(state);
    }

    if (state.activePage === "structure") {
      return window.RNAxRayPages.renderStructure(state);
    }

    if (state.activePage === "report") {
      return window.RNAxRayReport
        ? window.RNAxRayReport.render(state)
        : '<section class="placeholder-card"><div class="placeholder-inner"><span class="placeholder-label">Report</span><h2>The report page is unavailable.</h2></div></section>';
    }

    return window.RNAxRayOverview.render(state);
  }

  function renderDialog() {
    if (!state.dialog) {
      return "";
    }

    if (state.dialog === "privacy") {
      return renderDrawer("privacy", "Your data stays on this device", "RNAxRay Web runs entirely in this browser tab. Nothing you load is uploaded.", [
        drawerSection("What happens to your files", "<ul class=\"drawer-list\">" +
          "<li>HYB and FASTA files are read by this tab; there is no upload step and no server.</li>" +
          "<li>Results are kept in this tab’s memory only. Refreshing the page or starting over removes them.</li>" +
          "<li>Nothing is stored in the browser between visits, and the site has no analytics.</li>" +
          "</ul>"),
        drawerSection("The one exception you control", "<p>Related research on the RNA Structure page is off by default. When you turn it on, only the identifier and species you confirm are sent to EBI (RNAcentral and Europe PMC).</p>"),
        state.analysisEntered ? '<div class="drawer-links"><button class="quiet-button" type="button" data-action="navigate" data-page="privacy">Read the full privacy notes</button></div>' : ""
      ].join(""));
    }

    if (state.dialog === "clear") {
      return [
        '<div class="pop-layer">',
        '  <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="clear-dialog-title" data-dialog>',
        '    <h2 id="clear-dialog-title">Start over?</h2>',
        "    <p>This removes every loaded file and result from this browser tab and returns to the start page. Export anything you want to keep first.</p>",
        '    <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancel</button><button class="button button-danger" type="button" data-action="confirm-clear">Start over</button></div>',
        "  </section>",
        "</div>"
      ].join("");
    }

    if (state.dialog === "files" && state.summary) {
      return renderDrawer("files", "Data", "The files this session is analysing, how their RNA names match the reference, and how to reproduce the results.",
        window.RNAxRayPages.getFilesDialogBody(state) +
        drawerSection("Start over", '<p>Removes every loaded file and result from this tab and returns to the start page.</p><div class="inline-actions"><button class="button button-danger" type="button" data-action="start-over">Start over…</button></div>', "drawer-danger"));
    }

    if (state.dialog === "raw-reads" && state.rawReads) {
      return renderDrawer("raw-reads", "This is a raw-read file", "The current analysis is unchanged.", '<div class="raw-reads-body">' + renderRawReadsBody(false) + "</div>");
    }

    if (state.dialog === "desktop" && desktopEntriesShown()) {
      const kit = desktopKit();
      const compare = function (label, web, desktop) {
        return "<tr><th scope=\"row\">" + escapeHtml(label) + "</th><td>" + escapeHtml(web) + "</td><td>" + escapeHtml(desktop) + "</td></tr>";
      };
      return renderDrawer("desktop", kit.name, kit.tagline, [
        drawerSection("What it does", '<ul class="drawer-list desktop-capabilities">' + kit.capabilities.map(function (item) {
          return "<li><strong>" + escapeHtml(item.title) + ".</strong> " + escapeHtml(item.text) + "</li>";
        }).join("") + "</ul>"),
        drawerSection("Web or Desktop", '<table class="desktop-compare"><thead><tr><th scope="col"><span class="visually-hidden">Question</span></th><th scope="col">Web</th><th scope="col">' + escapeHtml(kit.name) + "</th></tr></thead><tbody>" +
          compare("Start from", ".hyb files", "Raw reads (FASTQ, FASTA, SAM)") +
          compare("CPLfold", "Up to " + formatNt(kit.limits.webCplfoldNt) + " after a test", "Set by memory, " + kit.limits.cplfoldText) +
          compare("Data", "Stays in this tab", "Stays on this computer") +
          "</tbody></table>"),
        drawerSection(kit.downloadsAvailable ? "Download" : "Availability", renderDesktopDownloads({ tagline: false }))
      ].join(""));
    }

    if (state.dialog === "display") {
      const dark = state.theme === "dark";
      const reduced = document.documentElement.dataset.motion === "reduced";
      return renderDrawer("display", "Display", "How the workspace looks on this device. Results and exports are not affected.", [
        drawerSection("Theme", '<div class="segmented" role="group" aria-label="Theme"><button type="button" class="segmented-option' + (dark ? "" : " is-selected") + '" aria-pressed="' + !dark + '"' + (dark ? ' data-action="toggle-theme"' : "") + '>Light</button><button type="button" class="segmented-option' + (dark ? " is-selected" : "") + '" aria-pressed="' + dark + '"' + (dark ? "" : ' data-action="toggle-theme"') + ">Dark</button></div>"),
        drawerSection("Motion", '<div class="segmented" role="group" aria-label="Motion"><button type="button" class="segmented-option' + (reduced ? "" : " is-selected") + '" aria-pressed="' + !reduced + '"' + (reduced ? " data-motion-toggle" : "") + '>Animated</button><button type="button" class="segmented-option' + (reduced ? " is-selected" : "") + '" aria-pressed="' + reduced + '"' + (reduced ? "" : " data-motion-toggle") + ">Reduced</button></div><p>Reduced keeps every change instant; it follows your system setting until you choose here.</p>"),
        drawerSection("Table density", '<label class="control-field"><span class="visually-hidden">Table density</span><select id="density-input"><option value="comfortable"' + (state.density === "comfortable" ? " selected" : "") + '>Comfortable rows</option><option value="compact"' + (state.density === "compact" ? " selected" : "") + ">Compact rows</option></select></label><p>Compact fits more interaction records on screen.</p>")
      ].join(""));
    }

    return renderHelpDrawer();
  }

  // Data, Help, Display and Privacy open as the same right-hand drawer:
  // a title, one sentence on what it is for, then a few short sections.
  function renderDrawer(id, title, lede, body) {
    return [
      '<div class="pop-layer drawer-layer">',
      '  <section class="dialog drawer ' + id + '-drawer" role="dialog" aria-modal="true" aria-labelledby="' + id + '-dialog-title" data-dialog>',
      '    <header class="drawer-head"><div><h2 id="' + id + '-dialog-title">' + escapeHtml(title) + '</h2><p class="drawer-lede">' + escapeHtml(lede) + "</p></div>",
      '    <button class="icon-button drawer-close" type="button" data-action="close-dialog" aria-label="Close ' + escapeAttribute(title) + '">×</button></header>',
      '    <div class="drawer-body">' + body + "</div>",
      "  </section>",
      "</div>"
    ].join("");
  }

  function drawerSection(title, html, extraClass) {
    return '<section class="drawer-section' + (extraClass ? " " + extraClass : "") + '"><h3>' + escapeHtml(title) + "</h3>" + html + "</section>";
  }

  // What the current page shows, how to read it, and what to do next.
  const PAGE_HELP = {
    landing: ["Start a session", [
      "Drop a .hyb file (the output of the hyb pipeline) or press Try example to load the ZIKV virion comparison.",
      "Add a reference FASTA if you want sequences, region extraction and RNA structure prediction.",
      { html: rawReadsSentenceHtml }
    ]],
    overview: ["Overview", [
      "A summary of the loaded file: how many records, which RNAs and chimera types it contains.",
      "Top interacting RNAs counts each record once per arm, so an RNA paired with itself counts twice.",
      "Next: open Interactions to filter records, or Contact Map to see where on the RNA they fall."
    ]],
    interactions: ["Interactions", [
      "Every chimeric record in the file, one row each. Filter by RNA, partner or score.",
      "Click a row to see both arms, their coordinates and the read it came from.",
      "Export the filtered rows as CSV or HYB to continue in other tools."
    ]],
    "contact-map": ["Contact Map", [
      "Each cell counts records whose two arms fall in that pair of position bins (X: first RNA, Y: second).",
      "Bright cells are frequent contacts; a diagonal band is local folding, off-diagonal spots are long-range.",
      "Drag to zoom, click a cell to list its records, then send it to Region Explorer or RNA Structure."
    ]],
    viewpoint: ["Viewpoint", [
      "Pick one region of an RNA and see where along the RNA its partners bind.",
      "Peaks are positions that pair with your viewpoint more often than elsewhere.",
      "Click a bar to inspect those records."
    ]],
    region: ["Region Explorer", [
      "Enter a range of an RNA to list every record that touches it and its main partners.",
      "With a reference FASTA you also get the sequence, ready to copy or fold.",
      "Send the region to RNA Structure to predict its fold with these interactions as evidence."
    ]],
    compare: ["Compare", [
      "Contrast two conditions, each with biological replicates (the example: ZAFR vs ZASI).",
      "Only the differential test (panel A) says whether a contact differs; the other maps describe counts.",
      "Below it: arc maps of both structures, the strongest regions (D, E) and their folding energies (F, G)."
    ]],
    structure: ["RNA Structure", [
      "Predict a secondary structure for a region, optionally guided by the HYB contacts.",
      "Short sequences fold instantly; longer ones need the local capacity test first (the page says why).",
      "Related research, at the bottom, looks up public records for the RNA only if you turn it on."
    ]],
    report: ["Report", [
      "One printable page with every analysis you configured, plus the checks to make before reporting.",
      "Print or save it as PDF, or download the report data as JSON.",
      "It reflects the current session; change an analysis and the report follows."
    ]],
    validation: ["Import check", [
      "What the parser found while reading the file: valid, skipped and invalid rows, and the column layout.",
      "Invalid rows are listed with the reason, so you can fix the file at its source.",
      "Nothing here changes your data; it explains what was used."
    ]],
    methods: ["Methods", [
      "How each number on the analysis pages is calculated, in the order of the pages.",
      "Use it to describe the analysis in a paper or to check a result."
    ]],
    "file-format": ["File format", [
      "The columns RNAxRay expects in a .hyb file, and which optional columns it uses.",
      "Check this when a file is rejected or a column looks wrong."
    ]],
    privacy: ["Privacy", [
      "Where your data goes (nowhere outside this tab) and the one optional public lookup."
    ]]
  };

  function renderHelpDrawer() {
    const page = state.analysisEntered ? state.activePage : "landing";
    const entry = PAGE_HELP[page] || PAGE_HELP.overview;
    const kit = desktopKit();
    const desktopLine = desktopEntriesShown() ? '<p class="drawer-desktop-line">' + kit.cta("overview") + "</p>" : "";
    const steps = entry[1].map(function (line) {
      // { html: fn } lines are built at render time (the raw-reads sentence)
      const html = typeof line === "string" ? escapeHtml(line) : line.html();
      return html ? "<li>" + html + "</li>" : "";
    });
    const body = [desktopLine, drawerSection("On this page: " + entry[0], '<ol class="drawer-steps">' + steps.join("") + "</ol>")];
    if (state.analysisEntered) {
      body.push(drawerSection("Keyboard", '<dl class="drawer-keys">' +
        "<div><dt><kbd>" + (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl") + "</kbd><kbd>K</kbd></dt><dd>Search pages and actions</dd></div>" +
        "<div><dt><kbd>g</kbd> then a letter</dt><dd>Go to a page (letters shown in the sidebar)</dd></div>" +
        "<div><dt><kbd>Esc</kbd></dt><dd>Close this panel or a record</dd></div></dl>", "drawer-keyboard"));
      body.push(drawerSection("Reference", '<div class="drawer-links">' +
        '<button class="quiet-button" type="button" data-action="navigate" data-page="methods">Methods</button>' +
        '<button class="quiet-button" type="button" data-action="navigate" data-page="file-format">File format</button>' +
        '<button class="quiet-button" type="button" data-action="navigate" data-page="validation">Import check</button>' +
        '<button class="quiet-button" type="button" data-action="navigate" data-page="privacy">Privacy</button></div>'));
    }
    return renderDrawer("help", "Help", "What this page shows, how to read it, and where to go next.", body.join(""));
  }

  function handleClick(event) {
    // K9 Desktop links (<a href="#rnaxray-desktop" data-action="open-desktop">)
    // and the header buttons: the drawer opens and the URL stays.
    const desktopLink = event.target.closest('[data-action="open-desktop"]');
    if (desktopLink) {
      event.preventDefault();
      const context = desktopLink.getAttribute && desktopLink.getAttribute("data-desktop-context");
      desktopReturnSelector = context
        ? '[data-action="open-desktop"][data-desktop-context="' + context + '"]'
        : '.desktop-entry[data-action="open-desktop"]';
      openDesktopDrawer();
      return;
    }

    const dialogLayer = event.target.closest(".pop-layer");
    if (dialogLayer && event.target === dialogLayer) {
      state.dialog = null;
      render();
      return;
    }

    // motion.js flips the preference after this handler; redraw the
    // Display panel's choice once it has.
    if (event.target.closest("[data-motion-toggle]")) {
      window.setTimeout(render, 0);
      return;
    }

    const featureNode = event.target.closest("[data-feature-action]");
    if (featureNode && window.RNAxRayUI.handleAction(state, featureNode, featureApi())) {
      return;
    }

    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) {
      return;
    }

    const action = actionNode.dataset.action;

    if (action === "app-download-placeholder") {
      event.preventDefault();
      showToast("Desktop app download is not available in this preview.");
      return;
    }

    if (action === "choose-hyb") {
      const input = document.getElementById("hyb-file-input");
      if (input) {
        input.click();
      }
      return;
    }

    if (action === "load-example") {
      loadExample();
      return;
    }

    if (action === "choose-fasta") {
      const input = document.getElementById("fasta-file-input");
      if (input) {
        input.click();
      }
      return;
    }

    if (action === "remove-landing-fasta") {
      state.landingFastaFile = null;
      render();
      return;
    }

    if (action === "open-privacy") {
      state.dialog = "privacy";
      render();
      return;
    }

    if (action === "open-help") {
      state.dialog = "help";
      render();
      return;
    }

    if (action === "open-files") {
      // "Review mapping" opens the Data panel at its name-matching section.
      if (actionNode.dataset && actionNode.dataset.openSection) {
        window.RNAxRayOpenSections[actionNode.dataset.openSection] = true;
      }
      state.dialog = "files";
      render();
      return;
    }

    if (action === "open-display" || action === "toggle-tweaks") {
      state.dialog = "display";
      render();
      return;
    }

    if (action === "dismiss-raw-reads") {
      state.rawReads = null;
      render();
      return;
    }

    if (action === "close-dialog") {
      if (state.dialog === "raw-reads") {
        state.rawReads = null;
      }
      state.dialog = null;
      render();
      return;
    }

    if (action === "toggle-theme") {
      state.theme = state.theme === "light" ? "dark" : "light";
      render();
      return;
    }


    if (action === "navigate") {
      if (typeof actionNode.closest === "function" && actionNode.closest("[data-dialog]")) {
        state.dialog = null;
      }
      navigate(actionNode.dataset.page);
      return;
    }

    if (action === "enter-analysis") {
      enterAnalysis();
      return;
    }

    if (action === "download-summary") {
      downloadSummary();
      return;
    }

    if (action === "download-rna-counts") {
      downloadRnaCounts();
      return;
    }

    if (action === "download-rna-pairs") {
      downloadRnaPairs();
      return;
    }

    if (action === "download-validation") {
      downloadValidationReport();
      return;
    }

    if (action === "print-report") {
      if (typeof window.print === "function") {
        window.print();
      }
      return;
    }

    if (action === "download-full-report") {
      downloadFullReport();
      return;
    }

    if (action === "report-jump") {
      event.preventDefault();
      // after any redraw this click causes, and instant: a smooth scroll
      // across a long report is cancelled by the next render
      const id = actionNode.dataset.target || "";
      window.requestAnimationFrame(function () {
        const target = document.getElementById(id);
        if (target) {
          target.scrollIntoView({ block: "start", behavior: "instant" });
        }
      });
      return;
    }

    if (action === "report-export") {
      openReportExport(actionNode.dataset.audience || "people");
      return;
    }

    if (action === "report-export-close") {
      state.reportExport = null;
      reportExportCache = null;
      render(REPORT_NOW);
      return;
    }

    if (action === "report-export-zip") {
      downloadReportZip();
      return;
    }

    if (action === "report-export-toggle") {
      toggleReportFile(actionNode.dataset.path || "");
      return;
    }

    if (action === "report-select" || action === "report-select-all") {
      // a selected-results report: the page and every export keep only the ticked steps
      const keys = window.RNAxRayResults ? window.RNAxRayResults.STEPS.map(function (spec) { return spec[1]; }) : [];
      if (action === "report-select-all") {
        state.reportSelection = null;
      } else {
        const selection = state.reportSelection || keys.reduce(function (all, key) { all[key] = true; return all; }, {});
        const key = actionNode.dataset.step || "";
        if (key && key !== "parse") {
          selection[key] = !selection[key];
        }
        state.reportSelection = keys.every(function (k) { return selection[k]; }) ? null : selection;
      }
      reportExportCache = null;
      state.reportExport = null;
      render(REPORT_NOW);
      return;
    }

    if (action === "report-export-file") {
      downloadReportFile(actionNode.dataset.audience || "analysis", actionNode.dataset.path || "");
      return;
    }

    if (action === "report-export-copy") {
      if (reportExportCache) {
        copyText(window.RNAxRayResults.reportMarkdown(reportExportCache.record), "AI summary (report.md) copied to the clipboard.");
      }
      return;
    }

    if (action === "report-export-html") {
      downloadOfflineReport();
      return;
    }

    if (action === "clear-session") {
      state.dialog = "clear";
      render();
      return;
    }

    // Start over (Data panel, search) asks first; confirming clears the
    // session and returns to the start page.
    if (action === "start-over") {
      state.dialog = "clear";
      render();
      return;
    }

    if (action === "confirm-clear") {
      resetToLanding();
      window.setTimeout(function () {
        showToast("Analysis cleared. Choose a HYB file to begin again.");
      }, 0);
      return;
    }

    if (action === "reset-file") {
      resetToLanding();
      return;
    }

    if (action === "reload-page") {
      window.location.reload();
      return;
    }

    if (action === "show-upcoming") {
      showToast(actionNode.dataset.target + " is outside this v0 preview.");
    }
  }

  function handlePointerDown(event) {
    state.pointerActionPending = !!event.target.closest("button, a, [data-feature-action], [data-action]");
  }

  function finishPointerAction(event) {
    if (event && event.target && event.target.matches && event.target.matches('input[type="file"]')) {
      return;
    }
    const pendingRender = state.pendingCommittedInputRender;
    state.pointerActionPending = false;
    state.pendingCommittedInputRender = false;
    if (!pendingRender) {
      return;
    }
    const target = event && event.target && event.target.closest
      ? event.target.closest("[data-feature-action], [data-action]")
      : null;
    const action = target ? (target.dataset.featureAction || target.dataset.action || "") : "";
    if (["choose-hyb", "choose-fasta", "choose-comparison-files", "replace-hyb"].indexOf(action) === -1) {
      window.setTimeout(render, 0);
    }
  }

  function handleChange(event) {
    // K8: a select's title is its current option's full text; keep it current
    // for pages that do not redraw on this change
    const changed = event.target;
    if (changed && changed.tagName === "SELECT" && changed.hasAttribute("title") && changed.selectedOptions && changed.selectedOptions[0]) {
      changed.title = changed.selectedOptions[0].text;
    }
    if (event.target.id === "density-input") {
      state.density = event.target.value === "compact" ? "compact" : "comfortable";
      render();
      return;
    }

    if (event.target.id === "hyb-file-input") {
      const file = event.target.files && event.target.files[0];
      if (file) {
        acceptHybFile(file);
      }
      event.target.value = "";
      return;
    }

    if (event.target.id === "fasta-file-input") {
      const file = event.target.files && event.target.files[0];
      if (file) {
        if (state.summary) {
          loadFasta(file);
        } else {
          state.landingFastaFile = file;
          state.error = null;
          render();
        }
      }
      event.target.value = "";
      return;
    }

    if (event.target.id === "comparison-file-input") {
      const files = event.target.files ? Array.from(event.target.files) : [];
      if (files.length) {
        loadComparisonFiles(files);
      }
      event.target.value = "";
      return;
    }

    if (event.target.closest("[data-feature]")) {
      const api = featureApi();
      if (isTextEntry(event.target)) {
        api.render = function () { scheduleCommittedInputRender(event.target); };
      }
      window.RNAxRayUI.handleChange(state, event.target, api);
    }
  }

  function handleInput(event) {
    const element = event.target;
    // the researcher's purpose on the Report page: kept as typed, no redraw
    if (element && element.id === "report-purpose") {
      state.reportPurpose = String(element.value || "").slice(0, 1000);
      if (reportExportCache) {
        reportExportCache = null;
        state.reportExport = null;
      }
      return;
    }
    if (!element || !element.dataset || !element.dataset.feature) {
      return;
    }
    if (!isTextEntry(element)) {
      return;
    }
    window.RNAxRayUI.handleInput(state, element);
  }

  function isTextEntry(element) {
    return element && (element.tagName === "TEXTAREA" || element.type === "text" || element.type === "search" || element.type === "number");
  }

  function scheduleCommittedInputRender(source) {
    const activeElement = document.activeElement;
    const actionHasFocus = activeElement && activeElement.closest && activeElement.closest("button, a, [data-feature-action], [data-action]");
    if (state.pointerActionPending || actionHasFocus) {
      state.pendingCommittedInputRender = true;
      return;
    }
    const focused = focusIdentity(activeElement);
    window.setTimeout(function () {
      render();
      restoreFocus(focused, source);
    }, 0);
  }

  function focusIdentity(element) {
    if (!element || !app.contains(element)) {
      return null;
    }
    return {
      id: element.id || "",
      feature: element.dataset && element.dataset.feature || "",
      key: element.dataset && element.dataset.key || ""
    };
  }

  function restoreFocus(identity, source) {
    let replacement = identity && identity.id ? document.getElementById(identity.id) : null;
    if (!replacement && identity && identity.feature) {
      replacement = Array.from(document.querySelectorAll("[data-feature]")).find(function (element) {
        return element.dataset.feature === identity.feature && element.dataset.key === identity.key;
      });
    }
    if (!replacement && source && source.dataset) {
      replacement = Array.from(document.querySelectorAll("[data-feature]")).find(function (element) {
        return element.dataset.feature === source.dataset.feature && element.dataset.key === source.dataset.key;
      });
    }
    if (replacement && typeof replacement.focus === "function") {
      replacement.focus();
    }
  }

  function handleKeydown(event) {
    const dropzone = event.target.closest("[data-dropzone]");
    const actionableRow = event.target.closest("tr[data-feature-action]");

    if (actionableRow && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (window.RNAxRayUI) {
        window.RNAxRayUI.handleAction(state, actionableRow, featureApi());
      }
      return;
    }

    if (dropzone && !event.target.closest("a[href]") && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const input = document.getElementById("hyb-file-input");
      if (input) {
        input.click();
      }
    }

    if (event.key === "Escape" && state.dialog) {
      state.dialog = null;
      render();
    }
  }

  function handleDragOver(event) {
    const dropzone = event.target.closest("[data-dropzone]");
    if (!dropzone) {
      return;
    }

    event.preventDefault();
    dropzone.classList.add("is-dragging");
  }

  function handleDragLeave(event) {
    const dropzone = event.target.closest("[data-dropzone]");
    if (dropzone) {
      dropzone.classList.remove("is-dragging");
    }
  }

  function handleDrop(event) {
    const dropzone = event.target.closest("[data-dropzone]");
    if (!dropzone) {
      return;
    }

    event.preventDefault();
    dropzone.classList.remove("is-dragging");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];

    if (file) {
      acceptHybFile(file);
    }
  }

  // A17: a raw-read file (FASTQ, SAM/BAM, FASTA) given where a HYB file goes
  // gets its own panel instead of the parser's "Line 1: ..." error. Known
  // extensions (also .gz) decide at once; other uncompressed files are
  // judged by their first 4 KB. Everything else is parsed as before.
  const RAW_READ_EXTENSION = /\.(fastq|fq|sam|bam|fa|fasta|fna)(\.gz)?$/i;

  function rawReadKind(name, head) {
    const extension = RAW_READ_EXTENSION.exec(String(name || ""));
    if (extension) {
      const kind = extension[1].toLowerCase();
      return kind === "fq" || kind === "fastq" ? "fastq" : kind === "sam" || kind === "bam" ? kind : "fasta";
    }
    if (typeof head !== "string" || !head) {
      return null;
    }
    const text = head.replace(/^\uFEFF/, "");
    if (/^@(HD|SQ)\t/.test(text)) {
      return "sam";
    }
    const lines = text.split(/\r?\n/);
    if (lines.length >= 4 && /^@\S/.test(lines[0]) && /^[A-Za-z.*-]+$/.test(lines[1]) && lines[2].charAt(0) === "+") {
      return "fastq";
    }
    if (text.charAt(0) === ">") {
      return "fasta";
    }
    return null;
  }

  function acceptHybFile(file) {
    const byName = rawReadKind(file && file.name);
    if (byName) {
      showRawReads(file, byName);
      return;
    }
    if (/\.gz$/i.test(file.name || "") || typeof file.slice !== "function") {
      startParsing(file);
      return;
    }
    const head = file.slice(0, 4096);
    const read = typeof head.text === "function" ? head.text() : Promise.reject(new Error("no Blob.text"));
    read.then(function (text) {
      const kind = rawReadKind("", text);
      if (kind) {
        showRawReads(file, kind);
      } else {
        startParsing(file);
      }
    }, function () {
      startParsing(file);
    });
  }

  function showRawReads(file, kind) {
    state.rawReads = { name: file.name || "Untitled file", kind: kind };
    state.error = null;
    if (state.analysisEntered) {
      state.dialog = "raw-reads";
    }
    render();
    if (!state.analysisEntered && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () {
        const heading = document.getElementById("raw-reads-title");
        if (heading) {
          heading.focus({ preventScroll: false });
        }
      });
    }
  }

  const RAW_READ_LABELS = { fastq: "FASTQ reads", sam: "SAM alignments", bam: "BAM alignments", fasta: "FASTA sequences" };

  // The panel's content (landing card and workspace drawer share it).
  function renderRawReadsBody(withHeading) {
    const raw = state.rawReads;
    const kit = desktopKit();
    const shown = desktopEntriesShown();
    const mine = shown && kit.downloadsAvailable ? kit.detectPlatform() : null;
    const actions = [];
    if (mine) {
      actions.push('<a class="button" href="' + escapeAttribute(kit.downloadUrl(mine)) + '">Download for ' + escapeHtml(mine.label) + "</a>");
    }
    if (shown) {
      actions.push('<button class="' + (mine ? "button button-secondary" : "button") + '" type="button" data-action="open-desktop" data-desktop-context="raw-read-panel">What RNAxRay Desktop does</button>');
    }
    actions.push('<button class="button button-secondary" type="button" data-action="choose-hyb">Choose a .hyb file instead</button>');
    if (!state.analysisEntered) {
      actions.push('<button class="quiet-button" type="button" data-action="dismiss-raw-reads">Back</button>');
    }
    return [
      withHeading ? '<span class="dropzone-kicker">' + escapeHtml(RAW_READ_LABELS[raw.kind] || "Raw reads") + "</span>" : "",
      withHeading ? '<h2 id="raw-reads-title" tabindex="-1">This is a raw-read file</h2>' : "",
      '<p class="raw-reads-file"><code title="' + escapeAttribute(raw.name) + '">' + escapeHtml(raw.name) + "</code>" + (withHeading ? "" : " · " + escapeHtml(RAW_READ_LABELS[raw.kind] || "raw reads")) + "</p>",
      "<p>Web reads .hyb files, the output of the hyb pipeline." + (shown ? " RNAxRay Desktop maps raw reads like these and turns them into .hyb files." : "") + "</p>",
      raw.kind === "fasta" ? '<p class="raw-reads-fasta">If this is your reference sequence, add it as the FASTA after the HYB file.</p>' : "",
      shown && !kit.downloadsAvailable ? '<p class="raw-reads-note">' + escapeHtml(kit.notAvailable) + "</p>" : "",
      '<div class="raw-reads-actions">' + actions.join("") + "</div>"
    ].join("");
  }

  function renderRawReadsPanel() {
    return [
      '<div class="file-card"><div class="file-card-inner raw-reads-panel">',
      '  <input id="hyb-file-input" class="visually-hidden" type="file" accept=".hyb,.txt,.gz,text/plain" aria-label="Choose a HYB file">',
      renderRawReadsBody(true),
      "</div></div>"
    ].join("");
  }

  // Stage one: fetch the primary HYB and its FASTA, then parse as an upload.
  // Stage two (continueExample) starts once the primary file is registered.
  async function loadExample() {
    if (!example) {
      return;
    }
    const session = {};
    state.rawReads = null;
    state.exampleLoadSession = session;
    state.exampleSetup = null;
    state.dialog = null;
    state.error = null;
    state.loading = {
      fileName: example.title,
      totalBytes: 0,
      processedBytes: 0,
      parsedRecords: 0,
      percent: 0,
      stage: "Loading example files"
    };
    render();

    try {
      let received = 0;
      const files = await Promise.all([example.primary.file, example.reference.file].map(function (name) {
        return fetchExampleFile(name, function (bytes) {
          if (state.exampleLoadSession !== session) {
            return;
          }
          received += bytes;
          state.loading.processedBytes = received;
          state.loading.stage = "Loading example files";
          updateLoadingStatus("Loading example files · " + formatBytes(received) + " downloaded");
        });
      }));
      if (state.exampleLoadSession !== session) {
        return;
      }
      state.exampleLoadSession = null;
      startParsing(files[0], { referenceFile: files[1], example: true });
    } catch (error) {
      if (state.exampleLoadSession !== session) {
        return;
      }
      state.exampleLoadSession = null;
      state.loading = null;
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      const network = offline || /network|failed to fetch|load failed/i.test(error && error.message || "");
      state.error = {
        source: "example",
        title: "The example could not be loaded",
        message: network
          ? "The example files could not be downloaded" + (offline ? " (this device is offline)." : " (network error).")
          : (error && error.message ? error.message : "The included example files are unavailable."),
        hint: network
          ? "Check the connection and press Try again. If it keeps failing, reload the page."
          : "Press Try again, or reload the page."
      };
      render();
    }
  }

  // Updates the loading panel's status line without a full render.
  function updateLoadingStatus(text) {
    const node = app && app.querySelector(".load-status");
    if (node) {
      node.textContent = text;
    }
  }

  // fetch one example file as a File; onBytes(n) reports downloaded bytes
  async function fetchExampleFile(name, onBytes) {
    const response = await fetch(example.url(name), { cache: "no-store" });
    if (!response.ok) {
      throw new Error("The example file " + name + " could not be read (HTTP " + response.status + ").");
    }
    let blob;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        chunks.push(next.value);
        if (onBytes) {
          onBytes(next.value.byteLength);
        }
      }
      blob = new Blob(chunks);
    } else {
      blob = await response.blob();
    }
    return createExampleFile(blob, { fileName: name, type: /\.gz$/i.test(name) ? "application/gzip" : "text/plain" });
  }

  // Stage two: the other three replicates go to the Compare page (parsed in
  // workers, as "Add HYB datasets" does) and the arc map gets both folds and
  // the gene track.  The landing page stays usable meanwhile.
  async function continueExample(parsedFile) {
    const comparison = state.comparison;
    if (!example || !comparison) {
      return;
    }
    const setup = { stage: "Downloading the other replicates", done: 0, total: example.replicates.length, error: "", ready: false };
    state.exampleSetup = setup;
    const current = function () {
      return state.exampleSetup === setup && state.comparison === comparison && state.file === parsedFile;
    };
    comparison.conditionALabel = example.labels.A;
    comparison.conditionBLabel = example.labels.B;
    comparison.binSize = example.comparison.binSize;
    comparison.similarityMinimum = example.comparison.similarityMinimum;
    (comparison.datasets || []).forEach(function (dataset) {
      if (dataset.id === PRIMARY_DATASET_ID) {
        dataset.label = example.primary.label;
      }
    });
    if (canRegisterDatasets()) {
      provider.updateDataset(PRIMARY_DATASET_ID, { label: example.primary.label });
    }
    comparison.result = null;
    render();
    try {
      const arcFiles = Promise.all([example.arcMap.a, example.arcMap.b, example.arcMap.annotation].map(function (name) {
        return fetchExampleFile(name);
      }));
      const replicateFiles = [];
      for (let index = 0; index < example.replicates.length; index += 1) {
        replicateFiles.push(await fetchExampleFile(example.replicates[index].file));
        if (!current()) {
          return;
        }
        setup.done = index + 1;
        render();
      }
      const structures = await arcFiles;
      if (!current()) {
        return;
      }
      if (window.RNAxRayArcMap) {
        state.arcMap = state.arcMap || window.RNAxRayArcMap.defaultState();
        await Promise.all([
          window.RNAxRayArcMap.loadFile(state.arcMap, "a", structures[0]),
          window.RNAxRayArcMap.loadFile(state.arcMap, "b", structures[1]),
          window.RNAxRayArcMap.loadFile(state.arcMap, "annotation", structures[2])
        ]);
        state.arcMap.labelOne = example.labels.A;
        state.arcMap.labelTwo = example.labels.B;
      }
      if (!current()) {
        return;
      }
      setup.stage = "Parsing the other replicates";
      setup.done = 0;
      render();
      await loadComparisonFiles(replicateFiles, {
        assign: example.replicates,
        onFile: function (index) {
          if (current()) {
            setup.done = index;
          }
        }
      });
      if (!current()) {
        return;
      }
      if (comparison.error) {
        setup.error = comparison.error;
      } else {
        setup.ready = true;
      }
      render();
    } catch (error) {
      if (!current()) {
        return;
      }
      setup.error = error && error.message ? error.message : "the example files are unavailable.";
      render();
    }
  }

  function createExampleFile(blob, asset) {
    if (typeof File === "function") {
      return new File([blob], asset.fileName, { type: asset.type });
    }
    Object.defineProperty(blob, "name", { value: asset.fileName });
    return blob;
  }

  function startParsing(file, options) {
    terminateWorker();
    cancelComparisonLoads();
    invalidateFastaLoad();
    const parseOptions = options || {};
    state.rawReads = null;
    const referenceFile = parseOptions.referenceFile || state.landingFastaFile || null;
    state.landingFastaFile = null;
    state.exampleLoadSession = null;
    const parseSession = {
      file: file,
      referenceFile: referenceFile,
      example: !!parseOptions.example
    };
    state.exampleSetup = null;
    state.parseSession = parseSession;
    state.dialog = null;
    state.file = file;
    state.analysisEntered = false;
    state.summary = null;
    state.records = [];
    state.filters = null;
    state.interactionResults = [];
    state.interactionScrollTop = 0;
    state.selectedRecordIndex = null;
    state.contact = null;
    state.region = null;
    state.viewpoint = null;
    state.comparison = null;
    resetAnalysisModules();
    state.structure = null;
    state.evidence = null;
    state.reportExport = null;
    reportExportCache = null;
    state.reportPurpose = "";
    state.reportSelection = null;
    if (window.RNAxRayEvidence) window.RNAxRayEvidence.cancel();
    state.error = null;
    state.loading = {
      fileName: file.name || "Untitled file",
      totalBytes: file.size,
      processedBytes: 0,
      parsedRecords: 0,
      percent: 0,
      stage: "Reading file"
    };
    render();

    try {
      const worker = new Worker((window.RNAXRAY_ASSET_BASE || "./") + "parser.worker.js");
      state.worker = worker;

      function parseSessionIsCurrent() {
        return state.parseSession === parseSession && state.file === file;
      }

      worker.onmessage = function (messageEvent) {
        if (!parseSessionIsCurrent()) {
          return;
        }
        const message = messageEvent.data || {};

        if (message.type === "progress") {
          const total = message.totalBytes || file.size || 1;
          state.loading = {
            fileName: file.name || "Untitled file",
            totalBytes: total,
            processedBytes: message.processedBytes || 0,
            parsedRecords: message.parsedRecords || 0,
            percent: Math.min(95, Math.round(((message.processedBytes || 0) / total) * 95)),
            stage: message.stage || "Parsing HYB records"
          };
          render();
          return;
        }

        if (message.type === "complete") {
          terminateWorker();
          const summary = message.summary;

          if (!summary || !summary.validRecords) {
            state.loading = null;
            const firstProblem = summary && summary.errors && summary.errors[0];
            state.error = {
              title: "This does not appear to be a valid HYB file",
              message: "No records with at least 15 tab-separated columns, RNA names, and valid RNA coordinates were found.",
              fileName: file.name || "Untitled file",
              detail: firstProblem ? describeParseProblem(firstProblem) : "",
              hint: hybFormatHint(),
              rawReadsHint: true
            };
            render();
            return;
          }

          state.loading = {
            fileName: file.name || "Untitled file",
            totalBytes: file.size,
            processedBytes: file.size,
            parsedRecords: summary.validRecords,
            percent: 100,
            stage: "Building summary"
          };
          render();

          window.setTimeout(function () {
            if (!parseSessionIsCurrent()) {
              return;
            }
            state.summary = summary;
            state.records = (message.records || []).map(function (record, index) {
              record.index = index;
              return record;
            });
            rebuildFastaMapping(summary);
            state.filters = window.RNAxRayData.defaultInteractionFilters();
            state.interactionResults = state.records;
            state.interactionScrollTop = 0;
            state.selectedRecordIndex = null;
            state.contact = window.RNAxRayData.defaultContactState(summary);
            state.region = window.RNAxRayData.defaultRegionState(summary, state.records);
            state.viewpoint = window.RNAxRayData.defaultViewpointState(summary, state.records);
            state.comparison = window.RNAxRayData.defaultComparisonState(summary, state.records);
            state.structure = window.RNAxRayData.defaultStructureState();
            state.structure.rna = state.region.rna;
            state.structure.start = state.region.start;
            state.structure.end = state.region.end;
            const structurePair = summary.pairCounts && summary.pairCounts[0];
            const secondStructureRna = structurePair ? structurePair.rnaTwo : state.region.rna;
            const secondStructureExtent = window.RNAxRayData.getRnaExtent(state.records, secondStructureRna);
            state.structure.secondRna = secondStructureRna;
            state.structure.secondStart = secondStructureExtent ? secondStructureExtent.min : state.region.start;
            state.structure.secondEnd = secondStructureExtent
              ? Math.min(secondStructureExtent.max, secondStructureExtent.min + 200)
              : state.region.end;
            registerPrimaryDataset(file, summary, state.records);
            state.loading = null;
            state.analysisEntered = false;
            state.activePage = "landing";
            setRouteHash("#/");
            if (parseSession.referenceFile) {
              loadFasta(parseSession.referenceFile);
            }
            if (parseSession.example) {
              continueExample(file);
            }
            if (state.pendingSessionSnapshot) {
              const pending = state.pendingSessionSnapshot;
              state.pendingSessionSnapshot = null;
              if (pending.theme === "dark" || pending.theme === "light") state.theme = pending.theme;
              if (pending.density === "compact" || pending.density === "comfortable") state.density = pending.density;
              setRouteHash(pending.route && pending.route !== "landing" ? "#/workspace/" + String(pending.route).replace(/^workspace\//, "") : "#/workspace/overview");
              state.analysisEntered = true;
            }
            digestFile(file).then(function (hash) {
              if (state.summary === summary) {
                state.summary.sha256 = hash;
                state.summary.sha256Unavailable = !hash;
                updatePrimaryFingerprint(hash);
                if (state.dialog === "files" || !state.analysisEntered) {
                  render();
                }
              }
            }).catch(function () {
              if (state.summary === summary) {
                state.summary.sha256 = "";
                state.summary.sha256Unavailable = true;
                updatePrimaryFingerprint("");
                if (state.dialog === "files" || !state.analysisEntered) {
                  render();
                }
              }
            });
          }, 220);
          return;
        }

        if (message.type === "error") {
          terminateWorker();
          state.loading = null;
          state.error = {
            title: "Local parsing could not finish",
            message: message.message || "The file could not be processed in this browser."
          };
          render();
        }
      };

      worker.onerror = function () {
        if (!parseSessionIsCurrent()) {
          return;
        }
        terminateWorker();
        state.loading = null;
        state.error = {
          title: "Local parsing could not finish",
          message: "The browser worker stopped unexpectedly. No file content was uploaded."
        };
        render();
      };

      worker.postMessage({ file: file });
    } catch (error) {
      if (state.parseSession !== parseSession || state.file !== file) {
        return;
      }
      state.loading = null;
      state.error = {
        title: "This browser cannot start the local parser",
        message: error && error.message ? error.message : "No data was uploaded."
      };
      render();
    }
  }

  function rebuildFastaMapping(summary) {
    if (!state.fasta) {
      return;
    }

    const previousMapping = state.fasta.mapping || {};
    const sequenceIds = new Set((state.fasta.sequences || []).map(function (entry) { return entry.id; }));
    const mapping = window.RNAxRayData.buildFastaMapping(summary.rnaNames || [], state.fasta.sequences || []);
    (summary.rnaNames || []).forEach(function (rna) {
      if (previousMapping[rna] && sequenceIds.has(previousMapping[rna])) {
        mapping[rna] = previousMapping[rna];
      }
    });
    state.fasta.mapping = mapping;
    const rnas = summary.rnaNames || [];
    if (rnas.indexOf(state.fasta.mappingEditorRna) === -1) {
      state.fasta.mappingEditorRna = rnas.find(function (rna) { return !mapping[rna]; }) || rnas[0] || "";
    }
    state.fasta.mappingEditorReference = mapping[state.fasta.mappingEditorRna] || "";
  }

  function navigate(page, reason) {
    const isAnalysis = workspacePages.some(function (item) { return item.id === page; });
    if (!state.shell) {
      // Embedded: no hash routing and no help pages; the host is told so it
      // can keep its own navigation in sync.
      if (!isAnalysis) {
        return;
      }
      const previousPage = state.activePage;
      state.activePage = page;
      render();
      if (previousPage !== page) {
        app.scrollTop = 0;
        emit("navigate", { pageId: page, previousPageId: previousPage, reason: reason || "page" });
      }
      return;
    }
    const nextHash = isAnalysis ? "#/workspace/" + page : "#/" + page;
    setRouteHash(nextHash);
  }

  function enterAnalysis() {
    if (!state.summary) {
      return;
    }
    state.analysisEntered = true;
    navigate("overview");
  }

  function setRouteHash(nextHash) {
    if (window.location.hash === nextHash) {
      syncRoute();
      render();
      window.scrollTo(0, 0);
      return;
    }
    window.location.hash = nextHash;
  }

  function featureApi() {
    return {
      render: render,
      navigate: navigate,
      chooseFasta: chooseFasta,
      chooseHyb: chooseHyb,
      chooseComparisonFiles: chooseComparisonFiles,
      removeFasta: removeFasta,
      clearSession: clearSession,
      download: downloadText,
      downloadBlob: downloadBlob,
      showToast: showToast,
      copyText: copyText,
      updateInteractionHash: updateInteractionHash,
      // DataProvider access for page actions (exports, paging).
      queryHybrids: function (query) { return pageData ? pageData.queryHybrids(query) : Promise.resolve({ total: 0, offset: 0, rows: [] }); },
      getArms: function (selection, query) {
        const current = pageData && pageData.getProvider();
        return current ? current.getArms(selection, query) : Promise.reject(new Error("No data provider is available."));
      },
      loadInteractionWindow: function (start) { return pageData ? pageData.loadInteractionWindow(start) : Promise.resolve(false); },
      dataChanged: function () {
        if (provider && typeof provider.notifyChange === "function") provider.notifyChange();
      },
      removeDataset: function (datasetId) {
        if (state.shell && provider && typeof provider.removeDataset === "function") provider.removeDataset(datasetId);
      },
      requestFold: function (request) {
        emit("requestFold", request);
      }
    };
  }

  function updatePrimaryFingerprint(hash) {
    if (canRegisterDatasets()) {
      provider.updateDataset(PRIMARY_DATASET_ID, { sha256: hash || null, sha256Unavailable: !hash });
    }
  }

  function canRegisterDatasets() {
    return !!(provider && typeof provider.addDataset === "function");
  }

  // Registers the parsed primary HYB as the BrowserProvider's "primary"
  // dataset and selects it. Comparison datasets are registered alongside.
  function registerPrimaryDataset(file, summary, records) {
    if (!canRegisterDatasets()) {
      return;
    }
    provider.clear();
    provider.addDataset({
      id: PRIMARY_DATASET_ID,
      primary: true,
      condition: "A",
      label: "Primary",
      fileName: summary.fileName || (file && file.name) || "",
      fileSize: summary.fileSize,
      summary: summary,
      records: records
    });
    if (state.fasta) {
      provider.setReference(state.fasta);
    }
    pageData.setSelection({ datasetIds: [PRIMARY_DATASET_ID] }, { keepState: true });
  }

  function chooseHyb() {
    const input = document.getElementById("hyb-file-input");
    if (input) {
      input.click();
    }
  }

  function chooseComparisonFiles() {
    const input = document.getElementById("comparison-file-input");
    if (input) {
      input.click();
    }
  }

  function chooseFasta() {
    const input = document.getElementById("fasta-file-input");
    if (input) {
      input.click();
    }
  }

  function invalidateFastaLoad() {
    state.fastaLoadSession = null;
  }

  function setProviderReference(fasta) {
    if (canRegisterDatasets() && typeof provider.setReference === "function") {
      provider.setReference(fasta);
    }
  }

  function notifyReferenceMetadata() {
    if (canRegisterDatasets() && typeof provider.notifyChange === "function") {
      provider.notifyChange({ metadataOnly: true });
    }
  }

  function removeFasta() {
    invalidateFastaLoad();
    state.fasta = null;
    setProviderReference(null);
    if (state.viewpoint) {
      state.viewpoint.results = null;
      state.viewpoint.rangeMode = "coordinates";
    }
    if (state.structure && state.structure.source === "reference" && window.RNAxRayStructure) {
      window.RNAxRayStructure.reset(state, { clearConstraints: true });
    }
    render();
  }

  async function loadFasta(file) {
    const primaryFile = state.file;
    const primarySummary = state.summary;
    const fastaLoadSession = { file: file, primaryFile: primaryFile, primarySummary: primarySummary };
    state.fastaLoadSession = fastaLoadSession;

    function fastaLoadSessionIsCurrent() {
      return state.fastaLoadSession === fastaLoadSession &&
        state.file === primaryFile &&
        state.summary === primarySummary;
    }

    if (!primaryFile || !primarySummary) {
      invalidateFastaLoad();
      return;
    }

    if (!state.analysisEntered) {
      render();
    }

    let loadedFasta = null;
    try {
      showToast("Reading reference FASTA locally…");
      const text = await file.text();
      if (!fastaLoadSessionIsCurrent()) {
        return;
      }
      const sequences = window.RNAxRayData.parseFasta(text);

      if (!sequences.length) {
        throw new Error("No FASTA records with a header and sequence were found.");
      }

      const unsupportedEntries = sequences.filter(function (entry) {
        return entry.invalidCharacters && entry.invalidCharacters.length;
      });
      const unsupportedCharacters = Array.from(new Set(unsupportedEntries.flatMap(function (entry) {
        return entry.invalidCharacters;
      })));

      const mapping = window.RNAxRayData.buildFastaMapping(primarySummary.rnaNames || [], sequences);
      const mappingEditorRna = (primarySummary.rnaNames || []).find(function (rna) { return !mapping[rna]; }) || (primarySummary.rnaNames || [])[0] || "";
      loadedFasta = {
        fileName: file.name || "reference.fasta",
        fileSize: file.size,
        sequences: sequences,
        mapping: mapping,
        mappingEditorRna: mappingEditorRna,
        mappingEditorReference: mapping[mappingEditorRna] || "",
        unsupportedSequenceEntries: unsupportedEntries.length,
        unsupportedCharacters: unsupportedCharacters,
        sha256: "",
        sha256Unavailable: false
      };
      if (!fastaLoadSessionIsCurrent()) {
        return;
      }
      state.fasta = loadedFasta;
      setProviderReference(loadedFasta);
      if (state.viewpoint) {
        state.viewpoint.results = null;
        if (state.viewpoint.rangeMode === "reference" &&
            !window.RNAxRayData.findFastaEntry(loadedFasta, state.viewpoint.rna)) {
          state.viewpoint.rangeMode = "coordinates";
        }
      }
      if (state.structure && state.structure.source === "reference" && window.RNAxRayStructure) {
        window.RNAxRayStructure.reset(state, { clearConstraints: true });
      }
      render();
      showToast(unsupportedEntries.length
        ? "Reference FASTA loaded with unsupported symbols preserved; affected regions cannot be folded until corrected."
        : "Reference FASTA loaded locally.");
      const hash = await digestFile(file);
      if (state.fasta !== loadedFasta) {
        return;
      }
      loadedFasta.sha256 = hash;
      loadedFasta.sha256Unavailable = !hash;
      notifyReferenceMetadata();
      if (state.fastaLoadSession === fastaLoadSession) {
        invalidateFastaLoad();
      }
      if (state.dialog === "files" || !state.analysisEntered) {
        render();
      }
    } catch (error) {
      if (loadedFasta) {
        if (state.fasta !== loadedFasta) {
          return;
        }
        loadedFasta.sha256 = "";
        loadedFasta.sha256Unavailable = true;
        notifyReferenceMetadata();
        if (state.fastaLoadSession === fastaLoadSession) {
          invalidateFastaLoad();
        }
        if (state.dialog === "files" || !state.analysisEntered) {
          render();
        }
        showToast("Reference FASTA loaded, but its SHA-256 fingerprint is unavailable.");
        return;
      }
      if (!fastaLoadSessionIsCurrent()) {
        return;
      }
      invalidateFastaLoad();
      if (!state.analysisEntered) {
        render();
      }
      showToast(error && error.message ? error.message : "The FASTA file could not be parsed.");
    }
  }

  // options.assign[index] = { label, condition } overrides a file's label and
  // condition (the example); options.onFile(index) reports progress.
  async function loadComparisonFiles(files, options) {
    const settings = options || {};
    const assign = settings.assign || [];
    const comparisonSession = state.comparison;
    const primaryFile = state.file;

    if (!comparisonSession || !files.length) {
      return;
    }

    cancelComparisonLoads();
    const comparisonLoadSession = {};
    state.comparisonLoadSession = comparisonLoadSession;

    function comparisonSessionIsCurrent() {
      return state.comparison === comparisonSession &&
        state.file === primaryFile &&
        state.comparisonLoadSession === comparisonLoadSession;
    }

    comparisonSession.error = "";
    comparisonSession.loading = { total: files.length, completed: 0, fileName: files[0].name || "HYB file" };
    comparisonSession.result = null;
    comparisonSession.selection = null;
    render();

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!comparisonSessionIsCurrent()) {
        return;
      }
      comparisonSession.loading = { total: files.length, completed: index, fileName: file.name || "HYB file" };
      if (settings.onFile) {
        settings.onFile(index);
      }
      render();

      try {
        const parsed = await parseComparisonFile(file);
        if (!comparisonSessionIsCurrent()) {
          return;
        }
        if (!parsed.summary.validRecords) {
          throw new Error("No valid HYB records were found.");
        }
        let sha256 = "";
        try {
          sha256 = await digestFile(file);
        } catch (digestError) {
          sha256 = "";
        }
        if (!comparisonSessionIsCurrent()) {
          return;
        }
        parsed.summary.sha256 = sha256;
        parsed.summary.sha256Unavailable = !sha256;
        const datasetId = "comparison_" + Date.now().toString(36) + "_" + index;
        const records = parsed.records.map(function (record, recordIndex) {
          record.index = recordIndex;
          return record;
        });
        // Registered in the BrowserProvider; the Compare page lists it via
        // DataProvider.listDatasets().
        provider.addDataset({
          id: datasetId,
          fileName: file.name || "comparison.hyb",
          fileSize: file.size,
          sha256: sha256 || null,
          sha256Unavailable: !sha256,
          summary: parsed.summary,
          records: records,
          condition: assign[index] && assign[index].condition || "B",
          label: assign[index] && assign[index].label ||
            (file.name ? file.name.replace(/\.gz$/i, "").replace(/\.(hyb|txt)$/i, "") : "Dataset " + (comparisonSession.datasets.length + index + 1))
        });
        comparisonSession.result = null;
        comparisonSession.selection = null;
      } catch (error) {
        if (!comparisonSessionIsCurrent()) {
          return;
        }
        comparisonSession.error = "Could not add " + (file.name || "one dataset") + ": " + (error && error.message ? error.message : "local parsing failed.");
      }
    }

    if (!comparisonSessionIsCurrent()) {
      return;
    }
    comparisonSession.loading = null;
    comparisonSession.result = null;
    state.comparisonLoadSession = null;
    render();
    showToast("Comparison datasets were parsed locally.");
  }

  function parseComparisonFile(file) {
    return new Promise(function (resolve, reject) {
      let worker;
      let settled = false;
      const parser = {
        cancel: function () {
          if (settled) {
            return;
          }
          settled = true;
          if (worker) {
            worker.terminate();
          }
          state.comparisonParsers.delete(parser);
          const error = new Error("Comparison parsing was cancelled.");
          error.name = "AbortError";
          reject(error);
        }
      };

      function settle(callback, value) {
        if (settled) {
          return;
        }
        settled = true;
        if (worker) {
          worker.terminate();
        }
        state.comparisonParsers.delete(parser);
        callback(value);
      }

      try {
        worker = new Worker((window.RNAXRAY_ASSET_BASE || "./") + "parser.worker.js");
      } catch (error) {
        settle(reject, error);
        return;
      }
      state.comparisonParsers.add(parser);

      worker.onmessage = function (event) {
        const message = event.data || {};
        if (message.type === "complete") {
          settle(resolve, { summary: message.summary, records: message.records || [] });
        }
        if (message.type === "error") {
          settle(reject, new Error(message.message || "The local parser could not read this file."));
        }
      };
      worker.onerror = function () {
        settle(reject, new Error("The local parser stopped unexpectedly."));
      };
      try {
        worker.postMessage({ file: file });
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  // Stop the DESeq2 and RNAcofold workers a comparison may have started; a
  // reply from a stale run must not land in the next file's state.
  function stopAnalysisWorkers() {
    if (window.RNAxRayDeseqCard && typeof window.RNAxRayDeseqCard.stop === "function") {
      window.RNAxRayDeseqCard.stop();
    }
    if (window.RNAxRayFoldingEnergy && typeof window.RNAxRayFoldingEnergy.stop === "function" && state.foldingEnergy) {
      window.RNAxRayFoldingEnergy.stop(state.foldingEnergy);
    }
  }

  // Arc map, region panels and folding energy keep their own state beside
  // state.comparison; loading or closing a file returns them to defaults.
  function resetAnalysisModules() {
    stopAnalysisWorkers();
    state.arcMap = moduleDefaultState(window.RNAxRayArcMap);
    state.regionPanels = moduleDefaultState(window.RNAxRayRegionPanels);
    state.foldingEnergy = moduleDefaultState(window.RNAxRayFoldingEnergy);
  }

  function moduleDefaultState(module) {
    return module && typeof module.defaultState === "function" ? module.defaultState() : null;
  }

  function cancelComparisonLoads() {
    state.comparisonLoadSession = null;
    Array.from(state.comparisonParsers).forEach(function (parser) {
      parser.cancel();
    });
    state.comparisonParsers.clear();
  }

  function updateInteractionHash() {
    if (!state.shell || !state.summary || state.activePage !== "interactions") {
      return;
    }
    const filters = state.filters || {};
    const parameters = new URLSearchParams();
    if (filters.rna) {
      parameters.set("rna", filters.rna);
    }
    if (filters.partner) {
      parameters.set("partner", filters.partner);
    }
    const suffix = parameters.toString();
    history.replaceState(null, "", "#/workspace/interactions" + (suffix ? "?" + suffix : ""));
  }

  function copyText(text, confirmation) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast(confirmation);
      }).catch(function () {
        fallbackCopy(text, confirmation);
      });
      return;
    }
    fallbackCopy(text, confirmation);
  }

  function fallbackCopy(text, confirmation) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand("copy");
      showToast(confirmation);
    } catch (error) {
      showToast("Copy is unavailable in this browser.");
    }
    textArea.remove();
  }

  async function digestFile(file) {
    if (!window.crypto || !window.crypto.subtle) {
      return "";
    }
    const buffer = await file.arrayBuffer();
    const digest = await window.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map(function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function clearSession() {
    terminateWorker();
    cancelComparisonLoads();
    invalidateFastaLoad();
    state.exampleLoadSession = null;
    state.exampleSetup = null;
    state.landingFastaFile = null;
    state.parseSession = null;
    state.analysisEntered = false;
    state.dialog = null;
    state.file = null;
    state.summary = null;
    state.records = [];
    state.fasta = null;
    state.filters = null;
    state.interactionResults = [];
    state.interactionScrollTop = 0;
    state.selectedRecordIndex = null;
    state.contact = null;
    state.region = null;
    state.viewpoint = null;
    state.comparison = null;
    resetAnalysisModules();
    state.structure = null;
    state.evidence = null;
    state.reportExport = null;
    reportExportCache = null;
    state.reportPurpose = "";
    state.reportSelection = null;
    if (window.RNAxRayEvidence) window.RNAxRayEvidence.cancel();
    state.loading = null;
    state.error = null;
    releaseProviderData();
    setRouteHash("#/");
  }

  // Website shell: forget every registered dataset and the selection.
  function releaseProviderData() {
    if (canRegisterDatasets()) {
      provider.clear();
    }
    state.selection = null;
    state.datasets = [];
    state.reference = null;
    state.view = window.RNAxRayPageData.freshView();
    if (pageData) {
      pageData.invalidate();
    }
  }

  function resetToLanding() {
    terminateWorker();
    cancelComparisonLoads();
    invalidateFastaLoad();
    state.rawReads = null;
    state.exampleLoadSession = null;
    state.exampleSetup = null;
    state.landingFastaFile = null;
    state.parseSession = null;
    state.analysisEntered = false;
    state.file = null;
    state.summary = null;
    state.records = [];
    state.fasta = null;
    state.filters = null;
    state.interactionResults = [];
    state.interactionScrollTop = 0;
    state.selectedRecordIndex = null;
    state.contact = null;
    state.region = null;
    state.viewpoint = null;
    state.comparison = null;
    resetAnalysisModules();
    state.structure = null;
    state.evidence = null;
    state.reportExport = null;
    reportExportCache = null;
    state.reportPurpose = "";
    state.reportSelection = null;
    if (window.RNAxRayEvidence) window.RNAxRayEvidence.cancel();
    state.loading = null;
    state.error = null;
    state.activePage = "landing";
    state.dialog = null;
    releaseProviderData();
    setRouteHash("#/");
  }

  function terminateWorker() {
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
    if (window.RNAxRayStructure) {
      window.RNAxRayStructure.terminate(state);
    }
  }

  function downloadSummary() {
    const payload = {
      application: "RNAxRay Web",
      version: "0.5.0",
      buildCommit: window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit || null,
      sourceFile: {
        name: state.summary.fileName,
        bytes: state.summary.fileSize,
        sha256: state.summary.sha256 || null,
        sha256Status: state.summary.sha256
          ? "available"
          : (state.summary.sha256Unavailable ? "unavailable" : "pending")
      },
      analysis: "overview",
      generatedLocally: true,
      summary: state.summary
    };
    downloadText("rnaxray-overview-summary.json", JSON.stringify(payload, null, 2), "application/json");
    showToast("Summary JSON downloaded locally.");
  }

  // Complete record-derived CSVs; every row comes from the DataProvider.
  function withAllRows(callback) {
    if (!pageData) {
      return;
    }
    pageData.queryHybrids({ offset: 0, limit: null }).then(function (result) {
      callback(result && result.rows || []);
    }).catch(function (error) {
      showToast(error && error.message ? error.message : "The interaction rows could not be loaded.");
    });
  }

  function downloadRnaCounts() {
    withAllRows(function (rows) {
      downloadText("rna_counts.csv", window.RNAxRayData.rnaCountsToCsv(rows), "text/csv");
      showToast("RNA counts CSV downloaded locally.");
    });
  }

  function downloadRnaPairs() {
    withAllRows(function (rows) {
      downloadText("rna_pairs.csv", window.RNAxRayData.rnaPairsToCsv(rows), "text/csv");
      showToast("RNA-pair counts CSV downloaded locally.");
    });
  }

  function downloadValidationReport() {
    const rows = [["line", "error", "content"]].concat(state.summary.errors.map(function (error) {
      return [error.line, error.error, error.content];
    }));
    const csv = rows.map(function (row) {
      return row.map(csvCell).join(",");
    }).join("\n");
    const sampled = !!state.summary.errorSampleTruncated;
    downloadText(sampled ? "rnaxray-validation-error-sample.csv" : "rnaxray-validation-report.csv", csv, "text/csv");
    showToast(sampled
      ? "Validation error sample downloaded locally; the Validation page shows how many details were omitted."
      : "Validation report downloaded locally.");
  }

  // ---- Report exports: files built from one result record (results.js)

  const REPORT_NOW = { immediate: true };

  let reportExportCache = null;
  let reportExportSession = 0;

  // the record of the export, with every filtered row from the DataProvider
  function prepareReportRecord() {
    if (!window.RNAxRayResults) {
      return Promise.reject(new Error("The result exports are unavailable in this build."));
    }
    const query = pageData ? pageData.queryHybrids({ filters: Object.assign({}, state.filters || {}), offset: 0, limit: window.RNAxRayResults.MAX_ANALYSIS_ROWS }) : Promise.resolve(null);
    return Promise.resolve(query).then(function (result) {
      const rows = result && Array.isArray(result.rows) ? result.rows : null;
      return window.RNAxRayResults.build(state, { interactionRows: rows, interactionTotal: result && Number.isFinite(result.total) ? result.total : undefined });
    });
  }

  // the package as it will be downloaded: without the files left out, with
  // a manifest that lists them
  function reportPackage(cache) {
    return window.RNAxRayResults.withManifest(window.RNAxRayResults.files(cache.record, cache.audience, { exclude: cache.exclude }), cache.record);
  }

  function listReportFiles(cache) {
    const all = window.RNAxRayResults.files(cache.record, cache.audience);
    const kept = window.RNAxRayResults.files(cache.record, cache.audience, { exclude: cache.exclude });
    const keptPaths = {};
    kept.forEach(function (file) { keptPaths[file.path] = file; });
    return all.map(function (file) {
      const shown = keptPaths[file.path] || file;
      return { path: file.path, description: shown.description, fields: shown.fields, bytes: new TextEncoder().encode(shown.text).length,
        excluded: !keptPaths[file.path], required: !!window.RNAxRayResults.REQUIRED_FILES[file.path] };
    }).concat([{ path: "manifest.json", description: "File list with sizes and SHA-256, and the files left out.", fields: ["schema", "run", "generatedAt", "application", "scope", "files", "leftOutByResearcher", "note"], bytes: 0, excluded: false, required: true }]);
  }

  function openReportExport(audience) {
    reportExportSession += 1;
    const session = reportExportSession;
    reportExportCache = null;
    state.reportExport = { audience: audience, status: audience === "people" ? "ready" : "preparing", list: [], error: "" };
    render(REPORT_NOW);
    if (audience === "people") {
      return;
    }
    prepareReportRecord().then(function (record) {
      if (session !== reportExportSession || !state.reportExport) {
        return;
      }
      reportExportCache = { audience: audience, record: record, exclude: {} };
      state.reportExport.status = "ready";
      state.reportExport.list = listReportFiles(reportExportCache);
      render(REPORT_NOW);
    }).catch(function (error) {
      if (session !== reportExportSession || !state.reportExport) {
        return;
      }
      state.reportExport.status = "error";
      state.reportExport.error = error && error.message ? error.message : "The export could not be prepared.";
      render(REPORT_NOW);
    });
  }

  function toggleReportFile(path) {
    if (!reportExportCache || window.RNAxRayResults.REQUIRED_FILES[path]) {
      return;
    }
    reportExportCache.exclude[path] = !reportExportCache.exclude[path];
    state.reportExport.list = listReportFiles(reportExportCache);
    render(REPORT_NOW);
  }

  function downloadReportZip() {
    if (!reportExportCache) {
      return;
    }
    const cache = reportExportCache;
    reportPackage(cache).then(function (files) {
      downloadBlob("rnaxray-result-" + cache.audience + (cache.record.scope.kind === "selected_results" ? "-selected" : "") + ".zip", window.RNAxRayResults.zip(files, "rnaxray-result"));
      showToast("Result package built and downloaded locally.");
    });
  }

  function downloadReportFile(audience, path) {
    const save = function (files) {
      const file = files.find(function (item) { return item.path === path; });
      if (!file) {
        showToast("That file is not part of the " + audience + " export.");
        return;
      }
      downloadText(path.split("/").pop(), file.text, file.mediaType);
      showToast(path + " downloaded locally.");
    };
    if (reportExportCache && reportExportCache.audience === audience) {
      reportPackage(reportExportCache).then(save);
      return;
    }
    prepareReportRecord().then(function (record) {
      return reportPackage({ audience: audience, record: record, exclude: {} });
    }).then(save).catch(function (error) {
      showToast(error && error.message ? error.message : "The file could not be prepared.");
    });
  }

  // One self-contained HTML file: the report article with this page's
  // stylesheets and images inlined, without the buttons that need the app.
  function downloadOfflineReport() {
    const article = document.querySelector("[data-report-page]");
    if (!article) {
      showToast("Open the report first.");
      return;
    }
    const clone = article.cloneNode(true);
    clone.querySelectorAll("[data-report-export-panel], .report-actions, button, input.report-select").forEach(function (node) { node.remove(); });
    clone.querySelectorAll("details").forEach(function (node) { node.setAttribute("open", ""); });
    // the purpose box becomes the researcher's text (or goes)
    clone.querySelectorAll(".report-purpose, .report-purpose-print").forEach(function (node) { node.remove(); });
    const purpose = String(state.reportPurpose || "").trim();
    const status = clone.querySelector("#report-status .report-section-body");
    if (purpose && status) {
      const line = document.createElement("p");
      line.className = "report-purpose-print";
      line.innerHTML = "<strong>Purpose:</strong> ";
      line.appendChild(document.createTextNode(purpose));
      status.insertBefore(line, status.firstChild);
    }
    const css = [];
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      try {
        css.push(Array.prototype.map.call(sheet.cssRules, function (rule) { return rule.cssText; }).join("\n"));
      } catch (error) {
        // a cross-origin sheet (none in this app) cannot be read
      }
    });
    const images = Array.prototype.slice.call(clone.querySelectorAll("img"));
    Promise.all(images.map(function (img) {
      return fetch(img.src).then(function (response) { return response.blob(); }).then(function (blob) {
        return new Promise(function (resolve) {
          const reader = new FileReader();
          reader.onload = function () { img.src = reader.result; resolve(); };
          reader.onerror = function () { img.remove(); resolve(); };
          reader.readAsDataURL(blob);
        });
      }).catch(function () { img.remove(); });
    })).then(function () {
      const theme = document.documentElement.getAttribute("data-theme") || "light";
      const title = "RNAxRay report · " + (state.summary && state.summary.fileName || "session");
      const html = "<!doctype html>\n<html lang=\"en\" data-theme=\"" + theme + "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>" + escapeHtml(title) +
        "</title><style>" + css.join("\n").replace(/<\/style/gi, "<\\/style") + "\nbody{margin:0;background:var(--background,#fff)}.report-offline-main{max-width:1180px;margin:0 auto;padding:24px 16px}</style></head><body><main class=\"report-offline-main\">" +
        clone.outerHTML + "<p class=\"report-note\">Offline copy of the RNAxRay Web report. Data tables and the AI context package are separate exports (For AI, For further analysis).</p></main></body></html>\n";
      downloadText("rnaxray-report.html", html, "text/html");
      showToast("Offline report downloaded locally.");
    });
  }

  function downloadFullReport() {
    if (!window.RNAxRayReport || typeof window.RNAxRayReport.getData !== "function") {
      showToast("The consolidated report is unavailable in this build.");
      return;
    }
    const report = window.RNAxRayReport.getData(state);
    downloadText("rnaxray-analysis-report.json", JSON.stringify(report, null, 2), "application/json");
    showToast("Consolidated report data downloaded locally.");
  }

  function downloadText(fileName, content, type) {
    const blob = new Blob([content], { type: type + ";charset=utf-8" });
    downloadBlob(fileName, blob);
  }

  function downloadBlob(fileName, blob) {
    if (window.RNAxRayDesktop && window.RNAxRayDesktop.enabled && typeof window.RNAxRayDesktop.saveFile === "function") {
      Promise.resolve(window.RNAxRayDesktop.saveFile(fileName, blob)).then(function (handled) {
        if (!handled) {
          browserDownloadBlob(fileName, blob);
        }
      }).catch(function () {
        browserDownloadBlob(fileName, blob);
      });
      return;
    }
    browserDownloadBlob(fileName, blob);
  }

  function browserDownloadBlob(fileName, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) {
      return;
    }

    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () {
      toast.classList.remove("is-visible");
    }, toastHoldMs(message));
  }

  // Long enough to read: 0.3 s per word plus 0.5 s, never shorter than the
  // 2.9 s short confirmations have always had, capped at 10 s.
  function toastHoldMs(message) {
    const words = String(message || "").trim().split(/\s+/).filter(Boolean).length;
    return Math.min(10000, Math.max(2900, 500 + 300 * words));
  }

  function pageTitle(page) {
    const allPages = workspacePages.concat([
      { id: "validation", label: "Validation" },
      { id: "methods", label: "Methods" },
      { id: "file-format", label: "File format" },
      { id: "privacy", label: "Privacy" }
    ]);
    const match = allPages.find(function (item) { return item.id === page; });
    return match ? match.label : "RNAxRay Web";
  }

  function formatNumber(value) {
    return numberFormatter.format(value || 0);
  }

  function formatBytes(bytes) {
    if (!bytes) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, index);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: index ? 1 : 0 }).format(value) + " " + units[index];
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function csvCell(value) {
    const cell = String(value == null ? "" : value);
    return '"' + cell.replace(/"/g, '""') + '"';
  }
}());

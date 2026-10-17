/*
 * Related research: optional public-database lookups for the RNA on the
 * RNA Structure page. The web counterpart of the desktop app's RNAcentral
 * MCP evidence feature (desktop/spec/EVIDENCE.md), with the same rules:
 *
 * - Off by default. Nothing is sent until the user turns lookups on,
 *   chooses an identifier and species, and confirms they match the RNA.
 * - Only that public identifier (and the species, to EBI Search) leaves the
 *   browser, by GET to two fixed EBI endpoints. HYB files, sequences,
 *   structures and file names never do.
 * - Results are background material: never a validation of the predicted
 *   structure, citations are not verified, and "no match" is never
 *   reported as "not studied".
 * - Cards are bound to the structure result they were looked up for and
 *   are not carried over to another result.
 *
 * The browser cannot run the RNAcentral MCP server, and rnacentral.org's
 * API sends no CORS headers, so this queries RNAcentral through EBI Search
 * (same EBI index, CORS-enabled) and literature through Europe PMC. The
 * RNAcentral AI literature summary itself is linked, not fetched.
 */
(function () {
  "use strict";

  const ADAPTER_VERSION = "rnaxray-web-evidence 1.0";
  const SCHEMA_VERSION = "1.0-web";
  const ENDPOINTS = {
    ebiSearch: "https://www.ebi.ac.uk/ebisearch/ws/rest/rnacentral",
    europePmc: "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
  };
  const REQUEST_TIMEOUT_MS = 20000;
  const MIN_REQUEST_GAP_MS = 500; // at most 2 requests a second
  const MAX_RESPONSE_CHARS = 512 * 1024;
  const MAX_ENTRIES = 5;

  // Same rules as the desktop shell: public identifiers only.
  const IDENTIFIER = /^[A-Za-z0-9_.:|-]{1,100}$/;
  const TAXON = /^[0-9]{1,10}$/;
  const URS = /^(URS[0-9A-F]{10})(?:_(\d{1,10}))?$/;

  const SPECIES = [
    { value: "", label: "Any species" },
    { value: "9606", label: "Human · 9606" },
    { value: "10090", label: "Mouse · 10090" },
    { value: "10116", label: "Rat · 10116" },
    { value: "7955", label: "Zebrafish · 7955" },
    { value: "7227", label: "Fruit fly · 7227" },
    { value: "6239", label: "C. elegans · 6239" },
    { value: "3702", label: "Arabidopsis · 3702" },
    { value: "559292", label: "S. cerevisiae S288C · 559292" },
    { value: "562", label: "E. coli · 562" },
    { value: "64320", label: "Zika virus · 64320" },
    { value: "2697049", label: "SARS-CoV-2 · 2697049" },
    { value: "11676", label: "HIV-1 · 11676" }
  ];

  // miRBase-style name prefixes with a known species. A contradicting
  // species is refused before any request, as on the desktop.
  const MIRNA_PREFIX_TAXON = {
    hsa: "9606", mmu: "10090", rno: "10116", dre: "7955", dme: "7227",
    cel: "6239", ath: "3702", gga: "9031", bta: "9913", ssc: "9823", aae: "7159"
  };
  const ENSEMBL_PREFIX_TAXON = { "": "9606", MUS: "10090", RNO: "10116", DAR: "7955" };

  const STATUS_TEXT = {
    success: "Matches found",
    no_match: "No match",
    upstream_error: "Service error",
    network_error: "Network error",
    timeout: "Timed out",
    cancelled: "Cancelled",
    unexpected_response: "Unexpected response"
  };
  const ATTACHABLE = { success: true, no_match: true };

  // ------------------------------------------------------------------
  // Identifiers
  // ------------------------------------------------------------------

  // Suggest public identifiers found in a HYB RNA name such as
  // "ENSG00000284190_ENST00000362134_MIR21_miRNA". Placeholders without
  // digits ("ENSG_ENST_...") are skipped.
  function candidates(name) {
    const text = String(name || "");
    const out = [];
    const add = function (value) {
      if (value && IDENTIFIER.test(value) && out.indexOf(value) === -1) out.push(value);
    };
    const refseq = text.match(/(?:^|[^A-Za-z0-9])((?:NR|NM|XR|XM)_\d{4,}(?:\.\d+)?)/);
    const tokens = text.split(/[_|\s]+/).filter(Boolean);
    tokens.forEach(function (token) {
      if (/^[a-z]{2,4}-(?:mir|miR|let|lin|bantam)-[A-Za-z0-9-]+$/.test(token)) add(token);
    });
    tokens.forEach(function (token) { if (/^ENS[A-Z]*T\d{6,}(?:\.\d+)?$/.test(token)) add(token.replace(/\.\d+$/, "")); });
    tokens.forEach(function (token) { if (/^ENS[A-Z]*G\d{6,}(?:\.\d+)?$/.test(token)) add(token.replace(/\.\d+$/, "")); });
    tokens.forEach(function (token) { if (/^(?:MIMAT\d{7}|MI\d{7})$/.test(token)) add(token); });
    // URS ids carry their taxon after an underscore, so match the whole name.
    const urs = text.match(/(?:^|[^A-Za-z0-9])(URS[0-9A-F]{10}(?:_\d{1,10})?)(?![A-Za-z0-9])/);
    if (urs) add(urs[1]);
    if (refseq) add(refseq[1]);
    // RNAxRay "GENEID_TRANSCRIPTID_SYMBOL_TYPE": the third field is the symbol.
    if (tokens.length >= 4 && /^ENS[A-Z]*G/.test(tokens[0]) && /^ENS[A-Z]*T/.test(tokens[1])) add(tokens[2]);
    if (!out.length && tokens.length === 1) add(tokens[0]);
    return out.slice(0, 6);
  }

  function prefixTaxon(identifier) {
    const mirna = /^([a-z]{2,4})-(?:mir|miR|let|lin|bantam)-/.exec(identifier || "");
    if (mirna && MIRNA_PREFIX_TAXON[mirna[1]]) return { taxon: MIRNA_PREFIX_TAXON[mirna[1]], basis: "miRBase prefix " + mirna[1] };
    const ensembl = /^ENS([A-Z]*?)(?:G|T)\d{6,}$/.exec(identifier || "");
    if (ensembl && Object.prototype.hasOwnProperty.call(ENSEMBL_PREFIX_TAXON, ensembl[1])) {
      return { taxon: ENSEMBL_PREFIX_TAXON[ensembl[1]], basis: "Ensembl prefix ENS" + ensembl[1] };
    }
    const urs = URS.exec(identifier || "");
    if (urs && urs[2]) return { taxon: urs[2], basis: "RNAcentral id suffix" };
    return null;
  }

  // Returns null when the lookup may be sent, otherwise the reason it is
  // refused. Nothing leaves the browser on a refusal.
  function validate(evidence) {
    if (!evidence || !evidence.enabled) return "Public lookups are off.";
    const identifier = String(evidence.identifier || "").trim();
    const taxon = String(evidence.taxon || "").trim();
    if (!identifier) return "Enter a public identifier.";
    if (!IDENTIFIER.test(identifier)) return "Use a public identifier: 1–100 letters, digits and - _ . : |.";
    if (taxon && !TAXON.test(taxon)) return "Species must be an NCBI taxon ID (digits).";
    const urs = URS.exec(identifier);
    if (urs && !urs[2] && !taxon) return "Choose a species for an RNAcentral URS identifier.";
    const implied = prefixTaxon(identifier);
    if (implied && taxon && implied.taxon !== taxon) {
      return "The " + implied.basis + " implies taxon " + implied.taxon + ", not " + taxon + ". Check the identifier or species.";
    }
    if (!evidence.confirmed) return "Confirm that the identifier and species match the RNA you are studying.";
    return null;
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  function ebiQuery(identifier, taxon) {
    const urs = URS.exec(identifier);
    if (urs) return "id:" + urs[1] + "_" + (urs[2] || taxon);
    return '"' + identifier + '"' + (taxon ? " AND TAXONOMY:" + taxon : "");
  }

  function ebiUrl(identifier, taxon) {
    return ENDPOINTS.ebiSearch + "?" + [
      "query=" + encodeURIComponent(ebiQuery(identifier, taxon)),
      "format=json",
      "size=" + MAX_ENTRIES,
      "fields=" + ["description", "rna_type", "has_litsumm", "n_citations", "expert_db"].join(",")
    ].join("&");
  }

  // Europe PMC gets the identifier only; the species never goes there.
  function europePmcUrl(identifier) {
    return ENDPOINTS.europePmc + "?" + [
      "query=" + encodeURIComponent('"' + identifier + '"'),
      "format=json",
      "resultType=lite",
      "pageSize=" + MAX_ENTRIES
    ].join("&");
  }

  // ------------------------------------------------------------------
  // Classification
  // ------------------------------------------------------------------

  function clip(value, length) {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return text.length > length ? text.slice(0, length - 1) + "…" : text;
  }

  // Europe PMC titles carry markup such as "&lt;i&gt;Aedes&lt;/i&gt;".
  // Reduce them to plain text; rendering escapes it once.
  function plain(value) {
    let text = String(value == null ? "" : value);
    for (let pass = 0; pass < 2; pass += 1) {
      text = text.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&amp;/gi, "&");
    }
    return text.replace(/<[^>]*>/g, "");
  }

  function first(value) {
    return Array.isArray(value) ? value[0] : value;
  }

  function rnacentralPage(id) {
    const urs = URS.exec(String(id || ""));
    return urs && urs[2] ? "https://rnacentral.org/rna/" + urs[1] + "/" + urs[2] : null;
  }

  function classifyEbi(response) {
    const json = response.json;
    if (!json || typeof json !== "object" || !Array.isArray(json.entries) || typeof json.hitCount !== "number") {
      return { status: "unexpected_response", detail: "EBI Search answered without a result list." };
    }
    const entries = json.entries.slice(0, MAX_ENTRIES).map(function (entry) {
      const fields = entry && entry.fields || {};
      return {
        id: clip(entry && entry.id, 60),
        description: clip(first(fields.description), 240),
        rnaType: clip(first(fields.rna_type), 60),
        hasLitSumm: String(first(fields.has_litsumm)) === "True",
        citations: Number(first(fields.n_citations)) || 0,
        databases: (Array.isArray(fields.expert_db) ? fields.expert_db : []).slice(0, 8).map(function (name) { return clip(name, 40); }),
        url: rnacentralPage(entry && entry.id)
      };
    });
    return { status: json.hitCount > 0 ? "success" : "no_match", hitCount: json.hitCount, entries: entries };
  }

  function classifyEuropePmc(response) {
    const json = response.json;
    const list = json && json.resultList && json.resultList.result;
    if (!json || typeof json.hitCount !== "number" || !Array.isArray(list)) {
      return { status: "unexpected_response", detail: "Europe PMC answered without a result list." };
    }
    const entries = list.slice(0, MAX_ENTRIES).map(function (paper) {
      const source = /^[A-Z]{3}$/.test(String(paper.source || "")) ? paper.source : "MED";
      const id = /^[A-Za-z0-9]{1,20}$/.test(String(paper.id || "")) ? paper.id : null;
      return {
        title: clip(plain(paper.title), 300),
        authors: clip(paper.authorString, 160),
        journal: clip(paper.journalTitle, 120),
        year: clip(paper.pubYear, 8),
        pmid: /^\d{1,9}$/.test(String(paper.pmid || "")) ? String(paper.pmid) : null,
        doi: clip(paper.doi, 120) || null,
        url: id ? "https://europepmc.org/article/" + source + "/" + id : null
      };
    });
    return { status: json.hitCount > 0 ? "success" : "no_match", hitCount: json.hitCount, entries: entries };
  }

  // ------------------------------------------------------------------
  // Network: GET only, two fixed endpoints, no credentials or referrer.
  // ------------------------------------------------------------------

  let lastRequestAt = 0;

  function allowed(url) {
    return url.indexOf(ENDPOINTS.ebiSearch + "?") === 0 || url.indexOf(ENDPOINTS.europePmc + "?") === 0;
  }

  async function getJson(url, signal, fetchImpl, now, sleep) {
    if (!allowed(url)) throw new Error("Refused a request outside the public lookup endpoints.");
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: signal
      });
    } catch (error) {
      if (signal && signal.aborted) return { aborted: true };
      return { networkError: true, detail: clip(error && error.message || "The request did not reach the service.", 160) };
    }
    if (!response.ok) return { httpStatus: response.status, detail: "HTTP " + response.status };
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (signal && signal.aborted) return { aborted: true };
      return { networkError: true, detail: "The response was interrupted." };
    }
    if (text.length > MAX_RESPONSE_CHARS) return { malformed: true, detail: "Response larger than 512 KiB." };
    try {
      return { json: JSON.parse(text) };
    } catch (error) {
      return { malformed: true, detail: "Response was not JSON." };
    }
  }

  function outcome(raw, classify) {
    if (raw.aborted) return { status: raw.timedOut ? "timeout" : "cancelled" };
    if (raw.networkError) return { status: "network_error", detail: raw.detail };
    if (raw.httpStatus) return { status: "upstream_error", detail: raw.detail };
    if (raw.malformed) return { status: "unexpected_response", detail: raw.detail };
    return classify(raw);
  }

  // ------------------------------------------------------------------
  // Cards and binding
  // ------------------------------------------------------------------

  // FNV-1a over the dot-bracket: enough to tell results apart in-session.
  function digest(text) {
    let hash = 0x811c9dc5;
    const value = String(text || "");
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return "fnv1a:" + hash.toString(16).padStart(8, "0");
  }

  function bindingFor(state) {
    const structure = state && state.structure || {};
    const result = structure.result;
    return {
      source: structure.source || null,
      rna: structure.source === "reference" ? structure.rna || null : null,
      start: structure.source === "reference" ? Number(structure.start) || null : null,
      end: structure.source === "reference" ? Number(structure.end) || null : null,
      engine: structure.engine || "viennarna",
      resultDigest: result && result.dotBracket ? digest(result.dotBracket) : null
    };
  }

  function sameBinding(a, b) {
    return !!a && !!b && a.source === b.source && a.rna === b.rna && a.start === b.start &&
      a.end === b.end && a.engine === b.engine && a.resultDigest === b.resultDigest;
  }

  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return "ev-" + window.crypto.randomUUID().replace(/-/g, "");
    return "ev-" + Date.now().toString(16) + Math.floor(Math.random() * 1e9).toString(16);
  }

  function makeCard(kind, query, requestedAt, result, binding) {
    const ebi = kind === "ebi";
    return {
      schema_version: SCHEMA_VERSION,
      evidence_id: newId(),
      source_provider: ebi ? "RNAcentral (via EBI Search)" : "Europe PMC",
      source_tool: ebi ? "ebisearch/rnacentral" : "europepmc/search",
      adapter_version: ADAPTER_VERSION,
      query_identifier: query.identifier,
      taxon: ebi ? (query.taxon || null) : null,
      identity_confirmation: "user_confirmed",
      requested_at: requestedAt,
      retrieved_at: ATTACHABLE[result.status] || result.status === "upstream_error" ? new Date().toISOString() : null,
      status: result.status,
      status_detail: result.detail || null,
      content_kind: ebi ? "database_metadata" : "literature_index",
      hit_count: typeof result.hitCount === "number" ? result.hitCount : null,
      entries: result.entries || [],
      source_url: ebi
        ? "https://rnacentral.org/search?q=" + encodeURIComponent(query.identifier)
        : "https://europepmc.org/search?query=" + encodeURIComponent('"' + query.identifier + '"'),
      citation_verification: "not_checked",
      relation_to_current_structure: "background_only",
      review: { state: "unreviewed", note: "" },
      binding: binding,
      include_in_report: false
    };
  }

  // ------------------------------------------------------------------
  // State and lookups
  // ------------------------------------------------------------------

  function ensure(state) {
    if (!state.evidence) {
      state.evidence = { enabled: false, identifier: "", taxon: "", confirmed: false, rnaKey: null, running: false, message: null, cards: [] };
    }
    const evidence = state.evidence;
    // Suggest an identifier and species for the RNA in view; keep what the
    // user typed until the RNA changes.
    const structure = state.structure || {};
    const names = structureRnaNames(state);
    const key = names.join("|");
    if (evidence.rnaKey !== key) {
      evidence.rnaKey = key;
      const suggestion = names.map(candidates).reduce(function (all, list) { return all.concat(list); }, [])[0] || "";
      evidence.identifier = suggestion;
      const implied = prefixTaxon(suggestion);
      evidence.taxon = implied ? implied.taxon : "";
      evidence.confirmed = false;
      evidence.message = null;
    }
    evidence.binding = bindingFor({ structure: structure });
    return evidence;
  }

  function structureRnaNames(state) {
    const structure = state.structure || {};
    if (structure.source === "reference") return [structure.rna, structure.secondRna].filter(Boolean);
    if (structure.source === "record" && structure.selectedRecordIndex !== null && structure.selectedRecordIndex !== undefined) {
      const record = loadedRecord(state, structure.selectedRecordIndex);
      return record ? [record.rnaOne, record.rnaTwo].filter(function (name, index, list) { return name && list.indexOf(name) === index; }) : [];
    }
    return [];
  }

  // The selected record among rows the page-data layer has already fetched
  // through the DataProvider (structure choices, open record, table window).
  function loadedRecord(state, index) {
    const target = String(index);
    const view = state.view || {};
    const singles = [view.structureSelectedRecord, view.selectedRecord];
    for (let i = 0; i < singles.length; i += 1) {
      if (singles[i] && singles[i].record && String(singles[i].record.index) === target) return singles[i].record;
    }
    const lists = [view.structureRecords, view.interactions && view.interactions.rows];
    for (let i = 0; i < lists.length; i += 1) {
      const match = Array.isArray(lists[i]) ? lists[i].find(function (item) { return String(item.index) === target; }) : null;
      if (match) return match;
    }
    return null;
  }

  let activeController = null;

  async function lookup(state, api, options) {
    const opts = options || {};
    const fetchImpl = opts.fetch || window.fetch.bind(window);
    const now = opts.now || function () { return Date.now(); };
    const sleep = opts.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    const evidence = ensure(state);
    const refusal = validate(evidence);
    if (refusal) {
      evidence.message = refusal;
      api.render();
      return { refused: refusal };
    }
    if (evidence.running) return { refused: "A lookup is already running." };
    const query = { identifier: String(evidence.identifier).trim(), taxon: String(evidence.taxon || "").trim() };
    const binding = bindingFor(state);
    const controller = new AbortController();
    let timedOut = false;
    activeController = controller;
    evidence.running = true;
    evidence.message = null;
    api.render();
    const timer = setTimeout(function () { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    const requestedAt = new Date().toISOString();
    const cards = [];
    try {
      const ebiRaw = await getJson(ebiUrl(query.identifier, query.taxon), controller.signal, fetchImpl, now, sleep);
      ebiRaw.timedOut = timedOut;
      cards.push(makeCard("ebi", query, requestedAt, outcome(ebiRaw, classifyEbi), binding));
      if (!controller.signal.aborted) {
        const pmcRaw = await getJson(europePmcUrl(query.identifier), controller.signal, fetchImpl, now, sleep);
        pmcRaw.timedOut = timedOut;
        cards.push(makeCard("pmc", query, requestedAt, outcome(pmcRaw, classifyEuropePmc), binding));
      }
    } finally {
      clearTimeout(timer);
      if (activeController === controller) activeController = null;
    }
    // A cleared session or a new file drops late answers.
    if (state.evidence !== evidence) return { dropped: true };
    evidence.running = false;
    evidence.cards = cards.concat(evidence.cards).slice(0, 24);
    api.render();
    return { cards: cards };
  }

  function cancel() {
    if (activeController) activeController.abort();
  }

  function isCurrent(card, state) {
    return sameBinding(card.binding, bindingFor(state));
  }

  // Included cards bound to the current result, for the report.
  function reportCards(state) {
    const evidence = state && state.evidence;
    if (!evidence) return [];
    return evidence.cards.filter(function (card) { return card.include_in_report && isCurrent(card, state); });
  }

  // ------------------------------------------------------------------
  // UI events (routed from analysis-ui.js)
  // ------------------------------------------------------------------

  function findCard(state, id) {
    return state.evidence && state.evidence.cards.find(function (card) { return card.evidence_id === id; });
  }

  function handleAction(action, state, api, element) {
    if (action.indexOf("evidence-") !== 0) return false;
    const evidence = ensure(state);
    if (action === "evidence-enable") { evidence.enabled = true; evidence.message = null; api.render(); return true; }
    if (action === "evidence-disable") { cancel(); evidence.enabled = false; evidence.confirmed = false; api.render(); return true; }
    if (action === "evidence-pick") {
      evidence.identifier = element.getAttribute("data-value") || "";
      const implied = prefixTaxon(evidence.identifier);
      if (implied) evidence.taxon = implied.taxon;
      evidence.confirmed = false;
      evidence.message = null;
      api.render();
      return true;
    }
    if (action === "evidence-lookup") { lookup(state, api); return true; }
    if (action === "evidence-cancel") { cancel(); return true; }
    if (action === "evidence-remove") {
      const id = element.getAttribute("data-evidence-id");
      evidence.cards = evidence.cards.filter(function (card) { return card.evidence_id !== id; });
      api.render();
      return true;
    }
    return true;
  }

  function controlValue(element) {
    return element.type === "checkbox" ? element.checked : element.value;
  }

  // Typing: update state without a render, and keep the Look up button honest.
  function handleInput(state, element) {
    const feature = element.dataset.feature;
    if (feature !== "evidence-control" && feature !== "evidence-card") return false;
    applyControl(state, element);
    const button = document.querySelector('[data-feature-action="evidence-lookup"]');
    if (button) button.disabled = !!validate(state.evidence) || state.evidence.running;
    return true;
  }

  function handleChange(state, element, api) {
    const feature = element.dataset.feature;
    if (feature !== "evidence-control" && feature !== "evidence-card") return false;
    applyControl(state, element);
    api.render();
    return true;
  }

  function applyControl(state, element) {
    const evidence = ensure(state);
    const key = element.dataset.key;
    if (element.dataset.feature === "evidence-card") {
      const card = findCard(state, element.dataset.evidenceId);
      if (!card) return;
      if (key === "review" && ["unreviewed", "reviewed", "rejected"].indexOf(element.value) > -1) card.review.state = element.value;
      if (key === "note") card.review.note = String(element.value || "").slice(0, 600);
      if (key === "include") card.include_in_report = !!element.checked && !!ATTACHABLE[card.status] && isCurrent(card, state);
      return;
    }
    if (key === "identifier") {
      evidence.identifier = String(element.value || "").slice(0, 100);
      evidence.confirmed = false;
      const box = document.querySelector('[data-feature="evidence-control"][data-key="confirmed"]');
      if (box) box.checked = false;
    }
    if (key === "taxon") { evidence.taxon = String(element.value || ""); evidence.confirmed = false; }
    if (key === "confirmed") evidence.confirmed = !!controlValue(element);
    evidence.message = null;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;").replace(/`/g, "&#096;");
  }

  function link(url, label) {
    return /^https:\/\/(rnacentral\.org|europepmc\.org)\//.test(String(url || ""))
      ? '<a href="' + escape(url) + '" target="_blank" rel="noopener noreferrer">' + escape(label) + "</a>"
      : escape(label);
  }

  function speciesLabel(taxon) {
    const match = SPECIES.find(function (item) { return item.value === String(taxon || ""); });
    return match ? match.label : "Taxon " + taxon;
  }

  function renderPanel(state) {
    const evidence = ensure(state);
    const head = '<div class="card-title-row"><div><span class="card-kicker evidence-kicker">Public databases</span><h2 id="evidence-title">Related research</h2></div>' +
      '<span class="method-badge">' + (evidence.enabled ? "Lookups on · EBI" : "Off") + "</span></div>";
    if (!evidence.enabled) {
      return [
        '<section class="evidence-panel data-card" aria-labelledby="evidence-title">', head,
        '<p class="evidence-lede">See what public databases already record about this RNA: its RNAcentral entries (through EBI Search) and Europe PMC papers that mention it.</p>',
        '<p class="evidence-boundary"><strong>Off by default.</strong> When you turn lookups on, only the identifier and species you confirm are sent to www.ebi.ac.uk. HYB files, sequences, structures and file names stay in this browser.</p>',
        '<button class="button button-secondary" type="button" data-feature-action="evidence-enable">Turn on public lookups</button>',
        "</section>"
      ].join("");
    }
    const suggestions = structureRnaNames(state).map(candidates).reduce(function (all, list) { return all.concat(list); }, [])
      .filter(function (value, index, list) { return list.indexOf(value) === index; });
    const implied = prefixTaxon(String(evidence.identifier || "").trim());
    const refusal = validate(evidence);
    const current = evidence.cards.filter(function (card) { return isCurrent(card, state); });
    const earlier = evidence.cards.filter(function (card) { return !isCurrent(card, state); });
    return [
      '<section class="evidence-panel data-card" aria-labelledby="evidence-title">', head,
      '<div class="evidence-query">',
      '<label class="control-field"><span>Public identifier</span><input type="text" spellcheck="false" autocomplete="off" maxlength="100" value="' + escape(evidence.identifier) + '" data-feature="evidence-control" data-key="identifier" aria-describedby="evidence-sends"></label>',
      '<label class="control-field"><span>Species</span><select data-feature="evidence-control" data-key="taxon">' +
        SPECIES.concat(evidence.taxon && !SPECIES.some(function (item) { return item.value === evidence.taxon; }) ? [{ value: evidence.taxon, label: "Taxon " + evidence.taxon }] : [])
          .map(function (item) { return '<option value="' + escape(item.value) + '"' + (item.value === String(evidence.taxon || "") ? " selected" : "") + ">" + escape(item.label) + "</option>"; }).join("") +
        "</select></label>",
      "</div>",
      suggestions.length ? '<div class="evidence-suggestions"><span>From the RNA name:</span>' + suggestions.map(function (value) {
        return '<button class="quiet-button evidence-chip' + (value === evidence.identifier ? " is-selected" : "") + '" type="button" data-feature-action="evidence-pick" data-value="' + escape(value) + '">' + escape(value) + "</button>";
      }).join("") + "</div>" : '<p class="evidence-note">No identifier could be read from the current RNA. Type a public identifier such as an Ensembl transcript ID or a miRBase name.</p>',
      implied ? '<p class="evidence-note">The ' + escape(implied.basis) + " implies " + escape(speciesLabel(implied.taxon)) + ".</p>" : "",
      '<label class="evidence-confirm"><input type="checkbox" data-feature="evidence-control" data-key="confirmed"' + (evidence.confirmed ? " checked" : "") + "><span>This identifier and species match the RNA I am studying.</span></label>",
      '<p class="evidence-sends" id="evidence-sends">Sends <code>' + escape(String(evidence.identifier || "").trim() || "—") + "</code>" +
        (evidence.taxon ? " and taxon <code>" + escape(evidence.taxon) + "</code>" : "") + " to EBI Search, and the identifier alone to Europe PMC. Nothing else leaves this browser.</p>",
      '<div class="evidence-actions">',
      evidence.running
        ? '<button class="button button-secondary" type="button" data-feature-action="evidence-cancel">Cancel lookup</button><span class="evidence-running" role="status">Looking up…</span>'
        : '<button class="button" type="button" data-feature-action="evidence-lookup"' + (refusal ? " disabled" : "") + ">Look up</button>",
      '<button class="quiet-button" type="button" data-feature-action="evidence-disable">Turn off</button>',
      "</div>",
      evidence.message ? '<div class="notice notice-warning" role="status">' + escape(evidence.message) + "</div>" : "",
      current.length ? '<div class="evidence-cards">' + current.map(function (card) { return renderCard(card, true); }).join("") + "</div>" : "",
      earlier.length ? '<details class="evidence-earlier"><summary>Earlier lookups for another result (' + earlier.length + ")</summary><p class=\"evidence-note\">These were looked up for a different RNA, range or structure. They are kept for reference and cannot be added to this result's report.</p>" +
        earlier.map(function (card) { return renderCard(card, false); }).join("") + "</details>" : "",
      "</section>"
    ].join("");
  }

  function renderEntries(card) {
    if (card.content_kind === "database_metadata") {
      return '<ul class="evidence-entries">' + card.entries.map(function (entry) {
        return "<li><strong>" + link(entry.url, entry.id) + "</strong> " + escape(entry.description) +
          '<span class="evidence-meta">' + [entry.rnaType, entry.citations ? entry.citations + " linked publications" : "", entry.databases.length ? "in " + entry.databases.join(", ") : ""].filter(Boolean).map(escape).join(" · ") + "</span>" +
          (entry.hasLitSumm && entry.url ? '<span class="evidence-litsumm">RNAcentral has an AI-generated literature summary for this entry: ' + link(entry.url, "read it on RNAcentral") + " (not fetched here).</span>" : "") +
          "</li>";
      }).join("") + "</ul>";
    }
    return '<ul class="evidence-entries">' + card.entries.map(function (entry) {
      return "<li><strong>" + link(entry.url, entry.title || "Untitled") + "</strong>" +
        '<span class="evidence-meta">' + [entry.authors, entry.journal, entry.year, entry.pmid ? "PMID " + entry.pmid : ""].filter(Boolean).map(escape).join(" · ") + "</span></li>";
    }).join("") + "</ul>";
  }

  function statusLine(card) {
    if (card.status === "success") {
      return card.content_kind === "database_metadata"
        ? card.hit_count + " RNAcentral " + (card.hit_count === 1 ? "entry" : "entries") + " matched" + (card.hit_count > card.entries.length ? "; showing " + card.entries.length : "") + "."
        : card.hit_count + " " + (card.hit_count === 1 ? "paper mentions" : "papers mention") + " this identifier" + (card.hit_count > card.entries.length ? "; showing " + card.entries.length : "") + ".";
    }
    if (card.status === "no_match") {
      return card.content_kind === "database_metadata"
        ? "No RNAcentral entry matched this identifier and species. This does not mean the RNA is unstudied."
        : "No Europe PMC record mentions this exact identifier. Papers may use another name.";
    }
    return (STATUS_TEXT[card.status] || card.status) + (card.status_detail ? ": " + card.status_detail : "") + ". Nothing was recorded from this service.";
  }

  function renderCard(card, current) {
    const attachable = !!ATTACHABLE[card.status] && current;
    const label = card.content_kind === "database_metadata"
      ? "Database record — background only, not a validation of this structure."
      : "Literature index — a mention is not evidence for this structure; citations not verified.";
    return [
      '<article class="evidence-card is-' + escape(card.status) + '">',
      '<header><span class="evidence-provider">' + escape(card.source_provider) + '</span><span class="evidence-status">' + escape(STATUS_TEXT[card.status] || card.status) + "</span></header>",
      '<p class="evidence-query-line"><code>' + escape(card.query_identifier) + "</code>" + (card.taxon ? " · " + escape(speciesLabel(card.taxon)) : "") +
        (card.retrieved_at ? ' · <time datetime="' + escape(card.retrieved_at) + '">' + escape(card.retrieved_at.replace("T", " ").slice(0, 16)) + " UTC</time>" : "") + "</p>",
      '<p class="evidence-status-line">' + escape(statusLine(card)) + "</p>",
      card.entries.length ? renderEntries(card) : "",
      '<p class="evidence-label">' + escape(label) + " " + link(card.source_url, "Open the full search") + "</p>",
      current ? [
        '<div class="evidence-review">',
        '<label class="control-field"><span>Review</span><select data-feature="evidence-card" data-key="review" data-evidence-id="' + escape(card.evidence_id) + '">' +
          [["unreviewed", "Not reviewed"], ["reviewed", "Reviewed"], ["rejected", "Rejected"]].map(function (option) {
            return '<option value="' + option[0] + '"' + (card.review.state === option[0] ? " selected" : "") + ">" + option[1] + "</option>";
          }).join("") + "</select></label>",
        '<label class="control-field evidence-note-field"><span>Researcher note</span><input type="text" maxlength="600" value="' + escape(card.review.note) + '" data-feature="evidence-card" data-key="note" data-evidence-id="' + escape(card.evidence_id) + '"></label>',
        '<label class="evidence-include"><input type="checkbox" data-feature="evidence-card" data-key="include" data-evidence-id="' + escape(card.evidence_id) + '"' + (card.include_in_report ? " checked" : "") + (attachable ? "" : " disabled") + "><span>Add to report</span></label>",
        "</div>"
      ].join("") : "",
      '<button class="quiet-button evidence-remove" type="button" data-feature-action="evidence-remove" data-evidence-id="' + escape(card.evidence_id) + '">Remove</button>',
      "</article>"
    ].join("");
  }

  window.RNAxRayEvidence = {
    ENDPOINTS: ENDPOINTS,
    SPECIES: SPECIES,
    candidates: candidates,
    prefixTaxon: prefixTaxon,
    validate: validate,
    ebiQuery: ebiQuery,
    ebiUrl: ebiUrl,
    europePmcUrl: europePmcUrl,
    classifyEbi: classifyEbi,
    classifyEuropePmc: classifyEuropePmc,
    outcome: outcome,
    digest: digest,
    bindingFor: bindingFor,
    isCurrent: isCurrent,
    ensure: ensure,
    lookup: lookup,
    cancel: cancel,
    reportCards: reportCards,
    statusLine: statusLine,
    STATUS_TEXT: STATUS_TEXT,
    handleAction: handleAction,
    handleInput: handleInput,
    handleChange: handleChange,
    renderPanel: renderPanel
  };
})();

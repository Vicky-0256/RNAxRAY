"use strict";

// Contract for Related research (web/evidence.js), the web counterpart of
// the desktop RNAcentral evidence feature (desktop/spec/EVIDENCE.md).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const web = path.resolve(__dirname, "..", "web");
const source = fs.readFileSync(path.join(web, "evidence.js"), "utf8");

function load() {
  const window = { crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" } };
  const context = vm.createContext({ window, AbortController, setTimeout, clearTimeout, Promise, Date, Math, JSON, encodeURIComponent, String, Number, Array, Object, RegExp, document: { querySelector: () => null } });
  vm.runInContext(source, context, { filename: "evidence.js" });
  return window.RNAxRayEvidence;
}

const E = load();

// ------------------------------------------------------------ identifiers

assert.deepEqual(Array.from(E.candidates("ENSG00000284190_ENST00000362134_MIR21_miRNA")),
  ["ENST00000362134", "ENSG00000284190", "MIR21"], "RNAxRay names give transcript, gene and symbol");
assert.deepEqual(Array.from(E.candidates("MIMAT0000076_MirBase_hsa-miR-21-5p_microRNA")),
  ["hsa-miR-21-5p", "MIMAT0000076"], "miRBase names come first");
assert.deepEqual(Array.from(E.candidates("ENSG_ENST_ZIKV-PE243-2015_virusRNA")), ["ZIKV-PE243-2015"],
  "placeholder ENSG/ENST fields are skipped; the symbol field is still offered");
assert.deepEqual(Array.from(E.candidates("NR_029493.1")), ["NR_029493.1"], "RefSeq accessions keep their underscore");
assert.deepEqual(Array.from(E.candidates("URS000039ED8D_9606")), ["URS000039ED8D_9606"]);
assert.deepEqual(Array.from(E.candidates("<script>alert(1)</script>")), [], "nothing outside the identifier alphabet is suggested");

assert.equal(E.prefixTaxon("hsa-mir-21").taxon, "9606");
assert.equal(E.prefixTaxon("mmu-miR-155-5p").taxon, "10090");
assert.equal(E.prefixTaxon("ENST00000362134").taxon, "9606");
assert.equal(E.prefixTaxon("ENSMUST00000082908").taxon, "10090");
assert.equal(E.prefixTaxon("MIR21"), null);

const base = { enabled: true, identifier: "hsa-mir-21", taxon: "9606", confirmed: true };
assert.equal(E.validate(base), null, "a confirmed public identifier may be sent");
assert.match(E.validate(Object.assign({}, base, { enabled: false })), /off/, "lookups are off by default");
assert.match(E.validate(Object.assign({}, base, { confirmed: false })), /Confirm/, "identity must be confirmed");
assert.match(E.validate(Object.assign({}, base, { taxon: "10090" })), /implies taxon 9606/, "a contradicting species is refused");
assert.match(E.validate(Object.assign({}, base, { identifier: "ACGU ACGU" })), /public identifier/, "sequences and spaces are refused");
assert.match(E.validate(Object.assign({}, base, { identifier: "A".repeat(101) })), /public identifier/);
assert.match(E.validate(Object.assign({}, base, { identifier: "URS000039ED8D", taxon: "" })), /species/, "a bare URS needs a species");
assert.match(E.validate(Object.assign({}, base, { taxon: "human" })), /taxon ID/);

// ---------------------------------------------------------------- queries

assert.equal(E.ebiQuery("hsa-mir-21", "9606"), '"hsa-mir-21" AND TAXONOMY:9606');
assert.equal(E.ebiQuery("MIR21", ""), '"MIR21"');
assert.equal(E.ebiQuery("URS000039ED8D", "9606"), "id:URS000039ED8D_9606");
assert.equal(E.ebiQuery("URS000039ED8D_10090", ""), "id:URS000039ED8D_10090");
assert.ok(E.ebiUrl("hsa-mir-21", "9606").startsWith(E.ENDPOINTS.ebiSearch + "?query=%22hsa-mir-21%22%20AND%20TAXONOMY%3A9606&format=json"));
assert.equal(E.europePmcUrl("hsa-mir-21"), E.ENDPOINTS.europePmc + "?query=%22hsa-mir-21%22&format=json&resultType=lite&pageSize=5",
  "Europe PMC receives the identifier only, never the species");
assert.ok(E.ENDPOINTS.ebiSearch.startsWith("https://www.ebi.ac.uk/") && E.ENDPOINTS.europePmc.startsWith("https://www.ebi.ac.uk/"));

// --------------------------------------------------------- classification

const ebiHit = { json: { hitCount: 3, entries: [{ id: "URS00000AF93C_9606", fields: { description: ["Homo sapiens (human) microRNA hsa-mir-21 precursor"], rna_type: ["pre miRNA"], has_litsumm: ["True"], n_citations: ["106"], expert_db: ["MIRBASE", "HGNC"] } }] } };
const ebi = E.classifyEbi(ebiHit);
assert.equal(ebi.status, "success");
assert.equal(ebi.entries[0].url, "https://rnacentral.org/rna/URS00000AF93C/9606");
assert.equal(ebi.entries[0].hasLitSumm, true);
assert.equal(ebi.entries[0].citations, 106);
assert.equal(E.classifyEbi({ json: { hitCount: 0, entries: [] } }).status, "no_match");
assert.equal(E.classifyEbi({ json: { results: [] } }).status, "unexpected_response");
const pmc = E.classifyEuropePmc({ json: { hitCount: 2, resultList: { result: [{ id: "24297251", source: "MED", pmid: "24297251", title: "starBase v2.0", authorString: "Li JH", journalTitle: "NAR", pubYear: "2014" }, { id: "../../evil", source: "javascript:", title: "x" }] } } });
assert.equal(pmc.entries[0].url, "https://europepmc.org/article/MED/24297251");
assert.equal(pmc.entries[1].url, null, "paper links are built only from well-formed ids");
assert.equal(E.classifyEuropePmc({ json: { hitCount: 1, resultList: { result: [{ id: "1", title: "Infection in &lt;i&gt;Aedes aegypti&lt;/i&gt; &amp; Culex" }] } } }).entries[0].title,
  "Infection in Aedes aegypti & Culex", "Europe PMC markup becomes plain text before it is escaped once");
assert.equal(E.outcome({ httpStatus: 503, detail: "HTTP 503" }, E.classifyEbi).status, "upstream_error");
assert.equal(E.outcome({ networkError: true }, E.classifyEbi).status, "network_error");
assert.equal(E.outcome({ malformed: true }, E.classifyEbi).status, "unexpected_response");
assert.equal(E.outcome({ aborted: true, timedOut: true }, E.classifyEbi).status, "timeout");
assert.equal(E.outcome({ aborted: true }, E.classifyEbi).status, "cancelled");

["success", "no_match", "upstream_error", "network_error", "timeout", "cancelled", "unexpected_response"].forEach((status) => {
  ["database_metadata", "literature_index"].forEach((kind) => {
    const line = E.statusLine({ status, content_kind: kind, hit_count: 0, entries: [] });
    assert.doesNotMatch(line, /\bnot studied\b|\bno research\b|\bnobody\b/i, "status text never claims an RNA is unstudied");
  });
});
assert.match(E.statusLine({ status: "no_match", content_kind: "database_metadata", entries: [] }), /does not mean the RNA is unstudied/);

// -------------------------------------------------------- lookups (mocked)

function stateFor(overrides) {
  return Object.assign({
    structure: { source: "reference", rna: "ENSG00000284190_ENST00000362134_MIR21_miRNA", start: 1, end: 72, engine: "viennarna", result: { dotBracket: "((((....))))" } },
    records: []
  }, overrides || {});
}

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status === 200, status: next.status, text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)) };
  };
}

(async () => {
  let clock = 0;
  const timing = { now: () => (clock += 1000), sleep: async () => {} };
  const api = { renders: 0, render() { this.renders += 1; } };

  // Off by default: nothing is sent.
  {
    const state = stateFor(); const calls = [];
    const evidence = E.ensure(state);
    assert.equal(evidence.enabled, false);
    assert.equal(evidence.identifier, "ENST00000362134", "the first identifier from the RNA name is suggested");
    assert.equal(evidence.taxon, "9606", "the Ensembl prefix suggests the species");
    assert.equal(evidence.confirmed, false);
    const result = await E.lookup(state, api, Object.assign({ fetch: fakeFetch([], calls) }, timing));
    assert.ok(result.refused); assert.equal(calls.length, 0, "a refused lookup sends nothing");
    evidence.enabled = true;
    assert.ok((await E.lookup(state, api, Object.assign({ fetch: fakeFetch([], calls) }, timing))).refused);
    assert.equal(calls.length, 0, "an unconfirmed identifier sends nothing");
  }

  // Confirmed: two GETs to the fixed endpoints, no credentials or referrer.
  {
    const state = stateFor(); const calls = [];
    const evidence = E.ensure(state);
    Object.assign(evidence, { enabled: true, confirmed: true });
    const result = await E.lookup(state, api, Object.assign({ fetch: fakeFetch([
      { status: 200, body: ebiHit.json },
      { status: 200, body: { hitCount: 0, resultList: { result: [] } } }
    ], calls) }, timing));
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.startsWith(E.ENDPOINTS.ebiSearch + "?"));
    assert.ok(calls[1].url.startsWith(E.ENDPOINTS.europePmc + "?"));
    calls.forEach(({ url, init }) => {
      assert.equal(init.method, "GET"); assert.equal(init.credentials, "omit"); assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(init.body, undefined, "no request body");
      assert.doesNotMatch(url, /ACGU|\(\(\(|\.hyb|ZIKV|start=|end=/i, "no sequence, structure, file or range leaves the browser");
    });
    assert.equal(result.cards.length, 2);
    const [card, paper] = result.cards;
    assert.equal(card.status, "success"); assert.equal(paper.status, "no_match");
    assert.equal(card.identity_confirmation, "user_confirmed");
    assert.equal(card.relation_to_current_structure, "background_only");
    assert.equal(card.citation_verification, "not_checked");
    assert.equal(card.review.state, "unreviewed");
    assert.equal(card.include_in_report, false, "cards join the report only when the researcher adds them");
    assert.equal(paper.taxon, null);
    assert.equal(E.isCurrent(card, state), true);
    assert.equal(E.reportCards(state).length, 0);
    card.include_in_report = true;
    assert.equal(E.reportCards(state).length, 1);

    // Another result: the card is no longer current and leaves the report.
    state.structure.result = { dotBracket: "(((....)))..." };
    assert.equal(E.isCurrent(card, state), false, "a card is bound to the result it was looked up for");
    assert.equal(E.reportCards(state).length, 0, "cards for another result never reach the report");
    state.structure.result = { dotBracket: "((((....))))" };
    state.structure.end = 80;
    assert.equal(E.isCurrent(card, state), false, "a different range is another result");
  }

  // Errors and refusal of a second concurrent lookup.
  {
    const state = stateFor(); const calls = [];
    Object.assign(E.ensure(state), { enabled: true, confirmed: true });
    const result = await E.lookup(state, api, Object.assign({ fetch: fakeFetch([new Error("Failed to fetch"), { status: 503, body: "busy" }], calls) }, timing));
    assert.equal(result.cards[0].status, "network_error");
    assert.equal(result.cards[1].status, "upstream_error");
    assert.equal(result.cards[0].entries.length, 0);
    const big = await E.lookup(state, api, Object.assign({ fetch: fakeFetch([{ status: 200, body: "x".repeat(600 * 1024) }, { status: 200, body: "not json" }], []) }, timing));
    assert.equal(big.cards[0].status, "unexpected_response");
    assert.equal(big.cards[1].status, "unexpected_response");
  }

  // Cancel mid-request, and a session cleared while a request is out.
  {
    const state = stateFor();
    Object.assign(E.ensure(state), { enabled: true, confirmed: true });
    const hanging = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const pending = E.lookup(state, api, Object.assign({ fetch: hanging }, timing));
    await new Promise((r) => setTimeout(r, 5));
    E.cancel();
    const cancelled = await pending;
    assert.equal(cancelled.cards[0].status, "cancelled");
    assert.equal(cancelled.cards.length, 1, "a cancelled lookup stops before the second service");
    assert.equal(state.evidence.running, false);

    const pending2 = E.lookup(state, api, Object.assign({ fetch: fakeFetch([{ status: 200, body: ebiHit.json }, { status: 200, body: { hitCount: 0, resultList: { result: [] } } }], []) }, timing));
    const before = state.evidence;
    state.evidence = null; // Start over / new file
    const dropped = await pending2;
    assert.equal(dropped.dropped, true, "late answers for a cleared session are dropped");
    assert.equal(before.cards.length, 1, "nothing is added to the old session");
  }

  // Rendering escapes everything that came from a service or the user.
  {
    const state = stateFor();
    const evidence = E.ensure(state);
    Object.assign(evidence, { enabled: true, confirmed: true });
    await E.lookup(state, api, Object.assign({ fetch: fakeFetch([
      { status: 200, body: { hitCount: 1, entries: [{ id: "URS00000AF93C_9606", fields: { description: ['<img src=x onerror=alert(1)>'] } }] } },
      { status: 200, body: { hitCount: 1, resultList: { result: [{ id: "1", source: "MED", title: "<script>alert(1)</script>", authorString: "\"><b>x" }] } } }
    ], []) }, timing));
    evidence.cards[0].review.note = "<svg onload=alert(1)>";
    const html = E.renderPanel(state);
    assert.doesNotMatch(html, /<script>|<img src=x|<svg onload|"><b>/, "service and note text are escaped");
    assert.match(html, /background only, not a validation of this structure/);
    assert.match(html, /citations not verified/);
    assert.match(html, /Sends <code>ENST00000362134<\/code> and taxon <code>9606<\/code>/);
    const off = E.renderPanel({ structure: state.structure, records: [] });
    assert.match(off, /Off by default/);
    assert.match(off, /data-feature-action="evidence-enable"/);
  }

  // The only network code in the web build is this module.
  fs.readdirSync(web).filter((name) => name.endsWith(".js") && name !== "evidence.js").forEach((name) => {
    const text = fs.readFileSync(path.join(web, name), "utf8");
    assert.doesNotMatch(text, /fetch\(\s*["'`]https?:|XMLHttpRequest|navigator\.sendBeacon|new WebSocket|EventSource\(/,
      name + " must not contact outside services; public lookups live in evidence.js");
  });
  const index = fs.readFileSync(path.join(web, "index.html"), "utf8");
  assert.ok(index.indexOf("./evidence.js") > index.indexOf("./structure-ui.js") && index.indexOf("./evidence.js") < index.indexOf("./analysis-ui.js"),
    "evidence.js loads before analysis-ui.js routes to it");
  const app = fs.readFileSync(path.join(web, "app.js"), "utf8");
  assert.equal((app.match(/state\.structure = null;\n\s*state\.evidence = null;/g) || []).length, 3, "every session reset clears evidence with the structure");

  process.stdout.write("evidence-contract: ok\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

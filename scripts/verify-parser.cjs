"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repository = path.resolve(__dirname, "..");
const parserSource = fs.readFileSync(path.join(repository, "web", "parser.worker.js"), "utf8");
const context = vm.createContext({
  Number,
  String,
  Boolean,
  Object,
  Array,
  Math,
  RegExp,
  Intl,
  TextDecoder,
  self: { postMessage: function () {} }
});

vm.runInContext(parserSource, context, { filename: "parser.worker.js" });

function line(options) {
  const value = Object.assign({
    id: "read_1",
    sequence: "ACGUACGU",
    dg: "-4.2",
    rnaOne: "RNA_A",
    oneStart: 1,
    oneEnd: 2,
    rnaTwo: "RNA_A",
    twoStart: 5,
    twoEnd: 6,
    overlap: "0",
    type: "Type_1"
  }, options || {});

  return [
    value.id,
    value.sequence,
    value.dg,
    value.rnaOne,
    "1",
    "4",
    String(value.oneStart),
    String(value.oneEnd),
    "1e-4",
    value.rnaTwo,
    "5",
    "8",
    String(value.twoStart),
    String(value.twoEnd),
    "2e-4",
    value.overlap,
    value.type
  ].join("\t");
}

function parse(text, lineNumber) {
  return context.parseRecord(text, lineNumber || 1);
}

// Canonical 17-column HYB semantics: overlap and type must not become support.
const canonical = parse(line({ id: "read_12_lane7", overlap: "7", type: "Type_9" }));
assert.equal(canonical.ok, true);
assert.equal(canonical.record.inputLayout, "rnaxray_17_column");
assert.equal(canonical.record.supportCount, 1);
assert.equal(canonical.record.overlapScore, 7);
assert.equal(canonical.record.chimeraType, "Type_9");
assert.equal(canonical.record.rawReadCount, 12);
assert.equal(canonical.record.isHomodimer, true);
// Real sam2hyb output: an empty column 16, then overlap and chimera type (18 fields).
const sam2hybColumns = line({ overlap: "-3", type: "Type_2" }).split("\t");
sam2hybColumns.splice(15, 0, "");
const sam2hyb = parse(sam2hybColumns.join("\t"));
assert.equal(sam2hyb.ok, true);
assert.equal(sam2hyb.record.inputLayout, "rnaxray_sam2hyb_18_column");
assert.equal(sam2hyb.record.overlapScore, -3);
assert.equal(sam2hyb.record.chimeraType, "Type_2");
assert.equal(sam2hyb.record.supportCount, 1);
const sam2hybInter = line({ rnaTwo: "RNA_B", overlap: ".", type: "Intermolecular" }).split("\t");
sam2hybInter.splice(15, 0, "");
assert.equal(parse(sam2hybInter.join("\t")).record.chimeraType, "Intermolecular");
assert.equal(parse(sam2hybInter.join("\t")).record.overlapScore, null);
const canonicalCountLikeOverlap = parse(line({ overlap: "count_total=7", type: "Type_1" }));
assert.equal(canonicalCountLikeOverlap.ok, true);
assert.equal(canonicalCountLikeOverlap.record.supportCount, 1,
  "a standard 17-column row must never reinterpret column 16 as legacy cluster support");
assert.equal(canonicalCountLikeOverlap.record.supportSource, "row");
assert.equal(canonicalCountLikeOverlap.record.overlapScore, null);
const canonicalWithTrailingMetadata = parse(line({ overlap: "3", type: "Type_1" }) + "\tcount_total=99");
assert.equal(canonicalWithTrailingMetadata.record.supportCount, 1,
  "trailing legacy metadata must not alter standard-row weighting");

// Legacy 16-column count annotations keep their established support semantics.
const legacyColumns = line({ id: "legacy_4", overlap: "9", type: "Type_1" }).split("\t");
legacyColumns.length = 16;
const legacy = parse(legacyColumns.join("\t"));
assert.equal(legacy.ok, true);
assert.equal(legacy.record.inputLayout, "legacy_clustered");
assert.equal(legacy.record.supportCount, 9);
assert.equal(legacy.record.overlapScore, null);
assert.equal(legacy.record.rawReadCount, 4);
assert.equal(legacy.record.isHomodimer, false);

const metadataColumns = line({ overlap: "count_total=7", type: "Type_1" }).split("\t");
metadataColumns.length = 16;
const metadataSupport = parse(metadataColumns.join("\t"));
assert.equal(metadataSupport.ok, true);
assert.equal(metadataSupport.record.supportCount, 7);
assert.equal(metadataSupport.record.supportSource, "count_metadata");
["count_total=2.5", "count_total=0", "count_total=" + "9".repeat(400)].forEach(function (metadata) {
  const columns = line({ overlap: metadata, type: "Type_1" }).split("\t");
  columns.length = 16;
  const invalidMetadata = parse(columns.join("\t"));
  assert.equal(invalidMetadata.ok, false, metadata + " must not enter cluster-support totals");
  assert.match(invalidMetadata.error.error, /positive safe integer/);
});
const unsupportedCountAlias = line({ overlap: "count=9", type: "Type_1" }).split("\t");
unsupportedCountAlias.length = 16;
const unsupportedCountRecord = parse(unsupportedCountAlias.join("\t"));
assert.equal(unsupportedCountRecord.ok, true);
assert.equal(unsupportedCountRecord.record.supportCount, 1,
  "count= must not be interpreted as bundled RNAxRay count_total metadata");

// A non-positive numeric column 16 cannot be a valid legacy count, so a
// truncated 16-column row retains it as a partial-RNAxRay overlap score.
["0", "-4", "-2.5"].forEach(function (overlap) {
  const columns = line({ overlap: overlap }).split("\t");
  columns.length = 16;
  const partial = parse(columns.join("\t"));
  assert.equal(partial.ok, true);
  assert.equal(partial.record.inputLayout, "partial_rnaxray");
  assert.equal(partial.record.overlapScore, Number(overlap));
  assert.equal(partial.record.supportCount, 1);
});
const overflowColumns = line({ overlap: "9".repeat(400) }).split("\t");
overflowColumns.length = 16;
const overflowLegacyCount = parse(overflowColumns.join("\t"));
assert.equal(overflowLegacyCount.ok, false, "an overflowing legacy count must not enter support totals");
assert.match(overflowLegacyCount.error.error, /safe positive-integer range/);

// Blank and dot dG values are missing, not zero-valued measurements.
["", ".", "   "].forEach(function (dg) {
  const parsed = parse(line({ dg: dg }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.dg, null);
  assert.equal(parsed.record.hasDg, false);
});
assert.equal(parse(line({ dg: "0" })).record.hasDg, true);

// HYB RNA coordinates are one-based and must never accept zero.
assert.equal(parse(line({ oneStart: 0 })).ok, false);
assert.equal(parse(line({ oneEnd: 0 })).ok, false);
assert.equal(parse(line({ twoStart: 0 })).ok, false);
assert.equal(parse(line({ twoEnd: 0 })).ok, false);

// Match all 13 ordered branches in bin/hyb_chim_types.awk.
const typeCases = [
  ["Type_1", 1, 2, 5, 6],
  ["Type_2", 7, 8, 3, 4],
  ["Type_3", 1, 4, 3, 6],
  ["Type_4", 1, 6, 3, 6],
  ["Type_5", 1, 7, 3, 6],
  ["Type_6", 3, 7, 3, 6],
  ["Type_7", 4, 7, 3, 6],
  ["Type_8", 3, 6, 3, 6],
  ["Type_9", 4, 6, 3, 6],
  ["Type_10", 3, 5, 3, 6],
  ["Type_11", 4, 5, 3, 6],
  ["Type_12", 1, 3, 3, 6],
  ["Type_13", 6, 7, 3, 6]
];

typeCases.forEach(function (entry) {
  assert.equal(
    context.inferChimeraType("RNA_A", entry[1], entry[2], "RNA_A", entry[3], entry[4]),
    entry[0]
  );
});
assert.equal(context.inferChimeraType("RNA_A", 1, 2, "RNA_B", 5, 6), "Intermolecular");

// Raw-read provenance is independent of row/support weighting and homodimers.
const summary = context.createSummary({ name: "fixture.hyb", size: 100 });
[
  parse(line({ id: "alpha_12", overlap: "5", type: "Type_1" })).record,
  parse(line({ id: "beta_3", overlap: "4.9", type: "Type_1" })).record,
  parse(line({ id: "not_canonical", rnaTwo: "RNA_B", overlap: "8", type: "Intermolecular" })).record
].forEach(function (record) {
  context.addRecord(summary, record);
});

assert.equal(summary.validRecords, 3);
assert.equal(summary.supportInteractions, 3);
assert.equal(summary.rawReadInteractions, 15);
assert.equal(summary.rawReadCountRecords, 2);
assert.equal(summary.homodimerRecords, 1);
assert.equal(summary.homodimerRawReads, 12);
context.finalizeSummary(summary);
const pair = summary.pairCounts.find(function (item) { return item.rnaOne === "RNA_A" && item.rnaTwo === "RNA_A"; });
assert.equal(pair.rawReads, 15);
assert.equal(pair.rawReadCountRecords, 2);
const rnaA = summary.rnaCounts.find(function (item) { return item.name === "RNA_A"; });
assert.equal(rnaA.rawReads, 30, "same-RNA records contribute one arm count for each arm");
assert.equal(rnaA.rawReadCountRecords, 4);

// Invalid-row totals remain complete while detail storage is explicitly
// bounded and labelled as a sample for browser memory safety.
const invalidSummary = context.createSummary({ name: "invalid-fixture.hyb", size: 1 });
for (let index = 1; index <= 250; index += 1) {
  invalidSummary.invalidRecords += 1;
  context.addError(invalidSummary, { line: index, error: "fixture", content: "bad" });
}
context.finalizeSummary(invalidSummary);
assert.equal(invalidSummary.errors.length, 100);
assert.equal(invalidSummary.errorSampleCount, 100);
assert.equal(invalidSummary.omittedErrorCount, 150);
assert.equal(invalidSummary.errorSampleTruncated, true);

// gzip input: recognised by its magic bytes and decompressed in the worker;
// progress counts compressed bytes
async function parseFile(file, globals) {
  const workerContext = vm.createContext(Object.assign({ TextDecoder, self: { postMessage: function () {} } }, globals || {}));
  vm.runInContext(parserSource, workerContext, { filename: "parser.worker.js" });
  const progress = [];
  return new Promise(function (resolve, reject) {
    workerContext.self.postMessage = function (message) {
      if (message.type === "progress") progress.push(message);
      if (message.type === "complete") resolve({ message: message, progress: progress });
      if (message.type === "error") reject(new Error(message.message));
    };
    workerContext.self.onmessage({ data: { file: file } });
  });
}

(async function () {
  const text = [line({ id: "1_3" }), line({ id: "2_5", rnaTwo: "RNA_B" }), "# comment", line({ id: "3_1" })].join("\n") + "\n";
  const gzip = require("node:zlib").gzipSync(Buffer.from(text));
  const streams = { TransformStream: TransformStream, DecompressionStream: DecompressionStream };
  const plain = await parseFile(new File([text], "fixture.hyb"), streams);
  const packed = await parseFile(new File([gzip], "fixture.hyb.gz"), streams);
  assert.equal(packed.message.summary.validRecords, 3);
  assert.equal(packed.message.summary.skippedCommentLines, 1);
  assert.equal(JSON.stringify(packed.message.records.map(function (r) { return r.id; })), JSON.stringify(plain.message.records.map(function (r) { return r.id; })));
  assert.ok(packed.progress.every(function (m) { return m.processedBytes <= gzip.length; }), "gzip progress counts compressed bytes");
  // a .gz name that is already plain text (a server that decoded it) parses as text
  const decoded = await parseFile(new File([text], "fixture.hyb.gz"), streams);
  assert.equal(decoded.message.summary.validRecords, 3);
  // without DecompressionStream a gzip file gets a clear error
  await assert.rejects(parseFile(new File([gzip], "fixture.hyb.gz")), /cannot decompress gzip files/);
  process.stdout.write("parser-contract: ok\n");
})().catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.exit(1);
});

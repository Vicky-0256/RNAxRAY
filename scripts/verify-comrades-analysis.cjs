"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const comrades = require(path.resolve(__dirname, "..", "web", "comrades-analysis.js"));

const fasta = {
  mapping: { RNA_A: "ref-a", RNA_B: "ref-b" },
  sequences: [
    { id: "ref-a", sequence: "AACCGGUUAACCGGUUAACCGGUU" },
    { id: "ref-b", sequence: "GGGGAAAACCCCUUUUGGGGAAAA" }
  ]
};
const records = [
  {
    id: "forward", index: 0, rnaOne: "RNA_A", rnaOneStart: 2, rnaOneEnd: 5,
    rnaTwo: "RNA_A", rnaTwoStart: 10, rnaTwoEnd: 13, isHomodimer: false
  },
  {
    id: "antisense", index: 1, rnaOne: "RNA_A", rnaOneStart: 5, rnaOneEnd: 2,
    rnaTwo: "RNA_A", rnaTwoStart: 10, rnaTwoEnd: 13, isHomodimer: false
  },
  {
    id: "paired-reverse", index: 2, rnaOne: "RNA_B", rnaOneStart: 4, rnaOneEnd: 7,
    rnaTwo: "RNA_A", rnaTwoStart: 3, rnaTwoEnd: 6, isHomodimer: false
  }
];

const single = comrades.prepareReferenceAssembly(records, fasta, {
  regions: [{ rna: "RNA_A", start: 1, end: 16 }]
});
assert.equal(single.sequence, "AACCGGUUAACCGGUU");
assert.equal(single.eligibleRecordCount, 1);
assert.equal(single.skipped.antisense, 1);
assert.equal(single.skipped.outsideSelectedRegions, 1);
assert.equal(single.evidenceArms[0].sequenceOne, "ACCG");
assert.equal(single.evidenceArms[0].oneStart, 2);
assert.equal(single.evidenceArms[0].twoStart, 10);

const paired = comrades.prepareReferenceAssembly(records, fasta, {
  regions: [
    { rna: "RNA_A", start: 1, end: 10 },
    { rna: "RNA_B", start: 1, end: 10 }
  ]
});
assert.equal(paired.sequence.length, 120);
assert.equal(paired.linker.length, 100);
assert.equal(paired.linker.sequence, "A".repeat(50) + "U".repeat(50));
assert.equal(paired.eligibleRecordCount, 1);
assert.equal(paired.evidenceArms[0].reversedFromHyb, true);
assert.equal(paired.evidenceArms[0].oneStart, 3);
assert.equal(paired.evidenceArms[0].twoStart, 114);

const cofoldMapped = comrades.mapCofoldPairs({
  sequenceOne: "GGGG", sequenceTwo: "CCCC", oneStart: 5, twoStart: 20, recordId: "x"
}, [
  { left: 1, right: 8 }, { left: 2, right: 7 },
  { left: 1, right: 4 }, { left: 5, right: 8 }
]);
assert.deepEqual(cofoldMapped, [
  { one: 5, two: 23, recordId: "x" },
  { one: 6, two: 22, recordId: "x" }
]);

const evidence = comrades.aggregateEvidence([
  { one: 5, two: 23, recordId: "a" },
  { one: 6, two: 22, recordId: "a" },
  { one: 5, two: 23, recordId: "b" },
  { one: 8, two: 18, recordId: "c" }
]);
assert.deepEqual(evidence.map(function (entry) { return [entry.one, entry.two, entry.count]; }), [
  [5, 23, 2], [6, 22, 1], [8, 18, 1]
]);

const stems = comrades.mergeTouchingStems(evidence);
assert.equal(stems.length, 2);
assert.deepEqual(
  { oneStart: stems[0].oneStart, oneEnd: stems[0].oneEnd, twoStart: stems[0].twoStart, twoEnd: stems[0].twoEnd, support: stems[0].support, length: stems[0].length },
  { oneStart: 5, oneEnd: 6, twoStart: 22, twoEnd: 23, support: 3, length: 2 }
);
const constraints = comrades.stemsToConstraints(stems, 75);
assert.deepEqual(constraints[0].pairs, [{ left: 5, right: 23 }, { left: 6, right: 22 }]);
assert.equal(constraints[0].support, 3);

const compatible = comrades.validateConstraintSet(constraints.slice(0, 1), "AAAAGGAAAAAAAAACCAAAACCC", 3);
assert.equal(compatible.valid, true);
const crossing = comrades.validateConstraintSet([
  { left: 1, right: 10, length: 1 },
  { left: 5, right: 15, length: 1 }
], "GAAAGAAAACAAAAC", 3);
assert.equal(crossing.valid, false);
assert.equal(crossing.reason, "crossing-pairs");

assert.deepEqual(comrades.seededShuffle([1, 2, 3, 4, 5], "seed"), comrades.seededShuffle([1, 2, 3, 4, 5], "seed"));
assert.notDeepEqual(comrades.seededShuffle([1, 2, 3, 4, 5], "seed"), comrades.seededShuffle([1, 2, 3, 4, 5], "other"));

const scored = comrades.scoreStructurePairs([
  { left: 5, right: 23 }, { left: 8, right: 18 }, { left: 2, right: 4 }
], evidence, 25);
assert.equal(scored.matchedPairs, 2);
assert.equal(scored.matchedPairSupport, 3);
assert.equal(scored.comradesScore, 6, "the original VARNA-score sum assigns each supported pair score to both nucleotides");
assert.equal(scored.nucleotideSupport[4], 2);
assert.equal(scored.nucleotideSupport[22], 2);

const many = Array.from({ length: 1005 }, function (_, index) {
  return { one: index + 1, two: 3000 - index, count: 1005 - index };
});
assert.equal(comrades.selectFragmentEvidence(many, 1, 3000).length, 1001,
  "the legacy awk printed<=1000 condition emits 1001 rows and is preserved intentionally");

process.stdout.write("comrades-analysis-contract: ok\n");

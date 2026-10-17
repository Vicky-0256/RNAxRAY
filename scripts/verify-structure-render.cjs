"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repository = path.resolve(__dirname, "..");
const workerInstances = [];

function FakeWorker(url, options) {
  this.url = url;
  this.options = options || null;
  this.message = null;
  this.terminated = false;
  workerInstances.push(this);
}

FakeWorker.prototype.postMessage = function (message) {
  this.message = message;
};

FakeWorker.prototype.terminate = function () {
  this.terminated = true;
};

const context = vm.createContext({
  Intl,
  Number,
  String,
  Boolean,
  Object,
  Array,
  Math,
  RegExp,
  Set,
  Map,
  Worker: FakeWorker,
  window: {
    RNAxRayData: {
      normaliseFoldSequence: function (sequence) {
        return { sequence: String(sequence || "").toUpperCase(), invalid: [] };
      }
    }
  }
});

vm.runInContext(
  fs.readFileSync(path.join(repository, "web", "comrades-analysis.js"), "utf8"),
  context,
  { filename: "comrades-analysis.js" }
);

vm.runInContext(
  fs.readFileSync(path.join(repository, "web", "analysis-pages.js"), "utf8"),
  context,
  { filename: "analysis-pages.js" }
);

vm.runInContext(
  fs.readFileSync(path.join(repository, "web", "structure-controller.js"), "utf8"),
  context,
  { filename: "structure-controller.js" }
);

vm.runInContext(
  fs.readFileSync(path.join(repository, "web", "structure-ui.js"), "utf8"),
  context,
  { filename: "structure-ui.js" }
);

const state = {
  summary: { rnaNames: [] },
  records: [],
  structure: {
    source: "paste",
    pastedSequence: "GGGAAACCCC",
    selectedRecordIndex: null,
    minimumLoop: "3",
    temperature: "37",
    constraintMode: "none",
    constraintText: "",
    allowLarge: false,
    selectedNucleotide: null,
    status: "idle",
    progress: 0,
    message: "",
    result: null
  }
};

const setupHtml = context.window.RNAxRayPages.renderStructure(state);
assert.match(setupHtml, /ViennaRNA MFE · Browser/);
assert.match(setupHtml, /Temperature/);
assert.match(setupHtml, /Predict MFE structure/);
assert.match(setupHtml, /Plain MFE/);
assert.match(setupHtml, /Manual hard base pairs \(expert\)/);
assert.doesNotMatch(setupHtml, /id="structure-constraint-text"/);
assert.doesNotMatch(setupHtml, /Nussinov|Pairing score/);

const largeRnaState = {
  summary: { rnaNames: Array.from({ length: 2000 }, function (_, index) { return "RNA_" + index; }) },
  records: [],
  fasta: null,
  structure: Object.assign({}, state.structure, { source: "reference", rna: "RNA_1999" })
};
const largeRnaHtml = context.window.RNAxRayPages.renderStructure(largeRnaState);
assert.match(largeRnaHtml, /type="search" list="options-structure-control-rna" value="RNA_1999"/,
  "large RNA collections should use a searchable exact-value control and retain a selected value beyond the suggestion cap");
assert.ok((largeRnaHtml.match(/<option/g) || []).length < 800,
  "a large RNA selector must cap rendered suggestions rather than materialise every RNA in the DOM");

const fileDialogRnas = Array.from({ length: 2000 }, function (_, index) { return "RNA_" + index; });
const largeFilesHtml = context.window.RNAxRayPages.getFilesDialogBody({
  summary: { fileName: "large.hyb", fileSize: 1, validRecords: 1, rnaNames: fileDialogRnas, sha256Unavailable: true },
  fasta: {
    fileName: "large.fa", fileSize: 1, sha256Unavailable: true, mapping: {},
    sequences: fileDialogRnas.map(function (rna) { return { id: rna, header: rna, sequence: "ACGU" }; })
  }
});
assert.equal((largeFilesHtml.match(/<option/g) || []).length, 1000,
  "the FASTA mapping editor must cap both RNA and reference suggestions at 500");
assert.equal((largeFilesHtml.match(/class="mapping-row"/g) || []).length, 100,
  "the FASTA mapping preview must remain bounded for large files");

state.records = Array.from({ length: 501 }, function (_, index) {
  return { index: index, id: "record_" + index, sequence: "GCGCUUCGCC", rnaOne: "RNA_A", rnaTwo: "RNA_B" };
});
state.structure.source = "record";
state.structure.selectedRecordIndex = 500;
providerView(state);
state.view.structureSelectedRecord = { index: 500, record: state.records[500] };
const distantRecordHtml = context.window.RNAxRayPages.renderStructure(state);
assert.match(distantRecordHtml, /value="500" selected>record_500/,
  "a record opened from beyond the first 500 rows must remain visible in the selector");
assert.match(distantRecordHtml, /Hybrid-read sequence/);
assert.match(distantRecordHtml, /not necessarily a complete reference RNA/);
state.records = [];
state.view = null;
state.structure.source = "paste";
state.structure.selectedRecordIndex = null;

state.structure.constraintMode = "manual-hard-base-pairs";
state.structure.constraintText = "3-8";
const manualSetupHtml = context.window.RNAxRayPages.renderStructure(state);
assert.match(manualSetupHtml, /Manual hard-pair mode/);
assert.match(manualSetupHtml, /id="structure-constraint-text"/);
assert.match(manualSetupHtml, />3-8<\/textarea>/);
assert.match(manualSetupHtml, /does not infer these pairs from HYB or RNAcofold evidence/);
assert.match(manualSetupHtml, /Predict constrained MFE/);

state.structure.selectedNucleotide = 1;
state.structure.result = {
  algorithm: "ViennaRNA constrained global MFE",
  sequence: "GGGAAACCCC",
  dotBracket: "(((....)))",
  energy: -2.5,
  energyUnit: "kcal/mol",
  elapsedMs: 12,
  unpaired: 4,
  constraintMode: "hard-base-pairs",
  constraintCount: 1,
  constraints: [{ left: 3, right: 8 }],
  pairs: [
    { left: 1, right: 10, leftBase: "G", rightBase: "C", type: "G–C" },
    { left: 2, right: 9, leftBase: "G", rightBase: "C", type: "G–C" },
    { left: 3, right: 8, leftBase: "G", rightBase: "C", type: "G–C" }
  ],
  label: "Pasted sequence"
};

const resultHtml = context.window.RNAxRayPages.renderStructure(state);
assert.match(resultHtml, /-2\.50/);
assert.match(resultHtml, /Folded RNA structure/);
assert.match(resultHtml, /data-view-mode="folded"/);
assert.match(resultHtml, /data-view-mode="folded" aria-pressed="true"/);
assert.match(resultHtml, /Download DBN/);
assert.match(resultHtml, /Download CT/);
assert.match(resultHtml, /data-feature-action="download-structure-png">Download PNG/);
assert.match(resultHtml, /Nucleotide 1/);
assert.match(resultHtml, /Paired with 10 C · G–C/);
assert.match(resultHtml, /Constraint mode/);
assert.match(resultHtml, /Manual hard/);
assert.match(resultHtml, /1 enforced pair/);
assert.match(resultHtml, /Manual hard-pair result/);
assert.match(resultHtml, /class="hard-constraint-pair"/);
assert.match(resultHtml, /Hard pair/);
assert.match(resultHtml, /not generated from HYB interaction evidence/);
assert.doesNotMatch(resultHtml, /undefined/);
state.structure.viewMode = "matrix";
const matrixResultHtml = context.window.RNAxRayPages.renderStructure(state);
assert.match(matrixResultHtml, /Base-pair matrix/);
assert.match(matrixResultHtml, /data-view-mode="matrix"/);
assert.match(matrixResultHtml, /data-view-mode="folded" aria-pressed="false"/);
assert.match(matrixResultHtml, /data-view-mode="radial" aria-pressed="false"/);
let viewRenderCount = 0;
assert.equal(context.window.RNAxRayStructureUI.handleAction("set-structure-view", state, {
  render: function () { viewRenderCount += 1; }
}, { dataset: { viewMode: "radial" } }), true);
assert.equal(state.structure.viewMode, "radial");
assert.equal(viewRenderCount, 1);
const longResultHtml = context.window.RNAxRayPages.renderStructureResult
  ? context.window.RNAxRayPages.renderStructureResult(Object.assign({}, state.structure.result, { sequence: "A".repeat(701) }), null)
  : "";
if (longResultHtml) {
  assert.match(longResultHtml, /sequence baseline/);
  assert.doesNotMatch(longResultHtml, /Click a nucleotide marker/);
}

const report = context.window.RNAxRayStructureUI.structureReport(state, state.structure.result);
assert.equal(report.visualization.viewMode, "radial");
assert.equal(report.prediction.constraintMode, "hard-base-pairs");
assert.equal(report.prediction.constraintSource, "manual-user-input");
assert.equal(report.prediction.constraintCount, 1);
assert.equal(report.methodScope.manualHardBasePairsApplied, true);
assert.equal(report.methodScope.automaticHybEvidenceConstraintGeneration, false);
assert.equal(report.methodScope.automaticRnaCofoldEvidenceSelection, false);
assert.match(report.methodScope.note, /entered manually/);
const referenceReport = context.window.RNAxRayStructureUI.structureReport({
  summary: { fileName: "primary.hyb", fileSize: 111, sha256: "hyb-sha" },
  reference: { fileName: "reference.fa", fileSize: 222, sha256: "fasta-sha" }
}, Object.assign({}, state.structure.result, {
  source: "reference",
  sourceRna: "RNA_A",
  sourceStart: 5,
  sourceEnd: 14
}));
assert.equal(referenceReport.sourceHyb.fileSize, 111);
assert.equal(referenceReport.sourceFasta.sha256, "fasta-sha");
assert.equal(referenceReport.sourceFasta.fileSize, 222);
assert.deepEqual(
  JSON.parse(JSON.stringify({ rna: referenceReport.source.rna, start: referenceReport.source.start, end: referenceReport.source.end })),
  { rna: "RNA_A", start: 5, end: 14 }
);
const pairsTsv = context.window.RNAxRayStructureUI.basePairTsv(state.structure.result);
assert.match(pairsTsv, /hard_constraint/);
assert.match(pairsTsv, /3\tG\t8\tC\tG–C\tyes/);

const guidedState = structureState("hyb-guided", "");
guidedState.summary = { rnaNames: ["RNA_A"], fileName: "guided.hyb", fileSize: 42, sha256: "guided-sha" };
guidedState.records = [
  {
    id: "read-1", index: 0, rnaOne: "RNA_A", rnaOneStart: 1, rnaOneEnd: 6,
    rnaTwo: "RNA_A", rnaTwoStart: 11, rnaTwoEnd: 16, isHomodimer: false
  }
];
guidedState.fasta = {
  fileName: "guided.fa", fileSize: 17, sha256: "fasta-sha",
  mapping: { RNA_A: "RNA_A" },
  sequences: [{ id: "RNA_A", sequence: "GGGGGGAAAACCCCCC" }]
};
Object.assign(guidedState.structure, {
  source: "reference",
  rna: "RNA_A",
  start: "1",
  end: "16",
  evidenceLayout: "single",
  secondRna: "RNA_A",
  secondStart: "1",
  secondEnd: "16",
  homodimerOnly: false,
  constraintLimit: "75",
  randomFoldCount: "10",
  randomSeed: "guided-contract",
  allowLargeEnsemble: false
});
providerView(guidedState);
const guidedSequence = context.window.RNAxRayPages.getStructureSequence(guidedState);
assert.equal(guidedSequence.sequence, "GGGGGGAAAACCCCCC");
assert.equal(guidedSequence.assembly.evidenceArms.length, 1);
const guidedSetupHtml = context.window.RNAxRayPages.renderStructure(guidedState);
assert.match(guidedSetupHtml, /COMRADES\(ViennaRNA\)/);
assert.match(guidedSetupHtml, /RNAcofold \+ constrained RNAfold · Browser/);
assert.match(guidedSetupHtml, /1 eligible HYB row/);
assert.match(guidedSetupHtml, /Run HYB-guided ensemble/);
assert.match(guidedSetupHtml, /1,000 · original cluster scale/);
assert.match(guidedSetupHtml, /Randomisation seed/);

const guidedWorkersBefore = workerInstances.length;
assert.equal(context.window.RNAxRayStructure.predict(guidedState, {
  render: function () {},
  showToast: function () {}
}), true);
assert.equal(workerInstances.length, guidedWorkersBefore + 1);
assert.equal(workerInstances.at(-1).message.type, "comrades-fold");
assert.equal(workerInstances.at(-1).message.evidenceArms.length, 1);
assert.equal(workerInstances.at(-1).message.randomFoldCount, 10);
assert.equal(workerInstances.at(-1).message.seed, "guided-contract");
context.window.RNAxRayStructure.cancel(guidedState);

guidedState.structure.status = "complete";
guidedState.structure.result = {
  algorithm: "COMRADES(ViennaRNA)",
  model: "RNAcofold evidence",
  engine: "ViennaRNA",
  engineVersion: "2.7.2",
  sequence: "GGGGGGAAAACCCCCC",
  dotBracket: "((((((....))))))",
  energy: -8.2,
  energyUnit: "kcal/mol",
  elapsedMs: 44,
  unpaired: 4,
  temperature: 37,
  minimumLoop: 3,
  constraintMode: "hyb-guided",
  constraintSource: "hyb-rna-cofold-evidence",
  constraintCount: 1,
  constraints: [{ left: 1, right: 16 }],
  acceptedStemConstraints: [{ id: "F1", rank: 1, left: 1, right: 16, length: 1, support: 2 }],
  rejectedStemConstraints: [{ id: "F2", rank: 2, reason: "crossing-pairs" }],
  comradesScore: 4,
  matchedEvidencePairs: 1,
  maximumNucleotideSupport: 2,
  nucleotideSupport: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
  pairs: [{ left: 1, right: 16, leftBase: "G", rightBase: "C", type: "G–C", evidenceSupport: 2 }],
  evidence: {
    inputRecords: 1,
    uniqueBasePairs: 1,
    selectedBasePairs: [{ one: 1, two: 16, count: 2, recordIds: ["read-1"] }],
    rankedStems: [{ rank: 1 }],
    requestedStemConstraints: 1
  },
  randomisation: {
    completedFolds: 1,
    seed: "guided-contract",
    selectedRun: 1,
    structures: [{ run: 0, randomised: false, energy: -7, comradesScore: 0, matchedEvidencePairs: 0, acceptedStemConstraints: [], rejectedStemConstraints: 1, dotBracket: "................" }, { run: 1, randomised: true, energy: -8.2, comradesScore: 4, matchedEvidencePairs: 1, acceptedStemConstraints: ["F1"], rejectedStemConstraints: 1, dotBracket: "((((((....))))))" }]
  },
  label: "RNA_A:1-16",
  source: "reference",
  sourceRna: "RNA_A",
  sourceStart: 1,
  sourceEnd: 16,
  sourceSegments: guidedSequence.assembly.segments,
  assembly: { segments: guidedSequence.assembly.segments, linker: null, eligibleRecordCount: 1 }
};
const guidedResultHtml = context.window.RNAxRayPages.renderStructure(guidedState);
assert.match(guidedResultHtml, /HYB-evidence-selected structure/);
assert.match(guidedResultHtml, /COMRADES score/);
assert.match(guidedResultHtml, /RNAcofold evidence/);
assert.match(guidedResultHtml, /Accepted stem constraints/);
assert.match(guidedResultHtml, /Download evidence/);
assert.match(guidedResultHtml, /Download ensemble/);
assert.match(guidedResultHtml, /evidence 2/);
const guidedReport = context.window.RNAxRayStructureUI.structureReport(guidedState, guidedState.structure.result);
assert.equal(guidedReport.prediction.constraintSource, "hyb-rna-cofold-evidence");
assert.equal(guidedReport.methodScope.automaticHybEvidenceConstraintGeneration, true);
assert.equal(guidedReport.methodScope.automaticRnaCofoldEvidenceSelection, true);
assert.equal(guidedReport.methodScope.iterativeCompatibleConstraintFitting, true);
assert.equal(guidedReport.methodScope.supportBasedStructureScoring, true);
assert.equal(guidedReport.methodScope.unafoldExecution, "external-cli-only");
assert.match(context.window.RNAxRayStructureUI.evidenceTsv(guidedState.structure.result), /1\t16\t2\tread-1/);
assert.match(context.window.RNAxRayStructureUI.constraintsTsv(guidedState.structure.result), /F 1 16 1/);
assert.match(context.window.RNAxRayStructureUI.ensembleTsv(guidedState.structure.result), /1\tyes\tyes\t-8\.2\t4/);

const cplfoldState = structureState("none", "");
cplfoldState.summary = { rnaNames: ["RNA_A"], fileName: "cplfold.hyb", fileSize: 84, sha256: "cplfold-sha" };
cplfoldState.records = [
  {
    id: "block-1", index: 0, rnaOne: "RNA_A", rnaOneStart: 103, rnaOneEnd: 108,
    rnaTwo: "RNA_A", rnaTwoStart: 120, rnaTwoEnd: 125, isHomodimer: false
  }
];
cplfoldState.fasta = {
  fileName: "cplfold.fa", fileSize: 40, sha256: "cplfold-fasta-sha",
  mapping: { RNA_A: "RNA_A" },
  sequences: [{ id: "RNA_A", sequence: "A".repeat(100) + "GGCGCGGCACCGUCCGCGGAACAAACGG" }]
};
Object.assign(cplfoldState.structure, {
  engine: "cplfold",
  source: "reference",
  rna: "RNA_A",
  start: "101",
  end: "128",
  cplfoldEvidence: "hyb-blocks",
  cplfoldBeam: "20",
  cplfoldMaxPhase1: "2",
  cplfoldEnergyDelta: "5",
  cplfoldEnergyModel: "DP09",
  cplfoldAlpha: "0.5",
  cplfoldBeta: "0",
  cplfoldAllowPseudoknot: true
});
providerView(cplfoldState);
const cplfoldSetup = context.window.RNAxRayPages.renderStructure(cplfoldState);
assert.match(cplfoldSetup, /CPLfold \+ Pyodide · Browser/);
assert.match(cplfoldSetup, /HYB block bonus matrix/);
assert.match(cplfoldSetup, /Allow pseudoknots/);
assert.match(cplfoldSetup, /Secondary structure only/);
assert.match(cplfoldSetup, /value="true"[^>]*data-key="cplfoldAllowPseudoknot"[^>]* checked/);
assert.match(cplfoldSetup, /1 eligible HYB row/);
assert.match(cplfoldSetup, /Predict CPLfold candidates/);
assert.match(cplfoldSetup, /Baseline 75 nt/);
assert.match(cplfoldSetup, /data-feature-action="probe-cplfold-capacity"/);
assert.match(cplfoldSetup, /data-feature-action="download-local-cplfold-input"[^>]*>Download local inputs/);
assert.match(cplfoldSetup, /title="Download prepared FASTA and HYB bonus matrix for local bin\/cplfold"/);
assert.match(cplfoldSetup, /Run longer sequences locally/);
assert.match(cplfoldSetup, /href="\.\/local-cplfold\.html"[^>]*target="_blank"/);
assert.doesNotMatch(cplfoldSetup, /python3\.11 -m venv \.venv-cplfold/);
assert.doesNotMatch(cplfoldSetup, /RNAXRAY_CPLFOLD_MAX_NT=2000/);
assert.doesNotMatch(cplfoldSetup, /Minimum hairpin loop/);
const cplfoldPrepared = context.window.RNAxRayPages.getStructureSequence(cplfoldState);
assert.equal(cplfoldPrepared.sequence, "GGCGCGGCACCGUCCGCGGAACAAACGG");
assert.deepEqual(JSON.parse(JSON.stringify(cplfoldPrepared.assembly.evidenceArms.map(function (arm) {
  return {
    oneStart: arm.oneStart,
    oneEnd: arm.oneEnd,
    twoStart: arm.twoStart,
    twoEnd: arm.twoEnd,
    recordId: arm.recordId
  };
}))), [
  { oneStart: 3, oneEnd: 8, twoStart: 20, twoEnd: 25, recordId: "block-1" }
], "a non-1 reference window must map HYB coordinates to 1-based prepared-sequence coordinates");
const cplfoldWorkersBefore = workerInstances.length;
assert.equal(context.window.RNAxRayStructure.predict(cplfoldState, {
  render: function () {},
  showToast: function () {}
}), true);
assert.equal(workerInstances.length, cplfoldWorkersBefore + 1);
const cplfoldWorker = workerInstances.at(-1);
assert.equal(cplfoldWorker.url, "./cplfold.worker.mjs?build=local");
assert.deepEqual(JSON.parse(JSON.stringify(cplfoldWorker.options)), { type: "module" });
assert.equal(cplfoldWorker.message.type, "cplfold");
assert.equal(cplfoldWorker.message.evidenceMode, "hyb-blocks");
assert.equal(cplfoldWorker.message.evidenceArms.length, 1);
assert.equal(cplfoldWorker.message.energyModel, "DP09");
assert.equal(cplfoldWorker.message.allowPseudoknot, true);
assert.match(context.window.RNAxRayPages.renderStructure(cplfoldState), /aria-label="CPLfold structure prediction progress"/);
cplfoldWorker.onmessage({ data: { type: "complete", result: {
  algorithm: "CPLfold two-phase pseudoknot prediction",
  model: "LinearFold Vienna-mode scoring with CPLfold/HotKnots DP09 energy ranking",
  engine: "CPLfold",
  engineVersion: "24bab52",
  bridgeVersion: "5",
  allowPseudoknot: true,
  runtime: "Pyodide test runtime",
  dotBracket: "..(((((..[[[[)))))......]]]]",
  energy: -8.0204,
  effectiveEnergy: -8.0204,
  phase1Energy: -3.2,
  score: -100,
  energyUnit: "kcal/mol",
  elapsedMs: 900,
  runtimeLoadMs: 600,
  foldElapsedMs: 300,
  unpaired: 11,
  structureType: "pseudoknot",
  topology: "pseudoknotted",
  crossingPairs: 8,
  constraintMode: "none",
  constraintSource: "none",
  constraintCount: 0,
  constraints: [],
  evidenceMode: "hyb-blocks",
  evidenceSource: "hyb-block-bonus-matrix",
  selectedCandidate: 0,
  parameters: { beamSize: 20, maxPhase1: 2, energyDelta: 5, energyModel: "DP09", alpha: 0.5, beta: 0, allowPseudoknot: true },
  evidence: {
    source: "hyb-block-intervals", inputRecords: 1, uniqueBlocks: 1,
    nonzeroBonusCells: 4, nonzeroUpperTriangleCells: 2, maximumBonus: 0.8,
    bonusEntries: [{ one: 3, two: 20, value: 0.8 }, { one: 4, two: 19, value: 0.4 }]
  },
  maximumNucleotideSupport: 0.8,
  nucleotideSupport: Array(28).fill(0),
  pairs: [
    { left: 3, right: 18, leftBase: "C", rightBase: "G", type: "C–G", layer: "primary", evidenceSupport: 0.2 },
    { left: 10, right: 28, leftBase: "C", rightBase: "G", type: "C–G", layer: "pseudoknot-1", evidenceSupport: 0.3 }
  ],
  candidates: [
    {
      index: 0, dotBracket: "..(((((..[[[[)))))......]]]]", type: "pseudoknot", topology: "pseudoknotted",
      energy: -8.0204, effectiveEnergy: -8.0204, phase1Energy: -3.2, score: -100, crossingPairs: 8,
      unpaired: 11,
      pairs: [
        { left: 3, right: 18, leftBase: "C", rightBase: "G", type: "C–G", layer: "primary", evidenceSupport: 0.2 },
        { left: 10, right: 28, leftBase: "C", rightBase: "G", type: "C–G", layer: "pseudoknot-1", evidenceSupport: 0.3 }
      ]
    },
    {
      index: 1, dotBracket: "..(((((......)))))..........", type: "phase1", topology: "nested",
      energy: -4.1, effectiveEnergy: -4.1, phase1Energy: -4.1, score: -80, crossingPairs: 0,
      unpaired: 17,
      pairs: [{ left: 3, right: 18, leftBase: "C", rightBase: "G", type: "C–G", layer: "primary", evidenceSupport: 0.2 }]
    }
  ]
} } });
const cplfoldResultHtml = context.window.RNAxRayPages.renderStructure(cplfoldState);
assert.match(cplfoldResultHtml, /Pseudoknot candidate/);
assert.match(cplfoldResultHtml, /HYB-derived CPLfold bonus matrix/);
assert.match(cplfoldResultHtml, /data-feature-action="select-cplfold-candidate"/);
assert.match(cplfoldResultHtml, /Click any row to update the RNA visualization/);
assert.match(cplfoldResultHtml, /class="cplfold-candidate-row is-selected"[^>]*aria-pressed="true"/);
assert.match(cplfoldResultHtml, /View structure/);
assert.match(cplfoldResultHtml, /Download bonus matrix/);
assert.match(cplfoldResultHtml, /data-feature-action="download-local-cplfold-input"[^>]*>Download local inputs/);
assert.match(cplfoldResultHtml, /pseudoknot-1/);
const cplfoldApi = { renders: 0, toasts: [], render: function () { this.renders += 1; }, showToast: function (message) { this.toasts.push(message); } };
const localInputEvents = { downloads: [], toasts: [] };
const localInputApi = {
  download: function (name, contents, mediaType) {
    localInputEvents.downloads.push({ name: name, contents: contents, mediaType: mediaType });
  },
  showToast: function (message) { localInputEvents.toasts.push(message); }
};
assert.equal(context.window.RNAxRayStructureUI.handleAction("download-local-cplfold-input", cplfoldState, localInputApi), true);
assert.deepEqual(localInputEvents.downloads, [{
  name: "cplfold-input.fasta",
  contents: ">RNAXRAY_Web_prepared_sequence\nGGCGCGGCACCGUCCGCGGAACAAACGG\n",
  mediaType: "text/plain"
}, {
  name: "cplfold-bonus-matrix.tsv",
  contents: "# RNAxRay CPLfold bonus matrix\n# sequence_length=28\n# coordinate_system=prepared-sequence-1-based-inclusive\n# transform=IRIS-style Gaussian arm blocks; symmetric outer product; threshold 1e-6; log1p\nprepared_position_1\tprepared_position_2\tlog1p_gaussian_hyb_bonus\n3\t20\t0.80000000\n4\t19\t0.40000000\n",
  mediaType: "text/tab-separated-values"
}]);
assert.match(localInputEvents.toasts[0], /bin\/cplfold --sequence-file cplfold-input\.fasta --bonus-matrix-file cplfold-bonus-matrix\.tsv/);

const preResultCplfoldState = Object.assign({}, cplfoldState, {
  structure: Object.assign({}, cplfoldState.structure, {
    status: "idle",
    operation: null,
    progress: 0,
    message: "",
    result: null,
    runId: 0,
    runningSequenceInfo: null
  })
});
const preResultInputEvents = { downloads: [], toasts: [], renders: 0 };
const preResultInputApi = {
  download: function (name, contents, mediaType) {
    preResultInputEvents.downloads.push({ name: name, contents: contents, mediaType: mediaType });
  },
  render: function () { preResultInputEvents.renders += 1; },
  showToast: function (message) { preResultInputEvents.toasts.push(message); }
};
const preResultWorkersBefore = workerInstances.length;
assert.equal(context.window.RNAxRayStructureUI.handleAction("download-local-cplfold-input", preResultCplfoldState, preResultInputApi), true);
assert.equal(workerInstances.length, preResultWorkersBefore + 1);
const bonusMatrixWorker = workerInstances.at(-1);
assert.equal(bonusMatrixWorker.message.type, "cplfold-bonus-matrix");
assert.equal(bonusMatrixWorker.message.evidenceArms.length, 1);
bonusMatrixWorker.onmessage({ data: { type: "bonus-matrix-complete", result: {
  engine: "CPLfold",
  engineVersion: "24bab52",
  bridgeVersion: "5",
  sequence: "GGCGCGGCACCGUCCGCGGAACAAACGG",
  evidenceMode: "hyb-blocks",
  evidence: {
    source: "hyb-block-intervals",
    inputRecords: 1,
    bonusEntries: [{ one: 3, two: 20, value: 0.8 }]
  }
} } });
assert.equal(preResultInputEvents.downloads.length, 2);
assert.equal(preResultInputEvents.downloads[0].name, "cplfold-input.fasta");
assert.equal(preResultInputEvents.downloads[1].name, "cplfold-bonus-matrix.tsv");
assert.match(preResultInputEvents.downloads[1].contents, /sequence_length=28/);
assert.match(preResultInputEvents.toasts.at(-1), /--bonus-matrix-file cplfold-bonus-matrix\.tsv/);
assert.equal(preResultCplfoldState.structure.status, "idle");
assert.equal(context.window.RNAxRayStructureUI.handleAction("select-cplfold-candidate", cplfoldState, cplfoldApi, { dataset: { candidateIndex: "1" } }), true);
assert.equal(cplfoldState.structure.result.selectedCandidate, 1);
assert.equal(cplfoldApi.renders, 1);
assert.equal(cplfoldState.structure.result.topology, "nested");
assert.equal(cplfoldState.structure.result.dotBracket, "..(((((......)))))..........");
const cplfoldReport = context.window.RNAxRayStructureUI.structureReport(cplfoldState, cplfoldState.structure.result);
assert.equal(cplfoldReport.methodScope.cplfoldPurePythonBrowserExecution, true);
assert.equal(cplfoldReport.prediction.pseudoknotAllowed, true);
assert.equal(cplfoldReport.methodScope.cplfoldPseudoknotPrediction, true);
assert.equal(cplfoldReport.methodScope.cplfoldHybBlockBonusMatrix, true);
assert.equal(cplfoldReport.methodScope.numbaJitAvailable, false);
assert.equal(cplfoldReport.methodScope.browserCplfoldBaselineLength, 75);
assert.equal(cplfoldReport.methodScope.browserCplfoldHardCeiling, 500);
assert.equal(cplfoldReport.prediction.selectedCandidateIndex, 1);
assert.equal(cplfoldReport.prediction.selectedCandidateRank, 2);
assert.equal(cplfoldReport.prediction.runtimeLoadMs, 600);
assert.equal(cplfoldReport.prediction.foldElapsedMs, 300);
assert.equal(cplfoldReport.prediction.evidenceMode, "hyb-blocks");
assert.match(context.window.RNAxRayStructureUI.cplfoldEvidenceTsv(cplfoldState.structure.result), /3\t20\t0\.800000/);
assert.match(context.window.RNAxRayStructureUI.cplfoldCandidatesTsv(cplfoldState.structure.result), /2\tyes\tphase1\tnested/);
const cplfoldPairsTsv = context.window.RNAxRayStructureUI.basePairTsv(cplfoldState.structure.result);
assert.match(cplfoldPairsTsv, /rna_cofold_evidence\tmfe_kcal_per_mol\tevidence_kind\tevidence_support/);
assert.match(cplfoldPairsTsv, /\t\tlog1p_hyb_bonus\t0\.2\tprimary\t-4\.10\tCPLfold/);
const sequenceOnlyCplfoldResult = Object.assign({}, cplfoldState.structure.result, {
  evidenceMode: "none",
  evidenceSource: "none",
  evidence: { source: "none", inputRecords: 0, bonusEntries: [] }
});
// the downloads sit in the page heading's Export menu, not in the result
const sequenceOnlyCplfoldHtml = context.window.RNAxRayPages.renderStructureResult(sequenceOnlyCplfoldResult, null) +
  context.window.RNAxRayPages.renderStructureExportMenu(sequenceOnlyCplfoldResult);
assert.doesNotMatch(sequenceOnlyCplfoldHtml, /Download bonus matrix/,
  "sequence-only CPLfold must not offer an empty HYB bonus export");
assert.match(sequenceOnlyCplfoldHtml, /Download candidates/);

const pseudoknotFreeSetupState = Object.assign({}, cplfoldState, {
  structure: Object.assign({}, cplfoldState.structure, {
    cplfoldAllowPseudoknot: false,
    result: null,
    status: "idle",
    operation: null,
    message: ""
  })
});
const pseudoknotFreeSetupHtml = context.window.RNAxRayPages.renderStructure(pseudoknotFreeSetupState);
assert.match(pseudoknotFreeSetupHtml, /Secondary structure only/);
assert.match(pseudoknotFreeSetupHtml, /value="false"[^>]*data-key="cplfoldAllowPseudoknot"[^>]* checked/);
assert.doesNotMatch(pseudoknotFreeSetupHtml, /value="true"[^>]*data-key="cplfoldAllowPseudoknot"[^>]* checked/);
assert.match(context.window.RNAxRayStructureUI.localCplfoldCommand(pseudoknotFreeSetupState.structure, true), /--no-pseudoknot/);
const pseudoknotFreeResult = Object.assign({}, cplfoldState.structure.result, {
  algorithm: "CPLfold pseudoknot-free secondary-structure prediction",
  allowPseudoknot: false,
  structureType: "phase1",
  topology: "nested",
  crossingPairs: 0,
  parameters: Object.assign({}, cplfoldState.structure.result.parameters, { allowPseudoknot: false }),
  candidates: [cplfoldState.structure.result.candidates[1]]
});
const pseudoknotFreeResultHtml = context.window.RNAxRayPages.renderStructureResult(pseudoknotFreeResult, null);
assert.match(pseudoknotFreeResultHtml, /Pseudoknot search disabled/);
assert.match(pseudoknotFreeResultHtml, /No crossing Phase 2 layer was generated/);
assert.match(pseudoknotFreeResultHtml, /Only Phase 1 secondary structures are ranked/);
const pseudoknotFreeReport = context.window.RNAxRayStructureUI.structureReport(pseudoknotFreeSetupState, pseudoknotFreeResult);
assert.equal(pseudoknotFreeReport.prediction.pseudoknotAllowed, false);
assert.equal(pseudoknotFreeReport.methodScope.cplfoldPseudoknotPrediction, false);

const oversizedCplfoldState = structureState("none", "");
Object.assign(oversizedCplfoldState.structure, {
  engine: "cplfold",
  source: "paste",
  pastedSequence: "A".repeat(76),
  cplfoldEvidence: "none",
  cplfoldBeam: "20",
  cplfoldMaxPhase1: "1",
  cplfoldEnergyDelta: "5",
  cplfoldEnergyModel: "DP09",
  cplfoldAlpha: "0.5",
  cplfoldBeta: "0"
});
const workersBeforeOversizedCplfold = workerInstances.length;
assert.equal(context.window.RNAxRayStructure.predict(oversizedCplfoldState, controllerApiForCplfold()), false);
assert.equal(workerInstances.length, workersBeforeOversizedCplfold);

function controllerApiForCplfold() {
  return { render: function () {}, showToast: function (message) { assert.match(message, /capacity test/); } };
}

const pngEvents = { downloads: [], toasts: [], revoked: [] };
state.structure.viewMode = "arc";
const exportSvg = {
  attributes: { viewBox: "0 0 920 300", width: "100%", height: "300" },
  getAttribute: function (name) { return this.attributes[name] || ""; },
  setAttribute: function (name, value) { this.attributes[name] = value; },
  cloneNode: function () {
    return {
      attributes: Object.assign({}, this.attributes),
      getAttribute: this.getAttribute,
      setAttribute: this.setAttribute
    };
  }
};
let drawCall = null;
const pngBlob = new Blob(["png"], { type: "image/png" });
context.document = {
  querySelector: function () { return exportSvg; },
  createElement: function (name) {
    assert.equal(name, "canvas");
    return {
      width: 0,
      height: 0,
      getContext: function (kind) {
        assert.equal(kind, "2d");
        return {
          drawImage: function () { drawCall = Array.from(arguments); }
        };
      },
      toBlob: function (callback, type) {
        assert.equal(type, "image/png");
        callback(pngBlob);
      }
    };
  }
};
context.XMLSerializer = function () {};
context.XMLSerializer.prototype.serializeToString = function (svg) {
  assert.equal(svg.attributes.width, "1840");
  assert.equal(svg.attributes.height, "600");
  return '<svg viewBox="0 0 920 300"></svg>';
};
context.Blob = Blob;
context.URL = {
  createObjectURL: function (blob) {
    assert.equal(blob.type, "image/svg+xml;charset=utf-8");
    return "blob:structure-svg";
  },
  revokeObjectURL: function (url) { pngEvents.revoked.push(url); }
};
context.Image = function () {};
Object.defineProperty(context.Image.prototype, "src", {
  set: function (value) {
    assert.equal(value, "blob:structure-svg");
    this.onload();
  }
});
const pngApi = {
  downloadBlob: function (fileName, blob) { pngEvents.downloads.push({ fileName: fileName, blob: blob }); },
  showToast: function (message) { pngEvents.toasts.push(message); }
};
assert.equal(context.window.RNAxRayStructureUI.handleAction("download-structure-png", state, pngApi), true);
assert.equal(pngEvents.downloads.length, 1);
assert.equal(pngEvents.downloads[0].fileName, "rna-secondary-structure-arcs.png");
assert.equal(pngEvents.downloads[0].blob, pngBlob);
assert.equal(drawCall[3], 1840);
assert.equal(drawCall[4], 600);
assert.deepEqual(pngEvents.revoked, ["blob:structure-svg"]);
assert.match(pngEvents.toasts.at(-1), /Structure PNG downloaded locally/);

context.document.querySelector = function () { return null; };
const missingPngEvents = { downloads: 0, toasts: [] };
assert.equal(context.window.RNAxRayStructureUI.handleAction("download-structure-png", state, {
  downloadBlob: function () { missingPngEvents.downloads += 1; },
  showToast: function (message) { missingPngEvents.toasts.push(message); }
}), true);
assert.equal(missingPngEvents.downloads, 0);
assert.match(missingPngEvents.toasts.at(-1), /not ready to export/);

context.document.querySelector = function () { return exportSvg; };
context.document.createElement = function () {
  return {
    width: 0,
    height: 0,
    getContext: function () { return { drawImage: function () {} }; },
    toBlob: function (callback) { callback(null); }
  };
};
const failedPngEvents = { downloads: 0, toasts: [] };
assert.equal(context.window.RNAxRayStructureUI.handleAction("download-structure-png", state, {
  downloadBlob: function () { failedPngEvents.downloads += 1; },
  showToast: function (message) { failedPngEvents.toasts.push(message); }
}), true);
assert.equal(failedPngEvents.downloads, 0, "a null canvas blob must not start a download");
assert.match(failedPngEvents.toasts.at(-1), /could not create the structure PNG/);

const parsed = context.window.RNAxRayStructure.parseManualConstraints("4-8\n3-9", "GCGCUUCGCC", 3);
assert.deepEqual(JSON.parse(JSON.stringify(parsed)), [{ left: 3, right: 9 }, { left: 4, right: 8 }]);
assert.throws(function () {
  context.window.RNAxRayStructure.parseManualConstraints("4,8", "GCGCUUCGCC", 3);
}, /i-j format/);
assert.throws(function () {
  context.window.RNAxRayStructure.parseManualConstraints("3-9\n3-10", "GCGCUUCGCC", 3);
}, /reuses a nucleotide/);
assert.throws(function () {
  context.window.RNAxRayStructure.parseManualConstraints("1-7\n3-9", "GCGCUUCGCC", 3);
}, /must not cross/);

const controllerApi = {
  renders: 0,
  toasts: [],
  render: function () { this.renders += 1; },
  showToast: function (message) { this.toasts.push(message); }
};
const controllerWorkerBaseline = workerInstances.length;
const constrainedState = structureState("manual-hard-base-pairs", "4-8");
assert.equal(context.window.RNAxRayStructure.predict(constrainedState, controllerApi), true);
assert.equal(workerInstances.length, controllerWorkerBaseline + 1);
assert.equal(workerInstances.at(-1).url, "./structure.worker.js");
assert.deepEqual(JSON.parse(JSON.stringify(workerInstances.at(-1).message.constraints)), [{ left: 4, right: 8 }]);

const plainState = structureState("none", "not parsed in plain mode");
assert.equal(context.window.RNAxRayStructure.predict(plainState, controllerApi), true);
assert.equal(workerInstances.length, controllerWorkerBaseline + 2);
assert.deepEqual(JSON.parse(JSON.stringify(workerInstances.at(-1).message.constraints)), []);

context.window.RNAxRayData.extractReference = function () {
  return { id: "ref_A", start: 1, end: 10, sequence: "GCGCUUCGCC" };
};
const referenceState = structureState("none", "");
referenceState.fasta = { mapping: { RNA_A: "ref_A" } };
referenceState.structure.source = "reference";
referenceState.structure.rna = "RNA_A";
referenceState.structure.start = "";
referenceState.structure.end = "999";
providerView(referenceState);
const effectiveReference = context.window.RNAxRayPages.getStructureSequence(referenceState);
assert.equal(effectiveReference.sourceStart, 1);
assert.equal(effectiveReference.sourceEnd, 10);
assert.equal(context.window.RNAxRayStructure.predict(referenceState, controllerApi), true);
const referenceWorker = workerInstances.at(-1);
referenceWorker.onmessage({ data: { type: "complete", result: {
  algorithm: "ViennaRNA MFE", sequence: "GCGCUUCGCC", dotBracket: "..........", pairs: []
} } });
assert.equal(referenceState.structure.result.sourceRna, "RNA_A");
assert.equal(referenceState.structure.result.sourceStart, 1,
  "reference provenance must use the effective extracted start rather than Number(blank)");
assert.equal(referenceState.structure.result.sourceEnd, 10,
  "reference provenance must use the clamped extracted end rather than the raw control value");

const invalidState = structureState("manual-hard-base-pairs", "4,8");
const workersBeforeInvalidSyntax = workerInstances.length;
assert.equal(context.window.RNAxRayStructure.predict(invalidState, controllerApi), false);
assert.equal(workerInstances.length, workersBeforeInvalidSyntax, "Invalid manual syntax must not start a Worker");
assert.equal(invalidState.structure.status, "error");
assert.match(controllerApi.toasts.at(-1), /i-j format/);

const zeroBoundaryState = structureState("none", "");
zeroBoundaryState.structure.minimumLoop = "0";
zeroBoundaryState.structure.temperature = "0";
assert.equal(context.window.RNAxRayStructure.predict(zeroBoundaryState, controllerApi), true);
assert.equal(workerInstances.at(-1).message.minimumLoop, 0, "A zero-nucleotide minimum loop is a valid explicit boundary");
assert.equal(workerInstances.at(-1).message.temperature, 0, "0 °C is a valid explicit boundary");

const upperBoundaryState = structureState("none", "");
upperBoundaryState.structure.minimumLoop = "12";
upperBoundaryState.structure.temperature = "100";
assert.equal(context.window.RNAxRayStructure.predict(upperBoundaryState, controllerApi), true);
assert.equal(workerInstances.at(-1).message.minimumLoop, 12);
assert.equal(workerInstances.at(-1).message.temperature, 100);

const legacyState = structureState("none", "");
delete legacyState.structure.minimumLoop;
delete legacyState.structure.temperature;
assert.equal(context.window.RNAxRayStructure.predict(legacyState, controllerApi), true);
assert.equal(workerInstances.at(-1).message.minimumLoop, 3, "A missing legacy minimumLoop field should use the default");
assert.equal(workerInstances.at(-1).message.temperature, 37, "A missing legacy temperature field should use the default");

const resetState = structureState("manual-hard-base-pairs", "2-9");
resetState.structure.selectedNucleotide = 7;
resetState.structure.result = { stale: true };
resetState.structure.allowLarge = true;
context.window.RNAxRayStructure.reset(resetState, { clearConstraints: true });
assert.equal(resetState.structure.result, null);
assert.equal(resetState.structure.selectedNucleotide, null,
  "invalidating a fold must not carry a nucleotide selection into another result");
assert.equal(resetState.structure.constraintMode, "manual-hard-base-pairs",
  "clearing sequence-specific pairs may keep the user in explicit constraint-entry mode");
assert.equal(resetState.structure.constraintText, "",
  "sequence-provenance changes must not apply hard pairs authored for a different sequence");
assert.equal(resetState.structure.allowLarge, false,
  "large-sequence consent must be renewed after changing sequence provenance");
const parameterResetState = structureState("manual-hard-base-pairs", "2-9");
parameterResetState.structure.selectedNucleotide = 2;
context.window.RNAxRayStructure.reset(parameterResetState);
assert.equal(parameterResetState.structure.constraintText, "2-9",
  "parameter-only invalidation may retain explicitly authored hard pairs for the same sequence");
assert.equal(parameterResetState.structure.selectedNucleotide, null);

[
  { field: "minimumLoop", value: "", pattern: /whole number from 0 to 12/ },
  { field: "minimumLoop", value: "three", pattern: /whole number from 0 to 12/ },
  { field: "minimumLoop", value: "3.5", pattern: /whole number from 0 to 12/ },
  { field: "minimumLoop", value: "-1", pattern: /whole number from 0 to 12/ },
  { field: "minimumLoop", value: "13", pattern: /whole number from 0 to 12/ },
  { field: "minimumLoop", value: null, pattern: /whole number from 0 to 12/ },
  { field: "temperature", value: "", pattern: /number from 0 to 100 °C/ },
  { field: "temperature", value: "cold", pattern: /number from 0 to 100 °C/ },
  { field: "temperature", value: "-0.1", pattern: /number from 0 to 100 °C/ },
  { field: "temperature", value: "100.1", pattern: /number from 0 to 100 °C/ },
  { field: "temperature", value: null, pattern: /number from 0 to 100 °C/ }
].forEach(function (fixture) {
  const parameterState = structureState("none", "");
  const workersBefore = workerInstances.length;
  parameterState.structure[fixture.field] = fixture.value;
  assert.equal(context.window.RNAxRayStructure.predict(parameterState, controllerApi), false,
    fixture.field + "=" + String(fixture.value) + " should be rejected");
  assert.equal(workerInstances.length, workersBefore, "Invalid parameters must not start a Worker");
  assert.equal(parameterState.structure.status, "error");
  assert.match(parameterState.structure.message, fixture.pattern);
  assert.equal(controllerApi.toasts.at(-1), parameterState.structure.message,
    "The actionable parameter error should also be shown as a toast");
});

// Mirrors web/page-data.js: pages receive DataProvider results in
// state.view / state.reference instead of raw records and the parsed FASTA.
function providerView(target) {
  const fasta = target.fasta || null;
  const records = target.records || [];
  const structure = target.structure || {};
  const guided = structure.engine === "cplfold" ? structure.cplfoldEvidence === "hyb-blocks" : structure.constraintMode === "hyb-guided";
  const rnas = [structure.rna, structure.secondRna].filter(function (rna, index, list) { return rna && list.indexOf(rna) === index; });
  const mapped = {};
  Object.keys(fasta && fasta.mapping || {}).forEach(function (rna) {
    const entry = (fasta.sequences || []).find(function (item) { return item.id === fasta.mapping[rna]; });
    mapped[rna] = { referenceId: fasta.mapping[rna], length: entry ? entry.sequence.length : 0 };
  });
  target.reference = fasta ? {
    fileName: fasta.fileName, fileSize: fasta.fileSize, sha256: fasta.sha256,
    mapping: Object.assign({}, fasta.mapping), mapped: mapped, sequenceCount: (fasta.sequences || []).length
  } : null;
  target.view = Object.assign({}, target.view, {
    structureRecords: records.slice(0, 500),
    structureEvidence: fasta ? {
      fasta: { sequences: fasta.sequences || [], mapping: Object.assign({}, fasta.mapping) },
      records: guided ? records : null,
      guided: guided,
      rnas: rnas
    } : null
  });
  return target;
}

function structureState(constraintMode, constraintText) {
  return {
    summary: { rnaNames: [], fileName: "fixture.hyb", sha256: "fixture" },
    records: [],
    structureWorker: null,
    structure: {
      source: "paste",
      engine: "viennarna",
      pastedSequence: "GCGCUUCGCC",
      selectedRecordIndex: null,
      minimumLoop: "3",
      temperature: "37",
      constraintMode: constraintMode,
      constraintText: constraintText,
      evidenceLayout: "single",
      secondRna: "",
      secondStart: "",
      secondEnd: "",
      homodimerOnly: false,
      constraintLimit: "75",
      randomFoldCount: "0",
      randomSeed: "RNAxRay-Web",
      allowLargeEnsemble: false,
      allowLarge: false,
      selectedNucleotide: null,
      status: "idle",
      progress: 0,
      message: "",
      result: null,
      runId: 0
    }
  };
}

process.stdout.write("structure-render-controller-contract: ok\n");

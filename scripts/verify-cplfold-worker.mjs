import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(scriptDirectory, "..");
const workerPath = path.join(repository, "web", "cplfold.worker.mjs");
const messages = [];
const nativeFetch = globalThis.fetch;

globalThis.self = {
  location: { href: pathToFileURL(workerPath).href + "?build=local" },
  crypto: globalThis.crypto,
  postMessage: function (message) { messages.push(message); }
};

// Node's Fetch implementation does not read file: URLs. The browser worker
// uses fetch for same-origin files, so provide only that narrow local adapter.
globalThis.fetch = async function (input, options) {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.protocol !== "file:") {
    return nativeFetch(input, options);
  }
  try {
    const bytes = fs.readFileSync(fileURLToPath(url));
    return new Response(bytes, { status: 200 });
  } catch (error) {
    return new Response("Not found", { status: 404 });
  }
};

await import(pathToFileURL(workerPath).href + "?worker-contract=1");
assert.equal(typeof self.onmessage, "function");

await self.onmessage({
  data: {
    type: "cplfold",
    sequence: "GGCGCGGCACCGUCCGCGGAACAAACGG",
    evidenceMode: "hyb-blocks",
    evidenceArms: [
      { oneStart: 3, oneEnd: 8, twoStart: 20, twoEnd: 25 },
      { oneStart: 4, oneEnd: 9, twoStart: 19, twoEnd: 24 }
    ],
    beamSize: 20,
    maxPhase1: 2,
    energyDelta: 5,
    energyModel: "DP09",
    alpha: 0.5,
    beta: 0,
    allowPseudoknot: true
  }
});

const failure = messages.find(function (message) { return message.type === "error"; });
assert.equal(failure, undefined, failure && failure.message);
assert.ok(messages.some(function (message) { return message.type === "progress" && message.phase === "source"; }));
const completion = messages.find(function (message) { return message.type === "complete"; });
assert.ok(completion, "the actual worker message path must return a completed fold");
assert.equal(completion.result.bridgeVersion, "5");
assert.equal(completion.result.engineVersion, "24bab52");
assert.equal(completion.result.allowPseudoknot, true);
assert.equal(completion.result.dotBracket, "..(((((..[[[[)))))......]]]]");
assert.equal(completion.result.maxSequenceLength, 75);
assert.match(completion.result.runtimeManifest.archiveSha256, /^[a-f0-9]{64}$/);
assert.ok(completion.result.elapsedMs >= completion.result.foldElapsedMs);
assert.ok(completion.result.elapsedMs >= completion.result.runtimeLoadMs);

messages.length = 0;
await self.onmessage({
  data: {
    type: "cplfold-capacity",
    probeLength: 25,
    evidenceMode: "none",
    beamSize: 1,
    maxPhase1: 1,
    energyDelta: 0,
    energyModel: "DP09",
    alpha: 0,
    beta: 0,
    allowPseudoknot: true
  }
});
const capacityFailure = messages.find(function (message) { return message.type === "error"; });
assert.equal(capacityFailure, undefined, capacityFailure && capacityFailure.message);
const capacityCompletion = messages.find(function (message) { return message.type === "capacity-complete"; });
assert.ok(capacityCompletion, "the worker capacity probe must return a completed sample");
assert.equal(capacityCompletion.sample.length, 25);
assert.ok(capacityCompletion.sample.foldElapsedMs >= 0);
assert.equal(capacityCompletion.parameters.beamSize, 1);
assert.match(capacityCompletion.runtimeManifest.archiveSha256, /^[a-f0-9]{64}$/);

messages.length = 0;
await self.onmessage({
  data: {
    type: "cplfold-bonus-matrix",
    sequence: "GGCGCGGCACCGUCCGCGGAACAAACGG",
    evidenceMode: "hyb-blocks",
    evidenceArms: [
      { oneStart: 3, oneEnd: 8, twoStart: 20, twoEnd: 25 }
    ]
  }
});
const matrixFailure = messages.find(function (message) { return message.type === "error"; });
assert.equal(matrixFailure, undefined, matrixFailure && matrixFailure.message);
const matrixCompletion = messages.find(function (message) { return message.type === "bonus-matrix-complete"; });
assert.ok(matrixCompletion, "the worker must export the HYB bonus matrix independently of a fold");
assert.equal(matrixCompletion.result.bridgeVersion, "5");
assert.equal(matrixCompletion.result.evidence.inputRecords, 1);
assert.ok(matrixCompletion.result.evidence.bonusEntries.length > 0);

messages.length = 0;
await self.onmessage({
  data: {
    type: "cplfold",
    sequence: "GGCGCGGCACCGUCCGCGGAACAAACGG" + "GCAU".repeat(12),
    maxSequenceLength: 125,
    evidenceMode: "none",
    beamSize: 1,
    maxPhase1: 1,
    energyDelta: 0,
    energyModel: "DP09",
    alpha: 0,
    beta: 0,
    allowPseudoknot: true
  }
});
const extendedFailure = messages.find(function (message) { return message.type === "error"; });
assert.equal(extendedFailure, undefined, extendedFailure && extendedFailure.message);
const extendedCompletion = messages.find(function (message) { return message.type === "complete"; });
assert.ok(extendedCompletion, "the worker must execute a sequence above the baseline when the request is within the tested capacity");
assert.equal(extendedCompletion.result.sequence.length, 76);
assert.equal(extendedCompletion.result.maxSequenceLength, 125);

messages.length = 0;
await self.onmessage({
  data: {
    type: "cplfold",
    sequence: "GGCGCGGCACCGUCCGCGGAACAAACGG",
    evidenceMode: "none",
    beamSize: 1,
    maxPhase1: 1,
    energyDelta: 0,
    energyModel: "DP09",
    alpha: 0,
    beta: 0.5,
    allowPseudoknot: false
  }
});
const pseudoknotFreeFailure = messages.find(function (message) { return message.type === "error"; });
assert.equal(pseudoknotFreeFailure, undefined, pseudoknotFreeFailure && pseudoknotFreeFailure.message);
const pseudoknotFreeCompletion = messages.find(function (message) { return message.type === "complete"; });
assert.ok(pseudoknotFreeCompletion, "the worker must complete a pseudoknot-free fold");
assert.equal(pseudoknotFreeCompletion.result.allowPseudoknot, false);
assert.equal(pseudoknotFreeCompletion.result.crossingPairs, 0);
assert.ok(pseudoknotFreeCompletion.result.candidates.every(function (candidate) {
  return candidate.type !== "pseudoknot" && candidate.crossingPairs === 0;
}));

globalThis.fetch = nativeFetch;
delete globalThis.self;
process.stdout.write("cplfold-worker-contract: ok\n");

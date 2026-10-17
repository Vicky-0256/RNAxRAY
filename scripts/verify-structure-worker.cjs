"use strict";

/*
 * Exercise the browser Worker protocol against the generated Emscripten module
 * in Node's worker_threads runtime. This is intentionally separate from the
 * native-module smoke test: it proves that the site-level message boundary,
 * asset lookup, and result serialization all remain compatible.
 */

const assert = require("node:assert/strict");
const { Worker } = require("node:worker_threads");
const path = require("node:path");
const fs = require("node:fs");

const workerSource = path.resolve(__dirname, "..", "web", "structure.worker.js");
const shimSource = `
  const { parentPort } = require("node:worker_threads");
  const fs = require("node:fs");
  const vm = require("node:vm");
  const { fileURLToPath, pathToFileURL } = require("node:url");
  const workerSource = ${JSON.stringify(workerSource)};

  global.self = global;
  global.self.location = { href: pathToFileURL(workerSource).href };
  global.self.postMessage = function (message) { parentPort.postMessage(message); };
  global.require = require;
  global.importScripts = function () {
    for (const url of arguments) {
      const filename = url.startsWith("file:") ? fileURLToPath(url) : url;
      vm.runInThisContext(fs.readFileSync(filename, "utf8"), { filename });
    }
  };

  vm.runInThisContext(fs.readFileSync(workerSource, "utf8"), { filename: workerSource });
  parentPort.on("message", function (data) { global.self.onmessage({ data }); });
`;

async function main() {
  const generatedAsset = path.resolve(__dirname, "..", "web", "vendor", "viennarna", "vienna-rna.js");
  if (!fs.existsSync(generatedAsset)) {
    const worker = new Worker(shimSource, { eval: true });
    try {
      const missing = await waitForTerminal(worker, [], {
        type: "fold",
        sequence: "GCGCUUCGCC",
        temperature: 37,
        minimumLoop: 3
      });
      assert.equal(missing.type, "error");
      assert.match(missing.message, /ViennaRNA WebAssembly assets are missing/);
      process.stdout.write("structure-worker-assets-missing: diagnostic ok\n");
      return;
    } finally {
      await worker.terminate();
    }
  }
  const worker = new Worker(shimSource, { eval: true });
  const messages = [];

  try {
    const unconstrainedMessage = await waitForTerminal(worker, messages, {
      type: "fold",
      sequence: "GCGCUUCGCC",
      temperature: 37,
      minimumLoop: 3
    });
    assert.equal(unconstrainedMessage.type, "complete", unconstrainedMessage.message);
    const result = unconstrainedMessage.result;
    assert.equal(result.engine, "ViennaRNA");
    assert.equal(result.engineVersion, "2.7.2");
    assert.equal(Number.isFinite(result.energy), true);
    assert.equal(result.dotBracket.length, 10);
    assert.match(result.dotBracket, /^[.()]+$/);
    assert.equal(result.pairs.length * 2 + result.unpaired, 10);
    assert.equal(result.constraintMode, "none");
    assert.equal(result.constraintCount, 0);
    assert.deepEqual(result.constraints, []);
    assert.equal(hasPair(result, 4, 8), false,
      "The constrained integration pair should differ from the unconstrained MFE");

    const constrainedMessage = await waitForTerminal(worker, messages, {
      type: "fold",
      sequence: "GCGCUUCGCC",
      temperature: 37,
      minimumLoop: 3,
      constraints: [{ left: 3, right: 9 }, { left: 4, right: 8 }]
    });
    assert.equal(constrainedMessage.type, "complete", constrainedMessage.message);
    const constrained = constrainedMessage.result;
    assert.equal(Number.isFinite(constrained.energy), true);
    assert.equal(constrained.constraintMode, "hard-base-pairs");
    assert.equal(constrained.constraintCount, 2);
    assert.deepEqual(constrained.constraints, [{ left: 3, right: 9 }, { left: 4, right: 8 }]);
    assert.equal(hasPair(constrained, 3, 9), true,
      "Expected the Worker result to contain the first requested hard-constrained pair");
    assert.equal(hasPair(constrained, 4, 8), true,
      "Expected the Worker result to contain the second requested hard-constrained pair");

    const conflictingMessage = await waitForTerminal(worker, messages, {
      type: "fold",
      sequence: "GCGCUUCGCC",
      temperature: 37,
      minimumLoop: 3,
      constraints: [{ left: 3, right: 9 }, { left: 3, right: 10 }]
    });
    assert.equal(conflictingMessage.type, "error");
    assert.match(conflictingMessage.message, /reuses a nucleotide/);

    const crossingMessage = await waitForTerminal(worker, messages, {
      type: "fold",
      sequence: "GCGCUUCGCC",
      temperature: 37,
      minimumLoop: 3,
      constraints: [{ left: 1, right: 7 }, { left: 3, right: 9 }]
    });
    assert.equal(crossingMessage.type, "error");
    assert.match(crossingMessage.message, /must not cross/);

    const comradesMessage = await waitForTerminal(worker, messages, {
      type: "comrades-fold",
      sequence: "GGGGGGAAAACCCCCC",
      temperature: 37,
      minimumLoop: 3,
      constraintLimit: 75,
      randomFoldCount: 2,
      seed: "worker-contract",
      evidenceArms: [
        { recordId: "read-1", recordIndex: 1, sequenceOne: "GGGGGG", sequenceTwo: "CCCCCC", oneStart: 1, twoStart: 11 },
        { recordId: "read-2", recordIndex: 2, sequenceOne: "GGGGGG", sequenceTwo: "CCCCCC", oneStart: 1, twoStart: 11 }
      ]
    });
    assert.equal(comradesMessage.type, "complete", comradesMessage.message);
    const comrades = comradesMessage.result;
    assert.equal(comrades.constraintMode, "hyb-guided");
    assert.equal(comrades.constraintSource, "hyb-rna-cofold-evidence");
    assert.equal(comrades.evidence.inputRecords, 2);
    assert.equal(comrades.evidence.cofoldsWithIntermolecularPairs, 2);
    assert.ok(comrades.evidence.uniqueBasePairs > 0);
    assert.ok(comrades.evidence.rankedStems.length > 0);
    assert.ok(comrades.constraintCount > 0);
    assert.ok(comrades.comradesScore > 0);
    assert.equal(comrades.randomisation.completedFolds, 2);
    assert.equal(comrades.randomisation.structures.length, 3,
      "the ensemble should contain the ranked fold plus both randomised folds");
    assert.equal(comrades.randomisation.seed, "worker-contract");
    assert.ok(comrades.pairs.some(function (pair) { return pair.evidenceSupport > 0; }));

    assert.ok(messages.some(function (message) { return message.type === "progress"; }));
    assert.ok(messages.some(function (message) {
      return message.type === "progress" && message.details && message.details.phase === "rna-cofold";
    }));
    process.stdout.write("structure-worker-integration: ok\n");
  } finally {
    await worker.terminate();
  }
}

function hasPair(result, left, right) {
  return result.pairs.some(function (pair) {
    return pair.left === left && pair.right === right;
  });
}

function waitForTerminal(worker, messages, request) {
  return new Promise(function (resolve, reject) {
    const timeout = setTimeout(function () {
      reject(new Error("Timed out waiting for the ViennaRNA structure worker result."));
    }, 30000);

    function cleanup() {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
    }

    function onMessage(message) {
      messages.push(message);
      if (message.type === "error" || message.type === "complete") {
        cleanup();
        resolve(message);
      }
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage(request);
  });
}

main().catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exitCode = 1;
});

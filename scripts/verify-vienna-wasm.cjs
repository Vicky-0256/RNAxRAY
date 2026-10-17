"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const entry = process.argv[2];

if (!entry) {
  throw new Error("Usage: node scripts/verify-vienna-wasm.cjs path/to/vienna-rna.js");
}

const createRNAxRayVienna = require(path.resolve(entry));
const assetDirectory = path.dirname(path.resolve(entry));

async function main() {
  const module = await createRNAxRayVienna({
    locateFile: function (file) {
      return path.join(assetDirectory, file);
    },
    print: function () {},
    printErr: function () {}
  });

  ["_rnaxray_vienna_mfe", "_rnaxray_vienna_mfe_constrained", "_rnaxray_vienna_cofold", "_rnaxray_vienna_version", "_malloc", "_free", "lengthBytesUTF8", "stringToUTF8", "UTF8ToString"].forEach(function (name) {
    assert.equal(typeof module[name], "function", "Expected exported Emscripten API " + name);
  });

  const sequence = "GCGCUUCGCC";
  const sequenceBytes = module.lengthBytesUTF8(sequence) + 1;
  const sequencePointer = module._malloc(sequenceBytes);
  const structurePointer = module._malloc(sequence.length + 1);
  const requestedPairs = [{ left: 3, right: 9 }, { left: 4, right: 8 }];
  const constraintPointer = module._malloc(Uint32Array.BYTES_PER_ELEMENT * requestedPairs.length * 2);

  try {
    module.stringToUTF8(sequence, sequencePointer, sequenceBytes);
    const mfe = module._rnaxray_vienna_mfe(sequencePointer, 37, 3, structurePointer, sequence.length + 1);
    const structure = module.UTF8ToString(structurePointer);
    const version = module.UTF8ToString(module._rnaxray_vienna_version());

    assert.equal(Number.isFinite(mfe), true, "Expected a finite MFE");
    assert.equal(structure.length, sequence.length, "Expected a dot-bracket character for every nucleotide");
    assert.match(structure, /^[.()]+$/, "Expected a non-pseudoknotted dot-bracket structure");
    assert.equal(version, "2.7.2", "Expected the pinned ViennaRNA version");

    requestedPairs.forEach(function (requestedPair, index) {
      assert.equal(hasPair(structure, requestedPair.left, requestedPair.right), false,
        "Each constrained smoke pair should differ from the unconstrained MFE");
      module.HEAPU32[(constraintPointer >>> 2) + index * 2] = requestedPair.left;
      module.HEAPU32[(constraintPointer >>> 2) + index * 2 + 1] = requestedPair.right;
    });

    const constrainedMfe = module._rnaxray_vienna_mfe_constrained(
      sequencePointer,
      37,
      3,
      constraintPointer,
      requestedPairs.length,
      structurePointer,
      sequence.length + 1
    );
    const constrainedStructure = module.UTF8ToString(structurePointer);
    assert.equal(Number.isFinite(constrainedMfe), true, "Expected a finite constrained MFE");
    assert.equal(constrainedStructure.length, sequence.length,
      "Expected a constrained dot-bracket character for every nucleotide");
    assert.match(constrainedStructure, /^[.()]+$/,
      "Expected a non-pseudoknotted constrained dot-bracket structure");
    requestedPairs.forEach(function (requestedPair) {
      assert.equal(hasPair(constrainedStructure, requestedPair.left, requestedPair.right), true,
        "Expected every hard-constrained pair to appear in the returned dot-bracket structure");
    });

    const firstArm = "GGGGGG";
    const secondArm = "CCCCCC";
    const firstArmPointer = writeString(module, firstArm);
    const secondArmPointer = writeString(module, secondArm);
    const cofoldStructurePointer = module._malloc(firstArm.length + secondArm.length + 1);
    try {
      const cofoldMfe = module._rnaxray_vienna_cofold(
        firstArmPointer,
        secondArmPointer,
        37,
        3,
        cofoldStructurePointer,
        firstArm.length + secondArm.length + 1
      );
      const cofoldStructure = module.UTF8ToString(cofoldStructurePointer);
      assert.equal(Number.isFinite(cofoldMfe), true, "Expected a finite RNAcofold MFE");
      assert.equal(cofoldStructure.length, firstArm.length + secondArm.length,
        "RNAcofold output must omit the strand delimiter without changing nucleotide coordinates");
      assert.match(cofoldStructure, /^[.()]+$/);
      assert.equal(dotBracketPairs(cofoldStructure).some(function (pair) {
        return pair.left <= firstArm.length && pair.right > firstArm.length;
      }), true, "Expected the complementary smoke-test arms to form an intermolecular base pair");
    } finally {
      module._free(cofoldStructurePointer);
      module._free(secondArmPointer);
      module._free(firstArmPointer);
    }
    process.stdout.write("vienna-wasm-smoke: ok\n");
  } finally {
    module._free(constraintPointer);
    module._free(structurePointer);
    module._free(sequencePointer);
  }
}

function writeString(module, value) {
  const bytes = module.lengthBytesUTF8(value) + 1;
  const pointer = module._malloc(bytes);
  module.stringToUTF8(value, pointer, bytes);
  return pointer;
}

function dotBracketPairs(dotBracket) {
  const stack = [];
  const pairs = [];
  for (let index = 0; index < dotBracket.length; index += 1) {
    if (dotBracket.charAt(index) === "(") {
      stack.push(index + 1);
    } else if (dotBracket.charAt(index) === ")") {
      pairs.push({ left: stack.pop(), right: index + 1 });
    }
  }
  return pairs;
}

function hasPair(dotBracket, requestedLeft, requestedRight) {
  const stack = [];

  for (let index = 0; index < dotBracket.length; index += 1) {
    if (dotBracket.charAt(index) === "(") {
      stack.push(index + 1);
    } else if (dotBracket.charAt(index) === ")") {
      const left = stack.pop();
      if (left === requestedLeft && index + 1 === requestedRight) {
        return true;
      }
    }
  }

  return false;
}

main().catch(function (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write("\n");
  process.exitCode = 1;
});

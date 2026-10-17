/*
 * ViennaRNA MFE and HYB-guided COMRADES worker.
 *
 * The generated Emscripten module is deliberately loaded only inside this
 * worker. RNA sequence data and the dynamic-programming computation never
 * leave the browser tab or block the main rendering thread.
 */

"use strict";

const MAX_SEQUENCE_LENGTH = 3000;
const MAX_EVIDENCE_RECORDS = 50000;
const MAX_RANDOM_FOLDS = 1000;
const ENGINE_DIRECTORY = new URL("./vendor/viennarna/", self.location.href).href;
const ENGINE_GLUE_URL = new URL("vienna-rna.js", ENGINE_DIRECTORY).href;
const COMRADES_CORE_URL = new URL("./comrades-analysis.js", self.location.href).href;

let enginePromise = null;

self.onmessage = async function (event) {
  const message = event.data || {};

  try {
    if (message.type === "comrades-fold") {
      await runComradesFold(message);
      return;
    }
    if (message.type !== "fold") {
      return;
    }

    const sequence = String(message.sequence || "").toUpperCase();
    const minimumLoop = normaliseMinimumLoop(message.minimumLoop);
    const temperature = normaliseTemperature(message.temperature);

    validateSequence(sequence);
    const constraints = normaliseConstraints(message.constraints, sequence, minimumLoop);
    self.postMessage({ type: "progress", stage: "Loading ViennaRNA folding engine", percent: 7 });
    const engine = await getEngine();
    self.postMessage({
      type: "progress",
      stage: constraints.length ? "Preparing constrained thermodynamic MFE calculation" : "Preparing thermodynamic MFE calculation",
      percent: 28
    });

    /* Yield once so the progress state can paint before the synchronous C call. */
    await yieldToEventLoop();
    self.postMessage({ type: "progress", stage: "Calculating minimum-free-energy structure", percent: 45 });

    const startedAt = Date.now();
    const result = foldWithVienna(engine, sequence, temperature, minimumLoop, constraints);
    result.elapsedMs = Date.now() - startedAt;

    self.postMessage({ type: "progress", stage: "Preparing dot-bracket result", percent: 92 });
    self.postMessage({ type: "complete", result: result });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error && error.message ? error.message : "ViennaRNA WebAssembly could not finish the structure prediction."
    });
  }
};

async function getEngine() {
  if (!enginePromise) {
    enginePromise = initialiseEngine();
  }
  return enginePromise;
}

async function initialiseEngine() {
  if (typeof WebAssembly !== "object") {
    throw new Error("This browser does not provide WebAssembly, which is required for ViennaRNA MFE folding.");
  }

  try {
    importScripts(ENGINE_GLUE_URL);
  } catch (error) {
    throw new Error("ViennaRNA WebAssembly assets are missing at " + ENGINE_GLUE_URL + ". Build the static site with scripts/build-vienna-wasm.sh or deploy through the Pages workflow.");
  }

  const factory = self.createRNAxRayVienna;
  if (typeof factory !== "function") {
    throw new Error("The ViennaRNA WebAssembly loader did not expose the expected folding module.");
  }

  let module;
  try {
    module = await factory({
      locateFile: function (file) {
        return new URL(file, ENGINE_DIRECTORY).href;
      },
      print: function () {},
      printErr: function () {},
      noInitialRun: true
    });
  } catch (error) {
    throw new Error("ViennaRNA WebAssembly assets were found but could not initialise in this browser. Check the generated .wasm file and browser console.");
  }

  ["_rnaxray_vienna_mfe", "_rnaxray_vienna_mfe_constrained", "_rnaxray_vienna_cofold", "_rnaxray_vienna_version", "_malloc", "_free", "lengthBytesUTF8", "stringToUTF8", "UTF8ToString"].forEach(function (key) {
    if (typeof module[key] !== "function") {
      throw new Error("ViennaRNA WebAssembly is missing required folding API " + key + ".");
    }
  });

  return module;
}

async function runComradesFold(message) {
  const sequence = String(message.sequence || "").toUpperCase();
  const minimumLoop = normaliseMinimumLoop(message.minimumLoop);
  const temperature = normaliseTemperature(message.temperature);
  const evidenceArms = normaliseEvidenceArms(message.evidenceArms);
  const randomFoldCount = boundedInteger(message.randomFoldCount, 0, MAX_RANDOM_FOLDS, 0, "Random-fold count");
  const constraintLimit = boundedInteger(message.constraintLimit, 1, 75, 75, "Constraint count");
  const seed = String(message.seed || "RNAxRay-Web").slice(0, 128);

  validateSequence(sequence);
  if (!evidenceArms.length) {
    throw new Error("No forward-strand HYB records are fully contained in the selected reference region layout.");
  }

  const comrades = getComradesCore();
  postProgress("Loading ViennaRNA RNAcofold engine", 4, { phase: "engine" });
  const engine = await getEngine();
  const startedAt = Date.now();
  const mappedPairs = [];
  let cofoldsWithIntermolecularPairs = 0;

  for (let index = 0; index < evidenceArms.length; index += 1) {
    const job = evidenceArms[index];
    const cofold = cofoldWithVienna(engine, job.sequenceOne, job.sequenceTwo, temperature, minimumLoop);
    const mapped = comrades.mapCofoldPairs(job, cofold.pairs);
    if (mapped.length) {
      cofoldsWithIntermolecularPairs += 1;
      mappedPairs.push.apply(mappedPairs, mapped);
    }
    if (index === evidenceArms.length - 1 || index % Math.max(1, Math.floor(evidenceArms.length / 80)) === 0) {
      postProgress(
        "RNAcofold evidence " + (index + 1) + " / " + evidenceArms.length,
        8 + Math.round(((index + 1) / evidenceArms.length) * 30),
        { phase: "rna-cofold", completed: index + 1, total: evidenceArms.length }
      );
      await yieldToEventLoop();
    }
  }

  const allEvidence = comrades.aggregateEvidence(mappedPairs);
  const selectedEvidence = comrades.selectFragmentEvidence(allEvidence, 1, sequence.length);
  const stems = comrades.mergeTouchingStems(selectedEvidence);
  const stemConstraints = comrades.stemsToConstraints(stems, constraintLimit);
  if (!selectedEvidence.length || !stemConstraints.length) {
    throw new Error("RNAcofold did not produce a non-overlapping base-pair stem that can constrain the selected reference sequence.");
  }

  postProgress("Fitting ranked HYB-evidence constraints", 40, {
    phase: "ranked-constraints",
    evidencePairs: selectedEvidence.length,
    stems: stems.length,
    constraints: stemConstraints.length
  });
  const deterministic = await fitConstraintOrder(
    engine,
    comrades,
    sequence,
    stemConstraints,
    temperature,
    minimumLoop,
    function (completed, total) {
      postProgress("Fitting ranked constraint " + completed + " / " + total, 40 + Math.round((completed / total) * 18), {
        phase: "ranked-constraints", completed: completed, total: total
      });
    }
  );
  const candidates = [annotateComradesCandidate(deterministic, comrades, selectedEvidence, 0, false)];
  await yieldToEventLoop();

  for (let run = 1; run <= randomFoldCount; run += 1) {
    const shuffled = comrades.seededShuffle(stemConstraints, seed + ":" + run);
    const fitted = await fitConstraintOrder(engine, comrades, sequence, shuffled, temperature, minimumLoop);
    candidates.push(annotateComradesCandidate(fitted, comrades, selectedEvidence, run, true));
    postProgress("Randomised fold " + run + " / " + randomFoldCount, 60 + Math.round((run / Math.max(1, randomFoldCount)) * 32), {
      phase: "randomised-folds", completed: run, total: randomFoldCount
    });
    await yieldToEventLoop();
  }

  candidates.sort(compareCandidates);
  const best = candidates[0];
  const result = best.result;
  result.elapsedMs = Date.now() - startedAt;
  result.algorithm = "COMRADES(ViennaRNA)";
  result.model = "RNAcofold evidence frequencies; ranked stem constraints fitted greedily with ViennaRNA 2.7.2 global MFE; non-pseudoknotted structures";
  result.constraintMode = "hyb-guided";
  result.constraintSource = "hyb-rna-cofold-evidence";
  result.constraints = comrades.flattenConstraintPairs(best.accepted);
  result.constraintCount = result.constraints.length;
  result.acceptedStemConstraints = best.accepted.map(constraintSummary);
  result.rejectedStemConstraints = best.rejected;
  result.evidence = {
    inputRecords: evidenceArms.length,
    cofoldsWithIntermolecularPairs: cofoldsWithIntermolecularPairs,
    mappedPairObservations: mappedPairs.length,
    uniqueBasePairs: allEvidence.length,
    selectedBasePairs: selectedEvidence,
    rankedStems: stems,
    requestedStemConstraints: stemConstraints.length,
    evidenceLimit: comrades.originalEvidenceLimit,
    evidenceWeight: "one per eligible HYB row"
  };
  result.randomisation = {
    requestedFolds: randomFoldCount,
    completedFolds: randomFoldCount,
    seed: seed,
    includesRankedDeterministicFold: true,
    selectedRun: best.run,
    selectedRunWasRandomised: best.randomised,
    structures: candidates.map(candidateSummary)
  };

  postProgress("Preparing COMRADES evidence and ensemble result", 97, { phase: "complete" });
  self.postMessage({ type: "complete", result: result });
}

function getComradesCore() {
  if (!self.RNAxRayComrades) {
    try {
      importScripts(COMRADES_CORE_URL);
    } catch (error) {
      throw new Error("The HYB-guided evidence module could not be loaded.");
    }
  }
  if (!self.RNAxRayComrades) {
    throw new Error("The HYB-guided evidence module did not expose its analysis API.");
  }
  return self.RNAxRayComrades;
}

function normaliseEvidenceArms(value) {
  if (!Array.isArray(value)) {
    throw new Error("HYB-guided folding requires prepared RNA arm records.");
  }
  if (value.length > MAX_EVIDENCE_RECORDS) {
    throw new Error("This region contains more than " + MAX_EVIDENCE_RECORDS + " eligible HYB rows. Select a smaller region before running RNAcofold evidence generation.");
  }
  return value.map(function (job, index) {
    const sequenceOne = String(job && job.sequenceOne || "").toUpperCase();
    const sequenceTwo = String(job && job.sequenceTwo || "").toUpperCase();
    const oneStart = Number(job && job.oneStart);
    const twoStart = Number(job && job.twoStart);
    if (!sequenceOne || !sequenceTwo || /[^ACGU]/.test(sequenceOne + sequenceTwo)) {
      throw new Error("Prepared HYB arm " + (index + 1) + " contains an invalid RNA sequence.");
    }
    if (sequenceOne.length + sequenceTwo.length > MAX_SEQUENCE_LENGTH) {
      throw new Error("Prepared HYB arm " + (index + 1) + " is too long for browser RNAcofold.");
    }
    if (!Number.isSafeInteger(oneStart) || !Number.isSafeInteger(twoStart) || oneStart < 1 || twoStart < 1) {
      throw new Error("Prepared HYB arm " + (index + 1) + " has invalid reference coordinates.");
    }
    return {
      recordId: String(job.recordId || ""),
      recordIndex: Number(job.recordIndex),
      sequenceOne: sequenceOne,
      sequenceTwo: sequenceTwo,
      oneStart: oneStart,
      oneEnd: oneStart + sequenceOne.length - 1,
      twoStart: twoStart,
      twoEnd: twoStart + sequenceTwo.length - 1,
      reversedFromHyb: !!job.reversedFromHyb
    };
  });
}

function cofoldWithVienna(engine, sequenceOne, sequenceTwo, temperature, minimumLoop) {
  const onePointer = allocateString(engine, sequenceOne);
  const twoPointer = allocateString(engine, sequenceTwo);
  const structureBytes = sequenceOne.length + sequenceTwo.length + 1;
  const structurePointer = engine._malloc(structureBytes);
  if (!structurePointer) {
    engine._free(twoPointer);
    engine._free(onePointer);
    throw new Error("ViennaRNA WebAssembly could not allocate enough memory for RNAcofold.");
  }
  try {
    const energy = engine._rnaxray_vienna_cofold(
      onePointer,
      twoPointer,
      temperature,
      minimumLoop,
      structurePointer,
      structureBytes
    );
    const dotBracket = engine.UTF8ToString(structurePointer);
    const combined = sequenceOne + sequenceTwo;
    if (!Number.isFinite(energy) || dotBracket.length !== combined.length || !/^[.()]+$/.test(dotBracket)) {
      throw new Error("ViennaRNA RNAcofold returned an invalid two-strand structure.");
    }
    return {
      energy: Number(energy),
      dotBracket: dotBracket,
      pairs: dotBracketPairs(combined, dotBracket)
    };
  } finally {
    engine._free(structurePointer);
    engine._free(twoPointer);
    engine._free(onePointer);
  }
}

function allocateString(engine, value) {
  const bytes = engine.lengthBytesUTF8(value) + 1;
  const pointer = engine._malloc(bytes);
  if (!pointer) {
    throw new Error("ViennaRNA WebAssembly could not allocate RNA sequence memory.");
  }
  engine.stringToUTF8(value, pointer, bytes);
  return pointer;
}

async function fitConstraintOrder(engine, comrades, sequence, orderedConstraints, temperature, minimumLoop, progress) {
  const accepted = [];
  const rejected = [];
  let result = null;
  for (let index = 0; index < orderedConstraints.length; index += 1) {
    const candidate = orderedConstraints[index];
    const proposed = accepted.concat([candidate]);
    const validation = comrades.validateConstraintSet(proposed, sequence, minimumLoop);
    if (!validation.valid) {
      rejected.push({ id: candidate.id, rank: candidate.rank, reason: validation.reason });
    } else {
      try {
        result = foldWithVienna(engine, sequence, temperature, minimumLoop, validation.pairs);
        accepted.push(candidate);
      } catch (error) {
        rejected.push({ id: candidate.id, rank: candidate.rank, reason: "vienna-incompatible" });
      }
    }
    if (progress) {
      progress(index + 1, orderedConstraints.length);
    }
    if (index % 5 === 0) {
      await yieldToEventLoop();
    }
  }
  if (!result) {
    result = foldWithVienna(engine, sequence, temperature, minimumLoop, []);
  }
  return { result: result, accepted: accepted, rejected: rejected };
}

function annotateComradesCandidate(fitted, comrades, evidence, run, randomised) {
  const score = comrades.scoreStructurePairs(fitted.result.pairs, evidence, fitted.result.dotBracket.length);
  fitted.result.pairs = score.pairs;
  fitted.result.nucleotideSupport = score.nucleotideSupport;
  fitted.result.maximumNucleotideSupport = score.maximumNucleotideSupport;
  fitted.result.matchedEvidencePairs = score.matchedPairs;
  fitted.result.matchedPairSupport = score.matchedPairSupport;
  fitted.result.comradesScore = score.comradesScore;
  return {
    result: fitted.result,
    accepted: fitted.accepted,
    rejected: fitted.rejected,
    run: run,
    randomised: randomised
  };
}

function compareCandidates(left, right) {
  return right.result.comradesScore - left.result.comradesScore ||
    right.result.matchedEvidencePairs - left.result.matchedEvidencePairs ||
    left.result.energy - right.result.energy ||
    left.run - right.run;
}

function constraintSummary(constraint) {
  return {
    id: constraint.id,
    rank: constraint.rank,
    left: constraint.left,
    right: constraint.right,
    length: constraint.length,
    support: constraint.support
  };
}

function candidateSummary(candidate) {
  return {
    run: candidate.run,
    randomised: candidate.randomised,
    energy: candidate.result.energy,
    comradesScore: candidate.result.comradesScore,
    matchedEvidencePairs: candidate.result.matchedEvidencePairs,
    acceptedStemConstraints: candidate.accepted.map(function (constraint) { return constraint.id; }),
    rejectedStemConstraints: candidate.rejected.length,
    dotBracket: candidate.result.dotBracket
  };
}

function postProgress(stage, percent, details) {
  self.postMessage({
    type: "progress",
    stage: stage,
    percent: Math.max(0, Math.min(99, Number(percent) || 0)),
    details: details || null
  });
}

function boundedInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(label + " must be a whole number from " + minimum + " to " + maximum + ".");
  }
  return parsed;
}

function foldWithVienna(engine, sequence, temperature, minimumLoop, constraints) {
  const sequenceBytes = engine.lengthBytesUTF8(sequence) + 1;
  const structureBytes = sequence.length + 1;
  const constraintBytes = constraints.length * 2 * Uint32Array.BYTES_PER_ELEMENT;
  const sequencePointer = engine._malloc(sequenceBytes);
  const structurePointer = engine._malloc(structureBytes);
  const constraintPointer = constraintBytes ? engine._malloc(constraintBytes) : 0;

  if (!sequencePointer || !structurePointer || (constraintBytes && !constraintPointer)) {
    if (sequencePointer) {
      engine._free(sequencePointer);
    }
    if (structurePointer) {
      engine._free(structurePointer);
    }
    if (constraintPointer) {
      engine._free(constraintPointer);
    }
    throw new Error("ViennaRNA WebAssembly could not allocate enough browser memory for this sequence.");
  }

  try {
    engine.stringToUTF8(sequence, sequencePointer, sequenceBytes);
    if (constraints.length) {
      writeConstraintBuffer(engine, constraintPointer, constraints);
    }

    const energy = constraints.length
      ? engine._rnaxray_vienna_mfe_constrained(
          sequencePointer,
          temperature,
          minimumLoop,
          constraintPointer,
          constraints.length,
          structurePointer,
          structureBytes
        )
      : engine._rnaxray_vienna_mfe(sequencePointer, temperature, minimumLoop, structurePointer, structureBytes);

    if (!Number.isFinite(energy)) {
      throw new Error(constraints.length
        ? "ViennaRNA could not calculate an MFE structure that satisfies all requested base-pair constraints."
        : "ViennaRNA could not calculate an MFE structure for this sequence and parameter set.");
    }
    const dotBracket = engine.UTF8ToString(structurePointer);
    if (dotBracket.length !== sequence.length || !/^[.()]+$/.test(dotBracket)) {
      throw new Error("ViennaRNA returned an invalid dot-bracket structure.");
    }

    const pairs = dotBracketPairs(sequence, dotBracket);
    assertConstraintsPresent(pairs, constraints);
    const version = engine.UTF8ToString(engine._rnaxray_vienna_version());

    return {
      algorithm: constraints.length ? "ViennaRNA constrained global MFE" : "ViennaRNA global MFE",
      model: constraints.length
        ? "Turner 2004 nearest-neighbour energy parameters; global non-pseudoknotted secondary structure with caller-supplied hard base-pair constraints"
        : "Turner 2004 nearest-neighbour energy parameters; global non-pseudoknotted secondary structure",
      engine: "ViennaRNA",
      engineVersion: version || "2.7.2",
      temperature: temperature,
      minimumLoop: minimumLoop,
      energy: Number(energy),
      energyUnit: "kcal/mol",
      pairs: pairs,
      dotBracket: dotBracket,
      unpaired: sequence.length - pairs.length * 2,
      constraintMode: constraints.length ? "hard-base-pairs" : "none",
      constraintCount: constraints.length,
      constraints: constraints.map(function (constraint) {
        return { left: constraint.left, right: constraint.right };
      })
    };
  } finally {
    if (constraintPointer) {
      engine._free(constraintPointer);
    }
    engine._free(structurePointer);
    engine._free(sequencePointer);
  }
}

function writeConstraintBuffer(engine, pointer, constraints) {
  if (!engine.HEAPU32 || typeof engine.HEAPU32.set !== "function") {
    throw new Error("ViennaRNA WebAssembly does not expose the memory view required for base-pair constraints.");
  }

  const flat = new Uint32Array(constraints.length * 2);
  constraints.forEach(function (constraint, index) {
    flat[index * 2] = constraint.left;
    flat[index * 2 + 1] = constraint.right;
  });
  engine.HEAPU32.set(flat, pointer >>> 2);
}

function assertConstraintsPresent(pairs, constraints) {
  const observed = new Set(pairs.map(function (pair) { return pair.left + ":" + pair.right; }));
  constraints.forEach(function (constraint) {
    if (!observed.has(constraint.left + ":" + constraint.right)) {
      throw new Error("ViennaRNA returned a structure that does not contain every requested base-pair constraint.");
    }
  });
}

function dotBracketPairs(sequence, dotBracket) {
  const stack = [];
  const pairs = [];

  for (let index = 0; index < dotBracket.length; index += 1) {
    const symbol = dotBracket.charAt(index);
    if (symbol === "(") {
      stack.push(index);
      continue;
    }
    if (symbol === ")") {
      const left = stack.pop();
      if (left === undefined) {
        throw new Error("ViennaRNA returned an unmatched closing base pair.");
      }
      const right = index;
      const leftBase = sequence.charAt(left);
      const rightBase = sequence.charAt(right);
      pairs.push({
        left: left + 1,
        right: right + 1,
        leftBase: leftBase,
        rightBase: rightBase,
        type: leftBase + "–" + rightBase
      });
    }
  }

  if (stack.length) {
    throw new Error("ViennaRNA returned an unmatched opening base pair.");
  }

  return pairs.sort(function (first, second) { return first.left - second.left; });
}

function validateSequence(sequence) {
  if (!sequence) {
    throw new Error("Choose a non-empty RNA sequence first.");
  }
  if (sequence.length > MAX_SEQUENCE_LENGTH) {
    throw new Error("ViennaRNA WebAssembly supports sequences up to " + MAX_SEQUENCE_LENGTH + " nt in RNAxRay Web.");
  }
  if (/[^ACGU]/.test(sequence)) {
    throw new Error("ViennaRNA folding accepts only A, C, G and U in this workspace.");
  }
}

function normaliseConstraints(value, sequence, minimumLoop) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Base-pair constraints must be supplied as an array of {left, right} coordinates.");
  }
  if (value.length > Math.floor(sequence.length / 2)) {
    throw new Error("There cannot be more base-pair constraints than half the sequence length.");
  }

  const endpoints = new Set();
  const constraints = value.map(function (item, index) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !Number.isInteger(item.left) || !Number.isInteger(item.right)) {
      throw new Error("Constraint " + (index + 1) + " must contain integer left and right coordinates.");
    }

    const left = item.left;
    const right = item.right;
    if (left < 1 || right < 1 || left >= right || right > sequence.length) {
      throw new Error("Constraint " + (index + 1) + " must use 1-based coordinates with 1 <= left < right <= sequence length.");
    }
    if (right - left - 1 < minimumLoop) {
      throw new Error("Constraint " + (index + 1) + " violates the selected minimum loop size.");
    }
    if (endpoints.has(left) || endpoints.has(right)) {
      throw new Error("Constraint " + (index + 1) + " reuses a nucleotide that already has a constrained partner.");
    }

    const bases = sequence.charAt(left - 1) + sequence.charAt(right - 1);
    if (!["AU", "UA", "CG", "GC", "GU", "UG"].includes(bases)) {
      throw new Error("Constraint " + (index + 1) + " is not an A-U, G-C or G-U base pair.");
    }

    endpoints.add(left);
    endpoints.add(right);
    return { left: left, right: right };
  }).sort(function (first, second) {
    return first.left - second.left;
  });

  for (let first = 0; first < constraints.length; first += 1) {
    for (let second = first + 1; second < constraints.length; second += 1) {
      if (constraints[first].left < constraints[second].left &&
          constraints[second].left < constraints[first].right &&
          constraints[first].right < constraints[second].right) {
        throw new Error("Base-pair constraints must not cross because the MFE result is non-pseudoknotted dot-bracket.");
      }
    }
  }

  return constraints;
}

function normaliseMinimumLoop(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 12 ? parsed : 3;
}

function normaliseTemperature(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 37;
}

function yieldToEventLoop() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

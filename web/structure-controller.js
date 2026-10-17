(function () {
  "use strict";

  const MAX_SEQUENCE_LENGTH = 3000;
  const ADVANCED_SEQUENCE_LENGTH = 2000;
  const CPLFOLD_BASELINE_SEQUENCE_LENGTH = 75;
  const CPLFOLD_HARD_MAX_SEQUENCE_LENGTH = 500;
  const CPLFOLD_CAPACITY_PROBE_LENGTH = 75;
  const CPLFOLD_CAPACITY_TARGET_MS = 45000;
  const CPLFOLD_CAPACITY_SAFETY_FACTOR = 0.65;
  const CPLFOLD_CAPACITY_TIMEOUT_MS = 60000;

  // Desktop only: the bundled Python runtime reports its own ceiling through
  // RNAxRayDesktop.limits.cplfoldMaxLength. The browser path always keeps 500.
  function nativeCplfoldActive() {
    const desktop = window.RNAxRayDesktop;
    return !!(desktop && desktop.enabled && desktop.capabilities &&
      desktop.capabilities.cplfoldNative === true &&
      typeof desktop.predictCplfold === "function");
  }

  function nativeCplfoldMaxLength() {
    const limits = window.RNAxRayDesktop && window.RNAxRayDesktop.limits;
    return positiveIntegerOrDefault(limits && limits.cplfoldMaxLength, CPLFOLD_HARD_MAX_SEQUENCE_LENGTH);
  }

  function currentCplfoldMaxLength() {
    return nativeCplfoldActive() ? nativeCplfoldMaxLength() : CPLFOLD_HARD_MAX_SEQUENCE_LENGTH;
  }

  function ensureCplfoldCapacity(structure) {
    if (!structure.cplfoldCapacity || typeof structure.cplfoldCapacity !== "object") {
      structure.cplfoldCapacity = {};
    }
    const capacity = structure.cplfoldCapacity;
    capacity.status = ["unknown", "probing", "ready", "error", "cancelled"].indexOf(capacity.status) === -1
      ? "unknown"
      : capacity.status;
    capacity.baselineLength = Math.min(
      CPLFOLD_HARD_MAX_SEQUENCE_LENGTH,
      positiveIntegerOrDefault(capacity.baselineLength, CPLFOLD_BASELINE_SEQUENCE_LENGTH)
    );
    capacity.hardCeiling = Math.max(
      capacity.baselineLength,
      Math.min(CPLFOLD_HARD_MAX_SEQUENCE_LENGTH, positiveIntegerOrDefault(capacity.hardCeiling, CPLFOLD_HARD_MAX_SEQUENCE_LENGTH))
    );
    capacity.recommendedLength = Math.max(
      capacity.baselineLength,
      Math.min(capacity.hardCeiling, positiveIntegerOrDefault(capacity.recommendedLength, capacity.baselineLength))
    );
    return capacity;
  }

  function positiveIntegerOrDefault(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  function cplfoldProfileKey(structure) {
    return [
      profileValue(structure.cplfoldEvidence, "hyb-blocks"),
      profileValue(structure.cplfoldBeam, "20"),
      profileValue(structure.cplfoldMaxPhase1, "3"),
      profileValue(structure.cplfoldEnergyDelta, "5"),
      profileValue(structure.cplfoldEnergyModel, "DP09").toUpperCase(),
      profileValue(structure.cplfoldAlpha, "0.5"),
      profileValue(structure.cplfoldBeta, "0"),
      profileValue(structure.cplfoldAllowPseudoknot, true) === "false" ? "nested" : "pseudoknot"
    ].join("|");
  }

  function profileValue(value, fallback) {
    return value === undefined || value === null || value === "" ? fallback : String(value);
  }

  function cplfoldCapacityMatches(structure) {
    const capacity = ensureCplfoldCapacity(structure);
    return capacity.status === "ready" && capacity.profileKey === cplfoldProfileKey(structure);
  }

  function cplfoldMaximumLength(structure) {
    const capacity = ensureCplfoldCapacity(structure);
    return cplfoldCapacityMatches(structure)
      ? capacity.recommendedLength
      : capacity.baselineLength;
  }

  function estimateCplfoldCapacity(sample) {
    const probeLength = Math.max(
      CPLFOLD_BASELINE_SEQUENCE_LENGTH,
      positiveIntegerOrDefault(sample && sample.length, CPLFOLD_CAPACITY_PROBE_LENGTH)
    );
    const foldElapsedMs = Number(sample && sample.foldElapsedMs);
    if (!Number.isFinite(foldElapsedMs) || foldElapsedMs <= 0) {
      return CPLFOLD_HARD_MAX_SEQUENCE_LENGTH;
    }
    const interactiveBudget = CPLFOLD_CAPACITY_TARGET_MS * CPLFOLD_CAPACITY_SAFETY_FACTOR;
    const estimate = probeLength * Math.sqrt(interactiveBudget / foldElapsedMs);
    const rounded = Math.floor(estimate / 25) * 25;
    return Math.max(
      CPLFOLD_BASELINE_SEQUENCE_LENGTH,
      Math.min(CPLFOLD_HARD_MAX_SEQUENCE_LENGTH, rounded)
    );
  }

  function cplfoldLengthIssue(length, structure) {
    if (nativeCplfoldActive()) {
      const nativeMax = nativeCplfoldMaxLength();
      return length > nativeMax
        ? "Desktop CPLfold is limited to " + nativeMax + " nt by the bundled runtime. Select a shorter region."
        : "";
    }
    const capacity = ensureCplfoldCapacity(structure || {});
    if (length > CPLFOLD_HARD_MAX_SEQUENCE_LENGTH) {
      return "Browser CPLfold has a hard safety ceiling of " + CPLFOLD_HARD_MAX_SEQUENCE_LENGTH + " nt in this pure-Python Pyodide build. Select a shorter region or use bin/cplfold locally.";
    }
    if (length <= capacity.baselineLength) {
      return "";
    }
    if (capacity.status === "probing") {
      return "The browser CPLfold capacity test is still running. Wait for it to finish or cancel it before predicting.";
    }
    if (capacity.status !== "ready") {
      return "This " + length + " nt CPLfold request is above the " + capacity.baselineLength + " nt browser baseline. Run the local browser capacity test first.";
    }
    if (!cplfoldCapacityMatches(structure)) {
      return "CPLfold settings changed after the last browser capacity test. Run the capacity test again before using a sequence longer than " + capacity.baselineLength + " nt.";
    }
    if (length > capacity.recommendedLength) {
      return "This browser capacity test recommends up to " + capacity.recommendedLength + " nt for the current CPLfold settings. Select a shorter region, reduce the search settings, or retest this browser.";
    }
    return "";
  }

  function readCplfoldParameters(structure) {
    const parameters = {
      beamSize: parseWholeNumber(structure.cplfoldBeam, 1, 200, "CPLfold beam size"),
      maxPhase1: parseWholeNumber(structure.cplfoldMaxPhase1, 1, 20, "Phase-1 candidate count"),
      energyDelta: parseBoundedNumber(structure.cplfoldEnergyDelta, 0, 50, "Energy delta"),
      alpha: parseBoundedNumber(structure.cplfoldAlpha, 0, 1, "Evidence alpha"),
      beta: parseBoundedNumber(structure.cplfoldBeta, 0, 1, "Pseudoknot beta"),
      allowPseudoknot: structure.cplfoldAllowPseudoknot !== false,
      energyModel: String(structure.cplfoldEnergyModel || "DP09").toUpperCase()
    };
    if (["DP03", "DP09", "CC06", "CC09", "RE"].indexOf(parameters.energyModel) === -1) {
      throw new Error("Choose a supported CPLfold energy model.");
    }
    return parameters;
  }

  function predict(state, api) {
    const structure = state.structure;
    const sequenceInfo = window.RNAxRayPages.getStructureSequence(state);
    const hybGuided = structure && structure.constraintMode === "hyb-guided";
    const cplfold = structure && structure.engine === "cplfold";
    const cplfoldGuided = cplfold && structure.cplfoldEvidence === "hyb-blocks";

    if (!structure || !sequenceInfo.sequence || sequenceInfo.error) {
      api.showToast(sequenceInfo.error || "Choose a valid RNA sequence first.");
      return false;
    }

    const lengthIssue = validateLength(sequenceInfo.sequence.length, structure.allowLarge, cplfold ? "cplfold" : "viennarna", structure);
    if (lengthIssue) {
      api.showToast(lengthIssue);
      return false;
    }

    let minimumLoop = null;
    let temperature = null;
    let cplfoldParameters = null;

    if (cplfold) {
      try {
        if (cplfoldGuided && (!sequenceInfo.assembly || !sequenceInfo.assembly.evidenceArms.length)) {
          throw new Error("No eligible forward-strand HYB records are fully contained in the selected reference region.");
        }
        cplfoldParameters = readCplfoldParameters(structure);
      } catch (error) {
        return rejectInput(structure, api, error, "The CPLfold parameters are invalid.");
      }
    } else {
      try {
        minimumLoop = parseMinimumLoop(structure.minimumLoop);
        temperature = parseTemperature(structure.temperature);
      } catch (error) {
        return rejectInput(structure, api, error, "The ViennaRNA folding parameters are invalid.");
      }
    }
    let constraints = [];
    let randomFoldCount = 0;
    let constraintLimit = 75;

    if (!cplfold && structure.constraintMode === "manual-hard-base-pairs") {
      try {
        constraints = parseManualConstraints(structure.constraintText, sequenceInfo.sequence, minimumLoop);
        if (!constraints.length) {
          throw new Error("Enter at least one base pair, or switch the folding mode back to plain MFE.");
        }
      } catch (error) {
        return rejectInput(structure, api, error, "The manual base-pair constraints are invalid.");
      }
    }
    if (!cplfold && hybGuided) {
      try {
        if (!sequenceInfo.assembly || !sequenceInfo.assembly.evidenceArms.length) {
          throw new Error("No eligible forward-strand HYB records are fully contained in the selected region layout.");
        }
        constraintLimit = parseWholeNumber(structure.constraintLimit, 1, 75, "Evidence stem constraints");
        randomFoldCount = parseWholeNumber(structure.randomFoldCount, 0, 1000, "Randomised folds");
        if (randomFoldCount > 100 && !structure.allowLargeEnsemble) {
          throw new Error("Confirm the large-ensemble warning before running more than 100 randomised folds.");
        }
        if (!String(structure.randomSeed || "").trim()) {
          throw new Error("Enter a reproducibility seed for randomised constraint ordering.");
        }
      } catch (error) {
        return rejectInput(structure, api, error, "The HYB-guided folding parameters are invalid.");
      }
    }

    cancel(state);

    const runId = (structure.runId || 0) + 1;
    structure.runId = runId;
    structure.status = "running";
    structure.operation = "prediction";
    structure.progress = 2;
    structure.message = cplfold
      ? "Starting pure-Python CPLfold in a local Pyodide worker…"
      : (hybGuided ? "Starting COMRADES(ViennaRNA)…" : "Starting ViennaRNA WebAssembly…");
    structure.result = null;
    structure.runningSequenceInfo = sequenceInfo;
    api.render();

    // Desktop uses the bundled Python/NumPy/Numba runtime for CPLfold. Keep
    // ViennaRNA and browser CPLfold on the worker path, and fall back to it
    // when a packaged runtime reports itself unavailable.
    if (cplfold && nativeCplfoldActive()) {
      const nativeRequest = {
        sequence: sequenceInfo.sequence,
        evidence_mode: cplfoldGuided ? "hyb-blocks" : "none",
        evidence_arms: cplfoldGuided ? sequenceInfo.assembly.evidenceArms : [],
        parameters: Object.assign({}, cplfoldParameters)
      };
      window.RNAxRayDesktop.predictCplfold(nativeRequest).then(function (nativeResult) {
        if (!state.structure || state.structure.runId !== runId) return;
        if (!nativeResult || nativeResult.status === "unavailable") {
          // Re-enter the browser path by clearing the native-only marker. The
          // worker request below is intentionally kept as the compatibility
          // fallback for development builds without a portable runtime.
          structure.message = "Native CPLfold is unavailable; using the browser worker…";
          structure.status = "idle";
          structure.operation = null;
          structure.runningSequenceInfo = null;
          api.render();
          window.RNAxRayDesktop.capabilities.cplfoldNative = false;
          predict(state, api);
          return;
        }
        if (nativeResult.ok === false) throw new Error(nativeResult.error || "Native CPLfold failed.");
        structure.runningSequenceInfo = null;
        structure.operation = null;
        structure.status = "complete";
        structure.progress = 100;
        structure.message = "CPLfold completed with the desktop bundled NumPy/Numba runtime.";
        structure.result = Object.assign({}, nativeResult, {
          completedAt: new Date().toISOString(),
          sequence: sequenceInfo.sequence,
          label: sequenceInfo.label,
          source: structure.source,
          sourceRna: structure.source === "reference" ? sequenceInfo.sourceRna : "",
          sourceStart: structure.source === "reference" ? sequenceInfo.sourceStart : null,
          sourceEnd: structure.source === "reference" ? sequenceInfo.sourceEnd : null,
          sourceSegments: sequenceInfo.sourceSegments || null,
          assembly: sequenceInfo.assembly ? {
            segments: sequenceInfo.assembly.segments,
            linker: sequenceInfo.assembly.linker,
            inputRecordCount: sequenceInfo.assembly.inputRecordCount,
            eligibleRecordCount: sequenceInfo.assembly.eligibleRecordCount,
            skipped: sequenceInfo.assembly.skipped,
            homodimerOnly: sequenceInfo.assembly.homodimerOnly
          } : null
        });
        api.render();
        api.showToast(structure.message);
      }).catch(function (error) {
        if (!state.structure || state.structure.runId !== runId) return;
        structure.runningSequenceInfo = null;
        structure.operation = null;
        structure.status = "error";
        structure.progress = 0;
        structure.message = error && error.message ? error.message : "Native CPLfold could not finish.";
        api.render();
      });
      return true;
    }

    try {
      const worker = cplfold
        ? new Worker((window.RNAXRAY_ASSET_BASE || "./") + "cplfold.worker.mjs?build=" + encodeURIComponent(window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit || "local"), { type: "module" })
        : new Worker((window.RNAXRAY_ASSET_BASE || "./") + "structure.worker.js");
      state.structureWorker = worker;

      worker.onmessage = function (event) {
        const message = event.data || {};
        if (!state.structure || state.structure.runId !== runId) {
          return;
        }

        if (message.type === "progress") {
          structure.progress = Math.max(0, Math.min(99, Number(message.percent) || 0));
          structure.message = message.stage || "Predicting minimum-free-energy structure…";
          api.render();
          return;
        }

        if (message.type === "complete") {
          finishWorker(state, worker);
          structure.runningSequenceInfo = null;
          structure.operation = null;
          const constraintCount = Math.max(0, Number(message.result && message.result.constraintCount) || 0);
          structure.status = "complete";
          structure.progress = 100;
          structure.message = message.result && message.result.engine === "CPLfold"
            ? "CPLfold completed locally with " + ((message.result.candidates || []).length) + " ranked candidate" + ((message.result.candidates || []).length === 1 ? "." : "s.")
            : message.result && message.result.constraintMode === "hyb-guided"
            ? "COMRADES(ViennaRNA) completed locally from " + (message.result.evidence ? message.result.evidence.inputRecords : 0) + " eligible HYB record" + ((message.result.evidence && message.result.evidence.inputRecords === 1) ? "." : "s.")
            : (constraintCount
              ? "ViennaRNA MFE structure predicted locally with " + constraintCount + " manual hard base-pair constraint" + (constraintCount === 1 ? "." : "s.")
              : "ViennaRNA MFE structure predicted locally.");
          structure.result = Object.assign({}, message.result || {}, {
            completedAt: new Date().toISOString(),
            sequence: sequenceInfo.sequence,
            label: sequenceInfo.label,
            source: structure.source,
            sourceRna: structure.source === "reference" ? sequenceInfo.sourceRna : "",
            sourceStart: structure.source === "reference" ? sequenceInfo.sourceStart : null,
            sourceEnd: structure.source === "reference" ? sequenceInfo.sourceEnd : null,
            sourceSegments: sequenceInfo.sourceSegments || null,
            assembly: sequenceInfo.assembly ? {
              segments: sequenceInfo.assembly.segments,
              linker: sequenceInfo.assembly.linker,
              inputRecordCount: sequenceInfo.assembly.inputRecordCount,
              eligibleRecordCount: sequenceInfo.assembly.eligibleRecordCount,
              skipped: sequenceInfo.assembly.skipped,
              homodimerOnly: sequenceInfo.assembly.homodimerOnly
            } : null
          });
          api.render();
          if (typeof window.CustomEvent === "function") {
            window.dispatchEvent(new window.CustomEvent("rnaxray:analysis-result", { detail: structure.result }));
          }
          api.showToast(structure.message);
          return;
        }

        if (message.type === "error") {
          finishWorker(state, worker);
          structure.runningSequenceInfo = null;
          structure.operation = null;
          structure.status = "error";
          structure.progress = 0;
          structure.message = message.message || (cplfold
            ? "Browser CPLfold could not finish the structure prediction."
            : "ViennaRNA WebAssembly could not finish the structure prediction.");
          api.render();
        }
      };

      worker.onerror = function () {
        if (!state.structure || state.structure.runId !== runId) {
          return;
        }
        finishWorker(state, worker);
        structure.runningSequenceInfo = null;
        structure.operation = null;
        structure.status = "error";
        structure.progress = 0;
        structure.message = cplfold
          ? "The browser CPLfold worker stopped unexpectedly. Confirm that the generated Pyodide assets are available."
          : "The ViennaRNA structure worker stopped unexpectedly.";
        api.render();
      };

      worker.postMessage(cplfold ? {
        type: "cplfold",
        sequence: sequenceInfo.sequence,
        evidenceMode: cplfoldGuided ? "hyb-blocks" : "none",
        evidenceArms: cplfoldGuided ? sequenceInfo.assembly.evidenceArms : [],
        beamSize: cplfoldParameters.beamSize,
        maxPhase1: cplfoldParameters.maxPhase1,
        energyDelta: cplfoldParameters.energyDelta,
        energyModel: cplfoldParameters.energyModel,
        alpha: cplfoldParameters.alpha,
        beta: cplfoldParameters.beta,
        allowPseudoknot: cplfoldParameters.allowPseudoknot,
        maxSequenceLength: cplfold ? cplfoldMaximumLength(structure) : undefined
      } : hybGuided ? {
        type: "comrades-fold",
        sequence: sequenceInfo.sequence,
        minimumLoop: minimumLoop,
        temperature: temperature,
        evidenceArms: sequenceInfo.assembly.evidenceArms,
        constraintLimit: constraintLimit,
        randomFoldCount: randomFoldCount,
        seed: String(structure.randomSeed).trim()
      } : {
        type: "fold",
        sequence: sequenceInfo.sequence,
        minimumLoop: minimumLoop,
        temperature: temperature,
        constraints: constraints
      });
      return true;
    } catch (error) {
      structure.status = "error";
      structure.progress = 0;
      structure.operation = null;
      structure.runningSequenceInfo = null;
      structure.message = error && error.message ? error.message : (cplfold
        ? "This browser cannot start the CPLfold module worker."
        : "This browser cannot start the ViennaRNA structure worker.");
      api.render();
      return false;
    }
  }

  function probeCplfoldCapacity(state, api) {
    const structure = state.structure;
    if (!structure || structure.engine !== "cplfold") {
      api.showToast("Select CPLfold before measuring browser capacity.");
      return false;
    }
    if (nativeCplfoldActive()) {
      structure.message = "The desktop bundled NumPy/CPLfold runtime does not require a browser capacity test.";
      api.render();
      api.showToast(structure.message);
      return false;
    }

    let parameters;
    try {
      parameters = readCplfoldParameters(structure);
    } catch (error) {
      return rejectInput(structure, api, error, "The CPLfold parameters are invalid.");
    }

    cancel(state);
    const capacity = ensureCplfoldCapacity(structure);
    const runId = (structure.runId || 0) + 1;
    const profileKey = cplfoldProfileKey(structure);
    structure.runId = runId;
    structure.status = "running";
    structure.operation = "capacity";
    structure.progress = 2;
    structure.message = "Measuring this browser's local CPLfold capacity…";
    capacity.status = "probing";
    capacity.profileKey = profileKey;
    capacity.probeLength = CPLFOLD_CAPACITY_PROBE_LENGTH;
    capacity.foldElapsedMs = null;
    capacity.elapsedMs = null;
    capacity.runtimeLoadMs = null;
    capacity.testedAt = null;
    capacity.hardware = null;
    capacity.message = "";
    api.render();

    let worker;
    try {
      worker = new Worker((window.RNAXRAY_ASSET_BASE || "./") + "cplfold.worker.mjs?build=" + encodeURIComponent(window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit || "local"), { type: "module" });
      state.structureWorker = worker;
    } catch (error) {
      return failCapacityProbe(state, null, runId, api, error && error.message
        ? error.message
        : "This browser cannot start the CPLfold capacity worker.");
    }

    worker.onmessage = function (event) {
      const message = event.data || {};
      if (!state.structure || state.structure.runId !== runId) {
        return;
      }
      if (message.type === "progress") {
        const progress = Math.max(0, Math.min(99, Number(message.percent) || 0));
        structure.progress = progress;
        capacity.progress = progress;
        structure.message = message.stage || "Measuring browser CPLfold capacity…";
        api.render();
        return;
      }
      if (message.type === "capacity-complete") {
        clearCapacityTimeout(state);
        finishWorker(state, worker);
        const sample = message.sample || {};
        const recommendedLength = estimateCplfoldCapacity(sample);
        capacity.status = "ready";
        capacity.recommendedLength = recommendedLength;
        capacity.probeLength = positiveIntegerOrDefault(sample.length, CPLFOLD_CAPACITY_PROBE_LENGTH);
        capacity.foldElapsedMs = Number(sample.foldElapsedMs) || null;
        capacity.elapsedMs = Number(message.elapsedMs || sample.elapsedMs) || null;
        capacity.runtimeLoadMs = Number(message.runtimeLoadMs) || null;
        capacity.testedAt = new Date().toISOString();
        capacity.hardware = message.hardware || null;
        capacity.runtimeManifest = message.runtimeManifest || null;
        capacity.parameters = message.parameters || null;
        capacity.message = "Estimated up to " + recommendedLength + " nt for the current browser and CPLfold settings.";
        structure.status = "idle";
        structure.operation = null;
        structure.progress = 0;
        structure.message = capacity.message;
        api.render();
        api.showToast(capacity.message);
        return;
      }
      if (message.type === "error") {
        failCapacityProbe(state, worker, runId, api, message.message || "The browser CPLfold capacity test could not finish.");
      }
    };

    worker.onerror = function () {
      failCapacityProbe(state, worker, runId, api, "The browser CPLfold capacity worker stopped unexpectedly. Confirm that the generated Pyodide assets are available.");
    };

    const schedule = typeof window.setTimeout === "function"
      ? window.setTimeout.bind(window)
      : (typeof setTimeout === "function" ? setTimeout : null);
    if (schedule) {
      capacity.timeoutId = schedule(function () {
        if (state.structure && state.structure.runId === runId) {
          failCapacityProbe(state, worker, runId, api, "The browser CPLfold capacity test exceeded 60 seconds and was stopped. The 75 nt baseline remains available.");
        }
      }, CPLFOLD_CAPACITY_TIMEOUT_MS);
    }

    try {
      worker.postMessage({
        type: "cplfold-capacity",
        probeLength: CPLFOLD_CAPACITY_PROBE_LENGTH,
        evidenceMode: structure.cplfoldEvidence === "hyb-blocks" ? "hyb-blocks" : "none",
        beamSize: parameters.beamSize,
        maxPhase1: parameters.maxPhase1,
        energyDelta: parameters.energyDelta,
        energyModel: parameters.energyModel,
        alpha: parameters.alpha,
        beta: parameters.beta,
        allowPseudoknot: parameters.allowPseudoknot
      });
    } catch (error) {
      return failCapacityProbe(state, worker, runId, api, error && error.message
        ? error.message
        : "The browser CPLfold capacity worker could not receive the probe request.");
    }
    return true;
  }

  function downloadCplfoldBonusMatrix(state, api, sequenceInfo, onComplete) {
    const structure = state.structure;
    if (!structure || structure.engine !== "cplfold") {
      api.showToast("Select CPLfold before downloading a bonus matrix.");
      return false;
    }
    if (structure.status === "running") {
      api.showToast("Wait for the current CPLfold operation to finish or cancel it first.");
      return false;
    }

    const prepared = sequenceInfo || window.RNAxRayPages.getStructureSequence(state);
    if (!prepared || prepared.error || !prepared.sequence) {
      api.showToast(prepared && prepared.error ? prepared.error : "Choose a valid sequence first.");
      return false;
    }
    if (!prepared.assembly || !Array.isArray(prepared.assembly.evidenceArms) || !prepared.assembly.evidenceArms.length) {
      api.showToast("No eligible HYB rows are available for a CPLfold bonus matrix.");
      return false;
    }

    const previousStatus = structure.result ? "complete" : "idle";
    const previousMessage = structure.message;
    const runId = (structure.runId || 0) + 1;
    structure.runId = runId;
    structure.status = "running";
    structure.operation = "bonus-matrix";
    structure.progress = 2;
    structure.message = "Preparing the CPLfold HYB bonus matrix for download…";
    structure.runningSequenceInfo = prepared;
    api.render();

    let worker;
    try {
      worker = new Worker((window.RNAXRAY_ASSET_BASE || "./") + "cplfold.worker.mjs?build=" + encodeURIComponent(window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit || "local"), { type: "module" });
      state.structureWorker = worker;
    } catch (error) {
      structure.status = "error";
      structure.operation = null;
      structure.progress = 0;
      structure.runningSequenceInfo = null;
      structure.message = error && error.message ? error.message : "This browser cannot start the CPLfold bonus-matrix worker.";
      api.render();
      api.showToast(structure.message);
      return false;
    }

    worker.onmessage = function (event) {
      const message = event.data || {};
      if (!state.structure || state.structure.runId !== runId) {
        return;
      }
      if (message.type === "progress") {
        structure.progress = Math.max(0, Math.min(99, Number(message.percent) || 0));
        structure.message = message.stage || "Preparing the CPLfold bonus matrix…";
        api.render();
        return;
      }
      if (message.type === "bonus-matrix-complete") {
        finishWorker(state, worker);
        structure.status = previousStatus;
        structure.operation = null;
        structure.progress = 0;
        structure.message = previousMessage;
        structure.runningSequenceInfo = null;
        api.render();
        if (typeof onComplete === "function") {
          onComplete(message.result);
        }
        return;
      }
      if (message.type === "error") {
        finishWorker(state, worker);
        structure.status = "error";
        structure.operation = null;
        structure.progress = 0;
        structure.runningSequenceInfo = null;
        structure.message = message.message || "The CPLfold bonus matrix could not be prepared.";
        api.render();
        api.showToast(structure.message);
      }
    };

    worker.onerror = function () {
      if (!state.structure || state.structure.runId !== runId) {
        return;
      }
      finishWorker(state, worker);
      structure.status = "error";
      structure.operation = null;
      structure.progress = 0;
      structure.runningSequenceInfo = null;
      structure.message = "The CPLfold bonus-matrix worker stopped unexpectedly. Confirm that the generated Pyodide assets are available.";
      api.render();
      api.showToast(structure.message);
    };

    try {
      worker.postMessage({
        type: "cplfold-bonus-matrix",
        sequence: prepared.sequence,
        evidenceMode: "hyb-blocks",
        evidenceArms: prepared.assembly.evidenceArms
      });
    } catch (error) {
      finishWorker(state, worker);
      structure.status = "error";
      structure.operation = null;
      structure.progress = 0;
      structure.runningSequenceInfo = null;
      structure.message = error && error.message ? error.message : "The CPLfold bonus-matrix worker could not receive the request.";
      api.render();
      api.showToast(structure.message);
      return false;
    }
    return true;
  }

  function failCapacityProbe(state, worker, runId, api, message) {
    if (!state.structure || state.structure.runId !== runId) {
      return false;
    }
    clearCapacityTimeout(state);
    if (worker) {
      finishWorker(state, worker);
    }
    const structure = state.structure;
    const capacity = ensureCplfoldCapacity(structure);
    structure.runId = (structure.runId || 0) + 1;
    capacity.status = "error";
    capacity.recommendedLength = capacity.baselineLength;
    capacity.message = message;
    structure.status = "idle";
    structure.operation = null;
    structure.progress = 0;
    structure.message = message;
    api.render();
    api.showToast(message);
    return false;
  }

  function clearCapacityTimeout(state) {
    const structure = state.structure;
    const capacity = structure && structure.cplfoldCapacity;
    if (!capacity || capacity.timeoutId == null) {
      return;
    }
    if (typeof window.clearTimeout === "function") {
      window.clearTimeout(capacity.timeoutId);
    } else if (typeof clearTimeout === "function") {
      clearTimeout(capacity.timeoutId);
    }
    capacity.timeoutId = null;
  }

  function parseMinimumLoop(value) {
    if (value === undefined) {
      return 3;
    }
    if ((typeof value !== "string" && typeof value !== "number") ||
        (typeof value === "string" && value.trim() === "")) {
      throw new Error("Minimum hairpin loop must be a whole number from 0 to 12.");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 12) {
      throw new Error("Minimum hairpin loop must be a whole number from 0 to 12.");
    }
    return parsed;
  }

  function parseTemperature(value) {
    if (value === undefined) {
      return 37;
    }
    if ((typeof value !== "string" && typeof value !== "number") ||
        (typeof value === "string" && value.trim() === "")) {
      throw new Error("Folding temperature must be a number from 0 to 100 °C.");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      throw new Error("Folding temperature must be a number from 0 to 100 °C.");
    }
    return parsed;
  }

  function parseWholeNumber(value, minimum, maximum, label) {
    if ((typeof value !== "string" && typeof value !== "number") ||
        (typeof value === "string" && value.trim() === "")) {
      throw new Error(label + " must be a whole number from " + minimum + " to " + maximum + ".");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(label + " must be a whole number from " + minimum + " to " + maximum + ".");
    }
    return parsed;
  }

  function parseBoundedNumber(value, minimum, maximum, label) {
    if ((typeof value !== "string" && typeof value !== "number") ||
        (typeof value === "string" && value.trim() === "")) {
      throw new Error(label + " must be a number from " + minimum + " to " + maximum + ".");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(label + " must be a number from " + minimum + " to " + maximum + ".");
    }
    return parsed;
  }

  function rejectInput(structure, api, error, fallback) {
    structure.status = "error";
    structure.progress = 0;
    structure.message = error && error.message ? error.message : fallback;
    api.render();
    api.showToast(structure.message);
    return false;
  }

  function parseManualConstraints(value, sequence, minimumLoop) {
    const text = String(value || "");
    const rna = String(sequence || "");
    const loop = parseMinimumLoop(minimumLoop);

    if (text.length > 100000) {
      throw new Error("The manual constraint input is too large.");
    }

    const entries = text.split(/\r?\n/).map(function (line, index) {
      return { text: line.trim(), line: index + 1 };
    }).filter(function (entry) {
      return entry.text.length > 0;
    });

    if (entries.length > Math.floor(rna.length / 2)) {
      throw new Error("There cannot be more constrained pairs than half the sequence length.");
    }

    const endpoints = new Set();
    const constraints = entries.map(function (entry) {
      const match = entry.text.match(/^([1-9][0-9]*)\s*-\s*([1-9][0-9]*)$/);
      if (!match) {
        throw new Error("Constraint line " + entry.line + " must contain exactly one pair in i-j format, for example 4-18.");
      }

      const left = Number(match[1]);
      const right = Number(match[2]);
      if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
        throw new Error("Constraint line " + entry.line + " contains a coordinate outside JavaScript's safe integer range.");
      }
      if (left >= right || right > rna.length) {
        throw new Error("Constraint line " + entry.line + " must satisfy 1 <= i < j <= " + rna.length + ".");
      }
      if (right - left - 1 < loop) {
        throw new Error("Constraint line " + entry.line + " violates the selected minimum hairpin loop of " + loop + ".");
      }
      if (endpoints.has(left) || endpoints.has(right)) {
        throw new Error("Constraint line " + entry.line + " reuses a nucleotide that already has a constrained partner.");
      }

      const pairType = rna.charAt(left - 1) + rna.charAt(right - 1);
      if (["AU", "UA", "CG", "GC", "GU", "UG"].indexOf(pairType) === -1) {
        throw new Error("Constraint line " + entry.line + " is not an A-U, G-C or G-U base pair in the prepared sequence.");
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
          throw new Error("Manual base-pair constraints must not cross because ViennaRNA returns a non-pseudoknotted dot-bracket structure.");
        }
      }
    }

    return constraints;
  }

  function validateLength(length, allowLarge, engine, structure) {
    if (engine === "cplfold") {
      return cplfoldLengthIssue(length, structure || {});
    }
    if (length > MAX_SEQUENCE_LENGTH) {
      return "ViennaRNA WebAssembly is limited to " + MAX_SEQUENCE_LENGTH + " nt in RNAxRay Web. Reduce this region before folding.";
    }
    if (length > ADVANCED_SEQUENCE_LENGTH && !allowLarge) {
      return "This " + length + " nt sequence can use substantial browser memory. Enable the advanced large-region option before continuing.";
    }
    return "";
  }

  function reset(state, options) {
    cancel(state);
    if (!state.structure) {
      return;
    }
    const settings = options || {};
    state.structure.status = "idle";
    state.structure.operation = null;
    state.structure.progress = 0;
    state.structure.message = "";
    state.structure.result = null;
    state.structure.runningSequenceInfo = null;
    state.structure.selectedNucleotide = null;
    if (settings.clearConstraints) {
      state.structure.constraintText = "";
      state.structure.allowLarge = false;
    }
  }

  function cancel(state) {
    const structure = state.structure;
    const capacity = structure && structure.cplfoldCapacity;
    const wasCapacityProbe = structure && structure.status === "running" && structure.operation === "capacity";
    clearCapacityTimeout(state);
    if (state.structureWorker) {
      state.structureWorker.terminate();
      state.structureWorker = null;
    }
    if (structure && structure.status === "running") {
      structure.runId = (structure.runId || 0) + 1;
      structure.status = "idle";
      structure.operation = null;
      structure.progress = 0;
      structure.message = "";
      structure.runningSequenceInfo = null;
      if (wasCapacityProbe && capacity) {
        capacity.status = "cancelled";
        capacity.recommendedLength = capacity.baselineLength || CPLFOLD_BASELINE_SEQUENCE_LENGTH;
        capacity.message = "Browser capacity test cancelled. The " + (capacity.baselineLength || CPLFOLD_BASELINE_SEQUENCE_LENGTH) + " nt baseline remains available.";
      }
    }
  }

  function finishWorker(state, worker) {
    worker.terminate();
    if (state.structureWorker === worker) {
      state.structureWorker = null;
    }
  }

  window.RNAxRayStructure = {
    maxSequenceLength: MAX_SEQUENCE_LENGTH,
    advancedSequenceLength: ADVANCED_SEQUENCE_LENGTH,
    cplfoldBaselineSequenceLength: CPLFOLD_BASELINE_SEQUENCE_LENGTH,
    cplfoldHardSequenceLength: CPLFOLD_HARD_MAX_SEQUENCE_LENGTH,
    get cplfoldMaxSequenceLength() {
      return currentCplfoldMaxLength();
    },
    validateLength: validateLength,
    estimateCplfoldCapacity: estimateCplfoldCapacity,
    parseManualConstraints: parseManualConstraints,
    predict: predict,
    probeCplfoldCapacity: probeCplfoldCapacity,
    downloadCplfoldBonusMatrix: downloadCplfoldBonusMatrix,
    reset: reset,
    cancel: cancel,
    terminate: cancel
  };
}());

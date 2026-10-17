(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  // Results already brought into view (selecting a candidate changes the
  // result in place, so it is not revealed again).
  const revealedResults = typeof WeakSet === "function" ? new WeakSet() : null;
  let diagramObserver = null;
  let fornaContainer = null;

  function afterRender(state, api) {
    if (diagramObserver) {
      diagramObserver.disconnect();
      diagramObserver = null;
    }
    fornaContainer = null;
    const result = state.structure && state.structure.result;
    const target = document.querySelector("[data-structure-diagram]");
    if (!result || !target) {
      return;
    }

    const viewMode = structureViewMode(state.structure.viewMode);
    state.structure.viewMode = viewMode;
    if (viewMode === "folded") {
      renderFornaDiagram(target, result);
    } else {
      target.replaceChildren(buildStructureDiagram(result, state.structure.selectedNucleotide, viewMode));
      bindNucleotideMarkers(target, state, api);
    }
    observeDiagramSize(target);
    if (revealedResults && !revealedResults.has(result)) {
      revealedResults.add(result);
      revealNewResult(result);
    }
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // E5 + E7: a new result folds the setup to its summary line, brings the
  // result heading into view (no smooth scroll under reduced motion), moves
  // focus to that heading so screen readers announce it, and says the
  // headline numbers in the live region.
  function revealNewResult(result) {
    window.RNAxRayOpenSections = window.RNAxRayOpenSections || Object.create(null);
    window.RNAxRayOpenSections["structure-setup"] = false;
    const setup = document.querySelector(".structure-setup-panel");
    if (setup) {
      setup.open = false;
    }
    const heading = document.getElementById("structure-result-heading");
    const reveal = function () {
      if (!heading || !heading.isConnected) {
        return;
      }
      if (typeof heading.scrollIntoView === "function") {
        heading.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      }
      if (typeof heading.focus === "function") {
        heading.focus({ preventScroll: true });
      }
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(reveal);
    } else {
      reveal();
    }
    const live = document.querySelector("[data-structure-announce]");
    if (live) {
      const summary = "Structure ready · " + formatEnergyText(result.energy) + " kcal/mol · " + (result.pairs || []).length + " pair" + ((result.pairs || []).length === 1 ? "" : "s");
      setTimeout(function () {
        if (live.isConnected) {
          live.textContent = summary;
        }
      }, 150);
    }
  }

  function formatEnergyText(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(1).replace("-", "\u2212") : "—";
  }

  // E6: the diagram follows its container's width (window resize, setup
  // folded or opened). The SVG views scale by themselves; fornac needs
  // setSize. Redraws are throttled to one per frame after the size settles.
  function observeDiagramSize(target) {
    if (typeof ResizeObserver !== "function") {
      return;
    }
    let lastWidth = target.clientWidth;
    let timer = null;
    diagramObserver = new ResizeObserver(function () {
      const width = target.clientWidth;
      if (Math.abs(width - lastWidth) < 2) {
        return;
      }
      lastWidth = width;
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (fornaContainer && typeof fornaContainer.setSize === "function") {
          try {
            fornaContainer.setSize();
          } catch (error) {
            // a failed resize keeps the previous layout
          }
        }
      }, 120);
    });
    diagramObserver.observe(target);
  }

  function renderFornaDiagram(target, result) {
    target.replaceChildren();
    if (!window.fornac || typeof window.fornac.FornaContainer !== "function") {
      const unavailable = document.createElement("p");
      unavailable.className = "structure-render-error";
      unavailable.textContent = "The fornac RNA renderer is unavailable. Select Arc to inspect this structure.";
      target.appendChild(unavailable);
      return;
    }
    const mount = document.createElement("div");
    mount.id = "forna-structure-" + Math.random().toString(36).slice(2);
    mount.className = "forna-structure-mount";
    target.appendChild(mount);
    // fornac gives its mount tabindex=1 and focuses it while constructing,
    // which scrolled the page to the diagram and took focus from the
    // control the user had pressed. Ignore that focus call and put the
    // mount back in normal tab order.
    mount.focus = function () {};
    try {
      const container = new window.fornac.FornaContainer("#" + mount.id, {
        animation: false,
        zoomable: true,
        initialSize: [Math.max(320, target.clientWidth || 760), Math.max(320, target.clientHeight || 560)],
        labelInterval: result.sequence.length <= 200 ? 10 : 25
      });
      delete mount.focus;
      mount.setAttribute("tabindex", "0");
      container.addRNA(result.dotBracket, {
        sequence: result.sequence,
        name: result.label || (result.engine === "CPLfold" ? "CPLfold" : "ViennaRNA")
      });
      container.setSize();
      fornaContainer = container;
    } catch (error) {
      target.replaceChildren();
      const failed = document.createElement("p");
      failed.className = "structure-render-error";
      failed.textContent = "fornac could not lay out this structure. Select Arc or Matrix to inspect all base pairs.";
      target.appendChild(failed);
    }
  }

  function handleAction(action, state, api, element) {
    if (action === "predict-structure") {
      if (!window.RNAxRayStructure) {
        api.showToast("The local structure predictor is unavailable in this browser.");
        return true;
      }
      window.RNAxRayStructure.predict(state, api);
      return true;
    }

    if (action === "probe-cplfold-capacity") {
      if (!window.RNAxRayStructure || typeof window.RNAxRayStructure.probeCplfoldCapacity !== "function") {
        api.showToast("The local CPLfold capacity test is unavailable in this browser.");
        return true;
      }
      window.RNAxRayStructure.probeCplfoldCapacity(state, api);
      return true;
    }

    if (action === "cancel-structure") {
      const capacityProbe = state.structure && state.structure.operation === "capacity";
      const bonusMatrixExport = state.structure && state.structure.operation === "bonus-matrix";
      if (window.RNAxRayStructure) {
        window.RNAxRayStructure.cancel(state);
      }
      api.render();
      api.showToast(capacityProbe
        ? "Browser CPLfold capacity test cancelled."
        : (bonusMatrixExport ? "CPLfold local input export cancelled." : "Local structure prediction cancelled."));
      return true;
    }

    if (action === "set-structure-view") {
      const viewMode = structureViewMode(element && element.dataset && element.dataset.viewMode);
      if (!state.structure) {
        return true;
      }
      state.structure.viewMode = viewMode;
      api.render();
      return true;
    }

    if (action === "download-local-cplfold-input") {
      return downloadLocalCplfoldInput(state, api);
    }

    const result = state.structure && state.structure.result;
    if (action === "select-cplfold-candidate") {
      const candidateIndex = Number(element && element.dataset && element.dataset.candidateIndex);
      if (!result || result.engine !== "CPLfold" || !selectCplfoldCandidate(result, candidateIndex)) {
        api.showToast("That CPLfold candidate is unavailable.");
        return true;
      }
      state.structure.selectedNucleotide = null;
      api.render();
      // only when the diagram is off screen
      const revealDiagram = function () {
        if (typeof document === "undefined") {
          return;
        }
        const diagram = document.querySelector("[data-structure-diagram]");
        if (!diagram || typeof diagram.scrollIntoView !== "function") {
          return;
        }
        const box = typeof diagram.getBoundingClientRect === "function" ? diagram.getBoundingClientRect() : null;
        const visible = box && box.bottom > 80 && box.top < (window.innerHeight || 0) - 80;
        if (!visible) {
          diagram.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
        }
      };
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(revealDiagram);
      } else {
        revealDiagram();
      }
      api.showToast("CPLfold candidate " + (candidateIndex + 1) + " selected.");
      return true;
    }
    if (!result || [
      "copy-structure-dot-bracket",
      "download-structure-dot-bracket",
      "download-structure-ct",
      "download-structure-pairs",
      "download-structure-evidence",
      "download-structure-constraints",
      "download-structure-ensemble",
      "download-cplfold-evidence",
      "download-cplfold-candidates",
      "download-structure-svg",
      "download-structure-png",
      "download-structure-report"
    ].indexOf(action) === -1) {
      return false;
    }

    if (action === "copy-structure-dot-bracket") {
      api.copyText(result.dotBracket, "Dot-bracket notation copied to the clipboard.");
      return true;
    }

    if (action === "download-structure-dot-bracket") {
      api.download("rna-secondary-structure.dbn", dotBracketFile(result), "text/plain");
      api.showToast("Dot-bracket file downloaded locally.");
      return true;
    }

    if (action === "download-structure-ct") {
      api.download("rna-secondary-structure.ct", ctFile(result), "text/plain");
      api.showToast("CT file downloaded locally.");
      return true;
    }

    if (action === "download-structure-pairs") {
      api.download("rna-secondary-structure-pairs.tsv", basePairTsv(result), "text/tab-separated-values");
      api.showToast("Base-pair table downloaded locally.");
      return true;
    }

    if (action === "download-structure-evidence") {
      api.download("rna-cofold-evidence.tsv", evidenceTsv(result), "text/tab-separated-values");
      api.showToast("RNAcofold evidence table downloaded locally.");
      return true;
    }

    if (action === "download-structure-constraints") {
      api.download("hyb-guided-folding-constraints.tsv", constraintsTsv(result), "text/tab-separated-values");
      api.showToast("Fitted stem constraints downloaded locally.");
      return true;
    }

    if (action === "download-structure-ensemble") {
      api.download("hyb-guided-structure-ensemble.tsv", ensembleTsv(result), "text/tab-separated-values");
      api.showToast("Randomised structure ensemble downloaded locally.");
      return true;
    }

    if (action === "download-cplfold-evidence") {
      api.download("cplfold-bonus-matrix.tsv", cplfoldEvidenceTsv(result), "text/tab-separated-values");
      api.showToast("CPLfold HYB bonus matrix downloaded locally.");
      return true;
    }

    if (action === "download-cplfold-candidates") {
      api.download("cplfold-candidates.tsv", cplfoldCandidatesTsv(result), "text/tab-separated-values");
      api.showToast("CPLfold candidates downloaded locally.");
      return true;
    }

    if (action === "download-structure-svg") {
      const svg = lightExportSvg(state);
      if (!svg) {
        api.showToast("The structure diagram is not ready to export yet.");
        return true;
      }
      const viewMode = structureViewMode(state.structure && state.structure.viewMode);
      api.download("rna-secondary-structure-" + structureViewFileStem(viewMode) + ".svg", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" + new XMLSerializer().serializeToString(svg), "image/svg+xml");
      api.showToast("Structure SVG downloaded locally.");
      return true;
    }

    if (action === "download-structure-png") {
      downloadStructurePng(api, structureViewMode(state.structure && state.structure.viewMode), lightExportSvg(state));
      return true;
    }

    api.download("rna-secondary-structure-report.json", JSON.stringify(structureReport(state, result), null, 2), "application/json");
    api.showToast("Structure report downloaded locally.");
    return true;
  }

  function downloadLocalCplfoldInput(state, api) {
    if (!state.structure || state.structure.engine !== "cplfold") {
      api.showToast("Select CPLfold before downloading a local input.");
      return true;
    }

    const result = state.structure.result;
    const prepared = window.RNAxRayPages && typeof window.RNAxRayPages.getStructureSequence === "function"
      ? window.RNAxRayPages.getStructureSequence(state)
      : null;
    const sequence = prepared && prepared.sequence
      ? prepared.sequence
      : (result && result.sequence ? result.sequence : "");
    if (!sequence) {
      api.showToast("Choose a valid sequence first.");
      return true;
    }

    const guided = state.structure.cplfoldEvidence === "hyb-blocks";
    if (prepared && prepared.error) {
      api.showToast(prepared.error);
      return true;
    }

    api.download(
      "cplfold-input.fasta",
      ">RNAXRAY_Web_prepared_sequence\n" + sequence + "\n",
      "text/plain"
    );

    const hasPreparedArms = prepared && prepared.assembly && Array.isArray(prepared.assembly.evidenceArms) && prepared.assembly.evidenceArms.length > 0;
    const hasResultMatrix = result && result.evidence && result.evidence.source === "hyb-block-intervals" && Array.isArray(result.evidence.bonusEntries);
    if (!guided || (!hasPreparedArms && !hasResultMatrix)) {
      api.showToast("CPLfold FASTA downloaded. Run: " + localCplfoldCommand(state.structure, false));
      return true;
    }

    if (hasResultMatrix) {
      api.download("cplfold-bonus-matrix.tsv", cplfoldEvidenceTsv(result), "text/tab-separated-values");
      api.showToast("CPLfold local inputs downloaded. Run: " + localCplfoldCommand(state.structure, true));
      return true;
    }

    if (!window.RNAxRayStructure || typeof window.RNAxRayStructure.downloadCplfoldBonusMatrix !== "function") {
      api.showToast("The local CPLfold bonus-matrix exporter is unavailable in this browser.");
      return true;
    }
    api.showToast("FASTA downloaded. Preparing the CPLfold HYB bonus matrix…");
    window.RNAxRayStructure.downloadCplfoldBonusMatrix(state, api, prepared, function (matrixResult) {
      api.download("cplfold-bonus-matrix.tsv", cplfoldEvidenceTsv(matrixResult), "text/tab-separated-values");
      api.showToast("CPLfold local inputs downloaded. Run: " + localCplfoldCommand(state.structure, true));
    });
    return true;
  }

  function localCplfoldCommand(structure, guided) {
    const command = [
      "bin/cplfold",
      "--sequence-file",
      "cplfold-input.fasta"
    ];
    if (guided) {
      command.push("--bonus-matrix-file", "cplfold-bonus-matrix.tsv");
    }
    command.push(
      "--beam", profileValue(structure && structure.cplfoldBeam, "20"),
      "--delta", profileValue(structure && structure.cplfoldEnergyDelta, "5"),
      "--max-phase1", profileValue(structure && structure.cplfoldMaxPhase1, "3"),
      "--max-phase2", "1",
      "--model", profileValue(structure && structure.cplfoldEnergyModel, "DP09").toUpperCase(),
      "--beta", profileValue(structure && structure.cplfoldBeta, "0")
    );
    if (guided) {
      command.push("--alpha", profileValue(structure && structure.cplfoldAlpha, "0.5"));
    }
    if (structure && structure.cplfoldAllowPseudoknot === false) {
      command.push("--no-pseudoknot");
    }
    return command.join(" ");
  }

  function selectCplfoldCandidate(result, index) {
    const candidates = result.candidates || [];
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      return false;
    }
    const candidate = candidates[index];
    result.selectedCandidate = index;
    result.dotBracket = candidate.dotBracket;
    result.pairs = candidate.pairs || [];
    result.unpaired = candidate.unpaired;
    result.energy = candidate.energy;
    result.effectiveEnergy = candidate.effectiveEnergy;
    result.phase1Energy = candidate.phase1Energy;
    result.phase1Structure = candidate.phase1Structure;
    result.phase2Structure = candidate.phase2Structure;
    result.score = candidate.score;
    result.structureType = candidate.type;
    result.topology = candidate.topology;
    result.crossingPairs = candidate.crossingPairs;
    return true;
  }

  function structureReport(state, result) {
    const constraintCount = Math.max(0, Number(result.constraintCount) || 0);
    const guided = result.constraintMode === "hyb-guided";
    const cplfold = result.engine === "CPLfold";
    const cplfoldAllowsPseudoknot = cplfold && resultAllowsPseudoknot(result);
    const allowPseudoknot = resultAllowsPseudoknot(result);
    const capacity = cplfold && state.structure && state.structure.cplfoldCapacity
      ? state.structure.cplfoldCapacity
      : null;
    const baselineLength = capacity && Number.isInteger(Number(capacity.baselineLength))
      ? Number(capacity.baselineLength)
      : 75;
    const hardCeiling = capacity && Number.isInteger(Number(capacity.hardCeiling))
      ? Number(capacity.hardCeiling)
      : 500;
    const capacityMatches = capacity && capacity.status === "ready" && capacity.profileKey === cplfoldProfileKey(state.structure);
    const recommendedLength = capacityMatches
      ? Math.max(baselineLength, Math.min(hardCeiling, Number(capacity.recommendedLength) || baselineLength))
      : (result.maxSequenceLength || baselineLength);
    const selectedCandidateIndex = cplfold ? Math.max(0, Number(result.selectedCandidate) || 0) : null;
    return {
      application: "RNAxRay Web",
      version: "0.5.0",
      buildCommit: window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit || null,
      generatedLocally: true,
      sourceHyb: {
        fileName: state.summary.fileName,
        fileSize: state.summary.fileSize == null ? null : state.summary.fileSize,
        sha256: state.summary.sha256 || null,
        sha256Status: state.summary.sha256
          ? "available"
          : (state.summary.sha256Unavailable ? "unavailable" : "pending")
      },
      sourceFasta: result.source === "reference" && state.reference ? {
        fileName: state.reference.fileName,
        fileSize: state.reference.fileSize == null ? null : state.reference.fileSize,
        sha256: state.reference.sha256 || null,
        sha256Status: state.reference.sha256
          ? "available"
          : (state.reference.sha256Unavailable ? "unavailable" : "pending")
      } : null,
      source: {
        label: result.label,
        type: result.source,
        sequence: result.sequence,
        rna: result.sourceRna || null,
        start: result.sourceStart == null ? null : result.sourceStart,
        end: result.sourceEnd == null ? null : result.sourceEnd,
        segments: result.sourceSegments || null,
        assembly: result.assembly || null
      },
      prediction: {
        algorithm: result.algorithm,
        model: result.model,
        engine: result.engine,
        engineVersion: result.engineVersion,
        bridgeVersion: cplfold ? result.bridgeVersion : null,
        runtime: cplfold ? result.runtime : null,
        temperatureCelsius: result.temperature,
        minimumLoop: result.minimumLoop,
        mfe: cplfold ? null : result.energy,
        energy: result.energy,
        effectiveEnergy: cplfold ? result.effectiveEnergy : null,
        phase1Energy: cplfold ? result.phase1Energy : null,
        phase1Structure: cplfold ? result.phase1Structure : null,
        phase2Structure: cplfold ? result.phase2Structure : null,
        linearFoldScore: cplfold ? result.score : null,
        energyUnit: result.energyUnit || "kcal/mol",
        constraintMode: result.constraintMode || "none",
        constraintSource: result.constraintSource || (constraintCount ? "manual-user-input" : "none"),
        constraintCount: constraintCount,
        constraints: result.constraints || [],
        dotBracket: result.dotBracket,
        pairs: result.pairs,
        elapsedMs: result.elapsedMs,
        runtimeLoadMs: cplfold ? result.runtimeLoadMs : null,
        foldElapsedMs: cplfold ? result.foldElapsedMs : null,
        browserRequestMaximumLength: cplfold ? result.maxSequenceLength || null : null,
        comradesScore: guided ? result.comradesScore : null,
        matchedEvidencePairs: guided ? result.matchedEvidencePairs : null,
        structureType: cplfold ? result.structureType : null,
        topology: cplfold ? result.topology : "nested",
        crossingPairs: cplfold ? result.crossingPairs : 0,
        pseudoknotAllowed: cplfold ? allowPseudoknot : false,
        selectedCandidateIndex: selectedCandidateIndex,
        selectedCandidateRank: cplfold ? selectedCandidateIndex + 1 : null,
        evidenceMode: cplfold ? result.evidenceMode : null,
        evidenceSource: cplfold ? result.evidenceSource : null
      },
      visualization: {
        viewMode: structureViewMode(state.structure && state.structure.viewMode)
      },
      hybGuidedEvidence: guided ? result.evidence : null,
      cplfoldEvidence: cplfold ? result.evidence : null,
      cplfoldParameters: cplfold ? result.parameters : null,
      cplfoldCandidates: cplfold ? result.candidates : null,
      randomisation: guided ? result.randomisation : null,
      acceptedStemConstraints: guided ? result.acceptedStemConstraints : null,
      rejectedStemConstraints: guided ? result.rejectedStemConstraints : null,
      methodScope: {
        manualHardBasePairsApplied: !guided && !cplfold && constraintCount > 0,
        automaticHybEvidenceConstraintGeneration: guided,
        automaticRnaCofoldEvidenceSelection: guided,
        iterativeCompatibleConstraintFitting: guided,
        randomisedConstraintOrderFolding: guided && !!(result.randomisation && result.randomisation.completedFolds),
        supportBasedStructureScoring: guided,
        cplfoldPurePythonBrowserExecution: cplfold,
        cplfoldPseudoknotPrediction: cplfold && allowPseudoknot,
        cplfoldPseudoknotSearchRequested: cplfold ? allowPseudoknot : false,
        cplfoldHybBlockBonusMatrix: cplfold && result.evidenceSource === "hyb-block-bonus-matrix",
        numbaJitAvailable: cplfold ? false : null,
        browserCplfoldMaximumLength: cplfold ? recommendedLength : null,
        browserCplfoldBaselineLength: cplfold ? baselineLength : null,
        browserCplfoldHardCeiling: cplfold ? hardCeiling : null,
        browserCplfoldCapacity: cplfold ? capacity : null,
        unafoldExecution: "external-cli-only",
        note: cplfold
          ? (allowPseudoknot
            ? "The browser ran the vendored pure-Python CPLfold two-phase algorithm in Pyodide. HYB-guided runs transform prepared arm intervals with the CPLfold IRIS-style Gaussian, symmetric outer-product and log1p bonus pipeline. Numba JIT is unavailable; the browser uses a local capacity probe to estimate a session-specific length up to its hard safety ceiling."
            : "The browser ran vendored pure-Python CPLfold Phase 1 in pseudoknot-free mode. Phase 2 was skipped, so no crossing pairs were searched; HYB-guided runs still use the IRIS-style Gaussian, symmetric outer-product and log1p bonus pipeline.")
          : guided
          ? "The browser reproduced the ViennaRNA RNAxRay post-HYB chain: per-row RNAcofold evidence, ranked stem construction, greedy compatible hard-constraint fitting, optional seeded randomised folds, and COMRADES support scoring."
          : constraintCount
          ? "The listed hard base pairs were entered manually by the user and enforced by ViennaRNA before MFE folding. They were not inferred from HYB or RNAcofold evidence."
          : "This is an unconstrained ViennaRNA global MFE fold. No HYB or RNAcofold evidence-derived constraints were generated."
      }
    };
  }

  function resultAllowsPseudoknot(result) {
    return !!result && result.allowPseudoknot !== false &&
      !(result.parameters && result.parameters.allowPseudoknot === false);
  }

  function cplfoldProfileKey(structure) {
    return [
      profileValue(structure && structure.cplfoldEvidence, "hyb-blocks"),
      profileValue(structure && structure.cplfoldBeam, "20"),
      profileValue(structure && structure.cplfoldMaxPhase1, "3"),
      profileValue(structure && structure.cplfoldEnergyDelta, "5"),
      profileValue(structure && structure.cplfoldEnergyModel, "DP09").toUpperCase(),
      profileValue(structure && structure.cplfoldAlpha, "0.5"),
      profileValue(structure && structure.cplfoldBeta, "0"),
      profileValue(structure && structure.cplfoldAllowPseudoknot, true) === "false" ? "nested" : "pseudoknot"
    ].join("|");
  }

  function profileValue(value, fallback) {
    return value === undefined || value === null || value === "" ? fallback : String(value);
  }

  function structureViewMode(value) {
    return ["folded", "arc", "radial", "circular", "matrix"].indexOf(value) > -1 ? value : "folded";
  }

  function structureViewFileStem(viewMode) {
    return structureViewMode(viewMode) === "arc" ? "arcs" : structureViewMode(viewMode);
  }

  function buildStructureDiagram(result, selectedNucleotide, viewMode) {
    switch (structureViewMode(viewMode)) {
      case "radial":
        return buildRadialDiagram(result, selectedNucleotide);
      case "circular":
        return buildCircularDiagram(result, selectedNucleotide);
      case "matrix":
        return buildMatrixDiagram(result, selectedNucleotide);
      default:
        return buildArcDiagram(result, selectedNucleotide);
    }
  }

  function buildArcDiagram(result, selectedNucleotide) {
    const width = 920;
    const height = 300;
    const left = 42;
    const right = width - 28;
    const baseline = 244;
    const sequence = result.sequence || "";
    const length = sequence.length || 1;
    const colors = colorTokens();
    const guided = result.constraintMode === "hyb-guided";
    const cplfold = result.engine === "CPLfold";
    const cplfoldAllowsPseudoknot = cplfold && resultAllowsPseudoknot(result);
    const cplfoldEvidence = cplfold && result.evidence && result.evidence.source === "hyb-block-intervals";
    const maximumEvidence = Math.max(0, Number(cplfoldEvidence ? result.evidence.maximumBonus : result.maximumNucleotideSupport) || 0);
    const hardPairs = new Set((result.constraints || []).map(function (pair) {
      return pair.left + ":" + pair.right;
    }));
    const svg = element("svg", {
      xmlns: SVG_NS,
      viewBox: "0 0 " + width + " " + height,
      width: "100%",
      height: "300",
      role: "img",
      "aria-label": "Arc diagram for " + length + " nucleotide RNA secondary structure"
    });

    svg.appendChild(element("title", {}, cplfold
      ? (cplfoldAllowsPseudoknot ? "Selected CPLfold RNA structure with pseudoknot layers" : "Selected CPLfold pseudoknot-free RNA structure")
      : "Predicted non-crossing RNA base pairs"));
    svg.appendChild(element("rect", { x: 0, y: 0, width: width, height: height, rx: 8, fill: colors.surface }));
    svg.appendChild(element("line", { x1: left, y1: baseline, x2: right, y2: baseline, stroke: colors.line, "stroke-width": 1.5 }));

    (result.pairs || []).forEach(function (pair) {
      const hardConstraint = hardPairs.has(pair.left + ":" + pair.right);
      const start = xFor(pair.left, length, left, right);
      const end = xFor(pair.right, length, left, right);
      const center = (start + end) / 2;
      const span = Math.max(1, pair.right - pair.left);
      const lift = Math.min(195, 24 + Math.sqrt(span / length) * 190);
      const path = element("path", {
        d: "M " + start.toFixed(2) + " " + baseline + " Q " + center.toFixed(2) + " " + (baseline - lift).toFixed(2) + " " + end.toFixed(2) + " " + baseline,
        fill: "none",
        stroke: cplfold ? cplfoldPairColor(pair, colors) : (guided ? evidenceColor(Number(pair.evidenceSupport) || 0, maximumEvidence, colors) : pairColor(pair.type, colors)),
        "stroke-width": cplfold && pair.layer !== "primary" ? 3 : (hardConstraint ? 3.7 : (guided && Number(pair.evidenceSupport) > 0 ? 2.5 : (pair.type === "G–C" || pair.type === "C–G" ? 2.1 : 1.6))),
        "stroke-linecap": "round",
        opacity: cplfoldEvidence
          ? Math.max(0.32, Math.min(0.96, 0.32 + (Number(pair.evidenceSupport) || 0) / Math.max(maximumEvidence, 1e-12) * 0.64))
          : (guided && !Number(pair.evidenceSupport) ? 0.34 : 0.9)
      });
      path.appendChild(element("title", {}, (cplfold
        ? (pair.layer || "primary") + " CPLfold pair: "
        : (hardConstraint ? (guided ? "HYB-fitted hard pair: " : "Manual hard pair: ") : "MFE pair: ")) + pair.left + " " + pair.leftBase + " paired with " + pair.right + " " + pair.rightBase + " (" + pair.type + ")" + (guided ? "; RNAcofold evidence " + (Number(pair.evidenceSupport) || 0) : (cplfoldEvidence ? "; HYB bonus " + (Number(pair.evidenceSupport) || 0).toFixed(4) : ""))));
      svg.appendChild(path);
    });

    markerTicks(svg, result, length, left, right, baseline, colors, selectedNucleotide);
    legend(svg, colors, result);
    return svg;
  }

  function buildRadialDiagram(result, selectedNucleotide) {
    const width = 680;
    const height = 650;
    const centerX = 340;
    const centerY = 324;
    const radius = 224;
    const sequence = result.sequence || "";
    const length = Math.max(1, sequence.length);
    const colors = colorTokens();
    const pairs = result.pairs || [];
    const svg = structureSvg(width, height, "Radial diagram for " + length + " nucleotide RNA secondary structure", result.engine === "CPLfold" ? "Selected CPLfold radial structure" : "Predicted radial RNA secondary structure", colors);
    const hardPairs = structureHardPairs(result);

    [0.25, 0.5, 0.75].forEach(function (ratio) {
      svg.appendChild(element("circle", {
        cx: centerX,
        cy: centerY,
        r: (radius * ratio).toFixed(2),
        fill: "none",
        stroke: colors.line,
        "stroke-width": 1,
        "stroke-dasharray": "2 5",
        opacity: 0.8
      }));
    });
    svg.appendChild(element("circle", {
      cx: centerX,
      cy: centerY,
      r: radius,
      fill: "none",
      stroke: colors.lineStrong,
      "stroke-width": 1.5
    }));

    pairs.forEach(function (pair) {
      const start = circlePoint(pair.left, length, centerX, centerY, radius);
      const end = circlePoint(pair.right, length, centerX, centerY, radius);
      const depth = pairDepth(pair, pairs);
      const pull = Math.max(0.16, 0.64 - Math.min(depth, 9) * 0.045);
      const midpointX = (start.x + end.x) / 2;
      const midpointY = (start.y + end.y) / 2;
      const controlX = centerX + (midpointX - centerX) * pull;
      const controlY = centerY + (midpointY - centerY) * pull;
      const style = structurePairStyle(result, pair, colors, hardPairs);
      const path = element("path", {
        d: "M " + start.x.toFixed(2) + " " + start.y.toFixed(2) + " Q " + controlX.toFixed(2) + " " + controlY.toFixed(2) + " " + end.x.toFixed(2) + " " + end.y.toFixed(2),
        fill: "none",
        stroke: style.stroke,
        "stroke-width": style.strokeWidth,
        "stroke-linecap": "round",
        "stroke-dasharray": style.dash,
        opacity: style.opacity
      });
      path.appendChild(element("title", {}, structurePairTitle(result, pair, style)));
      svg.appendChild(path);
    });

    appendSelectedRingRay(svg, length, centerX, centerY, radius, selectedNucleotide, colors);
    appendCircularTicks(svg, length, centerX, centerY, radius, colors);
    appendRingMarkers(svg, result, selectedNucleotide, centerX, centerY, radius, colors);
    legend(svg, colors, result, { x: 44, y: 24 });
    return svg;
  }

  function buildCircularDiagram(result, selectedNucleotide) {
    const width = 680;
    const height = 650;
    const centerX = 340;
    const centerY = 324;
    const radius = 224;
    const sequence = result.sequence || "";
    const length = Math.max(1, sequence.length);
    const colors = colorTokens();
    const pairs = result.pairs || [];
    const svg = structureSvg(width, height, "Circular diagram for " + length + " nucleotide RNA secondary structure", result.engine === "CPLfold" ? "Selected CPLfold circular structure" : "Predicted circular RNA secondary structure", colors);
    const hardPairs = structureHardPairs(result);

    svg.appendChild(element("circle", {
      cx: centerX,
      cy: centerY,
      r: radius,
      fill: "none",
      stroke: colors.lineStrong,
      "stroke-width": 2
    }));
    svg.appendChild(element("circle", {
      cx: centerX,
      cy: centerY,
      r: radius - 13,
      fill: "none",
      stroke: colors.line,
      "stroke-width": 1,
      "stroke-dasharray": "1 5"
    }));

    pairs.forEach(function (pair) {
      const start = circlePoint(pair.left, length, centerX, centerY, radius - 4);
      const end = circlePoint(pair.right, length, centerX, centerY, radius - 4);
      const style = structurePairStyle(result, pair, colors, hardPairs);
      const chord = element("line", {
        x1: start.x.toFixed(2),
        y1: start.y.toFixed(2),
        x2: end.x.toFixed(2),
        y2: end.y.toFixed(2),
        stroke: style.stroke,
        "stroke-width": style.strokeWidth,
        "stroke-linecap": "round",
        "stroke-dasharray": style.dash,
        opacity: style.opacity
      });
      chord.appendChild(element("title", {}, structurePairTitle(result, pair, style)));
      svg.appendChild(chord);
    });

    appendSelectedRingRay(svg, length, centerX, centerY, radius, selectedNucleotide, colors);
    appendCircularTicks(svg, length, centerX, centerY, radius, colors);
    appendRingMarkers(svg, result, selectedNucleotide, centerX, centerY, radius, colors);
    legend(svg, colors, result, { x: 44, y: 24 });
    return svg;
  }

  function buildMatrixDiagram(result, selectedNucleotide) {
    const width = 760;
    const height = 560;
    const plotLeft = 104;
    const plotTop = 62;
    const plotSize = 390;
    const plotBottom = plotTop + plotSize;
    const sequence = result.sequence || "";
    const length = Math.max(1, sequence.length);
    const colors = colorTokens();
    const pairs = result.pairs || [];
    const svg = structureSvg(width, height, "Base-pair matrix for " + length + " nucleotide RNA secondary structure", result.engine === "CPLfold" ? "Selected CPLfold base-pair matrix" : "Predicted RNA base-pair matrix", colors);
    const hardPairs = structureHardPairs(result);

    svg.appendChild(element("rect", {
      x: plotLeft,
      y: plotTop,
      width: plotSize,
      height: plotSize,
      fill: colors.surface,
      stroke: colors.lineStrong,
      "stroke-width": 1.2
    }));
    svg.appendChild(element("line", {
      x1: plotLeft,
      y1: plotTop,
      x2: plotLeft + plotSize,
      y2: plotBottom,
      stroke: colors.line,
      "stroke-width": 1,
      "stroke-dasharray": "3 5"
    }));
    appendMatrixTicks(svg, length, plotLeft, plotTop, plotSize, colors);

    pairs.forEach(function (pair) {
      const first = matrixPoint(pair.left, pair.right, length, plotLeft, plotTop, plotSize);
      const second = matrixPoint(pair.right, pair.left, length, plotLeft, plotTop, plotSize);
      const style = structurePairStyle(result, pair, colors, hardPairs);
      const point = element("circle", {
        cx: first.x.toFixed(2),
        cy: first.y.toFixed(2),
        r: length <= 180 ? 4 : 3,
        fill: style.stroke,
        stroke: colors.surface,
        "stroke-width": 0.8,
        opacity: style.opacity
      });
      point.appendChild(element("title", {}, structurePairTitle(result, pair, style) + " · matrix point"));
      svg.appendChild(point);
      if (pair.left !== pair.right) {
        const mirror = element("circle", {
          cx: second.x.toFixed(2),
          cy: second.y.toFixed(2),
          r: length <= 180 ? 4 : 3,
          fill: style.stroke,
          stroke: colors.surface,
          "stroke-width": 0.8,
          opacity: style.opacity
        });
        mirror.appendChild(element("title", {}, structurePairTitle(result, pair, style) + " · mirrored matrix point"));
        svg.appendChild(mirror);
      }
    });

    const selected = Number(selectedNucleotide);
    if (Number.isInteger(selected) && selected >= 1 && selected <= length) {
      const selectedX = matrixScale(selected, length, plotLeft, plotSize);
      const selectedY = matrixScale(selected, length, plotTop, plotSize);
      svg.appendChild(element("line", { x1: selectedX, y1: plotTop, x2: selectedX, y2: plotBottom, stroke: colors.accent, "stroke-width": 1.2, opacity: 0.55 }));
      svg.appendChild(element("line", { x1: plotLeft, y1: selectedY, x2: plotLeft + plotSize, y2: selectedY, stroke: colors.accent, "stroke-width": 1.2, opacity: 0.55 }));
    }
    appendMatrixPositionControls(svg, result, selectedNucleotide, plotLeft, plotBottom + 36, plotSize, colors);
    svg.appendChild(element("text", { x: plotLeft + plotSize / 2, y: height - 8, fill: colors.muted, "font-size": 11, "text-anchor": "middle", "font-family": "ui-monospace, monospace" }, "sequence position"));
    legend(svg, colors, result, { x: 44, y: 24 });
    return svg;
  }

  function structureSvg(width, height, label, title, colors) {
    const svg = element("svg", {
      xmlns: SVG_NS,
      viewBox: "0 0 " + width + " " + height,
      width: "100%",
      height: String(height),
      role: "img",
      "aria-label": label
    });
    svg.appendChild(element("title", {}, title));
    svg.appendChild(element("rect", { x: 0, y: 0, width: width, height: height, rx: 8, fill: colors.surface }));
    return svg;
  }

  function structureHardPairs(result) {
    return new Set((result.constraints || []).map(function (pair) {
      return pair.left + ":" + pair.right;
    }));
  }

  function structurePairStyle(result, pair, colors, hardPairs) {
    const constraints = hardPairs || structureHardPairs(result);
    const support = Number(pair.evidenceSupport) || 0;
    const guided = result.constraintMode === "hyb-guided";
    const cplfold = result.engine === "CPLfold";
    const cplfoldEvidence = cplfold && result.evidence && result.evidence.source === "hyb-block-intervals";
    const maximumEvidence = Math.max(0, Number(cplfoldEvidence ? result.evidence.maximumBonus : result.maximumNucleotideSupport) || 0);
    const hardConstraint = constraints.has(pair.left + ":" + pair.right);
    return {
      stroke: cplfold ? cplfoldPairColor(pair, colors) : (guided ? evidenceColor(support, maximumEvidence, colors) : pairColor(pair.type, colors)),
      strokeWidth: cplfold && pair.layer !== "primary" ? 3 : (hardConstraint ? 3.7 : (guided && support > 0 ? 2.5 : ((pair.type === "G–C" || pair.type === "C–G") ? 2.1 : 1.6))),
      opacity: cplfoldEvidence
        ? Math.max(0.32, Math.min(0.96, 0.32 + support / Math.max(maximumEvidence, 1e-12) * 0.64))
        : (guided && !support ? 0.34 : 0.9),
      dash: cplfold && pair.layer && pair.layer !== "primary" ? "5 3" : "",
      hardConstraint: hardConstraint
    };
  }

  function structurePairTitle(result, pair, style) {
    const cplfold = result.engine === "CPLfold";
    const guided = result.constraintMode === "hyb-guided";
    const cplfoldEvidence = cplfold && result.evidence && result.evidence.source === "hyb-block-intervals";
    const prefix = cplfold
      ? (pair.layer || "primary") + " CPLfold pair: "
      : (style.hardConstraint ? (guided ? "HYB-fitted hard pair: " : "Manual hard pair: ") : "MFE pair: ");
    const support = Number(pair.evidenceSupport) || 0;
    const evidence = guided ? "; RNAcofold evidence " + support : (cplfoldEvidence ? "; HYB bonus " + support.toFixed(4) : "");
    return prefix + pair.left + " " + pair.leftBase + " paired with " + pair.right + " " + pair.rightBase + " (" + pair.type + ")" + evidence;
  }

  function circlePoint(position, length, centerX, centerY, radius) {
    const angle = -Math.PI / 2 + (2 * Math.PI * (position - 1)) / Math.max(1, length);
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    };
  }

  function pairDepth(pair, pairs) {
    return pairs.reduce(function (depth, other) {
      return other.left < pair.left && other.right > pair.right ? depth + 1 : depth;
    }, 0);
  }

  function appendRingMarkers(svg, result, selectedNucleotide, centerX, centerY, radius, colors) {
    const length = Math.max(1, (result.sequence || "").length);
    if (length > 700) {
      appendInspectionTrack(svg, result, selectedNucleotide, 110, 602, 460, colors);
      return;
    }
    const markerRadius = length <= 120 ? 4.5 : (length <= 360 ? 3 : 1.9);
    for (let position = 1; position <= length; position += 1) {
      const point = circlePoint(position, length, centerX, centerY, radius);
      svg.appendChild(structureMarker(result, position, point.x, point.y, colors, selectedNucleotide, markerRadius));
    }
  }

  function appendSelectedRingRay(svg, length, centerX, centerY, radius, selectedNucleotide, colors) {
    const selected = Number(selectedNucleotide);
    if (!Number.isInteger(selected) || selected < 1 || selected > length) {
      return;
    }
    const point = circlePoint(selected, length, centerX, centerY, radius - 8);
    svg.appendChild(element("line", {
      x1: centerX,
      y1: centerY,
      x2: point.x.toFixed(2),
      y2: point.y.toFixed(2),
      stroke: colors.accent,
      "stroke-width": 1.2,
      "stroke-dasharray": "4 4",
      opacity: 0.45,
      "pointer-events": "none"
    }));
  }

  function appendCircularTicks(svg, length, centerX, centerY, radius, colors) {
    tickPositions(length).forEach(function (position) {
      const inner = circlePoint(position, length, centerX, centerY, radius + 4);
      const outer = circlePoint(position, length, centerX, centerY, radius + 13);
      const label = circlePoint(position, length, centerX, centerY, radius + 28);
      svg.appendChild(element("line", { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, stroke: colors.muted, "stroke-width": 1 }));
      svg.appendChild(element("text", { x: label.x, y: label.y + 4, fill: colors.muted, "font-size": 11, "text-anchor": "middle", "font-family": "ui-monospace, monospace" }, String(position)));
    });
  }

  function appendMatrixTicks(svg, length, plotLeft, plotTop, plotSize, colors) {
    tickPositions(length).forEach(function (position) {
      const x = matrixScale(position, length, plotLeft, plotSize);
      const y = matrixScale(position, length, plotTop, plotSize);
      svg.appendChild(element("line", { x1: x, y1: plotTop, x2: x, y2: plotTop + plotSize, stroke: colors.line, "stroke-width": 1, opacity: 0.45 }));
      svg.appendChild(element("line", { x1: plotLeft, y1: y, x2: plotLeft + plotSize, y2: y, stroke: colors.line, "stroke-width": 1, opacity: 0.45 }));
      svg.appendChild(element("text", { x: x, y: plotTop + plotSize + 17, fill: colors.muted, "font-size": 10, "text-anchor": "middle", "font-family": "ui-monospace, monospace" }, String(position)));
      svg.appendChild(element("text", { x: plotLeft - 9, y: y + 3, fill: colors.muted, "font-size": 10, "text-anchor": "end", "font-family": "ui-monospace, monospace" }, String(position)));
    });
    svg.appendChild(element("text", { x: plotLeft - 43, y: plotTop + plotSize / 2, fill: colors.muted, "font-size": 11, "text-anchor": "middle", transform: "rotate(-90 " + (plotLeft - 43) + " " + (plotTop + plotSize / 2) + ")" }, "position"));
  }

  function appendMatrixPositionControls(svg, result, selectedNucleotide, x, y, width, colors) {
    const length = Math.max(1, (result.sequence || "").length);
    if (length > 700) {
      appendInspectionTrack(svg, result, selectedNucleotide, x, y, width, colors);
      return;
    }
    const markerRadius = length <= 120 ? 4.5 : (length <= 360 ? 3 : 1.9);
    for (let position = 1; position <= length; position += 1) {
      const markerX = linearScale(position, length, x, width);
      svg.appendChild(element("line", { x1: markerX, y1: y - 7, x2: markerX, y2: y + 5, stroke: colors.muted, "stroke-width": 1 }));
      svg.appendChild(structureMarker(result, position, markerX, y, colors, selectedNucleotide, markerRadius));
    }
  }

  function structureMarker(result, position, x, y, colors, selectedNucleotide, radius) {
    const sequence = result.sequence || "";
    const selected = Number(selectedNucleotide) === position;
    const evidenceDriven = result.constraintMode === "hyb-guided" || (result.engine === "CPLfold" && result.evidence && result.evidence.source === "hyb-block-intervals");
    const marker = element("circle", {
      cx: Number(x).toFixed(2),
      cy: Number(y).toFixed(2),
      r: radius,
      fill: selected ? colors.accent : (evidenceDriven ? nucleotideEvidenceColor(result, position, colors) : colors.surface),
      stroke: selected ? colors.accent : colors.muted,
      "stroke-width": selected ? 2.3 : 1.1,
      "data-structure-position": position,
      tabindex: 0,
      role: "button",
      "aria-label": "Inspect nucleotide " + position + ", " + sequence.charAt(position - 1)
    });
    marker.appendChild(element("title", {}, nucleotideTitle(result, position)));
    return marker;
  }

  function appendInspectionTrack(svg, result, selectedNucleotide, x, y, width, colors) {
    const length = Math.max(1, (result.sequence || "").length);
    const selected = Number.isInteger(Number(selectedNucleotide))
      ? Math.max(1, Math.min(length, Number(selectedNucleotide)))
      : 1;
    svg.appendChild(element("line", { x1: x, y1: y, x2: x + width, y2: y, stroke: colors.lineStrong, "stroke-width": 2 }));
    const track = element("rect", {
      x: x,
      y: y - 14,
      width: width,
      height: 28,
      fill: "transparent",
      "data-structure-track": "true",
      tabindex: 0,
      role: "slider",
      "aria-label": "Inspect nucleotide along the sequence baseline",
      "aria-valuemin": 1,
      "aria-valuemax": length,
      "aria-valuenow": selected
    });
    track.appendChild(element("title", {}, "Click the sequence track or use Left, Right, Home and End to inspect a nucleotide"));
    svg.appendChild(track);
    const thumbX = linearScale(selected, length, x, width);
    svg.appendChild(element("circle", { cx: thumbX, cy: y, r: 6, fill: colors.accent, stroke: colors.surface, "stroke-width": 2, "pointer-events": "none" }));
    svg.appendChild(element("text", { x: x, y: y + 30, fill: colors.muted, "font-size": 11, "font-family": "ui-monospace, monospace" }, "1"));
    svg.appendChild(element("text", { x: x + width, y: y + 30, fill: colors.muted, "font-size": 11, "text-anchor": "end", "font-family": "ui-monospace, monospace" }, String(length)));
  }

  function tickPositions(length) {
    const values = [1, Math.round(1 + (length - 1) * 0.25), Math.round(1 + (length - 1) * 0.5), Math.round(1 + (length - 1) * 0.75), length];
    return values.filter(function (position, index) {
      return values.indexOf(position) === index;
    });
  }

  function matrixPoint(one, two, length, plotLeft, plotTop, plotSize) {
    return {
      x: matrixScale(one, length, plotLeft, plotSize),
      y: matrixScale(two, length, plotTop, plotSize)
    };
  }

  function matrixScale(position, length, start, span) {
    return start + ((position - 1) / Math.max(1, length - 1)) * span;
  }

  function linearScale(position, length, start, span) {
    return start + ((position - 1) / Math.max(1, length - 1)) * span;
  }

  // The diagram for an image export, light whatever the page theme: the
  // drawn views (arc, radial, circular, matrix) are drawn again with the
  // light colours; the folded view (fornac) carries its own colours and is
  // copied.  Both get a white background (the page's is transparent).
  function lightExportSvg(state) {
    const shown = document.querySelector("[data-structure-diagram] svg");
    const result = state && state.structure && state.structure.result;
    if (!shown || !result) {
      return null;
    }
    const viewMode = structureViewMode(state.structure.viewMode);
    let svg = null;
    if (viewMode !== "folded") {
      exportColors = LIGHT_EXPORT_COLORS;
      try {
        svg = buildStructureDiagram(result, state.structure.selectedNucleotide, viewMode);
      } catch (error) {
        svg = null; // no SVG DOM to draw into (tests): export what is shown
      } finally {
        exportColors = null;
      }
    }
    if (!svg) {
      svg = typeof shown.cloneNode === "function" ? shown.cloneNode(true) : shown;
    }
    if (typeof svg.getAttribute === "function" && !svg.getAttribute("xmlns") && typeof svg.setAttribute === "function") {
      svg.setAttribute("xmlns", SVG_NS);
    }
    if (typeof document.createElementNS !== "function" || typeof svg.insertBefore !== "function") {
      return svg;
    }
    const box = String(svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const background = document.createElementNS(SVG_NS, "rect");
    if (box.length === 4 && box.every(Number.isFinite)) {
      background.setAttribute("x", String(box[0]));
      background.setAttribute("y", String(box[1]));
      background.setAttribute("width", String(box[2]));
      background.setAttribute("height", String(box[3]));
    } else {
      background.setAttribute("width", "100%");
      background.setAttribute("height", "100%");
    }
    background.setAttribute("fill", "#ffffff");
    svg.insertBefore(background, svg.firstChild);
    return svg;
  }

  function downloadStructurePng(api, viewMode, exportSource) {
    const svg = exportSource || document.querySelector("[data-structure-diagram] svg");
    if (!svg) {
      api.showToast("The structure diagram is not ready to export yet.");
      return;
    }

    let sourceUrl = "";
    let finished = false;
    function cleanUp() {
      if (sourceUrl) {
        URL.revokeObjectURL(sourceUrl);
        sourceUrl = "";
      }
    }
    function fail() {
      if (finished) {
        return;
      }
      finished = true;
      cleanUp();
      api.showToast("This browser could not create the structure PNG. Download the SVG instead.");
    }

    try {
      const dimensions = svgDimensions(svg);
      const scale = 2;
      // a light export copy is already a copy; the page's diagram is cloned
      const exportSvg = exportSource ? svg : svg.cloneNode(true);
      exportSvg.setAttribute("width", String(dimensions.width * scale));
      exportSvg.setAttribute("height", String(dimensions.height * scale));
      const source = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" + new XMLSerializer().serializeToString(exportSvg);
      sourceUrl = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));

      const image = new Image();
      image.onload = function () {
        cleanUp();
        if (finished) {
          return;
        }
        try {
          const canvas = document.createElement("canvas");
          canvas.width = dimensions.width * scale;
          canvas.height = dimensions.height * scale;
          const context = canvas.getContext("2d");
          if (!context || typeof canvas.toBlob !== "function") {
            fail();
            return;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            if (!blob) {
              fail();
              return;
            }
            try {
              api.downloadBlob("rna-secondary-structure-" + structureViewFileStem(viewMode) + ".png", blob);
              finished = true;
              api.showToast("Structure PNG downloaded locally.");
            } catch (error) {
              fail();
            }
          }, "image/png");
        } catch (error) {
          fail();
        }
      };
      image.onerror = fail;
      image.src = sourceUrl;
    } catch (error) {
      fail();
    }
  }

  function svgDimensions(svg) {
    const viewBox = String(svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 && Number.isFinite(viewBox[3]) && viewBox[3] > 0) {
      return { width: Math.ceil(viewBox[2]), height: Math.ceil(viewBox[3]) };
    }
    const width = Number.parseFloat(svg.getAttribute("width"));
    const height = Number.parseFloat(svg.getAttribute("height"));
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error("The structure SVG has no rasterisable dimensions.");
    }
    return { width: Math.ceil(width), height: Math.ceil(height) };
  }

  function markerTicks(svg, result, length, left, right, baseline, colors, selectedNucleotide) {
    const sequence = result.sequence || "";
    const count = length <= 36 ? length : 5;
    for (let index = 0; index < count; index += 1) {
      const position = count === length ? index + 1 : Math.round(1 + (index / (count - 1 || 1)) * (length - 1));
      const x = xFor(position, length, left, right);
      svg.appendChild(element("line", { x1: x, y1: baseline - 4, x2: x, y2: baseline + 7, stroke: colors.muted, "stroke-width": 1 }));
      svg.appendChild(element("text", { x: x, y: baseline + 23, fill: colors.muted, "font-size": 11, "text-anchor": "middle", "font-family": "ui-monospace, monospace" }, length <= 36 ? sequence.charAt(position - 1) + " " + position : String(position)));
    }

    if (length <= 700) {
      for (let position = 1; position <= length; position += 1) {
        const x = xFor(position, length, left, right);
        const selected = Number(selectedNucleotide) === position;
        const marker = element("circle", {
          cx: x.toFixed(2),
          cy: baseline,
          r: length <= 120 ? 4.5 : 3.2,
          fill: selected ? colors.accent : ((result.constraintMode === "hyb-guided" || (result.engine === "CPLfold" && result.evidence && result.evidence.source === "hyb-block-intervals")) ? nucleotideEvidenceColor(result, position, colors) : colors.surface),
          stroke: selected ? colors.accent : colors.muted,
          "stroke-width": selected ? 2.3 : 1.1,
          "data-structure-position": position,
          tabindex: 0,
          role: "button",
          "aria-label": "Inspect nucleotide " + position + ", " + sequence.charAt(position - 1)
        });
        marker.appendChild(element("title", {}, nucleotideTitle(result, position)));
        svg.appendChild(marker);
      }
    } else {
      const selected = Number.isInteger(Number(selectedNucleotide))
        ? Math.max(1, Math.min(length, Number(selectedNucleotide)))
        : 1;
      const track = element("rect", {
        x: left,
        y: baseline - 12,
        width: right - left,
        height: 24,
        fill: "transparent",
        "data-structure-track": "true",
        tabindex: 0,
        role: "slider",
        "aria-label": "Inspect nucleotide along the sequence baseline",
        "aria-valuemin": 1,
        "aria-valuemax": length,
        "aria-valuenow": selected
      });
      track.appendChild(element("title", {}, "Click the baseline or use Left, Right, Home and End to inspect a nucleotide"));
      svg.appendChild(track);
    }
  }

  function bindNucleotideMarkers(target, state, api) {
    if (!api) {
      return;
    }
    Array.from(target.querySelectorAll("[data-structure-position]")).forEach(function (marker) {
      function selectMarker() {
        const position = Number(marker.getAttribute("data-structure-position"));
        state.structure.selectedNucleotide = position;
        api.render();
        const replacement = document.querySelector('[data-structure-position="' + position + '"]');
        if (replacement) {
          replacement.focus();
        }
      }
      marker.addEventListener("click", selectMarker);
      marker.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectMarker();
        }
      });
    });
    const track = target.querySelector("[data-structure-track]");
    if (track) {
      const length = state.structure.result.sequence.length;
      function selectPosition(position, restoreFocus) {
        state.structure.selectedNucleotide = Math.max(1, Math.min(length, position));
        api.render();
        if (restoreFocus) {
          const replacement = document.querySelector("[data-structure-track]");
          if (replacement) {
            replacement.focus();
          }
        }
      }
      track.addEventListener("click", function (event) {
        const bounds = track.getBoundingClientRect();
        const ratio = bounds.width > 0 ? Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) : 0;
        selectPosition(Math.round(1 + ratio * (length - 1)), true);
      });
      track.addEventListener("keydown", function (event) {
        const current = Number.isInteger(Number(state.structure.selectedNucleotide))
          ? Number(state.structure.selectedNucleotide)
          : 1;
        let next = current;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= 1;
        if (event.key === "ArrowRight" || event.key === "ArrowUp") next += 1;
        if (event.key === "Home") next = 1;
        if (event.key === "End") next = length;
        if (next !== current || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          selectPosition(next, true);
        }
      });
    }
  }

  function nucleotideTitle(result, position) {
    const pair = (result.pairs || []).find(function (entry) { return entry.left === position || entry.right === position; });
    const base = result.sequence.charAt(position - 1);
    if (!pair) {
      return position + " " + base + ": unpaired";
    }
    const partner = pair.left === position ? pair.right : pair.left;
    return position + " " + base + ": paired with " + partner + " (" + pair.type + ")";
  }

  function legend(svg, colors, result, options) {
    const settings = options || {};
    const startX = settings.x == null ? 44 : settings.x;
    const y = settings.y == null ? 24 : settings.y;
    const guided = result.constraintMode === "hyb-guided";
    const cplfold = result.engine === "CPLfold";
    const cplfoldAllowsPseudoknot = cplfold && resultAllowsPseudoknot(result);
    const spacing = settings.spacing == null ? ((guided || cplfold) ? 132 : 98) : settings.spacing;
    const items = cplfold
      ? (cplfoldAllowsPseudoknot
        ? [{ label: "phase 1", color: colors.primary }, { label: "pseudoknot", color: colors.accent }, { label: "deeper layer", color: colors.warning }]
        : [{ label: "phase 1", color: colors.primary }])
      : guided
      ? [{ label: "high evidence", color: colors.warning }, { label: "low evidence", color: colors.primary }, { label: "MFE only", color: colors.lineStrong }]
      : [{ label: "G–C", color: colors.primary }, { label: "A–U", color: colors.accent }, { label: "G–U", color: colors.muted }];
    items.forEach(function (item, index) {
      const x = startX + index * spacing;
      svg.appendChild(element("line", { x1: x, y1: y, x2: x + 17, y2: y, stroke: item.color, "stroke-width": 2.5, "stroke-linecap": "round" }));
      svg.appendChild(element("text", { x: x + 24, y: y + 4, fill: colors.muted, "font-size": 11, "font-family": "ui-monospace, monospace" }, item.label));
    });
  }

  function element(name, attributes, content) {
    const node = document.createElementNS(SVG_NS, name);
    Object.keys(attributes || {}).forEach(function (key) { node.setAttribute(key, String(attributes[key])); });
    if (content !== undefined) {
      node.textContent = content;
    }
    return node;
  }

  function xFor(position, length, left, right) {
    return length <= 1 ? (left + right) / 2 : left + ((position - 1) / (length - 1)) * (right - left);
  }

  // image exports are drawn in the light theme whatever the page's theme
  // (as the other pages' exports): these are styles.css's light values
  const LIGHT_EXPORT_COLORS = {
    primary: "#00a09d",
    accent: "#6a4ff2",
    muted: "#5b6c80",
    line: "#dce7ec",
    lineStrong: "#c2d3db",
    warning: "#9c5e12",
    surface: "#f7fafb"
  };
  let exportColors = null;

  function colorTokens() {
    if (exportColors) {
      return Object.assign({}, exportColors);
    }
    const style = getComputedStyle(document.documentElement);
    return {
      primary: style.getPropertyValue("--primary").trim(),
      accent: style.getPropertyValue("--accent").trim(),
      muted: style.getPropertyValue("--muted").trim(),
      line: style.getPropertyValue("--line").trim(),
      lineStrong: style.getPropertyValue("--line-strong").trim(),
      warning: style.getPropertyValue("--warning").trim(),
      surface: style.getPropertyValue("--surface-subtle").trim()
    };
  }

  function pairColor(type, colors) {
    if (type === "G–C" || type === "C–G") {
      return colors.primary;
    }
    if (type === "A–U" || type === "U–A") {
      return colors.accent;
    }
    return colors.muted;
  }

  function cplfoldPairColor(pair, colors) {
    if (pair.layer === "pseudoknot-1") {
      return colors.accent;
    }
    if (pair.layer && pair.layer !== "primary") {
      return colors.warning;
    }
    return colors.primary;
  }

  function evidenceColor(support, maximum, colors) {
    if (!(support > 0) || !(maximum > 0)) {
      return colors.lineStrong;
    }
    return support / maximum >= 0.55 ? colors.warning : colors.primary;
  }

  function nucleotideEvidenceColor(result, position, colors) {
    const support = result.nucleotideSupport && Number(result.nucleotideSupport[position - 1]) || 0;
    return evidenceColor(support, Number(result.maximumNucleotideSupport) || 0, colors);
  }

  function dotBracketFile(result) {
    const energy = Number.isFinite(Number(result.energy)) ? " (" + Number(result.energy).toFixed(2) + ")" : "";
    return ">" + (result.label || (result.engine === "CPLfold" ? "RNAXRAY_Web_CPLfold" : "RNAXRAY_Web_ViennaRNA_MFE")) + "\n" + result.sequence + "\n" + result.dotBracket + energy + "\n";
  }

  function basePairTsv(result) {
    const hardPairs = new Set((result.constraints || []).map(function (pair) {
      return pair.left + ":" + pair.right;
    }));
    const cplfold = result.engine === "CPLfold";
    const guided = result.constraintMode === "hyb-guided";
    const evidenceKind = cplfold
      ? (result.evidence && result.evidence.source === "hyb-block-intervals" ? "log1p_hyb_bonus" : "none")
      : (guided ? "rna_cofold_observations" : "none");
    // Keep the original ViennaRNA columns first for downstream compatibility,
    // then add engine-neutral, explicitly typed fields.
    const rows = [["left_position", "left_base", "right_position", "right_base", "pair_type", "hard_constraint", "rna_cofold_evidence", "mfe_kcal_per_mol", "evidence_kind", "evidence_support", "pair_layer", "selected_energy_kcal_per_mol", "engine"]];
    (result.pairs || []).forEach(function (pair) {
      const support = Number(pair.evidenceSupport) || 0;
      rows.push([
        pair.left,
        pair.leftBase,
        pair.right,
        pair.rightBase,
        pair.type,
        hardPairs.has(pair.left + ":" + pair.right) ? "yes" : "no",
        cplfold ? "" : support,
        cplfold ? "" : (Number.isFinite(Number(result.energy)) ? Number(result.energy).toFixed(2) : ""),
        evidenceKind,
        support,
        pair.layer || "nested",
        Number.isFinite(Number(result.energy)) ? Number(result.energy).toFixed(2) : "",
        result.engine || "ViennaRNA"
      ]);
    });
    return rows.map(function (row) { return row.join("\t"); }).join("\n") + "\n";
  }

  function evidenceTsv(result) {
    const rows = [["prepared_position_1", "prepared_position_2", "hyb_row_observations", "example_record_ids"]];
    const evidence = result.evidence && result.evidence.selectedBasePairs || [];
    evidence.forEach(function (pair) {
      rows.push([pair.one, pair.two, pair.count, (pair.recordIds || []).join(",")]);
    });
    return rows.map(function (row) { return row.join("\t"); }).join("\n") + "\n";
  }

  function constraintsTsv(result) {
    const rows = [["constraint_id", "original_rank", "command", "left", "right", "stem_length", "evidence_support", "accepted"]];
    (result.acceptedStemConstraints || []).forEach(function (constraint) {
      rows.push([constraint.id, constraint.rank, "F " + constraint.left + " " + constraint.right + " " + constraint.length, constraint.left, constraint.right, constraint.length, constraint.support, "yes"]);
    });
    (result.rejectedStemConstraints || []).forEach(function (constraint) {
      rows.push([constraint.id, constraint.rank, "", "", "", "", "", "no:" + constraint.reason]);
    });
    return rows.map(function (row) { return row.join("\t"); }).join("\n") + "\n";
  }

  function ensembleTsv(result) {
    const rows = [["run", "randomised", "selected", "mfe_kcal_per_mol", "comrades_score", "matched_evidence_pairs", "accepted_stem_constraints", "rejected_stem_constraints", "dot_bracket"]];
    const randomisation = result.randomisation || {};
    (randomisation.structures || []).forEach(function (entry) {
      rows.push([
        entry.run,
        entry.randomised ? "yes" : "no",
        entry.run === randomisation.selectedRun ? "yes" : "no",
        entry.energy,
        entry.comradesScore,
        entry.matchedEvidencePairs,
        (entry.acceptedStemConstraints || []).join(","),
        entry.rejectedStemConstraints,
        entry.dotBracket
      ]);
    });
    return rows.map(function (row) { return row.join("\t"); }).join("\n") + "\n";
  }

  function cplfoldEvidenceTsv(result) {
    const evidence = result.evidence || {};
    const sequenceLength = result.sequence ? String(result.sequence).length : Number(evidence.sequenceLength) || 0;
    const rows = [
      "# RNAxRay CPLfold bonus matrix",
      "# sequence_length=" + sequenceLength,
      "# coordinate_system=prepared-sequence-1-based-inclusive",
      "# transform=IRIS-style Gaussian arm blocks; symmetric outer product; threshold 1e-6; log1p",
      ["prepared_position_1", "prepared_position_2", "log1p_gaussian_hyb_bonus"].join("\t")
    ];
    (evidence.bonusEntries || []).forEach(function (entry) {
      rows.push([entry.one, entry.two, Number(entry.value).toFixed(8)].join("\t"));
    });
    return rows.join("\n") + "\n";
  }

  function cplfoldCandidatesTsv(result) {
    const rows = [["rank", "selected", "type", "topology", "energy_kcal_per_mol", "effective_energy_kcal_per_mol", "phase1_energy_kcal_per_mol", "linear_fold_score", "base_pairs", "crossing_pairs", "dot_bracket"]];
    (result.candidates || []).forEach(function (candidate, index) {
      rows.push([
        index + 1,
        index === Number(result.selectedCandidate || 0) ? "yes" : "no",
        candidate.type,
        candidate.topology,
        candidate.energy == null ? "" : candidate.energy,
        candidate.effectiveEnergy == null ? "" : candidate.effectiveEnergy,
        candidate.phase1Energy == null ? "" : candidate.phase1Energy,
        candidate.score == null ? "" : candidate.score,
        (candidate.pairs || []).length,
        candidate.crossingPairs || 0,
        candidate.dotBracket
      ]);
    });
    return rows.map(function (row) { return row.join("\t"); }).join("\n") + "\n";
  }

  function ctFile(result) {
    const sequence = result.sequence || "";
    const pairLookup = new Map();
    (result.pairs || []).forEach(function (pair) {
      pairLookup.set(pair.left, pair.right);
      pairLookup.set(pair.right, pair.left);
    });
    const energy = Number.isFinite(Number(result.energy)) ? Number(result.energy).toFixed(2) : "NA";
    const rows = [sequence.length + " ENERGY = " + energy + " " + (result.label || (result.engine === "CPLfold" ? "RNAXRAY_Web_CPLfold" : "RNAXRAY_Web_ViennaRNA_MFE"))];
    for (let position = 1; position <= sequence.length; position += 1) {
      rows.push([
        position,
        sequence.charAt(position - 1),
        position === 1 ? 0 : position - 1,
        position === sequence.length ? 0 : position + 1,
        pairLookup.get(position) || 0,
        position
      ].join("\t"));
    }
    return rows.join("\n") + "\n";
  }

  window.RNAxRayStructureUI = {
    afterRender: afterRender,
    handleAction: handleAction,
    structureReport: structureReport,
    basePairTsv: basePairTsv,
    evidenceTsv: evidenceTsv,
    constraintsTsv: constraintsTsv,
    ensembleTsv: ensembleTsv,
    cplfoldEvidenceTsv: cplfoldEvidenceTsv,
    cplfoldCandidatesTsv: cplfoldCandidatesTsv,
    localCplfoldCommand: localCplfoldCommand,
    selectCplfoldCandidate: selectCplfoldCandidate,
    buildStructureDiagram: buildStructureDiagram
  };
}());

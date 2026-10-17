(function () {
  "use strict";

  const CONTACT_MIN_CELLS = 50000;
  const CONTACT_BASELINE_CELLS = 100000;
  const CONTACT_HARD_MAX_CELLS = 1000000;
  const CONTACT_BASELINE_BIN_CONTRIBUTIONS = 2000000;
  const CONTACT_HARD_MAX_BIN_CONTRIBUTIONS = 20000000;
  const CONTACT_BIN_CONTRIBUTIONS_PER_CELL = 20;
  // a cell is one Map entry plus five array slots (buildContactBins), with
  // headroom for the copies the provider cache and comparison keep
  const CONTACT_ESTIMATED_CELL_BYTES = 240;
  const CONTACT_MEMORY_BYTES_PER_GB = 32 * 1024 * 1024;
  const CONTACT_MIN_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;
  const CONTACT_MAX_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;
  const CONTACT_FALLBACK_MEMORY_GB = 2;
  const CONTACT_TARGET_BUILD_MS = 250;
  // a whole-genome 10-nt comparison of four virus libraries (the included
  // ZIKV example) covers ~840,000 distinct cells from ~1.65 million
  // dataset cells; buildComparisonResults keeps them in typed arrays
  const MAX_COMPARISON_CELLS = 1500000;
  const MAX_COMPARISON_DATASET_CELLS = 4000000;
  const COMPARISON_DATASET_BUDGET = { maximumCells: MAX_COMPARISON_CELLS, maximumBinContributions: CONTACT_HARD_MAX_BIN_CONTRIBUTIONS };
  const MAX_R_INTEGER_COUNT = 2147483647;
  let contactResourceBudgetCache = null;

  function clampInteger(value, minimum, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return minimum;
    }
    return Math.max(minimum, Math.min(maximum, Math.floor(numeric)));
  }

  function getBrowserNavigator() {
    if (typeof navigator !== "undefined" && navigator) {
      return navigator;
    }
    if (typeof window !== "undefined" && window && window.navigator) {
      return window.navigator;
    }
    return null;
  }

  function performanceNow() {
    if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
      return performance.now();
    }
    if (typeof window !== "undefined" && window && window.performance && typeof window.performance.now === "function") {
      return window.performance.now();
    }
    return Date.now();
  }

  function median(values) {
    if (!values.length) {
      return 0;
    }
    const sorted = values.slice().sort(function (left, right) { return left - right; });
    return sorted[Math.floor(sorted.length / 2)];
  }

  // The probe follows the allocation and lookup pattern used by the sparse map.
  // It is intentionally small so the first contact-map render stays responsive.
  function probeContactPerformance() {
    const sampleCells = 4000;
    const sampleContributions = 16000;
    const cellRates = [];
    const contributionRates = [];
    let checksum = 0;

    for (let round = 0; round < 4; round += 1) {
      const cells = Object.create(null);
      let startedAt = performanceNow();
      for (let index = 0; index < sampleCells; index += 1) {
        const key = index + ":" + index;
        cells[key] = { x: index, y: index, records: 0, support: 0, value: 1 };
      }
      const cellElapsed = Math.max(1, performanceNow() - startedAt);

      startedAt = performanceNow();
      for (let index = 0; index < sampleContributions; index += 1) {
        const coordinate = index % sampleCells;
        const cell = cells[coordinate + ":" + coordinate];
        if (cell) {
          cell.records += 1;
          cell.value += 1;
          checksum += cell.records;
        }
      }
      const contributionElapsed = Math.max(1, performanceNow() - startedAt);

      if (round > 0) {
        cellRates.push(sampleCells / cellElapsed);
        contributionRates.push(sampleContributions / contributionElapsed);
      }
    }

    if (checksum === Number.MIN_SAFE_INTEGER) {
      return { cellsPerMs: 0, contributionsPerMs: 0 };
    }
    return {
      cellsPerMs: Math.max(1, median(cellRates)),
      contributionsPerMs: Math.max(1, median(contributionRates))
    };
  }

  function getContactResourceBudget() {
    if (contactResourceBudgetCache) {
      return contactResourceBudgetCache;
    }

    const browserNavigator = getBrowserNavigator();
    const reportedDeviceMemory = browserNavigator && Number.isFinite(Number(browserNavigator.deviceMemory))
      ? Number(browserNavigator.deviceMemory)
      : null;
    const deviceMemoryGb = reportedDeviceMemory !== null && reportedDeviceMemory > 0
      ? Math.min(64, reportedDeviceMemory)
      : null;
    const hardwareConcurrency = browserNavigator && Number.isSafeInteger(Number(browserNavigator.hardwareConcurrency)) && Number(browserNavigator.hardwareConcurrency) > 0
      ? Number(browserNavigator.hardwareConcurrency)
      : null;

    let probe;
    try {
      probe = probeContactPerformance();
    } catch (error) {
      probe = {
        cellsPerMs: CONTACT_BASELINE_CELLS / CONTACT_TARGET_BUILD_MS,
        contributionsPerMs: CONTACT_BASELINE_BIN_CONTRIBUTIONS / CONTACT_TARGET_BUILD_MS
      };
    }

    const effectiveMemoryGb = deviceMemoryGb || CONTACT_FALLBACK_MEMORY_GB;
    const memoryBudgetBytes = Math.max(
      CONTACT_MIN_MEMORY_BUDGET_BYTES,
      Math.min(CONTACT_MAX_MEMORY_BUDGET_BYTES, effectiveMemoryGb * CONTACT_MEMORY_BYTES_PER_GB)
    );
    const memoryBoundCells = Math.floor(memoryBudgetBytes / CONTACT_ESTIMATED_CELL_BYTES);
    const performanceBoundCells = Math.max(
      CONTACT_BASELINE_CELLS,
      Math.floor(probe.cellsPerMs * CONTACT_TARGET_BUILD_MS)
    );
    const maximumCells = clampInteger(
      Math.min(memoryBoundCells, performanceBoundCells),
      CONTACT_MIN_CELLS,
      CONTACT_HARD_MAX_CELLS
    );
    const performanceBoundContributions = Math.floor(probe.contributionsPerMs * CONTACT_TARGET_BUILD_MS);
    const maximumBinContributions = clampInteger(
      Math.max(
        CONTACT_BASELINE_BIN_CONTRIBUTIONS,
        Math.min(
          CONTACT_HARD_MAX_BIN_CONTRIBUTIONS,
          performanceBoundContributions,
          maximumCells * CONTACT_BIN_CONTRIBUTIONS_PER_CELL
        )
      ),
      CONTACT_BASELINE_BIN_CONTRIBUTIONS,
      CONTACT_HARD_MAX_BIN_CONTRIBUTIONS
    );

    contactResourceBudgetCache = {
      maximumCells: maximumCells,
      maximumBinContributions: maximumBinContributions,
      deviceMemoryGb: deviceMemoryGb,
      hardwareConcurrency: hardwareConcurrency,
      memoryBudgetMb: Math.round(memoryBudgetBytes / (1024 * 1024)),
      estimatedCellBytes: CONTACT_ESTIMATED_CELL_BYTES,
      targetBuildMs: CONTACT_TARGET_BUILD_MS,
      probeCellsPerMs: probe.cellsPerMs,
      probeContributionsPerMs: probe.contributionsPerMs,
      profile: deviceMemoryGb === null ? "fallback-memory+performance-probe" : "device-memory+performance-probe"
    };
    return contactResourceBudgetCache;
  }

  // comparison.worker.js uses the page's budget, so that the limits do not
  // depend on where the bins are built
  function setContactResourceBudget(budget) {
    contactResourceBudgetCache = budget && Number(budget.maximumCells) > 0 && Number(budget.maximumBinContributions) > 0 ? budget : null;
  }

  function defaultInteractionFilters() {
    return {
      rna: "",
      partner: "",
      type: "all",
      chimeraType: "all",
      search: "",
      armOneStart: "",
      armOneEnd: "",
      armTwoStart: "",
      armTwoEnd: "",
      maxEvalue: "",
      minDg: "",
      maxDg: "",
      minSupport: "1",
      countMode: "support"
    };
  }

  function defaultContactState(summary) {
    const pair = summary && summary.pairCounts && summary.pairCounts[0];
    return {
      rnaX: pair ? pair.rnaOne : "",
      rnaY: pair ? pair.rnaTwo : "",
      binSize: 10,
      measure: "records",
      colourCap: "95",
      customCap: "",
      scale: "linear",
      orientation: "normalised",
      chimeraType: "all",
      homodimer: "all",
      matrix: null,
      selection: null,
      showDataTable: false,
      overviewSelection: null,
      zoomSelection: null,
      overviewView: null,
      zoomView: null,
      detailView: null
    };
  }

  function defaultRegionState(summary, records) {
    const rna = summary && summary.rnaCounts && summary.rnaCounts[0] ? summary.rnaCounts[0].name : "";
    const extent = getRnaExtent(records || [], rna, summary);
    return {
      rna: rna,
      start: extent ? extent.min : "",
      end: extent ? Math.min(extent.max, (extent.min || 0) + 200) : "",
      partner: "",
      partnerStart: "",
      partnerEnd: "",
      overlap: "any",
      results: null
    };
  }

  function defaultViewpointState(summary, records) {
    const rna = summary && summary.rnaCounts && summary.rnaCounts[0] ? summary.rnaCounts[0].name : "";
    const extent = getRnaExtent(records || [], rna, summary);
    return {
      rna: rna,
      partner: "",
      chimeraType: "all",
      homodimer: "all",
      rangeMode: "coordinates",
      start: extent ? extent.min : "",
      end: extent ? extent.max : "",
      binSize: "1",
      measure: "records",
      results: null,
      selection: null,
      showDataTable: false
    };
  }

  function defaultComparisonState(summary, records) {
    const pair = summary && summary.pairCounts && summary.pairCounts[0];
    return {
      datasets: summary ? [{
        id: "primary",
        fileName: summary.fileName,
        fileSize: summary.fileSize,
        summary: summary,
        records: records || [],
        condition: "A",
        label: "Primary"
      }] : [],
      loading: null,
      error: "",
      rnaX: pair ? pair.rnaOne : "",
      rnaY: pair ? pair.rnaTwo : "",
      binSize: "10",
      measure: "records",
      normalise: "library",
      similarityMinimum: "1",
      similarityPanel: "white",
      conditionALabel: "Condition A",
      conditionBLabel: "Condition B",
      result: null,
      selection: null,
      activeMap: "effect",
      showDataTable: false
    };
  }

  function defaultStructureState() {
    return {
      engine: "cplfold",
      workflow: "custom",
      source: "reference",
      rna: "",
      start: "",
      end: "",
      pastedSequence: "",
      selectedRecordIndex: null,
      minimumLoop: "3",
      temperature: "37",
      constraintMode: "none",
      constraintText: "",
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
      cplfoldEvidence: "hyb-blocks",
      cplfoldBeam: "20",
      cplfoldMaxPhase1: "3",
      cplfoldEnergyDelta: "5",
      cplfoldEnergyModel: "DP09",
      cplfoldAlpha: "0.5",
      cplfoldBeta: "0",
      cplfoldAllowPseudoknot: false,
      cplfoldCapacity: {
        status: "unknown",
        baselineLength: 75,
        recommendedLength: 75,
        hardCeiling: 500,
        probeLength: null,
        foldElapsedMs: null,
        elapsedMs: null,
        runtimeLoadMs: null,
        testedAt: null,
        profileKey: "",
        hardware: null,
        runtimeManifest: null,
        parameters: null,
        message: ""
      },
      viewMode: "folded",
      selectedNucleotide: null,
      operation: null,
      status: "idle",
      progress: 0,
      message: "",
      result: null,
      runningSequenceInfo: null,
      runId: 0
    };
  }

  // Extent of an RNA's arms. When no records are supplied (pages fed by a
  // DataProvider), the summary's rnaExtents map is used instead.
  function getRnaExtent(records, rna, summary) {
    if ((!records || !records.length) && summary && summary.rnaExtents) {
      const known = summary.rnaExtents[rna];
      return known ? { min: known.min, max: known.max } : null;
    }
    let min = Infinity;
    let max = -Infinity;

    records.forEach(function (record) {
      if (record.rnaOne === rna) {
        min = Math.min(min, record.rnaOneStart);
        max = Math.max(max, record.rnaOneEnd);
      }
      if (record.rnaTwo === rna) {
        min = Math.min(min, record.rnaTwoStart);
        max = Math.max(max, record.rnaTwoEnd);
      }
    });

    return Number.isFinite(min) ? { min: min, max: max } : null;
  }

  function getFilteredRecords(state) {
    return filterRecords(state.records || [], state.filters);
  }

  // Pure record filter shared by the legacy state wrapper above and the
  // BrowserProvider (data-provider.js). `filterValues` uses the
  // defaultInteractionFilters() shape.
  function filterRecords(records, filterValues) {
    const filters = filterValues || defaultInteractionFilters();
    const query = String(filters.search || "").trim().toLowerCase();
    const armOneStart = coordinateOrNull(filters.armOneStart);
    const armOneEnd = coordinateOrNull(filters.armOneEnd);
    const armTwoStart = coordinateOrNull(filters.armTwoStart);
    const armTwoEnd = coordinateOrNull(filters.armTwoEnd);
    const maxEvalue = numberOrNull(filters.maxEvalue);
    const minDg = numberOrNull(filters.minDg);
    const maxDg = numberOrNull(filters.maxDg);
    const minSupport = numberOrNull(filters.minSupport);

    const coordinateFilters = [
      [filters.armOneStart, armOneStart],
      [filters.armOneEnd, armOneEnd],
      [filters.armTwoStart, armTwoStart],
      [filters.armTwoEnd, armTwoEnd]
    ];
    const hasInvalidCoordinate = coordinateFilters.some(function (entry) {
      return String(entry[0] == null ? "" : entry[0]).trim() && entry[1] === null;
    });

    if (hasInvalidCoordinate || (armOneStart !== null && armOneEnd !== null && armOneStart > armOneEnd) ||
        (armTwoStart !== null && armTwoEnd !== null && armTwoStart > armTwoEnd)) {
      return [];
    }

    return (records || []).filter(function (record) {
      if (filters.rna && record.rnaOne !== filters.rna && record.rnaTwo !== filters.rna) {
        return false;
      }

      if (filters.partner) {
        if (!filters.rna) {
          if (record.rnaOne !== filters.partner && record.rnaTwo !== filters.partner) {
            return false;
          }
        } else if (partnerForRecord(record, filters.rna) !== filters.partner) {
          return false;
        }
      }

      if (filters.type === "intra" && record.rnaOne !== record.rnaTwo) {
        return false;
      }
      if (filters.type === "inter" && record.rnaOne === record.rnaTwo) {
        return false;
      }
      if (filters.type === "homodimer" && !record.isHomodimer) {
        return false;
      }

      if (filters.chimeraType && filters.chimeraType !== "all" && record.chimeraType !== filters.chimeraType) {
        return false;
      }

      if (query) {
        const searchable = [
          record.id,
          record.sequence,
          record.rnaOne,
          record.rnaTwo,
          record.chimeraType,
          record.overlapScore === null ? "" : record.overlapScore
        ].join(" ").toLowerCase();
        if (searchable.indexOf(query) === -1) {
          return false;
        }
      }

      if (!overlapsOptional(record.rnaOneStart, record.rnaOneEnd, armOneStart, armOneEnd)) {
        return false;
      }
      if (!overlapsOptional(record.rnaTwoStart, record.rnaTwoEnd, armTwoStart, armTwoEnd)) {
        return false;
      }

      if (maxEvalue !== null) {
        const values = [record.rnaOneEvalue, record.rnaTwoEvalue].filter(function (value) { return value !== null; });
        if (values.length && values.some(function (value) { return value > maxEvalue; })) {
          return false;
        }
      }

      if (minDg !== null && (record.dg === null || record.dg < minDg)) {
        return false;
      }
      if (maxDg !== null && (record.dg === null || record.dg > maxDg)) {
        return false;
      }
      if (minSupport !== null && record.supportCount < minSupport) {
        return false;
      }

      return true;
    });
  }

  function partnerForRecord(record, rna) {
    if (record.rnaOne === rna && record.rnaTwo === rna) {
      return rna;
    }
    if (record.rnaOne === rna) {
      return record.rnaTwo;
    }
    if (record.rnaTwo === rna) {
      return record.rnaOne;
    }
    return "";
  }

  function getPartnerCounts(records, rna, countMode) {
    const counts = Object.create(null);

    records.forEach(function (record) {
      const partner = rna ? partnerForRecord(record, rna) : "";
      if (!partner) {
        return;
      }

      const existing = counts[partner] || { name: partner, records: 0, support: 0 };
      existing.records += 1;
      existing.support += record.supportCount;
      counts[partner] = existing;
    });

    return Object.keys(counts)
      .map(function (name) { return counts[name]; })
      .sort(function (left, right) {
        const leftValue = countMode === "records" ? left.records : left.support;
        const rightValue = countMode === "records" ? right.records : right.support;
        return rightValue - leftValue || left.name.localeCompare(right.name);
      });
  }

  function orientRecordForPair(record, rnaX, rnaY, orientation) {
    if (record.rnaOne === rnaX && record.rnaTwo === rnaY) {
      return {
        record: record,
        xStart: record.rnaOneStart,
        xEnd: record.rnaOneEnd,
        yStart: record.rnaTwoStart,
        yEnd: record.rnaTwoEnd,
        swapped: false
      };
    }

    if (orientation === "original") {
      return null;
    }

    if (rnaX !== rnaY && record.rnaOne === rnaY && record.rnaTwo === rnaX) {
      return {
        record: record,
        xStart: record.rnaTwoStart,
        xEnd: record.rnaTwoEnd,
        yStart: record.rnaOneStart,
        yEnd: record.rnaOneEnd,
        swapped: true
      };
    }

    return null;
  }

  function buildContactMatrix(records, contact) {
    return contactMatrixFromBins(buildContactBins(records, contact), contact);
  }

  // Accumulates records into sparse contact bins. This is the data half of the
  // contact map and the shape DataProvider.getContactBins() returns:
  // parallel arrays x/y (bin start coordinates), count (chosen measure),
  // records (rows per cell) and support (cluster support per cell), in first-
  // seen order. Display-only settings (colour cap, scale) are not used here.
  function buildContactBins(records, contact) {
    const requestedBinSize = Number(contact.binSize);
    const binSize = Number.isSafeInteger(requestedBinSize) && requestedBinSize > 0 ? requestedBinSize : 10;
    // a comparison dataset is binned off the page (comparison.worker.js) and
    // bounded by the comparison limits, not the Contact page's timing probe,
    // which a busy machine lowers below one replicate of the ZIKV example
    const resourceBudget = contact.budget === "comparison" ? COMPARISON_DATASET_BUDGET : getContactResourceBudget();
    const maximumCells = resourceBudget.maximumCells;
    const maximumBinContributions = resourceBudget.maximumBinContributions;
    // records that pass the filters, oriented, with their bin box; the box
    // sizes the cell index below
    const kept = [];
    let boxXMin = Infinity;
    let boxXMax = -Infinity;
    let boxYMin = Infinity;
    let boxYMax = -Infinity;
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const record = records[recordIndex];
      if (contact.chimeraType && contact.chimeraType !== "all" && record.chimeraType !== contact.chimeraType) {
        continue;
      }
      if (!matchesHomodimerSubset(record, contact.homodimer)) {
        continue;
      }
      const oriented = orientRecordForPair(record, contact.rnaX, contact.rnaY, contact.orientation);
      if (!oriented) {
        continue;
      }
      kept.push(oriented);
      const xs = binSize * Math.floor(oriented.xStart / binSize);
      const xe = binSize * Math.floor(oriented.xEnd / binSize);
      const ys = binSize * Math.floor(oriented.yStart / binSize);
      const ye = binSize * Math.floor(oriented.yEnd / binSize);
      if (xs < boxXMin) boxXMin = xs;
      if (xe > boxXMax) boxXMax = xe;
      if (ys < boxYMin) boxYMin = ys;
      if (ye > boxYMax) boxYMax = ye;
    }
    // cells in first-seen order: the index maps a bin pair to a row of the arrays
    const index = kept.length ? cellIndex(boxXMin, boxXMax, boxYMin, boxYMax, binSize) : cellIndex(0, 0, 0, 0, binSize);
    const cellX = [];
    const cellY = [];
    const cellRecords = [];
    const cellSupport = [];
    const cellValue = [];
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    let recordsUsed = 0;
    let totalSupport = 0;
    let cellCount = 0;
    let binContributions = 0;
    let limitReason = "";

    recordLoop:
    for (let keptIndex = 0; keptIndex < kept.length; keptIndex += 1) {
      const oriented = kept[keptIndex];
      const record = oriented.record;

      const xStartBin = binSize * Math.floor(oriented.xStart / binSize);
      const xEndBin = binSize * Math.floor(oriented.xEnd / binSize);
      const yStartBin = binSize * Math.floor(oriented.yStart / binSize);
      const yEndBin = binSize * Math.floor(oriented.yEnd / binSize);
      const xBinCount = Math.floor((xEndBin - xStartBin) / binSize) + 1;
      const yBinCount = Math.floor((yEndBin - yStartBin) / binSize) + 1;
      const recordContributions = xBinCount * yBinCount;
      const value = contact.measure === "records" ? 1 : record.supportCount;

      if (!Number.isSafeInteger(xBinCount) || !Number.isSafeInteger(yBinCount) ||
          !Number.isSafeInteger(recordContributions) || recordContributions > maximumCells) {
        limitReason = "Contact map not generated: one interaction spans more than " + maximumCells.toLocaleString("en-US") + " bin pairs under the adaptive browser budget. Increase the bin size or correct unusually large arm coordinates.";
        break;
      }
      if (recordContributions > maximumBinContributions - binContributions) {
        limitReason = "Contact map not generated: the selected records require more than " + maximumBinContributions.toLocaleString("en-US") + " bin contributions under the adaptive browser budget. Increase the bin size or narrow the selected data.";
        break;
      }

      for (let x = xStartBin; x <= xEndBin; x += binSize) {
        for (let y = yStartBin; y <= yEndBin; y += binSize) {
          let row = index.get(x, y);
          if (row < 0) {
            if (cellCount >= maximumCells) {
              limitReason = "Contact map not generated: the selected records cover more than " + maximumCells.toLocaleString("en-US") + " distinct cells under the adaptive browser budget. Increase the bin size or narrow the selected data.";
              break recordLoop;
            }
            row = cellCount;
            index.set(x, y, row);
            cellX.push(x);
            cellY.push(y);
            cellRecords.push(0);
            cellSupport.push(0);
            cellValue.push(0);
            cellCount += 1;
          }
          cellRecords[row] += 1;
          cellSupport[row] += record.supportCount;
          cellValue[row] += value;
        }
      }

      binContributions += recordContributions;
      recordsUsed += 1;
      totalSupport += record.supportCount;
      xMin = Math.min(xMin, oriented.xStart);
      xMax = Math.max(xMax, oriented.xEnd);
      yMin = Math.min(yMin, oriented.yStart);
      yMax = Math.max(yMax, oriented.yEnd);
    }

    const limits = {
      cellContributions: binContributions,
      maximumCells: maximumCells,
      maximumBinContributions: maximumBinContributions,
      resourceBudget: resourceBudget
    };

    if (limitReason) {
      return {
        ready: false,
        reason: limitReason,
        limitExceeded: true,
        binSize: binSize,
        length: 0,
        x: [],
        y: [],
        count: [],
        records: [],
        support: [],
        recordsUsed: 0,
        totalSupport: 0,
        extent: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
        limits: limits
      };
    }

    const bins = {
      ready: true,
      reason: "",
      limitExceeded: false,
      binSize: binSize,
      length: 0,
      x: cellX,
      y: cellY,
      count: cellValue,
      records: cellRecords,
      support: cellSupport,
      recordsUsed: recordsUsed,
      totalSupport: totalSupport,
      extent: {
        xMin: Number.isFinite(xMin) ? xMin : 0,
        xMax: Number.isFinite(xMax) ? xMax : 0,
        yMin: Number.isFinite(yMin) ? yMin : 0,
        yMax: Number.isFinite(yMax) ? yMax : 0
      },
      limits: limits
    };
    bins.length = Math.max(bins.extent.xMax, bins.extent.yMax);
    return bins;
  }

  // Numeric key of a cell (bin start coordinates); a string for coordinates
  // outside the exact range of the packed number.
  function cellKey(x, y) {
    return x >= 0 && y >= 0 && x < 67108864 && y < 67108864 && x === Math.floor(x) && y === Math.floor(y)
      ? x * 67108864 + y
      : x + ":" + y;
  }

  // Row lookup for cells whose bin starts lie in a known box: a dense
  // Int32Array when the box is small enough (a 10.8 kb genome against
  // itself at 10 nt is 1,081 x 1,081 bins), a Map otherwise.  Both give the
  // same rows; the array avoids hashing one key per bin contribution, which
  // dominated whole-genome binning.  get() returns -1 when absent.
  const DENSE_CELL_LIMIT = 4194304;
  function cellIndex(xMin, xMax, yMin, yMax, binSize) {
    const width = Math.floor((xMax - xMin) / binSize) + 1;
    const height = Math.floor((yMax - yMin) / binSize) + 1;
    const aligned = function (value, origin) { return Number.isSafeInteger(value) && (value - origin) % binSize === 0; };
    if (binSize > 0 && Number.isSafeInteger(binSize) && width > 0 && height > 0 && width * height <= DENSE_CELL_LIMIT &&
        aligned(xMin, xMin) && aligned(yMin, yMin)) {
      const rows = new Int32Array(width * height);
      const slot = function (x, y) {
        if (!aligned(x, xMin) || !aligned(y, yMin) || x < xMin || x > xMax || y < yMin || y > yMax) {
          return -1;
        }
        return ((x - xMin) / binSize) * height + (y - yMin) / binSize;
      };
      return {
        dense: true,
        get: function (x, y) {
          const at = slot(x, y);
          return at < 0 ? -1 : rows[at] - 1;
        },
        set: function (x, y, row) {
          rows[slot(x, y)] = row + 1;
        },
        // rows by x, then y: the slots are laid out that way
        rowsInOrder: function (count) {
          const out = new Int32Array(count);
          let next = 0;
          for (let at = 0; at < rows.length && next < count; at += 1) {
            if (rows[at]) {
              out[next] = rows[at] - 1;
              next += 1;
            }
          }
          return out;
        }
      };
    }
    const map = new Map();
    return {
      dense: false,
      get: function (x, y) {
        const row = map.get(cellKey(x, y));
        return row === undefined ? -1 : row;
      },
      set: function (x, y, row) {
        map.set(cellKey(x, y), row);
      }
    };
  }

  // Display half of the contact map: turns DataProvider contact bins into the
  // matrix object the Contact Map, Compare and Report pages render.
  function contactMatrixFromBins(bins, contact) {
    const source = bins || {};
    const limits = source.limits || {};
    const binSize = Number(source.binSize) || 10;
    if (source.ready === false) {
      return {
        ready: false,
        reason: source.reason || "Contact map not generated.",
        limitExceeded: source.limitExceeded !== false,
        cells: [],
        cellMap: Object.create(null),
        binSize: binSize,
        xMin: 0,
        xMax: 0,
        yMin: 0,
        yMax: 0,
        recordsUsed: 0,
        totalSupport: 0,
        cellContributions: limits.cellContributions || 0,
        maximumCells: limits.maximumCells,
        maximumBinContributions: limits.maximumBinContributions,
        resourceBudget: limits.resourceBudget,
        max: 0,
        cap: 0
      };
    }

    const xs = source.x || [];
    const entries = new Array(xs.length);
    const lookup = new Map();
    const displayValues = new Float64Array(xs.length);
    let displayMax = 0;
    for (let index = 0; index < xs.length; index += 1) {
      const cell = {
        x: xs[index],
        y: source.y[index],
        records: source.records ? source.records[index] : source.count[index],
        support: source.support ? source.support[index] : source.count[index],
        value: source.count[index]
      };
      entries[index] = cell;
      lookup.set(cellKey(cell.x, cell.y), cell);
      const display = contact.scale === "log" ? Math.log1p(cell.value) : cell.value;
      displayValues[index] = display;
      if (display > displayMax) {
        displayMax = display;
      }
    }
    // The cap needs at most two order statistics, found by selection.
    const cap = resolveContactCap(displayValues, displayMax, contact);
    const extent = source.extent || {};

    const matrix = {
      ready: true,
      reason: "",
      limitExceeded: false,
      cells: entries,
      binSize: binSize,
      xMin: Number.isFinite(extent.xMin) ? extent.xMin : 0,
      xMax: Number.isFinite(extent.xMax) ? extent.xMax : 0,
      yMin: Number.isFinite(extent.yMin) ? extent.yMin : 0,
      yMax: Number.isFinite(extent.yMax) ? extent.yMax : 0,
      length: Number.isFinite(source.length) ? source.length : null,
      length2: Number.isFinite(source.length2) ? source.length2 : null,
      recordsUsed: source.recordsUsed || 0,
      totalSupport: source.totalSupport || 0,
      cellContributions: limits.cellContributions || 0,
      maximumCells: limits.maximumCells,
      maximumBinContributions: limits.maximumBinContributions,
      resourceBudget: limits.resourceBudget,
      max: displayMax,
      cap: cap,
      binSizeAdjusted: !!source.binSizeAdjusted,
      requestedBinSize: source.requestedBinSize || binSize
    };
    // Constant-time lookup without building a string key per cell.
    Object.defineProperty(matrix, "getCell", {
      value: function (x, y) {
        return lookup.get(cellKey(x, y)) || null;
      }
    });
    // The "x:y" map is large (hundreds of thousands of keys at 5 nt) and
    // most views never need it, so it is built on first access.
    let cellMap = null;
    Object.defineProperty(matrix, "cellMap", {
      enumerable: true,
      get: function () {
        if (!cellMap) {
          cellMap = Object.create(null);
          for (let index = 0; index < entries.length; index += 1) {
            cellMap[entries[index].x + ":" + entries[index].y] = entries[index];
          }
        }
        return cellMap;
      }
    });
    return matrix;
  }

  // Same result as resolveColourCap(sorted values), without sorting: the
  // cap needs at most two order statistics, found by selection in O(n).
  function resolveContactCap(values, max, contact) {
    if (!values.length) {
      return 0;
    }
    if (contact.colourCap === "max") {
      return max;
    }
    if (contact.colourCap === "custom") {
      const custom = numberOrNull(contact.customCap);
      return custom !== null && custom > 0 ? custom : max;
    }
    const fraction = (Number(contact.colourCap) || 95) / 100;
    const position = Math.max(0, Math.min(values.length - 1, (values.length - 1) * fraction));
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const lowerValue = selectKth(values, lower);
    if (upper === lower) {
      return lowerValue;
    }
    // After selection everything right of `lower` is >= its value.
    let upperValue = Infinity;
    for (let index = lower + 1; index < values.length; index += 1) {
      if (values[index] < upperValue) {
        upperValue = values[index];
      }
    }
    return lowerValue + (upperValue - lowerValue) * (position - lower);
  }

  // Hoare-partition quickselect; reorders `values` in place.
  function selectKth(values, k) {
    let left = 0;
    let right = values.length - 1;
    while (right > left) {
      const pivot = values[(left + right) >> 1];
      let i = left;
      let j = right;
      while (i <= j) {
        while (values[i] < pivot) {
          i += 1;
        }
        while (values[j] > pivot) {
          j -= 1;
        }
        if (i <= j) {
          const swap = values[i];
          values[i] = values[j];
          values[j] = swap;
          i += 1;
          j -= 1;
        }
      }
      if (k <= j) {
        right = j;
      } else if (k >= i) {
        left = i;
      } else {
        break;
      }
    }
    return values[k];
  }

  function resolveColourCap(values, contact) {
    if (!values.length) {
      return 0;
    }

    if (contact.colourCap === "max") {
      return values[values.length - 1];
    }

    if (contact.colourCap === "custom") {
      const custom = numberOrNull(contact.customCap);
      return custom !== null && custom > 0 ? custom : values[values.length - 1];
    }

    return quantile(values, (Number(contact.colourCap) || 95) / 100);
  }

  function quantile(sortedValues, fraction) {
    if (!sortedValues.length) {
      return 0;
    }

    const position = Math.max(0, Math.min(sortedValues.length - 1, (sortedValues.length - 1) * fraction));
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
  }

  function getCellRecords(records, contact, xBin, yBin) {
    const binSize = Number(contact.binSize) || 10;
    return records.filter(function (record) {
      if (contact.chimeraType && contact.chimeraType !== "all" && record.chimeraType !== contact.chimeraType) {
        return false;
      }
      if (!matchesHomodimerSubset(record, contact.homodimer)) {
        return false;
      }
      const oriented = orientRecordForPair(record, contact.rnaX, contact.rnaY, contact.orientation);
      if (!oriented) {
        return false;
      }

      return (
        oriented.xStart <= xBin + binSize - 1 &&
        oriented.xEnd >= xBin &&
        oriented.yStart <= yBin + binSize - 1 &&
        oriented.yEnd >= yBin
      );
    });
  }

  function getRegionResults(state) {
    const region = state.region;
    return regionResultsFromRecords(filterRegionRecords(state.records || [], region), region);
  }

  function regionQuery(region) {
    const query = region || {};
    const start = coordinateOrNull(query.start);
    const end = coordinateOrNull(query.end);
    const partnerStartText = String(query.partnerStart == null ? "" : query.partnerStart).trim();
    const partnerEndText = String(query.partnerEnd == null ? "" : query.partnerEnd).trim();
    const partnerRangeSpecified = !!partnerStartText || !!partnerEndText;
    const partnerStart = coordinateOrNull(query.partnerStart);
    const partnerEnd = coordinateOrNull(query.partnerEnd);

    if (!query.rna || start === null || end === null || start > end ||
        (partnerRangeSpecified && (!query.partner || partnerStart === null || partnerEnd === null || partnerStart > partnerEnd))) {
      return null;
    }
    return { start: start, end: end, partnerRangeSpecified: partnerRangeSpecified, partnerStart: partnerStart, partnerEnd: partnerEnd };
  }

  // Records matching a Region Explorer query (used by the BrowserProvider for
  // queryHybrids({ region })). Invalid queries match nothing.
  function filterRegionRecords(records, region) {
    const query = regionQuery(region);
    if (!query) {
      return [];
    }
    return (records || []).filter(function (record) {
      return matchingRegionOrientations(record, region, query.start, query.end, query.partnerRangeSpecified, query.partnerStart, query.partnerEnd).length > 0;
    });
  }

  // Region Explorer aggregation (partners, profile) over matched records.
  function regionResultsFromRecords(matchedRecords, region) {
    const query = regionQuery(region);
    if (!query) {
      return emptyRegionResults();
    }
    const start = query.start;
    const end = query.end;
    const partnerRangeSpecified = query.partnerRangeSpecified;
    const partnerStart = query.partnerStart;
    const partnerEnd = query.partnerEnd;
    const matches = matchedRecords || [];

    const partnerMap = Object.create(null);
    matches.forEach(function (record) {
      const orientation = matchingRegionOrientations(record, region, start, end, partnerRangeSpecified, partnerStart, partnerEnd)[0];
      const partner = orientation.partner;
      const current = partnerMap[partner] || { name: partner, records: 0, support: 0 };
      current.records += 1;
      current.support += record.supportCount;
      partnerMap[partner] = current;
    });

    const profile = buildRegionProfile(matches, region.rna, start, end);
    return {
      records: matches,
      support: matches.reduce(function (total, record) { return total + record.supportCount; }, 0),
      partners: Object.keys(partnerMap).map(function (name) { return partnerMap[name]; })
        .sort(function (left, right) { return right.support - left.support || left.name.localeCompare(right.name); }),
      profile: profile.bins,
      profileBinSize: profile.binSize,
      profileBinSizeAdjusted: profile.adjusted,
      profileBinUpdates: profile.binUpdates,
      profileRangeUpdates: profile.rangeUpdates
    };
  }

  function emptyRegionResults() {
    return {
      records: [],
      support: 0,
      partners: [],
      profile: [],
      profileBinSize: 1,
      profileBinSizeAdjusted: false,
      profileBinUpdates: 0,
      profileRangeUpdates: 0
    };
  }

  function matchingRegionOrientations(record, region, start, end, partnerRangeSpecified, partnerStart, partnerEnd) {
    const orientations = [];
    if (record.rnaOne === region.rna) {
      orientations.push({
        anchorStart: record.rnaOneStart,
        anchorEnd: record.rnaOneEnd,
        partner: record.rnaTwo,
        partnerStart: record.rnaTwoStart,
        partnerEnd: record.rnaTwoEnd
      });
    }
    if (record.rnaTwo === region.rna) {
      orientations.push({
        anchorStart: record.rnaTwoStart,
        anchorEnd: record.rnaTwoEnd,
        partner: record.rnaOne,
        partnerStart: record.rnaOneStart,
        partnerEnd: record.rnaOneEnd
      });
    }
    return orientations.filter(function (orientation) {
      if (!matchesOverlapRule(orientation.anchorStart, orientation.anchorEnd, start, end, region.overlap)) {
        return false;
      }
      if (region.partner && orientation.partner !== region.partner) {
        return false;
      }
      return !partnerRangeSpecified || matchesOverlapRule(
        orientation.partnerStart,
        orientation.partnerEnd,
        partnerStart,
        partnerEnd,
        region.overlap
      );
    });
  }

  function matchesOverlapRule(recordStart, recordEnd, regionStart, regionEnd, rule) {
    if (rule === "contained") {
      return recordStart >= regionStart && recordEnd <= regionEnd;
    }
    return recordStart <= regionEnd && recordEnd >= regionStart;
  }

  function buildRegionProfile(records, rna, start, end) {
    const span = Math.max(1, end - start + 1);
    const requestedBinSize = span > 1000 ? 50 : span > 500 ? 25 : 10;
    const maximumBins = 30000;
    const binSize = Math.max(requestedBinSize, Math.ceil(span / maximumBins));
    const binCount = Math.ceil(span / binSize);
    const profile = [];
    const difference = new Float64Array(binCount + 1);
    let binUpdates = 0;
    let rangeUpdates = 0;

    for (let index = 0; index < binCount; index += 1) {
      const binStart = start + index * binSize;
      profile.push({ start: binStart, end: Math.min(end, binStart + binSize - 1), value: 0 });
    }

    records.forEach(function (record) {
      const arms = [];
      if (record.rnaOne === rna) {
        arms.push({ start: record.rnaOneStart, end: record.rnaOneEnd });
      }
      if (record.rnaTwo === rna) {
        arms.push({ start: record.rnaTwoStart, end: record.rnaTwoEnd });
      }
      arms.forEach(function (arm) {
        const armStart = Math.max(start, arm.start);
        const armEnd = Math.min(end, arm.end);
        if (armStart > armEnd) {
          return;
        }
        const firstBin = Math.max(0, Math.floor((armStart - start) / binSize));
        const lastBin = Math.min(binCount - 1, Math.floor((armEnd - start) / binSize));
        const value = Number(record.supportCount) || 0;

        // Every overlapped Region bin receives the complete arm support. Use a
        // difference array so a long arm costs one range update instead of one
        // main-thread mutation per covered bin. `binUpdates` intentionally
        // retains its previous meaning: the number of logical arm/bin
        // contributions represented by the profile.
        difference[firstBin] += value;
        difference[lastBin + 1] -= value;
        binUpdates += lastBin - firstBin + 1;
        rangeUpdates += 1;
      });
    });

    let runningValue = 0;
    for (let index = 0; index < binCount; index += 1) {
      runningValue += difference[index];
      profile[index].value = runningValue;
    }

    return {
      bins: profile,
      binSize: binSize,
      adjusted: binSize !== requestedBinSize,
      binUpdates: binUpdates,
      rangeUpdates: rangeUpdates
    };
  }

  function getViewpointResults(state) {
    const viewpoint = state.viewpoint || defaultViewpointState(state.summary, state.records);
    const reference = findFastaEntry(state.fasta, viewpoint.rna);
    return viewpointResultsFromRecords(viewpoint, state.records || [], {
      extent: getRnaExtent(state.records || [], viewpoint.rna, state.summary),
      referenceLength: reference ? reference.sequence.length : null
    });
  }

  // Resolves the inclusive Viewpoint interval. `context.extent` is the RNA's
  // observed {min,max}; `context.referenceLength` is the mapped reference
  // length or null. Returns null when the interval is invalid.
  function viewpointRange(viewpoint, context) {
    const options = context || {};
    const extent = options.extent || null;
    const hasReference = Number.isSafeInteger(options.referenceLength) && options.referenceLength > 0;
    const requestedStart = coordinateOrNull(viewpoint.start);
    const requestedEnd = coordinateOrNull(viewpoint.end);
    const useReferenceRange = viewpoint.rangeMode === "reference" && hasReference;
    if (viewpoint.rangeMode === "reference" && !hasReference) {
      return null;
    }
    const invalidRequestedRange = !useReferenceRange && (
      (String(viewpoint.start == null ? "" : viewpoint.start).trim() && requestedStart === null) ||
      (String(viewpoint.end == null ? "" : viewpoint.end).trim() && requestedEnd === null)
    );
    if (invalidRequestedRange) {
      return null;
    }
    const start = useReferenceRange ? 1 : (requestedStart === null ? (extent ? extent.min : null) : requestedStart);
    const end = useReferenceRange ? options.referenceLength : (requestedEnd === null ? (extent ? extent.max : null) : requestedEnd);
    if (!viewpoint.rna || start === null || end === null || start > end) {
      return null;
    }
    return { start: start, end: end };
  }

  // Viewpoint coverage over the supplied records (typically the arms returned
  // by DataProvider.getArms()). Records without a contributing arm are ignored.
  function viewpointResultsFromRecords(viewpoint, records, context) {
    const options = context || {};
    const extent = options.extent || null;
    const reference = Number.isSafeInteger(options.referenceLength) && options.referenceLength > 0
      ? { sequence: { length: options.referenceLength } }
      : null;
    const requestedStart = coordinateOrNull(viewpoint.start);
    const requestedEnd = coordinateOrNull(viewpoint.end);
    const useReferenceRange = viewpoint.rangeMode === "reference" && reference;
    if (viewpoint.rangeMode === "reference" && !reference) {
      return emptyViewpointResults();
    }
    const invalidRequestedRange = !useReferenceRange && (
      (String(viewpoint.start == null ? "" : viewpoint.start).trim() && requestedStart === null) ||
      (String(viewpoint.end == null ? "" : viewpoint.end).trim() && requestedEnd === null)
    );
    if (invalidRequestedRange) {
      return emptyViewpointResults();
    }
    const start = useReferenceRange ? 1 : (requestedStart === null ? (extent ? extent.min : null) : requestedStart);
    const end = useReferenceRange ? reference.sequence.length : (requestedEnd === null ? (extent ? extent.max : null) : requestedEnd);

    if (!viewpoint.rna || start === null || end === null || start > end) {
      return emptyViewpointResults();
    }

    const requestedBinSize = Math.max(1, Math.floor(Number(viewpoint.binSize) || 1));
    const span = end - start + 1;
    const maximumBins = 30000;
    const binSize = Math.max(requestedBinSize, Math.ceil(span / maximumBins));
    const binCount = Math.ceil(span / binSize);
    const bins = Array.from({ length: binCount }, function (_, index) {
      const binStart = start + index * binSize;
      return {
        start: binStart,
        end: Math.min(end, binStart + binSize - 1),
        coverageTotal: 0,
        value: 0
      };
    });
    const boundaryCoverage = new Float64Array(binCount);
    const fullBinDifference = new Float64Array(binCount + 1);
    const matches = [];
    let armContributions = 0;
    let coverageBoundaryUpdates = 0;
    let coverageRangeUpdates = 0;

    (records || []).forEach(function (record) {
      const arms = getViewpointArms(record, viewpoint.rna, viewpoint.partner, viewpoint.chimeraType, viewpoint.homodimer);
      if (!arms.length) {
        return;
      }

      let contributed = false;
      arms.forEach(function (arm) {
        const armStart = Math.max(start, arm.start);
        const armEnd = Math.min(end, arm.end);
        if (armStart > armEnd) {
          return;
        }
        contributed = true;
        armContributions += 1;
        const value = viewpoint.measure === "support" ? record.supportCount : 1;
        const firstBin = Math.max(0, Math.floor((armStart - start) / binSize));
        const lastBin = Math.min(binCount - 1, Math.floor((armEnd - start) / binSize));

        if (firstBin === lastBin) {
          boundaryCoverage[firstBin] += (armEnd - armStart + 1) * value;
          coverageBoundaryUpdates += 1;
          return;
        }

        // Only the two boundary bins can be partially covered. Every bin
        // strictly between them is covered in full and therefore receives the
        // same per-nucleotide value; represent that run with one difference
        // update. Endpoints remain inclusive.
        boundaryCoverage[firstBin] += (bins[firstBin].end - armStart + 1) * value;
        boundaryCoverage[lastBin] += (armEnd - bins[lastBin].start + 1) * value;
        coverageBoundaryUpdates += 2;

        const firstFullBin = firstBin + 1;
        const lastFullBin = lastBin - 1;
        if (firstFullBin <= lastFullBin) {
          fullBinDifference[firstFullBin] += value;
          fullBinDifference[lastFullBin + 1] -= value;
          coverageRangeUpdates += 1;
        }
      });
      if (contributed) {
        matches.push(record);
      }
    });

    let fullBinValue = 0;
    bins.forEach(function (bin, index) {
      fullBinValue += fullBinDifference[index];
      const binWidth = Math.max(1, bin.end - bin.start + 1);
      bin.coverageTotal = boundaryCoverage[index] + fullBinValue * binWidth;
      bin.value = bin.coverageTotal / binWidth;
    });

    return {
      ready: true,
      rna: viewpoint.rna,
      start: start,
      end: end,
      requestedBinSize: requestedBinSize,
      binSize: binSize,
      binSizeAdjusted: binSize !== requestedBinSize,
      records: matches,
      armContributions: armContributions,
      coverageBoundaryUpdates: coverageBoundaryUpdates,
      coverageRangeUpdates: coverageRangeUpdates,
      bins: bins,
      max: bins.reduce(function (maximum, bin) { return Math.max(maximum, bin.value); }, 0),
      totalCoverage: bins.reduce(function (total, bin) { return total + bin.coverageTotal; }, 0)
    };
  }

  function emptyViewpointResults() {
    return {
      ready: false,
      rna: "",
      start: null,
      end: null,
      requestedBinSize: 1,
      binSize: 1,
      binSizeAdjusted: false,
      records: [],
      armContributions: 0,
      coverageBoundaryUpdates: 0,
      coverageRangeUpdates: 0,
      bins: [],
      max: 0,
      totalCoverage: 0
    };
  }

  function getViewpointArms(record, rna, partner, chimeraType, homodimer) {
    if (chimeraType && chimeraType !== "all" && record.chimeraType !== chimeraType) {
      return [];
    }
    if (!matchesHomodimerSubset(record, homodimer)) {
      return [];
    }

    const arms = [];
    if (record.rnaOne === rna && (!partner || record.rnaTwo === partner)) {
      arms.push({ start: record.rnaOneStart, end: record.rnaOneEnd });
    }
    if (record.rnaTwo === rna && (!partner || record.rnaOne === partner)) {
      arms.push({ start: record.rnaTwoStart, end: record.rnaTwoEnd });
    }
    return arms;
  }

  function viewpointToTsv(results) {
    const rows = [["start", "end", "mean_interaction_coverage"]];
    (results && results.bins ? results.bins : []).forEach(function (bin) {
      rows.push([bin.start, bin.end, bin.value]);
    });
    return rows.map(function (row) { return row.join("\t"); }).join("\n");
  }

  // Results up to this size keep the original object shape (own `datasets`
  // arrays and a `cellMap` object); larger ones build a cell's per-dataset
  // values on demand and are looked up with comparisonCellAt().
  const SMALL_COMPARISON_CELLS = 100000;

  // A comparison is built in three steps so that the heavy middle one can run
  // in comparison.worker.js:
  //   prepareComparison(config)        datasets, groups and a plain input
  //   computeComparison(input, binsAt) typed arrays in (x, y) order (no DOM,
  //                                    no dataset objects; worker-safe)
  //   comparisonResultBuilder(...)     the cell objects the pages read, in
  //                                    steps the page can spread over frames
  // buildComparisonResults() runs all three at once.
  //
  // hasSource(dataset) says whether a dataset can contribute contact bins;
  // by default prefetched DataProvider bins (`contactBins`, built with
  // comparisonContactQuery()) or in-memory records.
  function prepareComparison(comparison, hasSource) {
    const config = comparison || {};
    const usable = typeof hasSource === "function" ? hasSource : function (dataset) {
      return Array.isArray(dataset.records) || !!dataset.contactBins;
    };
    const datasets = (config.datasets || []).filter(function (dataset) {
      return dataset && dataset.summary && usable(dataset);
    });
    const groupA = datasets.filter(function (dataset) { return dataset.condition === "A"; });
    const groupB = datasets.filter(function (dataset) { return dataset.condition === "B"; });

    if (!config.rnaX || !config.rnaY || !groupA.length || !groupB.length) {
      return {
        ready: false,
        result: {
          ready: false,
          reason: !groupA.length || !groupB.length
            ? (!groupB.length && groupA.length
              ? "Condition B has no dataset yet. Use Add HYB datasets for the second sample, then set its Condition to B."
              : "Condition A has no dataset yet. Set at least one dataset's Condition to A.")
            : "Choose RNA X and RNA Y to compare.",
          groupA: groupA,
          groupB: groupB,
          cells: [],
          conservedCells: []
        }
      };
    }

    const template = comparisonContactQuery(config);
    const allDatasets = groupA.concat(groupB);
    return {
      ready: true,
      groupA: groupA,
      groupB: groupB,
      allDatasets: allDatasets,
      template: template,
      // structured-cloneable: what the worker needs
      input: {
        normalise: config.normalise,
        similarityMinimum: similarityMinimumOf(config),
        datasets: allDatasets.map(function (dataset) {
          return {
            condition: dataset.condition,
            librarySize: template.measure === "support"
              ? Number(dataset.summary.supportInteractions || 0)
              : Number(dataset.summary.validRecords || 0),
            query: comparisonContactQuery(config, dataset)
          };
        })
      }
    };
  }

  // The numeric half of a comparison.  binsAt(datasetIndex) returns the
  // contact bins ({ ready, reason, x, y, count }) of input.datasets[index];
  // it is called once per dataset, in order, and not after a failure.
  // Returns { failure, datasetCellContributions }, { empty: true } or the
  // cells as typed arrays in (x, y) order.  options.effectOrder adds the
  // cell positions by |effect|, largest first (comparisonOrder()).
  function computeComparison(input, binsAt, options) {
    const datasets = input.datasets || [];
    const datasetCount = datasets.length;
    const groupACount = datasets.filter(function (dataset) { return dataset.condition === "A"; }).length;
    const groupBCount = datasetCount - groupACount;
    // cell rows in first-seen order; per dataset the rows it covers and its
    // raw values there
    // every dataset's bins first (in order; a failed dataset ends the list),
    // so one box over them sizes the cell index
    const allBins = [];
    for (let d = 0; d < datasetCount; d += 1) {
      const b = binsAt(d);
      allBins.push(b);
      if (b.ready === false) {
        break;
      }
    }
    let boxXMin = Infinity;
    let boxXMax = -Infinity;
    let boxYMin = Infinity;
    let boxYMax = -Infinity;
    let sharedBin = null;
    allBins.forEach(function (b) {
      if (b.ready === false) {
        return;
      }
      sharedBin = sharedBin === null ? Number(b.binSize) : (sharedBin === Number(b.binSize) ? sharedBin : NaN);
      const bx = b.x || [];
      const by = b.y || [];
      for (let i = 0; i < bx.length; i += 1) {
        if (bx[i] < boxXMin) boxXMin = bx[i];
        if (bx[i] > boxXMax) boxXMax = bx[i];
        if (by[i] < boxYMin) boxYMin = by[i];
        if (by[i] > boxYMax) boxYMax = by[i];
      }
    });
    const index = Number.isFinite(boxXMin) && sharedBin > 0
      ? cellIndex(boxXMin, boxXMax, boxYMin, boxYMax, sharedBin)
      : cellIndex(0, 0, 0, 0, 0);
    const cellX = [];
    const cellY = [];
    const perDataset = [];
    let matrixFailure = "";
    let datasetCellContributions = 0;

    for (let datasetIndex = 0; datasetIndex < datasetCount && !matrixFailure; datasetIndex += 1) {
      const dataset = datasets[datasetIndex];
      const bins = allBins[datasetIndex];
      if (bins.ready === false) {
        matrixFailure = bins.reason || "A dataset exceeded the browser contact-map limits.";
        break;
      }
      const xs = bins.x || [];
      const ys = bins.y || [];
      const counts = bins.count || [];
      if (datasetCellContributions + xs.length > MAX_COMPARISON_DATASET_CELLS) {
        matrixFailure = "The combined maps contain more than " + MAX_COMPARISON_DATASET_CELLS.toLocaleString("en-US") + " dataset-cell contributions. Increase the bin size or compare fewer datasets.";
        break;
      }
      datasetCellContributions += xs.length;
      const rows = new Int32Array(xs.length);
      const values = new Float64Array(xs.length);
      for (let cell = 0; cell < xs.length; cell += 1) {
        let row = index.get(xs[cell], ys[cell]);
        if (row < 0) {
          if (cellX.length >= MAX_COMPARISON_CELLS) {
            matrixFailure = "The combined maps cover more than " + MAX_COMPARISON_CELLS.toLocaleString("en-US") + " distinct cells. Increase the bin size or narrow the RNA pair.";
            break;
          }
          row = cellX.length;
          index.set(xs[cell], ys[cell], row);
          cellX.push(xs[cell]);
          cellY.push(ys[cell]);
        }
        rows[cell] = row;
        values[cell] = counts[cell];
      }
      perDataset.push({
        isA: dataset.condition === "A",
        rows: rows,
        values: values,
        scale: input.normalise === "library" ? 1000000 / Math.max(1, dataset.librarySize) : 1
      });
    }

    if (matrixFailure) {
      return { failure: matrixFailure, datasetCellContributions: datasetCellContributions };
    }

    const distinctCellCount = cellX.length;
    if (!distinctCellCount) {
      return { empty: true };
    }

    const aTotal = new Float64Array(distinctCellCount);
    const bTotal = new Float64Array(distinctCellCount);
    const aRaw = new Float64Array(distinctCellCount);
    const bRaw = new Float64Array(distinctCellCount);
    const present = new Int32Array(distinctCellCount);
    // raw value of every dataset in every cell (by row), NaN where the
    // dataset has none
    const rawByRow = perDataset.map(function (entry) {
      const dense = new Float64Array(distinctCellCount).fill(NaN);
      for (let cell = 0; cell < entry.rows.length; cell += 1) {
        const row = entry.rows[cell];
        const value = entry.values[cell];
        dense[row] = value;
        if (entry.isA) {
          aTotal[row] += value * entry.scale;
          aRaw[row] += value;
        } else {
          bTotal[row] += value * entry.scale;
          bRaw[row] += value;
        }
        present[row] += 1;
      }
      return dense;
    });

    const pseudocount = input.normalise === "library" ? 1 : 0.5;
    // Similarity heatmap as in HYB's plot_similarity_map run on one merged
    // contact map per condition (the condition's .hyb files concatenated):
    // a bin kept in both maps scores the smaller raw count.  Bins below the
    // minimum count are dropped from each map first (1 keeps every bin); this
    // display filter equals awk '$3 >= MIN' on each merged contact.txt before
    // plot_similarity_map.  As in plot_similarity_map with one file per side
    // and Desktop's differential.py -- not bin/rnaxray_compare with replicates,
    // which concatenates every replicate's contact.txt and pairs consecutive
    // occurrences of a bin (A1/A2, A2/B1, B1/B2).
    const similarityMinimum = input.similarityMinimum;
    // rows by x, then y (cells are distinct, so there are no ties)
    let order;
    if (index.dense) {
      order = index.rowsInOrder(distinctCellCount);
    } else {
      order = new Int32Array(distinctCellCount);
      for (let row = 0; row < distinctCellCount; row += 1) {
        order[row] = row;
      }
      order.sort(function (left, right) { return cellX[left] - cellX[right] || cellY[left] - cellY[right]; });
    }
    const out = {
      count: distinctCellCount,
      datasetCellContributions: datasetCellContributions,
      similarityMinimum: similarityMinimum,
      scales: perDataset.map(function (entry) { return entry.scale; }),
      x: new Float64Array(distinctCellCount),
      y: new Float64Array(distinctCellCount),
      conditionA: new Float64Array(distinctCellCount),
      conditionB: new Float64Array(distinctCellCount),
      effect: new Float64Array(distinctCellCount),
      present: new Int32Array(distinctCellCount),
      rawA: new Float64Array(distinctCellCount),
      rawB: new Float64Array(distinctCellCount),
      similarity: new Float64Array(distinctCellCount),
      // per dataset, by position
      raw: rawByRow.map(function () { return new Float64Array(distinctCellCount); }),
      conserved: null,
      effectOrder: null
    };
    const absoluteEffects = new Float64Array(distinctCellCount);
    let conservedCount = 0;
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let position = 0; position < distinctCellCount; position += 1) {
      const row = order[position];
      const conditionA = aTotal[row] / groupACount;
      const conditionB = bTotal[row] / groupBCount;
      const x = cellX[row];
      const y = cellY[row];
      const effect = Math.log2((conditionA + pseudocount) / (conditionB + pseudocount));
      const similarity = aRaw[row] >= similarityMinimum && bRaw[row] >= similarityMinimum ? Math.min(aRaw[row], bRaw[row]) : 0;
      out.x[position] = x;
      out.y[position] = y;
      out.conditionA[position] = conditionA;
      out.conditionB[position] = conditionB;
      out.effect[position] = effect;
      out.present[position] = present[row];
      out.rawA[position] = aRaw[row];
      out.rawB[position] = bRaw[row];
      out.similarity[position] = similarity;
      for (let datasetIndex = 0; datasetIndex < rawByRow.length; datasetIndex += 1) {
        out.raw[datasetIndex][position] = rawByRow[datasetIndex][row];
      }
      absoluteEffects[position] = Math.abs(effect);
      if (similarity > 0) conservedCount += 1;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    out.conserved = new Int32Array(conservedCount);
    const similarityValues = new Float64Array(conservedCount);
    for (let position = 0, next = 0; position < distinctCellCount; position += 1) {
      if (out.similarity[position] > 0) {
        out.conserved[next] = position;
        similarityValues[next] = out.similarity[position];
        next += 1;
      }
    }
    if (options && options.effectOrder) {
      out.effectOrder = effectOrderOf(absoluteEffects);
    }
    absoluteEffects.sort();
    similarityValues.sort();
    out.xMin = xMin;
    out.xMax = xMax;
    out.yMin = yMin;
    out.yMax = yMax;
    out.effectCap = absoluteEffects.length ? Math.max(.25, quantile(absoluteEffects, .95)) : 1;
    // similarity_heatmap.R caps the counts at their 95% quantile and lets
    // scale_fill_gradient span the data range: white at the smallest kept
    // count (similarityFloor), forestgreen at the cap.
    out.similarityCap = similarityValues.length ? Math.max(1, quantile(similarityValues, .95)) : 1;
    out.similarityFloor = similarityValues.length ? similarityValues[0] : 0;
    return out;
  }

  // positions by descending value, ties in position order: the order of a
  // stable cells.slice().sort() on that value.  Values are >= 0 and finite,
  // so their IEEE bits sort like the numbers: a stable radix sort on the
  // inverted bits (four 16-bit passes) gives that order without a JS
  // comparator call per comparison (seconds for 838,000 cells).
  const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  function effectOrderOf(absoluteEffects) {
    const n = absoluteEffects.length;
    let order = new Int32Array(n);
    for (let position = 0; position < n; position += 1) {
      order[position] = position;
    }
    let radix = LITTLE_ENDIAN && n > 1;
    for (let i = 0; radix && i < n; i += 1) {
      const v = absoluteEffects[i];
      if (!(v >= 0) || v === Infinity) {
        radix = false;
      }
    }
    if (!radix) {
      return order.sort(function (left, right) { return absoluteEffects[right] - absoluteEffects[left] || left - right; });
    }
    // a copy: the caller sorts absoluteEffects in place afterwards
    const values = new Float64Array(absoluteEffects);
    const words = new Uint32Array(values.buffer);
    const lo = new Uint32Array(n);
    const hi = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) {
      lo[i] = ~words[2 * i] >>> 0;
      hi[i] = ~words[2 * i + 1] >>> 0;
    }
    let next = new Int32Array(n);
    const counts = new Uint32Array(65536);
    [[lo, 0], [lo, 16], [hi, 0], [hi, 16]].forEach(function (pass) {
      const key = pass[0];
      const shift = pass[1];
      counts.fill(0);
      for (let i = 0; i < n; i += 1) {
        counts[(key[order[i]] >>> shift) & 0xffff] += 1;
      }
      let sum = 0;
      for (let b = 0; b < 65536; b += 1) {
        const c = counts[b];
        counts[b] = sum;
        sum += c;
      }
      for (let i = 0; i < n; i += 1) {
        const p = order[i];
        next[counts[(key[p] >>> shift) & 0xffff]++] = p;
      }
      const swap = order;
      order = next;
      next = swap;
    });
    return order;
  }

  // The buffers of a computeComparison() result, for postMessage transfer.
  function comparisonTransfers(packed) {
    if (!packed || !packed.count) {
      return [];
    }
    return ["x", "y", "conditionA", "conditionB", "effect", "present", "rawA", "rawB", "similarity", "conserved", "effectOrder"]
      .map(function (key) { return packed[key]; })
      .concat(packed.raw)
      .filter(Boolean)
      .map(function (array) { return array.buffer; });
  }

  // Index of cell (x, y) in arrays sorted by x then y, or -1.
  function sortedCellPosition(xs, ys, x, y) {
    let low = 0;
    let high = xs.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const cellXValue = xs[middle];
      const cellYValue = ys[middle];
      if (cellXValue === x && cellYValue === y) {
        return middle;
      }
      if (cellXValue < x || (cellXValue === x && cellYValue < y)) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return -1;
  }

  // Turns computeComparison() output into the result the pages read.
  // step(limit) creates up to `limit` more cells and returns true once the
  // result is complete; `result` is set then.  A failed or empty
  // comparison is complete at once.
  function comparisonResultBuilder(comparison, prepared, packed) {
    const config = comparison || {};
    const groupA = prepared.groupA;
    const groupB = prepared.groupB;
    const builder = { result: null, done: 0, total: 0, step: function () { return true; } };

    if (packed.failure) {
      builder.result = {
        ready: false,
        reason: "Comparison not generated. " + packed.failure,
        groupA: groupA,
        groupB: groupB,
        cells: [],
        conservedCells: [],
        limitExceeded: true,
        maximumCells: MAX_COMPARISON_CELLS,
        maximumDatasetCells: MAX_COMPARISON_DATASET_CELLS,
        datasetCellContributions: packed.datasetCellContributions
      };
      return builder;
    }
    if (packed.empty) {
      builder.result = {
        ready: false,
        reason: "No interactions were found for the selected RNA pair across the assigned datasets.",
        groupA: groupA,
        groupB: groupB,
        cells: [],
        conservedCells: []
      };
      return builder;
    }

    const count = packed.count;
    const allDatasets = prepared.allDatasets;
    const xs = packed.x;
    const ys = packed.y;
    const raw = packed.raw;
    const scales = packed.scales;
    const small = count <= SMALL_COMPARISON_CELLS;
    function datasetValues(position) {
      const list = [];
      allDatasets.forEach(function (dataset, datasetIndex) {
        const rawValue = raw[datasetIndex][position];
        if (rawValue === rawValue) {
          list.push({
            id: dataset.id,
            label: dataset.label || dataset.fileName,
            condition: dataset.condition,
            rawValue: rawValue,
            value: rawValue * scales[datasetIndex]
          });
        }
      });
      return list;
    }
    // a large map's cells share one shape (a constructor allocates them
    // much faster than adding properties one by one) and a prototype getter
    // for their per-dataset values; JSON and Object.keys see the same fields
    function LazyCell(position) {
      this.x = xs[position];
      this.y = ys[position];
      this.conditionA = packed.conditionA[position];
      this.conditionB = packed.conditionB[position];
      this.effect = packed.effect[position];
      this.presentDatasets = packed.present[position];
      this.rawA = packed.rawA[position];
      this.rawB = packed.rawB[position];
      this.similarity = packed.similarity[position];
    }
    Object.defineProperty(LazyCell.prototype, "datasets", {
      get: function () { return datasetValues(sortedCellPosition(xs, ys, this.x, this.y)); }
    });
    const cells = new Array(count);
    builder.total = count;
    builder.step = function (limit) {
      const end = Math.min(count, builder.done + Math.max(1, limit));
      for (let position = builder.done; position < end; position += 1) {
        if (!small) {
          cells[position] = new LazyCell(position);
          continue;
        }
        const cell = {};
        cell.x = xs[position];
        cell.y = ys[position];
        cell.conditionA = packed.conditionA[position];
        cell.conditionB = packed.conditionB[position];
        cell.effect = packed.effect[position];
        cell.presentDatasets = packed.present[position];
        cell.rawA = packed.rawA[position];
        cell.rawB = packed.rawB[position];
        cell.similarity = packed.similarity[position];
        cell.datasets = datasetValues(position);
        cells[position] = cell;
      }
      builder.done = end;
      if (end < count) {
        return false;
      }
      if (!builder.result) {
        builder.result = finish();
      }
      return true;
    };

    function finish() {
      const conservedCells = Array.from(packed.conserved, function (position) { return cells[position]; });
      const result = {
        ready: true,
        limitExceeded: false,
        groupA: groupA,
        groupB: groupB,
        cells: cells,
        cellMap: small ? Object.fromEntries(cells.map(function (cell) { return [cell.x + ":" + cell.y, cell]; })) : null,
        conservedCells: conservedCells,
        binSize: prepared.template.binSize,
        xMin: packed.xMin,
        xMax: packed.xMax,
        yMin: packed.yMin,
        yMax: packed.yMax,
        effectCap: packed.effectCap,
        similarityCap: packed.similarityCap,
        similarityFloor: packed.similarityFloor,
        similarityMinimum: packed.similarityMinimum,
        distinctCells: count,
        datasetCellContributions: packed.datasetCellContributions,
        maximumCells: MAX_COMPARISON_CELLS,
        maximumDatasetCells: MAX_COMPARISON_DATASET_CELLS,
        normalise: config.normalise || "library",
        measure: prepared.template.measure,
        rnaPairs: comparisonRnaPlan(config).filter(function (item) { return item.substituted; }).map(function (item) {
          return { id: item.dataset.id, label: item.dataset.label || item.dataset.fileName || item.dataset.id, rnaX: item.rnaX, rnaY: item.rnaY };
        })
      };
      // cell lookup for comparisonCellAt(), kept out of JSON and report exports
      Object.defineProperty(result, "cellLookup", {
        value: function (x, y) {
          const position = sortedCellPosition(xs, ys, Number(x), Number(y));
          return position < 0 ? null : cells[position];
        }
      });
      if (packed.effectOrder) {
        comparisonOrders.set(result, { effect: packed.effectOrder });
      }
      return result;
    }
    return builder;
  }

  function buildComparisonResults(comparison) {
    const config = comparison || {};
    const prepared = prepareComparison(config);
    if (!prepared.ready) {
      return prepared.result;
    }
    const packed = computeComparison(prepared.input, function (datasetIndex) {
      const dataset = prepared.allDatasets[datasetIndex];
      return dataset.contactBins
        ? dataset.contactBins
        : buildContactBins(dataset.records, prepared.input.datasets[datasetIndex].query);
    });
    const builder = comparisonResultBuilder(config, prepared, packed);
    builder.step(Infinity);
    return builder.result;
  }

  // The comparison cell at bin start (x, y), or null.
  function comparisonCellAt(result, x, y) {
    if (!result) {
      return null;
    }
    if (typeof result.cellLookup === "function") {
      return result.cellLookup(x, y);
    }
    return result.cellMap && result.cellMap[x + ":" + y] || null;
  }

  // Positions into result.cells in a table order, computed once per result
  // and key: "effect" (|log2 effect|, largest first), "similarity" (largest
  // first) or "position" (x, then y: result.cells itself, returns null).
  // Ties keep position order, as a stable sort of result.cells would.
  const comparisonOrders = new WeakMap();
  const COMPARISON_ORDER_KEYS = ["effect", "similarity", "position"];

  function comparisonOrder(result, key) {
    const sortKey = COMPARISON_ORDER_KEYS.indexOf(key) >= 0 ? key : "effect";
    if (!result || !Array.isArray(result.cells) || sortKey === "position") {
      return null;
    }
    let orders = comparisonOrders.get(result);
    if (!orders) {
      orders = {};
      comparisonOrders.set(result, orders);
    }
    if (orders[sortKey]) {
      return orders[sortKey];
    }
    const cells = result.cells;
    let order;
    if (sortKey === "effect") {
      const absoluteEffects = new Float64Array(cells.length);
      for (let position = 0; position < cells.length; position += 1) {
        absoluteEffects[position] = Math.abs(cells[position].effect);
      }
      order = effectOrderOf(absoluteEffects);
    } else {
      // similarity: the shared cells sorted, then every other cell (0) in
      // position order
      const sharedPositions = [];
      for (let position = 0; position < cells.length; position += 1) {
        if (cells[position].similarity > 0) {
          sharedPositions.push(position);
        }
      }
      const shared = Int32Array.from(sharedPositions);
      shared.sort(function (left, right) { return cells[right].similarity - cells[left].similarity || left - right; });
      order = new Int32Array(cells.length);
      order.set(shared);
      let next = shared.length;
      for (let position = 0; position < cells.length; position += 1) {
        if (!(cells[position].similarity > 0)) {
          order[next] = position;
          next += 1;
        }
      }
    }
    orders[sortKey] = order;
    return order;
  }

  // Cells start..start+count-1 of result.cells in comparisonOrder(key).
  function comparisonOrderedCells(result, key, start, count) {
    const cells = result && Array.isArray(result.cells) ? result.cells : [];
    const from = Math.max(0, Math.min(cells.length, Math.floor(Number(start) || 0)));
    const to = Math.min(cells.length, from + Math.max(0, Math.floor(Number(count) || 0)));
    const order = comparisonOrder(result, key);
    if (!order) {
      return cells.slice(from, to);
    }
    const list = new Array(to - from);
    for (let index = from; index < to; index += 1) {
      list[index - from] = cells[order[index]];
    }
    return list;
  }

  // Which RNA pair each assigned dataset contributes.  A dataset that has the
  // chosen RNA X and RNA Y uses them.  For a homodimer map (RNA X = RNA Y) a
  // dataset without that RNA uses its own RNA with the closest name instead
  // (another strain's genome, as ZAFR vs ZILM): its map is compared bin by
  // bin on its own coordinates, as bin/rnaxray_compare compares each dataset's
  // contact map by position.  The choice can be changed in the differential
  // test card (comparison.deseq.rnaByDataset), which uses the same rule.
  function comparisonRnaPlan(comparison) {
    const config = comparison || {};
    const homodimer = !!config.rnaX && config.rnaX === config.rnaY;
    const chosen = config.deseq && config.deseq.rnaByDataset || {};
    return (config.datasets || []).filter(function (dataset) {
      return dataset && (dataset.condition === "A" || dataset.condition === "B");
    }).map(function (dataset) {
      const names = dataset.summary && dataset.summary.rnaNames || [];
      const has = names.indexOf(config.rnaX) >= 0 && names.indexOf(config.rnaY) >= 0;
      if (!homodimer || has || !names.length) {
        return { dataset: dataset, rnaX: config.rnaX, rnaY: config.rnaY, substituted: false };
      }
      const rna = chosen[dataset.id] && names.indexOf(chosen[dataset.id]) >= 0 ? chosen[dataset.id] : names.slice().sort(function (left, right) {
        return nameSimilarity(right, config.rnaX) - nameSimilarity(left, config.rnaX) || left.localeCompare(right);
      })[0];
      return { dataset: dataset, rnaX: rna, rnaY: rna, substituted: true };
    });
  }

  // shared prefix + suffix length (deseq-card.js uses the same measure)
  function nameSimilarity(left, right) {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (suffix < left.length - prefix && suffix < right.length - prefix &&
      left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
      suffix += 1;
    }
    return prefix + suffix;
  }

  function similarityMinimumOf(comparison) {
    const value = Number(comparison && comparison.similarityMinimum);
    return Number.isFinite(value) && value > 1 ? value : 1;
  }

  // The per-dataset contact query a comparison uses; also what the page-data
  // layer passes to DataProvider.getContactBins() for each dataset.
  // With a dataset, its RNA pair from comparisonRnaPlan().
  function comparisonContactQuery(comparison, dataset) {
    const config = comparison || {};
    const pair = dataset ? comparisonRnaPlan(config).find(function (item) { return item.dataset.id === dataset.id; }) : null;
    return {
      rnaX: pair ? pair.rnaX : config.rnaX,
      rnaY: pair ? pair.rnaY : config.rnaY,
      binSize: Number(config.binSize) || 10,
      measure: config.measure === "support" ? "support" : "records",
      colourCap: "95",
      scale: "linear",
      orientation: "normalised",
      budget: "comparison"
    };
  }

  function comparisonToTsv(result) {
    const rows = [["x_start", "x_end", "y_start", "y_end", "condition_a_mean", "condition_b_mean", "log2_effect", "datasets_present", "condition_a_raw", "condition_b_raw", "similarity"]];
    if (!result || !result.cells) {
      return rows[0].join("\t");
    }
    result.cells.forEach(function (cell) {
      rows.push([
        cell.x,
        cell.x + result.binSize - 1,
        cell.y,
        cell.y + result.binSize - 1,
        cell.conditionA,
        cell.conditionB,
        cell.effect,
        cell.presentDatasets,
        cell.rawA,
        cell.rawB,
        cell.similarity
      ]);
    });
    return rows.map(function (row) { return row.join("\t"); }).join("\n");
  }

  function comparisonSelectedToTsv(comparison, selected, binSizeValue) {
    const rows = [["x_start", "x_end", "y_start", "y_end", "dataset_id", "label", "condition", "file_name", "raw_value", "analysis_value"]];
    if (!comparison || !selected) {
      return rows[0].join("\t");
    }
    const binSize = Number(binSizeValue) > 0 ? Number(binSizeValue) : Number(comparison.binSize) || 1;
    const present = Object.create(null);
    (selected.datasets || []).forEach(function (datasetValue) {
      present[datasetValue.id] = datasetValue;
    });
    (comparison.datasets || []).forEach(function (dataset) {
      const value = present[dataset.id];
      rows.push([
        selected.x,
        selected.x + binSize - 1,
        selected.y,
        selected.y + binSize - 1,
        dataset.id,
        dataset.label || dataset.fileName || "",
        dataset.condition || "",
        dataset.fileName || "",
        value ? value.rawValue : 0,
        value ? value.value : 0
      ]);
    });
    return rows.map(function (row) { return row.map(tsvCell).join("\t"); }).join("\n");
  }

  function comparisonCountMatrixToTsv(comparison, result) {
    const datasets = comparison && comparison.datasets || [];
    const rows = [["feature_id"].concat(datasets.map(function (dataset) { return dataset.id; }))];
    if (!result || !result.ready || !Array.isArray(result.cells)) {
      return rows[0].map(tsvCell).join("\t");
    }
    result.cells.slice().sort(function (left, right) {
      return left.x - right.x || left.y - right.y;
    }).forEach(function (cell) {
      const featureId = cell.x + "_" + cell.y;
      const present = Object.create(null);
      (cell.datasets || []).forEach(function (entry) { present[entry.id] = entry.rawValue; });
      rows.push([featureId].concat(datasets.map(function (dataset) {
        const rawCount = Object.prototype.hasOwnProperty.call(present, dataset.id) ? present[dataset.id] : 0;
        return validateLegacyRCount(rawCount, featureId, dataset.id);
      })));
    });
    return rows.map(function (row) { return row.map(tsvCell).join("\t"); }).join("\n");
  }

  function comparisonLegacyNamesToTsv(comparison) {
    return (comparison && comparison.datasets || []).map(function (dataset) {
      return [
        dataset.id,
        dataset.condition === "A" ? "condition_one" : "condition_two"
      ].map(tsvCell).join("\t");
    }).join("\n");
  }

  function comparisonSampleMetadataToTsv(comparison) {
    const rows = [["sample_id", "condition", "condition_label", "file_name"]];
    (comparison && comparison.datasets || []).forEach(function (dataset) {
      rows.push([
        dataset.id,
        dataset.condition === "A" ? "condition_one" : "condition_two",
        dataset.condition === "A" ? comparison.conditionALabel : comparison.conditionBLabel,
        dataset.fileName || dataset.summary && dataset.summary.fileName || ""
      ]);
    });
    return rows.map(function (row) { return row.map(tsvCell).join("\t"); }).join("\n");
  }

  function tsvCell(value) {
    return String(value == null ? "" : value).replace(/[\t\r\n]+/g, " ");
  }

  function validateLegacyRCount(value, featureId, sampleId) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        "Cannot export RNAxRay/DESeq2 counts: feature \"" + featureId + "\", sample \"" + sampleId +
        "\" is not a non-negative safe integer. Re-parse the HYB file or choose Record count instead of Cluster support."
      );
    }
    if (value > MAX_R_INTEGER_COUNT) {
      throw new Error(
        "Cannot export RNAxRay/DESeq2 counts: feature \"" + featureId + "\", sample \"" + sampleId +
        "\" exceeds the legacy R integer maximum of 2,147,483,647. Choose Record count, correct unusually large count_total values, or use a validated 64-bit workflow."
      );
    }
    return value;
  }

  function parseFasta(text) {
    const sequences = [];
    let current = null;

    String(text || "").replace(/\r/g, "").split("\n").forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      if (trimmed.charAt(0) === ">") {
        if (current) {
          sequences.push(current);
        }
        const header = trimmed.slice(1).trim();
        current = {
          header: header,
          id: header.split(/\s+/)[0] || "",
          sequence: ""
        };
        return;
      }

      if (current) {
        // Only whitespace is layout. Preserve every other symbol so a gap,
        // digit, or unsupported base can never silently shift coordinates.
        current.sequence += trimmed.replace(/\s+/g, "").toUpperCase();
      }
    });

    if (current) {
      sequences.push(current);
    }

    return sequences.filter(function (item) { return item.id && item.sequence; }).map(function (item) {
      item.invalidCharacters = Array.from(new Set(item.sequence.match(/[^ACGTU]/g) || []));
      return item;
    });
  }

  function buildFastaMapping(rnaNames, sequences) {
    const mapping = Object.create(null);
    const byHeader = Object.create(null);
    const byId = Object.create(null);
    const byLooseHeader = Object.create(null);
    const byLooseId = Object.create(null);

    function looseName(value) {
      return String(value || "").replace(/\|/g, "_");
    }

    (sequences || []).forEach(function (entry) {
      if (entry.header && byHeader[entry.header] === undefined) {
        byHeader[entry.header] = entry.id;
      }
      if (entry.id && byId[entry.id] === undefined) {
        byId[entry.id] = entry.id;
      }
      if (entry.header && looseName(entry.header) && byLooseHeader[looseName(entry.header)] === undefined) {
        byLooseHeader[looseName(entry.header)] = entry.id;
      }
      if (entry.id && looseName(entry.id) && byLooseId[looseName(entry.id)] === undefined) {
        byLooseId[looseName(entry.id)] = entry.id;
      }
    });

    (rnaNames || []).forEach(function (rna) {
      if (byHeader[rna] !== undefined || byId[rna] !== undefined) {
        mapping[rna] = byHeader[rna] !== undefined ? byHeader[rna] : byId[rna];
        return;
      }
      const alias = looseName(rna);
      if (byLooseHeader[alias] !== undefined || byLooseId[alias] !== undefined) {
        mapping[rna] = byLooseHeader[alias] !== undefined ? byLooseHeader[alias] : byLooseId[alias];
      }
    });

    return mapping;
  }

  function findFastaEntry(fasta, rna) {
    if (!fasta || !fasta.mapping || !fasta.sequences) {
      return null;
    }
    const id = fasta.mapping[rna];
    return fasta.sequences.find(function (entry) { return entry.id === id; }) || null;
  }

  function extractReference(fasta, rna, start, end) {
    const entry = findFastaEntry(fasta, rna);
    if (!entry) {
      return null;
    }
    const rawStart = String(start == null ? "" : start).trim();
    const rawEnd = String(end == null ? "" : end).trim();
    const parsedStart = coordinateOrNull(start);
    const parsedEnd = coordinateOrNull(end);
    if ((rawStart && parsedStart === null) || (rawEnd && parsedEnd === null)) {
      return null;
    }
    const left = parsedStart === null ? 1 : parsedStart;
    const right = Math.min(entry.sequence.length, parsedEnd === null ? entry.sequence.length : parsedEnd);
    if (left > right) {
      return null;
    }
    return {
      id: entry.id,
      header: entry.header,
      start: left,
      end: right,
      sequence: entry.sequence.slice(left - 1, right)
    };
  }

  function normaliseFoldSequence(input) {
    const lines = String(input || "").replace(/\r/g, "").split("\n");
    const raw = lines.filter(function (line) { return line.trim().charAt(0) !== ">"; }).join("");
    const sequence = raw.replace(/\s+/g, "").toUpperCase().replace(/T/g, "U");
    const invalid = sequence.match(/[^ACGU]/g);
    return {
      sequence: sequence,
      invalid: invalid ? Array.from(new Set(invalid)) : []
    };
  }

  function recordsToCsv(records) {
    const rows = [[
      "sequence_id",
      "rna_1",
      "rna_1_start",
      "rna_1_end",
      "rna_2",
      "rna_2_start",
      "rna_2_end",
      "support_count",
      "support_source",
      "raw_read_count",
      "overlap_score",
      "homodimer_overlap_ge_5",
      "chimera_type",
      "chimera_type_source",
      "dG",
      "line"
    ]];

    records.forEach(function (record) {
      rows.push([
        record.id,
        record.rnaOne,
        record.rnaOneStart,
        record.rnaOneEnd,
        record.rnaTwo,
        record.rnaTwoStart,
        record.rnaTwoEnd,
        record.supportCount,
        record.supportSource,
        record.rawReadCount === null ? "" : record.rawReadCount,
        record.overlapScore === null ? "" : record.overlapScore,
        record.isHomodimer ? "true" : "false",
        record.chimeraType,
        record.chimeraTypeSource,
        record.dg === null ? "" : record.dg,
        record.lineNumber
      ]);
    });

    return rows.map(function (row) {
      return row.map(csvCell).join(",");
    }).join("\n");
  }

  function recordsToHyb(records) {
    return records.map(function (record) { return record.raw; }).join("\n") + (records.length ? "\n" : "");
  }

  function rnaCountsToCsv(records) {
    const counts = new Map();

    (records || []).forEach(function (record) {
      addRnaCount(counts, record.rnaOne, record);
      addRnaCount(counts, record.rnaTwo, record);
    });

    const rows = [[
      "rna",
      "arm_occurrences",
      "source_reads",
      "source_read_count_arms",
      "cluster_support",
      "overlap_score_total",
      "overlap_score_arms"
    ]];
    Array.from(counts.values()).sort(function (left, right) {
      return right.support - left.support || left.name.localeCompare(right.name);
    }).forEach(function (item) {
      rows.push([
        item.name,
        item.records,
        item.rawReadCountRecords ? item.rawReads : "",
        item.rawReadCountRecords,
        item.support,
        item.overlapRecords ? item.overlapTotal : "",
        item.overlapRecords
      ]);
    });
    return csvRows(rows);
  }

  function rnaPairsToCsv(records) {
    const counts = new Map();

    (records || []).forEach(function (record) {
      const left = String(record.rnaOne || "");
      const right = String(record.rnaTwo || "");
      const rnaOne = left.localeCompare(right) <= 0 ? left : right;
      const rnaTwo = left.localeCompare(right) <= 0 ? right : left;
      const key = rnaOne + "\u0000" + rnaTwo;
      const item = counts.get(key) || countEntry({ rnaOne: rnaOne, rnaTwo: rnaTwo });
      addRecordCount(item, record);
      counts.set(key, item);
    });

    const rows = [[
      "rna_1",
      "rna_2",
      "hyb_records",
      "source_reads",
      "source_read_count_records",
      "cluster_support",
      "overlap_score_total",
      "overlap_score_records"
    ]];
    Array.from(counts.values()).sort(function (left, right) {
      return right.support - left.support ||
        left.rnaOne.localeCompare(right.rnaOne) ||
        left.rnaTwo.localeCompare(right.rnaTwo);
    }).forEach(function (item) {
      rows.push([
        item.rnaOne,
        item.rnaTwo,
        item.records,
        item.rawReadCountRecords ? item.rawReads : "",
        item.rawReadCountRecords,
        item.support,
        item.overlapRecords ? item.overlapTotal : "",
        item.overlapRecords
      ]);
    });
    return csvRows(rows);
  }

  function addRnaCount(counts, name, record) {
    const key = String(name || "");
    const item = counts.get(key) || countEntry({ name: key });
    addRecordCount(item, record);
    counts.set(key, item);
  }

  function countEntry(identity) {
    return Object.assign({
      records: 0,
      support: 0,
      rawReads: 0,
      rawReadCountRecords: 0,
      overlapTotal: 0,
      overlapRecords: 0
    }, identity);
  }

  function addRecordCount(item, record) {
    item.records += 1;
    item.support += Number(record.supportCount) || 0;
    if (record.rawReadCount !== null && record.rawReadCount !== undefined) {
      item.rawReads += Number(record.rawReadCount) || 0;
      item.rawReadCountRecords += 1;
    }
    if (record.overlapScore !== null && record.overlapScore !== undefined) {
      item.overlapTotal += Number(record.overlapScore) || 0;
      item.overlapRecords += 1;
    }
  }

  function csvRows(rows) {
    return rows.map(function (row) {
      return row.map(csvCell).join(",");
    }).join("\n");
  }

  function contactToTsv(matrix) {
    const rows = [["x_start", "x_end", "y_start", "y_end", "records", "support_count"]];
    matrix.cells.sort(function (left, right) { return left.x - right.x || left.y - right.y; }).forEach(function (cell) {
      rows.push([
        cell.x,
        cell.x + matrix.binSize - 1,
        cell.y,
        cell.y + matrix.binSize - 1,
        cell.records,
        cell.support
      ]);
    });
    return rows.map(function (row) { return row.join("\t"); }).join("\n");
  }

  function csvCell(value) {
    return '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"';
  }

  function numberOrNull(value) {
    const string = String(value == null ? "" : value).trim();
    if (!string) {
      return null;
    }
    const parsed = Number(string);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function coordinateOrNull(value) {
    const parsed = numberOrNull(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
  }

  function matchesHomodimerSubset(record, subset) {
    if (subset === "only") {
      return !!record.isHomodimer;
    }
    if (subset === "exclude") {
      return !record.isHomodimer;
    }
    return true;
  }

  function overlapsOptional(recordStart, recordEnd, filterStart, filterEnd) {
    if (filterStart === null && filterEnd === null) {
      return true;
    }
    const start = filterStart === null ? -Infinity : filterStart;
    const end = filterEnd === null ? Infinity : filterEnd;
    return recordStart <= end && recordEnd >= start;
  }

  window.RNAxRayData = {
    defaultInteractionFilters: defaultInteractionFilters,
    defaultContactState: defaultContactState,
    defaultRegionState: defaultRegionState,
    defaultViewpointState: defaultViewpointState,
    defaultComparisonState: defaultComparisonState,
    defaultStructureState: defaultStructureState,
    getRnaExtent: getRnaExtent,
    getFilteredRecords: getFilteredRecords,
    filterRecords: filterRecords,
    getPartnerCounts: getPartnerCounts,
    orientRecordForPair: orientRecordForPair,
    getContactResourceBudget: getContactResourceBudget,
    setContactResourceBudget: setContactResourceBudget,
    buildContactMatrix: buildContactMatrix,
    buildContactBins: buildContactBins,
    contactMatrixFromBins: contactMatrixFromBins,
    getCellRecords: getCellRecords,
    getRegionResults: getRegionResults,
    filterRegionRecords: filterRegionRecords,
    regionQuery: regionQuery,
    regionResultsFromRecords: regionResultsFromRecords,
    getViewpointResults: getViewpointResults,
    viewpointRange: viewpointRange,
    viewpointResultsFromRecords: viewpointResultsFromRecords,
    getViewpointArms: getViewpointArms,
    matchesHomodimerSubset: matchesHomodimerSubset,
    viewpointToTsv: viewpointToTsv,
    buildComparisonResults: buildComparisonResults,
    prepareComparison: prepareComparison,
    computeComparison: computeComparison,
    comparisonResultBuilder: comparisonResultBuilder,
    comparisonTransfers: comparisonTransfers,
    effectOrderOf: effectOrderOf,
    cellIndex: cellIndex,
    comparisonOrder: comparisonOrder,
    comparisonOrderedCells: comparisonOrderedCells,
    comparisonContactQuery: comparisonContactQuery,
    comparisonRnaPlan: comparisonRnaPlan,
    comparisonCellAt: comparisonCellAt,
    comparisonToTsv: comparisonToTsv,
    comparisonSelectedToTsv: comparisonSelectedToTsv,
    comparisonCountMatrixToTsv: comparisonCountMatrixToTsv,
    comparisonLegacyNamesToTsv: comparisonLegacyNamesToTsv,
    comparisonSampleMetadataToTsv: comparisonSampleMetadataToTsv,
    parseFasta: parseFasta,
    buildFastaMapping: buildFastaMapping,
    findFastaEntry: findFastaEntry,
    extractReference: extractReference,
    normaliseFoldSequence: normaliseFoldSequence,
    recordsToCsv: recordsToCsv,
    recordsToHyb: recordsToHyb,
    rnaCountsToCsv: rnaCountsToCsv,
    rnaPairsToCsv: rnaPairsToCsv,
    contactToTsv: contactToTsv,
    numberOrNull: numberOrNull
  };
}());

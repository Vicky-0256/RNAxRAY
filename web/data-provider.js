/*
 * RNAxRay DataProvider contract and the browser implementation.
 *
 * Analysis pages (Overview, Interactions, Contact Map, Viewpoint, Region,
 * Compare, RNA Structure, Report) read data only through a DataProvider. The
 * website uses BrowserProvider (records parsed by parser.worker.js and held in
 * tab memory); the desktop app can supply a provider backed by its Python
 * analysis index. Every method is async and takes a `selection` first.
 *
 * Selection
 *   { datasetIds: string[] }   one id = one dataset; several ids = the
 *                              datasets merged (counts summed, rows
 *                              concatenated in datasetIds order).
 *   normaliseSelection() also accepts "id", ["a", "b"] or { datasetId }.
 *
 * listDatasets() -> DatasetInfo[]
 *   DatasetInfo = { id, label, fileName, fileSize|null, sha256|null,
 *     sha256Unavailable: bool, condition: "A"|"B"|null, primary: bool,
 *     validRecords, supportInteractions, rnaNames: string[],
 *     reference: null | { fileName, fileSize|null, sha256|null,
 *       sha256Unavailable: bool, sequenceCount,
 *       mapping: { [rna]: referenceId },
 *       mapped: { [rna]: { referenceId, length } } } }
 *
 * getSummary(selection) -> Summary
 *   The parser summary shape: { fileName, fileSize, validRecords,
 *   invalidRecords, totalLines, skippedBlankLines, skippedCommentLines,
 *   supportInteractions, rawReadInteractions, rawReadCountRecords, withDg,
 *   overlapScoreRecords, canonicalRecords, legacyClusterRecords,
 *   ambiguousColumn16Records, inferredChimeraTypeRecords, intraRecords, intraSupport, interRecords,
 *   interSupport, homodimerRecords, homodimerRawReads, uniqueRNAs,
 *   uniquePairs, rnaNames[], rnaCounts[{name, records, support, rawReads,
 *   rawReadCountRecords, overlapTotal, overlapRecords}] (top 10),
 *   pairCounts[{rnaOne, rnaTwo, records, support, rawReads, ...}] (top 10),
 *   chimeraTypes[{name, records, support}], errors[{line, error, content}],
 *   errorSampleTruncated, ... } plus
 *   rnaExtents: { [rna]: { min, max } } (observed arm coordinates).
 *   Merged selections sum the counts. (BrowserProvider keeps rnaExtents
 *   non-enumerable on single-dataset summaries so JSON exports are unchanged.)
 *
 * getContactBins(selection, query) -> ContactBins
 *   query = { rnaX, rnaY, binSize, measure: "records"|"support",
 *     orientation: "normalised"|"original", chimeraType: "all"|<type>,
 *     homodimer: "all"|"only"|"exclude",
 *     maxCells?,              // double binSize until the map has <= maxCells
 *     region?: { x: [start, end], y: [start, end] } }  // keep cells in window
 *   (Backend spellings gene/gene2, measure "reads", types: [type] accepted.)
 *   ContactBins = { ready, reason, limitExceeded, gene, gene2,
 *     binSize, requestedBinSize, binSizeAdjusted,
 *     length, length2,        // RNA X / RNA Y length (reference if mapped,
 *                             // otherwise the largest observed coordinate)
 *     region, measure, total, max,
 *     x: [], y: [],           // bin start coordinates (multiples of binSize)
 *     count: [],              // value of the chosen measure per cell
 *     records: [], support: [],  // rows and cluster support per cell
 *     recordsUsed, totalSupport, extent: { xMin, xMax, yMin, yMax },
 *     limits?: { cellContributions, maximumCells, maximumBinContributions,
 *       resourceBudget } }
 *   Every arm covers each bin between its start and end (RNAxRay coverage rule).
 *
 * queryHybrids(selection, query) -> { total, offset, limit, order, rows }
 *   query = { filters?: InteractionFilters (defaultInteractionFilters()),
 *     region?: { rna, start, end, partner, partnerStart, partnerEnd,
 *       overlap: "any"|"contained" },
 *     cell?: { rnaX, rnaY, binSize, orientation, chimeraType, homodimer, x, y },
 *     indices?: number[],     // fetch specific rows by index
 *     order?: "file"|"support"("reads")|"position"|"dg" (alias: sort),
 *     offset = 0, limit = 100 (null = all rows) }
 *   Conditions combine with AND. `total` counts all matches.
 *   HybridRow = parser record: { index, id, sequence, rnaOne, rnaOneStart,
 *     rnaOneEnd, rnaOneReadStart, rnaOneReadEnd, rnaOneEvalue, rnaTwo, ...,
 *     dg, supportCount, rawReadCount, overlapScore, isHomodimer, chimeraType,
 *     chimeraTypeSource, lineNumber, raw, datasetId? }
 *   `index` is stable within the selection; merged selections add datasetId.
 *
 * getTopInteractions(selection, query) -> { total, rows }
 *   query.by = "partner": { rna, filters?, countMode: "support"|"records",
 *     limit? } -> rows [{ name, records, support }]
 *   query.by = "pair": { filters?, countMode, limit? }
 *     -> rows [{ rnaOne, rnaTwo, records, support }]
 *   query.by = "bin": contact query + { limit? }
 *     -> rows [{ x, y, xEnd, yEnd, count, records, support }] (largest first)
 *
 * getSequence(selection, query) -> null | Sequence
 *   query = { rna, start?, end? } (1-based inclusive; end is clamped to the
 *   reference length; omitted bounds mean the full sequence)
 *   Sequence = { rna, referenceId, header, start, end, length, sequence,
 *     invalidCharacters: [] }. null when the RNA has no mapped reference or
 *   the interval is invalid.
 *
 * getArms(selection, query) -> Arms (columnar)
 *   query = { rna?, partner?, chimeraType?, homodimer?, start?, end? }
 *   With `rna`, rows with an arm on `rna` (whose other arm is `partner`, when
 *   given) overlapping [start, end]; without `rna`, every row.
 *   Arms = { total, index: [], id: [], rnaOne: [], oneStart: [], oneEnd: [],
 *     rnaTwo: [], twoStart: [], twoEnd: [], support: [], homodimer: [],
 *     chimeraType: [] }
 *
 * Optional: getContactRecords(selection) -> null | ContactRecords
 *   The fields buildContactBins() reads, as typed columns that copy cheaply
 *   to comparison.worker.js, which then bins the records off the page:
 *   ContactRecords = { total, rnaNames: [], rnaOne: Int32Array,
 *     rnaTwo: Int32Array (indices into rnaNames), oneStart, oneEnd,
 *     twoStart, twoEnd, support: Float64Array, homodimer: Uint8Array,
 *     chimeraTypes: [], chimeraType: Int32Array (indices) }.
 *   null when the records cannot be packed exactly (the page then asks
 *   getContactBins()).  Providers without it are binned by getContactBins().
 */
(function (root, factory) {
  "use strict";

  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RNAxRayProvider = api;
  }
}(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis), function (root) {
  "use strict";

  const METHODS = ["listDatasets", "getSummary", "getContactBins", "queryHybrids", "getTopInteractions", "getSequence", "getArms"];
  const DEFAULT_LIMIT = 100;
  const QUERY_CACHE_SIZE = 12;

  function normaliseSelection(selection) {
    if (selection == null) {
      return { datasetIds: [] };
    }
    if (typeof selection === "string") {
      return { datasetIds: [selection] };
    }
    if (Array.isArray(selection)) {
      return { datasetIds: selection.map(String) };
    }
    if (Array.isArray(selection.datasetIds)) {
      return { datasetIds: selection.datasetIds.map(String) };
    }
    if (selection.datasetId != null) {
      return { datasetIds: [String(selection.datasetId)] };
    }
    return { datasetIds: [] };
  }

  function selectionKey(selection) {
    return normaliseSelection(selection).datasetIds.join("\u0001");
  }

  function sameSelection(left, right) {
    return selectionKey(left) === selectionKey(right);
  }

  // Columnar arms -> record-like objects for the existing analysis code.
  function armsToRecords(arms) {
    const source = arms || {};
    const total = Array.isArray(source.index) ? source.index.length : 0;
    const records = new Array(total);
    for (let row = 0; row < total; row += 1) {
      records[row] = {
        index: source.index[row],
        id: source.id ? source.id[row] : "",
        rnaOne: source.rnaOne[row],
        rnaOneStart: source.oneStart[row],
        rnaOneEnd: source.oneEnd[row],
        rnaTwo: source.rnaTwo[row],
        rnaTwoStart: source.twoStart[row],
        rnaTwoEnd: source.twoEnd[row],
        supportCount: source.support ? source.support[row] : 1,
        isHomodimer: source.homodimer ? !!source.homodimer[row] : false,
        chimeraType: source.chimeraType ? source.chimeraType[row] : ""
      };
    }
    return records;
  }

  function recordsToArms(records) {
    const list = records || [];
    const arms = {
      total: list.length,
      index: new Array(list.length),
      id: new Array(list.length),
      rnaOne: new Array(list.length),
      oneStart: new Array(list.length),
      oneEnd: new Array(list.length),
      rnaTwo: new Array(list.length),
      twoStart: new Array(list.length),
      twoEnd: new Array(list.length),
      support: new Array(list.length),
      homodimer: new Array(list.length),
      chimeraType: new Array(list.length)
    };
    list.forEach(function (record, row) {
      arms.index[row] = record.index;
      arms.id[row] = record.id;
      arms.rnaOne[row] = record.rnaOne;
      arms.oneStart[row] = record.rnaOneStart;
      arms.oneEnd[row] = record.rnaOneEnd;
      arms.rnaTwo[row] = record.rnaTwo;
      arms.twoStart[row] = record.rnaTwoStart;
      arms.twoEnd[row] = record.rnaTwoEnd;
      arms.support[row] = record.supportCount;
      arms.homodimer[row] = !!record.isHomodimer;
      arms.chimeraType[row] = record.chimeraType;
    });
    return arms;
  }

  // Records -> ContactRecords (see the header), or null when a coordinate
  // or support value is not a number (a typed column would change it).
  function packContactRecords(records) {
    const list = records || [];
    const total = list.length;
    const packed = {
      total: total,
      rnaNames: [],
      rnaOne: new Int32Array(total),
      rnaTwo: new Int32Array(total),
      oneStart: new Float64Array(total),
      oneEnd: new Float64Array(total),
      twoStart: new Float64Array(total),
      twoEnd: new Float64Array(total),
      support: new Float64Array(total),
      homodimer: new Uint8Array(total),
      chimeraTypes: [],
      chimeraType: new Int32Array(total)
    };
    const rnaCodes = new Map();
    const typeCodes = new Map();
    const code = function (codes, names, value) {
      let found = codes.get(value);
      if (found === undefined) {
        found = names.length;
        codes.set(value, found);
        names.push(value);
      }
      return found;
    };
    for (let row = 0; row < total; row += 1) {
      const record = list[row];
      if (typeof record.rnaOneStart !== "number" || typeof record.rnaOneEnd !== "number" ||
          typeof record.rnaTwoStart !== "number" || typeof record.rnaTwoEnd !== "number" ||
          typeof record.supportCount !== "number") {
        return null;
      }
      packed.rnaOne[row] = code(rnaCodes, packed.rnaNames, record.rnaOne);
      packed.rnaTwo[row] = code(rnaCodes, packed.rnaNames, record.rnaTwo);
      packed.oneStart[row] = record.rnaOneStart;
      packed.oneEnd[row] = record.rnaOneEnd;
      packed.twoStart[row] = record.rnaTwoStart;
      packed.twoEnd[row] = record.rnaTwoEnd;
      packed.support[row] = record.supportCount;
      packed.homodimer[row] = record.isHomodimer ? 1 : 0;
      packed.chimeraType[row] = code(typeCodes, packed.chimeraTypes, record.chimeraType);
    }
    return packed;
  }

  // ContactRecords -> record-like objects with the fields buildContactBins()
  // reads.
  function unpackContactRecords(packed) {
    const total = packed && packed.total || 0;
    const records = new Array(total);
    for (let row = 0; row < total; row += 1) {
      records[row] = {
        rnaOne: packed.rnaNames[packed.rnaOne[row]],
        rnaOneStart: packed.oneStart[row],
        rnaOneEnd: packed.oneEnd[row],
        rnaTwo: packed.rnaNames[packed.rnaTwo[row]],
        rnaTwoStart: packed.twoStart[row],
        rnaTwoEnd: packed.twoEnd[row],
        supportCount: packed.support[row],
        isHomodimer: packed.homodimer[row] === 1,
        chimeraType: packed.chimeraTypes[packed.chimeraType[row]]
      };
    }
    return records;
  }

  function computeRnaExtents(records) {
    const extents = Object.create(null);
    function add(rna, start, end) {
      const current = extents[rna];
      if (!current) {
        extents[rna] = { min: start, max: end };
        return;
      }
      if (start < current.min) current.min = start;
      if (end > current.max) current.max = end;
    }
    (records || []).forEach(function (record) {
      add(record.rnaOne, record.rnaOneStart, record.rnaOneEnd);
      add(record.rnaTwo, record.rnaTwoStart, record.rnaTwoEnd);
    });
    return extents;
  }

  const ADDITIVE_SUMMARY_FIELDS = [
    "fileSize", "totalLines", "processedBytes", "validRecords", "invalidRecords", "skippedBlankLines",
    "skippedCommentLines", "supportInteractions", "rawReadInteractions", "rawReadCountRecords", "withDg",
    "supportMetadataRecords", "overlapScoreRecords", "canonicalRecords", "legacyClusterRecords",
    "ambiguousColumn16Records", "inferredChimeraTypeRecords", "intraRecords", "intraSupport", "interRecords", "interSupport",
    "homodimerRecords", "homodimerRawReads", "omittedErrorCount"
  ];

  // Merged summary for several datasets. Count lists are rebuilt from the
  // concatenated rows with the parser's rules (parser.worker.js addRecord /
  // finalizeSummary) because per-file summaries keep only top-10 lists.
  function mergeSummaries(entries) {
    const merged = {
      fileName: entries.map(function (entry) { return entry.summary.fileName || entry.label || entry.id; }).join(" + "),
      datasetIds: entries.map(function (entry) { return entry.id; }),
      errors: [],
      errorSampleLimit: 100
    };
    ADDITIVE_SUMMARY_FIELDS.forEach(function (field) { merged[field] = 0; });
    entries.forEach(function (entry) {
      ADDITIVE_SUMMARY_FIELDS.forEach(function (field) {
        merged[field] += Number(entry.summary[field]) || 0;
      });
      (entry.summary.errors || []).forEach(function (error) {
        if (merged.errors.length < merged.errorSampleLimit) {
          merged.errors.push(Object.assign({ datasetId: entry.id }, error));
        }
      });
    });
    merged.errorSampleCount = merged.errors.length;
    merged.omittedErrorCount = Math.max(0, merged.invalidRecords - merged.errors.length);
    merged.errorSampleTruncated = merged.omittedErrorCount > 0;

    const rnaMap = Object.create(null);
    const pairMap = Object.create(null);
    const chimeraTypeMap = Object.create(null);
    function addRna(name, record) {
      const existing = rnaMap[name] || { name: name, records: 0, support: 0, rawReads: 0, rawReadCountRecords: 0, overlapTotal: 0, overlapRecords: 0 };
      existing.records += 1;
      existing.support += record.supportCount;
      if (record.rawReadCount !== null && record.rawReadCount !== undefined) {
        existing.rawReads += record.rawReadCount;
        existing.rawReadCountRecords += 1;
      }
      if (record.overlapScore !== null && record.overlapScore !== undefined) {
        existing.overlapTotal += record.overlapScore;
        existing.overlapRecords += 1;
      }
      rnaMap[name] = existing;
    }
    entries.forEach(function (entry) {
      entry.records.forEach(function (record) {
        addRna(record.rnaOne, record);
        addRna(record.rnaTwo, record);
        const ordered = String(record.rnaOne).localeCompare(String(record.rnaTwo)) <= 0
          ? [record.rnaOne, record.rnaTwo]
          : [record.rnaTwo, record.rnaOne];
        const key = ordered[0] + "\u0000" + ordered[1];
        const pair = pairMap[key] || { rnaOne: ordered[0], rnaTwo: ordered[1], records: 0, support: 0, rawReads: 0, rawReadCountRecords: 0, overlapTotal: 0, overlapRecords: 0 };
        pair.records += 1;
        pair.support += record.supportCount;
        if (record.rawReadCount !== null && record.rawReadCount !== undefined) {
          pair.rawReads += record.rawReadCount;
          pair.rawReadCountRecords += 1;
        }
        if (record.overlapScore !== null && record.overlapScore !== undefined) {
          pair.overlapTotal += record.overlapScore;
          pair.overlapRecords += 1;
        }
        pairMap[key] = pair;
        const typeName = record.chimeraType || "Unclassified";
        const type = chimeraTypeMap[typeName] || { name: typeName, records: 0, support: 0 };
        type.records += 1;
        type.support += record.supportCount;
        chimeraTypeMap[typeName] = type;
      });
    });
    merged.rnaCounts = Object.keys(rnaMap).map(function (key) { return rnaMap[key]; })
      .sort(function (left, right) { return right.support - left.support || left.name.localeCompare(right.name); })
      .slice(0, 10);
    merged.rnaNames = Object.keys(rnaMap).sort(function (left, right) { return left.localeCompare(right); });
    merged.pairCounts = Object.keys(pairMap).map(function (key) { return pairMap[key]; })
      .sort(function (left, right) {
        return right.support - left.support || left.rnaOne.localeCompare(right.rnaOne) || left.rnaTwo.localeCompare(right.rnaTwo);
      })
      .slice(0, 10);
    merged.chimeraTypes = Object.keys(chimeraTypeMap).map(function (key) { return chimeraTypeMap[key]; })
      .sort(function (left, right) { return right.records - left.records || left.name.localeCompare(right.name); });
    merged.uniqueRNAs = Object.keys(rnaMap).length;
    merged.uniquePairs = Object.keys(pairMap).length;
    return merged;
  }

  function sortBySupport(left, right) {
    return (Number(right.supportCount) || 0) - (Number(left.supportCount) || 0) ||
      (Number(right.rawReadCount) || 0) - (Number(left.rawReadCount) || 0) ||
      String(left.id || "").localeCompare(String(right.id || ""));
  }

  // order (backend spelling) or sort: "file" | "support" ("reads") | "position" | "dg"
  function queryOrder(options) {
    const order = String(options.order || options.sort || "file");
    return order === "reads" ? "support" : (["support", "position", "dg"].indexOf(order) !== -1 ? order : "file");
  }

  function normaliseLimit(value) {
    if (value === null || value === Infinity) {
      return Infinity;
    }
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LIMIT;
  }

  function invalidCharacters(sequence) {
    const seen = Object.create(null);
    String(sequence || "").toUpperCase().replace(/[ACGUT]/g, "").split("").forEach(function (character) {
      seen[character] = true;
    });
    return Object.keys(seen);
  }

  /*
   * BrowserProvider: the DataProvider over parser-worker records held in this
   * tab. The website shell registers datasets with addDataset() after
   * parsing; analysis pages only call the contract methods.
   */
  function BrowserProvider(options) {
    const settings = options || {};
    this.data = settings.data || null;
    this.datasets = new Map();
    this.reference = null;
    this.version = 0;
    this.listeners = new Set();
    this.queryCache = new Map();
    this.mergedCache = null;
  }

  BrowserProvider.prototype.kind = "browser";

  BrowserProvider.prototype.analysis = function () {
    const data = this.data || (root && root.RNAxRayData);
    if (!data) {
      throw new Error("RNAxRayData (analysis-data.js) must be loaded before using BrowserProvider.");
    }
    return data;
  };

  // ---- Registration (website shell only; not part of the page contract) ----

  BrowserProvider.prototype.addDataset = function (entry) {
    const input = entry || {};
    const id = String(input.id || ("dataset_" + Date.now().toString(36) + "_" + this.datasets.size));
    const records = Array.isArray(input.records) ? input.records : [];
    const summary = input.summary || {};
    records.forEach(function (record, index) {
      if (!Number.isSafeInteger(record.index)) {
        record.index = index;
      }
    });
    const extents = computeRnaExtents(records);
    // Keep JSON exports of the parser summary byte-identical.
    Object.defineProperty(summary, "rnaExtents", { value: extents, enumerable: false, configurable: true, writable: true });
    if (this.datasets.has(id)) {
      this.datasets.delete(id);
    }
    this.datasets.set(id, {
      id: id,
      label: input.label || (summary.fileName ? String(summary.fileName).replace(/\.gz$/i, "").replace(/\.(hyb|txt)$/i, "") : id),
      fileName: input.fileName || summary.fileName || "",
      fileSize: input.fileSize == null ? (summary.fileSize == null ? null : summary.fileSize) : input.fileSize,
      sha256: input.sha256 || summary.sha256 || null,
      sha256Unavailable: !!(input.sha256Unavailable || summary.sha256Unavailable),
      condition: input.condition || null,
      primary: !!input.primary,
      summary: summary,
      records: records
    });
    this.changed();
    return id;
  };

  BrowserProvider.prototype.updateDataset = function (id, patch) {
    const dataset = this.datasets.get(String(id));
    if (!dataset || !patch) {
      return false;
    }
    const metadataKeys = ["label", "condition", "sha256", "sha256Unavailable", "fileName", "fileSize"];
    metadataKeys.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        dataset[key] = patch[key];
      }
    });
    // Provenance-only edits do not change any analysis result.
    this.changed({ metadataOnly: true });
    return true;
  };

  BrowserProvider.prototype.removeDataset = function (id) {
    const removed = this.datasets.delete(String(id));
    if (removed) {
      this.changed();
    }
    return removed;
  };

  BrowserProvider.prototype.clear = function () {
    this.datasets.clear();
    this.reference = null;
    this.changed();
  };

  // `fasta` is the shell's parsed FASTA object ({ fileName, fileSize, sha256,
  // sequences: [{ id, header, sequence }], mapping: { rna: id } }). The shell
  // may keep editing its mapping; call notifyChange() afterwards.
  BrowserProvider.prototype.setReference = function (fasta) {
    this.reference = fasta || null;
    this.changed();
  };

  BrowserProvider.prototype.subscribe = function (listener) {
    const listeners = this.listeners;
    listeners.add(listener);
    return function () { listeners.delete(listener); };
  };

  // options.metadataOnly: only provenance (file names, fingerprints) changed.
  BrowserProvider.prototype.notifyChange = function (options) {
    this.changed(options);
  };

  BrowserProvider.prototype.changed = function (options) {
    const metadataOnly = !!(options && options.metadataOnly);
    this.version += 1;
    if (!metadataOnly) {
      this.queryCache.clear();
      this.mergedCache = null;
    }
    const version = this.version;
    Array.from(this.listeners).forEach(function (listener) {
      try {
        listener({ version: version, metadataOnly: metadataOnly });
      } catch (error) {
        /* Listener errors must not break registration. */
      }
    });
  };

  // ---- Internal helpers ----

  BrowserProvider.prototype.resolve = function (selection) {
    const ids = normaliseSelection(selection).datasetIds;
    const self = this;
    const entries = ids.map(function (id) {
      const dataset = self.datasets.get(id);
      if (!dataset) {
        throw new Error("Unknown dataset: " + id);
      }
      return dataset;
    });
    if (!entries.length) {
      throw new Error("The selection does not name any dataset.");
    }
    return entries;
  };

  BrowserProvider.prototype.rows = function (selection) {
    const entries = this.resolve(selection);
    if (entries.length === 1) {
      return entries[0].records;
    }
    const key = entries.map(function (entry) { return entry.id; }).join("\u0001");
    if (this.mergedCache && this.mergedCache.key === key) {
      return this.mergedCache.rows;
    }
    const rows = [];
    entries.forEach(function (entry) {
      entry.records.forEach(function (record) {
        rows.push(Object.assign({}, record, { index: rows.length, datasetId: entry.id, sourceIndex: record.index }));
      });
    });
    this.mergedCache = { key: key, rows: rows };
    return rows;
  };

  BrowserProvider.prototype.cached = function (key, compute) {
    if (this.queryCache.has(key)) {
      const value = this.queryCache.get(key);
      this.queryCache.delete(key);
      this.queryCache.set(key, value);
      return value;
    }
    const value = compute();
    this.queryCache.set(key, value);
    while (this.queryCache.size > QUERY_CACHE_SIZE) {
      this.queryCache.delete(this.queryCache.keys().next().value);
    }
    return value;
  };

  BrowserProvider.prototype.referenceInfo = function (rnaNames) {
    const fasta = this.reference;
    if (!fasta) {
      return null;
    }
    const data = this.analysis();
    const mapping = {};
    const mapped = {};
    Object.keys(fasta.mapping || {}).forEach(function (rna) {
      mapping[rna] = fasta.mapping[rna];
    });
    (rnaNames || Object.keys(mapping)).forEach(function (rna) {
      const entry = data.findFastaEntry(fasta, rna);
      if (entry) {
        mapped[rna] = { referenceId: entry.id, length: entry.sequence.length };
      }
    });
    return {
      fileName: fasta.fileName || "",
      fileSize: fasta.fileSize == null ? null : fasta.fileSize,
      sha256: fasta.sha256 || null,
      sha256Unavailable: !!fasta.sha256Unavailable,
      sequenceCount: Array.isArray(fasta.sequences) ? fasta.sequences.length : 0,
      mapping: mapping,
      mapped: mapped
    };
  };

  BrowserProvider.prototype.matchingRows = function (selection, query) {
    const data = this.analysis();
    const options = query || {};
    const rows = this.rows(selection);
    const key = selectionKey(selection) + "\u0002" + JSON.stringify({
      filters: options.filters || null,
      region: options.region || null,
      cell: options.cell || null,
      order: queryOrder(options)
    });
    return this.cached(key, function () {
      let matches = rows;
      if (options.filters) {
        matches = data.filterRecords(matches, options.filters);
      }
      if (options.region) {
        matches = data.filterRegionRecords(matches, options.region);
      }
      if (options.cell) {
        matches = data.getCellRecords(matches, options.cell, Number(options.cell.x), Number(options.cell.y));
      }
      const order = queryOrder(options);
      if (order === "support") {
        matches = matches.slice().sort(sortBySupport);
      } else if (order === "position") {
        matches = matches.slice().sort(function (left, right) {
          return String(left.rnaOne).localeCompare(String(right.rnaOne)) || left.rnaOneStart - right.rnaOneStart ||
            String(left.rnaTwo).localeCompare(String(right.rnaTwo)) || left.rnaTwoStart - right.rnaTwoStart || left.index - right.index;
        });
      } else if (order === "dg") {
        matches = matches.slice().sort(function (left, right) {
          const leftDg = left.dg === null || left.dg === undefined ? Infinity : left.dg;
          const rightDg = right.dg === null || right.dg === undefined ? Infinity : right.dg;
          return leftDg - rightDg || left.index - right.index;
        });
      }
      return matches;
    });
  };

  // ---- DataProvider contract ----

  BrowserProvider.prototype.listDatasets = async function () {
    const self = this;
    return Array.from(this.datasets.values()).map(function (dataset) {
      return {
        id: dataset.id,
        label: dataset.label,
        fileName: dataset.fileName,
        fileSize: dataset.fileSize,
        sha256: dataset.sha256 || null,
        sha256Unavailable: !!dataset.sha256Unavailable,
        condition: dataset.condition,
        primary: dataset.primary,
        validRecords: dataset.summary.validRecords || 0,
        supportInteractions: dataset.summary.supportInteractions || 0,
        rnaNames: (dataset.summary.rnaNames || []).slice(),
        reference: self.referenceInfo(dataset.summary.rnaNames || [])
      };
    });
  };

  BrowserProvider.prototype.getSummary = async function (selection) {
    const entries = this.resolve(selection);
    if (entries.length === 1) {
      return entries[0].summary;
    }
    const key = "summary\u0002" + selectionKey(selection);
    const self = this;
    return this.cached(key, function () {
      const merged = mergeSummaries(entries);
      merged.rnaExtents = computeRnaExtents(self.rows(selection));
      return merged;
    });
  };

  BrowserProvider.prototype.getContactBins = async function (selection, query) {
    const data = this.analysis();
    const contact = normaliseContactQuery(query);
    const rows = this.rows(selection);
    const requestedBinSize = Number(contact.binSize) > 0 ? Math.floor(Number(contact.binSize)) : 10;
    const maxCells = Number(contact.maxCells) > 0 ? Math.floor(Number(contact.maxCells)) : Infinity;
    let binSize = requestedBinSize;
    let bins = null;
    // Like the analysis backend: double the bin size until the map fits
    // maxCells (also retried when the browser cell budget is exceeded).
    for (let attempt = 0; attempt < 12; attempt += 1) {
      bins = data.buildContactBins(rows, Object.assign({}, contact, { binSize: binSize }));
      const tooManyCells = bins.ready ? bins.x.length > maxCells : /distinct cells/.test(bins.reason || "");
      if (!tooManyCells || maxCells === Infinity) {
        break;
      }
      binSize *= 2;
    }
    if (contact.region && bins.ready) {
      restrictBinsToRegion(bins, contact.region);
    }
    const fasta = this.reference;
    const lengthOf = function (rna, fallback) {
      const entry = fasta ? data.findFastaEntry(fasta, rna) : null;
      return entry ? entry.sequence.length : fallback;
    };
    const extents = (await this.getSummary(selection)).rnaExtents || {};
    bins.gene = contact.rnaX;
    bins.gene2 = contact.rnaY;
    bins.lengthX = lengthOf(contact.rnaX, extents[contact.rnaX] ? extents[contact.rnaX].max : bins.extent.xMax);
    bins.lengthY = lengthOf(contact.rnaY, extents[contact.rnaY] ? extents[contact.rnaY].max : bins.extent.yMax);
    bins.length = bins.lengthX;
    bins.length2 = bins.lengthY;
    bins.requestedBinSize = requestedBinSize;
    bins.binSizeAdjusted = bins.binSize !== requestedBinSize;
    bins.region = contact.region || null;
    bins.measure = contact.measure === "support" ? "support" : "records";
    bins.total = (bins.count || []).reduce(function (sum, value) { return sum + value; }, 0);
    bins.max = (bins.count || []).reduce(function (maximum, value) { return Math.max(maximum, value); }, 0);
    return bins;
  };

  // Accepts the page query and the analysis-backend spellings
  // (gene/gene2, measure "reads", types: [...]).
  function normaliseContactQuery(query) {
    const contact = Object.assign({}, query || {});
    if (!contact.rnaX && contact.gene) contact.rnaX = contact.gene;
    if (!contact.rnaY) contact.rnaY = contact.gene2 || contact.rnaX;
    if (contact.measure === "reads") contact.measure = "support";
    if (!contact.chimeraType && Array.isArray(contact.types) && contact.types.length === 1) {
      contact.chimeraType = contact.types[0];
    }
    return contact;
  }

  // region = { x: [start, end], y: [start, end] } (1-based, inclusive).
  function restrictBinsToRegion(bins, region) {
    const xRange = Array.isArray(region.x) ? region.x : null;
    const yRange = Array.isArray(region.y) ? region.y : xRange;
    const keep = [];
    for (let index = 0; index < bins.x.length; index += 1) {
      const x = bins.x[index];
      const y = bins.y[index];
      const inX = !xRange || (x + bins.binSize - 1 >= xRange[0] && x <= xRange[1]);
      const inY = !yRange || (y + bins.binSize - 1 >= yRange[0] && y <= yRange[1]);
      if (inX && inY) keep.push(index);
    }
    ["x", "y", "count", "records", "support"].forEach(function (key) {
      const source = bins[key];
      bins[key] = keep.map(function (index) { return source[index]; });
    });
  }

  BrowserProvider.prototype.queryHybrids = async function (selection, query) {
    const options = query || {};
    if (Array.isArray(options.indices)) {
      const rows = this.rows(selection);
      const byIndex = new Map();
      rows.forEach(function (row) { byIndex.set(row.index, row); });
      const found = options.indices.map(function (index) { return byIndex.get(Number(index)); }).filter(Boolean);
      return { total: found.length, offset: 0, rows: found };
    }
    const matches = this.matchingRows(selection, options);
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const limit = normaliseLimit(options.limit);
    return {
      total: matches.length,
      offset: offset,
      limit: limit === Infinity ? null : limit,
      order: queryOrder(options),
      rows: limit === Infinity ? matches.slice(offset) : matches.slice(offset, offset + limit)
    };
  };

  BrowserProvider.prototype.getTopInteractions = async function (selection, query) {
    const data = this.analysis();
    const options = query || {};
    const by = options.by || "partner";
    const limit = options.limit === undefined ? Infinity : normaliseLimit(options.limit);
    let rows;
    if (by === "bin") {
      const bins = await this.getContactBins(selection, options);
      rows = (bins.x || []).map(function (x, index) {
        return {
          x: x,
          y: bins.y[index],
          xEnd: x + bins.binSize - 1,
          yEnd: bins.y[index] + bins.binSize - 1,
          count: bins.count[index],
          records: bins.records[index],
          support: bins.support[index]
        };
      }).sort(function (left, right) { return right.count - left.count || left.x - right.x || left.y - right.y; });
    } else {
      const matches = options.filters ? this.matchingRows(selection, { filters: options.filters }) : this.rows(selection);
      if (by === "pair") {
        const pairs = Object.create(null);
        matches.forEach(function (record) {
          const ordered = String(record.rnaOne).localeCompare(String(record.rnaTwo)) <= 0
            ? [record.rnaOne, record.rnaTwo]
            : [record.rnaTwo, record.rnaOne];
          const key = ordered[0] + "\u0000" + ordered[1];
          const entry = pairs[key] || { rnaOne: ordered[0], rnaTwo: ordered[1], records: 0, support: 0 };
          entry.records += 1;
          entry.support += record.supportCount;
          pairs[key] = entry;
        });
        rows = Object.keys(pairs).map(function (key) { return pairs[key]; }).sort(function (left, right) {
          const leftValue = options.countMode === "records" ? left.records : left.support;
          const rightValue = options.countMode === "records" ? right.records : right.support;
          return rightValue - leftValue || left.rnaOne.localeCompare(right.rnaOne) || left.rnaTwo.localeCompare(right.rnaTwo);
        });
      } else {
        rows = data.getPartnerCounts(matches, options.rna || "", options.countMode || "support");
      }
    }
    return { total: rows.length, rows: limit === Infinity ? rows : rows.slice(0, limit) };
  };

  BrowserProvider.prototype.getSequence = async function (selection, query) {
    this.resolve(selection);
    const data = this.analysis();
    const options = query || {};
    const fasta = this.reference;
    if (!fasta || !options.rna) {
      return null;
    }
    const entry = data.findFastaEntry(fasta, options.rna);
    if (!entry) {
      return null;
    }
    const reference = data.extractReference(fasta, options.rna, options.start, options.end);
    if (!reference) {
      return null;
    }
    return {
      rna: options.rna,
      referenceId: reference.id,
      header: reference.header,
      start: reference.start,
      end: reference.end,
      length: entry.sequence.length,
      sequence: reference.sequence,
      invalidCharacters: invalidCharacters(reference.sequence)
    };
  };

  BrowserProvider.prototype.getArms = async function (selection, query) {
    const data = this.analysis();
    const options = query || {};
    const rows = this.rows(selection);
    const start = options.start == null || options.start === "" ? -Infinity : Number(options.start);
    const end = options.end == null || options.end === "" ? Infinity : Number(options.end);
    const key = selectionKey(selection) + "\u0003arms" + JSON.stringify(options);
    const matches = this.cached(key, function () {
      if (!options.rna) {
        return rows.filter(function (record) {
          if (options.chimeraType && options.chimeraType !== "all" && record.chimeraType !== options.chimeraType) {
            return false;
          }
          return data.matchesHomodimerSubset(record, options.homodimer);
        });
      }
      return rows.filter(function (record) {
        return data.getViewpointArms(record, options.rna, options.partner || "", options.chimeraType, options.homodimer).some(function (arm) {
          return arm.start <= end && arm.end >= start;
        });
      });
    });
    return recordsToArms(matches);
  };

  // Packed once per record list (records do not change after addDataset).
  const contactRecordsCache = new WeakMap();

  BrowserProvider.prototype.getContactRecords = async function (selection) {
    const rows = this.rows(selection);
    if (!contactRecordsCache.has(rows)) {
      contactRecordsCache.set(rows, packContactRecords(rows));
    }
    return contactRecordsCache.get(rows);
  };

  function implementsProvider(candidate) {
    return !!candidate && METHODS.every(function (method) { return typeof candidate[method] === "function"; });
  }

  return {
    METHODS: METHODS,
    BrowserProvider: BrowserProvider,
    normaliseSelection: normaliseSelection,
    selectionKey: selectionKey,
    sameSelection: sameSelection,
    armsToRecords: armsToRecords,
    recordsToArms: recordsToArms,
    packContactRecords: packContactRecords,
    unpackContactRecords: unpackContactRecords,
    mergeSummaries: mergeSummaries,
    computeRnaExtents: computeRnaExtents,
    implementsProvider: implementsProvider
  };
}));

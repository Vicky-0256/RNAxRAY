/* RNAxRay Web: all file parsing runs in this dedicated browser worker. */

const ERROR_SAMPLE_LIMIT = 100;
const PROGRESS_INTERVAL = 2000;

self.onmessage = async function (event) {
  const file = event.data && event.data.file;

  if (!file) {
    self.postMessage({
      type: "error",
      message: "No file was received by the local parser."
    });
    return;
  }

  try {
    const summary = createSummary(file);
    let pending = "";
    let lineNumber = 0;
    let recordsSinceProgress = 0;

    function consumeLine(rawLine) {
      lineNumber += 1;
      summary.totalLines = lineNumber;
      const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;

      if (!line.trim()) {
        summary.skippedBlankLines += 1;
        return;
      }

      if (/^\s*#/.test(line)) {
        summary.skippedCommentLines += 1;
        return;
      }

      const parsed = parseRecord(line, lineNumber);

      if (!parsed.ok) {
        summary.invalidRecords += 1;
        addError(summary, parsed.error);
        return;
      }

      addRecord(summary, parsed.record);
      recordsSinceProgress += 1;

      if (recordsSinceProgress >= PROGRESS_INTERVAL) {
        recordsSinceProgress = 0;
        self.postMessage({
          type: "progress",
          stage: "Parsing HYB records",
          percent: 0,
          parsedRecords: summary.validRecords,
          processedBytes: summary.processedBytes,
          totalBytes: file.size
        });
      }
    }

    await readFileInChunks(file, function (text, processedBytes) {
      summary.processedBytes = processedBytes;
      const combined = pending + text;
      const lines = combined.split(/\r?\n/);
      pending = lines.pop() || "";

      for (let index = 0; index < lines.length; index += 1) {
        consumeLine(lines[index]);
      }

      self.postMessage({
        type: "progress",
        stage: "Parsing HYB records",
        percent: file.size ? Math.min(94, Math.round((processedBytes / file.size) * 94)) : 0,
        parsedRecords: summary.validRecords,
        processedBytes: processedBytes,
        totalBytes: file.size
      });
    });

    if (pending.length > 0) {
      consumeLine(pending);
    }

    summary.processedBytes = file.size;
    const records = summary.records;
    finalizeSummary(summary);
    delete summary.records;

    self.postMessage({
      type: "complete",
      summary: summary,
      records: records
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error && error.message ? error.message : "The local parser could not read this file."
    });
  }
};

// gzip input (.hyb.gz) is recognised by its magic bytes, so a server that
// already decoded a .gz download (Content-Encoding) is read as plain text
async function isGzip(file) {
  if (typeof file.slice !== "function" || file.size < 2) {
    return false;
  }
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

async function readFileInChunks(file, onChunk) {
  const decoder = new TextDecoder();
  const gzip = await isGzip(file);

  if (gzip && (typeof file.stream !== "function" || typeof DecompressionStream !== "function")) {
    throw new Error("This browser cannot decompress gzip files; decompress " + (file.name || "the file") + " first.");
  }

  if (typeof file.stream === "function") {
    // progress counts compressed bytes read, so it stays within file.size
    let processedBytes = 0;
    let stream = file.stream();
    if (gzip) {
      stream = stream.pipeThrough(new TransformStream({
        transform: function (chunk, controller) {
          processedBytes += chunk.byteLength;
          controller.enqueue(chunk);
        }
      })).pipeThrough(new DecompressionStream("gzip"));
    }
    const reader = stream.getReader();

    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }

      if (!gzip) {
        processedBytes += next.value.byteLength;
      }
      onChunk(decoder.decode(next.value, { stream: true }), processedBytes);
    }

    const tail = decoder.decode();
    if (tail) {
      onChunk(tail, file.size);
    }
    return;
  }

  const chunkSize = 1024 * 1024;
  let offset = 0;

  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
    const buffer = await slice.arrayBuffer();
    offset += buffer.byteLength;
    onChunk(decoder.decode(buffer, { stream: offset < file.size }), offset);
  }

  const tail = decoder.decode();
  if (tail) {
    onChunk(tail, file.size);
  }
}

function createSummary(file) {
  return {
    fileName: file.name,
    fileSize: file.size,
    totalLines: 0,
    processedBytes: 0,
    validRecords: 0,
    invalidRecords: 0,
    skippedBlankLines: 0,
    skippedCommentLines: 0,
    supportInteractions: 0,
    rawReadInteractions: 0,
    rawReadCountRecords: 0,
    withDg: 0,
    supportMetadataRecords: 0,
    overlapScoreRecords: 0,
    canonicalRecords: 0,
    legacyClusterRecords: 0,
    ambiguousColumn16Records: 0,
    inferredChimeraTypeRecords: 0,
    records: [],
    rnaMap: Object.create(null),
    pairMap: Object.create(null),
    chimeraTypeMap: Object.create(null),
    intraRecords: 0,
    intraSupport: 0,
    interRecords: 0,
    interSupport: 0,
    homodimerRecords: 0,
    homodimerRawReads: 0,
    errorSampleLimit: ERROR_SAMPLE_LIMIT,
    errorSampleCount: 0,
    omittedErrorCount: 0,
    errorSampleTruncated: false,
    errors: []
  };
}

function parseRecord(line, lineNumber) {
  const columns = line.split("\t");

  if (columns.length < 15) {
    return invalid(lineNumber, "Expected at least 15 tab-separated columns", line);
  }

  const rnaOne = columns[3].trim();
  const rnaTwo = columns[9].trim();

  if (!rnaOne || !rnaTwo) {
    return invalid(lineNumber, "Missing RNA name", line);
  }

  const armOneStart = parseCoordinate(columns[6]);
  const armOneEnd = parseCoordinate(columns[7]);
  const armTwoStart = parseCoordinate(columns[12]);
  const armTwoEnd = parseCoordinate(columns[13]);

  if (
    armOneStart === null ||
    armOneEnd === null ||
    armTwoStart === null ||
    armTwoEnd === null ||
    armOneStart > armOneEnd ||
    armTwoStart > armTwoEnd
  ) {
    return invalid(lineNumber, "Invalid RNA coordinates", line);
  }

  const annotations = parseAnnotations(columns);
  if (annotations.invalidReason) {
    return invalid(lineNumber, annotations.invalidReason, line);
  }
  const dg = parseOptionalNumber(columns[2]);
  const sourceId = columns[0].trim();
  const rawReadCount = parseRawReadCount(sourceId);
  const isHomodimer = rnaOne === rnaTwo &&
    annotations.overlapScore !== null &&
    annotations.overlapScore >= 5;

  return {
    ok: true,
    record: {
      id: sourceId || "line_" + lineNumber,
      sequence: columns[1].trim(),
      dg: dg,
      rnaOne: rnaOne,
      rnaOneReadStart: parseOptionalNumber(columns[4]),
      rnaOneReadEnd: parseOptionalNumber(columns[5]),
      rnaOneStart: armOneStart,
      rnaOneEnd: armOneEnd,
      rnaOneEvalue: parseOptionalNumber(columns[8]),
      rnaTwo: rnaTwo,
      rnaTwoReadStart: parseOptionalNumber(columns[10]),
      rnaTwoReadEnd: parseOptionalNumber(columns[11]),
      rnaTwoStart: armTwoStart,
      rnaTwoEnd: armTwoEnd,
      rnaTwoEvalue: parseOptionalNumber(columns[14]),
      supportCount: annotations.supportCount,
      supportSource: annotations.supportSource,
      rawReadCount: rawReadCount,
      overlapScore: annotations.overlapScore,
      isHomodimer: isHomodimer,
      chimeraType: annotations.chimeraType || inferChimeraType(rnaOne, armOneStart, armOneEnd, rnaTwo, armTwoStart, armTwoEnd),
      chimeraTypeSource: annotations.chimeraType ? "column_17" : "inferred",
      inputLayout: annotations.inputLayout,
      ambiguousColumn16: annotations.ambiguousColumn16,
      hasDg: dg !== null,
      lineNumber: lineNumber,
      raw: line
    }
  };
}

function invalid(line, error, content) {
  return {
    ok: false,
    error: {
      line: line,
      error: error,
      content: content.slice(0, 600)
    }
  };
}

function parseCoordinate(value) {
  const trimmed = String(value || "").trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const number = Number(trimmed);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function parseRawReadCount(id) {
  const fields = String(id || "").split("_");
  if (fields.length < 2 || !/^\d+$/.test(fields[1])) {
    return null;
  }

  const count = Number(fields[1]);
  return Number.isSafeInteger(count) && count >= 1 ? count : null;
}

function parseOptionalNumber(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === ".") {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAnnotations(columns) {
  const tail = columns.slice(15).map(function (value) { return String(value || "").trim(); });
  const column16 = tail[0] || "";
  const column17 = tail[1] || "";
  const integerSyntax = /^\d+$/.test(column16);
  const integerValue = integerSyntax ? Number(column16) : null;
  const directInteger = Number.isSafeInteger(integerValue) ? integerValue : null;
  const numberSyntax = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(column16);
  const numberValue = numberSyntax ? Number(column16) : null;
  const directNumber = Number.isFinite(numberValue) ? numberValue : null;

  // RNAxRay's documented current layout has 17 fields: column 16 is the
  // overlap score and column 17 is the chimera type. Older clustered files
  // instead have 15 fields plus a 16th count/count_total annotation.
  // sam2hyb itself writes 18 fields: txt2hyb.awk leaves an empty column 16,
  // so the overlap score and chimera type sit in columns 17 and 18.
  if (columns.length >= 18 && column16 === "") {
    return {
      supportCount: 1,
      supportSource: "row",
      overlapScore: parseOptionalNumber(tail[1] || ""),
      chimeraType: normaliseChimeraType(tail[2] || ""),
      inputLayout: "rnaxray_sam2hyb_18_column",
      ambiguousColumn16: false
    };
  }
  if (columns.length >= 17) {
    return {
      supportCount: 1,
      supportSource: "row",
      overlapScore: parseOptionalNumber(column16),
      chimeraType: normaliseChimeraType(column17),
      inputLayout: "rnaxray_17_column",
      ambiguousColumn16: false
    };
  }

  const metadataResult = findSupportMetadata(tail);
  if (metadataResult.invalidReason) {
    return { invalidReason: metadataResult.invalidReason };
  }
  const metadata = metadataResult.value;

  if (metadata !== null) {
    return {
      supportCount: metadata,
      supportSource: "count_metadata",
      overlapScore: null,
      chimeraType: "",
      inputLayout: "legacy_clustered",
      ambiguousColumn16: false
    };
  }

  if (columns.length === 16 && ((integerSyntax && directInteger === null) || (numberSyntax && directNumber === null))) {
    return {
      invalidReason: "Legacy column 16 count is outside the safe positive-integer range"
    };
  }

  if (directInteger !== null && directInteger > 0) {
    return {
      supportCount: directInteger,
      supportSource: "legacy_column_16_count",
      overlapScore: null,
      chimeraType: "",
      inputLayout: "legacy_clustered",
      ambiguousColumn16: true
    };
  }

  if (directNumber !== null) {
    return {
      supportCount: 1,
      supportSource: "row",
      overlapScore: directNumber,
      chimeraType: "",
      inputLayout: "partial_rnaxray",
      ambiguousColumn16: false
    };
  }

  return {
    supportCount: 1,
    supportSource: "row",
    overlapScore: null,
    chimeraType: "",
    inputLayout: columns.length === 16 ? "legacy_unannotated" : "hyb_15_column",
    ambiguousColumn16: false
  };
}

function findSupportMetadata(values) {
  const joined = values.join(";");
  const match = joined.match(/(?:^|[;,\s])count_total\s*=\s*([^;,\s]+)(?=$|[;,\s])/i);
  if (!match) {
    return { value: null, invalidReason: "" };
  }
  if (!/^\d+$/.test(match[1])) {
    return { value: null, invalidReason: "count_total metadata must be a positive safe integer" };
  }
  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { value: null, invalidReason: "count_total metadata must be a positive safe integer" };
  }
  return { value: parsed, invalidReason: "" };
}

function normaliseChimeraType(value) {
  const type = String(value || "").trim();
  return !type || type === "." || /^na$/i.test(type) ? "" : type;
}

function inferChimeraType(rnaOne, startOne, endOne, rnaTwo, startTwo, endTwo) {
  if (rnaOne !== rnaTwo) {
    return "Intermolecular";
  }

  if (startOne < startTwo && endOne < startTwo) return "Type_1";
  if (startOne > endTwo && endOne > endTwo) return "Type_2";
  if (startOne < startTwo && endOne > startTwo && endOne < endTwo) return "Type_3";
  if (startOne < startTwo && endOne === endTwo) return "Type_4";
  if (startOne < startTwo && endOne > endTwo) return "Type_5";
  if (startOne === startTwo && endOne > endTwo) return "Type_6";
  if (startOne < endTwo && endOne > endTwo) return "Type_7";
  if (startOne === startTwo && endOne === endTwo) return "Type_8";
  if (startOne > startTwo && endOne === endTwo) return "Type_9";
  if (startOne === startTwo && endOne < endTwo) return "Type_10";
  if (startOne > startTwo && endOne < endTwo) return "Type_11";
  if (startOne < startTwo && endOne === startTwo) return "Type_12";
  if (startOne === endTwo && endOne > endTwo) return "Type_13";
  return "Unclassified intramolecular";
}

function addRecord(summary, record) {
  summary.records.push(record);
  summary.validRecords += 1;
  summary.supportInteractions += record.supportCount;

  if (record.rawReadCount !== null) {
    summary.rawReadInteractions += record.rawReadCount;
    summary.rawReadCountRecords += 1;
  }

  if (record.hasDg) {
    summary.withDg += 1;
  }

  if (record.supportSource !== "row") {
    summary.supportMetadataRecords += 1;
  }

  if (record.overlapScore !== null) {
    summary.overlapScoreRecords += 1;
  }

  if (record.inputLayout === "rnaxray_17_column" || record.inputLayout === "rnaxray_sam2hyb_18_column") {
    summary.canonicalRecords += 1;
  }
  if (record.inputLayout === "legacy_clustered") {
    summary.legacyClusterRecords += 1;
  }
  if (record.ambiguousColumn16) {
    summary.ambiguousColumn16Records += 1;
  }
  if (record.chimeraTypeSource === "inferred") {
    summary.inferredChimeraTypeRecords += 1;
  }

  addRna(summary.rnaMap, record.rnaOne, record.supportCount, record.overlapScore, record.rawReadCount);
  addRna(summary.rnaMap, record.rnaTwo, record.supportCount, record.overlapScore, record.rawReadCount);

  const pair = normalisePair(record.rnaOne, record.rnaTwo);
  const existingPair = summary.pairMap[pair.key] || {
    rnaOne: pair.rnaOne,
    rnaTwo: pair.rnaTwo,
    records: 0,
    support: 0,
    rawReads: 0,
    rawReadCountRecords: 0,
    overlapTotal: 0,
    overlapRecords: 0
  };

  existingPair.records += 1;
  existingPair.support += record.supportCount;
  if (record.rawReadCount !== null) {
    existingPair.rawReads += record.rawReadCount;
    existingPair.rawReadCountRecords += 1;
  }
  if (record.overlapScore !== null) {
    existingPair.overlapTotal += record.overlapScore;
    existingPair.overlapRecords += 1;
  }
  summary.pairMap[pair.key] = existingPair;

  addChimeraType(summary.chimeraTypeMap, record.chimeraType, record.supportCount);

  if (record.rnaOne === record.rnaTwo) {
    summary.intraRecords += 1;
    summary.intraSupport += record.supportCount;
  } else {
    summary.interRecords += 1;
    summary.interSupport += record.supportCount;
  }

  if (record.isHomodimer) {
    summary.homodimerRecords += 1;
    if (record.rawReadCount !== null) {
      summary.homodimerRawReads += record.rawReadCount;
    }
  }
}

function addRna(map, name, support, overlapScore, rawReadCount) {
  const existing = map[name] || { name: name, records: 0, support: 0, rawReads: 0, rawReadCountRecords: 0, overlapTotal: 0, overlapRecords: 0 };
  existing.records += 1;
  existing.support += support;
  if (rawReadCount !== null) {
    existing.rawReads += rawReadCount;
    existing.rawReadCountRecords += 1;
  }
  if (overlapScore !== null) {
    existing.overlapTotal += overlapScore;
    existing.overlapRecords += 1;
  }
  map[name] = existing;
}

function addChimeraType(map, type, support) {
  const name = type || "Unclassified";
  const existing = map[name] || { name: name, records: 0, support: 0 };
  existing.records += 1;
  existing.support += support;
  map[name] = existing;
}

function normalisePair(left, right) {
  return left.localeCompare(right) <= 0
    ? { rnaOne: left, rnaTwo: right, key: left + "\u0000" + right }
    : { rnaOne: right, rnaTwo: left, key: right + "\u0000" + left };
}

function addError(summary, error) {
  if (summary.errors.length < ERROR_SAMPLE_LIMIT) {
    summary.errors.push(error);
  }
}

function finalizeSummary(summary) {
  summary.errorSampleCount = summary.errors.length;
  summary.omittedErrorCount = Math.max(0, summary.invalidRecords - summary.errors.length);
  summary.errorSampleTruncated = summary.omittedErrorCount > 0;
  summary.rnaCounts = Object.keys(summary.rnaMap)
    .map(function (key) { return summary.rnaMap[key]; })
    .sort(function (left, right) { return right.support - left.support || left.name.localeCompare(right.name); })
    .slice(0, 10);

  summary.rnaNames = Object.keys(summary.rnaMap)
    .sort(function (left, right) { return left.localeCompare(right); });

  summary.pairCounts = Object.keys(summary.pairMap)
    .map(function (key) { return summary.pairMap[key]; })
    .sort(function (left, right) {
      return right.support - left.support ||
        left.rnaOne.localeCompare(right.rnaOne) ||
        left.rnaTwo.localeCompare(right.rnaTwo);
    })
    .slice(0, 10);

  summary.chimeraTypes = Object.keys(summary.chimeraTypeMap)
    .map(function (key) { return summary.chimeraTypeMap[key]; })
    .sort(function (left, right) { return right.records - left.records || left.name.localeCompare(right.name); });

  summary.uniqueRNAs = Object.keys(summary.rnaMap).length;
  summary.uniquePairs = Object.keys(summary.pairMap).length;
  delete summary.rnaMap;
  delete summary.pairMap;
  delete summary.chimeraTypeMap;
}

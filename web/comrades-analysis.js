(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RNAxRayComrades = api;
  }
}(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : globalThis), function () {
  "use strict";

  const ORIGINAL_LINKER_LENGTH = 100;
  const ORIGINAL_EVIDENCE_LIMIT = 1001;
  const ORIGINAL_CONSTRAINT_LIMIT = 75;
  const CANONICAL_PAIRS = new Set(["AU", "UA", "CG", "GC", "GU", "UG"]);

  function prepareReferenceAssembly(records, fasta, options) {
    const settings = options || {};
    const regions = normaliseRegions(settings.regions || []);
    if (!fasta || !Array.isArray(fasta.sequences)) {
      throw new Error("A parsed reference FASTA is required for HYB-guided folding.");
    }
    if (regions.length < 1 || regions.length > 2) {
      throw new Error("HYB-guided folding requires one or two reference regions.");
    }

    const segments = regions.map(function (region, index) {
      const entry = findReferenceEntry(fasta, region.rna);
      if (!entry) {
        throw new Error("No mapped FASTA sequence is available for " + region.rna + ".");
      }
      const fullSequence = normaliseSequence(entry.sequence);
      if (fullSequence.invalid.length) {
        throw new Error("The mapped FASTA sequence for " + region.rna + " contains unsupported symbols: " + fullSequence.invalid.join(", ") + ".");
      }
      if (region.end > fullSequence.sequence.length) {
        throw new Error("Region " + region.rna + ":" + region.start + "-" + region.end + " exceeds the mapped FASTA length of " + fullSequence.sequence.length + " nt.");
      }
      return {
        index: index,
        rna: region.rna,
        referenceId: entry.id,
        referenceStart: region.start,
        referenceEnd: region.end,
        sequence: fullSequence.sequence.slice(region.start - 1, region.end),
        preparedStart: 0,
        preparedEnd: 0
      };
    });

    const linker = segments.length === 2 ? originalLinker() : "";
    let preparedSequence = "";
    segments.forEach(function (segment, index) {
      if (index > 0) {
        preparedSequence += linker;
      }
      segment.preparedStart = preparedSequence.length + 1;
      preparedSequence += segment.sequence;
      segment.preparedEnd = preparedSequence.length;
    });

    const skipped = {
      antisense: 0,
      outsideSelectedRegions: 0,
      homodimerFilter: 0,
      invalidSequence: 0
    };
    const evidenceArms = [];

    (records || []).forEach(function (record) {
      if (!forwardRecord(record)) {
        skipped.antisense += 1;
        return;
      }
      if (settings.homodimerOnly && !record.isHomodimer) {
        skipped.homodimerFilter += 1;
        return;
      }

      const orientation = orientRecord(record, segments);
      if (!orientation) {
        skipped.outsideSelectedRegions += 1;
        return;
      }

      const first = preparedArm(orientation.first, orientation.firstSegment, preparedSequence);
      const second = preparedArm(orientation.second, orientation.secondSegment, preparedSequence);
      if (!first || !second || /[^ACGU]/.test(first.sequence + second.sequence)) {
        skipped.invalidSequence += 1;
        return;
      }

      evidenceArms.push({
        recordId: String(record.id || ""),
        recordIndex: Number.isSafeInteger(record.index) ? record.index : evidenceArms.length,
        sequenceOne: first.sequence,
        sequenceTwo: second.sequence,
        oneStart: first.preparedStart,
        oneEnd: first.preparedEnd,
        twoStart: second.preparedStart,
        twoEnd: second.preparedEnd,
        reversedFromHyb: orientation.reversed
      });
    });

    return {
      sequence: preparedSequence,
      label: segments.map(function (segment) {
        return segment.rna + ":" + segment.referenceStart + "-" + segment.referenceEnd;
      }).join(" + "),
      segments: segments.map(copySegment),
      linker: linker ? {
        length: linker.length,
        sequence: linker,
        preparedStart: segments[0].preparedEnd + 1,
        preparedEnd: segments[1].preparedStart - 1,
        source: "RNAxRay original 50 A + 50 T spacer, normalised to RNA as 50 A + 50 U"
      } : null,
      evidenceArms: evidenceArms,
      inputRecordCount: (records || []).length,
      eligibleRecordCount: evidenceArms.length,
      skipped: skipped,
      homodimerOnly: !!settings.homodimerOnly
    };
  }

  function normaliseRegions(regions) {
    return regions.map(function (region, index) {
      const rna = String(region && region.rna || "").trim();
      const start = Number(region && region.start);
      const end = Number(region && region.end);
      if (!rna || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new Error("Reference region " + (index + 1) + " must have an RNA name and 1-based start/end coordinates.");
      }
      return { rna: rna, start: start, end: end };
    });
  }

  function findReferenceEntry(fasta, rna) {
    const mappedId = fasta.mapping && fasta.mapping[rna] || rna;
    return fasta.sequences.find(function (entry) {
      return entry.id === mappedId;
    }) || null;
  }

  function normaliseSequence(value) {
    const sequence = String(value || "").replace(/\s+/g, "").toUpperCase().replace(/T/g, "U");
    const matches = sequence.match(/[^ACGU]/g);
    return {
      sequence: sequence,
      invalid: matches ? Array.from(new Set(matches)) : []
    };
  }

  function originalLinker() {
    return "A".repeat(ORIGINAL_LINKER_LENGTH / 2) + "U".repeat(ORIGINAL_LINKER_LENGTH / 2);
  }

  function forwardRecord(record) {
    return Number.isSafeInteger(record && record.rnaOneStart) &&
      Number.isSafeInteger(record && record.rnaOneEnd) &&
      Number.isSafeInteger(record && record.rnaTwoStart) &&
      Number.isSafeInteger(record && record.rnaTwoEnd) &&
      record.rnaOneStart <= record.rnaOneEnd &&
      record.rnaTwoStart <= record.rnaTwoEnd;
  }

  function orientRecord(record, segments) {
    const one = arm(record.rnaOne, record.rnaOneStart, record.rnaOneEnd);
    const two = arm(record.rnaTwo, record.rnaTwoStart, record.rnaTwoEnd);

    if (segments.length === 1) {
      if (armInSegment(one, segments[0]) && armInSegment(two, segments[0])) {
        return { first: one, second: two, firstSegment: segments[0], secondSegment: segments[0], reversed: false };
      }
      return null;
    }

    if (armInSegment(one, segments[0]) && armInSegment(two, segments[1])) {
      return { first: one, second: two, firstSegment: segments[0], secondSegment: segments[1], reversed: false };
    }
    if (armInSegment(two, segments[0]) && armInSegment(one, segments[1])) {
      return { first: two, second: one, firstSegment: segments[0], secondSegment: segments[1], reversed: true };
    }
    return null;
  }

  function arm(rna, start, end) {
    return { rna: String(rna || ""), start: Number(start), end: Number(end) };
  }

  function armInSegment(candidate, segment) {
    return candidate.rna === segment.rna &&
      candidate.start >= segment.referenceStart &&
      candidate.end <= segment.referenceEnd;
  }

  function preparedArm(candidate, segment, preparedSequence) {
    const preparedStart = segment.preparedStart + candidate.start - segment.referenceStart;
    const preparedEnd = segment.preparedStart + candidate.end - segment.referenceStart;
    if (preparedStart < segment.preparedStart || preparedEnd > segment.preparedEnd || preparedStart > preparedEnd) {
      return null;
    }
    return {
      preparedStart: preparedStart,
      preparedEnd: preparedEnd,
      sequence: preparedSequence.slice(preparedStart - 1, preparedEnd)
    };
  }

  function copySegment(segment) {
    return {
      index: segment.index,
      rna: segment.rna,
      referenceId: segment.referenceId,
      referenceStart: segment.referenceStart,
      referenceEnd: segment.referenceEnd,
      preparedStart: segment.preparedStart,
      preparedEnd: segment.preparedEnd,
      length: segment.sequence.length
    };
  }

  function mapCofoldPairs(job, pairs) {
    const firstLength = job.sequenceOne.length;
    const totalLength = firstLength + job.sequenceTwo.length;
    const mapped = [];
    (pairs || []).forEach(function (pair) {
      const left = Number(pair.left);
      const right = Number(pair.right);
      if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) ||
          left < 1 || right <= firstLength || left > firstLength || right > totalLength) {
        return;
      }
      mapped.push({
        one: job.oneStart + left - 1,
        two: job.twoStart + right - firstLength - 1,
        recordId: job.recordId
      });
    });
    return mapped;
  }

  function aggregateEvidence(mappedPairs) {
    const counts = new Map();
    (mappedPairs || []).forEach(function (pair) {
      const one = Number(pair.one);
      const two = Number(pair.two);
      if (!Number.isSafeInteger(one) || !Number.isSafeInteger(two) || one < 1 || two < 1 || one === two) {
        return;
      }
      const key = one + "\t" + two;
      const current = counts.get(key) || { one: one, two: two, count: 0, recordIds: [] };
      current.count += 1;
      if (pair.recordId !== undefined && current.recordIds.length < 20) {
        current.recordIds.push(String(pair.recordId));
      }
      counts.set(key, current);
    });
    return Array.from(counts.values()).sort(evidenceOrder);
  }

  function evidenceOrder(left, right) {
    return right.count - left.count || left.one - right.one || left.two - right.two;
  }

  function selectFragmentEvidence(evidence, begin, end, limit) {
    const first = Number(begin);
    const last = Number(end);
    const maximum = limit === undefined ? ORIGINAL_EVIDENCE_LIMIT : Number(limit);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
      throw new Error("Evidence selection requires a valid 1-based fragment range.");
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("Evidence selection limit must be a positive integer.");
    }
    return (evidence || []).filter(function (entry) {
      return entry.one >= first && entry.one <= last && entry.two >= first && entry.two <= last;
    }).sort(evidenceOrder).slice(0, maximum);
  }

  function mergeTouchingStems(evidence) {
    const stems = [];
    (evidence || []).slice().sort(function (left, right) {
      return left.one - right.one || left.two - right.two;
    }).forEach(function (entry) {
      const current = {
        oneStart: entry.one,
        oneEnd: entry.one,
        twoStart: entry.two,
        twoEnd: entry.two,
        length: 1,
        support: Number(entry.count) || 0,
        evidencePairs: [{ one: entry.one, two: entry.two, count: Number(entry.count) || 0 }]
      };
      const existing = stems.find(function (stem) {
        return current.oneStart === stem.oneEnd + 1 && current.twoEnd === stem.twoStart - 1;
      });
      if (existing) {
        existing.oneStart = Math.min(existing.oneStart, current.oneStart);
        existing.oneEnd = Math.max(existing.oneEnd, current.oneEnd);
        existing.twoStart = Math.min(existing.twoStart, current.twoStart);
        existing.twoEnd = Math.max(existing.twoEnd, current.twoEnd);
        existing.length += 1;
        existing.support += current.support;
        existing.evidencePairs.push(current.evidencePairs[0]);
      } else {
        stems.push(current);
      }
    });

    return stems.sort(function (left, right) {
      return right.support - left.support || right.length - left.length ||
        left.oneStart - right.oneStart || left.twoStart - right.twoStart;
    }).map(function (stem, index) {
      return Object.assign({ rank: index + 1 }, stem);
    });
  }

  function stemsToConstraints(stems, limit) {
    const maximum = limit === undefined ? ORIGINAL_CONSTRAINT_LIMIT : Number(limit);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) {
      throw new Error("Constraint limit must be a whole number from 1 to 1000.");
    }
    return (stems || []).filter(function (stem) {
      return inclusiveOverlap(stem.oneStart, stem.oneEnd, stem.twoStart, stem.twoEnd) <= 0;
    }).slice(0, maximum).map(function (stem, index) {
      const coordinates = [stem.oneStart, stem.oneEnd, stem.twoStart, stem.twoEnd].sort(function (a, b) { return a - b; });
      const length = coordinates[1] - coordinates[0] + 1;
      const constraint = {
        id: "F" + (index + 1),
        rank: stem.rank || index + 1,
        left: coordinates[0],
        right: coordinates[3],
        length: length,
        support: stem.support,
        evidencePairs: stem.evidencePairs || []
      };
      constraint.pairs = expandConstraint(constraint);
      return constraint;
    });
  }

  function inclusiveOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return 1 + Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart);
  }

  function expandConstraint(constraint) {
    const length = Number(constraint.length);
    const left = Number(constraint.left);
    const right = Number(constraint.right);
    if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
      return [];
    }
    return Array.from({ length: length }, function (_, index) {
      return { left: left + index, right: right - index };
    });
  }

  function flattenConstraintPairs(constraints) {
    return (constraints || []).reduce(function (pairs, constraint) {
      return pairs.concat(constraint.pairs || expandConstraint(constraint));
    }, []).sort(function (left, right) {
      return left.left - right.left || right.right - left.right;
    });
  }

  function validateConstraintSet(constraints, sequence, minimumLoop) {
    const pairs = flattenConstraintPairs(constraints);
    const endpoints = new Set();
    const rna = String(sequence || "");
    const loop = Number(minimumLoop);
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index];
      if (pair.left < 1 || pair.right > rna.length || pair.left >= pair.right) {
        return { valid: false, reason: "outside-sequence", pair: pair };
      }
      if (pair.right - pair.left - 1 < loop) {
        return { valid: false, reason: "minimum-loop", pair: pair };
      }
      if (!CANONICAL_PAIRS.has(rna.charAt(pair.left - 1) + rna.charAt(pair.right - 1))) {
        return { valid: false, reason: "non-canonical", pair: pair };
      }
      if (endpoints.has(pair.left) || endpoints.has(pair.right)) {
        return { valid: false, reason: "reused-endpoint", pair: pair };
      }
      endpoints.add(pair.left);
      endpoints.add(pair.right);
      for (let previous = 0; previous < index; previous += 1) {
        const other = pairs[previous];
        if ((other.left < pair.left && pair.left < other.right && other.right < pair.right) ||
            (pair.left < other.left && other.left < pair.right && pair.right < other.right)) {
          return { valid: false, reason: "crossing-pairs", pair: pair };
        }
      }
    }
    return { valid: true, reason: "", pairs: pairs };
  }

  function seededShuffle(items, seed) {
    const shuffled = (items || []).slice();
    const random = mulberry32(hashSeed(seed));
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      const value = shuffled[index];
      shuffled[index] = shuffled[swap];
      shuffled[swap] = value;
    }
    return shuffled;
  }

  function hashSeed(value) {
    const text = String(value == null ? "RNAxRay" : value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    let state = seed >>> 0;
    return function () {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function scoreStructurePairs(pairs, evidence, sequenceLength) {
    const support = new Map();
    (evidence || []).forEach(function (entry) {
      const left = Math.min(entry.one, entry.two);
      const right = Math.max(entry.one, entry.two);
      const key = left + ":" + right;
      support.set(key, (support.get(key) || 0) + (Number(entry.count) || 0));
    });

    const nucleotideSupport = Array.from({ length: Math.max(0, Number(sequenceLength) || 0) }, function () { return 0; });
    let matchedPairSupport = 0;
    let matchedPairs = 0;
    const annotatedPairs = (pairs || []).map(function (pair) {
      const left = Math.min(Number(pair.left), Number(pair.right));
      const right = Math.max(Number(pair.left), Number(pair.right));
      const evidenceSupport = support.get(left + ":" + right) || 0;
      if (evidenceSupport > 0) {
        matchedPairSupport += evidenceSupport;
        matchedPairs += 1;
        if (left >= 1 && left <= nucleotideSupport.length) nucleotideSupport[left - 1] = evidenceSupport;
        if (right >= 1 && right <= nucleotideSupport.length) nucleotideSupport[right - 1] = evidenceSupport;
      }
      return Object.assign({}, pair, { evidenceSupport: evidenceSupport });
    });

    return {
      pairs: annotatedPairs,
      matchedPairs: matchedPairs,
      matchedPairSupport: matchedPairSupport,
      comradesScore: matchedPairSupport * 2,
      nucleotideSupport: nucleotideSupport,
      maximumNucleotideSupport: nucleotideSupport.reduce(function (maximum, value) { return Math.max(maximum, value); }, 0)
    };
  }

  return {
    originalLinkerLength: ORIGINAL_LINKER_LENGTH,
    originalEvidenceLimit: ORIGINAL_EVIDENCE_LIMIT,
    originalConstraintLimit: ORIGINAL_CONSTRAINT_LIMIT,
    prepareReferenceAssembly: prepareReferenceAssembly,
    mapCofoldPairs: mapCofoldPairs,
    aggregateEvidence: aggregateEvidence,
    selectFragmentEvidence: selectFragmentEvidence,
    mergeTouchingStems: mergeTouchingStems,
    stemsToConstraints: stemsToConstraints,
    expandConstraint: expandConstraint,
    flattenConstraintPairs: flattenConstraintPairs,
    validateConstraintSet: validateConstraintSet,
    seededShuffle: seededShuffle,
    scoreStructurePairs: scoreStructurePairs
  };
}));

// Arc map: a PARIS-style figure of one or two RNA structures, the
// differential interactions of a comparison and a gene track, built from
// local files in the browser (nothing is uploaded).
//
// Inputs (all optional except structure A or a length source):
//   structure A / B  dot-bracket (.dbn, one record per window, header
//                    "name:start-end" places a window) or connectivity (.ct)
//   interactions     TSV with x, y, padj and direction or log2FoldChange
//                    (RNAxRay Desktop interactions.tsv, rnaxray_compare
//                    *_enrichment.txt or *_significant.padj_heatmap.txt);
//                    x and y are 10-nt cell starts, drawn at the cell centre
//   annotation       GenBank, GFF3/GTF, BED or TSV (name, start, end)
//
// Structure B, cells of either condition and a GenBank annotation can sit
// on another reference (another strain); they are moved onto A's
// coordinates by a banded global alignment of the sequences, the same
// algorithm as RNAxRay Desktop's seqmap package.
(function () {
  "use strict";

  const BAND = 300;
  const MAX_ALIGN = 400000;
  const MAX_TRACE = 400000000; // bytes of traceback a seeded band may use
  const LOW_IDENTITY = 0.8;

  // ---- alignment

  function normaliseSequence(sequence) {
    return String(sequence || "").toUpperCase().replace(/T/g, "U").replace(/[^A-Z]/g, "");
  }

  // align(from, to) -> { to: Int32Array (1-based target per from position,
  // 0 = gap), identity, matches, mismatches, gaps, same }.  Results are
  // cached, so re-rendering does not align again.  The scores are
  // symmetric, so the inverse of from -> to is an optimal to -> from
  // alignment: it is cached too and the other direction costs no second DP.
  const alignCache = new Map();

  function cacheAlignment(key, result) {
    if (alignCache.has(key)) {
      return;
    }
    if (alignCache.size >= 8) {
      alignCache.delete(alignCache.keys().next().value);
    }
    alignCache.set(key, result);
  }

  function invertAlignment(result, length) {
    const to = new Int32Array(length);
    for (let i = 0; i < result.to.length; i += 1) {
      if (result.to[i] > 0) {
        to[result.to[i] - 1] = i + 1;
      }
    }
    return { to: to, identity: result.identity, matches: result.matches, mismatches: result.mismatches, gaps: result.gaps, same: result.same };
  }

  function align(fromSequence, toSequence) {
    const a = normaliseSequence(fromSequence);
    const b = normaliseSequence(toSequence);
    const key = a + "\u0000" + b;
    if (alignCache.has(key)) {
      return alignCache.get(key);
    }
    const result = alignUncached(a, b);
    cacheAlignment(key, result);
    if (a !== b) {
      cacheAlignment(b + "\u0000" + a, invertAlignment(result, b.length));
    }
    return result;
  }

  // seedOffset(a, b): median diagonal offset (j - i * m / n) of 12-mers
  // sampled along a that occur once in b; 0 without enough hits
  function seedOffset(a, b) {
    const k = 12;
    const n = a.length;
    const m = b.length;
    if (n < 4 * k || m < 4 * k) {
      return 0;
    }
    const index = new Map();
    for (let j = 0; j + k <= m; j += 1) {
      const word = b.substr(j, k);
      index.set(word, index.has(word) ? -1 : j);
    }
    const step = Math.max(1, Math.floor(n / 400));
    const offsets = [];
    for (let i = 0; i + k <= n; i += step) {
      const j = index.get(a.substr(i, k));
      if (j !== undefined && j >= 0) {
        offsets.push(j - Math.floor(i * m / n));
      }
    }
    if (offsets.length < 10) {
      return 0;
    }
    offsets.sort(function (x, y) { return x - y; });
    return offsets[offsets.length >> 1];
  }

  function alignUncached(a, b) {
    const n = a.length;
    const m = b.length;
    if (!n || !m) {
      throw new Error("empty sequence");
    }
    if (a === b) {
      const same = new Int32Array(n);
      for (let i = 0; i < n; i += 1) {
        same[i] = i + 1;
      }
      return { to: same, identity: 1, matches: n, mismatches: 0, gaps: 0, same: true };
    }
    if (n > MAX_ALIGN || m > MAX_ALIGN) {
      throw new Error("sequences longer than 400,000 nt are not aligned");
    }
    const w = BAND + Math.abs(n - m);
    // a large end indel at about equal length puts the path off the
    // diagonal: widen the band on that side by the k-mer offset
    let offset = seedOffset(a, b);
    if (Math.abs(offset) <= BAND / 2 || (n + 1) * (2 * w + Math.abs(offset) + 2) > MAX_TRACE) {
      offset = 0;
    }
    const rowLo = new Int32Array(n + 1);
    const rowHi = new Int32Array(n + 1);
    for (let i = 0; i <= n; i += 1) {
      const centre = Math.floor(i * m / n);
      rowLo[i] = Math.max(0, centre + Math.min(0, offset) - w);
      rowHi[i] = Math.min(m, centre + Math.max(0, offset) + w);
    }
    const NEG = -1000000000;
    const width = 2 * w + Math.abs(offset) + 2;
    let prev = new Int32Array(width).fill(NEG);
    let cur = new Int32Array(width).fill(NEG);
    const trace = new Uint8Array((n + 1) * width);
    const codesA = new Uint8Array(n);
    const codesB = new Uint8Array(m);
    for (let i = 0; i < n; i += 1) {
      codesA[i] = a.charCodeAt(i);
    }
    for (let j = 0; j < m; j += 1) {
      codesB[j] = b.charCodeAt(j);
    }
    for (let j = rowLo[0]; j <= rowHi[0]; j += 1) {
      prev[j - rowLo[0]] = -3 * j;
      trace[j - rowLo[0]] = 2;
    }
    for (let i = 1; i <= n; i += 1) {
      const l = rowLo[i];
      const h = rowHi[i];
      const pl = rowLo[i - 1];
      const ph = rowHi[i - 1];
      const ca = codesA[i - 1];
      const rowBase = i * width;
      cur.fill(NEG);
      for (let j = l; j <= h; j += 1) {
        const k = j - l;
        let best = NEG;
        let dir = 0;
        if (j > 0 && j - 1 >= pl && j - 1 <= ph) {
          const d = prev[j - 1 - pl];
          if (d > NEG) {
            best = d + (ca === codesB[j - 1] ? 2 : -1);
          }
        }
        if (j >= pl && j <= ph) {
          const up = prev[j - pl];
          if (up > NEG && up - 3 > best) {
            best = up - 3;
            dir = 1;
          }
        }
        if (j > l) {
          const left = cur[k - 1];
          if (left > NEG && left - 3 > best) {
            best = left - 3;
            dir = 2;
          }
        } else if (j === 0) {
          best = -3 * i;
          dir = 1;
        }
        cur[k] = best;
        trace[rowBase + k] = dir;
      }
      const swap = prev;
      prev = cur;
      cur = swap;
    }
    if (m < rowLo[n] || m > rowHi[n]) {
      throw new Error("alignment band does not reach the end");
    }
    const out = { to: new Int32Array(n), identity: 0, matches: 0, mismatches: 0, gaps: 0, same: false };
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      let dir = 2;
      if (i > 0 && j >= rowLo[i] && j <= rowHi[i]) {
        dir = trace[i * width + j - rowLo[i]];
      } else if (i > 0) {
        dir = 1;
      }
      if (i === 0) {
        dir = 2;
      }
      if (j === 0 && i > 0) {
        dir = 1;
      }
      if (dir === 0) {
        out.to[i - 1] = j;
        if (codesA[i - 1] === codesB[j - 1]) {
          out.matches += 1;
        } else {
          out.mismatches += 1;
        }
        i -= 1;
        j -= 1;
      } else if (dir === 1) {
        out.gaps += 1;
        i -= 1;
      } else {
        out.gaps += 1;
        j -= 1;
      }
    }
    const columns = out.matches + out.mismatches + out.gaps;
    out.identity = columns ? out.matches / columns : 0;
    return out;
  }

  function mapPosition(map, position) {
    if (!map) {
      return position;
    }
    return position >= 1 && position <= map.to.length ? map.to[position - 1] : 0;
  }

  // nearest aligned position within reach nt (window ends, cell centres)
  function mapNearest(map, position, reach) {
    if (!map) {
      return position;
    }
    for (let d = 0; d <= reach; d += 1) {
      const before = mapPosition(map, position - d);
      if (before > 0) {
        return before + d;
      }
      const after = mapPosition(map, position + d);
      if (after > 0) {
        return Math.max(1, after - d);
      }
    }
    return 0;
  }

  // ---- structures

  const SEQUENCE_LINE = /^[ACGUTRYKMSWBDHVN]+$/i;
  const STRUCTURE_LINE = /^[().\[\]{}<>A-Za-z]+$/;
  const OPEN = "([{<ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const CLOSE = ")]}>abcdefghijklmnopqrstuvwxyz";

  function dotBracketPairs(structure, offset) {
    const stacks = {};
    const pairs = [];
    for (let i = 0; i < structure.length; i += 1) {
      const ch = structure[i];
      const open = OPEN.indexOf(ch);
      if (open >= 0) {
        (stacks[open] = stacks[open] || []).push(i + 1);
        continue;
      }
      const close = CLOSE.indexOf(ch);
      if (close >= 0 && stacks[close] && stacks[close].length) {
        pairs.push([stacks[close].pop() + offset - 1, i + 1 + offset - 1]);
      }
    }
    return pairs;
  }

  // parseStructure(text, name) -> { name, format, records: [{start, end,
  // sequence}], pairs: [[i, j]], sequence (full, when one record starts at 1), length }
  function parseStructure(text, fileName) {
    const lines = String(text || "").split(/\r?\n/);
    const first = lines.find(function (line) { return line.trim(); }) || "";
    if (/^\s*\d+\s+\S/.test(first) && !SEQUENCE_LINE.test(first.trim())) {
      return parseCt(lines, fileName);
    }
    const records = [];
    let current = null;
    lines.forEach(function (raw) {
      const line = raw.trim();
      if (!line) {
        return;
      }
      if (line[0] === ">") {
        current = { header: line.slice(1).trim(), sequence: "", structure: "" };
        records.push(current);
        return;
      }
      if (!current) {
        current = { header: fileName || "structure", sequence: "", structure: "" };
        records.push(current);
      }
      const token = line.split(/\s+/)[0];
      // sequence lines (IUPAC letters) come first; after the structure, only
      // its wrapped continuation is read, not RNAfold -p's ensemble,
      // centroid and MEA lines
      if (!current.structure) {
        if (SEQUENCE_LINE.test(token)) {
          current.sequence += token;
        } else if (STRUCTURE_LINE.test(token)) {
          current.structure = token;
          current.closed = line !== token; // an energy ends the structure
        }
      } else if (!current.done && !current.closed && STRUCTURE_LINE.test(token) &&
        (!current.sequence || current.structure.length < current.sequence.length)) {
        current.structure += token;
        current.closed = line !== token;
      } else {
        current.done = true;
      }
    });
    const pairs = [];
    const parsed = [];
    records.forEach(function (record) {
      if (!record.structure) {
        return;
      }
      const window = /:(\d+)-(\d+)/.exec(record.header);
      const start = window ? Number(window[1]) : 1;
      dotBracketPairs(record.structure, start).forEach(function (pair) { pairs.push(pair); });
      parsed.push({ start: start, end: start + record.structure.length - 1, sequence: normaliseSequence(record.sequence) });
    });
    if (!parsed.length) {
      throw new Error("no dot-bracket structure found in " + (fileName || "the file"));
    }
    return structureResult(fileName, "dbn", parsed, pairs, records[0].header);
  }

  function parseCt(lines, fileName) {
    const body = lines.filter(function (line) { return line.trim(); });
    const header = body.shift();
    const length = Number(header.trim().split(/\s+/)[0]);
    let sequence = "";
    const pairs = [];
    // RNAstructure writes several structures per file: read the first
    // (its `length` rows, up to the next header)
    const isHeader = function (parts) {
      return /^\d+$/.test(parts[0]) && (parts.length < 6 || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[4]));
    };
    let rows = 0;
    let structures = 1;
    body.forEach(function (line) {
      const parts = line.trim().split(/\s+/);
      if (isHeader(parts)) {
        if (rows) {
          structures += 1;
        }
        return;
      }
      if (structures > 1 || (length && rows >= length) || parts.length < 6) {
        return;
      }
      rows += 1;
      const i = Number(parts[0]);
      const j = Number(parts[4]);
      const position = Number(parts[5]) || i;
      sequence += parts[1];
      if (j > i) {
        pairs.push([i, j, position]);
      }
    });
    const offset = body.length ? Number(body[0].trim().split(/\s+/)[5]) - 1 || 0 : 0;
    const shifted = pairs.map(function (pair) { return [pair[0] + offset, pair[1] + offset]; });
    const result = structureResult(fileName, "ct", [{ start: offset + 1, end: offset + (length || sequence.length), sequence: normaliseSequence(sequence) }],
      shifted, header.trim().split(/\s+/).slice(1).join(" "));
    if (structures > 1) {
      result.note = (fileName || "The CT file") + " holds " + structures + " structures; the first is used.";
    }
    return result;
  }

  function structureResult(fileName, format, records, pairs, title) {
    const full = records.length === 1 && records[0].start === 1 ? records[0].sequence : "";
    return {
      name: fileName || title || "structure",
      title: title || "",
      format: format,
      records: records,
      pairs: pairs.map(function (pair) { return pair[0] < pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]]; }),
      sequence: full,
      length: records.reduce(function (maximum, record) { return Math.max(maximum, record.end); }, 0)
    };
  }

  // ---- interactions

  function parseInteractions(text, fileName) {
    const lines = String(text || "").split(/\r?\n/).filter(function (line) { return line.trim() && line[0] !== "#"; });
    if (!lines.length) {
      throw new Error("no rows in " + (fileName || "the file"));
    }
    const header = lines[0].split("\t").map(function (cell) { return cell.trim(); });
    const col = function (name) { return header.indexOf(name); };
    const xi = col("x");
    const yi = col("y");
    const padjI = col("padj");
    const lfcI = col("log2FoldChange");
    const dirI = col("direction");
    if (xi < 0 || yi < 0 || padjI < 0 || (lfcI < 0 && dirI < 0)) {
      throw new Error("an interaction table needs columns x, y, padj and direction or log2FoldChange");
    }
    const rows = [];
    lines.slice(1).forEach(function (line) {
      const parts = line.split("\t");
      const x = Number(parts[xi]);
      const y = Number(parts[yi]);
      const padj = parts[padjI] === "NA" ? NaN : Number(parts[padjI]);
      const lfc = lfcI >= 0 ? Number(parts[lfcI]) : NaN;
      let up;
      if (dirI >= 0 && (parts[dirI] === "up" || parts[dirI] === "down")) {
        up = parts[dirI] === "up";
      } else {
        up = lfc > 0;
      }
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(padj)) {
        rows.push({ x: x, y: y, padj: padj, log2FoldChange: lfc, up: up });
      }
    });
    return { name: fileName || "interactions", rows: rows };
  }

  // ---- annotation (rules as RNAxRay Desktop runtime/annotation.py)

  function shortLabel(text) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (words.length > 2 && words[words.length - 2].toLowerCase() === "precursor" && words[words.length - 1].length <= 4) {
      return "pr" + words[words.length - 1];
    }
    if (words.length > 1 && words[words.length - 1].length <= 6) {
      return words[words.length - 1];
    }
    return words.join(" ").slice(0, 24);
  }

  function feature(seqid, type, start, end, name, detail) {
    return { seqid: seqid, type: type, start: Math.min(start, end), end: Math.max(start, end), name: name || type, detail: detail || name || type };
  }

  function parseGenBank(text) {
    const features = [];
    const sequences = {};
    String(text).split(/\n\/\//).forEach(function (record) {
      if (record.indexOf("FEATURES") < 0 && record.indexOf("LOCUS") < 0) {
        return;
      }
      const locus = /^LOCUS\s+(\S+)/m.exec(record);
      const version = /^VERSION\s+(\S+)/m.exec(record);
      const seqid = version ? version[1] : (locus ? locus[1] : "sequence");
      const origin = /^ORIGIN[^\n]*\n([\s\S]*)/m.exec(record);
      if (origin) {
        sequences[seqid] = normaliseSequence(origin[1]);
      }
      const table = /^FEATURES[^\n]*\n([\s\S]*?)(?=^ORIGIN|^CONTIG|$(?![\s\S]))/m.exec(record);
      if (!table) {
        return;
      }
      const blocks = [];
      let current = null;
      table[1].split(/\r?\n/).forEach(function (line) {
        if (line.length > 21 && line[5] !== " ") {
          current = { type: line.slice(5, 21).trim(), location: line.slice(21).trim(), qualifiers: [] };
          blocks.push(current);
        } else if (current && line.slice(21).startsWith("/")) {
          current.qualifiers.push(line.slice(21).trim());
        } else if (current && line.trim()) {
          if (current.qualifiers.length) {
            current.qualifiers[current.qualifiers.length - 1] += " " + line.trim();
          } else {
            current.location += line.trim();
          }
        }
      });
      blocks.forEach(function (block) {
        if (block.type === "source") {
          return;
        }
        // parts on another entry (join(AB012345.1:1..20,30..60)) are skipped
        const local = block.location.replace(/[A-Za-z_][\w]*(?:\.\d+)?:[<>]?\d+(?:[.^]{1,2}[<>]?\d+)?/g, "");
        const numbers = (local.match(/\d+/g) || []).map(Number);
        if (!numbers.length) {
          return;
        }
        const quals = {};
        block.qualifiers.forEach(function (q) {
          const eq = q.indexOf("=");
          const key = eq >= 0 ? q.slice(1, eq) : q.slice(1);
          if (!(key in quals)) {
            quals[key] = eq >= 0 ? q.slice(eq + 1).trim().replace(/^"|"$/g, "") : "";
          }
        });
        const product = quals.product || quals.note || "";
        const gene = quals.gene || quals.locus_tag || "";
        const name = block.type === "mat_peptide" ? shortLabel(product || gene) : (gene || shortLabel(product) || block.type);
        features.push(feature(seqid, block.type, Math.min.apply(null, numbers), Math.max.apply(null, numbers), name, product || gene || block.type));
      });
    });
    return { features: features, sequences: sequences };
  }

  function parseAnnotation(text, fileName) {
    const source = String(text || "");
    const lower = String(fileName || "").toLowerCase();
    let parsed;
    if (/^\s*LOCUS/.test(source) || source.slice(0, 200000).indexOf("\nFEATURES") >= 0) {
      parsed = parseGenBank(source);
      parsed.format = "genbank";
    } else {
      const features = [];
      let format = "tsv";
      let columns = null;
      source.split(/\r?\n/).forEach(function (line) {
        if (!line.trim() || line[0] === "#" || /^(track|browser)\b/.test(line)) {
          return;
        }
        const parts = line.split("\t");
        if (parts.length >= 9 && /^\d+$/.test(parts[3]) && /^\d+$/.test(parts[4])) {
          format = "gff";
          const attrs = {};
          parts[8].split(/;\s*/).forEach(function (item) {
            const m = /^([^=\s]+)[=\s]"?([^"]*)"?$/.exec(item.trim());
            if (m && !(m[1] in attrs)) {
              attrs[m[1]] = m[2];
            }
          });
          const name = attrs.Name || attrs.gene_name || attrs.gene || attrs.product || attrs.gene_id || attrs.ID || parts[2];
          features.push(feature(parts[0], parts[2], Number(parts[3]), Number(parts[4]), name.indexOf(" ") >= 0 ? shortLabel(name) : name, attrs.product || name));
          return;
        }
        if ((lower.endsWith(".bed") || format === "bed") && parts.length >= 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
          format = "bed";
          features.push(feature(parts[0], "feature", Number(parts[1]) + 1, Number(parts[2]), parts[3] || "feature"));
          return;
        }
        const cells = line.split(/\t|,/).map(function (cell) { return cell.trim(); });
        if (columns === null) {
          const names = cells.map(function (cell) { return cell.toLowerCase(); });
          if (names.indexOf("start") >= 0 && names.indexOf("end") >= 0) {
            columns = names;
            return;
          }
          columns = [];
        }
        let start;
        let end;
        let name;
        let seqid = "";
        if (columns.length) {
          const pick = function () {
            for (let k = 0; k < arguments.length; k += 1) {
              const index = columns.indexOf(arguments[k]);
              if (index >= 0 && index < cells.length) {
                return cells[index];
              }
            }
            return "";
          };
          start = pick("start");
          end = pick("end");
          name = pick("name", "gene", "feature", "label", "id");
          seqid = pick("seqid", "chrom", "sequence", "gene_id");
        } else {
          const numeric = [];
          cells.forEach(function (cell, index) { if (/^\d+$/.test(cell)) { numeric.push(index); } });
          if (numeric.length < 2) {
            return;
          }
          start = cells[numeric[0]];
          end = cells[numeric[1]];
          name = cells.find(function (cell, index) { return index !== numeric[0] && index !== numeric[1] && cell; }) || "feature";
        }
        if (/^\d+$/.test(start) && /^\d+$/.test(end)) {
          features.push(feature(seqid, "feature", Number(start), Number(end), name));
        }
      });
      parsed = { features: features, sequences: {}, format: format };
    }
    if (!parsed.features.length) {
      throw new Error("no features found in " + (fileName || "the file"));
    }
    parsed.name = fileName || "annotation";
    return parsed;
  }

  const TRACK_ORDER = ["mat_peptide", "gene", "CDS"];
  const UTR = ["5'UTR", "3'UTR", "five_prime_UTR", "three_prime_UTR"];

  // trackFeatures: one track (mature peptides, else genes, else CDS, else
  // all) plus UTRs; a feature inside another of the same type is dropped.
  function trackFeatures(annotation) {
    const seqids = Array.from(new Set(annotation.features.map(function (f) { return f.seqid; })));
    const seqid = seqids[0] || "";
    const chosen = seqids.length <= 1 ? annotation.features : annotation.features.filter(function (f) { return f.seqid === seqid; });
    let track = [];
    for (let k = 0; k < TRACK_ORDER.length && !track.length; k += 1) {
      track = chosen.filter(function (f) { return f.type === TRACK_ORDER[k]; });
    }
    if (!track.length) {
      track = chosen.filter(function (f) { return UTR.indexOf(f.type) < 0 && f.type !== "source" && f.type !== "region"; });
    }
    track = track.concat(chosen.filter(function (f) { return UTR.indexOf(f.type) >= 0; }));
    track.sort(function (left, right) { return left.start - right.start || (right.end - right.start) - (left.end - left.start); });
    const kept = [];
    track.forEach(function (f) {
      if (!kept.some(function (k) { return k.type === f.type && k.start <= f.start && f.end <= k.end; })) {
        kept.push(f);
      }
    });
    return { features: kept, seqid: seqid, sequence: annotation.sequences[seqid] || "", multiple: seqids.length > 1 };
  }

  // ---- model

  function defaultState() {
    return { a: null, b: null, interactions: null, annotation: null, errors: {}, padj: "0.01", mono: true,
      oneOn: "a", twoOn: "a", start: "", end: "", labelOne: "", labelTwo: "" };
  }

  function formatNumber(value) {
    return Number(value).toLocaleString("en-US");
  }

  // build(arcMap) -> { ready, reason, length, pairsA, pairsB, overlay, features, stats, notes }
  function build(arcMap) {
    const s = arcMap || defaultState();
    const notes = [];
    const a = s.a;
    let length = a ? a.length : 0;
    if (!a && s.interactions) {
      length = s.interactions.rows.reduce(function (maximum, row) { return Math.max(maximum, row.x + 10, row.y + 10); }, 0);
    }
    if (!length) {
      return { ready: false, reason: "Load structure A (or an interaction table) to draw the arc map." };
    }
    const maps = {};
    function mapOnto(label, sequence) {
      if (!a || !a.sequence) {
        notes.push(label + " is drawn on its own coordinates: structure A has no full-length sequence to align to.");
        return null;
      }
      if (!sequence) {
        notes.push(label + " is drawn on its own coordinates (it has no full-length sequence).");
        return null;
      }
      const key = label;
      if (!(key in maps)) {
        try {
          maps[key] = align(sequence, a.sequence);
          if (!maps[key].same && maps[key].identity < LOW_IDENTITY) {
            notes.push("Warning: " + label + " aligns to A with only " + (100 * maps[key].identity).toFixed(1) +
              "% identity; positions moved onto A may be wrong. Check that it is the same gene or genome.");
          }
        } catch (error) {
          notes.push(label + " could not be aligned to A: " + error.message + "; drawn on its own coordinates.");
          maps[key] = null;
        }
      }
      return maps[key];
    }
    [a, s.b].forEach(function (structure) {
      if (structure && structure.note) {
        notes.push(structure.note);
      }
    });
    const pairsA = a ? a.pairs.slice() : [];
    let pairsB = [];
    let bMap = null;
    if (s.b) {
      bMap = s.b.sequence && a && a.sequence && s.b.sequence !== a.sequence ? mapOnto("B", s.b.sequence) : null;
      let dropped = 0;
      s.b.pairs.forEach(function (pair) {
        const i = mapPosition(bMap, pair[0]);
        const j = mapPosition(bMap, pair[1]);
        if (!i || !j) {
          dropped += 1;
          return;
        }
        pairsB.push(i < j ? [i, j] : [j, i]);
      });
      if (bMap && !bMap.same) {
        notes.push("B is shown on A's coordinates by alignment: " + (100 * bMap.identity).toFixed(1) + "% identity, " +
          formatNumber(bMap.mismatches) + " mismatches, " + formatNumber(bMap.gaps) + " gap columns" +
          (dropped ? "; " + formatNumber(dropped) + " pairs with an unaligned end left out." : "."));
      }
    }
    // shared pairs, counted where both structures are defined
    const coverB = s.b ? s.b.records.map(function (record) {
      return [mapNearest(bMap, record.start, 50) || record.start, mapNearest(bMap, record.end, 50) || record.end];
    }) : [];
    const coverA = a ? a.records.map(function (record) { return [record.start, record.end]; }) : [];
    const inside = function (pair, spans) { return spans.some(function (span) { return pair[0] >= span[0] && pair[1] <= span[1]; }); };
    const statsA = s.b ? pairsA.filter(function (pair) { return inside(pair, coverB); }) : pairsA;
    const statsB = s.b ? pairsB.filter(function (pair) { return inside(pair, coverA); }) : pairsB;
    const setA = new Set(statsA.map(function (pair) { return pair[0] + ":" + pair[1]; }));
    const shared = statsB.filter(function (pair) { return setA.has(pair[0] + ":" + pair[1]); }).length;

    const overlay = [];
    if (s.interactions) {
      const cutoff = Number(s.padj);
      const maps2 = {
        a: null,
        b: s.b && s.b.sequence && a && a.sequence && s.b.sequence !== a.sequence ? mapOnto("B", s.b.sequence) : null
      };
      let up = 0;
      let down = 0;
      let lost = 0;
      s.interactions.rows.forEach(function (row) {
        if (!(row.padj < cutoff)) {
          return;
        }
        const on = row.up ? s.oneOn : s.twoOn;
        const map = on === "b" ? maps2.b : null;
        let i = Math.min(row.x, row.y) + 5;
        let j = Math.max(row.x, row.y) + 5;
        if (map) {
          i = mapNearest(map, i, 10);
          j = mapNearest(map, j, 10);
          if (!i || !j) {
            lost += 1;
            return;
          }
        }
        overlay.push({ i: i, j: j, up: row.up, padj: row.padj });
        if (row.up) {
          up += 1;
        } else {
          down += 1;
        }
      });
      const labelOne = s.labelOne || "condition one";
      const labelTwo = s.labelTwo || "condition two";
      notes.push("Differential arcs: " + formatNumber(up + down) + " interactions with padj < " + cutoff + ", " + formatNumber(up) +
        " higher in " + labelOne + " (above) and " + formatNumber(down) + " higher in " + labelTwo + " (below)" +
        (lost ? "; " + formatNumber(lost) + " with an unaligned end left out." : "."));
      ["one", "two"].forEach(function (side) {
        if ((side === "one" ? s.oneOn : s.twoOn) === "b" && maps2.b && !maps2.b.same) {
          notes.push("Cells higher in " + (side === "one" ? labelOne : labelTwo) + " were moved from B's reference onto A's.");
        }
      });
    }

    let features = [];
    if (s.annotation) {
      const track = trackFeatures(s.annotation);
      let map = null;
      if (track.sequence && a && a.sequence && track.sequence !== a.sequence) {
        map = mapOnto("The gene annotation (" + (track.seqid || s.annotation.name) + ")", track.sequence);
        if (map && !map.same) {
          notes.push("Gene track moved from " + (track.seqid || s.annotation.name) + " onto A by alignment (" + (100 * map.identity).toFixed(1) + "% identity).");
        }
      }
      if (track.multiple) {
        notes.push("The annotation holds several sequences; the track shows " + track.seqid + ".");
      }
      track.features.forEach(function (f) {
        const start = map ? mapNearest(map, f.start, 30) : f.start;
        const end = map ? mapNearest(map, f.end, 30) : f.end;
        if (start && end) {
          features.push({ start: start, end: end, name: f.name, detail: f.detail });
        }
      });
    }
    return {
      ready: true,
      length: length,
      pairsA: pairsA,
      pairsB: pairsB,
      overlay: overlay,
      features: features,
      stats: { pairsA: statsA.length, pairsB: statsB.length, shared: shared, onlyA: statsA.length - shared, onlyB: statsB.length - shared },
      notes: notes
    };
  }

  // ---- SVG

  function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
  }

  function niceStep(span) {
    let step = Math.pow(10, Math.floor(Math.log10(Math.max(span, 1) / 5)));
    [1, 2, 5, 10].some(function (m) {
      if (span / (step * m) <= 8) {
        step *= m;
        return true;
      }
      return false;
    });
    return Math.max(1, step);
  }

  // svg(arcMap, model, colours) -> standalone SVG markup
  function svg(arcMap, model, colours) {
    const c = Object.assign({ ink: "#222222", muted: "#6b7280", line: "#c7ced6", a: "#d64541", b: "#2b6cc4", shared: "#8c8c8c",
      up: "#c62828", down: "#1f4e9e", track: ["#d9d9d9", "#bdbdbd"], background: "#ffffff" }, colours || {});
    // one-colour structures: the ink in print, the structure colour on screen
    c.structure = c.structure || c.ink;
    const s = arcMap;
    const width = 1000;
    const left = 16;
    const plotW = width - 2 * left;
    const half = 210;
    const twoSided = model.pairsB.length > 0 || model.overlay.some(function (o) { return !o.up; });
    const top = 34;
    const plotH = twoSided ? 2 * half : half;
    const base = top + half;
    const track = model.features.length ? 22 : 0;
    const start = Math.max(1, Number(s.start) || 1);
    const end = Math.min(model.length, Number(s.end) || model.length);
    const span = Math.max(1, end - start);
    // ticks, then the axis title (K5), then the legend
    const legendY = top + plotH + track + 54;
    const height = legendY + 14;
    const x = function (pos) { return left + (pos - start) / span * plotW; };
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" width="' + width + '" height="' + height +
      '" font-family="Inter, Arial, sans-serif" font-size="11" role="img" aria-label="Arc map">');
    parts.push("<title>Arc map</title>");
    parts.push('<rect width="100%" height="100%" fill="' + c.background + '"/>');
    parts.push('<text x="' + left + '" y="20" font-size="13" font-weight="600" fill="' + c.ink + '">' +
      escapeXml((s.a ? s.a.name : "Arc map") + " · " + formatNumber(start) + "–" + formatNumber(end)) + "</text>");
    parts.push('<defs><clipPath id="arcmap-clip"><rect x="' + left + '" y="' + top + '" width="' + plotW + '" height="' + plotH + '"/></clipPath></defs>');
    parts.push('<g clip-path="url(#arcmap-clip)" fill="none">');
    function arcPath(i, j, up, byWidth) {
      const x0 = x(i);
      const x1 = x(j);
      const rx = (x1 - x0) / 2;
      let h = byWidth ? (half - 6) * Math.min(1, 0.06 + 0.94 * (x1 - x0) / plotW) : Math.min(rx, half - 6);
      if (up) {
        h = -h;
      }
      const k = 0.5523;
      const mid = (x0 + x1) / 2;
      return "M" + x0.toFixed(1) + " " + base + "C" + x0.toFixed(1) + " " + (base + h * k).toFixed(1) + " " + (mid - rx * k).toFixed(1) + " " +
        (base + h).toFixed(1) + " " + mid.toFixed(1) + " " + (base + h).toFixed(1) + "C" + (mid + rx * k).toFixed(1) + " " + (base + h).toFixed(1) + " " +
        x1.toFixed(1) + " " + (base + h * k).toFixed(1) + " " + x1.toFixed(1) + " " + base;
    }
    const visible = function (pair) { return pair[1] >= start && pair[0] <= end; };
    const setA = new Set(model.pairsA.map(function (p) { return p[0] + ":" + p[1]; }));
    const setB = new Set(model.pairsB.map(function (p) { return p[0] + ":" + p[1]; }));
    const mono = s.mono;
    const layers = [
      { pairs: model.pairsA.filter(function (p) { return !setB.has(p[0] + ":" + p[1]); }), up: true, colour: mono ? c.structure : c.a },
      { pairs: model.pairsB.filter(function (p) { return !setA.has(p[0] + ":" + p[1]); }), up: false, colour: mono ? c.structure : c.b },
      { pairs: model.pairsA.filter(function (p) { return setB.has(p[0] + ":" + p[1]); }), up: true, colour: mono ? c.structure : c.shared },
      { pairs: model.pairsB.filter(function (p) { return setA.has(p[0] + ":" + p[1]); }), up: false, colour: mono ? c.structure : c.shared }
    ];
    layers.forEach(function (layer) {
      const d = layer.pairs.filter(visible).map(function (p) { return arcPath(p[0], p[1], layer.up, false); }).join("");
      if (d) {
        parts.push('<path d="' + d + '" stroke="' + layer.colour + '" stroke-width="0.8"/>');
      }
    });
    [true, false].forEach(function (up) {
      const d = model.overlay.filter(function (o) { return o.up === up && visible([o.i, o.j]); })
        .map(function (o) { return arcPath(o.i, o.j, up, true); }).join("");
      if (d) {
        parts.push('<path d="' + d + '" stroke="' + (up ? c.up : c.down) + '" stroke-opacity="0.85" stroke-width="1.3"/>');
      }
    });
    parts.push("</g>");
    parts.push('<line x1="' + left + '" y1="' + base + '" x2="' + (left + plotW) + '" y2="' + base + '" stroke="' + c.line + '"/>');
    if (track) {
      const y = top + plotH + 3;
      model.features.forEach(function (f, index) {
        if (f.end < start || f.start > end) {
          return;
        }
        const x0 = Math.max(left, x(f.start));
        const x1 = Math.min(left + plotW, x(f.end + 1));
        parts.push('<rect x="' + x0.toFixed(1) + '" y="' + y + '" width="' + Math.max(0.5, x1 - x0).toFixed(1) + '" height="16" fill="' +
          c.track[index % 2] + '"><title>' + escapeXml(f.detail + " " + f.start + "–" + f.end) + "</title></rect>");
        if (f.name && x1 - x0 > 6 * f.name.length + 4) {
          parts.push('<text x="' + ((x0 + x1) / 2).toFixed(1) + '" y="' + (y + 12) + '" text-anchor="middle" font-size="10" fill="' + c.ink + '">' + escapeXml(f.name) + "</text>");
        }
      });
    }
    const axisY = top + plotH + track;
    const step = niceStep(span);
    for (let pos = Math.ceil(start / step) * step; pos <= end; pos += step) {
      const px = x(pos);
      parts.push('<line x1="' + px.toFixed(1) + '" y1="' + (axisY + 2) + '" x2="' + px.toFixed(1) + '" y2="' + (axisY + 6) + '" stroke="' + c.line + '"/>');
      parts.push('<text x="' + px.toFixed(1) + '" y="' + (axisY + 18) + '" text-anchor="middle" fill="' + c.muted + '">' + pos + "</text>");
    }
    // B is drawn on A's coordinates, so the axis is A's
    parts.push('<text class="arcmap-axis-title" x="' + (left + plotW / 2).toFixed(1) + '" y="' + (axisY + 34) + '" text-anchor="middle" fill="' + c.ink + '">' +
      escapeXml((s.labelOne || (s.a && s.a.name) || "Structure A") + " position (nt)") + "</text>");
    const legend = [];
    if (s.a) {
      legend.push([mono ? c.structure : c.a, "A · " + s.a.name + (twoSided && model.pairsB.length ? " (above)" : "")]);
    }
    if (s.b) {
      legend.push([mono ? c.structure : c.b, "B · " + s.b.name + " (below)"]);
    }
    if (model.overlay.some(function (o) { return o.up; })) {
      legend.push([c.up, "higher in " + (s.labelOne || "condition one")]);
    }
    if (model.overlay.some(function (o) { return !o.up; })) {
      legend.push([c.down, "higher in " + (s.labelTwo || "condition two")]);
    }
    let lx = left;
    legend.forEach(function (item) {
      parts.push('<rect x="' + lx + '" y="' + (legendY - 4) + '" width="14" height="3" fill="' + item[0] + '"/>');
      parts.push('<text x="' + (lx + 20) + '" y="' + legendY + '" fill="' + c.muted + '">' + escapeXml(item[1]) + "</text>");
      lx += 40 + 6.2 * item[1].length;
    });
    parts.push("</svg>");
    return parts.join("");
  }

  // ---- card (HTML string; actions handled in analysis-ui.js)

  // The Compare page renders every card on each change; the model and its
  // SVG (alignment, ~5,000 arcs: ~150 ms) are kept while the inputs are the
  // same.  Loaded files are replaced, never changed in place, so objects are
  // compared by identity and settings by value.
  const objectIds = new WeakMap();
  let nextObjectId = 1;
  let lastCard = null;

  function stateKey(s) {
    // errors are shown by the card, not drawn
    return Object.keys(s).filter(function (key) { return key !== "errors"; }).sort().map(function (key) {
      const value = s[key];
      if (value && typeof value === "object") {
        if (!objectIds.has(value)) {
          objectIds.set(value, nextObjectId);
          nextObjectId += 1;
        }
        return key + "=#" + objectIds.get(value);
      }
      return key + "=" + JSON.stringify(value);
    }).join("|");
  }

  // On screen the figure takes the site's theme: its surface, ink and lines,
  // structures in the primary colour (as on the RNA Structure page and the
  // landing illustration) and the conditions' red and blue, brighter on dark.
  // The downloaded SVG keeps svg()'s white publication palette. Without a
  // document (the Node checks) the screen uses it too.
  function screenColours() {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
      return null;
    }
    const style = getComputedStyle(document.documentElement);
    const token = function (name) { return style.getPropertyValue(name).trim(); };
    const dark = document.documentElement.dataset.theme === "dark";
    return {
      ink: token("--ink"), muted: token("--muted"), line: token("--line-strong"), background: token("--surface-subtle"),
      structure: token("--primary"), a: dark ? "#e8605a" : "#d64541", b: dark ? "#4c8fe8" : "#2b6cc4", shared: token("--muted"),
      up: dark ? "#e8605a" : "#c62828", down: dark ? "#4c8fe8" : "#1f4e9e", track: [token("--line"), token("--line-strong")]
    };
  }

  function cachedModel(s) {
    const colours = screenColours();
    const key = stateKey(s) + "|" + JSON.stringify(colours);
    if (!lastCard || lastCard.key !== key) {
      const model = build(s);
      lastCard = { key: key, model: model, svg: model.ready ? svg(s, model, colours) : "" };
    }
    return lastCard;
  }

  function renderCard(arcMap, escape) {
    const s = arcMap || defaultState();
    const esc = escape || escapeXml;
    const cached = cachedModel(s);
    const model = cached.model;
    // the native input is hidden behind a button-styled label: a loaded file
    // shows its name, summary and Remove, never the browser's "No file chosen"
    const fileRow = function (key, label, accept, name, summary) {
      const input = '<input class="visually-hidden" type="file" accept="' + accept + '" data-feature="arcmap-file" data-key="' + key + '" aria-label="' + esc((name ? "Replace " : "Choose ") + label) + '">';
      return '<div class="arcmap-file control-field' + (name ? " is-loaded" : "") + '"><span>' + esc(label) + '</span><div class="file-pick">' +
        '<label class="button button-secondary file-pick-button">' + input + (name ? "Replace" : "Choose file") + "</label>" +
        (name
          ? '<span class="file-pick-name" title="' + esc(name + " · " + summary) + '"><b>' + esc(name) + "</b> · " + esc(summary) + '</span><button class="quiet-button" type="button" data-feature-action="arcmap-clear" data-key="' + key + '">Remove</button>'
          : '<span class="file-pick-name is-empty">No file</span>') +
        "</div>" + (s.errors[key] ? '<p class="notice notice-error">' + esc(s.errors[key]) + "</p>" : "") + "</div>";
    };
    const control = function (label, key, value, placeholder) {
      return '<label class="control-field"><span>' + esc(label) + '</span><input type="text" value="' + esc(value) +
        '" placeholder="' + esc(placeholder || "") + '" data-feature="arcmap-control" data-key="' + key + '"></label>';
    };
    const select = function (label, key, value, options) {
      return '<label class="control-field"><span>' + esc(label) + '</span><select data-feature="arcmap-control" data-key="' + key + '">' +
        options.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === value ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") +
        "</select></label>";
    };
    const out = [
      '<section class="data-card arcmap-card" id="arcmap-card">',
      '<div class="card-title-row"><div><h2>C · Arc map</h2><span class="card-note">One or two structures, the differential interactions of a comparison and a gene track, as in a PARIS-style figure. Its padj cutoff is separate from the differential test\'s and also drives panels D to G. Files stay in this browser.</span></div></div>',
      '<div class="arcmap-files">',
      fileRow("a", "Structure A (.dbn / .ct)", ".dbn,.db,.ct,.txt", s.a && s.a.name, s.a ? formatNumber(s.a.pairs.length) + " pairs · " + formatNumber(s.a.length) + " nt" : ""),
      fileRow("b", "Structure B (optional)", ".dbn,.db,.ct,.txt", s.b && s.b.name, s.b ? formatNumber(s.b.pairs.length) + " pairs" : ""),
      fileRow("interactions", "Differential interactions (TSV)", ".tsv,.txt", s.interactions && s.interactions.name, s.interactions ? formatNumber(s.interactions.rows.length) + " rows" : ""),
      fileRow("annotation", "Gene annotation (GenBank, GFF, BED, TSV)", ".gb,.gbk,.genbank,.gff,.gff3,.gtf,.bed,.tsv,.txt", s.annotation && s.annotation.name, s.annotation ? formatNumber(s.annotation.features.length) + " features" : ""),
      "</div>",
      '<div class="comparison-control-grid">',
      control("padj <", "padj", s.padj, "0.01"),
      control("Condition one", "labelOne", s.labelOne, "label, e.g. ZAFR"),
      control("Condition two", "labelTwo", s.labelTwo, "label, e.g. ZASI"),
      select("Condition one cells are on", "oneOn", s.oneOn, [["a", "A's reference"], ["b", "B's reference"]]),
      select("Condition two cells are on", "twoOn", s.twoOn, [["a", "A's reference"], ["b", "B's reference"]]),
      select("Structures", "mono", s.mono ? "mono" : "colour", [["mono", "One colour"], ["colour", "A red, B blue"]]),
      // empty means the whole structure: the placeholder says so in words,
      // so that an empty field does not read as a disabled one
      control("From (nt)", "start", s.start, "Start (1)"),
      control("To (nt)", "end", s.end, model.ready ? "End (" + formatNumber(model.length) + ")" : "End of structure"),
      "</div>"
    ];
    if (!model.ready) {
      out.push('<p class="card-note">' + esc(model.reason) + "</p>");
    } else {
      out.push('<div class="arcmap-figure" data-arcmap-figure>' + cached.svg + "</div>");
      out.push('<dl class="selection-stats stats-compact"><div><dt>Pairs A</dt><dd>' + formatNumber(model.stats.pairsA) + "</dd></div>" +
        (s.b ? "<div><dt>Pairs B</dt><dd>" + formatNumber(model.stats.pairsB) + "</dd></div><div><dt>Shared</dt><dd>" + formatNumber(model.stats.shared) +
          "</dd></div><div><dt>Only A · only B</dt><dd>" + formatNumber(model.stats.onlyA) + " · " + formatNumber(model.stats.onlyB) + "</dd></div>" : "") +
        "<div><dt>Differential arcs</dt><dd>" + formatNumber(model.overlay.length) + "</dd></div></dl>");
      model.notes.forEach(function (note) { out.push('<p class="card-note">' + esc(note) + "</p>"); });
      // K2: the card's download sits in an Export menu like every other card
      out.push('<div class="inline-actions"><details class="export-menu card-export-menu"><summary class="button button-secondary">Export</summary><div class="export-menu-list" role="menu"><button class="export-menu-item" type="button" role="menuitem" data-feature-action="arcmap-download-svg">Download arc map SVG</button></div></details></div>');
    }
    out.push("</section>");
    return out.join("");
  }

  // ---- state changes (called from analysis-ui.js)

  function loadFile(arcMap, key, file) {
    return file.text().then(function (text) {
      arcMap.errors[key] = "";
      try {
        if (key === "a" || key === "b") {
          arcMap[key] = parseStructure(text, file.name);
        } else if (key === "interactions") {
          arcMap.interactions = parseInteractions(text, file.name);
        } else if (key === "annotation") {
          arcMap.annotation = parseAnnotation(text, file.name);
        }
      } catch (error) {
        arcMap.errors[key] = error.message || String(error);
      }
    });
  }

  function setControl(arcMap, key, value) {
    if (key === "mono") {
      arcMap.mono = value === "mono";
    } else if (["padj", "labelOne", "labelTwo", "oneOn", "twoOn", "start", "end"].indexOf(key) >= 0) {
      arcMap[key] = value;
    }
  }

  window.RNAxRayArcMap = {
    align: align,
    mapPosition: mapPosition,
    mapNearest: mapNearest,
    LOW_IDENTITY: LOW_IDENTITY,
    parseStructure: parseStructure,
    parseInteractions: parseInteractions,
    parseAnnotation: parseAnnotation,
    trackFeatures: trackFeatures,
    defaultState: defaultState,
    build: build,
    svg: svg,
    // { model, svg } of the card's last state, shared with the result record
    cachedModel: cachedModel,
    renderCard: renderCard,
    loadFile: loadFile,
    setControl: setControl
  };
})();

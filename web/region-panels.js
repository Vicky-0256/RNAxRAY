// Region panels: local secondary structure of two lineage-enriched regions,
// cut from the genome-wide structures loaded in the Arc map card (panels D
// and E of a two-lineage summary figure).  Same rules as
// reproduce_zikv/analysis/select_regions_cplfold.py and
// window_from_structure.py:
//
//   For each direction (higher in condition one -> structure A, higher in
//   condition two -> structure B) the interactions with padj < cutoff are
//   sorted by padj; the region is the most significant one that the enriched
//   lineage's own structure forms, i.e. it has >= 1 predicted pair (i, j)
//   with |i - a| <= reach and |j - b| <= reach, a = min(x, y) + 5 and
//   b = max(x, y) + 5 on A's coordinates (B's pairs are moved onto A by the
//   alignment).  The windows are the extent of those pairs +- flank nt.
//   The two windows are then cut from both structures (B's through the
//   alignment) and drawn joined by an unpaired 3-nt linker (layout only).
//
// Files stay in the browser; nothing here folds anything.
(function (root) {
  "use strict";

  const LINKER = 3;
  const CANDIDATES_SHOWN = 40;

  function defaultState() {
    return { padj: "0.01", reach: "50", flank: "15", pickOne: "auto", pickTwo: "auto", pickFor: null, fastaA: null, fastaB: null, errors: {} };
  }

  // manual picks are ranks in one interaction table on one pair of
  // structures: they lapse when a file is loaded or removed in the Arc map card
  function pickInputs(arcMap) {
    const s = arcMap || {};
    return [s.a || null, s.b || null, s.interactions || null];
  }

  function picksStale(arcMap, rp) {
    const now = pickInputs(arcMap);
    return !!(rp && rp.pickFor) && rp.pickFor.some(function (value, k) { return value !== now[k]; });
  }

  function syncPicks(arcMap, rp) {
    if (picksStale(arcMap, rp)) {
      rp.pickOne = "auto";
      rp.pickTwo = "auto";
      rp.pickFor = null;
    }
    return rp;
  }

  function arcApi() {
    return root.RNAxRayArcMap;
  }

  function parseFasta(text, fileName) {
    const lines = String(text || "").split(/\r?\n/);
    let name = "";
    let sequence = "";
    for (let k = 0; k < lines.length; k += 1) {
      const line = lines[k].trim();
      if (!line) {
        continue;
      }
      if (line[0] === ">") {
        if (sequence) {
          break; // first record only
        }
        name = line.slice(1).trim();
        continue;
      }
      sequence += line;
    }
    sequence = sequence.toUpperCase().replace(/T/g, "U").replace(/[^A-Z]/g, "");
    if (!sequence) {
      throw new Error("no sequence found in " + (fileName || "the file"));
    }
    return { name: fileName || name || "sequence", title: name, sequence: sequence };
  }

  // full-length sequences of A and B: from the structure file, else a FASTA
  function sequences(arcMap, rp) {
    const s = arcMap || {};
    const r = rp || {};
    return {
      a: (s.a && s.a.sequence) || (r.fastaA && r.fastaA.sequence) || "",
      b: (s.b && s.b.sequence) || (r.fastaB && r.fastaB.sequence) || ""
    };
  }

  function pairTable(pairs, length) {
    const pt = new Int32Array(length + 2);
    pairs.forEach(function (pair) {
      if (pair[0] >= 1 && pair[1] <= length) {
        pt[pair[0]] = pair[1];
        pt[pair[1]] = pair[0];
      }
    });
    return pt;
  }

  // runs([...], gap) -> [[from, to]]: values within gap nt merged (as the script)
  function runs(values, gap) {
    const g = gap === undefined ? 5 : gap;
    const out = [];
    values.slice().sort(function (x, y) { return x - y; }).forEach(function (v) {
      if (out.length && v - out[out.length - 1][1] <= g) {
        out[out.length - 1][1] = v;
      } else {
        out.push([v, v]);
      }
    });
    return out;
  }

  function runsText(values) {
    const r = runs(values, 5);
    return r.length ? r.map(function (run) { return run[0] === run[1] ? String(run[0]) : run[0] + "-" + run[1]; }).join("; ") : "-";
  }

  // nested(pairs): a nested subset (the layout needs one), as Desktop's
  // regions._nested: shortest first, pairs crossing a kept pair are left out
  function nested(pairs) {
    const kept = [];
    pairs.slice().sort(function (l, r) { return (l[1] - l[0]) - (r[1] - r[0]) || l[0] - r[0]; }).forEach(function (p) {
      if (kept.every(function (k) { return !(k[0] < p[0] && p[0] < k[1] && k[1] < p[1]) && !(p[0] < k[0] && k[0] < p[1] && p[1] < k[1]); })) {
        kept.push(p);
      }
    });
    return kept.sort(function (l, r) { return l[0] - r[0]; });
  }

  // windowSummary(pt, sequence, X0, X1, Y0, Y1): port of window_from_structure.py;
  // windows that overlap or touch are merged into one (no linker), as
  // Desktop's regions.windows_of; Y0 / Y1 are then null
  function windowSummary(pt, sequence, X0, X1, Y0, Y1) {
    if (Y0 !== null && Y0 !== undefined && X0 > Y0) {
      const t0 = X0;
      const t1 = X1;
      X0 = Y0; X1 = Y1; Y0 = t0; Y1 = t1;
    }
    const merged = Y0 === null || Y0 === undefined || Y0 <= X1 + 1;
    if (merged) {
      X1 = Y1 === null || Y1 === undefined ? X1 : Math.max(X1, Y1);
      Y0 = null;
      Y1 = null;
    }
    const win = X1 - X0 + 1;
    const pos = [];
    for (let p = X0; p <= X1; p += 1) { pos.push(p); }
    for (let p = Y0 || 1; !merged && p <= Y1; p += 1) { pos.push(p); }
    const local = new Map();
    pos.forEach(function (p, k) { local.set(p, k); });
    const partnerOf = function (p) { return p >= 1 && p < pt.length ? pt[p] : 0; };
    const inside = [];
    pos.forEach(function (p, k) {
      const q = partnerOf(p);
      if (q > p && local.has(q)) {
        inside.push([k, local.get(q)]);
      }
    });
    const drawn = nested(inside);
    const chars = new Array(pos.length).fill(".");
    drawn.forEach(function (pair) { chars[pair[0]] = "("; chars[pair[1]] = ")"; });
    const dbn = chars.join("");
    const inX = function (q) { return q >= X0 && q <= X1; };
    const inY = function (q) { return q >= Y0 && q <= Y1; };
    let pairsX = 0;
    let pairsY = 0;
    let between = 0;
    const outside = [];
    const outsideBases = [];
    const bases = pos.map(function (p, k) {
      const q = partnerOf(p);
      if (q && q > p && inX(p) && inX(q)) { pairsX += 1; }
      if (q && q > p && inY(p) && inY(q)) { pairsY += 1; }
      if (q && inX(p) && inY(q)) { between += 1; }
      const out = q && !local.has(q) ? q : 0;
      if (out) {
        outside.push(q);
        outsideBases.push(p);
      }
      return { idx: k, strand: k < win ? "X" : "Y", pos: p, base: sequence ? sequence[p - 1] || "N" : "N",
        partner: q && local.has(q) ? local.get(q) : -1, outside: out };
    });
    return {
      X0: X0, X1: X1, Y0: Y0, Y1: Y1, merged: merged, win: win, linker: merged ? 0 : LINKER, dbn: dbn,
      layoutDbn: merged ? dbn : dbn.slice(0, win) + ".".repeat(LINKER) + dbn.slice(win),
      pairsX: pairsX, pairsY: pairsY, between: between, notDrawn: inside.length - drawn.length,
      outsideCount: outside.length, outsidePartners: runsText(outside), outsideRuns: runs(outside, 5),
      bases: bases
    };
  }

  // ---- layout: ViennaRNA's "simple" (polygon) coordinates, plot type 0

  function simpleLayout(dotBracket) {
    const n = dotBracket.length;
    const pt = new Int32Array(n + 3);
    const stack = [];
    for (let k = 0; k < n; k += 1) {
      if (dotBracket[k] === "(") {
        stack.push(k + 1);
      } else if (dotBracket[k] === ")" && stack.length) {
        const i = stack.pop();
        pt[i] = k + 1;
        pt[k + 1] = i;
      }
    }
    pt[0] = n;
    const angle = new Float64Array(n + 6);
    const PI = Math.PI;
    function loop(i, j) {
      let count = 2;
      const remember = [0];
      const iOld = i - 1;
      j += 1;
      while (i !== j) {
        const partner = pt[i];
        if (!partner || i === 0) {
          i += 1;
          count += 1;
        } else {
          count += 2;
          let k = i;
          let l = partner;
          remember.push(k, l);
          i = partner + 1;
          const sk = k;
          const sl = l;
          let ladder = 0;
          do {
            k += 1; l -= 1; ladder += 1;
          } while (pt[k] === l && pt[k] > k);
          let fill = ladder - 2;
          if (ladder >= 2) {
            angle[sk + 1 + fill] += PI / 2;
            angle[sl - 1 - fill] += PI / 2;
            angle[sk] += PI / 2;
            angle[sl] += PI / 2;
            if (ladder > 2) {
              for (; fill >= 1; fill -= 1) {
                angle[sk + fill] = PI;
                angle[sl - fill] = PI;
              }
            }
          }
          if (k <= l) {
            loop(k, l);
          }
        }
      }
      const polygon = PI * (count - 2) / count;
      remember.push(j);
      let begin = iOld < 0 ? 0 : iOld;
      for (let v = 1; v < remember.length; v += 1) {
        const diff = remember[v] - begin;
        for (let f = 0; f <= diff; f += 1) {
          angle[begin + f] += polygon;
        }
        v += 1;
        if (v >= remember.length) {
          break;
        }
        begin = remember[v];
      }
    }
    loop(0, n + 1);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    let alpha = 0;
    for (let i = 1; i < n; i += 1) {
      x[i] = x[i - 1] + Math.cos(alpha);
      y[i] = y[i - 1] + Math.sin(alpha);
      alpha += PI - angle[i + 1];
    }
    return { x: Array.from(x), y: Array.from(y) };
  }

  // ---- selection

  function cellsOnA(arcMap, ctx, row) {
    let a = Math.min(row.x, row.y) + 5;
    let b = Math.max(row.x, row.y) + 5;
    const on = row.up ? arcMap.oneOn : arcMap.twoOn;
    if (on === "b" && ctx.mapBA) {
      a = arcApi().mapNearest(ctx.mapBA, a, 10);
      b = arcApi().mapNearest(ctx.mapBA, b, 10);
      if (!a || !b) {
        return null;
      }
      if (a > b) {
        const t = a; a = b; b = t;
      }
    }
    return { a: a, b: b };
  }

  // context(arcMap, rp) -> { ready, reason, seqA, seqB, mapAB, mapBA, pairsA, pairsBonA, ptA, ptB, notes }
  function context(arcMap, rp) {
    const s = arcMap || {};
    if (!s.a || !s.b) {
      return { ready: false, reason: "Load structure A and structure B in the Arc map card (genome-wide folds of the two lineages)." };
    }
    if (!s.interactions) {
      return { ready: false, reason: "No differential interactions yet: run the differential test above and press Use in arc map, or load a differential interaction table in the Arc map card (C)." };
    }
    const seq = sequences(s, rp);
    const notes = [];
    let mapAB = null;
    let mapBA = null;
    if (seq.a && seq.b && seq.a !== seq.b) {
      try {
        mapBA = arcApi().align(seq.b, seq.a);
        mapAB = arcApi().align(seq.a, seq.b);
      } catch (error) {
        return { ready: false, reason: "B could not be aligned to A: " + error.message };
      }
      notes.push("B's pairs and windows are moved to and from A's coordinates by alignment (" + (100 * mapBA.identity).toFixed(1) + "% identity).");
      if (mapBA.identity < (arcApi().LOW_IDENTITY || 0.8)) {
        notes.push("Warning: only " + (100 * mapBA.identity).toFixed(1) + "% identity; the windows moved between A and B may be wrong. Check that both structures are of the same gene or genome.");
      }
    } else if (!seq.a || !seq.b) {
      notes.push("Without full-length sequences for both structures, A and B are taken to share coordinates (load FASTA references below to align them).");
    }
    const pairsA = s.a.pairs.slice().sort(byFirst);
    const pairsBonA = [];
    s.b.pairs.forEach(function (pair) {
      const i = mapBA ? arcApi().mapPosition(mapBA, pair[0]) : pair[0];
      const j = mapBA ? arcApi().mapPosition(mapBA, pair[1]) : pair[1];
      if (i && j) {
        pairsBonA.push(i < j ? [i, j] : [j, i]);
      }
    });
    pairsBonA.sort(byFirst);
    const lengthA = Math.max(s.a.length, seq.a.length);
    const lengthB = Math.max(s.b.length, seq.b.length);
    return {
      ready: true, seqA: seq.a, seqB: seq.b, mapAB: mapAB, mapBA: mapBA, pairsA: pairsA, pairsBonA: pairsBonA,
      lengthA: lengthA, lengthB: lengthB,
      ptA: pairTable(s.a.pairs, lengthA), ptB: pairTable(s.b.pairs, lengthB), notes: notes
    };
  }

  // pairs sorted by i (the context keeps them so), binary search on i
  function hits(pairs, a, b, reach) {
    let lo = 0;
    let hi = pairs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[mid][0] < a - reach) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const out = [];
    for (let k = lo; k < pairs.length && pairs[k][0] <= a + reach; k += 1) {
      if (Math.abs(pairs[k][1] - b) <= reach) {
        out.push(pairs[k]);
      }
    }
    return out;
  }

  function byFirst(left, right) {
    return left[0] - right[0] || left[1] - right[1];
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return value !== "" && value !== null && value !== undefined && Number.isFinite(n) ? n : fallback;
  }

  function options(rp) {
    const r = rp || defaultState();
    return {
      padj: numberOr(r.padj, 0.01),
      reach: Math.max(0, Math.round(numberOr(r.reach, 50))),
      flank: Math.max(0, Math.round(numberOr(r.flank, 15)))
    };
  }

  // candidates(arcMap, ctx, rp, up) -> rows of one direction, sorted by padj,
  // with rank (1-based), a, b (A coordinates) and pairs formed in A / B
  function candidates(arcMap, ctx, rp, up) {
    const o = options(rp);
    const rows = arcMap.interactions.rows.filter(function (row) { return row.up === up && row.padj < o.padj; });
    rows.sort(function (l, r) { return l.padj - r.padj; });
    const out = [];
    rows.forEach(function (row, index) {
      const cell = cellsOnA(arcMap, ctx, row);
      if (!cell) {
        return;
      }
      const own = hits(up ? ctx.pairsA : ctx.pairsBonA, cell.a, cell.b, o.reach);
      const other = hits(up ? ctx.pairsBonA : ctx.pairsA, cell.a, cell.b, o.reach);
      out.push({ rank: index + 1, x: row.x, y: row.y, a: cell.a, b: cell.b, log2FoldChange: row.log2FoldChange, padj: row.padj,
        own: own, other: other });
    });
    return out;
  }

  function mapWindow(map, from, to, length) {
    if (!map) {
      return [from, to];
    }
    const nearest = arcApi().mapNearest;
    return [Math.max(1, nearest(map, from, 50) || from), Math.min(length, nearest(map, to, 50) || to)];
  }

  // select(arcMap, rp) -> { ready, reason, notes, regions: [{ label, up, candidates, chosen, auto, windows, panels }] }
  function select(arcMap, rp) {
    const r = rp || defaultState();
    const ctx = context(arcMap, r);
    if (!ctx.ready) {
      return ctx;
    }
    const o = options(r);
    const labels = { one: arcMap.labelOne || "condition one", two: arcMap.labelTwo || "condition two" };
    const regions = [];
    [["A", true], ["B", false]].forEach(function (spec) {
      const up = spec[1];
      const list = candidates(arcMap, ctx, r, up);
      const firstFormed = list.find(function (c) { return c.own.length > 0; }) || null;
      const pick = picksStale(arcMap, r) ? "auto" : up ? r.pickOne : r.pickTwo;
      let chosen = firstFormed;
      if (pick && pick !== "auto") {
        chosen = list.find(function (c) { return String(c.rank) === String(pick); }) || firstFormed;
      }
      const region = { label: spec[0], up: up, lineage: up ? labels.one : labels.two, other: up ? labels.two : labels.one,
        candidates: list, chosen: chosen, auto: firstFormed, panels: [] };
      regions.push(region);
      if (!chosen) {
        region.reason = list.length ? "No interaction with padj < " + o.padj + " is formed by the " + region.lineage + " structure within ±" + o.reach + " nt."
          : "No interaction higher in " + region.lineage + " with padj < " + o.padj + ".";
        return;
      }
      // windows from the enriched lineage's own pairs; a picked candidate
      // without own pairs falls back to the other structure's, else the arms
      const basis = chosen.own.length ? chosen.own : chosen.other;
      let X0;
      let X1;
      let Y0;
      let Y1;
      if (basis.length) {
        X0 = Math.min.apply(null, basis.map(function (p) { return p[0]; })) - o.flank;
        X1 = Math.max.apply(null, basis.map(function (p) { return p[0]; })) + o.flank;
        Y0 = Math.min.apply(null, basis.map(function (p) { return p[1]; })) - o.flank;
        Y1 = Math.max.apply(null, basis.map(function (p) { return p[1]; })) + o.flank;
      } else {
        X0 = chosen.a - o.reach; X1 = chosen.a + o.reach; Y0 = chosen.b - o.reach; Y1 = chosen.b + o.reach;
        region.note = "Neither structure forms this interaction: windows are the arms ±" + o.reach + " nt.";
      }
      const clamp = function (v) { return Math.min(ctx.lengthA, Math.max(1, v)); };
      X0 = clamp(X0); X1 = clamp(X1); Y0 = clamp(Y0); Y1 = clamp(Y1);
      // a local hairpin: windows that overlap or touch become one
      if (Y0 <= X1 + 1) {
        X1 = Math.max(X1, Y1);
        Y0 = null;
        Y1 = null;
        region.note = (region.note ? region.note + " " : "") + "The two windows overlap and are cut as one (" + X0 + "–" + X1 + ", no linker).";
      }
      region.windows = { X0: X0, X1: X1, Y0: Y0, Y1: Y1 };
      const wb = [mapWindow(ctx.mapAB, X0, X1, ctx.lengthB), Y0 === null ? [null, null] : mapWindow(ctx.mapAB, Y0, Y1, ctx.lengthB)];
      const panelA = { structure: "a", lineage: labels.one, name: arcMap.a.name, title: arcMap.a.title,
        summary: windowSummary(ctx.ptA, ctx.seqA, X0, X1, Y0, Y1) };
      const panelB = { structure: "b", lineage: labels.two, name: arcMap.b.name, title: arcMap.b.title,
        summary: windowSummary(ctx.ptB, ctx.seqB, wb[0][0], wb[0][1], wb[1][0], wb[1][1]) };
      region.panels = up ? [panelA, panelB] : [panelB, panelA];
    });
    return { ready: true, notes: ctx.notes, regions: regions, options: o, labels: labels };
  }

  // ---- text summaries (same lines as window_from_structure.py's .txt)

  function windowsText(w, dash) {
    const d = dash || "–";
    return w.X0 + d + w.X1 + (w.Y0 === null ? "" : " / " + w.Y0 + d + w.Y1);
  }

  function summaryText(panel) {
    const s = panel.summary;
    return ["source\t" + (panel.title || panel.name), "window_X\t" + s.X0 + "-" + s.X1, "window_Y\t" + (s.merged ? "-" : s.Y0 + "-" + s.Y1),
      "pairs_in_X\t" + s.pairsX, "pairs_in_Y\t" + s.pairsY, "inter_window_pairs\t" + s.between,
      "bases_paired_outside\t" + s.outsideCount, "outside_partners\t" + s.outsidePartners].join("\n") + "\n";
  }

  function regionsTsv(model) {
    const lines = ["label\tlineage\trank\ta\tb\tlog2FC\tpadj\tpairs_own\tpairs_other\tX0\tX1\tY0\tY1"];
    model.regions.forEach(function (r) {
      if (!r.chosen) {
        return;
      }
      const c = r.chosen;
      lines.push([r.label, r.lineage, c.rank, c.a, c.b, Number(c.log2FoldChange).toFixed(2), Number(c.padj).toExponential(2),
        c.own.length, c.other.length, r.windows.X0, r.windows.X1, r.windows.Y0 === null ? "-" : r.windows.Y0, r.windows.Y1 === null ? "-" : r.windows.Y1].join("\t"));
    });
    return lines.join("\n") + "\n";
  }

  function panelsTsv(model) {
    const lines = ["region\tstructure\tlineage\tidx\tstrand\tpos\tbase\tx\ty\tpartner\toutside"];
    model.regions.forEach(function (r) {
      r.panels.forEach(function (panel) {
        const xy = simpleLayout(panel.summary.layoutDbn);
        panel.summary.bases.forEach(function (b) {
          const k = b.idx < panel.summary.win ? b.idx : b.idx + panel.summary.linker;
          lines.push([r.label, panel.structure.toUpperCase(), panel.lineage, b.idx, b.strand, b.pos, b.base,
            xy.x[k].toFixed(2), xy.y[k].toFixed(2), b.partner, b.outside].join("\t"));
        });
      });
    });
    return lines.join("\n") + "\n";
  }

  // ---- SVG

  function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
  }

  const COLOURS = { ink: "#222222", muted: "#6b7280", line: "#9aa3ad", pair: "#4b5563", one: "#c62828", two: "#1f4e9e",
    unpaired: "#e5e7eb", paired: "#9ca3af", background: "#ffffff" };

  // one structure diagram in a box (x, y, w, h); returns SVG elements
  function panelSvg(panel, highlight, box, c) {
    const s = panel.summary;
    const xy = simpleLayout(s.layoutDbn);
    const total = s.layoutDbn.length;
    const local = function (k) { return k < s.win ? k : k + s.linker; };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < total; k += 1) {
      minX = Math.min(minX, xy.x[k]); maxX = Math.max(maxX, xy.x[k]);
      minY = Math.min(minY, xy.y[k]); maxY = Math.max(maxY, xy.y[k]);
    }
    const pad = 14;
    const scale = Math.min((box.w - 2 * pad) / Math.max(1, maxX - minX), (box.h - 2 * pad) / Math.max(1, maxY - minY), 14);
    const ox = box.x + (box.w - scale * (maxX - minX)) / 2;
    const oy = box.y + (box.h - scale * (maxY - minY)) / 2;
    const px = function (k) { return ox + (xy.x[k] - minX) * scale; };
    const py = function (k) { return oy + (xy.y[k] - minY) * scale; };
    const r = Math.max(1.6, Math.min(5.5, scale * 0.42));
    const out = [];
    // backbone (linker dashed)
    let d = "";
    for (let k = 0; k + 1 < total; k += 1) {
      const linker = s.linker && k >= s.win - 1 && k < s.win + s.linker;
      if (!linker) {
        d += "M" + px(k).toFixed(1) + " " + py(k).toFixed(1) + "L" + px(k + 1).toFixed(1) + " " + py(k + 1).toFixed(1);
      }
    }
    out.push('<path d="' + d + '" stroke="' + c.line + '" stroke-width="1" fill="none"/>');
    let dl = "";
    for (let k = s.win - 1; s.linker && k < s.win + s.linker && k + 1 < total; k += 1) {
      dl += "M" + px(k).toFixed(1) + " " + py(k).toFixed(1) + "L" + px(k + 1).toFixed(1) + " " + py(k + 1).toFixed(1);
    }
    if (dl) {
      out.push('<path d="' + dl + '" stroke="' + c.line + '" stroke-width="1" stroke-dasharray="2 2" fill="none"/>');
    }
    // pairs (crossing pairs left out of the layout are not drawn)
    let dIntra = "";
    let dInter = "";
    s.bases.forEach(function (b) {
      if (b.partner > b.idx && s.dbn[b.idx] === "(") {
        const seg = "M" + px(local(b.idx)).toFixed(1) + " " + py(local(b.idx)).toFixed(1) + "L" + px(local(b.partner)).toFixed(1) + " " + py(local(b.partner)).toFixed(1);
        if (b.idx < s.win && b.partner >= s.win) {
          dInter += seg;
        } else {
          dIntra += seg;
        }
      }
    });
    if (dIntra) {
      out.push('<path d="' + dIntra + '" stroke="' + c.pair + '" stroke-width="1.4"/>');
    }
    if (dInter) {
      out.push('<path d="' + dInter + '" stroke="' + highlight + '" stroke-width="2"/>');
    }
    // bases
    s.bases.forEach(function (b) {
      const k = local(b.idx);
      const tip = b.pos + " " + b.base + (b.partner >= 0 ? " paired with " + s.bases[b.partner].pos : b.outside ? " paired outside with " + b.outside : " unpaired");
      let fill = c.unpaired;
      let stroke = "none";
      if (b.outside) {
        fill = c.background;
        stroke = c.ink;
      } else if (b.partner >= 0) {
        fill = b.idx < s.win && b.partner >= s.win || b.idx >= s.win && b.partner < s.win ? highlight : c.paired;
      }
      out.push('<circle cx="' + px(k).toFixed(1) + '" cy="' + py(k).toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + fill + '"' +
        (stroke !== "none" ? ' stroke="' + stroke + '" stroke-width="0.9"' : "") + "><title>" + escapeXml(tip) + "</title></circle>");
      if (r >= 4.5) {
        out.push('<text x="' + px(k).toFixed(1) + '" y="' + (py(k) + 2.6).toFixed(1) + '" font-size="' + (r * 1.35).toFixed(1) +
          '" text-anchor="middle" fill="' + (fill === highlight ? "#ffffff" : c.ink) + '">' + b.base + "</text>");
      }
    });
    // window ends
    (s.merged ? [[0, s.X0], [s.win - 1, s.X1]] : [[0, s.X0], [s.win - 1, s.X1], [s.win, s.Y0], [s.bases.length - 1, s.Y1]]).forEach(function (end) {
      const k = local(end[0]);
      out.push('<text x="' + (px(k) + r + 2).toFixed(1) + '" y="' + (py(k) - r - 1).toFixed(1) + '" font-size="9" fill="' + c.muted + '">' + end[1] + "</text>");
    });
    return out.join("");
  }

  // svg(model) -> standalone SVG with the two regions (D, E), two panels each
  function svg(model, colours) {
    const c = Object.assign({}, COLOURS, colours || {});
    const regions = model.regions.filter(function (r) { return r.chosen; });
    const cellW = 420;
    const cellH = 400;
    const head = 40;
    const foot = 76;
    const width = 2 * cellW + 30;
    const height = regions.length * (head + cellH + foot) + 30;
    const parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" width="' + width + '" height="' + height +
      '" font-family="Inter, Arial, sans-serif" font-size="11" role="img" aria-label="Region structures">', "<title>Region structures</title>",
      '<rect width="100%" height="100%" fill="' + c.background + '"/>'];
    regions.forEach(function (region, index) {
      const top = 10 + index * (head + cellH + foot);
      const highlight = region.up ? c.one : c.two;
      const ch = region.chosen;
      parts.push('<text x="10" y="' + (top + 16) + '" font-size="14" font-weight="700" fill="' + c.ink + '">' + (region.label === "A" ? "D" : "E") + "</text>");
      parts.push('<text x="30" y="' + (top + 16) + '" font-size="13" font-weight="600" fill="' + c.ink + '">' +
        escapeXml("Region " + region.label + " · " + region.lineage + "-enriched #" + ch.rank + " · " + ch.a + "↔" + ch.b +
          " · log2FC " + Number(ch.log2FoldChange).toFixed(2) + " · padj " + Number(ch.padj).toExponential(2)) + "</text>");
      region.panels.forEach(function (panel, column) {
        const x = 10 + column * (cellW + 10);
        const s = panel.summary;
        parts.push('<text x="' + x + '" y="' + (top + 34) + '" font-size="12" font-weight="600" fill="' + c.ink + '">' +
          escapeXml(panel.lineage + " structure · " + windowsText(s)) + "</text>");
        parts.push('<rect x="' + x + '" y="' + (top + head) + '" width="' + cellW + '" height="' + cellH + '" fill="none" stroke="#e5e7eb"/>');
        parts.push(panelSvg(panel, highlight, { x: x, y: top + head, w: cellW, h: cellH }, c));
        const lines = [(s.merged ? s.pairsX + " pairs in the window" : s.between + " inter-window pairs · " + s.pairsX + " in X · " + s.pairsY + " in Y") +
          " · " + s.outsideCount + " paired outside" + (s.notDrawn ? " · " + s.notDrawn + " crossing not drawn" : "")];
        let current = "outside partners:";
        s.outsidePartners.split("; ").forEach(function (item, k) {
          const next = current + (k ? "; " : " ") + item;
          if (next.length > 70 && k) {
            lines.push(current + ";");
            current = "  " + item;
          } else {
            current = next;
          }
        });
        lines.push(current);
        lines.slice(0, 4).forEach(function (line, k) {
          parts.push('<text x="' + x + '" y="' + (top + head + cellH + 16 + 14 * k) + '" fill="' + c.muted + '">' + escapeXml(line) + "</text>");
        });
      });
    });
    parts.push('<text x="10" y="' + (height - 8) + '" font-size="10" fill="' + c.muted + '">' +
      escapeXml((regions.some(function (r) { return r.panels.some(function (p) { return p.summary && !p.summary.merged; }); })
        ? "Windows joined by a " + LINKER + "-nt unpaired linker (dashed, layout only); coloured lines = pairs between the windows; "
        : "Overlapping windows drawn as one; ") + "hollow = paired outside the windows.") + "</text>");
    parts.push("</svg>");
    return parts.join("");
  }

  // ---- card

  function renderCard(arcMap, rp, escape) {
    const r = syncPicks(arcMap, rp || defaultState());
    const esc = escape || escapeXml;
    const s = arcMap || (arcApi() ? arcApi().defaultState() : {});
    const control = function (label, key, value, placeholder) {
      return '<label class="control-field"><span>' + esc(label) + '</span><input type="text" value="' + esc(value) +
        '" placeholder="' + esc(placeholder || "") + '" data-feature="regions-control" data-key="' + key + '"></label>';
    };
    // a button-styled label over the hidden input, as in the Arc map card
    const fasta = function (key, label, loaded) {
      const summary = loaded ? loaded.sequence.length.toLocaleString("en-US") + " nt" : "";
      return '<div class="arcmap-file control-field' + (loaded ? " is-loaded" : "") + '"><span>' + esc(label) + '</span><div class="file-pick">' +
        '<label class="button button-secondary file-pick-button"><input class="visually-hidden" type="file" accept=".fa,.fasta,.fna,.txt" data-feature="regions-fasta" data-key="' + key +
        '" aria-label="' + esc((loaded ? "Replace " : "Choose ") + label) + '">' + (loaded ? "Replace" : "Choose file") + "</label>" +
        (loaded
          ? '<span class="file-pick-name" title="' + esc(loaded.name + " · " + summary) + '"><b>' + esc(loaded.name) + "</b> · " + esc(summary) + '</span><button class="quiet-button" type="button" data-feature-action="regions-fasta-clear" data-key="' + key + '">Remove</button>'
          : '<span class="file-pick-name is-empty">No file</span>') +
        "</div>" + (r.errors && r.errors[key] ? '<p class="notice notice-error">' + esc(r.errors[key]) + "</p>" : "") + "</div>";
    };
    const out = ['<section class="data-card region-panels-card" id="region-panels-card">',
      '<div class="card-title-row"><div><h2>D, E · Region structures</h2><span class="card-note">For each direction, the most significant interaction that the enriched lineage\'s own structure forms (a predicted pair within reach of both arms), cut from both structures loaded in the Arc map card. Structure A is condition one\'s lineage, B is condition two\'s.</span></div></div>',
      '<div class="comparison-control-grid">', control("padj <", "padj", r.padj, "0.01"), control("Reach (nt)", "reach", r.reach, "50"), control("Flank (nt)", "flank", r.flank, "15"), "</div>"];
    const needsFasta = s.a && s.b && (!s.a.sequence || !s.b.sequence);
    if (needsFasta || r.fastaA || r.fastaB) {
      out.push('<div class="arcmap-files">', fasta("fastaA", "Reference of A (FASTA)", r.fastaA), fasta("fastaB", "Reference of B (FASTA)", r.fastaB), "</div>");
    }
    const model = arcApi() ? select(s, r) : { ready: false, reason: "The arc map module is not loaded." };
    if (!model.ready) {
      out.push('<p class="card-note">' + esc(model.reason) + "</p></section>");
      return out.join("");
    }
    const cellsNote = [];
    if (s.oneOn === "b") { cellsNote.push("cells higher in " + model.labels.one + " are read on B's reference"); }
    if (s.twoOn === "b") { cellsNote.push("cells higher in " + model.labels.two + " are read on B's reference"); }
    model.notes.forEach(function (note) { out.push('<p class="card-note">' + esc(note) + "</p>"); });
    out.push('<p class="card-note">Interaction cells are taken on A\'s reference' + (cellsNote.length ? " except: " + esc(cellsNote.join("; ")) + " (moved onto A; set in the Arc map card)" : "") + ".</p>");
    out.push('<div class="region-panels-grid">');
    model.regions.forEach(function (region) {
      const key = region.up ? "pickOne" : "pickTwo";
      const shown = region.candidates.slice(0, CANDIDATES_SHOWN);
      if (region.chosen && shown.indexOf(region.chosen) < 0) {
        shown.push(region.chosen);
      }
      const optionsHtml = ['<option value="auto"' + ((r[key] || "auto") === "auto" ? " selected" : "") + ">Automatic (first formed" +
        (region.auto ? ": #" + region.auto.rank : "") + ")</option>"].concat(shown.map(function (cand) {
        return '<option value="' + cand.rank + '"' + (String(r[key]) === String(cand.rank) ? " selected" : "") + ">#" + cand.rank + " · " + cand.a + "↔" + cand.b +
          " · padj " + Number(cand.padj).toExponential(2) + " · " + cand.own.length + " / " + cand.other.length + " pairs</option>";
      })).join("");
      out.push('<div class="region-panel" data-region="' + region.label + '">');
      out.push("<h3>" + (region.label === "A" ? "D" : "E") + " · Region " + region.label + " · " + esc(region.lineage) + "-enriched</h3>");
      out.push('<label class="control-field"><span>Interaction (pairs formed by ' + esc(region.lineage) + " / " + esc(region.other) + ')</span><select data-feature="regions-control" data-key="' + key + '">' + optionsHtml + "</select></label>");
      if (!region.chosen) {
        out.push('<p class="card-note">' + esc(region.reason) + "</p></div>");
        return;
      }
      const ch = region.chosen;
      out.push('<dl class="selection-stats"><div><dt>Rank</dt><dd>#' + ch.rank + "</dd></div><div><dt>Arms (A)</dt><dd>" + ch.a + "↔" + ch.b +
        "</dd></div><div><dt>log2FC</dt><dd>" + Number(ch.log2FoldChange).toFixed(2) + "</dd></div><div><dt>padj</dt><dd>" + Number(ch.padj).toExponential(2) +
        "</dd></div><div><dt>Windows (A)</dt><dd>" + windowsText(region.windows) + "</dd></div></dl>");
      if (region.note) {
        out.push('<p class="card-note">' + esc(region.note) + "</p>");
      }
      out.push('<div class="data-table-wrap"><table class="data-table region-table"><thead><tr><th>Structure</th><th>Windows</th><th>Pairs in X</th><th>Pairs in Y</th><th>Inter-window</th><th>Paired outside</th><th>Outside partners</th></tr></thead><tbody>');
      region.panels.forEach(function (panel) {
        const sm = panel.summary;
        out.push("<tr data-structure=\"" + panel.structure + "\"><td>" + esc(panel.lineage) + " (" + panel.structure.toUpperCase() + ")</td><td>" + windowsText(sm) +
          "</td><td>" + sm.pairsX + "</td><td>" + sm.pairsY + '</td><td data-inter>' + sm.between + "</td><td>" + sm.outsideCount + "</td><td>" + esc(sm.outsidePartners) + "</td></tr>");
      });
      out.push("</tbody></table></div></div>");
    });
    out.push("</div>");
    out.push('<div class="region-figure" data-regions-figure>' + svg(model) + "</div>");
    // K2: the card's downloads sit in one Export menu
    out.push('<div class="inline-actions"><details class="export-menu card-export-menu"><summary class="button button-secondary">Export</summary><div class="export-menu-list" role="menu">' +
      '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="regions-download-svg">Download region SVG</button>' +
      '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="regions-download-tsv">Download regions TSV</button>' +
      '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="regions-download-layout">Download layout TSV</button></div></details></div>');
    out.push("</section>");
    return out.join("");
  }

  // ---- events (delegated from analysis-ui.js)

  function ensure(state) {
    state.regionPanels = state.regionPanels || defaultState();
    state.arcMap = state.arcMap || (arcApi() ? arcApi().defaultState() : null);
    return state.regionPanels;
  }

  function handleChange(state, element, api) {
    const feature = element.dataset && element.dataset.feature;
    if (feature === "regions-control") {
      const rp = ensure(state);
      const key = element.dataset.key;
      if (["padj", "reach", "flank", "pickOne", "pickTwo"].indexOf(key) >= 0) {
        syncPicks(state.arcMap, rp);
        rp[key] = element.value;
        if (key !== "pickOne" && key !== "pickTwo") {
          rp.pickOne = "auto";
          rp.pickTwo = "auto";
          rp.pickFor = null;
        } else {
          rp.pickFor = pickInputs(state.arcMap);
        }
      }
      api.render();
      return true;
    }
    if (feature === "regions-fasta") {
      const rp = ensure(state);
      const key = element.dataset.key;
      const file = element.files && element.files[0];
      if (file) {
        file.text().then(function (text) {
          rp.errors[key] = "";
          try {
            rp[key] = parseFasta(text, file.name);
          } catch (error) {
            rp.errors[key] = error.message || String(error);
          }
          api.render();
        });
      }
      return true;
    }
    return false;
  }

  function handleAction(state, element, api) {
    const action = element.dataset && element.dataset.featureAction;
    if (!action || action.indexOf("regions-") !== 0) {
      return false;
    }
    const rp = ensure(state);
    if (action === "regions-fasta-clear") {
      rp[element.dataset.key] = null;
      api.render();
      return true;
    }
    const model = select(state.arcMap, syncPicks(state.arcMap, rp));
    if (!model.ready) {
      return true;
    }
    if (action === "regions-download-svg") {
      api.download("regions.svg", svg(model), "image/svg+xml");
    } else if (action === "regions-download-tsv") {
      const text = regionsTsv(model) + "\n" + model.regions.map(function (region) {
        return region.panels.map(function (panel) { return "# region " + region.label + " · " + panel.lineage + "\n" + summaryText(panel); }).join("\n");
      }).join("\n");
      api.download("regions.tsv", text, "text/tab-separated-values");
    } else if (action === "regions-download-layout") {
      api.download("regions-layout.tsv", panelsTsv(model), "text/tab-separated-values");
    }
    if (api.showToast) {
      api.showToast("Downloaded locally.");
    }
    return true;
  }

  root.RNAxRayRegionPanels = {
    LINKER: LINKER,
    defaultState: defaultState,
    parseFasta: parseFasta,
    sequences: sequences,
    pairTable: pairTable,
    runs: runs,
    windowSummary: windowSummary,
    nested: nested,
    syncPicks: syncPicks,
    simpleLayout: simpleLayout,
    context: context,
    candidates: candidates,
    select: select,
    summaryText: summaryText,
    regionsTsv: regionsTsv,
    panelsTsv: panelsTsv,
    svg: svg,
    renderCard: renderCard,
    handleChange: handleChange,
    handleAction: handleAction
  };
})(typeof window !== "undefined" ? window : self);

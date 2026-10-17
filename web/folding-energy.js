// Folding energy of lineage-enriched interactions in both lineages (panels F
// and G of a two-lineage summary figure), from the files of the Arc map card.
// Same rules as reproduce_zikv/analysis/folding_energy.py and
// folding_energy_stats.R:
//
//   For each interaction with padj < cutoff a fragment of L nt is centred on
//   each arm (cell start + 5, condition one's reference = A).  The two
//   fragments are joined with "&" and folded with RNAcofold (ViennaRNA,
//   default parameters, 37 C) once with A's sequence and once with B's
//   sequence at the aligned positions; fragments that run off either end are
//   skipped.  Per direction: violin + box of both lineages' dG and a paired
//   t-test.
//
// Folding runs in folding-energy.worker.js (ViennaRNA WebAssembly); this file
// also loads inside that worker (importScripts) for the cofold helper.
(function (root) {
  "use strict";

  const TEMPERATURE = 37;
  const MINIMUM_LOOP = 3;

  function defaultState() {
    return { padj: "0.01", length: "40", running: false, progress: 0, done: 0, total: 0, results: null, error: "" };
  }

  // ---- statistics

  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

  function logGamma(z) {
    if (z < 0.5) {
      return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - logGamma(1 - z);
    }
    z -= 1;
    let x = LANCZOS[0];
    for (let i = 1; i < 9; i += 1) {
      x += LANCZOS[i] / (z + i);
    }
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  // continued fraction for the incomplete beta (modified Lentz)
  function betaContinuedFraction(a, b, x) {
    const TINY = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - qab * x / qap;
    if (Math.abs(d) < TINY) { d = TINY; }
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 10000; m += 1) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < TINY) { d = TINY; }
      c = 1 + aa / c;
      if (Math.abs(c) < TINY) { c = TINY; }
      d = 1 / d;
      h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < TINY) { d = TINY; }
      c = 1 + aa / c;
      if (Math.abs(c) < TINY) { c = TINY; }
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-16) {
        break;
      }
    }
    return h;
  }

  // regularised incomplete beta I_x(a, b)
  function incompleteBeta(x, a, b) {
    if (x <= 0) { return 0; }
    if (x >= 1) { return 1; }
    const lbt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
    if (x < (a + 1) / (a + b + 2)) {
      return Math.exp(lbt) * betaContinuedFraction(a, b, x) / a;
    }
    return 1 - Math.exp(lbt) * betaContinuedFraction(b, a, 1 - x) / b;
  }

  // two-sided p-value of Student's t with df degrees of freedom
  function tTwoSided(t, df) {
    if (!Number.isFinite(t)) {
      return Number.isNaN(t) ? NaN : 0;
    }
    return incompleteBeta(df / (df + t * t), df / 2, 0.5);
  }

  // Student's t CDF, P(T <= t)
  function tCdf(t, df) {
    const tail = tTwoSided(t, df) / 2;
    return t >= 0 ? 1 - tail : tail;
  }

  function mean(values) {
    let s = 0;
    for (let i = 0; i < values.length; i += 1) { s += values[i]; }
    return values.length ? s / values.length : NaN;
  }

  function sd(values) {
    const m = mean(values);
    let s = 0;
    for (let i = 0; i < values.length; i += 1) { s += (values[i] - m) * (values[i] - m); }
    return values.length > 1 ? Math.sqrt(s / (values.length - 1)) : NaN;
  }

  // R's t.test(one, two, paired = TRUE); where R stops with "data are
  // essentially constant", t and p are NaN with a note
  function pairedTTest(one, two) {
    const n = Math.min(one.length, two.length);
    const d = [];
    for (let i = 0; i < n; i += 1) { d.push(one[i] - two[i]); }
    const md = mean(d);
    const se = sd(d) / Math.sqrt(n);
    const df = n - 1;
    const out = { n: n, meanOne: mean(one), meanTwo: mean(two), meanDiff: md, t: NaN, df: df, p: NaN };
    if (n > 1 && se < 10 * Number.EPSILON * Math.abs(md)) {
      out.note = "differences are constant";
    } else if (n > 1 && se > 0) {
      out.t = md / se;
      out.p = tTwoSided(out.t, df);
    }
    return out;
  }

  // quantile type 7 (R default)
  function quantile(sorted, q) {
    if (!sorted.length) { return NaN; }
    const h = (sorted.length - 1) * q;
    const lo = Math.floor(h);
    const hi = Math.min(sorted.length - 1, lo + 1);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  }

  // R's bw.nrd0
  function bandwidth(values) {
    const sorted = values.slice().sort(function (x, y) { return x - y; });
    const s = sd(values);
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    let lo = Math.min(s, iqr / 1.34);
    if (!(lo > 0)) {
      lo = s || Math.abs(sorted[0]) || 1;
    }
    return 0.9 * lo * Math.pow(values.length, -0.2);
  }

  // Gaussian kernel density over [min - 3 bw, max + 3 bw] (geom_violin trim = FALSE)
  function density(values, points) {
    const n = points || 256;
    const bw = bandwidth(values);
    const lo = Math.min.apply(null, values) - 3 * bw;
    const hi = Math.max.apply(null, values) + 3 * bw;
    const xs = [];
    const ys = [];
    const norm = 1 / (values.length * bw * Math.sqrt(2 * Math.PI));
    for (let k = 0; k < n; k += 1) {
      const x = lo + (hi - lo) * k / (n - 1);
      let s = 0;
      for (let i = 0; i < values.length; i += 1) {
        const u = (x - values[i]) / bw;
        s += Math.exp(-0.5 * u * u);
      }
      xs.push(x);
      ys.push(s * norm);
    }
    return { x: xs, y: ys, bw: bw };
  }

  // box statistics as geom_boxplot (quartiles type 7, whiskers 1.5 IQR)
  function boxStats(values) {
    const sorted = values.slice().sort(function (x, y) { return x - y; });
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const inside = sorted.filter(function (v) { return v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr; });
    return { q1: q1, median: quantile(sorted, 0.5), q3: q3, low: inside[0], high: inside[inside.length - 1],
      outliers: sorted.filter(function (v) { return v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr; }) };
  }

  // ---- jobs

  // forward map of a 1-based A position onto B: the aligned position, or for
  // a base facing a gap the B base after the previous aligned one (as the
  // script's align_map), clamped to B's length
  function forward(map, position, lengthB) {
    if (!map) {
      return position;
    }
    if (position < 1 || position > map.to.length) {
      return 0;
    }
    const t = map.to[position - 1];
    if (t > 0) {
      return t;
    }
    for (let p = position - 1; p >= 1; p -= 1) {
      if (map.to[p - 1] > 0) {
        return Math.min(lengthB, map.to[p - 1] + 1);
      }
    }
    return 1;
  }

  function fragment(sequence, centre, length) {
    const start = centre - 1 - Math.floor(length / 2);
    if (start < 0 || start + length > sequence.length) {
      return null;
    }
    return sequence.slice(start, start + length);
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return value !== "" && value !== null && value !== undefined && Number.isFinite(n) ? n : fallback;
  }

  // FNV-1a 32-bit, continued from hash (for the stale-results key)
  function fnv1a(hash, text) {
    let h = hash === undefined ? 0x811c9dc5 : hash;
    const value = String(text);
    for (let i = 0; i < value.length; i += 1) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // buildJobs(arcMap, regionState, energyState) -> { ready, reason, jobs, skipped, unplaced, invalid, considered, key, notes }
  function buildJobs(arcMap, rp, fe) {
    const s = arcMap || {};
    const e = fe || defaultState();
    const arc = root.RNAxRayArcMap;
    const panels = root.RNAxRayRegionPanels;
    if (!arc || !panels) {
      return { ready: false, reason: "The arc map modules are not loaded." };
    }
    if (!s.interactions) {
      return { ready: false, reason: "No differential interactions yet: run the differential test above and press Use in arc map, or load a differential interaction table in the Arc map card (C)." };
    }
    const seq = panels.sequences(s, rp);
    if (!seq.a || !seq.b) {
      return { ready: false, reason: "Folding needs the full sequence of both lineages: load genome-wide structures A and B (with their sequence) in the Arc map card, or the FASTA references below." };
    }
    const cutoff = numberOr(e.padj, 0.01);
    const length = Math.max(4, Math.round(numberOr(e.length, 40)));
    let mapAB = null;
    let mapBA = null;
    const notes = [];
    if (seq.a !== seq.b) {
      try {
        mapAB = arc.align(seq.a, seq.b);
        mapBA = arc.align(seq.b, seq.a);
      } catch (error) {
        return { ready: false, reason: "B could not be aligned to A: " + error.message };
      }
      notes.push("Fragments are centred on condition one's reference (A) and moved onto B by alignment (" + (100 * mapAB.identity).toFixed(1) + "% identity).");
    }
    const jobs = [];
    let skipped = 0;
    let unplaced = 0;
    let invalid = 0;
    let considered = 0;
    s.interactions.rows.forEach(function (row) {
      if (!(row.padj < cutoff)) {
        return;
      }
      considered += 1;
      let cx = row.x + 5;
      let cy = row.y + 5;
      if ((row.up ? s.oneOn : s.twoOn) === "b" && mapBA) {
        cx = arc.mapNearest(mapBA, cx, 10);
        cy = arc.mapNearest(mapBA, cy, 10);
        if (!cx || !cy) {
          unplaced += 1;
          return;
        }
      }
      const qa = fragment(seq.a, cx, length);
      const qb = fragment(seq.a, cy, length);
      const oa = fragment(seq.b, forward(mapAB, cx, seq.b.length), length);
      const ob = fragment(seq.b, forward(mapAB, cy, seq.b.length), length);
      if (!qa || !qb || !oa || !ob) {
        skipped += 1;
        return;
      }
      if (!/^[ACGU]+$/.test(qa + qb + oa + ob)) {
        invalid += 1;
        return;
      }
      jobs.push({ side: row.up ? "enriched_in_one" : "enriched_in_two", x: row.x, y: row.y, log2FoldChange: row.log2FoldChange, padj: row.padj,
        one: [qa, qb], two: [oa, ob] });
    });
    // the script's order: enriched in one, then enriched in two
    const ordered = jobs.filter(function (j) { return j.side === "enriched_in_one"; }).concat(jobs.filter(function (j) { return j.side === "enriched_in_two"; }));
    let hash = fnv1a(fnv1a(undefined, seq.a), "|" + seq.b);
    ordered.forEach(function (j) {
      hash = fnv1a(hash, "|" + [j.side, j.x, j.y, j.log2FoldChange, j.padj, j.one[0], j.one[1], j.two[0], j.two[1]].join(","));
    });
    const key = [seq.a.length, seq.b.length, ordered.length, hash.toString(16), cutoff, length, s.oneOn, s.twoOn].join("|");
    return { ready: true, jobs: ordered, skipped: skipped, unplaced: unplaced, invalid: invalid, considered: considered, cutoff: cutoff, length: length, key: key, notes: notes };
  }

  // ---- folding (used by the worker and by node checks)

  function writeString(module, value) {
    const bytes = module.lengthBytesUTF8(value) + 1;
    const pointer = module._malloc(bytes);
    if (!pointer) {
      throw new Error("ViennaRNA WebAssembly could not allocate memory.");
    }
    module.stringToUTF8(value, pointer, bytes);
    return pointer;
  }

  // RNAcofold MFE of one & two, rounded to 2 decimals as the CLI prints it
  function cofold(module, one, two, temperature, minimumLoop) {
    let p1 = 0;
    let p2 = 0;
    let ps = 0;
    try {
      p1 = writeString(module, one);
      p2 = writeString(module, two);
      const bytes = one.length + two.length + 1;
      ps = module._malloc(bytes);
      if (!ps) {
        throw new Error("ViennaRNA WebAssembly could not allocate memory.");
      }
      const energy = module._rnaxray_vienna_cofold(p1, p2, temperature === undefined ? TEMPERATURE : temperature,
        minimumLoop === undefined ? MINIMUM_LOOP : minimumLoop, ps, bytes);
      if (!Number.isFinite(energy)) {
        throw new Error("RNAcofold failed for " + one + "&" + two);
      }
      return Math.round(energy * 100) / 100;
    } finally {
      if (ps) { module._free(ps); }
      if (p2) { module._free(p2); }
      if (p1) { module._free(p1); }
    }
  }

  // results(jobs, energies) -> rows with dG_one, dG_two
  function attach(jobs, energies) {
    return jobs.map(function (job, k) {
      return { side: job.side, x: job.x, y: job.y, log2FoldChange: job.log2FoldChange, padj: job.padj, dG_one: energies[2 * k], dG_two: energies[2 * k + 1] };
    });
  }

  function summarise(rows) {
    return ["enriched_in_one", "enriched_in_two"].map(function (side) {
      const x = rows.filter(function (r) { return r.side === side; });
      const one = x.map(function (r) { return r.dG_one; });
      const two = x.map(function (r) { return r.dG_two; });
      const test = x.length >= 3 ? pairedTTest(one, two) : { n: x.length, meanOne: mean(one), meanTwo: mean(two), meanDiff: mean(one) - mean(two), t: NaN, df: NaN, p: NaN };
      return Object.assign({ side: side, one: one, two: two }, test);
    });
  }

  function formatP(p) {
    if (!Number.isFinite(p)) { return "NA"; }
    return p.toExponential(1);
  }

  function fixed(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : "NA";
  }

  // a TSV cell: non-finite numbers as NA (as R writes them)
  function cell(value) {
    return typeof value === "number" && !Number.isFinite(value) ? "NA" : value;
  }

  function toTsv(results) {
    const lines = ["length\tside\tx\ty\tlog2FoldChange\tpadj\tdG_one\tdG_two"];
    results.rows.forEach(function (r) {
      lines.push([results.length, r.side, r.x, r.y, r.log2FoldChange, r.padj, r.dG_one, r.dG_two].map(cell).join("\t"));
    });
    return lines.join("\n") + "\n";
  }

  function statsTsv(results, labels) {
    const lines = ["comparison\tlength\tenriched_in\tn\tmean_dG_one\tmean_dG_two\tmean_diff_one_minus_two\tt\tp"];
    summarise(results.rows).forEach(function (s) {
      lines.push([labels.one + " vs " + labels.two, results.length, s.side === "enriched_in_one" ? labels.one : labels.two, s.n,
        s.meanOne, s.meanTwo, s.meanDiff, s.t, s.p].map(cell).join("\t"));
    });
    return lines.join("\n") + "\n";
  }

  // ---- SVG

  function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
  }

  function niceTicks(lo, hi) {
    const span = hi - lo;
    let step = Math.pow(10, Math.floor(Math.log10(span / 5)));
    [1, 2, 5, 10].some(function (m) {
      if (span / (step * m) <= 7) { step *= m; return true; }
      return false;
    });
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      out.push(Math.round(v * 1e6) / 1e6);
    }
    return out;
  }

  function svg(results, labels, colours) {
    const c = Object.assign({ ink: "#222222", muted: "#6b7280", grid: "#e5e7eb", one: "#c62828", two: "#1f4e9e", background: "#ffffff" }, colours || {});
    const stats = summarise(results.rows).filter(function (s) { return s.n > 0; });
    const panelW = 400;
    const panelH = 340;
    const width = stats.length * panelW + 20;
    const height = panelH + 20;
    const parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" width="' + width + '" height="' + height +
      '" font-family="Inter, Arial, sans-serif" font-size="11" role="img" aria-label="Folding energy">', "<title>Folding energy</title>",
      '<rect width="100%" height="100%" fill="' + c.background + '"/>'];
    stats.forEach(function (s, index) {
      const ox = 10 + index * panelW;
      const left = ox + 56;
      const right = ox + panelW - 16;
      const top = 62;
      const bottom = panelH - 30;
      const series = [{ values: s.one, colour: c.one, label: labels.one }, { values: s.two, colour: c.two, label: labels.two }];
      const dens = series.map(function (item) { return item.values.length > 1 ? density(item.values, 256) : null; });
      let lo = Infinity;
      let hi = -Infinity;
      let maxD = 0;
      dens.forEach(function (d, k) {
        const vals = series[k].values;
        lo = Math.min(lo, d ? d.x[0] : Math.min.apply(null, vals));
        hi = Math.max(hi, d ? d.x[d.x.length - 1] : Math.max.apply(null, vals));
        if (d) { maxD = Math.max(maxD, Math.max.apply(null, d.y)); }
      });
      if (!(hi > lo)) { hi = lo + 1; }
      const ticks = niceTicks(lo, hi);
      const y = function (v) { return bottom - (v - lo) / (hi - lo) * (bottom - top); };
      const who = s.side === "enriched_in_one" ? labels.one : labels.two;
      parts.push('<text x="' + ox + '" y="18" font-size="14" font-weight="700" fill="' + c.ink + '">' + (s.side === "enriched_in_one" ? "F" : "G") + "</text>");
      parts.push('<text x="' + (ox + 18) + '" y="18" font-size="12.5" font-weight="600" fill="' + c.ink + '">' +
        escapeXml(who + "-enriched (" + labels.one + " vs " + labels.two + "), n=" + s.n) + "</text>");
      parts.push('<text x="' + (ox + 18) + '" y="36" fill="' + c.muted + '">' +
        escapeXml("2 × " + results.length + " nt, RNAcofold; paired t-test p = " + formatP(s.p) + (s.note ? " (" + s.note + ")" : "")) + "</text>");
      ticks.forEach(function (t) {
        parts.push('<line x1="' + left + '" x2="' + right + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '" stroke="' + c.grid + '"/>');
        parts.push('<text x="' + (left - 6) + '" y="' + (y(t) + 3.5).toFixed(1) + '" text-anchor="end" fill="' + c.muted + '">' + t + "</text>");
      });
      parts.push('<text transform="translate(' + (ox + 14) + " " + ((top + bottom) / 2) + ') rotate(-90)" text-anchor="middle" fill="' + c.ink + '">Folding energy (kcal/mol)</text>');
      const slot = (right - left) / 2;
      const halfW = slot * 0.42;
      series.forEach(function (item, k) {
        const cx = left + slot * (k + 0.5);
        const d = dens[k];
        if (d && maxD > 0) {
          let path = "";
          for (let i = 0; i < d.x.length; i += 1) {
            path += (i ? "L" : "M") + (cx - d.y[i] / maxD * halfW).toFixed(1) + " " + y(d.x[i]).toFixed(1);
          }
          for (let i = d.x.length - 1; i >= 0; i -= 1) {
            path += "L" + (cx + d.y[i] / maxD * halfW).toFixed(1) + " " + y(d.x[i]).toFixed(1);
          }
          parts.push('<path d="' + path + 'Z" fill="' + item.colour + '" fill-opacity="0.55" stroke="' + item.colour + '" stroke-width="1"/>');
        }
        const b = boxStats(item.values);
        const bw = slot * 0.12;
        parts.push('<line x1="' + cx.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y1="' + y(b.high).toFixed(1) + '" y2="' + y(b.q3).toFixed(1) + '" stroke="' + c.ink + '"/>');
        parts.push('<line x1="' + cx.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y1="' + y(b.q1).toFixed(1) + '" y2="' + y(b.low).toFixed(1) + '" stroke="' + c.ink + '"/>');
        parts.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + y(b.q3).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, y(b.q1) - y(b.q3)).toFixed(1) +
          '" fill="#ffffff" stroke="' + c.ink + '"/>');
        parts.push('<line x1="' + (cx - bw / 2).toFixed(1) + '" x2="' + (cx + bw / 2).toFixed(1) + '" y1="' + y(b.median).toFixed(1) + '" y2="' + y(b.median).toFixed(1) + '" stroke="' + c.ink + '" stroke-width="2"/>');
        b.outliers.forEach(function (v) {
          parts.push('<circle cx="' + cx.toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="1.4" fill="' + c.ink + '"/>');
        });
        parts.push('<text x="' + cx.toFixed(1) + '" y="' + (bottom + 18) + '" text-anchor="middle" fill="' + c.ink + '">' + escapeXml(item.label) + "</text>");
      });
      parts.push('<line x1="' + left + '" x2="' + right + '" y1="' + bottom + '" y2="' + bottom + '" stroke="' + c.muted + '"/>');
    });
    parts.push("</svg>");
    return parts.join("");
  }

  // ---- card

  function labelsOf(arcMap) {
    return { one: (arcMap && arcMap.labelOne) || "condition one", two: (arcMap && arcMap.labelTwo) || "condition two" };
  }

  function renderCard(arcMap, rp, fe, escape) {
    const e = fe || defaultState();
    const esc = escape || escapeXml;
    const labels = labelsOf(arcMap);
    const control = function (label, key, value, placeholder) {
      return '<label class="control-field"><span>' + esc(label) + '</span><input type="text" value="' + esc(value) +
        '" placeholder="' + esc(placeholder || "") + '" data-feature="energy-control" data-key="' + key + '"' + (e.running ? " disabled" : "") + "></label>";
    };
    const out = ['<section class="data-card folding-energy-card" id="folding-energy-card">',
      '<div class="card-title-row"><div><h2>F, G · Folding energy</h2><span class="card-note">RNAcofold of the two arms of every significant interaction, once with each lineage\'s sequence (A = condition one, B = condition two, at aligned positions), as violin plots with a paired t-test. ViennaRNA runs in this browser (WebAssembly).</span></div></div>',
      '<div class="comparison-control-grid">', control("padj <", "padj", e.padj, "0.01"), control("Fragment length per arm (nt)", "length", e.length, "40"),
      '<label class="control-field"><span>Temperature</span><input type="text" value="37 °C, default parameters" disabled></label></div>'];
    const s = arcMap || {};
    const panels = root.RNAxRayRegionPanels;
    if (panels && (!(s.a && s.a.sequence) || !(s.b && s.b.sequence))) {
      const fasta = function (key, label) {
        const loaded = rp && rp[key];
        const summary = loaded ? loaded.sequence.length.toLocaleString("en-US") + " nt" : "";
        // a button-styled label over the hidden input, as in the Arc map card
        return '<div class="arcmap-file control-field' + (loaded ? " is-loaded" : "") + '"><span>' + esc(label) + '</span><div class="file-pick">' +
          '<label class="button button-secondary file-pick-button"><input class="visually-hidden" type="file" accept=".fa,.fasta,.fna,.txt" data-feature="regions-fasta" data-key="' + key +
          '" aria-label="' + esc((loaded ? "Replace " : "Choose ") + label) + '">' + (loaded ? "Replace" : "Choose file") + "</label>" +
          (loaded
            ? '<span class="file-pick-name" title="' + esc(loaded.name + " · " + summary) + '"><b>' + esc(loaded.name) + "</b> · " + esc(summary) + "</span>"
            : '<span class="file-pick-name is-empty">No file</span>') +
          "</div>" + (rp && rp.errors && rp.errors[key] ? '<p class="notice notice-error">' + esc(rp.errors[key]) + "</p>" : "") + "</div>";
      };
      out.push('<div class="arcmap-files">', fasta("fastaA", "Reference of condition one / A (FASTA)"), fasta("fastaB", "Reference of condition two / B (FASTA)"), "</div>");
    }
    const plan = buildJobs(s, rp, e);
    if (!plan.ready) {
      out.push('<p class="card-note">' + esc(plan.reason) + "</p></section>");
      return out.join("");
    }
    plan.notes.forEach(function (note) { out.push('<p class="card-note">' + esc(note) + "</p>"); });
    out.push('<p class="card-note">' + plan.considered.toLocaleString("en-US") + " interactions with padj &lt; " + plan.cutoff + "; " + plan.jobs.length.toLocaleString("en-US") +
      " to fold (" + (2 * plan.jobs.length).toLocaleString("en-US") + " RNAcofold runs)" + (plan.skipped ? "; " + plan.skipped + " skipped (fragment off an end)" : "") +
      (plan.unplaced ? "; " + plan.unplaced + " skipped (could not be placed on A by alignment)" : "") +
      (plan.invalid ? "; " + plan.invalid + " skipped (non-ACGU bases)" : "") + ".</p>");
    if (e.running) {
      const pct = e.total ? Math.round(100 * e.done / e.total) : 0;
      out.push('<div class="progress-bar" role="progressbar" aria-label="RNAcofold progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>');
      out.push('<p class="card-note" data-energy-progress>Folding ' + e.done.toLocaleString("en-US") + " / " + e.total.toLocaleString("en-US") + "…</p>");
      out.push('<div class="inline-actions"><button class="quiet-button" type="button" data-feature-action="energy-cancel">Cancel</button></div>');
    } else {
      out.push('<div class="inline-actions"><button class="button" type="button" data-feature-action="energy-run"' + (plan.jobs.length ? "" : " disabled") + ">" +
        (e.results ? "Fold again" : "Fold with RNAcofold") + "</button></div>");
    }
    if (e.error) {
      out.push('<p class="notice notice-error">' + esc(e.error) + "</p>");
    }
    if (e.results) {
      const r = e.results;
      if (r.key !== plan.key) {
        out.push('<p class="card-note">Inputs or settings changed since these energies were folded; fold again to update.</p>');
      }
      const stats = summarise(r.rows);
      out.push('<div class="data-table-wrap"><table class="data-table energy-table"><thead><tr><th>Enriched in</th><th>n</th><th>Mean dG ' + esc(labels.one) + '</th><th>Mean dG ' + esc(labels.two) +
        "</th><th>Mean difference</th><th>t</th><th>Paired t-test p</th></tr></thead><tbody>");
      stats.forEach(function (st) {
        out.push('<tr data-side="' + st.side + '"><td>' + esc(st.side === "enriched_in_one" ? labels.one : labels.two) + "</td><td data-n>" + st.n + "</td><td>" + fixed(st.meanOne, 2) + "</td><td>" + fixed(st.meanTwo, 2) +
          "</td><td>" + fixed(st.meanDiff, 2) + "</td><td>" + fixed(st.t, 3) + '</td><td data-p="' + cell(st.p) + '">' + (Number.isFinite(st.p) ? st.p.toPrecision(3) : "NA") + "</td></tr>");
      });
      out.push("</tbody></table></div>");
      stats.forEach(function (st) {
        if (st.note) {
          out.push('<p class="card-note">' + esc("Paired t-test for " + (st.side === "enriched_in_one" ? labels.one : labels.two) + "-enriched interactions: NA, the differences are constant.") + "</p>");
        }
      });
      out.push('<div class="energy-figure" data-energy-figure>' + svg(r, labels) + "</div>");
      out.push('<p class="card-note">' + esc("ViennaRNA " + (r.version || "?") + " RNAcofold (WebAssembly), " + TEMPERATURE + " °C, default parameters; " + r.rows.length + " interactions × 2 lineages, 2 × " + r.length + " nt.") + "</p>");
      // K2: the card's downloads sit in one Export menu
      out.push('<div class="inline-actions"><details class="export-menu card-export-menu"><summary class="button button-secondary">Export</summary><div class="export-menu-list" role="menu">' +
        '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="energy-download-svg">Download violin SVG</button>' +
        '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="energy-download-tsv">Download energies TSV</button>' +
        '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="energy-download-stats">Download t-tests TSV</button></div></details></div>');
    }
    out.push("</section>");
    return out.join("");
  }

  // ---- events (delegated from analysis-ui.js)

  let worker = null;

  function ensure(state) {
    state.foldingEnergy = state.foldingEnergy || defaultState();
    return state.foldingEnergy;
  }

  // terminates the folding worker; its pending results are dropped (also
  // called by app.js when files are loaded or closed)
  function stop(fe) {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }
    if (fe) {
      fe.running = false;
    }
  }

  function run(state, api) {
    const fe = ensure(state);
    const plan = buildJobs(state.arcMap, state.regionPanels, fe);
    if (!plan.ready || !plan.jobs.length) {
      return;
    }
    stop(fe);
    fe.running = true;
    fe.error = "";
    fe.done = 0;
    fe.total = 2 * plan.jobs.length;
    const pairs = [];
    plan.jobs.forEach(function (job) { pairs.push(job.one, job.two); });
    try {
      worker = new Worker((root.RNAXRAY_ASSET_BASE || "./") + "folding-energy.worker.js?build=" + encodeURIComponent(root.RNAXRAY_BUILD && root.RNAXRAY_BUILD.commit || "local"));
    } catch (error) {
      fe.running = false;
      fe.error = "Could not start the folding worker: " + (error.message || error);
      api.render();
      return;
    }
    let lastRender = 0;
    worker.onmessage = function (event) {
      const m = event.data || {};
      if (m.type === "progress") {
        fe.done = m.done;
        const now = Date.now();
        if (now - lastRender > 400) {
          lastRender = now;
          api.render();
        }
      } else if (m.type === "result") {
        stop(fe);
        fe.results = { rows: attach(plan.jobs, m.energies), length: plan.length, cutoff: plan.cutoff, key: plan.key, version: m.version, completedAt: new Date().toISOString() };
        api.render();
      } else if (m.type === "error") {
        stop(fe);
        fe.error = m.message || "Folding failed.";
        api.render();
      }
    };
    worker.onerror = function (event) {
      stop(fe);
      fe.error = "The folding worker failed: " + (event.message || "unknown error");
      api.render();
    };
    worker.postMessage({ type: "cofold-batch", pairs: pairs, temperature: TEMPERATURE, minimumLoop: MINIMUM_LOOP });
    api.render();
  }

  function handleChange(state, element, api) {
    if (!element.dataset || element.dataset.feature !== "energy-control") {
      return false;
    }
    const fe = ensure(state);
    const key = element.dataset.key;
    if (key === "padj" || key === "length") {
      fe[key] = element.value;
    }
    api.render();
    return true;
  }

  function handleAction(state, element, api) {
    const action = element.dataset && element.dataset.featureAction;
    if (!action || action.indexOf("energy-") !== 0) {
      return false;
    }
    const fe = ensure(state);
    const labels = labelsOf(state.arcMap);
    if (action === "energy-run") {
      run(state, api);
    } else if (action === "energy-cancel") {
      stop(fe);
      api.render();
    } else if (fe.results && action === "energy-download-tsv") {
      api.download("folding-energy.tsv", toTsv(fe.results), "text/tab-separated-values");
    } else if (fe.results && action === "energy-download-stats") {
      api.download("folding-energy-ttests.tsv", statsTsv(fe.results, labels), "text/tab-separated-values");
    } else if (fe.results && action === "energy-download-svg") {
      api.download("folding-energy.svg", svg(fe.results, labels), "image/svg+xml");
    }
    return true;
  }

  root.RNAxRayFoldingEnergy = {
    TEMPERATURE: TEMPERATURE,
    MINIMUM_LOOP: MINIMUM_LOOP,
    defaultState: defaultState,
    logGamma: logGamma,
    incompleteBeta: incompleteBeta,
    tTwoSided: tTwoSided,
    tCdf: tCdf,
    pairedTTest: pairedTTest,
    quantile: quantile,
    bandwidth: bandwidth,
    density: density,
    boxStats: boxStats,
    fnv1a: fnv1a,
    forward: forward,
    fragment: fragment,
    buildJobs: buildJobs,
    cofold: cofold,
    attach: attach,
    summarise: summarise,
    toTsv: toTsv,
    statsTsv: statsTsv,
    svg: svg,
    renderCard: renderCard,
    handleChange: handleChange,
    handleAction: handleAction,
    stop: stop
  };
})(typeof window !== "undefined" ? window : self);

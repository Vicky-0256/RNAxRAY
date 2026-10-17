// Compare page: the differential contact test (DESeq2 Wald test, deseq.js in
// deseq.worker.js) and panel A of a comparison figure, the "differential
// coverage map": significant 10-nt cells, red = higher in condition A
// (condition one), blue = higher in condition B, opacity by -log10 padj as
// RNAxRay Desktop's cmpSignificantCells (desktop/app/views/compare.go).
//
// Self-contained so it merges easily: analysis-pages.js calls renderCard,
// analysis-ui.js forwards actions / changes and calls draw after render,
// report-page.js calls reportSection / reportData.  State lives in
// state.comparison.deseq.
(function () {
  "use strict";

  const RED = [214, 69, 65];
  const BLUE = [43, 108, 196];
  const BIN = 10;
  const PADJ_FULL = 20; // −log10 padj at which a cell is fully opaque
  const BOTTOM_SPACE = 104;
  const TABLE_ROWS = 60;
  const REPORT_CELLS = 20000;
  const VALIDATION = "On the ZIKV virion comparison (ZAFR_REP1/2 vs ZILM_REP2/3, 1,038,539 tested 10-nt cells) it matches R DESeq2 1.46: the same 83,023 significant cells (20,660 up / 62,363 down) and 668 / 1,725 merged interactions at padj < 0.05 (one interaction is an exactly tied neighbour of R's pick, because ties are merged in table order); against RNAxRay Desktop's numpy port, log2 fold changes agree to 2e-9 and padj to 3e-7 (relative) over every tested cell.";

  let worker = null;
  let runToken = 0;

  function defaults() {
    return { minCount: "2", radius: "100", padjCutoff: "0.05", show: "both", rnaByDataset: {}, excluded: {}, status: "idle", progress: "",
      error: "", result: null, selected: null };
  }

  function ensure(comparison) {
    if (!comparison.deseq) {
      comparison.deseq = defaults();
    }
    return comparison.deseq;
  }

  // ---- inputs

  // datasets in the test: assigned to A or B and not left out in the card
  function assignedDatasets(comparison) {
    const excluded = comparison.deseq && comparison.deseq.excluded || {};
    return (comparison.datasets || []).filter(function (dataset) {
      return dataset && (dataset.condition === "A" || dataset.condition === "B") && !excluded[dataset.id];
    });
  }

  function eligibility(comparison) {
    const assigned = assignedDatasets(comparison);
    const nA = assigned.filter(function (dataset) { return dataset.condition === "A"; }).length;
    const nB = assigned.length - nA;
    let reason = "";
    if (comparison.loading) {
      reason = "Finish parsing the selected datasets first.";
    } else if (!comparison.rnaX || !comparison.rnaY) {
      reason = "Choose RNA X and RNA Y above.";
    } else if (!nA || !nB) {
      reason = "Assign datasets to both conditions.";
    } else if (assigned.length < 3) {
      reason = "The test needs at least three datasets (replicates); " + assigned.length + " are assigned.";
    } else if (nA < 2 && nB < 2) {
      reason = "At least one condition needs two or more replicates.";
    }
    return { ok: !reason, reason: reason, nA: nA, nB: nB, assigned: assigned };
  }

  function similarity(left, right) {
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

  // RNA pair used for each dataset.  A homodimer map (RNA X = RNA Y) may use
  // another RNA in a dataset that lacks it (another strain's genome, as in
  // ZAFR vs ZILM): the closest name is proposed and can be changed.
  function rnaPlan(comparison) {
    const deseq = ensure(comparison);
    const homodimer = comparison.rnaX && comparison.rnaX === comparison.rnaY;
    return assignedDatasets(comparison).map(function (dataset) {
      const names = dataset.summary && dataset.summary.rnaNames || [];
      const has = names.indexOf(comparison.rnaX) >= 0 && names.indexOf(comparison.rnaY) >= 0;
      if (!homodimer) {
        return { dataset: dataset, rnaX: comparison.rnaX, rnaY: comparison.rnaY, options: [], substituted: false, missing: !has && names.length > 0 };
      }
      let rna = comparison.rnaX;
      let substituted = false;
      if (!has && names.length) {
        const chosen = deseq.rnaByDataset[dataset.id];
        rna = chosen && names.indexOf(chosen) >= 0 ? chosen : names.slice().sort(function (left, right) {
          return similarity(right, comparison.rnaX) - similarity(left, comparison.rnaX) || left.localeCompare(right);
        })[0];
        substituted = true;
      }
      return { dataset: dataset, rnaX: rna, rnaY: rna, options: has ? [] : names, substituted: substituted, missing: false };
    });
  }

  // an empty or non-numeric field is NaN (Number("") would be 0)
  function fieldNumber(value) {
    const text = String(value == null ? "" : value).trim();
    return text && Number.isFinite(Number(text)) ? Number(text) : NaN;
  }

  function parameters(deseq) {
    const minCount = fieldNumber(deseq.minCount);
    const radius = fieldNumber(deseq.radius);
    const padjCutoff = fieldNumber(deseq.padjCutoff);
    const errors = [];
    if (!Number.isInteger(minCount) || minCount < 0) {
      errors.push("Min count must be a non-negative integer.");
    }
    if (!Number.isInteger(radius) || radius < 0) {
      errors.push("Merge range must be a non-negative integer (nt).");
    }
    if (!(padjCutoff > 0 && padjCutoff <= 1)) {
      errors.push("The padj cutoff must be between 0 and 1.");
    }
    return { minCount: minCount, radius: radius, padjCutoff: padjCutoff, alpha: 0.01, binSize: BIN, errors: errors };
  }

  function inputKey(comparison) {
    const deseq = ensure(comparison);
    return JSON.stringify([rnaPlan(comparison).map(function (plan) {
      return [plan.dataset.id, plan.dataset.condition, plan.rnaX, plan.rnaY, plan.dataset.summary && plan.dataset.summary.validRecords];
    }), deseq.minCount, deseq.radius, deseq.padjCutoff]);
  }

  // ---- formatting

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[ch];
    });
  }

  function num(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function padjText(value) {
    if (!Number.isFinite(value)) {
      return "NA";
    }
    return value < 1e-3 ? value.toExponential(2) : value.toPrecision(3);
  }

  function fixed(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : "NA";
  }

  function seconds(ms) {
    return (Number(ms || 0) / 1000).toFixed(1) + " s";
  }

  // ---- card

  function renderCard(state) {
    const comparison = state.comparison || {};
    const deseq = ensure(comparison);
    const check = eligibility(comparison);
    const plan = rnaPlan(comparison);
    const labelA = comparison.conditionALabel || "Condition A";
    const labelB = comparison.conditionBLabel || "Condition B";
    const result = deseq.result;
    const running = deseq.status === "running";
    const stale = result && result.inputKey !== inputKey(comparison);
    const field = function (label, key, value, hint) {
      return '<label class="control-field"><span>' + esc(label) + '</span><input type="number" value="' + esc(value) + '" data-feature="deseq-control" data-key="' + key + '"' +
        (key === "padjCutoff" ? ' min="0" max="1" step="0.01"' : ' min="0" step="1"') + (hint ? ' title="' + esc(hint) + '"' : "") + "></label>";
    };
    const out = [
      '<section class="data-card deseq-card" id="deseq-card">',
      '<div class="card-title-row"><div><h2>A · Differential test (DESeq2 Wald test)</h2><span class="card-note">Which contacts differ between ' +
        esc(labelA) + ' and ' + esc(labelB) + '? Each 10-nt × 10-nt contact cell is tested with the replicates as the noise estimate; significant neighbouring cells are merged into interactions, as rnaxray_compare does. Runs in this tab; nothing is uploaded.</span></div><span class="card-kicker">' +
        num(check.nA) + ' + ' + num(check.nB) + ' replicates</span></div>',
      '<div class="comparison-control-grid">',
      field("Test cells with total count above", "minCount", deseq.minCount, "Cells whose counts summed over all datasets are at most this are not tested (rnaxray_compare -m)"),
      field("Merge range (nt)", "radius", deseq.radius, "Significant cells within this many nt (in x and y) of a stronger one of the same direction are merged (rnaxray_compare -r)"),
      field("Significant if padj below", "padjCutoff", deseq.padjCutoff, "Cells with padj below this are significant (independent filtering uses alpha 0.01, as DESeq_run.R)"),
      '</div>',
      '<div class="deseq-include"><span class="card-note">Datasets in the test:</span>' + (comparison.datasets || []).map(function (dataset) {
        const on = !(deseq.excluded || {})[dataset.id];
        return '<label class="deseq-include-item"><input type="checkbox" data-feature="deseq-include" data-dataset-id="' + esc(dataset.id) + '"' + (on ? " checked" : "") + "> " +
          esc(dataset.label || dataset.fileName || dataset.id) + " <span class=\"card-note\">(" + esc(dataset.condition === "A" ? labelA : labelB) + ")</span></label>";
      }).join("") + "</div>"
    ];
    const substituted = plan.filter(function (item) { return item.substituted; });
    if (substituted.length) {
      out.push('<div class="deseq-rna-map"><p class="card-note">These datasets have no ' + esc(comparison.rnaX) + '; their homodimer map uses another RNA (another strain\'s genome is compared on its own coordinates, as rnaxray_compare does):</p>');
      substituted.forEach(function (item) {
        out.push('<label class="control-field"><span>' + esc(item.dataset.label || item.dataset.fileName || item.dataset.id) + '</span><select data-feature="deseq-rna" data-dataset-id="' + esc(item.dataset.id) + '">' +
          item.options.map(function (name) { return '<option value="' + esc(name) + '"' + (name === item.rnaX ? " selected" : "") + ">" + esc(name) + "</option>"; }).join("") + "</select></label>");
      });
      out.push("</div>");
    }
    plan.filter(function (item) { return item.missing; }).forEach(function (item) {
      out.push('<p class="notice notice-warning">' + esc(item.dataset.label || item.dataset.fileName) + " has no " + esc(comparison.rnaX) + " × " + esc(comparison.rnaY) + " records; it contributes zero counts.</p>");
    });
    const params = parameters(deseq);
    params.errors.forEach(function (message) { out.push('<p class="notice notice-error">' + esc(message) + "</p>"); });
    out.push('<div class="control-actions">' +
      (running
        ? '<button class="button" type="button" disabled>Running…</button><button class="quiet-button" type="button" data-feature-action="deseq-cancel">Cancel</button>'
        : '<button class="button" type="button" data-feature-action="deseq-run"' + (check.ok && !params.errors.length ? "" : " disabled") + ">Run differential test</button>") +
      '<span class="control-hint" data-deseq-progress aria-live="polite">' + esc(running ? deseq.progress || "Starting…" : (check.ok ? "" : check.reason)) + "</span></div>");
    if (deseq.error) {
      out.push('<p class="notice notice-error">' + esc(deseq.error) + "</p>");
    }
    if (result) {
      out.push(renderResult(comparison, deseq, result, stale, labelA, labelB));
    }
    const methodOpen = window.RNAxRayOpenSections && window.RNAxRayOpenSections["deseq-method"] ? " open" : "";
    out.push('<details class="comparison-note-details deseq-method" data-open-key="deseq-method"' + methodOpen + '><summary>Method and how it was checked against R</summary><p class="card-note">A JavaScript port of RNAxRay Desktop\'s numpy port of the DESeq2 1.46 Wald test (median-of-ratios size factors, Cox-Reid gene-wise dispersions, parametric trend with local fallback, MAP shrinkage, Wald test, Cook\'s filtering with three or more replicates, independent filtering at alpha 0.01, Benjamini-Hochberg), then rnaxray_compare\'s greedy merge by padj. It is not R: ' + esc(VALIDATION) + "</p></details>");
    out.push("</section>");
    return out.join("");
  }

  function shownRows(result, show) {
    return result.interactions.filter(function (row) {
      return show === "both" || (show === "up" ? row.direction === "up" : row.direction === "down");
    });
  }

  function renderResult(comparison, deseq, result, stale, labelA, labelB) {
    const s = result.summary;
    const show = deseq.show || "both";
    const rows = shownRows(result, show).slice().sort(function (left, right) { return left.padj - right.padj; });
    const selected = deseq.selected;
    const out = [];
    if (stale) {
      out.push('<p class="notice notice-warning">Datasets, conditions or parameters changed after this result was computed; run the test again to update it.</p>');
    }
    out.push('<dl class="selection-stats deseq-stats">' + [
      ["Cells tested", num(s.cellsTested) + " of " + num(s.cellsTotal) + " (the rest have a total count of " + num(s.parameters.minCount) + " or less)"],
      ["Significant (padj < " + s.parameters.padjCutoff + ")", num(s.significant) + " cells"],
      ["Higher in " + labelA, num(s.significantUp) + " cells · " + num(s.interactionsUp) + " interactions"],
      ["Higher in " + labelB, num(s.significantDown) + " cells · " + num(s.interactionsDown) + " interactions"],
      ["Size factors", s.sizeFactors.map(function (value) { return value.toFixed(4); }).join(" · ")],
      ["Run time", seconds(s.timings.workerMs || s.timings.totalMs)]
    ].map(function (entry) { return "<div><dt>" + esc(entry[0]) + "</dt><dd>" + esc(entry[1]) + "</dd></div>"; }).join("") + "</dl>");
    out.push('<div class="card-title-row deseq-panel-title"><div><h3>A · Differential coverage map</h3><span class="card-note">Significant 10-nt cells (padj &lt; ' + esc(s.parameters.padjCutoff) +
      '); red: higher in ' + esc(labelA) + ', blue: higher in ' + esc(labelB) + '; opacity by −log10 padj (full at 20). Click near a cell to pick its merged interaction.</span></div>' +
      '<label class="control-field deseq-show"><span>Show</span><select data-feature="deseq-control" data-key="show">' +
      [["both", "Both directions"], ["up", "Higher in " + labelA], ["down", "Higher in " + labelB]].map(function (option) {
        return '<option value="' + option[0] + '"' + (option[0] === show ? " selected" : "") + ">" + esc(option[1]) + "</option>";
      }).join("") + "</select></label></div>");
    out.push('<div class="canvas-wrap deseq-canvas-wrap"><canvas id="deseq-panel-canvas" class="deseq-canvas" width="640" height="640" aria-label="Differential coverage map"></canvas></div>');
    // K2: the card's downloads sit in one Export menu; "Use in arc map" is an action
    out.push('<div class="inline-actions"><button class="button" type="button" data-feature-action="deseq-use-arcmap">Use in arc map</button>' +
      '<details class="export-menu card-export-menu"><summary class="button button-secondary">Export</summary><div class="export-menu-list" role="menu">' +
      '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="deseq-download-svg">Download map SVG</button>' +
      '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="deseq-download-png">Download map PNG</button>' +
      '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="deseq-export-interactions">Export interactions TSV</button>' +
      '<button class="export-menu-item" type="button" role="menuitem" data-feature-action="deseq-export-significant">Export significant cells TSV</button>' +
      '</div></details></div>');
    out.push('<p class="card-note">Before reporting an interaction, check that every replicate supports it: click the same position in the effect map below to see each dataset\'s count. A small padj with a low mean count can still come from one replicate.</p>');
    if (deseq.arcMapFed && !stale) {
      out.push('<p class="card-note">The arc map below had structures but no interaction table, so it now draws these merged interactions; the region structures (D, E) and folding energies (F, G) follow from it. Those panels use their own padj cutoff (0.01 by default), so they can show fewer interactions than this table.</p>');
    }
    out.push('<div class="card-title-row"><h3>Merged interactions</h3><span class="card-note">' + num(rows.length) + " shown by padj" +
      (rows.length > TABLE_ROWS ? " (first " + TABLE_ROWS + " listed; the TSV has all)" : "") + "</span></div>");
    if (!rows.length) {
      out.push('<p class="card-note">No significant interaction in this direction.</p>');
    } else {
      out.push('<div class="data-table-wrap deseq-table"><table class="data-table"><thead class="nowrap"><tr><th>Higher in</th><th class="num">Arm 1 <span class="unit">x, nt</span></th><th class="num">Arm 2 <span class="unit">y, nt</span></th><th class="num">log2 ' + esc(labelA) + '/' + esc(labelB) + '</th><th class="num">padj</th><th class="num">Mean count <span class="unit">normalised</span></th></tr></thead><tbody>' +
        rows.slice(0, TABLE_ROWS).map(function (row) {
          const key = row.direction + ":" + row.x + ":" + row.y;
          return '<tr class="' + (selected === key ? "is-selected" : "") + '" data-feature-action="deseq-select" data-key="' + esc(key) + '" tabindex="0"><td>' +
            esc(row.direction === "up" ? labelA : labelB) + '</td><td class="num">' + num(row.x) + "–" + num(row.x + BIN - 1) + '</td><td class="num">' + num(row.y) + "–" + num(row.y + BIN - 1) +
            '</td><td class="num">' + fixed(row.log2FoldChange, 2) + '</td><td class="num">' + padjText(row.padj) + '</td><td class="num">' + fixed(row.baseMean, 1) + "</td></tr>";
        }).join("") + "</tbody></table></div>");
    }
    return out.join("");
  }

  // ---- drawing (canvas and SVG share the geometry)

  function mapLength(result) {
    return Math.max(BIN, (result.summary.maxCoordinate || 0) + BIN);
  }

  function niceStep(span) {
    let step = Math.pow(10, Math.floor(Math.log10(Math.max(span, 1) / 5)));
    [1, 2, 5, 10].some(function (m) {
      if (span / (step * m) <= 6) {
        step *= m;
        return true;
      }
      return false;
    });
    return step;
  }

  function geometry(width, height, length) {
    const left = 58;
    const top = 40;
    // below the map: tick labels, the axis title and the colour bar
    const size = Math.max(60, Math.min(width - left - 16, height - top - BOTTOM_SPACE));
    return {
      left: left, top: top, size: size, length: length,
      x: function (v) { return left + v / length * size; },
      y: function (v) { return top + (1 - v / length) * size; },
      cell: Math.max(0.6, BIN / length * size)
    };
  }

  // cells to draw, least significant first (as Desktop: strongest on top)
  function eachCell(result, show, visit) {
    const s = result.significant;
    for (let i = s.x.length - 1; i >= 0; i -= 1) {
      const lfc = s.log2FoldChange[i];
      if (!(lfc > 0) && !(lfc < 0)) {
        continue;
      }
      if ((show === "up" && lfc < 0) || (show === "down" && lfc > 0)) {
        continue;
      }
      const padj = s.padj[i] > 0 ? Math.max(s.padj[i], 1e-300) : 1e-300;
      const strength = Math.min(1, -Math.log10(padj) / 20);
      visit(s.x[i], s.y[i], lfc > 0 ? RED : BLUE, 0.2 + 0.8 * strength);
    }
  }

  function drawPanel(context, width, height, comparison, result, show, selectedRow) {
    const g = geometry(width, height, mapLength(result));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#222222";
    context.font = "600 13px Inter, Arial, sans-serif";
    context.textAlign = "left";
    context.fillText("Differential coverage map · " + (comparison.conditionALabel || "Condition A") + " vs " + (comparison.conditionBLabel || "Condition B"), g.left, 20);
    context.strokeStyle = "#c7ced6";
    context.lineWidth = 1;
    context.strokeRect(g.left - 0.5, g.top - 0.5, g.size + 1, g.size + 1);
    eachCell(result, show, function (x, y, colour, alpha) {
      context.fillStyle = "rgba(" + colour[0] + "," + colour[1] + "," + colour[2] + "," + alpha.toFixed(3) + ")";
      context.fillRect(g.x(x), g.y(y + BIN), g.cell, g.cell);
    });
    if (selectedRow) {
      const r = Number(comparison.deseq && comparison.deseq.radius) || 0;
      context.strokeStyle = "#111111";
      context.lineWidth = 1.5;
      const x0 = g.x(Math.max(0, selectedRow.x - r));
      const y0 = g.y(selectedRow.y + BIN + r);
      context.strokeRect(x0, y0, g.x(selectedRow.x + BIN + r) - x0, g.y(Math.max(0, selectedRow.y - r)) - y0);
    }
    axes(g, function (kind, a, b, c, d, text, anchor) {
      if (kind === "line") {
        context.strokeStyle = "#c7ced6";
        context.beginPath();
        context.moveTo(a, b);
        context.lineTo(c, d);
        context.stroke();
      } else {
        context.fillStyle = "#6b7280";
        context.font = "11px Inter, Arial, sans-serif";
        context.textAlign = anchor;
        if (kind === "vtext") {
          context.save();
          context.translate(a, b);
          context.rotate(-Math.PI / 2);
          context.fillText(text, 0, 0);
          context.restore();
        } else {
          context.fillText(text, a, b);
        }
      }
    }, comparison);
    if (legendKit()) {
      legendKit().legend.drawCanvas(context, legendOptions(g, comparison));
    }
  }

  // axis ticks and labels through a small drawing callback
  function axes(g, draw, comparison) {
    const step = niceStep(g.length);
    for (let v = 0; v <= g.length; v += step) {
      draw("line", g.x(v), g.top + g.size, g.x(v), g.top + g.size + 5);
      draw("text", g.x(v), g.top + g.size + 18, 0, 0, String(v), "center");
      draw("line", g.left - 5, g.y(v), g.left, g.y(v));
      draw("text", g.left - 8, g.y(v) + 4, 0, 0, String(v), "right");
    }
    draw("text", g.left + g.size / 2, g.top + g.size + 36, 0, 0, (comparison.rnaX || "RNA X") + " position (nt, arm 1)", "center");
    draw("vtext", 13, g.top + g.size / 2, 0, 0, (comparison.rnaY || comparison.rnaX || "RNA Y") + " position (nt, arm 2)", "center");
    const labelA = comparison.conditionALabel || "Condition A";
    const labelB = comparison.conditionBLabel || "Condition B";
    if (!legendKit()) {
      draw("text", g.left, g.top + g.size + 54, 0, 0, "■ red: higher in " + labelA + "   ■ blue: higher in " + labelB + "   opacity: −log10 padj (0.2 at padj 1, full at 1e-20)", "left");
    }
  }

  function legendKit() {
    return typeof window !== "undefined" && window.RNAxRayUiKit && window.RNAxRayUiKit.legend ? window.RNAxRayUiKit : null;
  }

  // K1 colour bar: signed −log10 padj, the colour giving the direction and
  // the opacity the strength, as the cells are drawn (over white)
  function legendOptions(g, comparison) {
    const tint = function (colour, alpha) {
      return "rgb(" + colour.map(function (c) { return Math.round(255 + (c - 255) * alpha); }).join(",") + ")";
    };
    return {
      kind: "diverging",
      min: -PADJ_FULL,
      max: PADJ_FULL,
      ticks: [-PADJ_FULL, -PADJ_FULL / 2, 0, PADJ_FULL / 2, PADJ_FULL],
      colorAt: function (t) {
        const signed = 2 * t - 1;
        const strength = Math.abs(signed);
        return strength < 1e-6 ? "rgb(255,255,255)" : tint(signed > 0 ? RED : BLUE, 0.2 + 0.8 * strength);
      },
      format: function (value) { return (Math.abs(value) >= PADJ_FULL ? "≥ " : "") + Math.abs(value); },
      title: "−log10 padj (opacity); colour: direction",
      lowLabel: "Higher in " + (comparison.conditionBLabel || "Condition B"),
      highLabel: "Higher in " + (comparison.conditionALabel || "Condition A"),
      orientation: "horizontal",
      x: g.left,
      y: g.top + g.size + 46,
      width: Math.min(280, g.size),
      height: 10,
      ink: "#222222",
      muted: "#6b7280",
      font: "Inter, Arial, sans-serif"
    };
  }

  function draw(state, api) {
    const canvas = typeof document !== "undefined" && document.getElementById("deseq-panel-canvas");
    const comparison = state.comparison;
    const deseq = comparison && comparison.deseq;
    if (!canvas || !deseq || !deseq.result) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(280, Math.round(rect.width || 640));
    const height = Math.max(280, Math.round(rect.height || 640));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPanel(context, width, height, comparison, deseq.result, deseq.show || "both", selectedInteraction(deseq));
    canvas.onpointerup = function (event) {
      const box = canvas.getBoundingClientRect();
      const g = geometry(width, height, mapLength(deseq.result));
      const x = (event.clientX - box.left - g.left) / g.size * g.length;
      const y = (1 - (event.clientY - box.top - g.top) / g.size) * g.length;
      const rows = shownRows(deseq.result, deseq.show || "both");
      let best = null;
      let bestDistance = Infinity;
      rows.forEach(function (row) {
        const d = Math.max(Math.abs(row.x + BIN / 2 - x), Math.abs(row.y + BIN / 2 - y));
        if (d < bestDistance) {
          bestDistance = d;
          best = row;
        }
      });
      if (best && bestDistance <= Math.max(Number(deseq.radius) || 0, 10, 4 * g.length / g.size)) {
        deseq.selected = best.direction + ":" + best.x + ":" + best.y;
        if (api) {
          api.render();
        }
      }
    };
  }

  function selectedInteraction(deseq) {
    if (!deseq.selected || !deseq.result) {
      return null;
    }
    return deseq.result.interactions.find(function (row) { return row.direction + ":" + row.x + ":" + row.y === deseq.selected; }) || null;
  }

  function panelSvg(comparison, options) {
    const deseq = comparison.deseq;
    const result = deseq.result;
    const opts = options || {};
    const width = opts.width || 760;
    const height = opts.height || 820;
    const show = opts.show || deseq.show || "both";
    const g = geometry(width, height, mapLength(result));
    const parts = [];
    const xml = function (text) { return esc(text); };
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" width="' + width + '" height="' + height +
      '" font-family="Inter, Arial, sans-serif" font-size="11" role="img" aria-label="Differential coverage map">');
    parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
    parts.push('<text x="' + g.left + '" y="20" font-size="13" font-weight="600" fill="#222222">' + xml("Differential coverage map · " + (comparison.conditionALabel || "Condition A") + " vs " + (comparison.conditionBLabel || "Condition B")) + "</text>");
    parts.push('<rect x="' + (g.left - 0.5) + '" y="' + (g.top - 0.5) + '" width="' + (g.size + 1) + '" height="' + (g.size + 1) + '" fill="none" stroke="#c7ced6"/>');
    const cells = [];
    eachCell(result, show, function (x, y, colour, alpha) {
      cells.push([x, y, colour, alpha]);
    });
    const limit = opts.maxCells || Infinity;
    const start = Math.max(0, cells.length - limit); // the most significant are last
    const w = g.cell.toFixed(2);
    const groups = { red: [], blue: [] };
    for (let k = start; k < cells.length; k += 1) {
      const c = cells[k];
      groups[c[2] === RED ? "red" : "blue"].push('<rect x="' + g.x(c[0]).toFixed(2) + '" y="' + g.y(c[1] + BIN).toFixed(2) + '" width="' + w + '" height="' + w + '" fill-opacity="' + c[3].toFixed(3) + '"/>');
    }
    // keep the drawing order (weakest first) within each colour
    parts.push('<g fill="rgb(' + BLUE.join(",") + ')">' + groups.blue.join("") + "</g>");
    parts.push('<g fill="rgb(' + RED.join(",") + ')">' + groups.red.join("") + "</g>");
    axes(g, function (kind, a, b, c, d, text, anchor) {
      if (kind === "line") {
        parts.push('<line x1="' + a.toFixed(1) + '" y1="' + b.toFixed(1) + '" x2="' + c.toFixed(1) + '" y2="' + d.toFixed(1) + '" stroke="#c7ced6"/>');
      } else {
        const place = kind === "vtext" ? ' transform="translate(' + a.toFixed(1) + " " + b.toFixed(1) + ') rotate(-90)"' : ' x="' + a.toFixed(1) + '" y="' + b.toFixed(1) + '"';
        parts.push("<text" + place + ' text-anchor="' + (anchor === "center" ? "middle" : (anchor === "right" ? "end" : "start")) + '" fill="#6b7280">' + xml(text) + "</text>");
      }
    }, comparison);
    if (legendKit()) {
      parts.push(legendKit().legend.svg(legendOptions(g, comparison)));
    }
    parts.push("</svg>");
    return { svg: parts.join(""), drawn: cells.length - start, total: cells.length };
  }

  // ---- run

  function collectArms(arms, plan) {
    const total = arms && Array.isArray(arms.index) ? arms.index.length : (arms && arms.rnaOne ? arms.rnaOne.length : 0);
    const out = new Int32Array(total * 4);
    let k = 0;
    for (let row = 0; row < total; row += 1) {
      const one = arms.rnaOne[row];
      const two = arms.rnaTwo[row];
      if (one === plan.rnaX && two === plan.rnaY) {
        out[k] = arms.oneStart[row]; out[k + 1] = arms.oneEnd[row]; out[k + 2] = arms.twoStart[row]; out[k + 3] = arms.twoEnd[row];
        k += 4;
      } else if (plan.rnaX !== plan.rnaY && one === plan.rnaY && two === plan.rnaX) {
        out[k] = arms.twoStart[row]; out[k + 1] = arms.twoEnd[row]; out[k + 2] = arms.oneStart[row]; out[k + 3] = arms.oneEnd[row];
        k += 4;
      }
    }
    for (let i = 0; i < k; i += 1) {
      if (!(out[i] >= 0)) {
        throw new Error("negative arm coordinates cannot be binned");
      }
    }
    return out.slice(0, k);
  }

  function setProgress(deseq, text) {
    deseq.progress = text;
    const node = typeof document !== "undefined" && document.querySelector("[data-deseq-progress]");
    if (node) {
      node.textContent = text;
    }
  }

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  // Abandon any run in progress: the worker is terminated and a pending
  // arms read, worker message or no-Worker timer finishing later is ignored.
  // With the card's state, a running card goes back to idle.
  function stop(deseq) {
    runToken += 1;
    stopWorker();
    if (deseq && deseq.status === "running") {
      deseq.status = "idle";
      deseq.progress = "";
    }
  }

  function run(state, api) {
    const comparison = state.comparison;
    const deseq = ensure(comparison);
    const check = eligibility(comparison);
    const params = parameters(deseq);
    if (!check.ok || params.errors.length) {
      api.showToast(check.reason || params.errors[0]);
      return;
    }
    if (typeof api.getArms !== "function") {
      deseq.error = "This view cannot read the datasets' interaction arms.";
      api.render();
      return;
    }
    stopWorker();
    const token = ++runToken;
    const plan = rnaPlan(comparison);
    const key = inputKey(comparison);
    const labels = { A: comparison.conditionALabel || "Condition A", B: comparison.conditionBLabel || "Condition B" };
    const started = Date.now();
    deseq.status = "running";
    deseq.error = "";
    deseq.progress = "Reading interaction arms…";
    api.render();
    Promise.all(plan.map(function (item) {
      return Promise.resolve(api.getArms({ datasetIds: [item.dataset.id] }, { rna: item.rnaX, partner: item.rnaY }));
    })).then(function (list) {
      if (token !== runToken) {
        return;
      }
      const samples = plan.map(function (item, index) {
        return { name: item.dataset.label || item.dataset.fileName || item.dataset.id, arms: collectArms(list[index], item) };
      });
      const records = samples.map(function (sample) { return sample.arms.length / 4; });
      const empty = plan.filter(function (item, index) { return !records[index]; });
      if (empty.length) {
        // every cell would have a zero in these samples: no size factors
        stopWorker();
        deseq.status = "error";
        deseq.error = "Differential test not run: " + empty.map(function (item) {
          return (item.dataset.label || item.dataset.fileName || item.dataset.id) + " has no " + item.rnaX + " × " + item.rnaY + " records";
        }).join("; ") + ". Every cell would have a zero count in that dataset, so size factors cannot be computed; leave it out of the test or choose another RNA pair.";
        api.render();
        return;
      }
      const conditionOne = plan.map(function (item) { return item.dataset.condition === "A"; });
      const options = { minCount: params.minCount, radius: params.radius, padjCutoff: params.padjCutoff, alpha: params.alpha, binSize: BIN };
      const finish = function (result) {
        if (token !== runToken) {
          return;
        }
        stopWorker();
        result.inputKey = key;
        result.labels = labels;
        result.datasets = plan.map(function (item, index) {
          return { id: item.dataset.id, label: item.dataset.label || "", fileName: item.dataset.fileName || "", condition: item.dataset.condition,
            rnaX: item.rnaX, rnaY: item.rnaY, records: records[index] };
        });
        result.rna = { x: comparison.rnaX, y: comparison.rnaY };
        result.elapsedMs = Date.now() - started;
        result.completedAt = new Date().toISOString();
        deseq.result = result;
        deseq.status = "done";
        deseq.selected = null;
        deseq.progress = "";
        // an arc map with structures but no interaction table (the included
        // example) draws this result right away
        deseq.arcMapFed = false;
        if (window.RNAxRayArcMap && state.arcMap && !state.arcMap.interactions && (state.arcMap.a || state.arcMap.b)) {
          useInArcMap(state, result);
          deseq.arcMapFed = true;
        }
        api.render();
      };
      const fail = function (message) {
        if (token !== runToken) {
          return;
        }
        stopWorker();
        deseq.status = "error";
        deseq.error = "Differential test failed: " + message;
        api.render();
      };
      const transfer = samples.map(function (sample) { return sample.arms.buffer; });
      if (typeof Worker === "undefined") {
        setTimeout(function () {
          try {
            const D = window.RNAxRayDeseq;
            finish(D.compare(samples.map(function (sample) { return { name: sample.name, cells: D.binArms(sample.arms, BIN) }; }), conditionOne, options));
          } catch (error) {
            fail(error.message || String(error));
          }
        }, 30);
        return;
      }
      worker = new Worker((window.RNAXRAY_ASSET_BASE || "./") + "deseq.worker.js?build=" + encodeURIComponent(window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit || "local"));
      worker.onmessage = function (event) {
        const message = event.data || {};
        if (message.type === "progress") {
          setProgress(deseq, message.detail + (message.fraction != null && message.fraction > 0 ? " · " + Math.round(100 * message.fraction) + "%" : "") +
            " · " + seconds(Date.now() - started));
        } else if (message.type === "done") {
          finish(message.result);
        } else if (message.type === "error") {
          fail(message.message);
        }
      };
      worker.onerror = function (event) {
        fail(event && event.message ? event.message : "the worker stopped");
      };
      worker.postMessage({ samples: samples, conditionOne: conditionOne, options: options }, transfer);
      setProgress(deseq, "Binning " + records.reduce(function (a, b) { return a + b; }, 0).toLocaleString("en-US") + " records…");
    }).catch(function (error) {
      if (token === runToken) {
        deseq.status = "error";
        deseq.error = "Differential test failed: " + (error && error.message ? error.message : String(error));
        api.render();
      }
    });
  }

  // ---- actions

  function handleChange(state, element, api) {
    const feature = element.dataset.feature;
    if (feature !== "deseq-control" && feature !== "deseq-rna" && feature !== "deseq-include") {
      return false;
    }
    const deseq = ensure(state.comparison);
    if (feature === "deseq-include") {
      deseq.excluded = Object.assign({}, deseq.excluded);
      if (element.checked) {
        delete deseq.excluded[element.dataset.datasetId];
      } else {
        deseq.excluded[element.dataset.datasetId] = true;
      }
    } else if (feature === "deseq-rna") {
      deseq.rnaByDataset = Object.assign({}, deseq.rnaByDataset);
      deseq.rnaByDataset[element.dataset.datasetId] = element.value;
    } else if (["minCount", "radius", "padjCutoff", "show"].indexOf(element.dataset.key) >= 0) {
      deseq[element.dataset.key] = element.value;
    }
    api.render();
    return true;
  }

  function handleInput(state, element) {
    if (element.dataset.feature !== "deseq-control" || element.dataset.key === "show") {
      return false;
    }
    ensure(state.comparison)[element.dataset.key] = element.value;
    return true;
  }

  function handleAction(state, action, element, api) {
    if (!action || action.indexOf("deseq-") !== 0 || !state.comparison) {
      return false;
    }
    const comparison = state.comparison;
    const deseq = ensure(comparison);
    const result = deseq.result;
    const base = "rnaxray-differential";
    if (action === "deseq-run") {
      run(state, api);
    } else if (action === "deseq-cancel") {
      stop();
      deseq.status = "idle";
      deseq.progress = "";
      api.render();
    } else if (!result) {
      api.showToast("Run the differential test first.");
    } else if (action === "deseq-select") {
      deseq.selected = deseq.selected === element.dataset.key ? null : element.dataset.key;
      api.render();
    } else if (action === "deseq-export-interactions") {
      api.download(base + "-interactions.tsv", window.RNAxRayDeseq.interactionsToTsv(result.interactions), "text/tab-separated-values");
      api.showToast("Interactions TSV downloaded locally.");
    } else if (action === "deseq-export-significant") {
      api.download(base + "-significant.tsv", window.RNAxRayDeseq.significantToTsv(result.significant), "text/tab-separated-values");
      api.showToast("Significant cells TSV downloaded locally.");
    } else if (action === "deseq-download-svg") {
      api.download(base + "-map.svg", panelSvg(comparison).svg, "image/svg+xml");
      api.showToast("Differential coverage map SVG downloaded locally.");
    } else if (action === "deseq-download-png") {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1640;
      const context = canvas.getContext("2d");
      context.scale(2, 2);
      drawPanel(context, 800, 820, comparison, result, deseq.show || "both", null);
      canvas.toBlob(function (blob) {
        if (blob) {
          api.downloadBlob(base + "-map.png", blob);
          api.showToast("Differential coverage map PNG downloaded locally.");
        } else {
          api.showToast("This browser could not create the PNG. Try the SVG export instead.");
        }
      }, "image/png");
    } else if (action === "deseq-use-arcmap") {
      if (!window.RNAxRayArcMap) {
        return true;
      }
      useInArcMap(state, result);
      api.render();
      api.showToast("The arc map now draws the " + result.interactions.length.toLocaleString("en-US") + " merged interactions (its own padj filter, " +
        state.arcMap.padj + ", applies).");
      const card = document.querySelector(".arcmap-card");
      if (card && typeof card.scrollIntoView === "function") {
        card.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    } else {
      return false;
    }
    return true;
  }

  // the arc map (and through it the region and folding-energy cards) draws
  // the merged interactions of this result
  function useInArcMap(state, result) {
    state.arcMap = state.arcMap || window.RNAxRayArcMap.defaultState();
    state.arcMap.interactions = window.RNAxRayDeseq.arcMapInteractions(result.interactions,
      "Differential test · " + result.labels.A + " vs " + result.labels.B);
    state.arcMap.errors = Object.assign({}, state.arcMap.errors, { interactions: "" });
    state.arcMap.labelOne = result.labels.A;
    state.arcMap.labelTwo = result.labels.B;
  }

  // ---- reproducibility (parameters JSON, report)

  function parametersReport(comparison) {
    const deseq = comparison && comparison.deseq;
    if (!deseq) {
      return null;
    }
    const params = parameters(deseq);
    const result = deseq.result;
    return {
      method: "DESeq2 1.46 Wald test, condition A (condition_one) vs B, JavaScript port of RNAxRay Desktop's numpy port (rnaxrayanalysis.deseq); rnaxray_compare interaction merge",
      validation: VALIDATION,
      parameters: { minCount: params.minCount, mergeRange: params.radius, padjCutoff: params.padjCutoff, independentFilteringAlpha: 0.01, binSize: BIN, measure: "record-count" },
      result: result ? {
        current: result.inputKey === inputKey(comparison),
        completedAt: result.completedAt || null,
        datasets: result.datasets,
        summary: result.summary
      } : null
    };
  }

  function reportData(comparison) {
    const report = parametersReport(comparison);
    if (!report || !report.result) {
      return report;
    }
    report.result.topInteractions = comparison.deseq.result.interactions.slice().sort(function (left, right) { return left.padj - right.padj; })
      .slice(0, 50);
    return report;
  }

  function reportSection(comparison, helpers) {
    const deseq = comparison && comparison.deseq;
    const result = deseq && deseq.result;
    const h = helpers;
    if (!result) {
      return '<div class="report-subsection"><h3>Differential test (DESeq2)</h3><div class="report-empty">The differential test was not run in this session.</div></div>';
    }
    const s = result.summary;
    const labelA = result.labels.A;
    const labelB = result.labels.B;
    const panel = panelSvg(comparison, { maxCells: REPORT_CELLS, show: "both", width: 640, height: 660 });
    const top = result.interactions.slice().sort(function (left, right) { return left.padj - right.padj; }).slice(0, h.maxRows || 12);
    return [
      '<div class="report-grid report-analysis-grid">',
      '<div class="report-subsection"><h3>Differential test (DESeq2 Wald test)</h3>' + h.definitionList([
        ["Datasets", result.datasets.map(function (d) { return (d.label || d.fileName) + " (" + (d.condition === "A" ? labelA : labelB) + ")"; }).join(", ")],
        ["Min count · merge range · padj", s.parameters.minCount + " · " + s.parameters.range + " nt · " + s.parameters.padjCutoff],
        ["Cells tested", h.formatNumber(s.cellsTested) + " of " + h.formatNumber(s.cellsTotal)],
        ["Significant cells", h.formatNumber(s.significant) + " (" + h.formatNumber(s.significantUp) + " higher in " + labelA + ", " + h.formatNumber(s.significantDown) + " higher in " + labelB + ")"],
        ["Merged interactions", h.formatNumber(s.interactionsUp) + " higher in " + labelA + ", " + h.formatNumber(s.interactionsDown) + " higher in " + labelB],
        ["Size factors", s.sizeFactors.map(function (v) { return v.toFixed(4); }).join(", ")],
        ["Current inputs", result.inputKey === inputKey(comparison) ? "Yes" : "No (inputs changed after the run)"]
      ]) + "</div>",
      '<div class="report-subsection"><h3>Strongest merged interactions</h3>' + h.table(["Higher in", "x", "y", "log2 A/B", "padj"], top.map(function (row) {
        return [h.escape(row.direction === "up" ? labelA : labelB), h.formatNumber(row.x), h.formatNumber(row.y), fixed(row.log2FoldChange, 2), padjText(row.padj)];
      })) + "</div>",
      "</div>",
      '<div class="report-visual-wrap"><div class="report-subsection-heading"><h3>A · Differential coverage map</h3><span class="report-note-inline">red = higher in ' + h.escape(labelA) + "; blue = higher in " + h.escape(labelB) + "; opacity by −log10 padj</span></div>" +
        h.visualBlock(panel.svg, panel.drawn < panel.total ? "Showing the " + h.formatNumber(panel.drawn) + " most significant of " + h.formatNumber(panel.total) + " cells for printing; the page's SVG export has all." : "") + "</div>",
      '<p class="report-note">The differential test is a JavaScript port of RNAxRay Desktop\'s numpy port of the DESeq2 1.46 Wald test, run in this browser. ' + h.escape(VALIDATION) + "</p>"
    ].join("");
  }

  window.RNAxRayDeseqCard = {
    renderCard: renderCard,
    draw: draw,
    handleAction: handleAction,
    handleChange: handleChange,
    handleInput: handleInput,
    run: run,
    stop: stop,
    panelSvg: panelSvg,
    parameters: parametersReport,
    reportData: reportData,
    reportSection: reportSection,
    eligibility: eligibility,
    rnaPlan: rnaPlan,
    collectArms: collectArms
  };
})();

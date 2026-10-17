(function () {
  "use strict";

  const REPORT_VERSION = "0.5.0";
  const MAX_TABLE_ROWS = 12;
  const MAX_DATASET_ROWS = 15;
  const MAX_VISUAL_CELLS = 4200;
  const SIMILARITY_GREY_PANEL = "#ebebeb"; // ggplot2 theme_grey panel
  const MAX_VISUAL_BINS = 180;
  const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

  function render(state) {
    const context = getReportContext(state || {});
    return [
      '<article class="report-page" data-report-page>',
      renderHero(context),
      renderExportPanel(context, state),
      renderContents(context),
      part("objects", "1", "Analysis objects and status"),
      renderSummary(context),
      renderStatus(context, state),
      part("results", "2", "Main results"),
      renderKeyResults(context),
      part("figures", "3", "Figures and data"),
      when(context, ["interactions"], renderInteractions),
      when(context, ["contact_map"], renderContactMap),
      when(context, ["viewpoint"], renderViewpoint),
      when(context, ["region"], renderRegion),
      when(context, ["comparison", "differential_test", "arc_map", "region_structures", "folding_energy"], renderComparison),
      when(context, ["structure"], renderStructure),
      part("methods", "4", "Methods and sources"),
      renderSource(context),
      renderValidation(context),
      renderFileFormat(),
      renderMethods(),
      when(context, ["literature_search"], renderExternalSources),
      part("limitations", "5", "Limitations and warnings"),
      renderLimitations(context),
      '</article>'
    ].join("");
  }

  function afterRender(state) {
    if (typeof document === "undefined") {
      return;
    }
    const target = document.querySelector("[data-report-structure-diagram]");
    if (!target || !window.RNAxRayStructureUI || typeof window.RNAxRayStructureUI.buildStructureDiagram !== "function") {
      return;
    }
    const result = state && state.structure && state.structure.result;
    if (!result) {
      return;
    }
    try {
      const diagram = window.RNAxRayStructureUI.buildStructureDiagram(result, null, "arc");
      if (typeof target.replaceChildren === "function") {
        target.replaceChildren(diagram);
      } else {
        while (target.firstChild) {
          target.removeChild(target.firstChild);
        }
        target.appendChild(diagram);
      }
    } catch (error) {
      target.textContent = "The printable structure diagram is unavailable. Use the Structure page SVG export.";
    }
  }

  function getReportContext(state) {
    const source = state || {};
    const reportState = Object.assign({}, source);
    reportState.summary = source.summary || {};
    reportState.filters = Object.assign({}, source.filters || {});
    ["contact", "viewpoint", "region", "comparison", "structure"].forEach(function (key) {
      reportState[key] = source[key] ? Object.assign({}, source[key]) : source[key];
    });

    // Every analysis result below was fetched through the DataProvider by
    // page-data.js (the report route prefetches each page's data); the report
    // never reads HYB rows or files itself.
    const prepared = source.view && source.view.report || null;
    const derived = { contact: false, viewpoint: false, region: false, comparison: false };

    if (reportState.contact && !reportState.contact.matrix && reportState.contact.rnaX && reportState.contact.rnaY) {
      reportState.contact.matrix = { ready: false, reason: "Contact Map is still being prepared for the report snapshot.", cells: [] };
    }
    if (reportState.viewpoint && !reportState.viewpoint.results) {
      reportState.viewpoint.results = { ready: false, bins: [], records: [], reason: "Viewpoint is still being prepared for the report snapshot." };
    }
    if (reportState.region && !reportState.region.results) {
      reportState.region.results = { records: [], partners: [], profile: [], support: 0, reason: "Region Explorer is still being prepared for the report snapshot." };
    }
    if (reportState.comparison && !reportState.comparison.result) {
      reportState.comparison.result = { ready: false, cells: [], conservedCells: [], reason: reportState.comparison.loading ? "Finish parsing the selected local datasets before generating or exporting a comparison." : "Comparison is still being prepared for the report snapshot." };
    }

    const generatedAt = new Date().toISOString();
    // the result record (results.js) gives every status and key number the
    // report shows, and the exports read the same record
    const record = window.RNAxRayResults ? safeCall(function () { return window.RNAxRayResults.build(source, { generatedAt: generatedAt }); }, null) : null;
    const fullRecord = record && record.scope.kind === "selected_results"
      ? safeCall(function () { return window.RNAxRayResults.build(source, { generatedAt: generatedAt, ignoreSelection: true }); }, record)
      : record;
    return {
      state: reportState,
      record: record,
      fullRecord: fullRecord,
      filteredTotal: prepared ? number(prepared.filteredTotal) : 0,
      filteredRecords: prepared && Array.isArray(prepared.filteredSample) ? prepared.filteredSample : [],
      partnerCounts: prepared && Array.isArray(prepared.partnerCounts) ? prepared.partnerCounts : [],
      derived: derived,
      generatedAt: generatedAt
    };
  }

  function renderHero(context) {
    const summary = context.state.summary || {};
    const fileName = summary.fileName || "Untitled HYB file";
    return [
      '<header class="report-hero">',
      '  <div class="report-hero-top">',
      '    <div class="report-identity">',
      '      <span class="report-logo-wrap report-logo-light"><img src="' + (window.RNAXRAY_ASSET_BASE || "./") + 'assets/rnaxray-wordmark.svg" alt="RNAxRay"></span>',
      '      <span class="report-logo-wrap report-logo-dark"><img src="' + (window.RNAXRAY_ASSET_BASE || "./") + 'assets/rnaxray-wordmark-dark.svg" alt="RNAxRay"></span>',
      '      <span><span class="report-product">RNAxRay Web</span><span class="report-document-label">Consolidated analysis report</span></span>',
      "    </div>",
      '    <div class="report-actions" aria-label="Report actions">',
      '      <button class="button" type="button" data-action="print-report">Print / Save PDF</button>',
      '      <details class="export-menu report-export-menu">',
      '        <summary class="button button-secondary">Export</summary>',
      '        <div class="export-menu-list" role="menu" aria-label="Export the report">',
      '          <button class="export-menu-item" type="button" role="menuitem" data-action="report-export" data-audience="people">For people<small>' + escape(EXPORT_TEXT.people[2]) + "</small></button>",
      '          <button class="export-menu-item" type="button" role="menuitem" data-action="report-export" data-audience="ai">For AI<small>' + escape(EXPORT_TEXT.ai[2]) + "</small></button>",
      '          <button class="export-menu-item" type="button" role="menuitem" data-action="report-export" data-audience="analysis">For further analysis<small>' + escape(EXPORT_TEXT.analysis[2]) + "</small></button>",
      "        </div>",
      "      </details>",
      // inside the workspace the sidebar already returns; embedded and
      // standalone views keep their own way back
      context.state.shell === true ? "" : '      <button class="quiet-button" type="button" data-action="navigate" data-page="overview">Back to workspace</button>',
      "    </div>",
      "  </div>",
      '  <div class="report-hero-copy">',
      '    <span class="report-kicker">Local session snapshot</span>',
      '    <h1>Analysis report</h1>',
      '    <p class="report-lede">A print-ready view of the current RNAxRay workspace, including configured analyses, generated results, selected intervals, and reproducibility details.</p>',
      '    <div class="report-hero-meta"><span><strong>Scope</strong> ' + escape(context.record ? context.record.scope.label : "Session report") + '</span><span><strong>Source</strong> <code>' + escape(fileName) + '</code></span><span><strong>Generated</strong> ' + timeTag(context.generatedAt) + '</span><span><strong>Version</strong> <code>RNAxRay Web ' + escape(REPORT_VERSION) + (window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit ? " · " + escape(String(window.RNAXRAY_BUILD.commit).slice(0, 12)) : "") + '</code></span>' + (context.record ? '<span><strong>Run</strong> <code>' + escape(context.record.run.id) + "</code></span>" : "") + '<span class="report-status is-ready">Processed locally</span></div>',
      context.record ? '    <p class="report-scope-note">' + escape(pageText(context.record.scope.description)) + "</p>" : "",
      "  </div>",
      '  <p class="report-print-note">Use your browser\'s Print dialog and choose <strong>Save as PDF</strong>. The report is generated in this tab and no data is uploaded.</p>',
      "</header>"
    ].join("");
  }

  function renderSummary(context) {
    const summary = context.state.summary || {};
    const totalRows = number(summary.validRecords) + number(summary.invalidRecords);
    const validRatio = totalRows ? number(summary.validRecords) / totalRows : 0;
    const fasta = context.state.reference;
    const mapped = fasta ? mappedFastaCount(fasta) : 0;
    const fastaCount = fasta ? referenceSequenceCount(fasta) : 0;
    const fastaValue = fasta ? formatNumber(fastaCount) + (fastaCount === 1 ? " sequence" : " sequences") : "Optional / not loaded";
    const fastaDetail = fasta ? formatNumber(mapped) + " mapped HYB RNA names" : "Required for reference-based structure";
    return section(
      "summary",
      "Executive summary",
      "Session snapshot",
      '<span class="report-status is-ready">Ready</span>',
      [
        '<div class="report-metric-grid">',
        metric("Valid HYB records", formatNumber(summary.validRecords), "Rows available for analysis · R01"),
        metric("Valid ratio", formatPercent(validRatio), formatNumber(summary.invalidRecords) + " invalid rows skipped · R02"),
        metric("Unique RNAs", formatNumber(summary.uniqueRNAs), "Distinct names across both arms · R03"),
        metric("RNA pairs", formatNumber(summary.uniquePairs), "Normalised pair identities · R04"),
        metric("Cluster support", formatNumber(summary.supportInteractions), "Support units retained from HYB metadata · R05"),
        metric("Reference FASTA", fastaValue, fastaDetail + (fasta ? " · R07, R08" : "")),
        "</div>",
        '<div class="report-grid report-analysis-grid report-summary-breakdown">',
        '<div class="report-subsection"><h3>Top interacting RNAs</h3>' + renderTopRnaTable(summary.rnaCounts) + dataNote(context, "tables/top_rnas.tsv") + '</div>',
        '<div class="report-subsection"><h3>Top RNA pairs</h3>' + renderTopPairTable(summary.pairCounts) + dataNote(context, "tables/top_rna_pairs.tsv") + '</div>',
        "</div>",
        '<div class="report-callout"><strong>Report scope</strong><span>Tables and inline visuals are bounded for reliable browser printing. Existing page-level CSV, TSV, HYB, SVG, PNG, FASTA, and structure exports remain the complete data path.</span></div>'
      ].join("")
    );
  }

  // What the researcher should check before reporting, for this session
  // only: each item appears when its analysis or data condition applies.
  function renderReviewChecks(context) {
    const state = context.state;
    const summary = state.summary || {};
    const items = [];
    items.push("These results describe " + (summary.fileName || "the loaded HYB file") + " only: " + formatNumber(summary.validRecords || 0) +
      " valid records (R01; " + formatNumber(summary.invalidRecords || 0) + " invalid rows skipped, R02). Counts are not normalised against other experiments.");
    const inferred = summary.inferredChimeraTypeRecords || 0;
    if (inferred) {
      items.push("Chimera types of " + formatNumber(inferred) + " records (R06) were inferred by RNAxRay because the file has no type column; check them before reporting type proportions.");
    }
    if (summary.ambiguousColumn16Records) {
      items.push(formatNumber(summary.ambiguousColumn16Records) + " rows have a legacy column 16 that may hold a raw-read count or cluster support; confirm how the file was produced.");
    }
    const names = (summary.rnaNames || []).length;
    const reference = state.reference || state.fasta;
    if (!reference) {
      items.push("No reference FASTA was loaded: RNA coordinates are not checked against a sequence.");
    } else if (mappedFastaCount(reference) < names) {
      items.push("Only " + formatNumber(mappedFastaCount(reference)) + " of " + formatNumber(names) + " HYB RNA names matched the reference FASTA (R08); coordinates of the others are not checked.");
    }
    const comparison = state.comparison || {};
    if (comparison.result && comparison.result.ready) {
      items.push("Compare effect and similarity maps (S07) are descriptive; only the differential test (S08, a JavaScript port of DESeq2, with replicates in each condition) gives adjusted p-values. Check its result against R before claiming a difference.");
    }
    const structure = state.structure || {};
    if (structure.result && structure.result.sequence) {
      items.push("The RNA structure (S12) is a computational prediction guided by chimeric reads; support key helices with independent evidence (for example probing or mutation) before stating them.");
    }
    const cards = window.RNAxRayEvidence ? safeCall(function () { return window.RNAxRayEvidence.reportCards(state); }, []) : [];
    if (cards.length) {
      items.push("External sources (S13, E ids) include AI-generated literature summaries whose citations are not verified; read the cited papers before relying on them.");
    }
    return section(
      "review",
      "Before you report these results",
      "Researcher checks for this session",
      '<span class="report-status is-pending">' + formatNumber(items.length) + (items.length === 1 ? " check" : " checks") + "</span>",
      '<ul class="report-review-list">' + items.map(function (item) { return "<li>" + escape(item) + "</li>"; }).join("") + "</ul>"
    );
  }

  function renderSource(context) {
    const state = context.state;
    const summary = state.summary || {};
    const fasta = state.reference;
    const fastaMapped = mappedFastaCount(fasta);
    const sourceHyb = sourceHybMetadata(state);
    const sourceFasta = sourceFastaMetadata(state);
    return section(
      "source",
      "Source and provenance",
      "Input files",
      '<span class="report-status is-ready">Local only</span>',
      [
        '<div class="report-grid report-source-grid">',
        '<div class="report-subsection"><h3>HYB input</h3>' + definitionList([
          ["File", sourceHyb.fileName, true],
          ["Size", formatBytes(sourceHyb.fileSize)],
          ["SHA-256", sourceHyb.sha256 || sourceHyb.sha256Status, true],
          ["Valid records", formatNumber(summary.validRecords)]
        ]) + '</div>',
        '<div class="report-subsection"><h3>Reference FASTA</h3>' + definitionList([
          ["File", sourceFasta ? sourceFasta.fileName : "Not loaded", !!sourceFasta],
          ["Size", sourceFasta ? formatBytes(sourceFasta.fileSize) : "Optional"],
          ["SHA-256", sourceFasta ? (sourceFasta.sha256 || sourceFasta.sha256Status) : "Not available", !!sourceFasta],
          ["Mapped names", sourceFasta ? formatNumber(fastaMapped) + " / " + formatNumber((summary.rnaNames || []).length) : "0"]
        ]) + '</div>',
        '<div class="report-subsection"><h3>Build context</h3>' + definitionList([
          ["Application", "RNAxRay Web"],
          ["Version", REPORT_VERSION, true],
          ["Build commit", window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit || "Local development build", true],
          ["Processing", "Browser-local; no server upload"]
        ]) + '</div>',
        "</div>",
        '<p class="report-note" data-cites="S02"><span class="report-cite">S02</span> ' + (fasta ? "The loaded FASTA is available for reference-based Viewpoint and RNA Structure workflows." : "No FASTA was loaded in this session. Interaction analysis and contact maps remain available; reference-based structure workflows will remain unavailable until a FASTA is added.") + '</p>'
      ].join("")
    );
  }

  function renderValidation(context) {
    const summary = context.state.summary || {};
    const errors = Array.isArray(summary.errors) ? summary.errors.slice(0, MAX_TABLE_ROWS) : [];
    const errorRows = errors.map(function (item) {
      return [formatNumber(item.line), escape(item.error || "Invalid row"), '<code>' + escape(truncateText(item.content || "", 120)) + '</code>'];
    });
    const status = number(summary.invalidRecords) ? '<span class="report-status is-warning">Review needed</span>' : '<span class="report-status is-ready">Passed</span>';
    return section(
      "validation",
      "Validation",
      "Parser and data quality",
      status,
      [
        '<div class="report-metric-grid report-metric-grid--compact">',
        metric("Valid records", formatNumber(summary.validRecords), "Retained"),
        metric("Invalid records", formatNumber(summary.invalidRecords), "Skipped"),
        metric("Blank lines", formatNumber(summary.skippedBlankLines), "Ignored"),
        metric("Comment lines", formatNumber(summary.skippedCommentLines), "Ignored"),
        metric("Numeric dG", formatNumber(summary.withDg), "Valid records with dG"),
        metric("Overlap score", formatNumber(summary.overlapScoreRecords), "Standard column 16"),
        metric("Collapsed IDs", formatNumber(summary.rawReadCountRecords), "Raw-read metadata found"),
        metric("Homodimer proxy", formatNumber(summary.homodimerRecords), "Overlap score >= 5"),
        "</div>",
        summary.ambiguousColumn16Records ? '<div class="report-callout report-callout--warning"><strong>Legacy column 16 detected</strong><span>' + formatNumber(summary.ambiguousColumn16Records) + ' rows were interpreted as legacy cluster support because no column 17 chimera type was present.</span></div>' : "",
        summary.errorSampleTruncated ? '<p class="report-note" data-cites="S01 R02"><span class="report-cite">S01, R02</span> The browser retained the first ' + formatNumber(summary.errorSampleCount) + ' validation details and omitted ' + formatNumber(summary.omittedErrorCount) + ' additional error details from memory. The complete invalid-row count remains ' + formatNumber(summary.invalidRecords) + '.</p>' : "",
        errors.length ? '<div class="report-table-wrap">' + table([num("Line"), "Error", "Content sample"], errorRows) + '</div>' : '<div class="report-empty is-ready">No invalid row details were retained.</div>'
      ].join("")
    );
  }

  function renderTopRnaTable(items) {
    const rows = (Array.isArray(items) ? items : []).slice(0, 8).map(function (item) {
      return [escape(item.name || ""), formatNumber(item.records), formatNumber(item.support)];
    });
    return rows.length ? table([long("RNA"), num("Records"), num("Support")], rows) : '<div class="report-empty">No RNA summary is available.</div>';
  }

  function renderTopPairTable(items) {
    const rows = (Array.isArray(items) ? items : []).slice(0, 8).map(function (item) {
      return [escape(item.rnaOne || ""), escape(item.rnaTwo || ""), formatNumber(item.records), formatNumber(item.support)];
    });
    return rows.length ? table([long("RNA 1"), long("RNA 2"), num("Records"), num("Support")], rows) : '<div class="report-empty">No RNA-pair summary is available.</div>';
  }

  function renderInteractions(context) {
    const state = context.state;
    const filters = state.filters || {};
    const records = context.filteredRecords || [];
    const total = number(context.filteredTotal);
    const partners = context.partnerCounts || [];
    const rows = boundedItems(records, MAX_TABLE_ROWS, sortRecords).map(function (record) {
      return [
        '<code>' + escape(truncateText(record.id || "", 34)) + '</code>',
        escape((record.rnaOne || "") + " <-> " + (record.rnaTwo || "")),
        '<code>' + escape(range(record.rnaOneStart, record.rnaOneEnd)) + '</code>',
        '<code>' + escape(range(record.rnaTwoStart, record.rnaTwoEnd)) + '</code>',
        escape(record.chimeraType || "Unknown"),
        formatNumber(record.supportCount),
        record.dg == null ? "-" : formatNumber(record.dg)
      ];
    });
    const filterEntries = [];
    if (filters.rna) filterEntries.push(["RNA", filters.rna]);
    if (filters.partner) filterEntries.push(["Partner", filters.partner]);
    if (filters.type && filters.type !== "all") filterEntries.push(["Class", filters.type]);
    if (filters.chimeraType && filters.chimeraType !== "all") filterEntries.push(["Chimera type", filters.chimeraType]);
    if (filters.minSupport && filters.minSupport !== "1") filterEntries.push(["Minimum support", filters.minSupport]);
    if (filters.search) filterEntries.push(["Search", filters.search]);
    const partnerRows = partners.slice(0, 10).map(function (item) {
      return [escape(item.name), formatNumber(item.records), formatNumber(item.support)];
    });
    return section(
      "interactions",
      "Interactions",
      "Filtered record view",
      stepBadge(context, "interactions", formatNumber(total) + " matches"),
      [
        '<div class="report-grid report-analysis-grid">',
        '<div class="report-subsection"><h3>Current filters</h3>' + (filterEntries.length ? definitionList(filterEntries) : '<div class="report-empty">No additional filters; all valid records are included.</div>') + '</div>',
        '<div class="report-subsection"><h3>Selected RNA partners</h3>' + (filters.rna && partnerRows.length ? table([long("Partner"), num("Records"), num("Support")], partnerRows) : '<div class="report-empty">Choose an RNA on the Interactions page to populate partner counts.</div>') + '</div>',
        "</div>",
        '<div class="report-subsection report-subsection--table"><div class="report-subsection-heading"><h3>Top matching records</h3><span class="report-note-inline">Showing ' + formatNumber(Math.min(total, MAX_TABLE_ROWS)) + ' of ' + formatNumber(total) + '</span></div>',
        rows.length ? table(["Sequence ID", long("RNA pair"), num("RNA 1 interval"), num("RNA 2 interval"), "Chimera type", num("Support"), num("dG", "kcal/mol")], rows) : '<div class="report-empty">No records match the current filter state.</div>',
        dataNote(context, "tables/interactions.tsv"),
        "</div>"
      ].join("")
    );
  }

  function renderFileFormat() {
    const rows = [
      ["1", "Sequence / read ID"],
      ["2", "Hybrid sequence"],
      ["3", "dG"],
      ["4", "Arm 1 RNA"],
      ["5-6", "Arm 1 read start / end"],
      ["7-8", "Arm 1 RNA start / end"],
      ["9", "Arm 1 e-value"],
      ["10", "Arm 2 RNA"],
      ["11-12", "Arm 2 read start / end"],
      ["13-14", "Arm 2 RNA start / end"],
      ["15", "Arm 2 e-value"],
      ["16", "Overlap score in standard 17-column HYB; legacy cluster support in older layouts"],
      ["17", "Chimera type in standard HYB output"]
    ];
    return section(
      "file-format",
      "HYB File Format",
      "Input layout",
      '<span class="report-status is-ready">Reference</span>',
      '<div class="report-subsection report-subsection--table"><p class="report-note" data-cites="S01"><span class="report-cite">S01</span> The local parser accepts the HYB record layout below. Collapsed source-read counts are retained as provenance and are not reused as Contact Map or Viewpoint weights.</p>' + table(["Column", "Field"], rows.map(function (row) { return [escape(row[0]), escape(row[1])]; })) + '</div>'
    );
  }

  function renderContactMap(context) {
    const state = context.state;
    const contact = state.contact || {};
    const matrix = contact.matrix;
    const params = parameterSnapshot("contactParameters", state, {
      rnaX: contact.rnaX || "",
      rnaY: contact.rnaY || "",
      binSize: number(contact.binSize, 10),
      measure: contact.measure || "records",
      orientation: contact.orientation || "normalised",
      chimeraType: contact.chimeraType || "all",
      homodimerSubset: contact.homodimer || "all"
    });
    const ready = !!(matrix && matrix.ready !== false && Array.isArray(matrix.cells) && matrix.cells.length);
    const status = stepBadge(context, "contact_map");
    const selectedCell = findMatrixCell(matrix, contact.selection);
    const visual = ready ? visualBlock(renderHeatmap(matrix, contact), matrix.cells.length > MAX_VISUAL_CELLS ? "Inline heatmap capped at " + formatNumber(MAX_VISUAL_CELLS) + " cells for printing." : "") : "";
    return section(
      "contact-map",
      "Contact Map",
      "RNA pair bin accumulation",
      status,
      [
        '<div class="report-grid report-analysis-grid">',
        '<div class="report-subsection"><h3>Parameters</h3>' + parameterList(params.parameters) + '</div>',
        '<div class="report-subsection"><h3>Result</h3>' + (ready ? definitionList([
          ["Cells · R10", formatNumber(matrix.cells.length)],
          ["Records used · R11", formatNumber(matrix.recordsUsed)],
          ["Total support", formatNumber(matrix.totalSupport)],
          ["Bin contributions", formatNumber(matrix.cellContributions)],
          ["Display cap", formatNumber(matrix.cap)],
          ["Selected cell", selectedCell ? range(selectedCell.x, selectedCell.x + number(matrix.binSize, 1) - 1) + " x " + range(selectedCell.y, selectedCell.y + number(matrix.binSize, 1) - 1) : "None"]
        ]) : '<div class="report-empty">' + escape(matrix && matrix.reason || "Generate a Contact Map from the workspace to include its result here.") + '</div>') + '</div>',
        "</div>",
        ready ? '<div class="report-visual-wrap"><div class="report-subsection-heading"><h3>Printable heatmap</h3><span class="report-note-inline">' + escape(contact.rnaX || "RNA X") + ' x ' + escape(contact.rnaY || "RNA Y") + ' · Teal–violet sequential</span></div>' + visual + dataNote(context, "tables/contact_map_cells.tsv") + '</div>' : "",
        matrix && matrix.resourceBudget ? '<p class="report-note" data-cites="S04 R12"><span class="report-cite">S04, R12</span> Adaptive browser budget: up to ' + formatNumber(matrix.maximumCells) + ' cells and ' + formatNumber(matrix.maximumBinContributions) + ' bin contributions for this device profile.</p>' : ""
      ].join("")
    );
  }

  function renderViewpoint(context) {
    const state = context.state;
    const viewpoint = state.viewpoint || {};
    const results = viewpoint.results;
    const ready = !!(results && results.ready && Array.isArray(results.bins) && results.bins.length);
    const params = parameterSnapshot("viewpointParameters", state, {
      rna: viewpoint.rna || "",
      partner: viewpoint.partner || "All partners",
      rangeMode: viewpoint.rangeMode || "coordinates",
      start: viewpoint.start || "",
      end: viewpoint.end || "",
      binSize: viewpoint.binSize || "1",
      measure: viewpoint.measure || "records"
    });
    return section(
      "viewpoint",
      "Viewpoint",
      "Interaction-arm coverage",
      stepBadge(context, "viewpoint"),
      [
        '<div class="report-grid report-analysis-grid">',
        '<div class="report-subsection"><h3>Parameters</h3>' + parameterList(params.parameters) + '</div>',
        '<div class="report-subsection"><h3>Result</h3>' + (ready ? definitionList([
          ["Effective range", range(results.start, results.end)],
          ["Resolution", formatNumber(results.binSize) + " nt"],
          ["Matching records · R13", formatNumber((results.records || []).length)],
          ["Mapped arms", formatNumber(results.armContributions)],
          ["Maximum coverage · R14", formatNumber(results.max)],
          ["Total coverage", formatNumber(results.totalCoverage)]
        ]) : '<div class="report-empty">Generate Viewpoint coverage from the workspace to include its result here.</div>') + '</div>',
        "</div>",
        ready ? '<div class="report-visual-wrap"><div class="report-subsection-heading"><h3>Printable coverage profile</h3><span class="report-note-inline">' + escape(results.rna || viewpoint.rna || "RNA") + '</span></div>' + visualBlock(renderCoverageSvg(results.bins, results.max, "#00a09d", viewpoint.selection && viewpoint.selection.start, results.rna || viewpoint.rna, viewpoint.measure === "support" ? "Cluster support" : "Records"), results.bins.length > MAX_VISUAL_BINS ? "Coverage bars downsampled to " + formatNumber(MAX_VISUAL_BINS) + " buckets for printing." : "") + dataNote(context, "tables/viewpoint_bins.tsv") + '</div>' : "",
        results && results.binSizeAdjusted ? '<p class="report-note" data-cites="S05"><span class="report-cite">S05</span> The requested resolution was adjusted to ' + formatNumber(results.binSize) + ' nt to keep the browser profile within its maximum bin count.</p>' : ""
      ].join("")
    );
  }

  function renderRegion(context) {
    const state = context.state;
    const region = state.region || {};
    const results = region.results;
    const ready = !!(results && (Array.isArray(results.records) || Array.isArray(results.profile)) && region.rna);
    const params = parameterSnapshot("regionParameters", state, {
      rna: region.rna || "",
      start: region.start || "",
      end: region.end || "",
      partner: region.partner || "All partners",
      partnerStart: region.partnerStart || "",
      partnerEnd: region.partnerEnd || "",
      overlap: region.overlap || "any"
    });
    const partnerRows = results && Array.isArray(results.partners) ? results.partners.slice(0, 10).map(function (item) {
      return [escape(item.name), formatNumber(item.records), formatNumber(item.support)];
    }) : [];
    const recordRows = results && Array.isArray(results.records) ? boundedItems(results.records, MAX_TABLE_ROWS, sortRecords).map(function (record) {
      return [escape(truncateText(record.id || "", 34)), escape(record.rnaOne || ""), escape(range(record.rnaOneStart, record.rnaOneEnd)), escape(record.rnaTwo || ""), escape(range(record.rnaTwoStart, record.rnaTwoEnd)), formatNumber(record.supportCount)];
    }) : [];
    return section(
      "region",
      "Region Explorer",
      "Inclusive coordinate overlap",
      stepBadge(context, "region"),
      [
        '<div class="report-grid report-analysis-grid">',
        '<div class="report-subsection"><h3>Parameters</h3>' + parameterList(params.parameters) + '</div>',
        '<div class="report-subsection"><h3>Result</h3>' + (results ? definitionList([
          ["Matching records · R15", formatNumber((results.records || []).length)],
          ["Cluster support · R16", formatNumber(results.support)],
          ["Partner RNAs · R17", formatNumber((results.partners || []).length)],
          ["Profile resolution", formatNumber(results.profileBinSize) + " nt"]
        ]) : '<div class="report-empty">Explore a region from the workspace to include its result here.</div>') + '</div>',
        "</div>",
        results && results.profile && results.profile.length ? '<div class="report-visual-wrap"><div class="report-subsection-heading"><h3>Printable region profile</h3><span class="report-note-inline">' + escape(region.rna || "RNA") + '</span></div>' + visualBlock(renderCoverageSvg(results.profile, maxSeriesValue(results.profile), "#00a09d", null, region.rna, "Arm support"), results.profile.length > MAX_VISUAL_BINS ? "Profile bars downsampled to " + formatNumber(MAX_VISUAL_BINS) + " buckets for printing." : "") + dataNote(context, "tables/region_profile.tsv") + '</div>' : "",
        '<div class="report-grid report-region-tables">',
        '<div class="report-subsection"><h3>Top partners</h3>' + (partnerRows.length ? table([long("Partner"), num("Records"), num("Support")], partnerRows) : '<div class="report-empty">No partner records are available for this region.</div>') + dataNote(context, "tables/region_partners.tsv") + '</div>',
        '<div class="report-subsection"><h3>Matching record sample</h3>' + (recordRows.length ? table(["Sequence ID", long("RNA 1"), num("Region 1"), long("RNA 2"), num("Region 2"), num("Support")], recordRows) : '<div class="report-empty">No matching records are available for this region.</div>') + '</div>',
        "</div>",
        results && results.records && results.records.length > MAX_TABLE_ROWS ? '<p class="report-note" data-cites="S06 R15"><span class="report-cite">S06, R15</span> Showing the first ' + formatNumber(MAX_TABLE_ROWS) + ' matching records. The Region Explorer export contains all local matches.</p>' : ""
      ].join("")
    );
  }

  function renderComparison(context) {
    const state = context.state;
    const comparison = state.comparison || {};
    const result = comparison.result;
    const ready = !!(result && result.ready && Array.isArray(result.cells) && result.cells.length);
    const datasets = Array.isArray(comparison.datasets) ? comparison.datasets : [];
    const params = parameterSnapshot("comparisonParameters", state, {
      conditionALabel: comparison.conditionALabel || "Condition A",
      conditionBLabel: comparison.conditionBLabel || "Condition B",
      rnaX: comparison.rnaX || "",
      rnaY: comparison.rnaY || "",
      binSize: comparison.binSize || "",
      measure: comparison.measure || "records",
      normalise: comparison.normalise || "library",
      similarityMinimum: comparison.similarityMinimum || "1",
      similarityPanel: comparison.similarityPanel === "grey" ? "grey" : "white"
    });
    const datasetRows = datasets.slice(0, MAX_DATASET_ROWS).map(function (dataset) {
      const summary = dataset.summary || {};
      return [escape(dataset.fileName || "Dataset"), escape(dataset.label || ""), escape(dataset.condition === "A" ? (comparison.conditionALabel || "Condition A") : (comparison.conditionBLabel || "Condition B")), formatNumber(summary.validRecords), formatNumber(summary.supportInteractions)];
    });
    const selected = result && comparison.selection ? findComparisonCell(result, comparison.selection) : null;
    const selectedDetail = selected ? definitionList([
      [comparison.conditionALabel || "Condition A", formatNumber(selected.conditionA)],
      [comparison.conditionBLabel || "Condition B", formatNumber(selected.conditionB)],
      ["Log2 effect", formatNumber(selected.effect)],
      ["Datasets present", formatNumber(selected.presentDatasets)],
      ["Similarity", formatNumber(selected.similarity)],
      ["Coordinates", range(selected.x, selected.x + number(result.binSize, 1) - 1) + " x " + range(selected.y, selected.y + number(result.binSize, 1) - 1)]
    ]) : '<div class="report-empty">No comparison bin is selected.</div>';
    return section(
      "comparison",
      "Compare",
      "Multi-dataset effect map",
      stepBadge(context, "comparison"),
      [
        '<div class="report-subsection report-subsection--table"><div class="report-subsection-heading"><h3>Datasets and conditions</h3><span class="report-note-inline">' + formatNumber(datasets.length) + (datasets.length === 1 ? ' local file' : ' local files') + '</span></div>',
        datasetRows.length ? table([long("File"), "Label", "Condition", num("Valid records"), num("Support")], datasetRows) : '<div class="report-empty">Add a second local HYB dataset to configure a comparison.</div>',
        datasets.length > MAX_DATASET_ROWS ? '<p class="report-note" data-cites="S07"><span class="report-cite">S07</span> Only the first ' + formatNumber(MAX_DATASET_ROWS) + ' datasets are shown in the printable report.</p>' : "",
        "</div>",
        '<div class="report-grid report-analysis-grid">',
        '<div class="report-subsection"><h3>Parameters</h3>' + parameterList(params.parameters) + '</div>',
        '<div class="report-subsection"><h3>Result</h3>' + (ready ? definitionList([
          ["Condition A datasets · R18", formatNumber((result.groupA || []).length)],
          ["Condition B datasets · R19", formatNumber((result.groupB || []).length)],
          ["Comparable bins · R20", formatNumber(result.cells.length)],
          ["Similarity bins · R21", formatNumber((result.conservedCells || []).length)],
          ["Selected bin", selected ? "Included below" : "None"]
        ]) : '<div class="report-empty">' + escape(result && result.reason || "Update the comparison from the workspace to include its result here.") + '</div>') + '</div>',
        "</div>",
        // K6, in the Compare page's order: A the differential test, then the
        // maps (B and the descriptive effect map), then panels C to G
        included(context, "differential_test") ? '<div class="report-subsection-heading report-step-heading"><h3>A · Differential test</h3>' + stepBadge(context, "differential_test") + "</div>" : "",
        window.RNAxRayDeseqCard && included(context, "differential_test") ? String(window.RNAxRayDeseqCard.reportSection(comparison, { escape: escape, formatNumber: formatNumber, table: table, definitionList: definitionList, visualBlock: visualBlock, maxRows: MAX_TABLE_ROWS }) || "")
          .split('<p class="report-note">').join('<p class="report-note" data-cites="S08"><span class="report-cite">S08</span> ') : "",
        included(context, "differential_test") ? resultRefs(context, "differential_test") : "",
        included(context, "differential_test") ? dataNote(context, "tables/differential_interactions.tsv") + dataNote(context, "tables/differential_significant_cells.tsv") : "",
        ready ? '<div class="report-visual-pair"><div class="report-visual-wrap"><div class="report-subsection-heading"><h3>Descriptive · Mean log2 effect</h3><span class="report-note-inline">not a test · violet = ' + escape(comparison.conditionALabel || "A") + ' enriched; teal = ' + escape(comparison.conditionBLabel || "B") + ' enriched</span></div>' + visualBlock(renderComparisonMapSvg(result, comparison, "effect"), result.cells.length > MAX_VISUAL_CELLS ? "Effect map capped at " + formatNumber(MAX_VISUAL_CELLS) + " cells for printing." : "") + '</div><div class="report-visual-wrap"><div class="report-subsection-heading"><h3>B · Similarity heatmap</h3><span class="report-note-inline">smaller raw count of A and B (HYB plot_similarity_map)</span></div>' + visualBlock(renderComparisonMapSvg(result, comparison, "conserved"), (result.conservedCells || []).length > MAX_VISUAL_CELLS ? "Similarity map capped at " + formatNumber(MAX_VISUAL_CELLS) + " cells for printing." : "") + '</div></div>' + dataNote(context, "tables/compare_cells.tsv") : "",
        '<div class="report-subsection"><h3>Selected comparison bin</h3>' + selectedDetail + '</div>',
        renderFigurePanels(context),
        '<p class="report-note" data-cites="S07 S08"><span class="report-cite">S07, S08</span> Comparison effects are descriptive library-size-normalised values; adjusted p-values come only from the differential test' + (comparison.deseq && comparison.deseq.result ? " above" : ", which was not run") + '.</p>'
      ].join("")
    );
  }

  function renderStructure(context) {
    const state = context.state;
    const structure = state.structure || {};
    const result = structure.result;
    const sequenceInfo = !result && window.RNAxRayPages && typeof window.RNAxRayPages.getStructureSequence === "function"
      ? safeCall(function () { return window.RNAxRayPages.getStructureSequence(state); }, null)
      : null;
    const ready = !!(result && result.sequence);
    const cplfold = result && result.engine === "CPLfold";
    const candidateRows = cplfold && Array.isArray(result.candidates) ? result.candidates.slice(0, MAX_TABLE_ROWS).map(function (candidate, index) {
      return [formatNumber(index + 1), escape(candidate.type || ""), escape(candidate.topology || "nested"), candidate.energy == null ? "-" : formatNumber(candidate.energy), formatNumber((candidate.pairs || []).length), formatNumber(candidate.crossingPairs || 0), '<code>' + escape(truncateText(candidate.dotBracket || "", 90)) + '</code>'];
    }) : [];
    const structureReportData = ready && window.RNAxRayStructureUI && typeof window.RNAxRayStructureUI.structureReport === "function"
      ? safeCall(function () { return window.RNAxRayStructureUI.structureReport(state, result); }, null)
      : null;
    const source = ready ? (structureReportData && structureReportData.source || {}) : {};
    const prediction = ready ? (structureReportData && structureReportData.prediction || {}) : {};
    return section(
      "structure",
      "RNA Structure",
      "Secondary-structure prediction",
      stepBadge(context, "structure"),
      [
        '<div class="report-grid report-analysis-grid">',
        '<div class="report-subsection"><h3>Setup</h3>' + definitionList([
          ["Engine", structure.engine === "cplfold" ? "CPLfold / Pyodide" : "ViennaRNA WebAssembly"],
          ["Source", structure.source || "Not selected"],
          ["RNA", structure.rna || "-", true],
          ["Range", structure.start && structure.end ? range(structure.start, structure.end) : "-"],
          ["Constraint mode", structure.constraintMode || "none"],
          ["Pseudoknot search", structure.engine === "cplfold" ? (structure.cplfoldAllowPseudoknot === false ? "Disabled" : "Allowed") : "Outside ViennaRNA mode"]
        ]) + '</div>',
        '<div class="report-subsection"><h3>Result</h3>' + (ready ? definitionList([
          ["Prepared sequence · R37", formatNumber(result.sequence.length) + " nt"],
          ["Energy · R38", result.energy == null ? "-" : formatNumber(result.energy) + " " + (result.energyUnit || "kcal/mol")],
          ["Topology", prediction.topology || result.topology || "nested"],
          ["Base pairs · R39", formatNumber((result.pairs || []).length)],
          ["Crossing pairs · R40", formatNumber(result.crossingPairs || 0)],
          ["Selected candidate", cplfold ? formatNumber(number(result.selectedCandidate, 0) + 1) : "MFE"]
        ]) : '<div class="report-empty">' + escape(sequenceInfo && sequenceInfo.error || "Run a structure prediction from the workspace to include its result here.") + '</div>') + '</div>',
        "</div>",
        ready ? '<div class="report-structure-result"><div class="report-subsection-heading"><h3>Printable secondary-structure view</h3><span class="report-note-inline">Arc layout used for the report snapshot</span></div><div class="report-structure-diagram" data-report-structure-diagram></div><p class="report-note" data-cites="S12"><span class="report-cite">S12</span> The report uses a stable Arc layout so it prints consistently. Use the RNA Structure page SVG/PNG controls to export folded, radial, circular, or matrix views.</p>' + dataNote(context, "results/structure_prediction.json") + dataNote(context, "results/structure_prediction.dbn") + '</div>' : "",
        ready ? '<div class="report-grid report-analysis-grid">' : "",
        ready ? '<div class="report-subsection"><h3>Sequence</h3><pre class="report-sequence"><code>' + escape(truncateText(result.sequence || "", 1400)) + '</code></pre><p class="report-note" data-cites="S12 R37"><span class="report-cite">S12, R37</span> The complete prepared sequence remains available through the Structure page FASTA export.</p></div>' : "",
        ready ? '<div class="report-subsection"><h3>Dot-bracket</h3><pre class="report-sequence"><code>' + escape(truncateText(result.dotBracket || "", 1400)) + '</code></pre><p class="report-note" data-cites="S12"><span class="report-cite">S12</span> Selected candidate: ' + escape(prediction.structureType || result.structureType || "MFE") + '; view the complete notation through the DBN export.</p></div>' : "",
        ready ? "</div>" : "",
        cplfold && candidateRows.length ? '<div class="report-subsection report-subsection--table"><div class="report-subsection-heading"><h3>CPLfold candidates</h3><span class="report-note-inline">Showing ' + formatNumber(Math.min(result.candidates.length, MAX_TABLE_ROWS)) + ' of ' + formatNumber(result.candidates.length) + '</span></div>' + table([num("Rank"), "Type", "Topology", num("Energy", "kcal/mol"), num("Pairs"), num("Crossing"), "Dot-bracket"], candidateRows) + '</div>' : "",
        ready && cplfold ? '<p class="report-note" data-cites="S12"><span class="report-cite">S12</span> CPLfold candidates preserve the selected pseudoknot setting and HYB bonus-matrix provenance. The complete candidate and bonus-matrix exports remain available from the RNA Structure page.</p>' : ""
      ].join("")
    );
  }

  // Cards the researcher added from Related research, bound to the current
  // structure result. Background material only: nothing here changes a
  // method, parameter or number in this report.
  function renderExternalSources(context) {
    const cards = window.RNAxRayEvidence ? safeCall(function () { return window.RNAxRayEvidence.reportCards(context.state); }, []) : [];
    const reviewLabel = { unreviewed: "Not reviewed", reviewed: "Reviewed", rejected: "Rejected" };
    return section(
      "external-sources",
      "External sources and researcher notes",
      "Public databases",
      stepBadge(context, "literature_search", cards.length ? formatNumber(cards.length) + " added" : null),
      cards.length ? cards.map(function (card, index) {
        const evidenceId = "E" + String(index + 1).padStart(2, "0");
        const cite = '<p class="report-note" data-cites="S13 ' + evidenceId + '"><span class="report-cite">S13, ' + evidenceId + "</span> ";
        const text = window.RNAxRayEvidence.statusLine(card);
        const entries = (card.entries || []).map(function (entry) {
          return card.content_kind === "database_metadata"
            ? "<li><strong>" + escape(entry.id) + "</strong> " + escape(entry.description) + (entry.hasLitSumm ? " <em>(RNAcentral AI literature summary available; not included)</em>" : "") + "</li>"
            : "<li>" + escape(entry.title) + (entry.year ? " (" + escape(entry.year) + ")" : "") + (entry.pmid ? " · PMID " + escape(entry.pmid) : "") + "</li>";
        }).join("");
        return [
          '<div class="report-subsection report-evidence-card">',
          "<h3><code>" + evidenceId + "</code> " + escape(card.source_provider) + " · <code>" + escape(card.query_identifier) + "</code></h3>",
          definitionList([
            ["Query", card.query_identifier + (card.taxon ? " · taxon " + card.taxon : ""), true],
            ["Retrieved", card.retrieved_at ? formatTimestamp(card.retrieved_at) : "-"],
            ["Status", (window.RNAxRayEvidence.STATUS_TEXT[card.status] || card.status)],
            ["Bound to", card.binding && card.binding.rna ? card.binding.rna + " " + range(card.binding.start, card.binding.end) : (card.binding && card.binding.source || "-"), true],
            ["Structure digest", card.binding && card.binding.resultDigest || "No result yet", true],
            ["Review", reviewLabel[card.review && card.review.state] || "Not reviewed"],
            card.review && card.review.note ? ["Researcher note", card.review.note] : null
          ]),
          cite + escape(text) + "</p>",
          entries ? "<ul>" + entries + "</ul>" : "",
          cite + '<strong>' + (card.content_kind === "database_metadata" ? "External database record — background only, not a validation of this structure." : "Literature index — a mention is not evidence for this structure.") + "</strong> Citations not verified.</p>",
          "</div>"
        ].join("");
      }).join("") : '<div class="report-empty">No external sources were added. Public lookups on the RNA Structure page are optional and off by default; a researcher adds each card to the report explicitly.</div>'
    );
  }

  function renderMethods() {
    return section(
      "methods",
      "Methods and privacy",
      "Interpretation notes",
      '<span class="report-status is-ready">Documented</span>',
      [
        '<div class="report-grid report-analysis-grid">',
        '<div class="report-subsection"><h3>Analysis semantics</h3><p>HYB records are validated locally. Contact Map accumulates selected records into inclusive coordinate bins. Viewpoint and Region Explorer use inclusive RNA coordinates. Compare reports descriptive effect sizes rather than statistical significance.</p></div>',
        '<div class="report-subsection"><h3>RNA structure</h3><p>ViennaRNA runs in a dedicated WebAssembly worker. CPLfold runs as pure Python in Pyodide and can search pseudoknot candidates. HYB-guided CPLfold exports retain the bonus matrix as a separate input.</p></div>',
        '<div class="report-subsection"><h3>Privacy</h3><p>This is a static browser-local application. Files, derived records, and analysis results stay in this tab\'s memory. Printing and JSON download happen locally through browser APIs.</p></div>',
        "</div>",
        '<div class="report-callout"><strong>Reproducibility boundary</strong><span>This consolidated document is a readable snapshot. Use the page-level parameter reports and raw exports when a complete machine-readable analysis package is required.</span></div>'
      ].join("")
    );
  }

  function getData(state) {
    const context = getReportContext(state || {});
    const reportState = context.state;
    const summary = reportState.summary || {};
    const contact = reportState.contact || {};
    const matrix = contact.matrix;
    const viewpoint = reportState.viewpoint || {};
    const viewpointResult = viewpoint.results;
    const region = reportState.region || {};
    const regionResult = region.results;
    const comparison = reportState.comparison || {};
    const comparisonResult = comparison.result;
    const structure = reportState.structure || {};
    const structureResult = structure.result;
    const structurePayload = structureResult && window.RNAxRayStructureUI && typeof window.RNAxRayStructureUI.structureReport === "function"
      ? safeCall(function () { return window.RNAxRayStructureUI.structureReport(reportState, structureResult); }, { result: structureResult })
      : { setup: pickStructureSetup(structure), result: structureResult || null };

    return {
      application: "RNAxRay Web",
      version: REPORT_VERSION,
      buildCommit: window.RNAXRAY_BUILD && window.RNAXRAY_BUILD.commit || null,
      generatedLocally: true,
      generatedAt: context.generatedAt,
      reportScope: {
        kind: "consolidated-session-snapshot",
        boundedTables: true,
        rawExportsRemainAvailable: true
      },
      sourceHyb: sourceHybMetadata(reportState),
      sourceFasta: sourceFastaMetadata(reportState),
      summary: jsonSafe(summary, 3, 200),
      validation: {
        invalidRecords: number(summary.invalidRecords),
        errors: jsonSafe((summary.errors || []).slice(0, MAX_TABLE_ROWS), 3, 50),
        errorSampleTruncated: !!summary.errorSampleTruncated,
        omittedErrorCount: number(summary.omittedErrorCount)
      },
      analyses: {
        interactions: {
          parameters: jsonSafe(reportState.filters || {}, 3, 50),
          result: {
            matchingRecords: context.filteredTotal,
            topPartners: jsonSafe(context.partnerCounts.slice(0, 10), 3, 50),
            sampleRecords: jsonSafe(boundedItems(context.filteredRecords, MAX_TABLE_ROWS, sortRecords), 3, 50)
          }
        },
        contactMap: {
          parameters: jsonSafe(parameterSnapshot("contactParameters", reportState, contact), 4, 100),
          result: matrix ? {
            ready: matrix.ready !== false,
            reason: matrix.reason || null,
            cells: Array.isArray(matrix.cells) ? matrix.cells.length : 0,
            recordsUsed: number(matrix.recordsUsed),
            totalSupport: number(matrix.totalSupport),
            binSize: number(matrix.binSize, 10),
            maximumCells: number(matrix.maximumCells),
            maximumBinContributions: number(matrix.maximumBinContributions),
            selectedCell: jsonSafe(findMatrixCell(matrix, contact.selection), 3, 20),
            visualCells: jsonSafe(boundedItems(matrix.cells || [], MAX_VISUAL_CELLS, sortCells), 3, 20)
          } : { ready: false, reason: "Not generated", cells: 0 }
        },
        viewpoint: {
          parameters: jsonSafe(parameterSnapshot("viewpointParameters", reportState, viewpoint), 4, 100),
          result: viewpointResult ? {
            ready: viewpointResult.ready !== false,
            start: viewpointResult.start,
            end: viewpointResult.end,
            binSize: viewpointResult.binSize,
            matchingRecords: Array.isArray(viewpointResult.records) ? viewpointResult.records.length : 0,
            armContributions: number(viewpointResult.armContributions),
            totalCoverage: number(viewpointResult.totalCoverage),
            bins: jsonSafe((viewpointResult.bins || []).slice(0, MAX_VISUAL_BINS), 3, 20)
          } : { ready: false, reason: "Not generated", bins: [] }
        },
        region: {
          parameters: jsonSafe(parameterSnapshot("regionParameters", reportState, region), 4, 100),
          result: regionResult ? {
            matchingRecords: Array.isArray(regionResult.records) ? regionResult.records.length : 0,
            support: number(regionResult.support),
            partners: jsonSafe((regionResult.partners || []).slice(0, 10), 3, 50),
            profile: jsonSafe((regionResult.profile || []).slice(0, MAX_VISUAL_BINS), 3, 20),
            sampleRecords: jsonSafe(boundedItems(regionResult.records || [], MAX_TABLE_ROWS, sortRecords), 3, 50)
          } : { ready: false, reason: "Not generated" }
        },
        comparison: {
          parameters: jsonSafe(parameterSnapshot("comparisonParameters", reportState, comparison), 4, 150),
          datasets: jsonSafe(comparisonDatasets(comparison), 3, 50),
          result: comparisonResult ? {
            ready: comparisonResult.ready === true,
            reason: comparisonResult.reason || null,
            comparableBins: Array.isArray(comparisonResult.cells) ? comparisonResult.cells.length : 0,
            similarityBins: Array.isArray(comparisonResult.conservedCells) ? comparisonResult.conservedCells.length : 0,
            selectedCell: jsonSafe(findComparisonCell(comparisonResult, comparison.selection), 3, 50),
            effectCells: jsonSafe(boundedItems(comparisonResult.cells || [], MAX_VISUAL_CELLS, sortEffectCells), 3, 50)
          } : { ready: false, reason: "Not generated" },
          differentialTest: window.RNAxRayDeseqCard ? jsonSafe(window.RNAxRayDeseqCard.reportData(comparison), 6, 100) : null
        },
        structure: jsonSafe(structurePayload, 5, 1000)
      },
      resultRecord: context.record ? jsonSafe({ schema: context.record.schema, scope: context.record.scope, steps: context.record.steps.map(function (step) { return { id: step.id, key: step.key, status: step.status, detail: step.detail }; }), results: context.record.results, warnings: context.record.warnings }, 5, 200) : null,
      externalSources: window.RNAxRayEvidence ? jsonSafe(safeCall(function () { return window.RNAxRayEvidence.reportCards(reportState); }, []), 6, 50) : [],
      methods: {
        browserLocal: true,
        reportUsesBoundedVisuals: true,
        completeExportsRemainOnPages: true
      }
    };
  }


  // ---- result record: badges, results at a glance, figure panels, export

  const STATUS_BADGE = {
    ok: ["is-ready", "Completed"],
    no_result: ["is-pending", "No result"],
    not_run: ["is-pending", "Not run"],
    running: ["is-pending", "Running"],
    pending: ["is-pending", "Preparing"],
    failed: ["is-warning", "Failed"],
    stale: ["is-warning", "Inputs changed"]
  };

  // status codes stay in data-status, Markdown and JSON; the page shows words
  const RESULT_STATUS_TEXT = { not_available: "No value" };

  function statusLabel(code) {
    const badge = STATUS_BADGE[code];
    return badge ? badge[1] : RESULT_STATUS_TEXT[code] || humanize(code);
  }

  // text from the result record shown on the page: no raw status codes
  function pageText(text) {
    return String(text == null ? "" : text).replace(/\b(not_run|no_result|not_available)\b/g, function (code) {
      return statusLabel(code).toLowerCase();
    });
  }

  function recordStep(context, key) {
    const record = context.record;
    return record ? record.steps.find(function (step) { return step.key === key; }) || null : null;
  }

  // the status chip of a section, from the result record's step status
  function stepBadge(context, key, okLabel) {
    const step = recordStep(context, key);
    if (!step) {
      return '<span class="report-status is-pending">Configured</span>';
    }
    const badge = STATUS_BADGE[step.status] || ["is-pending", statusLabel(step.status)];
    const label = step.status === "ok" && okLabel ? okLabel : badge[1];
    return '<span class="report-status ' + badge[0] + '" data-step="' + escape(step.id) + '" data-status="' + escape(step.status) + '" title="' + escape(step.id + " · " + pageText(step.detail || step.statusText)) + '">' + escape(label) + "</span>";
  }

  // a part heading of the report (1 to 5), also the table of contents' anchors
  const PARTS = [["objects", "1", "Analysis objects and status"], ["results", "2", "Main results"], ["figures", "3", "Figures and data"],
    ["methods", "4", "Methods and sources"], ["limitations", "5", "Limitations and warnings"]];

  function part(id, number, title) {
    return '<h2 class="report-part" id="report-part-' + id + '"><span>' + escape(number) + "</span> " + escape(title) + "</h2>";
  }

  function renderContents(context) {
    const record = context.record;
    const steps = record ? record.steps : [];
    const done = steps.filter(function (step) { return step.status === "ok" || step.status === "no_result"; }).length;
    return '<nav class="report-contents" aria-label="Report contents"><strong>Contents</strong><ol>' + PARTS.map(function (p) {
      return '<li><span>' + escape(p[1]) + '</span><a href="#report-part-' + p[0] + '" data-action="report-jump" data-target="report-part-' + p[0] + '">' + escape(p[2]) + "</a></li>";
    }).join("") + "</ol>" + (record ? '<span class="report-note-inline">' + formatNumber(done) + " of " + formatNumber(steps.length) + " steps completed · " +
      formatNumber(record.warnings.length) + (record.warnings.length === 1 ? " warning" : " warnings") + "</span>" : "") + "</nav>";
  }

  // a step is in the report unless a selected-results report left it out
  function included(context, key) {
    const record = context.record;
    return !record || record.scope.kind !== "selected_results" || record.steps.some(function (step) { return step.key === key; });
  }

  function when(context, keys, render) {
    return keys.some(function (key) { return included(context, key); }) ? render(context) : "";
  }

  // "Data: T05 tables/x.tsv [Download]" under a chart or table
  const FULL_ONLY = { "tables/interactions.tsv": "every filtered record (built when you download it)" };
  function dataNote(context, file) {
    const record = context.record;
    const t = record ? record.tables.find(function (item) { return item.file === file; }) : null;
    const st = record ? record.structures.find(function (item) { return item.file === file; }) : null;
    if (!t && !st && !FULL_ONLY[file]) {
      return "";
    }
    const audience = t ? (t.audience.indexOf("analysis") >= 0 ? "analysis" : "ai") : "analysis";
    const label = t ? t.id + " " + file : file;
    const detail = t ? t.scope : st ? st.title : FULL_ONLY[file];
    return '<p class="report-data-note">Data: <code>' + escape(label) + "</code> · " + escape(detail) + ' <button class="quiet-button" type="button" data-action="report-export-file" data-audience="' + audience + '" data-path="' + escape(file) + '">Download</button></p>';
  }

  // "R22 Cells tested 4,321 · R23 ..." for a step
  function resultRefs(context, key) {
    const step = recordStep(context, key);
    if (!step) {
      return "";
    }
    const items = context.record.results.filter(function (r) { return r.step === step.id; });
    return items.length ? '<p class="report-data-note">Results: ' + items.map(function (r) {
      return "<code>" + escape(r.id) + "</code> " + escape(r.label) + ' <span data-result-ref="' + escape(r.id) + '">' + escape(window.RNAxRayResults.formatValue(r)) + "</span>";
    }).join(" · ") + "</p>" : "";
  }

  function renderStatus(context, state) {
    const record = context.record;
    if (!record) {
      return "";
    }
    const purpose = state && typeof state.reportPurpose === "string" ? state.reportPurpose : "";
    const full = context.fullRecord || record;
    const selected = record.scope.kind === "selected_results";
    const done = full.steps.filter(function (step) { return step.status === "ok" || step.status === "no_result"; }).length;
    const stepRows = full.steps.map(function (step) {
      const kept = !selected || record.steps.some(function (item) { return item.id === step.id; });
      const box = '<input class="report-select" type="checkbox" data-action="report-select" data-step="' + escape(step.key) + '"' + (kept ? " checked" : "") +
        (step.key === "parse" ? " disabled" : "") + ' aria-label="Include ' + escape(step.id + " " + step.title) + ' in the report">';
      return [box + ' <code>' + escape(step.id) + "</code>", escape(step.title) + (kept ? "" : ' <em class="report-left-out">left out</em>'), stepBadge({ record: full }, step.key),
        escape(step.scope || "—"), step.completedAt ? timeTag(step.completedAt) : escape(step.status === "ok" || step.status === "no_result" ? "from current inputs" : "—"), escape(pageText(step.detail || ""))];
    });
    return section(
      "status",
      "Analysis status",
      "Steps, scope and purpose",
      '<span class="report-status is-ready">' + formatNumber(done) + " of " + formatNumber(record.steps.length) + " steps completed</span>",
      [
        '<label class="report-purpose"><span>Purpose of this analysis (optional, written by you; saved in the exports as the researcher\'s text)</span>' +
          '<textarea id="report-purpose" rows="2" maxlength="1000" placeholder="e.g. Which ZIKV genome contacts differ between the African and Asian lineages?">' + escape(purpose) + "</textarea></label>",
        purpose.trim() ? '<p class="report-purpose-print"><strong>Purpose:</strong> ' + escape(purpose.trim()) + "</p>" : "",
        '<p class="report-note">Each step has a fixed id (S01 to S13) shared with the Markdown and JSON exports. A step that did not run shows “Not run”; its results show —, never 0. Untick a step to make a selected-results report: the page and every export then leave it out and say so.</p>',
        selected ? '<p class="notice notice-warning report-selected-note">Selected results report: ' + escape(record.scope.omittedSteps.join(", ")) + ' left out. <button class="quiet-button" type="button" data-action="report-select-all">Include every step</button></p>' : "",
        '<div class="report-subsection report-subsection--table">' + table(["Id", "Step", "Status", "Scope", "Completed", "Detail"], stepRows) + "</div>"
      ].join("")
    );
  }

  function renderKeyResults(context) {
    const record = context.record;
    if (!record) {
      return "";
    }
    const resultRows = record.results.map(function (result) {
      return ['<code>' + escape(result.id) + "</code>", '<code>' + escape(result.step) + "</code>", escape(result.label),
        '<span data-result="' + escape(result.id) + '">' + escape(window.RNAxRayResults.formatValue(result)) + "</span>", escape(result.unit), escape(statusLabel(result.status)),
        '<span title="' + escape(window.RNAxRayResults.NATURE_TEXT[result.nature] || "") + '">' + escape(result.nature.replace(/_/g, " ")) + "</span>"];
    });
    const tableRows = record.tables.map(function (t) {
      return ['<code>' + escape(t.id) + "</code>", '<code>' + escape(t.step) + "</code>", escape(t.title), escape(t.scope),
        "<code>" + escape(t.file) + '</code> <button class="quiet-button" type="button" data-action="report-export-file" data-audience="' + (t.audience.indexOf("analysis") >= 0 ? "analysis" : "ai") + '" data-path="' + escape(t.file) + '">Download</button>'];
    });
    return section(
      "results-index",
      "Results at a glance",
      "Every result with its id, value, unit and status",
      '<span class="report-status is-ready">' + formatNumber(record.results.filter(function (r) { return r.value !== null; }).length) + " of " + formatNumber(record.results.length) + " with a value</span>",
      [
        '<p class="report-note">The numbers in the sections below carry the same ids (for example "Cells · R10"). Each result covers its step\'s scope in Analysis status.</p>',
        '<details class="report-details" open data-open-key="report-results"><summary>Results (' + formatNumber(record.results.length) + ")</summary>" + table(["Id", "Step", "Result", num("Value"), "Unit", "Status", "Nature"], resultRows) + "</details>",
        tableRows.length ? '<details class="report-details" data-open-key="report-tables"><summary>Data tables (' + formatNumber(tableRows.length) + ")</summary>" + table(["Id", "Step", "Table", "Scope", "File"], tableRows) + "</details>" : ""
      ].join("")
    );
  }

  function renderLimitations(context) {
    const record = context.record;
    return [
      renderReviewChecks(context),
      record ? section(
        "limitations",
        "Warnings and limitations",
        "From the result record",
        '<span class="report-status ' + (record.warnings.length ? "is-warning" : "is-ready") + '">' + formatNumber(record.warnings.length) + (record.warnings.length === 1 ? " warning" : " warnings") + "</span>",
        [
          '<div class="report-subsection"><h3>Warnings</h3>' + (record.warnings.length ? '<ul class="report-review-list">' + record.warnings.map(function (w) {
            return "<li><code>" + escape(w.id) + "</code> (" + escape(w.step) + ") " + escape(pageText(w.text)) + "</li>";
          }).join("") + "</ul>" : '<div class="report-empty is-ready">No warnings for this session.</div>') + "</div>",
          '<div class="report-subsection"><h3>Limitations</h3><ul class="report-review-list">' + record.limitations.map(function (text) { return "<li>" + escape(pageText(text)) + "</li>"; }).join("") + "</ul></div>"
        ].join("")
      ) : ""
    ].join("");
  }

  // panels C to G of the Compare figure, each with the table behind it
  function renderFigurePanels(context) {
    const record = context.record;
    if (!record) {
      return "";
    }
    // K6 panel names, as on the Compare page
    const keys = [["arc_map", "C · Arc map"], ["region_structures", "D, E · Region structures"], ["folding_energy", "F, G · Folding energy"]];
    return keys.filter(function (pair) { return included(context, pair[0]); }).map(function (pair) {
      const step = recordStep(context, pair[0]);
      const figures = record.figures.filter(function (f) { return f.step === step.id; });
      const tables = record.tables.filter(function (t) { return t.step === step.id; });
      const body = figures.map(function (f) {
        const svg = safeCall(f.svg, "");
        // the panel heading already names a figure titled like its panel
        const heading = f.title === pair[1] ? '<span class="report-note-inline">' + escape(f.id + " · " + f.file) + "</span>" : "<h3>" + escape(f.title) + '</h3><span class="report-note-inline">' + escape(f.id) + "</span>";
        return svg ? '<div class="report-visual-wrap"><div class="report-subsection-heading">' + heading + "</div>" + visualBlock(svg, "") + "</div>" : "";
      }).join("");
      const data = tables.length ? '<p class="report-data-note">Data: ' + tables.map(function (t) {
        return "<code>" + escape(t.id + " " + t.file) + '</code> <button class="quiet-button" type="button" data-action="report-export-file" data-audience="' + (t.audience.indexOf("analysis") >= 0 ? "analysis" : "ai") + '" data-path="' + escape(t.file) + '">Download</button>';
      }).join(" · ") + "</p>" : "";
      return '<div class="report-subsection report-figure-panel"><div class="report-subsection-heading report-step-heading"><h3>' + escape(pair[1]) + "</h3>" + stepBadge(context, pair[0]) + "</div>" +
        (body || '<div class="report-empty">' + escape(pageText(step.detail || step.statusText)) + "</div>") + resultRefs(context, pair[0]) + data + "</div>";
    }).join("");
  }

  // [menu label, panel description, one-line menu summary]
  const EXPORT_TEXT = {
    people: ["For people", "Read, print or archive the report. Print / Save PDF keeps a fixed layout; the offline HTML keeps this page's tables, figures and open sections in one file that works without this site.",
      "PDF or offline HTML to read, print or archive"],
    ai: ["For AI", "A layered context package for an AI assistant: README, a template report.md (no language model), summary.json with every result id, status and unit, data_dictionary.json, provenance.json, evidence.json and bounded tables. Large tables stay in the analysis package.",
      "Context package: summary, result ids, bounded tables"],
    analysis: ["For further analysis", "Tables with a data dictionary for scripts and other tools: every filtered record, every comparison cell and significant cell, region and folding-energy tables, structures as dot-bracket, and the figure SVGs.",
      "Full tables with a data dictionary, structures, SVGs"]
  };

  function renderExportPanel(context, state) {
    const exp = state && state.reportExport;
    if (!exp || !EXPORT_TEXT[exp.audience]) {
      return "";
    }
    const text = EXPORT_TEXT[exp.audience];
    const out = ['<section class="report-export-panel" aria-label="Export ' + escape(text[0]) + '" data-report-export-panel>',
      '<div class="report-subsection-heading"><h2>Export · ' + escape(text[0]) + '</h2><button class="quiet-button" type="button" data-action="report-export-close">Close</button></div>',
      '<p class="report-note">' + escape(text[1]) + "</p>"];
    // a step still being prepared would be exported as pending, not as a result
    if (context.record && context.record.scope.kind === "selected_results") {
      out.push('<p class="notice notice-warning">Selected results report: only the ticked steps are exported (' + escape(context.record.scope.omittedSteps.join(", ")) + " left out), and every file says so.</p>");
    }
    const waiting = context.record ? context.record.steps.filter(function (step) { return step.status === "pending" || step.status === "running"; }) : [];
    if (waiting.length) {
      out.push('<p class="notice notice-warning" data-export-waiting>Still being prepared: ' + escape(waiting.map(function (step) { return step.id + " " + step.title; }).join("; ")) +
        ". These steps are exported as " + escape(waiting.map(function (step) { return statusLabel(step.status).toLowerCase(); }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(" or ")) + ", without results; open the export again when they finish to include their results.</p>");
    }
    if (exp.audience === "people") {
      out.push('<div class="report-export-actions"><button class="button" type="button" data-action="print-report">Print / Save PDF</button><button class="button button-secondary" type="button" data-action="report-export-html">Download offline HTML</button></div>');
    } else if (exp.status === "preparing") {
      out.push('<p class="report-note" aria-live="polite">Preparing the files in this tab…</p>');
    } else if (exp.status === "error") {
      out.push('<p class="notice notice-error">' + escape(exp.error || "The export could not be prepared.") + "</p>");
    } else if (exp.status === "ready") {
      const total = exp.list.reduce(function (sum, f) { return sum + (f.excluded ? 0 : f.bytes); }, 0);
      out.push('<div class="report-export-actions"><button class="button" type="button" data-action="report-export-zip">Download all (' + escape(formatBytes(total)) + ", ZIP)</button>" +
        (exp.audience === "ai" ? '<button class="button button-secondary" type="button" data-action="report-export-copy">Copy AI summary (report.md)</button>' : "") + "</div>");
      out.push(table(["Include", "File", "Contents and fields", num("Size"), ""], exp.list.map(function (f) {
        const box = '<input type="checkbox" data-action="report-export-toggle" data-path="' + escape(f.path) + '"' + (f.excluded ? "" : " checked") + (f.required ? " disabled" : "") +
          ' aria-label="Include ' + escape(f.path) + '">';
        const fields = f.fields && f.fields.length ? '<details class="report-fields"><summary>' + formatNumber(f.fields.length) + (f.fields.length === 1 ? " field" : " fields") + "</summary><code>" +
          f.fields.map(escape).join("</code> <code>") + "</code></details>" : "";
        return [box, "<code>" + escape(f.path) + "</code>" + (f.excluded ? ' <em class="report-left-out">left out</em>' : ""), escape(f.description) + fields, escape(formatBytes(f.bytes)),
          f.excluded ? "" : '<button class="quiet-button" type="button" data-action="report-export-file" data-audience="' + escape(exp.audience) + '" data-path="' + escape(f.path) + '">Download</button>'];
      })));
      out.push(exp.list.some(function (f) { return f.excluded; }) ? '<p class="report-note">Files you leave out are listed in manifest.json and README.md as left out by the researcher; data_dictionary.json then describes only the tables that stay. README.md and manifest.json are always included.</p>' : "");
      out.push('<p class="report-note"><strong>Not included:</strong> the input files themselves (only names and SHA-256), local paths, and anything outside this tab. Everything is built in this browser; nothing is uploaded. Sharing a file is a separate step you take yourself.</p>');
    }
    out.push("</section>");
    return out.join("");
  }

  function section(id, title, kicker, status, body) {
    return [
      '<section class="report-section report-section--' + id + '" id="report-' + id + '">',
      '  <div class="report-section-heading"><div><span class="report-kicker">' + escape(kicker) + '</span><h2>' + escape(title) + '</h2></div>' + status + '</div>',
      '  <div class="report-section-body">', body, "</div>",
      "</section>"
    ].join("");
  }

  function metric(label, value, detail) {
    return '<article class="report-metric"><span class="report-metric-label">' + escape(label) + '</span><strong class="report-metric-value">' + escape(value) + '</strong><span class="report-metric-detail">' + escape(detail) + '</span></article>';
  }

  function definitionList(entries) {
    return '<dl class="report-definition-list">' + entries.filter(Boolean).map(function (entry) {
      const value = entry[1] == null || entry[1] === "" ? "-" : entry[1];
      return '<div><dt>' + escape(entry[0]) + '</dt><dd' + (entry[2] ? ' class="is-mono"' : "") + '>' + escape(value) + '</dd></div>';
    }).join("") + "</dl>";
  }

  function parameterList(parameters) {
    if (!parameters || typeof parameters !== "object") {
      return '<div class="report-empty">No parameter snapshot is available.</div>';
    }
    const entries = Object.keys(parameters).filter(function (key) {
      return parameters[key] !== undefined && parameters[key] !== null && parameters[key] !== "";
    }).map(function (key) {
      return [humanize(key), formatParameter(parameters[key]), isMonoParameter(key)];
    });
    return entries.length ? definitionList(entries) : '<div class="report-empty">No parameter values were set.</div>';
  }

  // K3 column kinds for table(): a header is a plain label, or
  // num(label, unit) for a right-aligned tabular number column, or
  // long(label) for a name that stays on one line, cut with an ellipsis and
  // given its full text as a title (print shows it in full).
  function num(label, unit) {
    return { label: label, num: true, unit: unit || "" };
  }

  function long(label) {
    return { label: label, truncate: true };
  }

  function table(headers, rows) {
    // Wide tables scroll inside their own box on screen instead of widening
    // the page; print styles let them flow at full width.
    const columns = headers.map(function (header) { return typeof header === "string" ? { label: header } : header; });
    // the long-name columns share 60% of the width (names get the most room)
    const longColumns = columns.filter(function (column) { return column.truncate; }).length;
    return '<div class="report-table-scroll"><table class="report-table"><thead><tr>' + columns.map(function (column) {
      return '<th scope="col"' + (column.num ? ' class="num"' : "") + (column.truncate ? ' style="width:' + Math.round(60 / longColumns) + '%"' : "") + '>' + escape(column.label) + (column.unit ? ' <span class="unit">' + escape(column.unit) + "</span>" : "") + '</th>';
    }).join("") + '</tr></thead><tbody>' + rows.map(function (row) {
      return '<tr>' + row.map(function (cell, index) {
        const column = columns[index] || {};
        if (column.truncate) {
          // cells are escaped markup: their text, tags removed, is a safe title
          return '<td class="cell-truncate" title="' + String(cell).replace(/<[^>]*>/g, "") + '">' + cell + '</td>';
        }
        return '<td' + (column.num ? ' class="num"' : "") + '>' + cell + '</td>';
      }).join("") + '</tr>';
    }).join("") + '</tbody></table></div>';
  }

  function visualBlock(svg, note) {
    return '<div class="report-visual">' + svg + (note ? '<p class="report-note-inline">' + escape(note) + '</p>' : "") + '</div>';
  }

  // ---- printable figures: light like every SVG export (K4), with axis
  // ticks and titles (K5) and a colour bar (K1) drawn into the SVG itself.
  // Without ui-kit.js (the node checks) the axes keep their two end ticks
  // and the colour bar is left out.
  const FIGURE_INK = "#132c47";
  const FIGURE_MUTED = "#5b6c80";
  const FIGURE_LINE = "#c2d3db";
  const FIGURE_GRID = "#e6eef2";
  const FIGURE_FONT = "ui-sans-serif, system-ui, -apple-system, &quot;Segoe UI&quot;, sans-serif";
  const MAP_LEFT_PAD = 26; // room left of the plot for the rotated y-axis title

  function uiKit() {
    return typeof window !== "undefined" && window.RNAxRayUiKit ? window.RNAxRayUiKit : null;
  }

  // nice ticks (K5) with both ends
  function axisTicks(min, max, target) {
    const kit = uiKit();
    return kit ? kit.niceTicks(min, max, target || 5) : (min === max ? [min] : [min, max]);
  }

  function axisText(x, y, anchor, text, extra) {
    return '<text x="' + fixed(x) + '" y="' + fixed(y) + '" text-anchor="' + anchor + '" font-family="' + FIGURE_FONT + '" font-size="10" fill="' + FIGURE_MUTED + '"' + (extra || "") + ">" + escape(text) + "</text>";
  }

  // x axis below a plot: ticks over [lo, hi], position(v) -> x
  function xAxisSvg(plot, lo, hi, position, title) {
    const bottom = plot.top + plot.height;
    const ticks = axisTicks(lo, hi, 6).map(function (value, index, all) {
      const x = position(value);
      const anchor = all.length > 1 && index === 0 ? "start" : all.length > 1 && index === all.length - 1 ? "end" : "middle";
      return '<line x1="' + fixed(x) + '" x2="' + fixed(x) + '" y1="' + bottom + '" y2="' + (bottom + 4) + '" stroke="' + FIGURE_MUTED + '" stroke-width="0.75"></line>' + axisText(x, bottom + 15, anchor, formatNumber(value));
    }).join("");
    return ticks + '<text x="' + fixed(plot.left + plot.width / 2) + '" y="' + (bottom + 32) + '" text-anchor="middle" font-family="' + FIGURE_FONT + '" font-size="11" font-weight="600" fill="' + FIGURE_INK + '">' + escape(title) + "</text>";
  }

  // y axis left of a plot; grid lines across it when asked
  function yAxisSvg(plot, lo, hi, position, title, grid) {
    const ticks = axisTicks(lo, hi, 5).map(function (value) {
      const y = position(value);
      return (grid ? '<line x1="' + plot.left + '" x2="' + (plot.left + plot.width) + '" y1="' + fixed(y) + '" y2="' + fixed(y) + '" stroke="' + FIGURE_GRID + '" stroke-width="0.75"></line>' : "") +
        '<line x1="' + (plot.left - 4) + '" x2="' + plot.left + '" y1="' + fixed(y) + '" y2="' + fixed(y) + '" stroke="' + FIGURE_MUTED + '" stroke-width="0.75"></line>' + axisText(plot.left - 6, y + 3.5, "end", formatNumber(value));
    }).join("");
    const middle = plot.top + plot.height / 2;
    const x = plot.titleX;
    return ticks + '<text x="' + x + '" y="' + fixed(middle) + '" transform="rotate(-90 ' + x + " " + fixed(middle) + ')" text-anchor="middle" font-family="' + FIGURE_FONT + '" font-size="11" font-weight="600" fill="' + FIGURE_INK + '">' + escape(title) + "</text>";
  }

  // K1 colour bar under the plot, right-aligned
  function legendSvg(plot, opts) {
    const kit = uiKit();
    if (!kit) {
      return "";
    }
    const width = 240;
    return kit.legend.svg(Object.assign({ orientation: "horizontal", x: plot.left + plot.width - width, y: plot.top + plot.height + 44, width: width, height: 10, ink: FIGURE_INK, muted: FIGURE_MUTED }, opts));
  }

  function positionTitle(rna) {
    return (rna || "RNA") + " position (nt)";
  }

  // a binned map's frame: background, axes over inclusive nt coordinates
  // (y grows downwards, as on the page), and the colour bar
  function mapFrame(plot, extent, titles, legend) {
    const xSpan = Math.max(1, extent.xEnd - extent.xStart);
    const ySpan = Math.max(1, extent.yEnd - extent.yStart);
    return xAxisSvg(plot, extent.xStart, extent.xEnd - 1, function (v) { return plot.left + (v - extent.xStart) / xSpan * plot.width; }, titles[0]) +
      yAxisSvg(plot, extent.yStart, extent.yEnd - 1, function (v) { return plot.top + (v - extent.yStart) / ySpan * plot.height; }, titles[1], false) +
      legendSvg(plot, legend);
  }

  const MAP_HEIGHT = 430;

  function mapSvgOpen(className, label, title) {
    return '<svg class="report-svg ' + className + '" viewBox="' + (-MAP_LEFT_PAD) + " 0 " + (760 + MAP_LEFT_PAD) + " " + MAP_HEIGHT + '" role="img" aria-label="' + escape(label) + '">' +
      "<title>" + escape(title) + "</title>" +
      '<rect x="' + (-MAP_LEFT_PAD) + '" y="0" width="' + (760 + MAP_LEFT_PAD) + '" height="' + MAP_HEIGHT + '" fill="#ffffff"></rect>';
  }

  // the Contact Map page's colour-bar title: "Record count (linear)",
  // "Cluster support (log1p)"
  function contactMeasureTitle(contact) {
    return (contact && contact.measure === "support" ? "Cluster support" : "Record count") + (contact && contact.scale === "log" ? " (log1p)" : " (linear)");
  }

  // colour bar of the contact map over display values (linear or log1p);
  // the top tick reads "≥ cap" when the cap clips the largest value
  function contactLegend(cap, contact, displayMax) {
    const top = Math.max(cap, 1e-9);
    const clipped = number(displayMax) > cap;
    return {
      kind: "sequential",
      colorAt: brandHeatColor,
      min: 0,
      max: top,
      ticks: axisTicks(0, top, 4),
      format: function (value) { return (clipped && value === top ? "\u2265 " : "") + formatNumber(value); },
      title: contactMeasureTitle(contact)
    };
  }

  function renderHeatmap(matrix, contact) {
    const cells = Array.isArray(matrix.cells) ? matrix.cells : [];
    if (!cells.length) {
      return '<div class="report-empty">No contact-map cells were generated.</div>';
    }
    const shown = boundedItems(cells, MAX_VISUAL_CELLS, function (left, right) {
      return visualCellValue(right, contact) - visualCellValue(left, contact) || sortCells(left, right);
    });
    const binSize = Math.max(1, number(matrix.binSize, 1));
    const xStart = extrema(cells, "x", "min");
    const yStart = extrema(cells, "y", "min");
    const xEnd = extrema(cells, "x", "max") + binSize;
    const yEnd = extrema(cells, "y", "max") + binSize;
    const plotLeft = 58;
    const plotTop = 28;
    const plotWidth = 650;
    const plotHeight = 300;
    const cap = Math.max(0, number(matrix.cap, number(matrix.max, 0)));
    const selected = contact && contact.selection;
    const rects = shown.map(function (cell) {
      const x = plotLeft + ((number(cell.x) - xStart) / Math.max(1, xEnd - xStart)) * plotWidth;
      const y = plotTop + ((number(cell.y) - yStart) / Math.max(1, yEnd - yStart)) * plotHeight;
      const width = Math.max(1, binSize / Math.max(1, xEnd - xStart) * plotWidth + 0.5);
      const height = Math.max(1, binSize / Math.max(1, yEnd - yStart) * plotHeight + 0.5);
      const ratio = cap ? Math.max(0, Math.min(1, visualCellValue(cell, contact) / cap)) : 0;
      const isSelected = selected && number(selected.x) === number(cell.x) && number(selected.y) === number(cell.y);
      return '<rect x="' + fixed(x) + '" y="' + fixed(y) + '" width="' + fixed(width) + '" height="' + fixed(height) + '" fill="' + brandHeatColor(ratio) + '"' + (isSelected ? ' stroke="#132c47" stroke-width="2"' : "") + '><title>' + escape(range(cell.x, number(cell.x) + binSize - 1) + " x " + range(cell.y, number(cell.y) + binSize - 1) + "; value " + formatNumber(cell.value)) + '</title></rect>';
    }).join("");
    const plot = { left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight, titleX: -12 };
    return [
      mapSvgOpen("report-heatmap-svg", "Printable contact map", "Contact map for " + (contact && contact.rnaX || "RNA X") + " and " + (contact && contact.rnaY || "RNA Y")),
      '<rect x="' + plotLeft + '" y="' + plotTop + '" width="' + plotWidth + '" height="' + plotHeight + '" fill="#f7fafb" stroke="' + FIGURE_LINE + '"></rect>',
      rects,
      mapFrame(plot, { xStart: xStart, xEnd: xEnd, yStart: yStart, yEnd: yEnd }, [positionTitle(contact && contact.rnaX), positionTitle(contact && contact.rnaY)], contactLegend(cap, contact, matrix.max)),
      '</svg>'
    ].join("");
  }

  function renderCoverageSvg(items, maximum, color, selectedStart, rna, measure) {
    const bins = downsample(items || [], MAX_VISUAL_BINS);
    if (!bins.length) {
      return '<div class="report-empty">No coverage bins were generated.</div>';
    }
    const plot = { left: 68, top: 14, width: 672, height: 150, titleX: 14 };
    const maxValue = Math.max(0, number(maximum, maxSeriesValue(bins)));
    const barWidth = plot.width / bins.length;
    const first = number(bins[0].start);
    const last = number(bins[bins.length - 1].end);
    const span = Math.max(1, last - first + 1);
    const bars = bins.map(function (bin, index) {
      const value = Math.max(0, number(bin.value));
      const height = maxValue ? value / maxValue * plot.height : 0;
      const selected = selectedStart != null && number(selectedStart) >= number(bin.start) && number(selectedStart) <= number(bin.end);
      return '<rect x="' + fixed(plot.left + index * barWidth) + '" y="' + fixed(plot.top + plot.height - height) + '" width="' + fixed(Math.max(1, barWidth - 0.5)) + '" height="' + fixed(height) + '" fill="' + (selected ? "#6a4ff2" : color) + '"><title>' + escape(range(bin.start, bin.end) + "; value " + formatNumber(value)) + '</title></rect>';
    }).join("");
    return [
      '<svg class="report-svg report-coverage-svg" viewBox="0 0 760 212" role="img" aria-label="Printable coverage profile">',
      '<title>RNA interaction coverage profile</title>',
      '<rect x="0" y="0" width="760" height="212" fill="#ffffff"></rect>',
      maxValue ? yAxisSvg(plot, 0, maxValue, function (v) { return plot.top + plot.height - v / maxValue * plot.height; }, measure || "Coverage", true) : "",
      bars,
      '<line x1="' + plot.left + '" y1="' + (plot.top + plot.height) + '" x2="' + (plot.left + plot.width) + '" y2="' + (plot.top + plot.height) + '" stroke="' + FIGURE_LINE + '"></line>',
      xAxisSvg(plot, first, last, function (v) { return plot.left + (v - first + 0.5) / span * plot.width; }, positionTitle(rna)),
      '</svg>'
    ].join("");
  }

  function renderComparisonMapSvg(result, comparison, mode) {
    const source = mode === "conserved" ? (result.conservedCells || []) : (result.cells || []);
    if (!source.length) {
      return '<div class="report-empty">No bins are available for this comparison view.</div>';
    }
    const shown = boundedItems(source, MAX_VISUAL_CELLS, mode === "conserved" ? sortConservedCells : sortEffectCells);
    const binSize = Math.max(1, number(result.binSize, 1));
    const xStart = extrema(source, "x", "min");
    const yStart = extrema(source, "y", "min");
    const xEnd = extrema(source, "x", "max") + binSize;
    const yEnd = extrema(source, "y", "max") + binSize;
    const plotLeft = 52;
    const plotTop = 24;
    const plotWidth = 650;
    const plotHeight = 300;
    const cap = Math.max(0.25, number(result.effectCap, 1));
    const selected = comparison.selection;
    const rects = shown.map(function (cell) {
      const x = plotLeft + ((number(cell.x) - xStart) / Math.max(1, xEnd - xStart)) * plotWidth;
      const y = plotTop + ((number(cell.y) - yStart) / Math.max(1, yEnd - yStart)) * plotHeight;
      const width = Math.max(1, binSize / Math.max(1, xEnd - xStart) * plotWidth + 0.5);
      const height = Math.max(1, binSize / Math.max(1, yEnd - yStart) * plotHeight + 0.5);
      const ratio = mode === "conserved"
        ? conservedRatio(cell.similarity, result)
        : number(cell.effect) / cap;
      const fill = mode === "conserved" ? conservedColor(ratio) : effectColor(ratio);
      const isSelected = selected && number(selected.x) === number(cell.x) && number(selected.y) === number(cell.y);
      return '<rect x="' + fixed(x) + '" y="' + fixed(y) + '" width="' + fixed(width) + '" height="' + fixed(height) + '" fill="' + fill + '"' + (isSelected ? ' stroke="#132c47" stroke-width="2"' : "") + '><title>' + escape(range(cell.x, number(cell.x) + binSize - 1) + " x " + range(cell.y, number(cell.y) + binSize - 1) + (mode === "conserved" ? "; similarity " + formatNumber(cell.similarity) : "; effect " + formatNumber(cell.effect))) + '</title></rect>';
    }).join("");
    const plot = { left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight, titleX: -12 };
    return [
      mapSvgOpen("report-heatmap-svg", "Printable comparison map", mode === "conserved" ? "Similarity heatmap" : "Mean log2 comparison effect"),
      '<rect x="' + plotLeft + '" y="' + plotTop + '" width="' + plotWidth + '" height="' + plotHeight + '" fill="' + (mode !== "conserved" ? "#f7fafb" : comparison.similarityPanel === "grey" ? SIMILARITY_GREY_PANEL : "#ffffff") + '" stroke="' + FIGURE_LINE + '"></rect>',
      rects,
      mapFrame(plot, { xStart: xStart, xEnd: xEnd, yStart: yStart, yEnd: yEnd }, [positionTitle(comparison.rnaX), positionTitle(comparison.rnaY)],
        mode === "conserved" ? similarityLegend(result, comparison) : effectLegend(cap, comparison)),
      '</svg>'
    ].join("");
  }

  // diverging: negative (teal) = higher in B, positive (violet) = higher in A
  function effectLegend(cap, comparison) {
    return {
      kind: "diverging",
      colorAt: function (t) { return effectColor(t * 2 - 1); },
      min: -cap,
      max: cap,
      ticks: [-cap, -cap / 2, 0, cap / 2, cap],
      title: "Mean log2 effect (" + (comparison.conditionALabel || "A") + " / " + (comparison.conditionBLabel || "B") + ")",
      lowLabel: (comparison.conditionBLabel || "B") + " enriched",
      highLabel: (comparison.conditionALabel || "A") + " enriched"
    };
  }

  // white at the smallest plotted count, forestgreen at the 95% quantile cap
  function similarityLegend(result, comparison) {
    const cap = Math.max(1, number(result && result.similarityCap, 1));
    const floor = Math.min(cap, similarityFloorOf(result));
    const title = "min(" + (comparison.conditionALabel || "A") + ", " + (comparison.conditionBLabel || "B") + ") raw count";
    if (!(cap > floor) || !Number.isFinite(floor)) {
      // a single plotted value: one colour, the midpoint of the ramp
      return { kind: "sequential", colorAt: function () { return conservedColor(0.5); }, min: cap - 0.5, max: cap + 0.5, ticks: [cap], title: title };
    }
    return { kind: "sequential", colorAt: conservedColor, min: floor, max: cap, title: title, highLabel: "95% quantile cap" };
  }

  function parameterSnapshot(name, state, fallback) {
    if (window.RNAxRayUI && typeof window.RNAxRayUI[name] === "function") {
      const result = safeCall(function () { return window.RNAxRayUI[name](state); }, null);
      if (result) {
        return result;
      }
    }
    return { parameters: fallback || {} };
  }

  function sourceHybMetadata(state) {
    const summary = state.summary || {};
    return {
      fileName: summary.fileName || "",
      fileSize: summary.fileSize == null ? null : summary.fileSize,
      sha256: summary.sha256 || null,
      sha256Status: summary.sha256 ? "available" : (summary.sha256Unavailable ? "unavailable" : "pending")
    };
  }

  // state.reference is DatasetInfo.reference from DataProvider.listDatasets().
  function sourceFastaMetadata(state) {
    const fasta = state.reference;
    if (!fasta) {
      return null;
    }
    return {
      fileName: fasta.fileName || "",
      fileSize: fasta.fileSize == null ? null : fasta.fileSize,
      sha256: fasta.sha256 || null,
      sha256Status: fasta.sha256 ? "available" : (fasta.sha256Unavailable ? "unavailable" : "pending"),
      sequenceCount: referenceSequenceCount(fasta),
      mappedRnas: mappedFastaCount(fasta)
    };
  }

  function referenceSequenceCount(reference) {
    if (!reference) {
      return 0;
    }
    if (Number.isFinite(Number(reference.sequenceCount))) {
      return Number(reference.sequenceCount);
    }
    return Array.isArray(reference.sequences) ? reference.sequences.length : 0;
  }

  function comparisonDatasets(comparison) {
    return (comparison && comparison.datasets || []).map(function (dataset) {
      const summary = dataset.summary || {};
      return {
        id: dataset.id || null,
        label: dataset.label || "",
        condition: dataset.condition || null,
        fileName: dataset.fileName || summary.fileName || "",
        fileSize: dataset.fileSize == null ? (summary.fileSize == null ? null : summary.fileSize) : dataset.fileSize,
        sha256: dataset.sha256 || summary.sha256 || null,
        validRecords: number(summary.validRecords),
        supportInteractions: number(summary.supportInteractions)
      };
    });
  }

  function pickStructureSetup(structure) {
    return {
      engine: structure.engine || "viennarna",
      source: structure.source || "",
      rna: structure.rna || "",
      start: structure.start || null,
      end: structure.end || null,
      constraintMode: structure.constraintMode || "none",
      cplfoldEvidence: structure.cplfoldEvidence || null,
      cplfoldAllowPseudoknot: structure.cplfoldAllowPseudoknot !== false
    };
  }

  function findMatrixCell(matrix, selection) {
    if (!matrix || !selection) {
      return null;
    }
    if (matrix.cellMap && matrix.cellMap[selection.x + ":" + selection.y]) {
      return matrix.cellMap[selection.x + ":" + selection.y];
    }
    return (matrix.cells || []).find(function (cell) { return number(cell.x) === number(selection.x) && number(cell.y) === number(selection.y); }) || null;
  }

  function findComparisonCell(result, selection) {
    if (!result || !selection) {
      return null;
    }
    if (typeof result.cellLookup === "function") {
      return result.cellLookup(selection.x, selection.y);
    }
    if (result.cellMap && result.cellMap[selection.x + ":" + selection.y]) {
      return result.cellMap[selection.x + ":" + selection.y];
    }
    return (result.cells || []).find(function (cell) { return number(cell.x) === number(selection.x) && number(cell.y) === number(selection.y); }) || null;
  }

  function downsample(items, maximum) {
    const source = Array.isArray(items) ? items : [];
    if (source.length <= maximum) {
      return source;
    }
    const step = Math.ceil(source.length / maximum);
    const output = [];
    for (let index = 0; index < source.length; index += step) {
      const group = source.slice(index, index + step);
      output.push({
        start: group[0].start,
        end: group[group.length - 1].end,
        value: group.reduce(function (total, item) { return total + number(item.value); }, 0) / group.length
      });
    }
    return output;
  }

  function boundedItems(items, maximum, sorter) {
    const source = Array.isArray(items) ? items : [];
    if (source.length <= maximum * 8) {
      return source.slice().sort(sorter).slice(0, maximum);
    }
    const step = Math.max(1, Math.ceil(source.length / (maximum * 4)));
    const sampled = [];
    for (let index = 0; index < source.length && sampled.length < maximum * 4; index += step) {
      sampled.push(source[index]);
    }
    return sampled.sort(sorter).slice(0, maximum);
  }

  function extrema(items, key, direction) {
    const values = Array.isArray(items) ? items : [];
    if (!values.length) {
      return 0;
    }
    return values.reduce(function (current, item) {
      const value = number(item && item[key]);
      return direction === "max" ? Math.max(current, value) : Math.min(current, value);
    }, direction === "max" ? -Infinity : Infinity);
  }

  function maxSeriesValue(items) {
    return (items || []).reduce(function (maximum, item) { return Math.max(maximum, number(item.value)); }, 0);
  }

  function visualCellValue(cell, contact) {
    const value = number(cell && cell.value);
    return contact && contact.scale === "log" ? Math.log1p(Math.max(0, value)) : value;
  }

  function sortRecords(left, right) {
    return number(right.supportCount) - number(left.supportCount) || number(right.rawReadCount) - number(left.rawReadCount) || String(left.id || "").localeCompare(String(right.id || ""));
  }

  function sortCells(left, right) {
    return number(right.value) - number(left.value) || number(left.x) - number(right.x) || number(left.y) - number(right.y);
  }

  function sortEffectCells(left, right) {
    return Math.abs(number(right.effect)) - Math.abs(number(left.effect)) || number(left.x) - number(right.x) || number(left.y) - number(right.y);
  }

  function sortConservedCells(left, right) {
    return number(right.similarity) - number(left.similarity) || number(left.x) - number(right.x) || number(left.y) - number(right.y);
  }

  // the Contact Map's "Teal–violet sequential" scale in its light (export)
  // form from analysis-ui.js (K4); the older ramp when that is not loaded
  function brandHeatColor(ratio) {
    const value = Math.max(0, Math.min(1, number(ratio)));
    if (typeof window !== "undefined" && window.RNAxRayUI && typeof window.RNAxRayUI.viridis === "function") {
      return window.RNAxRayUI.viridis(value, "light");
    }
    if (value < 0.5) {
      return interpolateColor("#132c47", "#00a09d", value * 2);
    }
    return interpolateColor("#00a09d", "#6a4ff2", (value - 0.5) * 2);
  }

  // similarity_heatmap.R: counts capped at the 95% quantile, then
  // scale_fill_gradient(low = white, high = forestgreen) over the data range,
  // so white is the smallest plotted count (not zero) and forestgreen the cap.
  // A single-valued range maps to the midpoint, like scales::rescale().
  function conservedRatio(similarity, result) {
    const cap = Math.max(1, number(result && result.similarityCap, 1));
    const floor = Math.min(cap, similarityFloorOf(result));
    if (!(cap > floor)) {
      return 0.5;
    }
    return Math.max(0, Math.min(1, (Math.min(number(similarity), cap) - floor) / (cap - floor)));
  }

  function similarityFloorOf(result) {
    const floor = number(result && result.similarityFloor);
    if (floor > 0) {
      return floor;
    }
    return ((result && result.conservedCells) || []).reduce(function (minimum, cell) {
      const value = number(cell.similarity);
      return value > 0 && value < minimum ? value : minimum;
    }, Infinity);
  }

  // scales::pal_seq_gradient interpolates in CIELAB (farver, D65 white).
  function conservedColor(ratio) {
    const from = srgbToLab(hexRgb("#ffffff"));
    const to = srgbToLab(hexRgb("#228b22"));
    const t = Math.max(0, Math.min(1, number(ratio)));
    const rgb = labToSrgb([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t]);
    return "rgb(" + rgb[0] + ", " + rgb[1] + ", " + rgb[2] + ")";
  }

  const LAB_WHITE = [0.95047, 1, 1.08883];

  function srgbToLab(rgb) {
    const linear = rgb.map(function (channel) {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    const xyz = [
      0.4124564 * linear[0] + 0.3575761 * linear[1] + 0.1804375 * linear[2],
      0.2126729 * linear[0] + 0.7151522 * linear[1] + 0.0721750 * linear[2],
      0.0193339 * linear[0] + 0.1191920 * linear[1] + 0.9503041 * linear[2]
    ].map(function (value, index) {
      const t = value / LAB_WHITE[index];
      return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
    });
    return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
  }

  function labToSrgb(lab) {
    const fy = (lab[0] + 16) / 116;
    const xyz = [fy + lab[1] / 500, fy, fy - lab[2] / 200].map(function (value, index) {
      const cube = value * value * value;
      return LAB_WHITE[index] * (cube > 216 / 24389 ? cube : (116 * value - 16) / (24389 / 27));
    });
    return [
      3.2404542 * xyz[0] - 1.5371385 * xyz[1] - 0.4985314 * xyz[2],
      -0.9692660 * xyz[0] + 1.8760108 * xyz[1] + 0.0415560 * xyz[2],
      0.0556434 * xyz[0] - 0.2040259 * xyz[1] + 1.0572252 * xyz[2]
    ].map(function (value) {
      const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
      return Math.max(0, Math.min(255, Math.round(encoded * 255)));
    });
  }

  function effectColor(value) {
    const bounded = Math.max(-1, Math.min(1, number(value)));
    return bounded >= 0
      ? interpolateColor("#f5f8fa", "#6a4ff2", bounded)
      : interpolateColor("#f5f8fa", "#00a09d", Math.abs(bounded));
  }

  function interpolateColor(from, to, ratio) {
    const first = hexRgb(from);
    const second = hexRgb(to);
    const t = Math.max(0, Math.min(1, number(ratio)));
    return "rgb(" + Math.round(first[0] + (second[0] - first[0]) * t) + ", " + Math.round(first[1] + (second[1] - first[1]) * t) + ", " + Math.round(first[2] + (second[2] - first[2]) * t) + ")";
  }

  function hexRgb(value) {
    const hex = String(value || "#000000").replace("#", "");
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  function mappedFastaCount(fasta) {
    return fasta && fasta.mapping ? Object.keys(fasta.mapping).filter(function (key) { return fasta.mapping[key]; }).length : 0;
  }

  function humanize(value) {
    return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function isMonoParameter(key) {
    return /rna|start|end|bin|cap|coordinate|range|hash|reference|mode/i.test(String(key || ""));
  }

  function formatParameter(value) {
    if (value === true) return "Yes";
    if (value === false) return "No";
    if (value && typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value == null || value === "" ? "-" : value);
  }

  function formatNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? numberFormatter.format(parsed) : (fallback == null ? "-" : String(fallback));
  }

  function formatPercent(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return "-";
    return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(parsed);
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "-";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return numberFormatter.format(bytes / Math.pow(1024, index)) + " " + units[index];
  }

  // page display only, in the viewer's local time: "16 Oct 2026, 23:54 (UTC+1)".
  // The result record and every export keep generatedAt / completedAt as ISO.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Local time";
    }
    const pad = function (n) { return String(n).padStart(2, "0"); };
    const offset = -date.getTimezoneOffset();
    const hours = Math.floor(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;
    const zone = "UTC" + (offset === 0 ? "" : (offset > 0 ? "+" : "\u2212") + hours + (minutes ? ":" + pad(minutes) : ""));
    return date.getDate() + " " + MONTHS[date.getMonth()] + " " + date.getFullYear() + ", " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + " (" + zone + ")";
  }

  // a <time> element: readable text, the ISO value in datetime and title
  function timeTag(value) {
    const date = new Date(value);
    const iso = Number.isNaN(date.getTime()) ? "" : date.toISOString();
    return iso ? '<time datetime="' + escape(iso) + '" title="' + escape(iso) + '">' + escape(formatTimestamp(value)) + "</time>" : escape(formatTimestamp(value));
  }

  function range(start, end) {
    if (start == null || end == null || start === "" || end === "") return "-";
    return String(start) + "-" + String(end);
  }

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback == null ? 0 : fallback);
  }

  function fixed(value) {
    return number(value).toFixed(2);
  }

  function truncateText(value, maximum) {
    const text = String(value == null ? "" : value);
    if (text.length <= maximum) return text;
    const head = Math.ceil(maximum * 0.62);
    const tail = Math.max(1, maximum - head - 18);
    return text.slice(0, head) + " ... [truncated] ... " + text.slice(-tail);
  }

  function safeCall(callback, fallback) {
    try {
      return callback();
    } catch (error) {
      return fallback;
    }
  }

  function jsonSafe(value, depth, breadth) {
    if (value === undefined) return null;
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (depth <= 0) return "[truncated]";
    if (Array.isArray(value)) {
      return value.slice(0, breadth).map(function (item) { return jsonSafe(item, depth - 1, breadth); });
    }
    if (typeof value === "object") {
      const output = {};
      Object.keys(value).slice(0, breadth).forEach(function (key) {
        output[key] = jsonSafe(value[key], depth - 1, breadth);
      });
      return output;
    }
    return String(value);
  }

  function escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  window.RNAxRayReport = {
    render: render,
    afterRender: afterRender,
    getData: getData
  };
}());

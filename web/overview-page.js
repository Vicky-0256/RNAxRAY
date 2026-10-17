(function () {
  "use strict";

  const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

  function render(state) {
    const summary = state.summary;
    const validPercentage = summary.validRecords + summary.invalidRecords
      ? summary.validRecords / (summary.validRecords + summary.invalidRecords)
      : 0;
    const dgPercentage = summary.validRecords ? summary.withDg / summary.validRecords : 0;
    const rawReadValue = summary.rawReadCountRecords ? format(summary.rawReadInteractions) : "—";
    const rawReadDescription = summary.rawReadCountRecords
      ? "Recovered from " + format(summary.rawReadCountRecords) + " sequence IDs"
      : "No collapsed-read counts found in sequence IDs";

    return [
      '      <div class="page-heading">',
      "        <div>",
      "          <h1>Overview</h1>",
      '          <p><span class="mono">' + escape(summary.fileName) + "</span> · loaded locally · " + format(summary.validRecords) + " valid records</p>",
      "        </div>",
      '        <div class="inline-actions heading-export"><details class="export-menu"><summary class="button button-secondary">Export</summary><div class="export-menu-list" role="menu"><button class="export-menu-item" type="button" role="menuitem" data-action="download-summary">Summary · JSON</button><button class="export-menu-item" type="button" role="menuitem" data-action="download-rna-counts">RNA counts · CSV</button><button class="export-menu-item" type="button" role="menuitem" data-action="download-rna-pairs">RNA pairs · CSV</button></div></details></div>',
      "      </div>",
      renderReferenceStatus(state),
      '      <section class="metric-grid" aria-label="Dataset summary">',
      renderMetric("HYB records", format(summary.validRecords), "One valid tab-delimited record per row"),
      renderMetric("Source reads", rawReadValue, rawReadDescription),
      renderMetric("Unique RNAs", format(summary.uniqueRNAs), "Distinct RNA names across both arms"),
      renderMetric("RNA pairs", format(summary.uniquePairs), "RNA arm order is normalised for summary"),
      "      </section>",
      summary.ambiguousColumn16Records ? '<section class="notice notice-warning"><strong>Legacy column 16 detected.</strong> ' + format(summary.ambiguousColumn16Records) + ' 16-column rows contain a positive integer in column 16 without a chimera-type column. They are treated as legacy cluster support, following the bundled HYB merge format. If these rows are instead truncated standard 17-column records, add column 17 before analysis.</section>' : "",
      '      <section class="overview-grid">',
      renderTopRnas(summary.rnaCounts),
      renderInteractionTypes(summary),
      renderTopPairs(summary.pairCounts),
      "      </section>",
      '      <section class="data-card">',
      '        <div class="card-title-row"><h2>Data quality</h2><span class="card-kicker">Local validation</span></div>',
      '        <div class="quality-grid">',
      renderQualityStat(percentFormatter.format(validPercentage), "valid data rows"),
      summary.withDg
        ? renderQualityStat(percentFormatter.format(dgPercentage), "include a numeric dG value")
        : renderQualityStat("Not provided", "numeric dG values in this file", "quality-stat--absent"),
      renderQualityStat(format(summary.homodimerRecords), "homodimer-proxy records (overlap ≥ 5)"),
      renderQualityStat(format(summary.invalidRecords), "invalid rows skipped"),
      "        </div>",
      "      </section>"
    ].join("");
  }

  function renderReferenceStatus(state) {
    // state.reference is DatasetInfo.reference from DataProvider.listDatasets().
    const embedded = state.shell === false;
    if (state.reference) {
      const mapped = Object.keys(state.reference.mapping || {}).length;
      return [
        '      <section class="overview-callout overview-callout--compact" aria-label="Reference FASTA status">',
        '        <p class="overview-callout-line"><strong>Reference sequences loaded</strong><span>' + format(state.reference.sequenceCount) + (state.reference.sequenceCount === 1 ? " FASTA sequence · " : " FASTA sequences · ") + format(mapped) + " of " + format(state.summary.rnaNames.length) + " HYB RNA names matched locally.</span></p>",
        embedded ? "" : '        <button class="quiet-button" type="button" data-action="open-files" data-open-section="data-mapping">Review mapping</button>',
        "      </section>"
      ].join("");
    }
    if (embedded) {
      return [
        '      <section class="overview-callout" aria-label="Reference FASTA status">',
        "        <div>",
        "          <h2>Reference sequences are not available</h2>",
        "          <p>Interaction analysis and contact maps are available now. Add a reference to the project to extract reference regions and prepare structure input.</p>",
        "        </div>",
        "      </section>"
      ].join("");
    }

    return [
      '      <section class="overview-callout" aria-label="Reference FASTA status">',
      "        <div>",
      "          <h2>Reference sequences are not loaded</h2>",
      "          <p>Interaction analysis and contact maps are available now. Add a local FASTA to extract reference regions and prepare structure input.</p>",
      "        </div>",
      '        <button class="quiet-button" type="button" data-feature-action="choose-fasta">Add reference FASTA</button>',
      "      </section>"
    ].join("");
  }

  function renderMetric(label, value, description) {
    return [
      '        <article class="metric-card">',
      '          <span class="metric-label">' + escape(label) + "</span>",
      '          <strong class="metric-value">' + escape(value) + "</strong>",
      '          <span class="metric-description">' + escape(description) + "</span>",
      "        </article>"
    ].join("");
  }

  function renderTopRnas(items) {
    const maximum = items.length ? items[0].support : 1;
    return [
      '        <section class="data-card overview-top-rnas">',
      '          <div class="card-title-row"><h2>Top interacting RNAs</h2><span class="card-kicker">Cluster support, per arm</span></div>',
      '          <p class="card-note">Each record counts once per arm on the RNA, so a record with both arms on one RNA counts twice.</p>',
      '          <div class="bar-list">',
      items.slice(0, 5).map(function (item) {
        return [
          '            <div class="bar-row">',
          '              <span class="bar-name" title="' + attribute(item.name) + '">' + escape(item.name) + "</span>",
          '              <span class="bar-track"><span class="bar-fill" style="width:' + Math.max(3, (item.support / maximum) * 100) + '%"></span></span>',
          '              <span class="bar-value">' + format(item.support) + "</span>",
          "            </div>"
        ].join("");
      }).join(""),
      "          </div>",
      "        </section>"
    ].join("");
  }

  function renderInteractionTypes(summary) {
    const types = summary.chimeraTypes || [];
    const total = summary.validRecords || 1;
    return [
      '        <section class="data-card overview-types">',
      '          <div class="card-title-row"><h2>Chimera types</h2><span class="card-kicker">Column 17 / inferred</span></div>',
      '          <div class="type-split">',
      types.slice(0, 4).map(function (item) { return renderType(item.name, item.records / total, item.records); }).join(""),
      "          </div>",
      '          <button class="quiet-button overview-types-link" type="button" data-action="navigate" data-page="interactions">View interactions</button>',
      "        </section>"
    ].join("");
  }

  function renderType(label, fraction, count) {
    return [
      '            <div class="type-item">',
      "              <strong>" + escape(label) + "</strong>",
      '              <span class="type-value">' + format(count) + " records · " + percentFormatter.format(fraction) + "</span>",
      '              <div class="type-meter"><span style="width:' + (fraction * 100) + '%"></span></div>',
      "            </div>"
    ].join("");
  }

  function renderTopPairs(items) {
    return [
      '      <section class="data-card overview-top-pairs">',
      '        <div class="card-title-row"><h2>Top RNA pairs</h2><span class="card-kicker">Normalised pairs</span></div>',
      '        <div class="data-table-wrap">',
      '          <table class="data-table overview-pairs-table">',
      '            <thead class="nowrap"><tr><th>RNA 1</th><th>RNA 2</th><th class="num">HYB records</th><th class="num">Source reads</th><th class="num">Cluster support</th></tr></thead>',
      "            <tbody>",
      items.slice(0, 6).map(function (item) {
        return '<tr><td class="cell-truncate" title="' + attribute(item.rnaOne) + '">' + escape(item.rnaOne) + '</td><td class="cell-truncate" title="' + attribute(item.rnaTwo) + '">' + escape(item.rnaTwo) + '</td><td class="num">' + format(item.records) + '</td><td class="num">' + (item.rawReadCountRecords ? format(item.rawReads) : "—") + '</td><td class="num">' + format(item.support) + "</td></tr>";
      }).join(""),
      "            </tbody>",
      "          </table>",
      "        </div>",
      "      </section>"
    ].join("");
  }

  function renderQualityStat(value, label, modifier) {
    return '<div class="quality-stat' + (modifier ? " " + modifier : "") + '"><strong>' + escape(value) + "</strong><span>" + escape(label) + "</span></div>";
  }

  function renderValidation(state) {
    const summary = state.summary;
    const notices = [];
    if (summary.invalidRecords > 0) {
      notices.push('<p class="notice notice-warning">' + format(summary.invalidRecords) + " invalid rows were skipped. The file remains usable with its valid records.</p>");
    } else {
      notices.push('<p class="notice">No invalid data rows were found during local validation.</p>');
    }
    if (summary.ambiguousColumn16Records) {
      notices.push('<p class="notice notice-warning">' + format(summary.ambiguousColumn16Records) + ' rows use a positive-integer legacy column 16. They are interpreted as legacy cluster counts; the input has no column 17 type for those rows.</p>');
    }
    if (summary.errorSampleTruncated) {
      notices.push('<p class="notice notice-warning">The downloadable error sample contains the first ' + format(summary.errorSampleCount) + ' invalid rows; ' + format(summary.omittedErrorCount) + ' additional invalid-row details were omitted to keep browser memory bounded. The total invalid count above remains complete.</p>');
    }

    return [
      '      <div class="page-heading">',
      "        <div>",
      "          <h1>Validation</h1>",
      "          <p>Format checks completed in this browser while the file was read.</p>",
      "        </div>",
      "      </div>",
      '      <section class="validation-card">',
      "        <h2>" + escape(summary.fileName) + " is ready</h2>",
      '        <p class="validation-intro">The parser expects at least 15 tab-separated fields, RNA names in both arms, and positive one-based RNA start/end coordinates. Standard HYB 17-column annotations are retained explicitly.</p>',
      '        <div class="validation-summary">',
      renderValidationItem(summary.validRecords, "Valid records"),
      renderValidationItem(summary.skippedCommentLines, "Skipped comment lines"),
      renderValidationItem(summary.skippedBlankLines, "Skipped blank lines"),
      renderValidationItem(summary.invalidRecords, "Invalid records"),
      renderValidationItem(summary.canonicalRecords || 0, "Standard 17-column records"),
      renderValidationItem(summary.overlapScoreRecords || 0, "Records with overlap score"),
      renderValidationItem(summary.rawReadCountRecords || 0, "IDs with collapsed-read count"),
      renderValidationItem(summary.homodimerRecords || 0, "Homodimer-proxy records"),
      "        </div>",
      notices.join(""),
      '        <div class="validation-actions">',
      '          <button class="button" type="button" data-action="navigate" data-page="overview">Continue with ' + format(summary.validRecords) + " valid records</button>",
      summary.invalidRecords ? '<button class="button button-secondary" type="button" data-action="download-validation">' + (summary.errorSampleTruncated ? "Download error sample" : "Download validation report") + '</button>' : "",
      "        </div>",
      "      </section>"
    ].join("");
  }

  function renderValidationItem(value, label) {
    return '<div class="validation-item"><strong>' + format(value) + "</strong><span>" + escape(label) + "</span></div>";
  }

  function renderMethods() {
    return [
      '      <div class="page-heading"><div><h1>Methods</h1><p>Local analysis rules, stated explicitly for reproducibility.</p></div></div>',
      '      <section class="data-card">',
      '        <div class="card-title-row"><h2>HYB file parsing</h2><span class="card-kicker">v2 semantics</span></div>',
      '        <p class="notice">Lines beginning with <span class="mono">#</span> and blank lines are skipped. A valid record has at least 15 tab-separated columns, a name for each RNA arm, and positive one-based RNA start/end coordinates in columns 7–8 and 13–14.</p>',
      '        <div class="card-title-row"><h2>Counts</h2></div>',
      '        <p class="notice">Record count equals the number of valid rows. For collapsed HYB IDs, the second underscore-delimited ID field is retained separately as the source raw-read count, matching the bundled <span class="mono">collapse_hyb_2.sh</span> and <span class="mono">hybrid_stats_2</span> convention. It never changes Contact Map or Viewpoint row weighting. In the standard 17-column layout, column 16 is an <strong>Overlap Score</strong>, not a count. Cluster support is read only from legacy <span class="mono">count_total=…</span> metadata or an untyped legacy positive-integer column 16.</p>',
      '        <div class="card-title-row"><h2>Chimera type</h2></div>',
      '        <p class="notice">Column 17 is retained as the HYB chimera type. For legacy 15/16-column records without that field, the website deterministically derives the legacy Type_1–Type_13 or Intermolecular label from the two RNA arms, matching the bundled <span class="mono">hyb_chim_types.awk</span> rule.</p>',
      '        <div class="card-title-row"><h2>Homodimer proxy</h2></div>',
      '        <p class="notice">A record is marked as the original HYB homodimer proxy only when both arms map to the same RNA and the standard overlap score in column 16 is at least 5. This flag is independent of the column 17 chimera type and is available as a filter.</p>',
      '        <div class="card-title-row"><h2>Pair normalisation</h2></div>',
      '        <p class="notice">Overview pair summaries order RNA names alphabetically, so A–B and B–A are counted together. The Contact Map preserves a selected X/Y axis and swaps reversed input arms onto that axis.</p>',
      '        <div class="card-title-row"><h2>Contact-map binning</h2></div>',
      '        <p class="notice">For every HYB record, all bins covered by arm 1 are paired with all bins covered by arm 2. The chosen count measure is added to each bin pair. Log1p only changes display colour scaling.</p>',
      '        <div class="card-title-row"><h2>Viewpoint and comparison</h2></div>',
      '        <p class="notice">Viewpoint plots interaction-arm coverage at one-nucleotide resolution or as binned mean coverage. Compare displays descriptive library-size-normalised effects and conserved bins, and exports the legacy HYB raw count and two-column names tables plus separate extended metadata. An official WebR 0.6 asset passed a recorded manual static-origin smoke, but it is not shipped or rerun in deployment CI; production DESeq2 remains gated until the pinned 1.52.0 WASM closure loads from static assets and passes native-R numerical parity.</p>',
      '        <div class="card-title-row"><h2>RNA structure</h2></div>',
      '        <p class="notice">The structure workspace provides reference-region input for HYB-guided modes and supports HYB record or pasted sequence input in compatible sequence-only and ViennaRNA modes. Plain and manual modes run pinned ViennaRNA MFE WebAssembly. HYB-guided ViennaRNA reproduces the RNAcofold evidence, compatible F-constraint, randomised-fold and COMRADES-scoring chain. A separate pure-Python CPLfold/Pyodide engine predicts and visualises nested and pseudoknotted candidates from a sequence or a bonus matrix built from all eligible HYB rows in one selected reference region; the browser folds 75 nt before the capacity test, up to 500 nt after it (the test gives a conservative, session-specific limit). UNAFold remains an optional external CLI compatibility path.</p>',
      "      </section>"
    ].join("");
  }

  function renderFileFormat() {
    const rows = [
      ["1", "Sequence / read ID; collapsed HYB IDs store source-read count in the second underscore-delimited field"],
      ["2", "Hybrid sequence"],
      ["3", "dG"],
      ["4", "Arm 1 RNA"],
      ["5–6", "Arm 1 read start / end"],
      ["7–8", "Arm 1 RNA start / end"],
      ["9", "Arm 1 e-value"],
      ["10", "Arm 2 RNA"],
      ["11–12", "Arm 2 read start / end"],
      ["13–14", "Arm 2 RNA start / end"],
      ["15", "Arm 2 e-value"],
      ["16", "Overlap Score in standard 17-column HYB; legacy cluster count/metadata in older 16-column files"],
      ["17", "Type of Chimera in standard HYB output"]
    ];

    const desktop = desktopKit();
    const rawReads = desktop ? desktop.cta("raw-reads") : "";

    return [
      '      <div class="page-heading"><div><h1>File format</h1><p>The local validator accepts the HYB record layout described below.</p></div></div>',
      rawReads ? '      <section class="data-card format-raw-reads"><div class="card-title-row"><h2>From raw reads to .hyb</h2></div><p class="notice">' + rawReads + "</p></section>" : "",
      '      <section class="data-card">',
      '        <div class="card-title-row"><h2>Expected tab-delimited fields</h2><span class="card-kicker">1-indexed</span></div>',
      '        <div class="data-table-wrap"><table class="data-table"><thead><tr><th>Column</th><th>Field</th></tr></thead><tbody>',
      rows.map(function (row) { return "<tr><td>" + row[0] + "</td><td>" + row[1] + "</td></tr>"; }).join(""),
      "        </tbody></table></div>",
      "      </section>"
    ].join("");
  }

  function renderPrivacy() {
    const desktop = desktopKit();
    return [
      '      <div class="page-heading"><div><h1>Privacy</h1><p>What happens to data opened in RNAxRay Web.</p></div></div>',
      '      <section class="data-card">',
      '        <div class="card-title-row"><h2>Local by design</h2><span class="card-kicker">No backend</span></div>',
      '        <div class="notice">RNAxRay Web is a static GitHub Pages application. The selected HYB file is passed from the file picker to a Web Worker inside the same browser tab. No upload, analytics call, cloud save, or persistent browser database is used.</div>',
      '        <div class="card-title-row"><h2>Optional public lookups</h2><span class="card-kicker">Off by default</span></div>',
      '        <div class="notice">Related research on the RNA Structure page is the only feature that contacts another service. It stays off until you turn it on. Each lookup sends only the public identifier you confirm, plus its species to EBI Search, by GET to www.ebi.ac.uk (EBI Search and Europe PMC). HYB files, sequences, structures and file names are never sent, and results stay in this tab.</div>',
      '        <div class="card-title-row"><h2>Session lifetime</h2></div>',
      '        <div class="notice">Parsed results exist only in tab memory. Choose “Start over” in the top bar to clear this analysis and return to file upload.</div>',
      desktop ? '        <div class="card-title-row"><h2>' + escape(desktop.name) + '</h2></div><div class="notice privacy-desktop">' + escape(desktop.name) + " also processes your data only on your computer: it works offline, and reads, .hyb files and results stay on disk.</div>" : "",
      "      </section>"
    ].join("");
  }

  // K9 (RNAxRayUiKit.desktop), or null inside RNAxRay Desktop and in tests that
  // load this page without ui-kit.js
  function desktopKit() {
    const desktop = window.RNAxRayUiKit && window.RNAxRayUiKit.desktop;
    return desktop && !desktop.isInsideDesktop() ? desktop : null;
  }

  function format(value) {
    return numberFormatter.format(value || 0);
  }

  function escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function attribute(value) {
    return escape(value).replace(/`/g, "&#096;");
  }

  window.RNAxRayOverview = {
    render: render,
    renderValidation: renderValidation,
    renderMethods: renderMethods,
    renderFileFormat: renderFileFormat,
    renderPrivacy: renderPrivacy
  };
}());

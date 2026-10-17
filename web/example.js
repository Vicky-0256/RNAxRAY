/*
 * The included "Try example": ZIKV virion RNA, African lineage (ZAFR) vs
 * Asian lineage (ZASI = ZILM, French Polynesian isolate), two replicates
 * each.  Every file lives in assets/examples/zikv-virion/ and is fetched
 * only when the example is used.
 *
 * The four .hyb files are 1-in-10 subsets of the full replicate files
 * (every 10th record, awk 'NR % 10 == 1'), gzip-compressed; parser.worker.js
 * decompresses them in the browser.  Each lineage's records are on its own
 * genome (ZIKV_African_KX377335-1_virusRNA, ZIKV_FrenchPolynesian_
 * KJ776791-2_virusRNA); the comparison uses each dataset's own genome, by
 * bin position, as bin/rnaxray_compare does.  The structures are CPLfold
 * pseudoknot-free genome folds; NC_035889 gives the gene track.
 *
 * app.js reads this manifest; scripts/verify-example.cjs checks that every
 * file exists and runs the example end to end.
 */
(function (root) {
  "use strict";

  const directory = "assets/examples/zikv-virion/";

  const example = {
    directory: directory,
    title: "ZIKV virion: ZAFR vs ZASI",
    labels: { A: "ZAFR", B: "ZASI" },
    comparison: { binSize: "10", similarityMinimum: "10" },
    // the primary dataset (Overview, Interactions, Contact Map, ...) is also
    // the first replicate of condition A on the Compare page
    primary: { file: "ZAFR_REP1_1in10.hyb.gz", label: "ZAFR_REP1", condition: "A", records: 22416 },
    reference: { file: "ZAFR.fasta" },
    replicates: [
      { file: "ZAFR_REP2_1in10.hyb.gz", label: "ZAFR_REP2", condition: "A", records: 34939 },
      { file: "ZILM_REP2_1in10.hyb.gz", label: "ZILM_REP2", condition: "B", records: 57636 },
      { file: "ZILM_REP3_1in10.hyb.gz", label: "ZILM_REP3", condition: "B", records: 18466 }
    ],
    arcMap: { a: "ZAFR.dbn", b: "ZILM.dbn", annotation: "NC_035889.gb" },
    // shown on the landing page, in this order
    downloads: [
      { file: "ZAFR_REP1_1in10.hyb.gz", kind: "HYB", note: "ZAFR replicate 1 · primary" },
      { file: "ZAFR_REP2_1in10.hyb.gz", kind: "HYB", note: "ZAFR replicate 2" },
      { file: "ZILM_REP2_1in10.hyb.gz", kind: "HYB", note: "ZASI (ZILM) replicate 2" },
      { file: "ZILM_REP3_1in10.hyb.gz", kind: "HYB", note: "ZASI (ZILM) replicate 3" },
      { file: "ZAFR.fasta", kind: "FASTA", note: "African genome KX377335.1" },
      { file: "ZILM.fasta", kind: "FASTA", note: "French Polynesian genome KJ776791.2" },
      { file: "ZAFR.dbn", kind: "DBN", note: "CPLfold genome fold, ZAFR" },
      { file: "ZILM.dbn", kind: "DBN", note: "CPLfold genome fold, ZASI" },
      { file: "NC_035889.gb", kind: "GB", note: "GenBank gene track" }
    ]
  };

  example.url = function (file) {
    return ((root && root.RNAXRAY_ASSET_BASE) || "./") + directory + file;
  };

  // every file the example references
  example.files = function () {
    const names = [example.primary.file, example.reference.file, example.arcMap.a, example.arcMap.b, example.arcMap.annotation]
      .concat(example.replicates.map(function (item) { return item.file; }))
      .concat(example.downloads.map(function (item) { return item.file; }));
    return names.filter(function (name, index) { return names.indexOf(name) === index; });
  };

  if (typeof module === "object" && module.exports) {
    module.exports = example;
  }
  if (root) {
    root.RNAxRayExample = example;
  }
}(typeof window !== "undefined" ? window : null));

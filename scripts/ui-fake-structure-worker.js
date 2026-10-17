// Test double for web/structure.worker.js and web/cplfold.worker.mjs, used only by
// scripts/ui-screenshots.py (page "structure-result") to screenshot the RNA Structure result
// layout without the ViennaRNA WebAssembly / Pyodide builds. Nussinov fold, made-up energies.
// Never served by the app itself.
function fold(seq) {
  const n = seq.length, ok = { AU: 1, UA: 1, GC: 1.5, CG: 1.5, GU: .5, UG: .5 };
  const N = Array.from({ length: n }, () => new Float64Array(n));
  for (let len = 5; len <= n; len++) for (let i = 0; i + len - 1 < n; i++) {
    const j = i + len - 1;
    let best = Math.max(N[i + 1][j], N[i][j - 1]);
    const p = ok[seq[i] + seq[j]];
    if (p && j - i > 3) best = Math.max(best, N[i + 1][j - 1] + p);
    for (let k = i + 1; k < j; k++) best = Math.max(best, N[i][k] + N[k + 1][j]);
    N[i][j] = best;
  }
  const pairs = [], stack = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (i >= j) continue;
    if (N[i][j] === N[i + 1][j]) { stack.push([i + 1, j]); continue; }
    if (N[i][j] === N[i][j - 1]) { stack.push([i, j - 1]); continue; }
    const p = ok[seq[i] + seq[j]];
    if (p && j - i > 3 && N[i][j] === N[i + 1][j - 1] + p) { pairs.push([i, j]); stack.push([i + 1, j - 1]); continue; }
    for (let k = i + 1; k < j; k++) if (N[i][j] === N[i][k] + N[k + 1][j]) { stack.push([i, k], [k + 1, j]); break; }
  }
  const db = Array(n).fill(".");
  pairs.forEach(([i, j]) => { db[i] = "("; db[j] = ")"; });
  return {
    dotBracket: db.join(""),
    pairs: pairs.sort((a, b) => a[0] - b[0]).map(([i, j]) => ({ left: i + 1, right: j + 1, leftBase: seq[i], rightBase: seq[j], type: seq[i] + "–" + seq[j], layer: "primary", evidenceSupport: (i * 7 % 10) / 10 })),
    unpaired: n - 2 * pairs.length
  };
}
self.onmessage = function (event) {
  const m = event.data || {};
  const seq = String(m.sequence || "").toUpperCase().replace(/T/g, "U");
  if (m.type === "cplfold-capacity" || m.type === "capacity") {
    self.postMessage({ type: "capacity-complete", sample: { length: 75, foldElapsedMs: 1200 }, elapsedMs: 3800, runtimeLoadMs: 2600 });
    return;
  }
  setTimeout(function () {
    const f = fold(seq);
    const energy = -Math.round(f.pairs.length * 1.6 * 10) / 10;
    if (m.type === "cplfold") {
      const cand = [0, 1, 2].map(function (k) {
        return { index: k, dotBracket: f.dotBracket, type: "phase1", topology: "nested", energy: energy + k * 1.3, effectiveEnergy: energy + k * 1.3, phase1Energy: energy + k * 1.3, score: -100 + k, crossingPairs: 0, unpaired: f.unpaired, pairs: f.pairs };
      });
      self.postMessage({ type: "complete", result: {
        algorithm: "CPLfold (fake)", engine: "CPLfold", allowPseudoknot: !!m.allowPseudoknot, dotBracket: f.dotBracket, energy: energy, effectiveEnergy: energy,
        elapsedMs: 3900, runtimeLoadMs: 2600, foldElapsedMs: 1300, unpaired: f.unpaired, structureType: "phase1", topology: "nested", crossingPairs: 0,
        constraintMode: "none", constraintCount: 0, constraints: [], evidenceMode: m.evidenceMode, selectedCandidate: 0,
        parameters: { beamSize: m.beamSize, maxPhase1: m.maxPhase1, energyDelta: m.energyDelta, energyModel: m.energyModel, alpha: m.alpha, beta: m.beta, allowPseudoknot: !!m.allowPseudoknot },
        evidence: { source: m.evidenceMode === "hyb-blocks" ? "hyb-block-intervals" : "none", inputRecords: 8, uniqueBlocks: 6, nonzeroBonusCells: 40, nonzeroUpperTriangleCells: 20, maximumBonus: 1.2,
          bonusEntries: f.pairs.slice(0, 20).map(function (p) { return { one: p.left, two: p.right, value: p.evidenceSupport + .1 }; }) },
        maximumNucleotideSupport: 1, nucleotideSupport: Array(seq.length).fill(0).map(function (_, i) { return (i * 13 % 10) / 10; }),
        pairs: f.pairs, candidates: cand
      } });
      return;
    }
    self.postMessage({ type: "complete", result: { algorithm: "ViennaRNA MFE (fake)", engine: "ViennaRNA", dotBracket: f.dotBracket, energy: energy, pairs: f.pairs, unpaired: f.unpaired, elapsedMs: 140, constraintMode: "none", constraintCount: 0, constraints: [] } });
  }, 300);
};

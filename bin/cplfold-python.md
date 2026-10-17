# CPLfold Python integration

The `feature/cplfold-python` branch includes a source snapshot of CPLfold at
`third_party/cplfold`. The snapshot was imported from
`https://github.com/Vicky-0256/CPLfold.git`, branch
`feature/pseudoknot-free-mode`, commit
`24bab521e0bcf2cff71f4567363aac1d5f5c97d5`.

## Runtime boundary

CPLfold's folding and pseudoknot-energy path is Python source and does not call
a HotKnots executable, shared library, wrapper, or external process. It is not
a standard-library-only implementation: the complete predictor requires NumPy
and Numba, and Numba uses LLVM JIT compilation. ViennaRNA is optional. SciPy
and pysam are needed only by the optional PARIS BAM extraction script.

The `feature/cplfold-python` branch adds the reproducible local CLI layer. The
separate `feature/cplfold-web` branch packages the same pure-Python sources,
parameters, Pyodide 0.29.4, and NumPy 2.2.5 as a static GitHub Pages artifact.
Pyodide does not provide Numba, so the browser bridge uses identity `njit`
decorators. The local CLI remains the supported route for longer workloads.
The browser measures a conservative session recommendation above a 75-nt
baseline, with a 500-nt hard browser ceiling. No server-side execution layer
is required.

For HYB-guided browser runs, each eligible row contributes its two prepared
reference intervals once to the original CPLfold/IRIS-style Gaussian,
symmetric outer-product and `log1p` bonus transform. The browser does not use
HYB overlap score or collapsed source-read count as matrix weights.

## Install and run

Use CPython 3.11 for the maintained CI environment. The same pinned dependency
set was also verified locally on CPython 3.8.10:

```bash
python3.11 -m venv .venv-cplfold
. .venv-cplfold/bin/activate
python -m pip install -r requirements/cplfold-core.txt
bin/cplfold --sequence GGCGCGGCACCGUCCGCGGAACAAACGG \
  --beam 20 --max-phase1 3 --max-phase2 2
```

RNAxRay Web can download the prepared sequence as a single-record FASTA. In
HYB-guided CPLfold mode it also downloads the sparse upper-triangle bonus
matrix used by the browser, as `cplfold-bonus-matrix.tsv`. The local CLI
reconstructs the symmetric dense NumPy matrix before folding:

```bash
bin/cplfold --sequence-file cplfold-input.fasta \
  --bonus-matrix-file cplfold-bonus-matrix.tsv \
  --beam 20 --delta 5 --max-phase1 3 --max-phase2 1 \
  --model DP09 --alpha 0.5 --beta 0
```

`--sequence-file` also accepts a plain sequence text file. FASTA headers and
line wrapping are removed, and multiple FASTA records are rejected. The bonus
matrix uses 1-based prepared-sequence coordinates, includes a declared
`sequence_length`, and is symmetric when loaded. Sequence-only CPLfold mode
does not need the matrix file.

To keep only pseudoknot-free secondary structures, add `--no-pseudoknot`. This
runs Phase 1 and skips the constrained Phase 2; in that mode `--beta` is
ignored.

The browser can export the matrix for local handoff independently of whether
the pure-Python browser fold fits its 500-nt prediction ceiling. Matrix export
is capped at 5,000 nt because the HYB transform is inherently quadratic; the
local predictor has its separate machine-dependent guard below.

The RNAxRay wrapper starts CPLfold as an isolated Python process, assigns a
private mode-`0700` Numba cache below the user's cache directory, and rejects
inputs longer than 1,000 nt by default. The parser allocates multiple
quadratic arrays, so this guard prevents accidental large-memory jobs. Set a
deliberate override only after sizing the machine:

```bash
RNAXRAY_CPLFOLD_MAX_NT=1500 bin/cplfold --sequence-file cplfold-input.fasta
```

Run the full vendored regression suite and a real-Numba smoke test with:

```bash
python scripts/verify-cplfold-python.py
```

The current `--max-phase2` option is retained for upstream CLI compatibility,
but upstream commit `24bab52` does not use it to enumerate multiple Phase 2
structures. Do not interpret that option as an effective search limit yet.

## Updating the snapshot

The code was imported as a squashed Git subtree. `UPSTREAM.md` records the
small RNAxRay-local changes made after import. After reviewing a new upstream
commit and its license state, update it with `git subtree pull` rather than by
copying the source directory. This avoids importing the upstream `.git`,
`__pycache__`, and machine-specific Numba cache files.

## Distribution status

Read `third_party/cplfold/THIRD_PARTY_NOTICES.md` before publishing this branch.
CPLfold's own code is GPL-2.0-or-later (`third_party/cplfold/LICENSE`, granted
by its author), as are the HotKnots-derived energy evaluator and parameters.
The LinearFold-derived parser keeps LinearFold's terms, which add conditions
beyond the GPL, so the combination does not yet have one resolved license; that
question concerns the LinearFold copyright holders.

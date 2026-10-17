# Vendored snapshot

- Repository: `https://github.com/Vicky-0256/CPLfold.git`
- Upstream branch: `feature/pseudoknot-free-mode`
- Upstream commit: `24bab521e0bcf2cff71f4567363aac1d5f5c97d5`
- Import method: squashed Git subtree
- Destination: `third_party/cplfold`

The snapshot contains Python sources and data tracked by upstream. It excludes
the upstream Git database, Python bytecode, Numba caches, shared libraries, and
other ignored local artifacts.

## RNAxRay-local changes after import

- `CPLfold.py` treats a completed Phase-1-only prediction as CLI success.
- `CPLfold.py` supports explicit pseudoknot-free prediction through
  `--no-pseudoknot` and `allow_pseudoknot=False`.
- `tests/test_cli_exit_status.py` locks that exit-status behavior.
- `CPLfold.py` accepts RNAxRay's sparse bonus-matrix TSV export through
  `--bonus-matrix-file` and applies it with `--alpha`.
- `CPLfold_parser.py` compiles the outside pass with Numba. The new
  `_outside_kernel` and its `_outside_*` scoring helpers are verbatim copies
  of `BeamCKYParserHyper._outside` and its methods, with `self` dropped and
  the list tables swapped for the existing int32 arrays; fastmath is off.
  Output is byte-identical to the original (kept as `_outside_python`;
  `CPLFOLD_PYTHON_OUTSIDE=1` selects it). 600 nt drops from 270 s to about
  1 s. This change is not upstream yet.
- `LICENSE` is the author's GPL-2.0-or-later grant for CPLfold's own code
  (2026-10-17), not in upstream commit `24bab52`. `LICENSES/`,
  `THIRD_PARTY_NOTICES.md`, and this file record provenance and the
  distribution constraints of the LinearFold- and HotKnots-derived parts.

Upstream commit `24bab52` does not identify an exact LinearFold source revision
or the exact HotKnots 2.0 archive/checksum used to create the Python-derived
files. That missing derivation metadata must be resolved before treating this
snapshot as independently reproducible provenance.

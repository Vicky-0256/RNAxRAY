# Third-party notices and distribution status

This directory is a vendored snapshot of CPLfold with two upstream code
lineages besides CPLfold's own. CPLfold's own code is licensed GPL-2.0-or-later
(`LICENSE`); the combination with the LinearFold-derived parser does **not** yet
have one resolved license (see "Compatibility review required"). Do not relabel
it as MIT or Apache licensed; the MIT license in the RNAxRay repository's
top-level `LICENSE` covers RNAxRay's own code, not this directory.

## CPLfold-authored code

`CPLfold.py` identifies Ke Wang as its author. Ke Wang, the author and rights
holder, licensed CPLfold's original orchestration code, tests, examples and
documentation under the GNU General Public License, version 2 or (at your
option) any later version, on 2026-10-17: see `LICENSE`, with the license text
in `LICENSES/GPL-2.0-or-later.txt`. The upstream repository
(https://github.com/Vicky-0256/CPLfold) should carry the same `LICENSE`.

## LinearFold-derived parser

`CPLfold_parser.py` and related scoring tables state that they are based on
LinearFold. LinearFold is credited to Liang Huang, He Zhang, Dezhong Deng, Kai
Zhao, Kaibo Liu, David Hendrix, and David Mathews. Its upstream terms permit
research, educational, and commercial use and modification, require author
credit, restrict redistribution fees to media costs, and request contact with
the corresponding author before inclusion in a commercial product. The exact
upstream text is preserved in `LICENSES/LinearFold-LICENSE.txt`.

Source: https://github.com/LinearFold/LinearFold

## HotKnots-derived energy evaluator and parameters

`Utils/hotknots_energy.py` is a Python port/refactoring of the energy-calculation
portion of HotKnots 2.0. Files in `Utils/energy_params` are derived from the
HotKnots 2.0 parameter distribution. The HotKnots README credits Jihong Ren and
Baharak Rastegari, with modifications by Cristina Pop and Mirela Andronescu.
Relevant upstream source headers specify GNU GPL version 2 or later. A copy of
GPL version 2 is preserved in `LICENSES/GPL-2.0-or-later.txt`.

Source: https://www.cs.ubc.ca/labs/algorithms/Software/HotKnots/

The snapshot does not contain or execute the native HotKnots program. Runtime
independence does not remove the source and parameter provenance or its license
obligations.

## Compatibility review required

The GPL prohibits adding further downstream restrictions, while the LinearFold
terms include conditions beyond the GPL text. Because CPLfold imports the
LinearFold-derived parser and HotKnots-derived evaluator into one Python
program, publishing the combined snapshot may require an explicit compatible
license or exception from the LinearFold copyright holders. CPLfold's own code
and the HotKnots-derived files are both GPL-2.0-or-later, so this question
concerns the LinearFold terms only. Recording both texts is necessary
attribution, but it is not itself a compatibility determination or legal
advice.

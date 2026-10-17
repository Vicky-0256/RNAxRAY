# Third-party notices and distribution status

This directory is an experimental vendored snapshot. It has two material
upstream code lineages and does **not** currently claim one resolved license for
their combined distribution. Do not relabel it, or the RNAxRay repository, as MIT
or Apache licensed.

## CPLfold-authored code

`CPLfold.py` identifies Ke Wang as its author. The imported upstream snapshot
contains no `LICENSE`, `COPYING`, or other explicit grant covering CPLfold's
original orchestration code, tests, examples, and documentation. This vendoring
does not infer or create such a grant; permission from the relevant rights
holder is still required for public redistribution.

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
license or exception from the relevant copyright holders. Recording both texts
is necessary attribution, but it is not itself a compatibility determination
or legal advice.

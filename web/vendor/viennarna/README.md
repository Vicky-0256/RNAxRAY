# ViennaRNA WebAssembly binding

`rnaxray_vienna_fold.c` is a deliberately small C boundary around RNAlib's global
MFE, hard-base-pair, and two-strand RNAcofold interfaces. The browser worker
calls only this boundary; it does not run a shell or send a sequence to a
service. RNAcofold results supply the per-HYB-row evidence used by the local
COMRADES constraint workflow.

The deploy workflow invokes `scripts/build-vienna-wasm.sh`. It downloads the
official ViennaRNA 2.7.2 source release, verifies its SHA-256, builds RNAlib
with the pinned Emscripten toolchain, and places these generated deploy assets
alongside this file:

- `vienna-rna.js`
- `vienna-rna.wasm`
- `build-manifest.json`
- `COPYING-ViennaRNA.txt`

The generated files are intentionally not committed. A local preview without a
build has no folding engine and must display the clear missing-engine state;
it must never substitute a different algorithm while claiming ViennaRNA MFE.
For a local build, the script requires `curl`, `tar`, `pkg-config`, Node,
an active Emscripten SDK, and either `sha256sum` (GNU coreutils) or the
macOS `shasum -a 256` command. If generated assets are absent, the structure
page reports the missing `vienna-rna.js` URL instead of substituting another
folding algorithm.

## Attribution and redistribution

The build uses the [ViennaRNA Package](https://github.com/ViennaRNA/ViennaRNA),
version 2.7.2. Its bundled `COPYING` notice permits research, educational, and
commercial use and modification subject to its redistribution and attribution
conditions. The deployment artifact includes that notice. Please retain it and
credit the ViennaRNA authors and the Institute for Theoretical Chemistry at the
University of Vienna when redistributing this web build.

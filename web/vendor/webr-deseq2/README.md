# DESeq2 / WebR feasibility gate

This directory records the feasibility evidence collected on 2026-09-04. It intentionally does not contain a deployable WebR or DESeq2 runtime yet.

A manual browser smoke used the official WebR v0.6.0 release tarball (its URL and SHA-256 are locked in `runtime-smoke-result.json`). It started base R 4.6.0 from an ordinary local static HTTP origin with the `PostMessage` channel, evaluated a numerical expression, and confirmed that the stable package repository did not advertise DESeq2. The exact harness is in `scripts/webr-smoke/`.

This is feasibility evidence, not a production release check: the WebR runtime is not vendored into `web/`, and the deployment workflow does not rerun that browser smoke. A separate dependency-resolution probe used the R-universe **development** snapshot for DESeq2 1.53.2. It resolved 42 of 43 runtime packages and missed `locfit`. Its package versions and source-index hashes are captured in `dependency-probe-1.53.2.json`. That probe must not be represented as validation of the pinned release target, DESeq2 1.52.0 / Bioconductor 3.23.

The production gate is therefore:

1. Pin WebR 0.6.0, R 4.6.0, Bioconductor 3.23, and DESeq2 1.52.0.
2. Resolve and build the complete **1.52.0** dependency closure as WebAssembly packages with locked source URLs and SHA-256 hashes. The development probe suggests that `locfit` needs work, but the release closure must be checked independently.
3. Package that closure as a static WebR virtual-filesystem library instead of fetching packages at page runtime.
4. Run the same fixture through native R and WebR and compare log2 fold change, p-value, adjusted p-value, missing-value behaviour, and row order.
5. Add a deployment-CI browser smoke for the vendored runtime and change `decision` in `feasibility.json` to `ready` only after every release check passes.

Until then, the Compare page remains descriptive. For the existing local RNAxRay R entry point it exports `rnaxray-web.table.txt` and the required two-column, headerless `rnaxray-web_names.table`; run `DESeq_run.R rnaxray-web.table.txt rnaxray-web_names.table 2`. Extended headered metadata is a separate audit/custom-adapter export. No backend is required for the eventual browser runtime.

To reproduce the recorded base-runtime smoke, download the locked release asset, verify its SHA-256, extract it as `scripts/webr-smoke/webr-0.6.0/`, serve `scripts/webr-smoke/` over ordinary HTTP, and open `index.html` in a browser. The result is exposed as `window.__spikeResult`. Because this reproduction fetches a 40 MB external test asset and needs a real browser, it is deliberately separate from the offline website and current deployment gate.

Primary references:

- <https://github.com/r-wasm/webr/releases/tag/v0.6.0>
- <https://docs.r-wasm.org/webr/latest/serving.html>
- <https://bioconductor.org/packages/release/bioc/html/DESeq2.html>
- <https://github.com/r-wasm/rwasm/issues/56>

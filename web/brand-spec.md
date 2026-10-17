# RNAxRay Web — brand notes

Name, logo, palette and voice shared with RNAxRay Desktop:
`../docs/brand-guidelines.md`. This file adds what is specific to the web app.

## Current asset state

- **Product:** RNAxRay Web, a browser-local workspace for HYB RNA interaction files.
- **Logo:** \`assets/rnaxray-wordmark.svg\` is the light-theme RNAxRay wordmark; \`assets/rnaxray-wordmark-dark.svg\` is used automatically for the dark theme; \`assets/favicon.svg\` is the tab icon. Sources and placement: \`../docs/brand-guidelines.md\`.
- **External network assets:** none at runtime. The deployed artifact self-hosts pinned ViennaRNA, Pyodide, NumPy, and CPLfold files; it deliberately loads no remote images, fonts, scripts, analytics, or CDN resources after deployment.

## Design system

- **Narrative role:** a scientific analysis workspace, with a calm file-opening entry point rather than a marketing landing page.
- **Primary viewport:** desktop research workflows at laptop distance; tablet and phone layouts preserve loading and summary reading.
- **Visual temperature:** restrained, precise, and trustworthy.
- **Capacity:** dense analysis controls after a file is loaded; generous whitespace before loading.
- **Palette:** Teal \`#00A09D\`, Violet \`#6A4FF2\`, Navy \`#132C47\`; light canvas \`#F3F7F8\`, white surface, teal-soft surfaces, violet-soft analysis accents, and Navy text. Dark mode uses Navy surfaces with bright Teal and Violet controls.
- **Typography:** locally available system sans for interface copy; locally available monospace for sequence, coordinates, and data values.
- **Spacing:** 8 px base unit, with primary layout gaps at 8/16/24/32 px.
- **Radius:** 8 px content surfaces; 6 px controls; compact status pills.
- **Elevation:** hairline borders and a tight low-contrast shadow level inside the workspace. The landing page alone may use a faint dot lattice, a slow teal/violet aura and a teal→violet rule on the file panel.
- **Motion:** \`motion.css\` and \`motion.js\`. Entrances play only when the scene changes (first landing visit, landing panel stage, workspace entry, page change); re-renders within a scene paint the final state. Landing intro ≈1.5 s, workspace page change ≈0.5 s, hover/press feedback 80–260 ms. The landing hero is an *illustrative* arc diagram (labelled as such, generated, not user data). Theme switches use a circular View Transition from the pressed control. Everything is disabled under \`prefers-reduced-motion\` or the Tweaks panel's **Reduce motion** setting, which persists locally.
- **Interaction:** \`interaction.js\` / \`interaction.css\` act only through the app's own controls. ⌘K / Ctrl+K or \`/\` opens a command palette (pages, this page's visible actions, general commands, fuzzy match). \`g\` then a letter jumps to a page (o, i, c, v, r, p, s, e) and reveals the letters in the sidebar; \`[\` / \`]\` step through analysis pages. Analysis canvases show a crosshair and a pointer-following readout of the same text as the status line or native title. Dialogs take focus, trap Tab, close on Escape, and return focus to their opener.

## Current implementation scope

- Local HYB loading, streamed worker parsing, explicit standard-17-column / legacy-cluster semantics, chimera-type and homodimer-proxy filtering, virtualised record browsing, and local CSV/HYB/JSON exports. Standard column 16 is the overlap score, column 17 is chimera type, and collapsed source-read counts are recovered separately from the second underscore-delimited ID field without being reused as map weights.
- Contact maps use the existing HYB fixed-bin accumulation rule in one large interactive canvas with region selection and resettable zoom. Data-table, TSV, SVG, and PNG exports run locally.
- Viewpoint provides per-nucleotide interaction-arm coverage (or larger-bin mean coverage), can switch between selected coordinates and the full mapped reference range, and can pass an interval to Region Explorer.
- Region Explorer, FASTA parsing, explainable exact-name matching, manual mapping, sequence extraction, and FASTA export run locally.
- Compare accepts multiple local HYB files, supports two assigned conditions, and visualises descriptive library-size-normalised log2 effects plus bins conserved across datasets. It exports legacy-HYB-compatible raw counts and a two-column names table, plus separate extended metadata, but does not make statistical-significance claims until the pinned WebR package image passes its release gate.
- The RNA Structure workspace runs pinned ViennaRNA 2.7.2 MFE and RNAcofold functions in a dedicated Web Worker. CPLfold is the default engine and starts in pseudoknot-free mode; ViennaRNA remains available for nested MFE and evidence-guided workflows. Its expert **Manual hard base pairs** mode accepts one 1-based `i-j` pair per line, validates the pairs before calculation, enforces them in ViennaRNA, and labels them in the result and exports.
- **COMRADES(ViennaRNA)** reproduces the browser-suitable post-HYB ViennaRNA path: per-row cofolding, base-pair-frequency aggregation, touching-stem ranking, greedy compatibility fitting, seeded randomised constraint orders, COMRADES scoring, and evidence-coloured arcs. It does not claim general pseudoknot prediction.
- **CPLfold** is a separate pure-Python/Pyodide engine for nested and pseudoknotted candidates. Its HYB-guided mode visualises the IRIS-style interval-block bonus matrix and uses distinct arc colours for phase-1 and crossing phase-2 pairs. Candidate selection changes every structure result and export consistently. Because Numba JIT is unavailable, the browser measures a representative local run and derives a conservative session-specific recommendation above a 75-nt baseline, with a 500-nt hard safety ceiling.
- GitHub Pages deployment uses a static artifact workflow; no back-end, analytics, or runtime CDN is required. Third-party scientific runtimes are pinned and self-hosted in the artifact.
- FASTQ/SAM alignment and `.hyb` construction remain in the local CLI. UNAFold remains an optional external CLI compatibility route. A manual static-origin smoke was recorded for the official WebR 0.6.0 asset, but the runtime is not shipped or rerun in deployment CI; in-browser DESeq2 remains disabled until the pinned 1.52.0 dependency image loads from static assets and passes native-R numerical parity.

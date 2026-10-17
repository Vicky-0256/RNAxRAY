# RNAxRay shared web/desktop protocol

RNAxRay Web and RNAxRay Desktop are separate products. They share this protocol so
that a result produced by one can be inspected or imported by the other. They
do not share a runtime, process, browser capacity measurement, or release
artifact.

## Versioning

The current protocol is `1.0`. The protocol version is independent of the
application version. Readers must accept the same major version and may
migrate a newer minor version when the fields they need are still present.
Unknown payload fields must be preserved when re-saving a project or result.

The normative schemas are:

- [`project.schema.json`](project.schema.json): portable desktop project and
  run provenance;
- [`task.schema.json`](task.schema.json): task request/lifecycle record;
- [`result.schema.json`](result.schema.json): result envelope;
- [`capabilities.schema.json`](capabilities.schema.json): runtime capability
  snapshot.

## Common rules

1. IDs are stable within a project and are safe for filenames.
2. Timestamps are UTC ISO-8601 strings.
3. Paths in projects, task outputs, and artifacts are relative to the project
   root. Absolute paths and `..` traversal are invalid.
4. The web runtime uses `execution: browser`; the desktop runtime uses
   `native`, `wsl`, or `hybrid` as appropriate.
5. Every result includes provenance. Contact-map results must record
   `rules.bin_size: 10` and `rules.colour_cap: "95"` so the old RNAxRay display
   semantics remain reproducible.

## Boundary between products

Web tasks may be executed in Workers or WebAssembly and may include a browser
capacity profile for CPLfold. Desktop CPLfold tasks use the bundled native
Python/NumPy runtime and advertise `cplfoldNative`; they must not require the
browser capacity probe. A desktop result can still be opened by the web app
because the result payload and provenance are independent of the execution
environment.

The schemas intentionally leave `payload` and task `parameters` extensible.
Each result kind should document its payload fields before adding a required
field. This allows the desktop application to expose additional batch,
mapping, and project-management features without changing the web contract.

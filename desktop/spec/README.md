# RNAxRay Desktop project format

The project format is a directory ending in `.rnaxrayproj` with `project.json` at
its root. A project may be zipped as a single `.rnaxrayproject` file for sharing;
the directory layout and manifest stay the same after extraction.

The normative manifest is [`project.schema.json`](project.schema.json). The
small [`example.rnaxrayproj`](example.rnaxrayproj) fixture is intentionally portable
and contains no user data. It shows the minimum manifest fields, one completed
run, relative logs, and a runtime snapshot.

## Layout

```text
sample.rnaxrayproj/
├── project.json
├── inputs/                  # imported source files
├── runs/<run-id>/           # parameters, status, logs, outputs
├── exports/                 # user-selected exports
└── reports/                 # generated HTML/PDF reports
```

Only paths relative to the project root are stored in the manifest. An opener
must reject absolute paths, `..` path segments, NUL bytes, duplicate paths, and
files that are not contained by the project root. The Rust implementation
should apply the same checks while extracting a `.rnaxrayproject` archive (Zip
Slip protection).

`inputs[*].sha256` and `artifacts[*].sha256` are hashes of the files as stored
inside the project. A zero hash is suitable only for a documentation fixture;
real projects must store the actual 64-character SHA-256 digest. A run keeps
the input IDs, structured parameters, output paths, engine, runtime capability
IDs, and exit status so that results can be reproduced or diagnosed later.

## Versioning and migration

`schema_version` uses `major.minor`. Readers must accept the same major
version and migrate older minor versions in memory before saving. A future
major version should be opened read-only with a clear message. Application
versions belong under `application.version` and do not change the manifest
compatibility contract.

### Schema 2.0: references and samples

2.0 adds `references[]` and `samples[]` (one reads file per sample, with
condition, replicate, reference, `gene_id`, settings, outputs and per-stage
status `stages.{map,hyb,index}`). Opening a 1.x project adds empty arrays and
keeps `inputs[]`; the upgrade is written by the next manifest mutation.

Raw files are *linked* by default: the record keeps the absolute path, size,
mtime and `quick_hash` = sha256(decimal size + `\n` + first 1 MiB + last
1 MiB). `sha256` stays `null` until the `hash_inputs` operation computes it.
*Copied* files live under `inputs/` and use project-relative paths. Linked
files are never required to open a project; `check_inputs` reports each one as
`ok`, `missing` or `changed`, and lists in `no_reference` the samples whose
reads cannot be mapped because they have no reference (`.hyb` samples need
none); either makes `all_ok` false. Sample outputs are written to
`samples/<sample_id>/`.

## Safe writer checklist

1. Write a complete manifest to a temporary file and atomically replace
   `project.json`.
2. Write outputs below `runs/`, `exports/`, or `reports/` using validated
   relative paths.
3. Recompute file hashes after the write and update the corresponding entry.
4. Keep UI state small and serializable; do not store absolute local paths.

The runtime detector in `../runtime` emits a snapshot that can be copied into
the manifest's `runtime` field. It is diagnostic metadata and is not used as a
trust boundary: every task runner must still validate its own command and
paths.

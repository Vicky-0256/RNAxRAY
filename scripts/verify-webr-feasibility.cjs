"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repository = path.resolve(__dirname, "..");
const evidenceDirectory = path.join(repository, "web", "vendor", "webr-deseq2");
const manifest = readJson(path.join(evidenceDirectory, "feasibility.json"));
const runtime = readJson(path.join(evidenceDirectory, "runtime-smoke-result.json"));
const probe = readJson(path.join(evidenceDirectory, "dependency-probe-1.53.2.json"));
const harnessPath = path.join(repository, runtime.harness);

assert.equal(manifest.target.hosting, "GitHub Pages");
assert.equal(manifest.target.webR, "0.6.0");
assert.equal(manifest.target.r, "4.6.0");
assert.equal(manifest.target.bioconductor, "3.23");
assert.equal(manifest.target.deseq2, "1.52.0");
assert.equal(manifest.target.channel, "PostMessage");

assert.equal(manifest.observations.baseRuntimeSmoke.status, "recorded-manual-pass");
assert.equal(manifest.observations.baseRuntimeSmoke.deploymentCiRerunsSmoke, false);
assert.equal(manifest.observations.baseRuntimeSmoke.runtimeVendoredInSite, false);
assert.equal(runtime.evidenceLevel, "recorded-manual-browser-smoke");
assert.equal(runtime.deploymentCiRerunsSmoke, false);
assert.equal(runtime.runtimeVendoredInSite, false);
assert.equal(runtime.result.ready, true);
assert.equal(runtime.result.channel, "PostMessage");
assert.match(runtime.result.rVersion, /^R version 4\.6\.0 /);
assert.ok(Math.abs(runtime.result.baseComputation - 0.9997262831771446) < 1e-15);
assert.equal(runtime.result.stableRepositoryContainsDESeq2, false);
assert.equal(runtime.result.error, "");
assert.equal(sha256(harnessPath), runtime.harnessSha256,
  "recorded browser result must identify the exact reproducible smoke harness");

const harness = fs.readFileSync(harnessPath, "utf8");
assert.match(harness, /ChannelType\.PostMessage/);
assert.match(harness, /R\.version\.string/);
assert.match(harness, /sum\(dpois\(0:12, lambda = 4\)\)/);
assert.match(harness, /available\.packages/);

assert.equal(manifest.observations.stableRepository.containsDESeq2, false);
assert.equal(probe.probe.deseq2, "1.53.2");
assert.equal(probe.probe.track, "R-universe development snapshot");
assert.equal(probe.probe.applicableToPinnedReleaseTarget, false);
assert.notEqual(probe.probe.deseq2, manifest.target.deseq2,
  "development dependency probe must never be represented as the pinned release target");
assert.equal(probe.closure.length, probe.requiredPackages);
assert.equal(new Set(probe.closure.map(packageName)).size, probe.requiredPackages);
assert.deepEqual(probe.missingPackages, ["locfit"]);
assert.equal(probe.resolvedPackages, probe.requiredPackages - probe.missingPackages.length);
assert.ok(probe.closure.includes("locfit=-@MISSING"));
assert.equal(manifest.observations.exploratoryDependencyProbe.applicableToPinnedReleaseTarget, false);
assert.equal(manifest.observations.exploratoryDependencyProbe.deseq2, probe.probe.deseq2);
assert.equal(manifest.observations.exploratoryDependencyProbe.resolvedPackages, probe.resolvedPackages);
assert.equal(manifest.observations.exploratoryDependencyProbe.requiredPackages, probe.requiredPackages);
assert.deepEqual(manifest.observations.exploratoryDependencyProbe.missingPackages, probe.missingPackages);

assert.equal(manifest.releaseChecks.pinnedTargetDependencyClosure, "not-run");
assert.equal(manifest.releaseChecks.pinnedTargetLibraryLoad, "not-run");
assert.equal(manifest.releaseChecks.nativeRNumericalParity, "not-run");
assert.equal(manifest.decision, "blocked");
assert.match(manifest.reason, /1\.53\.2 development probe.*not evidence for the pinned target/i);
assert.match(manifest.fallback, /two-column headerless RNAxRay names table/i);
assert.equal(manifest.checks, undefined,
  "the gate must not turn recorded observations into self-attested release checks");

const accidentallyDeployedRuntime = walk(evidenceDirectory).filter(function (file) {
  return ["webr.mjs", "webr-worker.js", "R.js", "R.wasm"].includes(path.basename(file));
});
assert.deepEqual(accidentallyDeployedRuntime, [],
  "the manifest says the WebR runtime is not vendored, but runtime assets were found");

process.stdout.write("webr-deseq2-feasibility-gate: evidence consistent; pinned 1.52.0 release remains blocked\n");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function packageName(entry) {
  return entry.split("=")[0];
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(function (entry) {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

#!/usr/bin/env python3
"""Compare a P6 acceptance project (desktop/app acceptance_test.go) with reproduce_zikv.

    python3 desktop/scripts/compare-acceptance.py <accept dir> <reproduce_zikv dir> [--out report.json]

For every sample the app's .hyb and contact.txt are compared with
reproduce_zikv/results_combined as multisets of lines (the app runs Bowtie2
with --reorder, so line order differs by design; RAWDATA_APP_PLAN.md).
For every comparison the significant cells and the merged interactions are
compared with the legacy rnaxray_compare output, and the whole-genome folds with
reproduce_zikv/analysis/cplfold/<strain>.dbn.  Prints a table and writes JSON.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys
from collections import Counter
from typing import Dict, Iterable, Optional, Set, Tuple

COMPARE_DIRS = {
    "AFR vs BRA": "compare_virion_AFR_vs_BRA",
    "AFR vs ILM": "compare_virion_AFR_vs_ILM",
    "AFR vs SIN": "compare_virion_AFR_vs_SIN",
    "SIN vs BRA": "compare_virion_SIN_vs_BRA",
    "ILM vs BRA": "compare_virion_ILM_vs_BRA",
    "BRA_human vs BRA_insect": "compare_BRA_human_vs_insect",
}
FOLDS = {"AFR": "ZAFR", "ILM": "ZILM"}


def line_digest(path: str) -> Tuple[int, Counter]:
    """Line count and a multiset of 8-byte line hashes (memory-light)."""
    counts: Counter = Counter()
    n = 0
    with open(path, "rb") as handle:
        for line in handle:
            line = line.rstrip(b"\r\n")
            if not line:
                continue
            counts[hashlib.blake2b(line, digest_size=8).digest()] += 1
            n += 1
    return n, counts


def multiset_report(app: str, legacy: str) -> Dict[str, object]:
    n_app, a = line_digest(app)
    n_leg, b = line_digest(legacy)
    only_app = sum((a - b).values())
    only_leg = sum((b - a).values())
    return {"lines_app": n_app, "lines_legacy": n_leg, "only_app": only_app, "only_legacy": only_leg,
            "identical_as_multiset": only_app == 0 and only_leg == 0}


def legacy_significant(directory: str) -> Set[str]:
    path = glob.glob(os.path.join(directory, "DESeq_*_significant.txx"))[0]
    out = set()
    with open(path) as handle:
        handle.readline()
        for line in handle:
            out.add(line.split("\t", 1)[0])
    return out


def legacy_interactions(directory: str, sign: str) -> Set[Tuple[str, str]]:
    found = glob.glob(os.path.join(directory, "*_100range_%s_enrichment.txt" % sign))
    if not found:
        return set()
    out = set()
    with open(found[0]) as handle:
        for line in handle:
            parts = line.split()
            if len(parts) >= 2 and parts[0].isdigit() and not (parts[0] == "0" and parts[1] == "0"):
                out.add((parts[0], parts[1]))
    return out


def app_significant(directory: str) -> Set[str]:
    out = set()
    with open(os.path.join(directory, "significant.tsv")) as handle:
        handle.readline()
        for line in handle:
            parts = line.split("\t", 2)
            out.add(parts[0] + "_" + parts[1])
    return out


def app_interactions(directory: str, direction: str) -> Set[Tuple[str, str]]:
    out = set()
    with open(os.path.join(directory, "interactions.tsv")) as handle:
        handle.readline()
        for line in handle:
            parts = line.split("\t")
            if parts[0] == direction:
                out.add((parts[1], parts[2]))
    return out


def overlap(a: Iterable, b: Iterable) -> Dict[str, int]:
    a, b = set(a), set(b)
    return {"app": len(a), "legacy": len(b), "shared": len(a & b)}


def read_dbn(path: str) -> str:
    lines = [line.strip() for line in open(path) if line.strip()]
    return lines[2] if len(lines) >= 3 else ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("accept_dir")
    parser.add_argument("reproduce_dir")
    parser.add_argument("--out")
    args = parser.parse_args()
    meta = json.load(open(os.path.join(args.accept_dir, "acceptance.json")))
    project = meta["project"]
    manifest = json.load(open(os.path.join(project, "project.json")))
    samples = {s["name"]: s for s in manifest["samples"]}
    legacy = os.path.join(args.reproduce_dir, "results_combined")
    report: Dict[str, object] = {"samples": {}, "comparisons": {}, "structures": {}}

    print("== samples (.hyb and contact.txt as line multisets)")
    for name, sample in sorted(samples.items()):
        out = sample.get("outputs") or {}
        entry: Dict[str, object] = {}
        hyb = os.path.join(project, out.get("hyb") or "")
        if out.get("hyb") and os.path.exists(os.path.join(legacy, name + ".hyb")):
            entry["hyb"] = multiset_report(hyb, os.path.join(legacy, name + ".hyb"))
        contact = out.get("contact")
        legacy_contact = glob.glob(os.path.join(legacy, name + ".*.contact.txt"))
        if contact and legacy_contact:
            entry["contact"] = multiset_report(os.path.join(project, contact), legacy_contact[0])
        report["samples"][name] = entry
        h, c = entry.get("hyb", {}), entry.get("contact", {})
        print("%-10s hyb %9s / %-9s %-5s contact %8s / %-8s %s" % (
            name, h.get("lines_app"), h.get("lines_legacy"), h.get("identical_as_multiset"),
            c.get("lines_app"), c.get("lines_legacy"), c.get("identical_as_multiset")))

    print("== comparisons (significant cells, merged interactions up / down)")
    for label, cid in meta["comparisons"].items():
        directory = os.path.join(args.reproduce_dir, COMPARE_DIRS[label])
        mine = os.path.join(project, "comparisons", cid)
        entry = {"significant": overlap(app_significant(mine), legacy_significant(directory)),
                 "up": overlap(app_interactions(mine, "up"), legacy_interactions(directory, "pos")),
                 "down": overlap(app_interactions(mine, "down"), legacy_interactions(directory, "neg"))}
        report["comparisons"][label] = entry
        s, u, d = entry["significant"], entry["up"], entry["down"]
        print("%-24s sig %6d / %-6d shared %6d   up %4d/%-4d shared %4d   down %4d/%-4d shared %4d" % (
            label, s["app"], s["legacy"], s["shared"], u["app"], u["legacy"], u["shared"], d["app"], d["legacy"], d["shared"]))

    print("== whole-genome folds")
    for condition, sid in meta["structures"].items():
        mine = read_dbn(os.path.join(project, "structures", sid, "structure.dbn"))
        theirs = read_dbn(os.path.join(args.reproduce_dir, "analysis", "cplfold", FOLDS[condition] + ".dbn"))
        same = sum(1 for x, y in zip(mine, theirs) if x == y)
        entry = {"length": len(mine), "identical": mine == theirs, "same_positions": same,
                 "pairs_app": mine.count("("), "pairs_legacy": theirs.count("(")}
        report["structures"][condition] = entry
        print("%-4s length %d identical %s pairs %d / %d" % (condition, len(mine), entry["identical"],
                                                         entry["pairs_app"], entry["pairs_legacy"]))
    if args.out:
        json.dump(report, open(args.out, "w"), indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())

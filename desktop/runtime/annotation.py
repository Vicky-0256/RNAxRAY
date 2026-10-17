"""Gene annotation of a reference (bridge operations ``set_reference_annotation``
and ``read_annotation``).

A reference may carry one annotation file, copied into the project as
``annotations/<reference_id>.<ext>`` and recorded on the reference as
``annotation: {path, format, file_name}``.  Formats:

* GenBank (``LOCUS`` ... ``FEATURES`` ... ``ORIGIN``): mat_peptide, CDS, gene,
  5'UTR, 3'UTR and misc_feature; the ORIGIN sequence is returned so the app
  can move the features onto a reference whose sequence differs (for example
  a RefSeq record of a related strain).
* GFF3 / GTF: nine tab-separated columns, 1-based inclusive.
* BED: chrom, 0-based start, end, optional name.
* TSV: a header naming ``start`` and ``end`` (and optionally ``name``/``gene``,
  ``seqid``/``chrom``, ``type``) or plain ``name start end`` rows, 1-based.

``read_annotation`` returns the features of one sequence (gene id) chosen
for a single track: mat_peptides when the file has them, else genes, else
CDS, else every feature, plus UTRs; a feature lying inside another of the
same type is dropped (C inside "anchored C", pr and M inside prM).
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .project import _mutate_manifest, load_manifest, safe_relative_path
from .samples import _find, _project_root

MAX_ANNOTATION_BYTES = 64 * 1024 * 1024
MAX_FEATURES = 5000
FORMATS = ("genbank", "gff", "bed", "tsv")
_EXT = {"genbank": "gb", "gff": "gff", "bed": "bed", "tsv": "tsv"}
_TRACK_ORDER = ("mat_peptide", "gene", "CDS")
_UTR = ("5'UTR", "3'UTR", "five_prime_UTR", "three_prime_UTR")


def detect_format(text: str, name: str = "") -> str:
    head = text.lstrip()[:2000]
    if head.startswith("LOCUS") or "\nFEATURES" in text[:200000]:
        return "genbank"
    lower = name.lower()
    if lower.endswith((".gff", ".gff3", ".gtf")) or head.startswith("##gff"):
        return "gff"
    if lower.endswith(".bed"):
        return "bed"
    for line in text.splitlines():
        if not line.strip() or line.startswith(("#", "track", "browser")):
            continue
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 9 and parts[3].isdigit() and parts[4].isdigit():
            return "gff"
        break
    return "tsv"


def _short_label(text: str) -> str:
    """'nonstructural protein NS1' -> 'NS1'; short names are kept."""
    text = text.strip()
    words = text.split()
    if len(words) > 2 and words[-2].lower() == "precursor" and len(words[-1]) <= 4:
        return "pr" + words[-1]  # 'membrane glycoprotein precursor M' -> 'prM'
    if len(words) > 1 and len(words[-1]) <= 6:
        return words[-1]
    return text[:24]


def _feature(seqid: str, ftype: str, start: int, end: int, name: str, strand: str = "+", detail: str = "") -> Dict[str, Any]:
    if start > end:
        start, end = end, start
    return {"seqid": seqid, "type": ftype, "start": start, "end": end, "name": name or ftype,
            "strand": strand, "detail": detail or name or ftype}


def parse_genbank(text: str) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    features: List[Dict[str, Any]] = []
    sequences: Dict[str, str] = {}
    for record in re.split(r"\n//", text):
        if "LOCUS" not in record and "FEATURES" not in record:
            continue
        locus = re.search(r"^LOCUS\s+(\S+)", record, re.M)
        version = re.search(r"^VERSION\s+(\S+)", record, re.M)
        seqid = (version.group(1) if version else locus.group(1) if locus else "sequence")
        table = re.search(r"^FEATURES[^\n]*\n(.*?)(?=^ORIGIN|^CONTIG|\Z)", record, re.M | re.S)
        origin = re.search(r"^ORIGIN[^\n]*\n(.*)", record, re.M | re.S)
        if origin:
            sequences[seqid] = re.sub(r"[^A-Za-z]", "", origin.group(1)).upper().replace("T", "U")
        if not table:
            continue
        current: Optional[Dict[str, Any]] = None
        blocks: List[Dict[str, Any]] = []
        for line in table.group(1).splitlines():
            if len(line) > 21 and line[5] != " ":
                current = {"type": line[5:21].strip(), "location": line[21:].strip(), "qualifiers": []}
                blocks.append(current)
            elif current is not None and line[21:].startswith("/"):
                current["qualifiers"].append(line[21:].strip())
            elif current is not None and line.strip():
                if current["qualifiers"]:
                    current["qualifiers"][-1] += " " + line.strip()
                else:
                    current["location"] += line.strip()
        for block in blocks:
            if block["type"] == "source":
                continue
            # parts on another entry (join(AB012345.1:1..20,30..60)) are skipped
            local = re.sub(r"[A-Za-z_]\w*(?:\.\d+)?:[<>]?\d+(?:[.^]{1,2}[<>]?\d+)?", "", block["location"])
            numbers = [int(n) for n in re.findall(r"\d+", local)]
            if not numbers:
                continue
            quals: Dict[str, str] = {}
            for q in block["qualifiers"]:
                key, _, value = q[1:].partition("=")
                quals.setdefault(key, value.strip().strip('"'))
            product = quals.get("product") or quals.get("note") or ""
            gene = quals.get("gene") or quals.get("locus_tag") or ""
            if block["type"] == "mat_peptide":
                name = _short_label(product or gene)
            else:
                name = gene or _short_label(product) or block["type"]
            strand = "-" if "complement" in block["location"] else "+"
            features.append(_feature(seqid, block["type"], min(numbers), max(numbers), name, strand,
                                     product or gene or block["type"]))
    return features, sequences


def parse_gff(text: str) -> List[Dict[str, Any]]:
    out = []
    for line in text.splitlines():
        if line.startswith("##FASTA"):
            break
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 9 or not parts[3].isdigit() or not parts[4].isdigit():
            continue
        attrs: Dict[str, str] = {}
        for item in re.split(r";\s*", parts[8]):
            if "=" in item:
                key, _, value = item.partition("=")
            else:  # GTF: key "value"
                key, _, value = item.strip().partition(" ")
            if key:
                attrs.setdefault(key.strip(), value.strip().strip('"'))
        name = (attrs.get("Name") or attrs.get("gene_name") or attrs.get("gene") or attrs.get("product")
                or attrs.get("gene_id") or attrs.get("ID") or parts[2])
        out.append(_feature(parts[0], parts[2], int(parts[3]), int(parts[4]), _short_label(name) if " " in name else name,
                            parts[6] if parts[6] in "+-" else "+", attrs.get("product") or name))
    return out


def parse_bed(text: str) -> List[Dict[str, Any]]:
    out = []
    for line in text.splitlines():
        if not line.strip() or line.startswith(("#", "track", "browser")):
            continue
        parts = re.split(r"\t|\s+", line.strip())
        if len(parts) < 3 or not parts[1].isdigit() or not parts[2].isdigit():
            continue
        name = parts[3] if len(parts) > 3 else "feature"
        strand = parts[5] if len(parts) > 5 and parts[5] in "+-" else "+"
        out.append(_feature(parts[0], "feature", int(parts[1]) + 1, int(parts[2]), name, strand))
    return out


def parse_tsv(text: str) -> List[Dict[str, Any]]:
    out = []
    columns: Optional[Dict[str, int]] = None
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = [p.strip() for p in re.split(r"\t|,", line.rstrip("\n"))]
        if columns is None:
            lower = [p.lower() for p in parts]
            if "start" in lower and "end" in lower:
                columns = {key: lower.index(key) for key in lower}
                continue
            columns = {}
        if columns:
            def col(*names: str) -> str:
                for n in names:
                    if n in columns and columns[n] < len(parts):
                        return parts[columns[n]]
                return ""
            start, end = col("start"), col("end")
            name = col("name", "gene", "feature", "label", "id")
            seqid, ftype = col("seqid", "chrom", "sequence", "gene_id"), col("type") or "feature"
        else:
            numbers = [k for k, p in enumerate(parts) if p.isdigit()]
            if len(numbers) < 2:
                continue
            start, end = parts[numbers[0]], parts[numbers[1]]
            name = next((p for k, p in enumerate(parts) if k not in numbers[:2] and p), "feature")
            seqid, ftype = "", "feature"
        if not start.isdigit() or not end.isdigit():
            continue
        out.append(_feature(seqid, ftype, int(start), int(end), name))
    return out


def parse_annotation(path: Path, fmt: Optional[str] = None) -> Tuple[str, List[Dict[str, Any]], Dict[str, str]]:
    """``(format, features, sequences)`` of an annotation file."""
    path = Path(path)
    if path.stat().st_size > MAX_ANNOTATION_BYTES:
        raise ValueError("annotation file is larger than %d MB" % (MAX_ANNOTATION_BYTES // (1024 * 1024)))
    text = path.read_text(encoding="utf-8", errors="replace")
    fmt = fmt or detect_format(text, path.name)
    if fmt == "genbank":
        features, sequences = parse_genbank(text)
    else:
        features, sequences = {"gff": parse_gff, "bed": parse_bed, "tsv": parse_tsv}[fmt](text), {}
    if not features:
        raise ValueError("no features found in %s (read as %s)" % (path.name, fmt))
    return fmt, features, sequences


def _matches(seqid: str, gene: str) -> bool:
    if not seqid or seqid == gene:
        return True
    accession = seqid.split(".")[0]
    return bool(accession) and accession in gene


def track_features(features: List[Dict[str, Any]], gene: str) -> Tuple[List[Dict[str, Any]], str]:
    """The features of ``gene`` for one track and the seqid they came from."""
    seqids = sorted({f["seqid"] for f in features})
    chosen = [f for f in features if _matches(f["seqid"], gene)]
    if not chosen and len(seqids) == 1:
        chosen = list(features)  # a one-sequence file applies to the reference it is attached to
    seqid = chosen[0]["seqid"] if chosen else ""
    track: List[Dict[str, Any]] = []
    for ftype in _TRACK_ORDER:
        track = [f for f in chosen if f["type"] == ftype]
        if track:
            break
    if not track:
        track = [f for f in chosen if f["type"] not in _UTR + ("source", "region")]
    track += [f for f in chosen if f["type"] in _UTR]
    # drop a feature inside another of the same type
    track.sort(key=lambda f: (f["start"], -(f["end"] - f["start"])))
    kept: List[Dict[str, Any]] = []
    for f in track:
        if any(k["type"] == f["type"] and k["start"] <= f["start"] and f["end"] <= k["end"] for k in kept):
            continue
        kept.append(f)
    return kept[:MAX_FEATURES], seqid


def set_reference_annotation(root: Path, reference_id: str, source: Optional[Path]) -> Dict[str, Any]:
    """Attach (copy) an annotation file to a reference, or remove it (``source`` None)."""
    root = _project_root(root)
    if source is not None:
        source = Path(source).expanduser().resolve()
        if not source.is_file():
            raise ValueError("annotation file does not exist: %s" % source)
        fmt, features, _ = parse_annotation(source)
    reference = _find(load_manifest(root)["references"], reference_id, "reference")
    old = (reference.get("annotation") or {}).get("path")
    target_rel = None
    if source is not None:
        folder = root / "annotations"
        folder.mkdir(exist_ok=True)
        if folder.is_symlink() or folder.resolve().parent != root:
            raise ValueError("annotations/ must be a real folder inside the project")
        target_rel = "annotations/%s.%s" % (reference_id, _EXT[fmt])
        shutil.copyfile(source, root / target_rel)

    def mutate(manifest: Dict[str, Any]) -> Dict[str, Any]:
        item = _find(manifest["references"], reference_id, "reference")
        if source is None:
            item.pop("annotation", None)
        else:
            item["annotation"] = {"path": target_rel, "format": fmt, "file_name": source.name[:200],
                                  "features": len(features)}
        return item

    result = _mutate_manifest(root, mutate)
    if old and old != target_rel and safe_relative_path(old):
        stale = (root / old).resolve()
        if stale.parent == (root / "annotations").resolve() and stale.is_file():
            stale.unlink()
    return result


def read_annotation(root: Path, reference_id: str, gene: str) -> Dict[str, Any]:
    """``{annotation, features, seqid, sequence}`` for one gene of a reference;
    ``annotation`` is null when the reference has none."""
    root = _project_root(root)
    reference = _find(load_manifest(root)["references"], reference_id, "reference")
    entry = reference.get("annotation")
    if not isinstance(entry, dict) or not safe_relative_path(entry.get("path")):
        return {"annotation": None, "features": [], "seqid": "", "sequence": None}
    path = (root / entry["path"]).resolve()
    if path.parent != (root / "annotations").resolve() or not path.is_file():
        raise ValueError("annotation file is missing: %s" % entry["path"])
    fmt, features, sequences = parse_annotation(path, entry.get("format"))
    track, seqid = track_features(features, gene)
    return {"annotation": entry, "features": track, "seqid": seqid, "sequence": sequences.get(seqid)}

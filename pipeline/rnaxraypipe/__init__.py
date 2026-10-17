"""Pure-Python port of the RNAxRay FASTQ/FASTA/SAM -> .hyb pipeline.

Byte-for-byte compatible with ``bin/sam2hyb`` run under one-true-awk in a
C/C.UTF-8 locale (macOS).  Run ``python -m rnaxraypipe --help``.
"""
from .pipeline import Options, Result, run, sam2hyb

__all__ = ["Options", "Result", "run", "sam2hyb"]
__version__ = "0.1.0"

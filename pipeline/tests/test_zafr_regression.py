"""2M-read regression golden on real data (ZAFR_REP1, first 2,000,000 reads).

Needs the ``zika_files`` directory (``$RNAXRAY_ZIKA_DIR`` or a ``zika_files``
directory next to a parent of this checkout), Bowtie2 and, for the ``-e 1``
run, the ViennaRNA Python package.  Skipped otherwise, or when
``RNAXRAY_SKIP_SLOW=1``.  Takes one to two minutes.
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "bench"))

from rnaxraypipe import Options, inputs, run  # noqa: E402
from make_subset import find_zika_files, write_subset  # noqa: E402

GOLDEN = json.loads((HERE / "golden/zafr_rep1_2m.json").read_text())
ZIKA = find_zika_files()


def _source():
    if ZIKA is None:
        return None
    for name in (GOLDEN["source"], GOLDEN["source_gz"]):
        if (ZIKA / name).is_file():
            return ZIKA / name
    return None


def _has_bowtie2():
    return bool(inputs._tool("bowtie2-align-s", "bowtie2") and inputs._tool("bowtie2-build-s", "bowtie2-build"))


def _has_viennarna():
    try:
        import RNA  # noqa: F401
        return True
    except ImportError:
        return False


def _digest(path):
    data = Path(path).read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "lines": data.count(b"\n")}


def _options(**kw):
    if "keep_sam" not in Options.__dataclass_fields__:
        kw.pop("keep_sam", None)
    return Options(**kw)


@unittest.skipIf(os.environ.get("RNAXRAY_SKIP_SLOW") == "1", "RNAXRAY_SKIP_SLOW=1")
@unittest.skipUnless(_source() is not None, "zika_files/ZAFR_REP1.fastq not found")
@unittest.skipUnless(_has_bowtie2(), "Bowtie2 not installed")
class ZafrRegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="rnaxray-zafr2m-"))
        cls.reads = cls.tmp / "zafr_2m.fastq"
        digest = write_subset(_source(), GOLDEN["lines"] // 4, cls.reads)
        if digest != GOLDEN["subset_sha256"]:
            raise AssertionError("subset digest %s differs from the golden's %s" % (digest, GOLDEN["subset_sha256"]))
        cls.reference = ZIKA / GOLDEN["reference"]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _check(self, result, run_name):
        expected = GOLDEN["runs"][run_name]
        for key, path in (("hyb", result.hyb), ("homodimers", result.homodimers), ("stats", result.stats)):
            self.assertEqual(_digest(path), expected[key], "%s %s" % (run_name, key))

    def test_fastq_and_sam_paths(self):
        result = run(self.reads, self.reference, self.tmp / "fq/zafr_2m", _options(keep_sam="plain"))
        self._check(result, "fastq_e0")
        sam = result.sam
        self.assertTrue(sam and Path(sam).is_file())
        if _has_viennarna():
            result = run(sam, self.reference, self.tmp / "sam/zafr_2m", _options(energy=True))
            self._check(result, "sam_e1")
        else:
            result = run(sam, self.reference, self.tmp / "sam/zafr_2m", _options())
            self._check(result, "fastq_e0")


if __name__ == "__main__":
    unittest.main()

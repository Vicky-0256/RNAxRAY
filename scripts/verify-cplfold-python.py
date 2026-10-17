#!/usr/bin/env python3
"""Verify the vendored CPLfold tests and a real-Numba end-to-end fold."""

from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


SEQUENCE = "GGCGCGGCACCGUCCGCGGAACAAACGG"
EXPECTED_STRUCTURE = "..(((((..[[[[)))))......]]]]"
EXPECTED_ENERGY_LINE = "Energy: -8.02 kcal/mol"


def run(command: list[str], *, cwd: Path, environment: dict[str, str]) -> str:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=300,
    )
    return completed.stdout


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    vendor = repository / "third_party" / "cplfold"
    wrapper = repository / "bin" / "cplfold"
    configured = os.environ.get("RNAXRAY_PYTHON")
    candidates = [
        Path(configured).expanduser() if configured else None,
        repository / ".venv-cplfold" / "bin" / "python",
        Path(sys.executable),
    ]
    runner = next((candidate for candidate in candidates if candidate and candidate.is_file()), Path(sys.executable))
    probe = subprocess.run(
        [str(runner), "-c", "import numpy, numba"],
        cwd=repository, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, check=False,
    )
    if probe.returncode != 0:
        raise SystemExit(
            "CPLfold verification needs a Python environment with NumPy and Numba. "
            "Set RNAXRAY_PYTHON or create .venv-cplfold."
        )

    with tempfile.TemporaryDirectory(prefix="rnaxray-cplfold-numba-") as cache:
        environment = os.environ.copy()
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment.pop("NUMBA_DISABLE_JIT", None)

        oversized_sequence = "A" * 1001
        oversized_file = Path(cache) / "oversized-input.fasta"
        oversized_file.write_text(">oversized\n" + oversized_sequence + "\n", encoding="utf-8")
        guard_cases = [
            ["--sequence", oversized_sequence],
            [f"--sequence={oversized_sequence}"],
            [f"-s{oversized_sequence}"],
            [f"-s={oversized_sequence}"],
            ["--sequence", "A", "--sequence", oversized_sequence],
            ["--sequence-file", str(oversized_file)],
        ]
        for arguments in guard_cases:
            oversized = subprocess.run(
                [str(runner), str(wrapper), *arguments, "--quiet"],
                cwd=repository,
                env=environment,
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=30,
            )
            if (
                oversized.returncode == 0
                or "safety limit is 1000 nt" not in oversized.stdout
            ):
                raise SystemExit(
                    f"The CPLfold length guard was bypassed by arguments: {arguments[:1]}"
                )

        default_cache_environment = environment.copy()
        default_cache_environment.pop("NUMBA_CACHE_DIR", None)
        default_cache_root = Path(cache) / "xdg-cache"
        default_cache_environment["XDG_CACHE_HOME"] = str(default_cache_root)
        run(
            [str(runner), str(wrapper), "--help"],
            cwd=repository,
            environment=default_cache_environment,
        )
        default_cache = default_cache_root / "rnaxray" / "cplfold-numba"
        if not default_cache.is_dir():
            raise SystemExit("The wrapper did not create its user-scoped Numba cache")
        if stat.S_IMODE(default_cache.stat().st_mode) != 0o700:
            raise SystemExit("The default Numba cache is not mode 0700")

        no_pseudoknot_environment = environment.copy()
        no_pseudoknot_environment["NUMBA_DISABLE_JIT"] = "1"
        no_pseudoknot_environment["NUMBA_CACHE_DIR"] = str(
            Path(cache) / "no-pseudoknot-cache"
        )
        no_pseudoknot = subprocess.run(
            [str(runner), str(wrapper), "--sequence", "AAAAA", "--quiet"],
            cwd=repository,
            env=no_pseudoknot_environment,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=30,
        )
        if no_pseudoknot.returncode != 0:
            raise SystemExit(
                "A valid Phase-1-only fold incorrectly returned command failure"
            )

        environment["NUMBA_CACHE_DIR"] = str(Path(cache) / "jit-cache")

        sequence_file = Path(cache) / "cplfold-input.fasta"
        sequence_file.write_text(
            ">RNAXRAY_Web_prepared_sequence\n" + SEQUENCE + "\n", encoding="utf-8"
        )

        unit_output = run(
            [
                str(runner),
                "-m",
                "unittest",
                "discover",
                "-s",
                "tests",
                "-v",
            ],
            cwd=vendor,
            environment=environment,
        )
        test_count = re.search(r"^Ran (\d+) tests?", unit_output, re.MULTILINE)
        if test_count is None or int(test_count.group(1)) != 29:
            raise SystemExit("CPLfold did not run the expected 29 regression tests")
        if re.search(r"^OK$", unit_output, re.MULTILINE) is None:
            raise SystemExit("CPLfold unit tests did not report success")

        smoke_output = run(
            [
                str(runner),
                str(wrapper),
                "--sequence-file",
                str(sequence_file),
                "--beam",
                "20",
                "--max-phase1",
                "3",
                "--max-phase2",
                "2",
            ],
            cwd=repository,
            environment=environment,
        )

        bonus_matrix_file = Path(cache) / "cplfold-bonus-matrix.tsv"
        bonus_matrix_file.write_text(
            "# RNAxRay CPLfold bonus matrix\n"
            "# sequence_length=28\n"
            "# coordinate_system=prepared-sequence-1-based-inclusive\n"
            "prepared_position_1\tprepared_position_2\tlog1p_gaussian_hyb_bonus\n"
            "3\t20\t0.80000000\n"
            "4\t19\t0.40000000\n",
            encoding="utf-8",
        )
        guided_output = run(
            [
                str(runner),
                str(wrapper),
                "--sequence-file",
                str(sequence_file),
                "--bonus-matrix-file",
                str(bonus_matrix_file),
                "--alpha",
                "0.5",
                "--beam",
                "20",
                "--max-phase1",
                "2",
                "--max-phase2",
                "1",
            ],
            cwd=repository,
            environment=environment,
        )

    if EXPECTED_STRUCTURE not in smoke_output:
        raise SystemExit("CPLfold smoke test did not reproduce the reference structure")
    if EXPECTED_ENERGY_LINE not in smoke_output:
        raise SystemExit("CPLfold smoke test did not reproduce the reference energy")
    if "Using bonus matrix with alpha: 0.5" not in guided_output:
        raise SystemExit("CPLfold CLI did not apply the downloaded bonus matrix")

    print(
        "CPLfold Python verification passed: length guard, secure cache, "
        "29 unit tests, "
        "FASTA and bonus-matrix file input, and real-JIT smoke."
    )
    print(f"Reference structure: {EXPECTED_STRUCTURE}")
    print("Reference DP09 energy: -8.0204 kcal/mol (CLI rounded to -8.02).")


if __name__ == "__main__":
    main()

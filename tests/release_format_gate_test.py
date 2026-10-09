#!/usr/bin/env python3
"""Exercise the release format gate without modifying the checked-in matrix."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check_release_format_gate.py"


class ReleaseFormatGateTests(unittest.TestCase):
    def run_gate(self, version: str, matrix: object) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="xdrive-release-format-gate-") as directory:
            matrix_path = Path(directory) / "matrix.json"
            matrix_path.write_text(json.dumps(matrix), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(CHECKER), "--version", version, "--matrix", str(matrix_path)],
                capture_output=True,
                text=True,
                check=False,
            )

    def provisional(self) -> dict[str, object]:
        return {"matrixVersion": 1, "status": "provisional-no-go"}

    def approved(self, version: str = "v1.3.1") -> dict[str, object]:
        return {
            "matrixVersion": 1,
            "status": "release-approved",
            "releaseApproval": {
                "version": version,
                "reviewedAt": "2026-10-09",
                "reviewer": "release-review",
                "evidence": ["docs/format-freeze-audit.md", "CI run 123"],
            },
        }

    def test_prerelease_candidate_is_allowed_while_matrix_is_provisional(self) -> None:
        result = self.run_gate("v1.3.1-rc.1", self.provisional())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_stable_release_is_refused_while_matrix_is_provisional(self) -> None:
        result = self.run_gate("v1.3.1", self.provisional())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("provisional-no-go", result.stderr)

    def test_exactly_approved_stable_release_is_allowed(self) -> None:
        result = self.run_gate("v1.3.1", self.approved())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_approval_for_another_version_is_refused(self) -> None:
        result = self.run_gate("v1.3.2", self.approved("v1.3.1"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must match exactly", result.stderr)

    def test_stable_release_requires_review_evidence(self) -> None:
        matrix = self.approved()
        matrix["releaseApproval"]["evidence"] = []  # type: ignore[index]
        result = self.run_gate("v1.3.1", matrix)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("evidence", result.stderr)

    def test_stable_release_requires_a_real_review_date(self) -> None:
        matrix = self.approved()
        matrix["releaseApproval"]["reviewedAt"] = "2026-02-30"  # type: ignore[index]
        result = self.run_gate("v1.3.1", matrix)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("YYYY-MM-DD", result.stderr)

    def test_release_script_checks_gate_before_tests(self) -> None:
        release_script = (ROOT / "scripts/release.sh").read_text(encoding="utf-8")
        gate_call = release_script.index("scripts/check_release_format_gate.py")
        project_tests = release_script.index("make test")
        self.assertLess(gate_call, project_tests)
        self.assertIn('"$project_root/docs/format-version-matrix.json"', release_script)

    def test_unknown_status_and_malformed_json_are_refused(self) -> None:
        unknown = self.run_gate("v1.3.1-rc.1", {"matrixVersion": 1, "status": "approved"})
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown status", unknown.stderr)
        malformed_status = self.run_gate("v1.3.1-rc.1", {"matrixVersion": 1, "status": []})
        self.assertNotEqual(malformed_status.returncode, 0)
        self.assertIn("unknown status", malformed_status.stderr)
        malformed_version = self.run_gate("v1.3.1-rc.1", {"matrixVersion": True, "status": "provisional-no-go"})
        self.assertNotEqual(malformed_version.returncode, 0)
        self.assertIn("matrixVersion", malformed_version.stderr)

        with tempfile.TemporaryDirectory(prefix="xdrive-release-format-gate-") as directory:
            matrix_path = Path(directory) / "matrix.json"
            matrix_path.write_text("{", encoding="utf-8")
            malformed = subprocess.run(
                [sys.executable, str(CHECKER), "--version", "v1.3.1-rc.1", "--matrix", str(matrix_path)],
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("cannot read format version matrix", malformed.stderr)


if __name__ == "__main__":
    unittest.main()

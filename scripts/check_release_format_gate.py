#!/usr/bin/env python3
"""Fail closed when a stable release is not approved by the format matrix."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any


VERSION_PATTERN = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$")
KNOWN_STATUSES = {"provisional-no-go", "release-approved"}


def check(version: str, matrix_path: Path) -> str | None:
    if not VERSION_PATTERN.fullmatch(version):
        return f"invalid release version: {version!r}"

    try:
        matrix: Any = json.loads(matrix_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return f"cannot read format version matrix {matrix_path}: {error}"

    if (
        not isinstance(matrix, dict)
        or type(matrix.get("matrixVersion")) is not int
        or matrix.get("matrixVersion") != 1
    ):
        return "format version matrix has an unsupported or missing matrixVersion"
    status = matrix.get("status")
    if not isinstance(status, str) or status not in KNOWN_STATUSES:
        return f"format version matrix has an unknown status: {status!r}"

    # A prerelease is a validation candidate, not a stable release. It may be
    # built while the format review remains provisional, but still requires a
    # parseable, recognized matrix so a missing file cannot silently pass.
    if "-" in version:
        return None

    if status != "release-approved":
        return (
            f"refusing stable release {version}: format matrix status is {status!r}; "
            "complete the format and release gates, then set an exact releaseApproval"
        )

    approval = matrix.get("releaseApproval")
    if not isinstance(approval, dict):
        return "refusing stable release: releaseApproval record is missing"
    if approval.get("version") != version:
        return (
            f"refusing stable release {version}: releaseApproval.version must match "
            f"exactly (found {approval.get('version')!r})"
        )
    reviewed_at = approval.get("reviewedAt")
    if not isinstance(reviewed_at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", reviewed_at):
        return "refusing stable release: releaseApproval.reviewedAt must be YYYY-MM-DD"
    try:
        date.fromisoformat(reviewed_at)
    except ValueError:
        return "refusing stable release: releaseApproval.reviewedAt must be YYYY-MM-DD"
    if not isinstance(approval.get("reviewer"), str) or not approval["reviewer"].strip():
        return "refusing stable release: releaseApproval.reviewer is missing"
    evidence = approval.get("evidence")
    if not isinstance(evidence, list) or not evidence or any(
        not isinstance(item, str) or not item.strip() for item in evidence
    ):
        return "refusing stable release: releaseApproval.evidence must list review evidence"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="release version, for example v1.3.1")
    parser.add_argument("--matrix", required=True, type=Path, help="format version matrix JSON")
    args = parser.parse_args()

    error = check(args.version, args.matrix)
    if error:
        print(f"release format gate: {error}", file=sys.stderr)
        return 1
    print(f"release format gate: allowed {args.version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Ensure every stable Go API error has safe, actionable client copy."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "internal/server"
CLIENT = ROOT / "web/src/api/api-error.ts"
CATALOG = re.compile(
    r"const errorMessages: Readonly<Record<string, string>> = \{(.*?)^\}",
    re.MULTILINE | re.DOTALL,
)
ENTRY = re.compile(r"^\s+([a-z][a-z0-9_]*):\s*'([^']*)',?$", re.MULTILINE)
SERVER_LITERALS = (
    re.compile(
        r'\bwriteError(?:Details)?\s*\(\s*\w+\s*,\s*'
        r'(?:http\.Status[A-Za-z0-9_]+|\d+)\s*,\s*"([a-z][a-z0-9_]*)"'
    ),
    re.compile(
        r'\bmaintenanceReject\s*\(\s*(?:http\.Status[A-Za-z0-9_]+|\d+)\s*,\s*'
        r'"([a-z][a-z0-9_]*)"'
    ),
)


def fail(message: str) -> None:
    print(f"API error catalog: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    source = CLIENT.read_text(encoding="utf-8")
    match = CATALOG.search(source)
    if not match:
        fail("client message catalog is missing")
    messages = dict(ENTRY.findall(match.group(1)))
    if not messages or any(not message.strip() for message in messages.values()):
        fail("client catalog contains an empty message")

    codes: set[str] = set()
    for path in SERVER.rglob("*.go"):
        text = path.read_text(encoding="utf-8")
        for pattern in SERVER_LITERALS:
            codes.update(pattern.findall(text))
    missing = sorted(codes - messages.keys())
    if missing:
        fail("server errors missing user guidance: " + ", ".join(missing))
    print(f"API error catalog: {len(codes)} server codes covered by {len(messages)} client messages")


if __name__ == "__main__":
    main()

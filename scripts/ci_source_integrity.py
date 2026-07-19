#!/usr/bin/env python3
"""Reject unsafe files and high-confidence credentials in a Git commit range."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Pattern, Sequence

MAX_FILE_BYTES = 2_000_000
SECRET_PATTERNS: tuple[tuple[str, Pattern[bytes]], ...] = (
    (
        "private key",
        re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"),
    ),
    ("GitHub token", re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("OpenAI-style key", re.compile(rb"sk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("Slack token", re.compile(rb"xox[baprs]-[A-Za-z0-9-]{20,}")),
    ("AWS access key", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("Telegram bot token", re.compile(rb"\b\d{8,12}:[A-Za-z0-9_-]{25,}\b")),
)


def git_output(arguments: Sequence[str]) -> bytes:
    """Run Git without a shell and return stdout, raising on failure."""
    completed = subprocess.run(
        ["git", *arguments],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return completed.stdout


def changed_paths(base: str, head: str) -> list[Path]:
    """Return added, copied, modified, or renamed paths in a commit range."""
    raw = git_output(
        ["diff", "--name-only", "-z", "--diff-filter=ACMR", base, head]
    )
    return [Path(name.decode("utf-8")) for name in raw.split(b"\0") if name]


def binary_paths(base: str, head: str) -> set[str]:
    """Return paths Git classifies as binary in a commit range."""
    paths: set[str] = set()
    output = git_output(["diff", "--numstat", base, head]).decode(
        "utf-8", errors="replace"
    )
    for line in output.splitlines():
        columns = line.split("\t", 2)
        if len(columns) == 3 and columns[0] == "-" and columns[1] == "-":
            paths.add(columns[2])
    return paths


def inspect_range(base: str, head: str) -> tuple[int, list[str]]:
    """Inspect changed files and return the count and safe diagnostic findings."""
    paths = changed_paths(base, head)
    binary = binary_paths(base, head)
    findings = [f"{path}: Git-classified binary content" for path in sorted(binary)]

    for path in paths:
        if path.is_symlink():
            findings.append(f"{path}: changed symlink")
            continue
        if not path.is_file():
            findings.append(f"{path}: non-regular or missing changed file")
            continue

        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            findings.append(f"{path}: oversized ({size} bytes)")
            continue

        data = path.read_bytes()
        if b"\0" in data:
            findings.append(f"{path}: NUL content")
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(data):
                findings.append(f"{path}: possible {label}")

    return len(paths), findings


def main(argv: Sequence[str] | None = None) -> int:
    """Run the integrity scan for BASE and optional HEAD commit-ish values."""
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) not in {1, 2}:
        print("usage: ci_source_integrity.py BASE [HEAD]", file=sys.stderr)
        return 2

    base = args[0]
    head = args[1] if len(args) == 2 else "HEAD"
    try:
        git_output(["cat-file", "-e", f"{base}^{{commit}}"])
        git_output(["cat-file", "-e", f"{head}^{{commit}}"])
        count, findings = inspect_range(base, head)
    except (OSError, UnicodeError, subprocess.CalledProcessError) as error:
        print(f"source-integrity scan failed closed: {error}", file=sys.stderr)
        return 1

    print(f"changed_files={count} findings={len(findings)}")
    if findings:
        print("\n".join(findings), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

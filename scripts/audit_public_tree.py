#!/usr/bin/env python3
"""Fail closed on public-tree artifacts that violate the repository boundary."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import zstandard


FORBIDDEN_NAMES = {".DS_Store", "__pycache__", ".pytest_cache", ".mypy_cache", ".coverage"}
FORBIDDEN_DIR_NAMES = FORBIDDEN_NAMES | {"build", "dist"}
FORBIDDEN_SUFFIXES = {".pyc", ".pyo", ".log", ".sqlite", ".db"}
CONTENT_RULES = {
    "private-user-path": re.compile(r"/Users/lgr59|[A-Za-z]:[\\/]Users[\\/]lgr59", re.IGNORECASE),
    "private-source-name": re.compile(r"codex-sync", re.IGNORECASE),
    "legacy-product": re.compile(r"\bcodex\b", re.IGNORECASE),
    "legacy-home-field": re.compile(r"codex_home", re.IGNORECASE),
    "credential-assignment": re.compile(r"(?:api[_-]?key|token|password|secret)\s*[:=]\s*(?!\[|<|None\b)[\"']?[A-Za-z0-9_./+\-=]{12,}", re.IGNORECASE),
    "private-key": re.compile(r"BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY"),
}
NEGATIVE_CONTRACT_ALLOWLIST = {
    "tests/test_cli_install.py": {"legacy-home-field", "legacy-product"},
    "tests/helpers.py": {"credential-assignment"},
    "tests/test_public_tree_audit.py": {"private-user-path"},
    "scripts/build_fixture.py": {"private-key"},
    "scripts/audit_public_tree.py": set(CONTENT_RULES),
}


def scan_text(path: str, text: str) -> list[dict[str, str]]:
    findings = []
    allowed = NEGATIVE_CONTRACT_ALLOWLIST.get(path, set())
    for rule, pattern in CONTENT_RULES.items():
        if rule not in allowed and pattern.search(text):
            findings.append({"path": path, "rule": rule})
    return findings


def audit(root: Path) -> dict[str, object]:
    root = root.resolve()
    findings: list[dict[str, str]] = []
    files = 0
    ignored_macos_metadata = (
        (root / ".git").is_dir()
        and (root / ".gitignore").is_file()
        and ".DS_Store" in (root / ".gitignore").read_text(encoding="utf-8").splitlines()
    )
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if ".git" in path.relative_to(root).parts:
            continue
        if path.name == ".DS_Store" and ignored_macos_metadata:
            continue
        if path.name in FORBIDDEN_DIR_NAMES or path.name.endswith(".egg-info"):
            findings.append({"path": relative, "rule": "generated-name"})
            continue
        if path.is_symlink():
            findings.append({"path": relative, "rule": "symbolic-link"})
            continue
        if not path.is_file():
            continue
        files += 1
        if path.suffix.casefold() in FORBIDDEN_SUFFIXES:
            findings.append({"path": relative, "rule": "generated-suffix"})
            continue
        if path.name == "session.jsonl.zstd":
            try:
                decoded = zstandard.ZstdDecompressor().decompress(path.read_bytes()).decode("utf-8")
            except Exception:
                findings.append({"path": relative, "rule": "invalid-compressed-fixture"})
                continue
            if "synthetic" not in decoded.casefold():
                findings.append({"path": relative, "rule": "non-synthetic-fixture"})
            findings.extend(scan_text(relative, decoded))
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            findings.append({"path": relative, "rule": "unexpected-binary"})
            continue
        findings.extend(scan_text(relative, text))
    return {"schema": "dsh-session-insights/public-tree-audit/1", "root": str(root), "files_scanned": files,
            "status": "pass" if not findings else "fail", "findings": findings}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    result = audit(args.root)
    rendered = json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Audit the declared Python dependencies (runtime + dev) with pip-audit.

The audit input is the dependency list declared in pyproject.toml, not the
ambient interpreter environment, so the result is reproducible across
developer machines (conda-local packages are never project dependencies) and
covers exactly what this project ships and develops against. A pip-audit
failure (including an unreachable advisory service) exits non-zero: an
unscannable state is never reported as a pass.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path


def declared_dependencies(pyproject: Path) -> list[str]:
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    project = data.get("project", {})
    dependencies = list(project.get("dependencies", []))
    for group in project.get("optional-dependencies", {}).values():
        dependencies.extend(group)
    return dependencies


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    dependencies = declared_dependencies(root / "pyproject.toml")
    if not dependencies:
        print("no declared dependencies to audit")
        return 0
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
        handle.write("\n".join(dependencies) + "\n")
        requirements = handle.name
    print(f"auditing {len(dependencies)} declared dependency specifications")
    completed = subprocess.run(
        [sys.executable, "-m", "pip_audit", "-r", requirements, "--strict"],
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())

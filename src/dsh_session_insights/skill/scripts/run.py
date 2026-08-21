#!/usr/bin/env python3
"""Run the managed CLI from the DSH-visible Skill bundle."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def dsh_home() -> Path:
    return Path(os.environ.get("DSH_HOME", Path.home() / ".dsh")).expanduser()


def managed_python() -> Path:
    venv = dsh_home() / "tools" / "dsh-session-insights" / "venv"
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def main(argv: list[str] | None = None) -> int:
    executable = managed_python()
    if not executable.is_file():
        print(
            "dsh-session-insights: managed runtime is missing; reinstall from a trusted source checkout with "
            "`python scripts/bootstrap.py install`.",
            file=sys.stderr,
        )
        return 2
    return subprocess.call(
        [str(executable), "-m", "dsh_session_insights.cli", *(sys.argv[1:] if argv is None else argv)]
    )


if __name__ == "__main__":
    raise SystemExit(main())

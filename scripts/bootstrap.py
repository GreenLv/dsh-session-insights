#!/usr/bin/env python3
"""Install or remove the managed runtime from a trusted source checkout."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


PRODUCT = "dsh-session-insights"
MARKER = ".dsh-session-insights-managed.json"
REPO_ROOT = Path(__file__).resolve().parents[1]


def resolve_home(value: Path | None) -> Path:
    return (value or Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))).expanduser().resolve()


def marker_ok(root: Path) -> bool:
    try:
        value = json.loads((root / MARKER).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return value.get("product") == PRODUCT


def validate_targets(home: Path) -> tuple[Path, Path]:
    skill = home / "skills" / PRODUCT
    tool = home / "tools" / PRODUCT
    for target in (skill, tool):
        if target.is_symlink():
            raise ValueError(f"refusing symbolic-link target: {target}")
    if skill.resolve() == tool.resolve() or skill.resolve().is_relative_to(tool.resolve()) or tool.resolve().is_relative_to(skill.resolve()):
        raise ValueError("managed roots overlap")
    return skill, tool


def install(home: Path) -> None:
    skill, tool = validate_targets(home)
    if skill.exists() and not marker_ok(skill):
        raise ValueError(f"refusing unmanaged skill target: {skill}")
    if tool.exists() and not marker_ok(tool):
        raise ValueError(f"refusing unmanaged runtime target: {tool}")
    home.mkdir(parents=True, exist_ok=True)
    tool.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{tool.name}.stage.", dir=tool.parent))
    backup = Path(tempfile.mkdtemp(prefix=f".{tool.name}.backup.", dir=tool.parent))
    backup.rmdir()
    replaced = False
    had_previous = tool.exists()
    try:
        (stage / MARKER).write_text(
            json.dumps({"product": PRODUCT, "version": "0.1.0", "managed_root": "runtime", "state": "staging"}, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        subprocess.run([sys.executable, "-m", "venv", str(stage / "venv")], check=True)
        source_copy = stage / "source"
        shutil.copytree(
            REPO_ROOT,
            source_copy,
            ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "*.egg-info", "build", "dist", ".venv"),
        )
        python = stage / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", str(source_copy)], check=True)
        shutil.rmtree(source_copy)
        scripts = stage / "venv" / ("Scripts" if os.name == "nt" else "bin")
        old = str(stage).encode()
        new = str(tool).encode()
        for entry in scripts.iterdir():
            if not entry.is_file():
                continue
            try:
                data = entry.read_bytes()
            except OSError:
                continue
            if old in data and b"\x00" not in data:
                entry.write_bytes(data.replace(old, new))
        (stage / MARKER).write_text(
            json.dumps({"product": PRODUCT, "version": "0.1.0", "managed_root": "runtime"}, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if had_previous:
            tool.replace(backup)
        stage.replace(tool)
        replaced = True
        managed_python = tool / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        subprocess.run(
            [str(managed_python), "-m", "dsh_session_insights.cli", "install", "--dsh-home", str(home)],
            check=True,
        )
    except Exception:
        if replaced and tool.exists() and marker_ok(tool):
            shutil.rmtree(tool)
        if backup.exists() and not tool.exists():
            backup.replace(tool)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if backup.exists():
            shutil.rmtree(backup)


def uninstall(home: Path) -> None:
    skill, tool = validate_targets(home)
    for target in (skill, tool):
        if target.exists() and not marker_ok(target):
            raise ValueError(f"refusing unmanaged target: {target}")
    if skill.exists():
        shutil.rmtree(skill)
    if tool.exists():
        shutil.rmtree(tool)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--dsh-home", type=Path)
    args = parser.parse_args(argv)
    if sys.version_info < (3, 11):
        parser.error("Python 3.11 or newer is required")
    try:
        home = resolve_home(args.dsh_home)
        install(home) if args.action == "install" else uninstall(home)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"bootstrap: {exc}", file=sys.stderr)
        return 2
    print(home)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

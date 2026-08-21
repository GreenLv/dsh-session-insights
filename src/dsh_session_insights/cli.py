"""Public command-line interface for dsh-session-insights."""

from __future__ import annotations

import argparse
import importlib.resources
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from . import __version__, analyzer, semantic


PRODUCT = "dsh-session-insights"
MARKER = ".dsh-session-insights-managed.json"


def resolve_home(value: Path | None) -> Path:
    return (value or Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))).expanduser().resolve()


def managed_roots(home: Path) -> tuple[Path, Path]:
    return home / "skills" / PRODUCT, home / "tools" / PRODUCT


def _safe_roots(home: Path) -> tuple[Path, Path]:
    skill_root, tool_root = managed_roots(home)
    for candidate in (skill_root, tool_root):
        if candidate.is_symlink():
            raise ValueError(f"refusing symbolic-link target: {candidate}")
    skill_resolved = skill_root.resolve()
    tool_resolved = tool_root.resolve()
    if skill_resolved == tool_resolved or skill_resolved.is_relative_to(tool_resolved) or tool_resolved.is_relative_to(skill_resolved):
        raise ValueError("managed skill and tool roots overlap")
    return skill_root, tool_root


def _read_marker(root: Path) -> dict[str, object] | None:
    marker = root / MARKER
    if not marker.is_file():
        return None
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if value.get("product") == PRODUCT else None


def _replace_managed_directory(staging: Path, target: Path) -> None:
    if target.exists() and _read_marker(target) is None:
        raise ValueError(f"refusing to replace unmanaged target: {target}")
    backup = target.with_name(f".{target.name}.backup.{os.getpid()}")
    if backup.exists():
        shutil.rmtree(backup)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.replace(backup)
    try:
        staging.replace(target)
    except Exception:
        if backup.exists() and not target.exists():
            backup.replace(target)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def install_skill(home: Path) -> Path:
    skill_root, tool_root = _safe_roots(home)
    python_path = tool_root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python_path.is_file():
        raise ValueError(f"managed runtime is missing: {python_path}; run scripts/bootstrap.py install")
    skill_root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{skill_root.name}.stage.", dir=skill_root.parent))
    try:
        source = importlib.resources.files("dsh_session_insights.skill")
        with importlib.resources.as_file(source) as source_path:
            shutil.copytree(source_path, staging, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (staging / MARKER).write_text(
            json.dumps({"product": PRODUCT, "version": __version__, "managed_root": "skill"}, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        _replace_managed_directory(staging, skill_root)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return skill_root


def _schedule_runtime_cleanup(tool_root: Path) -> None:
    code = (
        "import shutil,sys,time; time.sleep(0.75); "
        "shutil.rmtree(sys.argv[1], ignore_errors=False)"
    )
    kwargs: dict[str, object] = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([sys._base_executable, "-c", code, str(tool_root)], **kwargs)


def uninstall(home: Path) -> None:
    skill_root, tool_root = _safe_roots(home)
    for root in (skill_root, tool_root):
        if root.exists() and _read_marker(root) is None:
            raise ValueError(f"refusing to remove unmanaged target: {root}")
    if skill_root.exists():
        shutil.rmtree(skill_root)
    if tool_root.exists():
        _schedule_runtime_cleanup(tool_root)


def doctor(home: Path) -> tuple[bool, dict[str, object]]:
    skill_root, tool_root = _safe_roots(home)
    python_path = tool_root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    checks = {
        "python_3_11_plus": sys.version_info >= (3, 11),
        "zstandard_available": analyzer.get_zstandard() is not None,
        "dsh_home": str(home),
        "sessions_root_exists": (home / "sessions").is_dir(),
        "skill_managed": _read_marker(skill_root) is not None,
        "runtime_managed": _read_marker(tool_root) is not None,
        "managed_python_exists": python_path.is_file(),
        "skill_definition_exists": (skill_root / "SKILL.md").is_file(),
    }
    passed = all(value for key, value in checks.items() if key not in {"dsh_home", "sessions_root_exists"})
    return passed, checks


def _home_parser(name: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"{PRODUCT} {name}")
    parser.add_argument("--dsh-home", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"-h", "--help"}:
        print("usage: dsh-session-insights {report|semantic|doctor|install|uninstall} ...")
        return 0
    if args[0] in {"-V", "--version"}:
        print(__version__)
        return 0
    command, rest = args[0], args[1:]
    try:
        if command == "report":
            return analyzer.main(rest)
        if command == "semantic":
            return semantic.main(rest)
        if command == "install":
            parsed = _home_parser("install").parse_args(rest)
            print(install_skill(resolve_home(parsed.dsh_home)))
            return 0
        if command == "uninstall":
            parsed = _home_parser("uninstall").parse_args(rest)
            uninstall(resolve_home(parsed.dsh_home))
            print("uninstall scheduled")
            return 0
        if command == "doctor":
            parser = _home_parser("doctor")
            parser.add_argument("--json", action="store_true")
            parsed = parser.parse_args(rest)
            passed, checks = doctor(resolve_home(parsed.dsh_home))
            if parsed.json:
                print(json.dumps({"ok": passed, "checks": checks}, ensure_ascii=False, indent=2, sort_keys=True))
            else:
                for key, value in checks.items():
                    print(f"{key}: {value}")
            return 0 if passed else 1
        raise ValueError(f"unknown command: {command}")
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"{PRODUCT}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

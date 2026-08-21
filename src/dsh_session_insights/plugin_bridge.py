#!/usr/bin/env python3
"""JSONL stdin bridge used by the native DSH Bundle.

Raw session snapshots are held in memory and passed directly to the analyzer;
only bounded analyzer/semantic artifacts are written to the configured run root.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import analyzer, semantic


BRIDGE_SCHEMA = "dsh-session-insights/bridge-1"


def read_request() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    header_line = sys.stdin.readline()
    if not header_line:
        raise ValueError("missing bridge request")
    header = json.loads(header_line)
    if not isinstance(header, dict) or header.get("schema") != BRIDGE_SCHEMA:
        raise ValueError("unsupported bridge request schema")
    snapshots: list[dict[str, Any]] = []
    for line in sys.stdin:
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict) or value.get("kind") != "session":
            raise ValueError("invalid session snapshot envelope")
        snapshot = value.get("snapshot")
        if not isinstance(snapshot, dict):
            raise ValueError("invalid session snapshot")
        snapshots.append(snapshot)
    return header, snapshots


def config_from_options(options: dict[str, Any]) -> analyzer.AnalysisConfig:
    now = analyzer.parse_datetime(str(options.get("now"))) if options.get("now") else datetime.now(timezone.utc)
    until = analyzer.parse_datetime(str(options.get("until")), end_of_day=True) if options.get("until") else now
    if options.get("since"):
        since = analyzer.parse_datetime(str(options["since"]))
    else:
        days = int(options.get("days", 30))
        if days <= 0:
            raise ValueError("days must be positive")
        since = until - timedelta(days=days)
    privacy = str(options.get("privacy", "redacted"))
    analysis_privacy = "metrics" if privacy == "metrics" else str(options.get("analysis_privacy") or privacy)
    return analyzer.AnalysisConfig(
        dsh_home=Path(os.environ.get("DSH_HOME", Path.home() / ".dsh")).expanduser(),
        since=since,
        until=until,
        project=str(options["project"]) if options.get("project") else None,
        privacy_mode=privacy,
        metrics_only=privacy == "metrics",
        max_excerpts=int(options.get("max_excerpts", 80)),
        generated_at=now,
        semantic_capture=True,
        analysis_privacy_mode=analysis_privacy,
        analysis_depth=str(options.get("analysis_depth", "evidence")),
        deterministic_cache=False,
        locale=str(options.get("locale", "zh-CN")),
    )


def render_report(report: dict[str, Any], output: Path, *, locale: str) -> dict[str, Any]:
    report.setdefault("scope", {})["locale"] = locale
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(analyzer.render_html(report), encoding="utf-8")
    companion = output.with_suffix(".json")
    companion.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"report": str(output), "data": str(companion), "sessions": report["totals"]["sessions"]}


def prepare_semantic(options: dict[str, Any], snapshots: list[dict[str, Any]]) -> dict[str, Any]:
    workdir = Path(str(options["workdir"])).expanduser().resolve()
    argv = ["prepare", "--workdir", str(workdir)]
    for name in ("days", "since", "until", "project", "privacy", "analysis_privacy", "analysis_depth", "locale"):
        if options.get(name) is not None:
            argv.extend(["--" + name.replace("_", "-"), str(options[name])])
    parsed = semantic.make_parser().parse_args(argv)
    parsed.session_snapshots = snapshots
    semantic.command_prepare(parsed)
    manifest = semantic.load_manifest(workdir)
    return {
        "workdir": str(workdir),
        "batches": manifest["batch_ids"],
        "selected": len(manifest["selected_task_family_ids"]),
        "locale": manifest.get("locale", "zh-CN"),
        "metrics_semantic_skipped": manifest["metrics_semantic_skipped"],
    }


def main() -> int:
    try:
        request, snapshots = read_request()
        operation = request.get("operation")
        options = request.get("options") if isinstance(request.get("options"), dict) else {}
        if operation == "report":
            config = config_from_options(options)
            built = analyzer.build_report(config, session_snapshots=snapshots)
            assert isinstance(built, dict)
            output = Path(str(options["output"])).expanduser().resolve()
            result = render_report(built, output, locale=str(options.get("locale", "zh-CN")))
        elif operation == "prepare":
            result = prepare_semantic(options, snapshots)
        else:
            raise ValueError(f"unknown bridge operation: {operation}")
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

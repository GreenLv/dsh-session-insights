#!/usr/bin/env python3
"""Independently read back an isolated DSH native-acceptance directory."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import zstandard


REQUIRED_CHECKS = {
    "skill-discovery", "doctor", "deterministic-cache", "redacted-privacy",
    "semantic-complete", "metrics-skip", "fallback", "output-boundary", "process-cleanup",
}
SENTINELS = ("/sensitive-home", "sk-test-", "api_key=", "Bearer ")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def skill_calls(session_root: Path) -> set[str]:
    found: set[str] = set()
    for path in session_root.rglob("session.jsonl.zstd"):
        raw = zstandard.ZstdDecompressor().stream_reader(path.open("rb")).read().decode("utf-8")
        for line in raw.splitlines():
            record = json.loads(line)
            if record.get("type") != "tool/call":
                continue
            data = record.get("data") if isinstance(record.get("data"), dict) else {}
            if str(data.get("name", "")).casefold() != "skill":
                continue
            arguments = data.get("arguments")
            try:
                value = json.loads(arguments) if isinstance(arguments, str) else arguments
            except json.JSONDecodeError:
                value = {}
            if isinstance(value, dict):
                for key in ("name", "skill", "skill_name"):
                    if value.get(key):
                        found.add(str(value[key]))
    return found


def verify(root: Path) -> dict[str, object]:
    root = root.resolve()
    evidence = root / "evidence"
    home = root / "home"
    errors: list[str] = []
    acceptance = read_json(evidence / "native-acceptance.json")
    if acceptance.get("schema") != "dsh-session-insights/native-acceptance/1":
        errors.append("native acceptance schema mismatch")
    checks = {item.get("id"): item.get("status") for item in acceptance.get("checks", []) if isinstance(item, dict)}
    if set(checks) != REQUIRED_CHECKS or any(checks.get(item) != "pass" for item in REQUIRED_CHECKS):
        errors.append("required acceptance checks are missing or not pass")
    artifacts: dict[str, Path] = {}
    for key, relative in acceptance.get("artifacts", {}).items():
        path = (evidence / str(relative)).resolve()
        if not path.is_relative_to(evidence.resolve()) or not path.is_file():
            errors.append(f"invalid artifact path: {key}")
        else:
            artifacts[key] = path
    for key in ("first_report", "second_report", "third_report", "semantic_report"):
        if key not in artifacts:
            continue
        text = artifacts[key].read_text(encoding="utf-8")
        if any(item in text for item in SENTINELS):
            errors.append(f"privacy sentinel in {key}")
        if read_json(artifacts[key]).get("schema") != "dsh-session-insights/1":
            errors.append(f"report schema mismatch: {key}")
    if "first_report" in artifacts and read_json(artifacts["first_report"])["coverage"]["deterministic_cache"]["misses"] < 1:
        errors.append("first report has no cache miss")
    if "second_report" in artifacts and read_json(artifacts["second_report"])["coverage"]["deterministic_cache"]["hits"] < 1:
        errors.append("second report has no cache hit")
    if "third_report" in artifacts and read_json(artifacts["third_report"])["coverage"]["deterministic_cache"]["invalidations"] < 1:
        errors.append("third report has no cache invalidation")
    if "semantic_report" in artifacts and read_json(artifacts["semantic_report"]).get("semantic_analysis", {}).get("status") != "complete":
        errors.append("semantic report is not complete")
    if "metrics_manifest" in artifacts:
        metrics = read_json(artifacts["metrics_manifest"])
        if not metrics.get("metrics_semantic_skipped") or metrics.get("batch_ids"):
            errors.append("metrics semantics were not fully skipped")
    if "fallback_report" in artifacts and read_json(artifacts["fallback_report"]).get("semantic_analysis", {}).get("status") != "fallback":
        errors.append("fallback report is not fallback")
    unexpected = [path for path in (home / "sessions").rglob("*") if path.is_file() and path.name != "session.jsonl.zstd"]
    if unexpected:
        errors.append("non-session artifact found under sessions")
    calls = skill_calls(home / "sessions")
    if "dsh-session-insights" not in calls:
        errors.append("native DSH log contains no dsh-session-insights Skill call")
    return {
        "schema": "dsh-session-insights/native-readback/1",
        "status": "pass" if not errors else "fail",
        "dsh_version": acceptance.get("dsh_version"),
        "python_version": acceptance.get("python_version"),
        "artifact_count": len(artifacts),
        "skill_calls": sorted(calls),
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    result = verify(args.root)
    rendered = json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())

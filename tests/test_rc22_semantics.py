"""rc.2 semantic regressions: structured approval non-grants and team/mode.

These tests exercise the analyzer contract changes for the sole DSH rc.2
target: structured codes are matched by their persisted
identity, never by success text, and team configuration never upgrades into
user work, authorization or completion.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dsh_session_insights import analyzer
from dsh_session_insights.v4 import IDENTITY

ROOT = Path(__file__).resolve().parents[1]


def base_rows() -> list[dict]:
    rows = [
        json.loads(line)
        for line in (ROOT / "tests/fixtures/synthetic-session.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    return rows


def snapshot_with_result_error(error: dict, *, info_variant: bool = False) -> dict:
    """The synthetic base session with the settled tool result carrying one
    structured error object; success text must never overwrite it."""
    rows = base_rows()
    header = dict(rows[0])
    header.pop("type")
    result = rows[6]
    result["data"]["message"]["isError"] = True
    result["data"]["message"]["content"] = [{"type": "text", "text": "Command completed successfully"}]
    if info_variant:
        result["data"]["error"] = {"message": "approval denial", "info": error}
    else:
        result["data"]["error"] = error
    return {"session": header, "events": rows[1:]}


def config_for(session_header: dict):
    now = datetime.fromtimestamp((session_header["createdAt"] + 86400000) / 1000, tz=timezone.utc)
    return analyzer.AnalysisConfig(
        dsh_home=Path("/synthetic"),
        since=now - timedelta(days=30),
        until=now,
        privacy_mode="redacted",
        generated_at=now,
        semantic_capture=True,
        analysis_depth="evidence",
        deterministic_cache=False,
        locale="en",
    )


def build(snapshot: dict):
    report, sessions = analyzer.build_report(
        config_for(snapshot["session"]),
        session_snapshots=[snapshot],
        include_internal_sessions=True,
    )
    return report, report["session_summaries"][0], sessions[0]


def blocked_facts(messages: list[dict]) -> list[dict]:
    return [m["tool_facts"] for m in messages if m.get("tool_facts", {}).get("outcome") == "blocked"]


class ApprovalNonGrantTests(unittest.TestCase):
    """APPROVAL_CANCELLED / APPROVAL_UNAVAILABLE are their own blocked outcomes."""

    def test_approval_cancelled_is_not_caller_cancellation_or_rejection(self):
        snapshot = snapshot_with_result_error({"name": "ApprovalError", "code": "APPROVAL_CANCELLED", "reason": "the approval window was cancelled"})
        report, session, internal = build(snapshot)
        self.assertEqual(session["tool_execution"]["approval_cancelled"], 1)
        self.assertEqual(session["tool_execution"]["outer_cancelled"], 0)
        self.assertEqual(session["tool_execution"]["outer_failures"], 0)
        self.assertEqual(report["totals"]["tool_failures"], 0)
        self.assertEqual(session["permission_blocks"], 0)
        self.assertEqual(session["denied_approvals"], 0)
        self.assertEqual(session["verification"]["successes"], 0, "success text must not classify a blocked call")
        facts = blocked_facts(internal["semantic_messages"])
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["approval"], "APPROVAL_CANCELLED")
        self.assertIsNone(facts[0]["cause"])

    def test_approval_unavailable_is_not_human_rejection(self):
        snapshot = snapshot_with_result_error({"name": "ApprovalError", "code": "APPROVAL_UNAVAILABLE"})
        report, session, _internal = build(snapshot)
        self.assertEqual(session["tool_execution"]["approval_unavailable"], 1)
        self.assertEqual(session["tool_execution"]["approval_cancelled"], 0)
        self.assertEqual(report["totals"]["tool_failures"], 0)
        self.assertEqual(session["permission_blocks"], 0)

    def test_info_variant_carries_the_same_classification(self):
        snapshot = snapshot_with_result_error(
            {"name": "ApprovalError", "code": "APPROVAL_UNAVAILABLE"}, info_variant=True
        )
        report, session, _internal = build(snapshot)
        self.assertEqual(session["tool_execution"]["approval_unavailable"], 1)
        self.assertEqual(report["totals"]["tool_failures"], 0)

    def test_repeated_non_grants_keep_separate_evidence(self):
        path = ROOT / "tests/fixtures/rc1-cancellation/repeated-cancellation/session.v4.jsonl"
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        for event in rows[1:]:
            if event["type"] == "tool/result":
                event["data"]["error"] = {"name": "ApprovalError", "code": "APPROVAL_CANCELLED"}
        report, session, internal = build({"session": rows[0], "events": rows[1:]})
        self.assertEqual(session["tool_execution"]["approval_cancelled"], 2)
        facts = blocked_facts(internal["semantic_messages"])
        self.assertEqual(len(facts), 2)
        self.assertEqual([fact["turn"] for fact in facts], [1, 2])
        self.assertEqual(len({fact["record_identity"] for fact in facts}), 2)

    def test_approval_rejected_is_a_permission_boundary(self):
        snapshot = snapshot_with_result_error({"name": "ApprovalError", "code": "APPROVAL_REJECTED", "reason": "the user rejected tool bash"})
        report, session, _internal = build(snapshot)
        self.assertEqual(session["tool_execution"]["approval_cancelled"], 0)
        self.assertEqual(session["tool_execution"]["approval_unavailable"], 0)
        self.assertEqual(session["tool_execution"]["outer_failures"], 1)
        self.assertEqual(report["totals"]["tool_failures"], 1)
        self.assertEqual(session["permission_blocks"], 1)
        self.assertEqual(session["failure_causes"].get("permission_boundary"), 1)

    def test_success_text_cannot_create_approval_facts(self):
        # No structured code: text mentioning approval codes stays an ordinary
        # failure, never a structured blocked outcome.
        snapshot = snapshot_with_result_error({})
        snapshot["events"][5]["data"].pop("error")
        snapshot["events"][5]["data"]["message"]["content"] = [
            {"type": "text", "text": "APPROVAL_UNAVAILABLE APPROVAL_CANCELLED happened"}
        ]
        report, session, internal = build(snapshot)
        self.assertEqual(blocked_facts(internal["semantic_messages"]), [])
        self.assertEqual(session["tool_execution"]["outer_failures"], 1)
        self.assertEqual(report["totals"]["tool_failures"], 1)


class TeamModeTests(unittest.TestCase):
    """team/mode is team configuration/context, never user work."""

    def test_identity_targets_rc3_semantics(self):
        self.assertEqual(IDENTITY["target_dsh_version"], "0.2.2-rc.3")
        self.assertEqual(IDENTITY["analyzer_semantics"], "v4-dsh022rc3.1")

    def test_team_mode_is_counted_as_configuration(self):
        rows = base_rows()
        header = dict(rows[0])
        header.pop("type")
        team_mode = {"seq": len(rows) - 1, "time": rows[0]["createdAt"] + 5000, "type": "team/mode", "data": {"enabled": True}}
        rows.append(team_mode)
        report, session, internal = build({"session": header, "events": rows[1:]})
        self.assertEqual(session["team"]["mode_changes"], 1)
        self.assertEqual(report["totals"]["team"]["mode_changes"], 1)
        self.assertEqual(internal["task_started"], 1, "team/mode must not create a user task")
        self.assertEqual(session["permission_blocks"], 0)
        self.assertEqual(
            [m for m in internal["semantic_messages"] if m.get("role") == "user" and "team/mode" in m.get("text", "")],
            [],
        )

    def test_non_boolean_mode_data_is_not_counted(self):
        rows = base_rows()
        header = dict(rows[0])
        header.pop("type")
        rows.append({"seq": len(rows) - 1, "time": rows[0]["createdAt"] + 5000, "type": "team/mode", "data": {}})
        report, session, _ = build({"session": header, "events": rows[1:]})
        self.assertEqual(session["team"]["mode_changes"], 0)

    def test_log_without_team_mode_stays_accepted(self):
        # rc.1-shaped log: no team/mode anywhere; zero mode changes, full report.
        rows = base_rows()
        header = dict(rows[0])
        header.pop("type")
        report, session, _ = build({"session": header, "events": rows[1:]})
        self.assertEqual(session["team"]["mode_changes"], 0)
        self.assertEqual(report["totals"]["sessions"], 1)

    def test_rc2_event_is_in_the_single_product_vocabulary(self):
        self.assertIn("team/mode", analyzer.DSH_KNOWN_RECORD_TYPES)


if __name__ == "__main__":
    unittest.main()

"""D02 differential regression on sessions imported by the official rc.3 importer.

The JS harness (tests-js/fixtures/import-sessions.mjs) runs the published
`@deepseek-ai/dsh-deepseek-chat-import` importer sources over the official
session-persistence-jsonl backend and emits the imported V4 snapshots. This
test keeps the retained Python analyzer's semantics aligned with the native
side on that imported data: excluded replies stay failures, the imported
`deepseek-chat-export` source is an observation label and never a local model
request, missing usage stays unavailable, and the two analyzers agree.
"""
import copy
import json
import subprocess
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from dsh_session_insights import analyzer

ROOT = Path(__file__).resolve().parents[1]


class DshImportSemanticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.harness_output = subprocess.run(
            ["node", str(ROOT / "tests-js/fixtures/import-sessions-cli.mjs")],
            text=True, encoding="utf-8", capture_output=True, timeout=300,
        )
        if cls.harness_output.returncode != 0:
            raise AssertionError(f"import harness failed: {cls.harness_output.stderr}")
        payload = json.loads(cls.harness_output.stdout)
        cls.snapshots = payload["snapshots"]
        cls.importer = payload["importer"]

    def build(self, snapshots, locale="en", privacy="redacted"):
        now = datetime.fromisoformat("2026-11-10T08:00:00+00:00")
        config = analyzer.AnalysisConfig(
            dsh_home=Path("/synthetic"),
            since=now - timedelta(days=30), until=now, generated_at=now,
            privacy_mode=privacy, metrics_only=privacy == "metrics",
            semantic_capture=True, deterministic_cache=False, locale=locale,
            report_timezone=analyzer.resolve_report_timezone("UTC"),
        )
        return analyzer.build_report(config, session_snapshots=snapshots)

    def native_report(self, snapshots, locale="en", privacy="redacted"):
        now = int(datetime.fromisoformat("2026-11-10T08:00:00+00:00").timestamp() * 1000)
        output = subprocess.run(
            ["node", str(ROOT / "tests-js/fixtures/native-report.mjs")],
            input=json.dumps({"snapshots": snapshots, "options": {
                "now": now, "days": 30, "privacy": privacy, "locale": locale,
                "analysis_depth": "evidence",
                "report_timezone": "UTC",
            }}),
            text=True, encoding="utf-8", capture_output=True,
        )
        self.assertEqual(output.returncode, 0, output.stderr)
        return json.loads(output.stdout)["report"]

    def test_importer_identity_is_exact_rc3_package(self):
        self.assertEqual(self.importer["name"], "@deepseek-ai/dsh-deepseek-chat-import")
        self.assertEqual(self.importer["version"], "0.2.2-rc.3")

    def test_imported_sessions_carry_workspace_cwd_and_full_turns(self):
        workspace_path = json.loads(self.harness_output.stdout)["workspace_path"]
        self.assertEqual(len(self.snapshots), 4)
        for snapshot in self.snapshots:
            self.assertEqual(snapshot["session"]["cwd"], workspace_path)
            self.assertEqual(snapshot["session"]["version"], 4)
            self.assertEqual(snapshot["events"][0]["type"], "turn/start")

    def test_excluded_replies_stay_failures_and_usage_stays_unavailable(self):
        report = self.build(self.snapshots)
        totals = report["totals"]
        self.assertEqual(totals["turns"], 10)
        self.assertEqual(totals["aborted_turns"], 4)
        self.assertEqual(totals["tool_failures"], 1)
        self.assertEqual(totals["tokens"]["total_tokens"], 0)
        session_summaries = report["session_summaries"]
        self.assertEqual(len(session_summaries), 4)
        for summary in session_summaries:
            self.assertEqual(summary["tokens"]["total_tokens"], 0)
            self.assertIn(summary["provider"], (None, "deepseek-chat-export"))
        self.assertEqual(
            sorted(p["provider"] for p in report["providers"]),
            ["deepseek-chat-export"],
        )

    def test_native_and_python_reports_agree_on_imported_sessions(self):
        report = self.build(self.snapshots)
        native = self.native_report(self.snapshots)
        for key, value in report["totals"].items():
            self.assertEqual(native["totals"][key], value, f"totals.{key}")
        for key in ("projects", "task_family_totals", "interaction_metrics",
                    "role_metrics", "platform_metrics", "usage_profile"):
            self.assertEqual(native[key], report[key], key)
        for expected, actual in zip(report["session_summaries"], native["session_summaries"], strict=True):
            for key, v in expected.items():
                if key in {"failure_rule_version", "rollout_id", "rollout_file"}:
                    continue
                self.assertEqual(actual[key], v, f"session.{key}")


if __name__ == "__main__":
    unittest.main()

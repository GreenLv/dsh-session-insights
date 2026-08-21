from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dsh_session_insights import analyzer
from helpers import NOW, records, write_session


class SessionQueryAdapterTests(unittest.TestCase):
    def config(self, home: Path) -> analyzer.AnalysisConfig:
        now = datetime.fromisoformat(NOW.replace("Z", "+00:00"))
        return analyzer.AnalysisConfig(
            dsh_home=home,
            since=now - timedelta(days=30),
            until=now,
            generated_at=now,
            deterministic_cache=False,
        )

    def test_snapshot_and_file_sources_have_equivalent_totals(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_session(home, 1)
            file_report = analyzer.build_report(self.config(home))
            snapshot_records = records(1)
            snapshot = {"session": {key: value for key, value in snapshot_records[0].items() if key != "type"}, "events": snapshot_records[1:]}
            stream_report = analyzer.build_report(self.config(home), session_snapshots=[snapshot])
            assert isinstance(file_report, dict) and isinstance(stream_report, dict)
            for key in ("sessions", "turns", "user_messages", "assistant_messages", "tool_calls", "tool_failures", "tokens"):
                self.assertEqual(file_report["totals"][key], stream_report["totals"][key], key)
            self.assertFalse(stream_report["coverage"]["deterministic_cache"]["enabled"])

    def test_session_insights_command_marks_current_family_as_meta_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            snapshot_records = records(1)
            snapshot_records.insert(-1, {
                "type": "command/run", "time": snapshot_records[-1]["time"] - 1,
                "data": {"commandId": "command-test", "name": "session-insights", "args": " --days 30"},
            })
            snapshot = {"session": {key: value for key, value in snapshot_records[0].items() if key != "type"}, "events": snapshot_records[1:]}
            report = analyzer.build_report(self.config(home), session_snapshots=[snapshot])
            assert isinstance(report, dict)
            self.assertTrue(report["task_families"][0]["meta_analysis"])

    def test_bridge_streams_snapshot_without_zstandard_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            snapshot_records = records(1)
            request = {
                "schema": "dsh-session-insights/bridge-1",
                "operation": "report",
                "options": {"days": 30, "now": NOW, "output": str(root / "report.html"), "locale": "en"},
            }
            snapshot = {"kind": "session", "snapshot": {
                "session": {key: value for key, value in snapshot_records[0].items() if key != "type"},
                "events": snapshot_records[1:],
            }}
            payload = "\n".join(json.dumps(item) for item in (request, snapshot)) + "\n"
            env = dict(os.environ)
            env["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
            completed = subprocess.run(
                [sys.executable, "-m", "dsh_session_insights.plugin_bridge"],
                input=payload,
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(completed.stdout.strip().splitlines()[-1])
            self.assertTrue(result["ok"])
            self.assertEqual(result["sessions"], 1)
            self.assertTrue((root / "report.html").is_file())
            self.assertTrue((root / "report.json").is_file())
            html = (root / "report.html").read_text(encoding="utf-8")
            self.assertIn('<html lang="en">', html)
            self.assertIn("DSH Session Insights", html)

    def test_bridge_prepares_english_semantic_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workdir = root / "insights" / "runs" / "run-test"
            snapshot_records = records(1)
            request = {
                "schema": "dsh-session-insights/bridge-1",
                "operation": "prepare",
                "options": {"days": 30, "now": NOW, "workdir": str(workdir), "locale": "en", "privacy": "redacted"},
            }
            snapshot = {"kind": "session", "snapshot": {
                "session": {key: value for key, value in snapshot_records[0].items() if key != "type"},
                "events": snapshot_records[1:],
            }}
            env = dict(os.environ)
            env["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
            env["DSH_HOME"] = str(root)
            completed = subprocess.run(
                [sys.executable, "-m", "dsh_session_insights.plugin_bridge"],
                input="\n".join(json.dumps(item) for item in (request, snapshot)) + "\n",
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            manifest = json.loads((workdir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["locale"], "en")
            self.assertEqual(manifest["batch_ids"], ["batch-001"])
            batch = json.loads((workdir / "batches" / "batch-001.json").read_text(encoding="utf-8"))
            self.assertIn("English", " ".join(batch["output_contract"]["rules"]))


if __name__ == "__main__":
    unittest.main()

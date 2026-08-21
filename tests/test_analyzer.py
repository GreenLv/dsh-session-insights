from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dsh_session_insights import analyzer

from helpers import NOW, write_session


NOW_DT = datetime.fromisoformat(NOW.replace("Z", "+00:00"))


class AnalyzerTests(unittest.TestCase):
    def config(self, home: Path, **overrides):
        values = dict(dsh_home=home, since=NOW_DT - timedelta(days=30), until=NOW_DT,
                      privacy_mode="redacted", generated_at=NOW_DT)
        values.update(overrides)
        return analyzer.AnalysisConfig(**values)

    def test_schema_tokens_provider_and_privacy(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            report = analyzer.build_report(self.config(home))
            self.assertEqual(report["schema"], "dsh-session-insights/1")
            self.assertEqual(report["runtime"], "dsh")
            self.assertEqual(report["totals"]["tokens"]["uncached_input_tokens"], 120)
            self.assertEqual(report["totals"]["tokens"]["cached_input_tokens"], 300)
            self.assertEqual(report["providers"][0]["provider"], "synthetic-provider")
            serialized = json.dumps(report, ensure_ascii=False)
            self.assertNotIn("/sensitive-home", serialized)
            self.assertNotIn("sk-test-", serialized)

    def test_project_and_window_filter(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home, 1, cwd="/workspace/project-a")
            write_session(home, 2, cwd="/workspace/project-b", workspace="--workspace-project-b--")
            report = analyzer.build_report(self.config(home, project="/workspace/project-a"))
            self.assertEqual(report["totals"]["sessions"], 1)
            self.assertEqual(report["coverage"]["skipped_project"], 1)

    def test_workspace_key_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home, cwd=None, workspace="--workspace-project-a--")
            report = analyzer.build_report(self.config(home, project="/workspace/project-a"))
            self.assertEqual(report["totals"]["sessions"], 1)

    def test_cache_miss_hit_and_invalidation(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            path = write_session(home)
            first = analyzer.build_report(self.config(home))
            second = analyzer.build_report(self.config(home))
            self.assertEqual(first["coverage"]["deterministic_cache"]["misses"], 1)
            self.assertEqual(second["coverage"]["deterministic_cache"]["hits"], 1)
            write_session(home, secret=False)
            third = analyzer.build_report(self.config(home))
            self.assertEqual(third["coverage"]["deterministic_cache"]["invalidations"], 1)

    def test_metrics_contains_no_excerpts(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            report = analyzer.build_report(self.config(home, privacy_mode="metrics", metrics_only=True))
            self.assertEqual(report["excerpts"], [])

    def test_local_is_explicit_and_retains_sanitized_path(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            report = analyzer.build_report(self.config(home, privacy_mode="local"))
            self.assertIn("/sensitive-home/person/project", json.dumps(report, ensure_ascii=False))
            self.assertNotIn("sk-test-", json.dumps(report, ensure_ascii=False))

    def test_output_guard_and_default_location(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            source = write_session(home)
            default = analyzer.default_html_output(self.config(home))
            self.assertEqual(default, home / "insights" / "reports" / "dsh-session-insights-20260821-120000.html")
            before = source.read_bytes()
            with self.assertRaises(SystemExit) as raised:
                analyzer.main(["--dsh-home", str(home), "--days", "30", "--format", "json", "--output", str(source), "--now", NOW])
            self.assertEqual(raised.exception.code, 2)
            self.assertEqual(source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()

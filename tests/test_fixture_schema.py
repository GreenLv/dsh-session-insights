from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import jsonschema

from dsh_session_insights import analyzer


ROOT = Path(__file__).parents[1]


class FixtureAndSchemaTests(unittest.TestCase):
    def test_compressed_fixture_is_deterministic_and_audited(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_fixture.py"), "--check"],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_fixture_report_validates_against_schema_v1(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            target = home / "sessions" / "--synthetic-workspace-project-a--" / "session-synthetic-fixture" / "session.jsonl.zstd"
            target.parent.mkdir(parents=True)
            target.write_bytes((ROOT / "tests" / "fixtures" / "session.jsonl.zstd").read_bytes())
            report = analyzer.build_report(analyzer.AnalysisConfig(
                dsh_home=home,
                since=datetime(2026, 8, 1, tzinfo=timezone.utc),
                until=datetime(2026, 8, 21, tzinfo=timezone.utc),
            ))
            schema = json.loads((ROOT / "docs" / "schema" / "report-v1.schema.json").read_text())
            jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(report)
            self.assertEqual(report["totals"]["sessions"], 1)


if __name__ == "__main__":
    unittest.main()

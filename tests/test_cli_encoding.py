"""CLI transport must be UTF-8 even with legacy redirected Python streams."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from dsh_session_insights import output_safety
from helpers import NOW, write_session

ROOT = Path(__file__).resolve().parents[1]


class CliEncodingTests(unittest.TestCase):
    def env(self, home):
        return {**os.environ, "PYTHONPATH": str(ROOT / "src"), "DSH_HOME": str(home),
                "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"}

    def test_three_entries_emit_utf8_reports_or_paths_under_legacy_pipes(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "合成之家"
            write_session(home, cwd="/synthetic/中文项目")
            report_args = ["--dsh-home", str(home), "--now", NOW, "--report-timezone", "UTC+00:00", "--no-deterministic-cache"]
            for module, prefix in (("dsh_session_insights", ["report"]), ("dsh_session_insights.analyzer", [])):
                with self.subTest(module=module):
                    result = subprocess.run([sys.executable, "-m", module, *prefix, *report_args], env=self.env(home), capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8"))
                    text = result.stdout.decode("utf-8")
                    self.assertEqual(json.loads(text)["totals"]["sessions"], 1)
                    self.assertIn("中文项目", text)
            work = Path(temp) / "语义输出"
            result = subprocess.run([sys.executable, "-m", "dsh_session_insights.semantic", "prepare", "--workdir", str(work), *report_args], env=self.env(home), capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8"))
            self.assertIn("语义输出", result.stdout.decode("utf-8"))
            self.assertTrue((work / "manifest.json").is_file())

    def test_three_entries_emit_readable_utf8_refusals_under_legacy_pipes(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            source = home / "sessions"
            before = {p: p.read_bytes() for p in source.rglob("*") if p.is_file()}
            report_args = ["--dsh-home", str(home), "--now", NOW, "--output", str(source / "拒绝.json")]
            cases = [("dsh_session_insights", ["report", *report_args], "会话源目录"),
                     ("dsh_session_insights.analyzer", report_args, "会话源目录"),
                     ("dsh_session_insights.semantic", ["finalize", "--workdir", str(home / "未创建"), "--fallback"], "未创建")]
            for module, args, marker in cases:
                with self.subTest(module=module):
                    result = subprocess.run([sys.executable, "-m", module, *args], env=self.env(home), capture_output=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(marker, result.stderr.decode("utf-8"))
            self.assertEqual({p: p.read_bytes() for p in source.rglob("*") if p.is_file()}, before)

    def test_library_import_does_not_reconfigure_and_embedded_streams_are_supported(self):
        class Unsupported(io.StringIO):
            def reconfigure(self, **kwargs):
                raise io.UnsupportedOperation("embedded stream")

        with mock.patch("sys.stdout", io.StringIO()) as stdout, mock.patch("sys.stderr", Unsupported()) as stderr:
            output_safety.configure_cli_text_streams()
            stdout.write("中文")
            stderr.write("错误")
            self.assertEqual(stdout.getvalue(), "中文")
            self.assertEqual(stderr.getvalue(), "错误")
        script = "import sys; from dsh_session_insights import cli, analyzer, semantic; assert sys.stdout.encoding == 'cp1252'"
        result = subprocess.run([sys.executable, "-c", script], env=self.env(ROOT), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_surrogate_output_fails_with_readable_diagnostics(self):
        script = "import sys; from dsh_session_insights import cli; cli.analyzer.main=lambda _: sys.stdout.write('\\ud800'); raise SystemExit(cli.main(['report']))"
        result = subprocess.run([sys.executable, "-c", script], env=self.env(ROOT), capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertIn("surrogates not allowed", result.stderr.decode("utf-8"))

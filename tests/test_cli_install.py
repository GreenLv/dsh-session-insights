from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

from dsh_session_insights import analyzer, cli, semantic


ROOT = Path(__file__).parents[1]
BOOTSTRAP_SPEC = importlib.util.spec_from_file_location("bootstrap", ROOT / "scripts" / "bootstrap.py")
BOOTSTRAP = importlib.util.module_from_spec(BOOTSTRAP_SPEC)
assert BOOTSTRAP_SPEC and BOOTSTRAP_SPEC.loader
BOOTSTRAP_SPEC.loader.exec_module(BOOTSTRAP)
VERIFY_SPEC = importlib.util.spec_from_file_location("verify_native_acceptance", ROOT / "scripts" / "verify_native_acceptance.py")
VERIFY = importlib.util.module_from_spec(VERIFY_SPEC)
assert VERIFY_SPEC and VERIFY_SPEC.loader
VERIFY_SPEC.loader.exec_module(VERIFY)


class CliAndInstallerTests(unittest.TestCase):
    def fake_runtime(self, home: Path) -> Path:
        root = home / "tools" / cli.PRODUCT
        python = root / "venv" / ("Scripts/python.exe" if cli.os.name == "nt" else "bin/python")
        python.parent.mkdir(parents=True)
        python.write_text("synthetic runtime", encoding="utf-8")
        (root / cli.MARKER).write_text(json.dumps({"product": cli.PRODUCT, "version": "0.1.0", "managed_root": "runtime"}), encoding="utf-8")
        return root

    def test_public_cli_contract_has_no_legacy_switches(self):
        report_help = analyzer.make_parser().format_help()
        semantic_help = semantic.make_parser().format_help()
        self.assertNotIn("--runtime", report_help + semantic_help)
        self.assertNotIn("--codex-home", report_help + semantic_help)
        out = StringIO()
        with redirect_stdout(out):
            self.assertEqual(cli.main(["--help"]), 0)
        for command in ("report", "semantic", "doctor", "install", "uninstall"):
            self.assertIn(command, out.getvalue())

    def test_install_skill_manages_only_marked_root(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            self.fake_runtime(home)
            installed = cli.install_skill(home)
            self.assertTrue((installed / "SKILL.md").is_file())
            self.assertEqual(json.loads((installed / cli.MARKER).read_text(encoding="utf-8"))["product"], cli.PRODUCT)
            cli.install_skill(home)
            self.assertTrue((installed / "scripts" / "run.py").is_file())

    def test_refuses_unmanaged_and_symbolic_link_targets(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            self.fake_runtime(home)
            skill = home / "skills" / cli.PRODUCT
            skill.mkdir(parents=True)
            (skill / "foreign.txt").write_text("do not overwrite", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unmanaged"):
                cli.install_skill(home)
            self.assertEqual((skill / "foreign.txt").read_text(encoding="utf-8"), "do not overwrite")

        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            outside = home / "outside"
            outside.mkdir()
            skill = home / "skills" / cli.PRODUCT
            skill.parent.mkdir(parents=True)
            try:
                skill.symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("symbolic links unavailable")
            with self.assertRaisesRegex(ValueError, "symbolic-link"):
                cli._safe_roots(home)

    def test_uninstall_checks_both_markers_before_removal(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            tool = self.fake_runtime(home)
            skill = cli.install_skill(home)
            (tool / cli.MARKER).unlink()
            with self.assertRaisesRegex(ValueError, "unmanaged"):
                cli.uninstall(home)
            self.assertTrue(skill.exists())
            (tool / cli.MARKER).write_text(json.dumps({"product": cli.PRODUCT}), encoding="utf-8")
            with mock.patch.object(cli, "_schedule_runtime_cleanup") as cleanup:
                cli.uninstall(home)
            self.assertFalse(skill.exists())
            cleanup.assert_called_once_with(tool)

    def test_failed_bootstrap_removes_staging_and_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "home"
            failure = subprocess.CalledProcessError(1, ["python", "-m", "venv"])
            with mock.patch.object(BOOTSTRAP.subprocess, "run", side_effect=failure):
                with self.assertRaises(subprocess.CalledProcessError):
                    BOOTSTRAP.install(home)
            tools = home / "tools"
            residues = list(tools.glob(".dsh-session-insights.*")) if tools.exists() else []
            self.assertEqual(residues, [])

    def test_failed_bootstrap_restores_previous_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "home"
            previous = self.fake_runtime(home)
            sentinel = previous / "previous-runtime.txt"
            sentinel.write_text("preserve", encoding="utf-8")
            failure = subprocess.CalledProcessError(1, ["python", "-m", "venv"])

            with mock.patch.object(BOOTSTRAP.subprocess, "run", side_effect=failure):
                with self.assertRaises(subprocess.CalledProcessError):
                    BOOTSTRAP.install(home)

            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")
            self.assertTrue(BOOTSTRAP.marker_ok(previous))
            residues = list((home / "tools").glob(".dsh-session-insights.*"))
            self.assertEqual(residues, [])

    def test_bootstrap_builds_venv_only_after_final_path_is_installed(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "home"
            calls: list[list[str]] = []

            def record(command, **kwargs):
                calls.append([str(item) for item in command])
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.object(BOOTSTRAP.subprocess, "run", side_effect=record):
                BOOTSTRAP.install(home)

            tool = home / "tools" / cli.PRODUCT
            self.assertEqual(calls[0][-1], str(tool / "venv"))
            self.assertTrue(all(".stage." not in item for command in calls for item in command))
            self.assertFalse((tool / "source").exists())
            self.assertEqual(json.loads((tool / cli.MARKER).read_text(encoding="utf-8"))["managed_root"], "runtime")

    def test_native_privacy_sentinels_allow_only_complete_redacted_placeholders(self):
        safe = '"api_key=<redacted> Bearer <redacted>"'
        self.assertEqual(VERIFY.privacy_sentinel_hits(safe), [])
        unsafe = '"api_key=sk-live-value Bearer live-token /sensitive-home sk-test-value"'
        self.assertEqual(
            set(VERIFY.privacy_sentinel_hits(unsafe)),
            {"api-key", "bearer-token", "sensitive-path", "synthetic-key"},
        )
        self.assertEqual(VERIFY.privacy_sentinel_hits('api_key=<redacted>suffix'), ["api-key"])


if __name__ == "__main__":
    unittest.main()

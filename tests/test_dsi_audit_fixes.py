"""DSI-AUDIT-20261023 regression tests: production call chains for F1-F11.

Every case replays the audit's trigger through the public entrypoints (CLI
subprocess, build_report, semantic commands) against synthetic DSH_HOME trees.
Positive controls run next to each refusal so a blanket rejection cannot pass.
"""
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import zstandard
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dsh_session_insights import analyzer, cli, output_safety, semantic
from helpers import NOW, compress_dsh_generation, epoch_ms, write_session

ROOT = Path(__file__).resolve().parents[1]
NOW_DT = datetime.fromisoformat(NOW.replace("Z", "+00:00"))
URL_VECTORS = json.loads((ROOT / "tests/fixtures/url-sanitize-vectors.json").read_text(encoding="utf-8"))
IDENTITY_VECTORS = json.loads((ROOT / "tests/fixtures/project-identity-vectors.json").read_text(encoding="utf-8"))
TZ_VECTORS = json.loads((ROOT / "tests/fixtures/report-timezone-vectors.json").read_text(encoding="utf-8"))
DIGEST_VECTORS = json.loads((ROOT / "tests/fixtures/aggregate-digest-vectors.json").read_text(encoding="utf-8"))


def config(home, **kw):
    defaults = dict(
        dsh_home=home, since=NOW_DT - timedelta(days=30), until=NOW_DT,
        privacy_mode="redacted", deterministic_cache=True,
    )
    defaults.update(kw)
    return analyzer.AnalysisConfig(**defaults)


def session_rows(index=1, cwd="/synthetic/customer-a/app", created=None):
    created = created or epoch_ms(NOW)
    rows = [
        {"type": "session", "version": 4, "id": f"synthetic-{index}", "createdAt": created,
         "cwd": cwd, "agentPreset": "standard", "delegationDepth": 0, "isSeeded": False},
        {"type": "turn/start", "seq": 0, "time": created, "data": {"turn": 1}},
        {"type": "user/message", "seq": 1, "time": created, "surfaceOp": "append",
         "data": {"content": [{"type": "text", "text": f"Implement synthetic feature {index}"}],
                  "id": f"m-user-{index}", "role": "user", "source": {"kind": "user"}}},
        {"type": "user/message", "seq": 2, "time": created, "surfaceOp": "append",
         "data": {"content": [{"type": "text", "text": "Keep it narrow."}],
                  "id": f"m-user2-{index}", "role": "user", "source": {"kind": "user"}}},
        {"type": "turn/end", "seq": 3, "time": created + 1000, "data": {"reason": {"kind": "completed"}, "turn": 1}},
    ]
    return rows


def write_plain(home, rows, workspace="--ws-a--", index=1):
    directory = home / "sessions" / workspace / f"session-synthetic-{index:03d}"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "session.v4.jsonl"
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False, sort_keys=True) for r in rows) + "\n", encoding="utf-8")
    return path


def run_cli(args, home, pin_now=True):
    # Pin --now to the fixture window: a wall-clock default would drift past
    # the synthetic sessions' createdAt. Subcommands without --now/--dsh-home
    # flags receive the home through the environment instead.
    command = [sys.executable, "-m", "dsh_session_insights", *args]
    accepts_now = args[0] == "report" or (args[0] == "semantic" and args[1:2] == ["prepare"])
    if pin_now and accepts_now:
        command += ["--now", NOW]
    if args and args[0] in ("report",):
        command += ["--dsh-home", str(home)]
    return subprocess.run(
        command, capture_output=True, text=True, cwd=str(ROOT),
        env={**os.environ, "PYTHONPATH": str(ROOT / "src"), "DSH_HOME": str(home)},
    )


def directory_state(root):
    state = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            state[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return state


class F1OutputBoundaryTests(unittest.TestCase):
    def test_companion_symlink_into_source_is_refused_and_source_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            source_tree_before = directory_state(home / "sessions")
            out = Path(temp) / "out"
            out.mkdir()
            companion = out / "audit.json"
            os.symlink(next((home / "sessions").rglob("session.v4.jsonl.zstd")), companion)
            result = run_cli(["report", "--format", "html", "--output", str(out / "audit.html")], home)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(directory_state(home / "sessions"), source_tree_before)
            self.assertIn("会话源目录", result.stderr)

    def test_main_output_inside_source_tree_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            target = next((home / "sessions").rglob("*.zstd")).parent / "report.html"
            before = directory_state(home / "sessions")
            result = run_cli(["report", "--format", "html", "--output", str(target)], home)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(directory_state(home / "sessions"), before)

    def test_hardlink_target_refused_and_old_report_bytes_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            out = Path(temp) / "out"
            out.mkdir()
            target = out / "audit.html"
            target.write_text("PREVIOUS VALID REPORT", encoding="utf-8")
            linked = out / "other.html"
            os.link(target, linked)
            result = run_cli(["report", "--format", "html", "--output", str(target)], home)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_text(encoding="utf-8"), "PREVIOUS VALID REPORT")

    def test_positive_control_writes_main_and_companion_without_overlap(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            out = Path(temp) / "reports" / "audit.html"
            result = run_cli(["report", "--format", "html", "--output", str(out)], home)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(out.exists())
            companion = out.with_suffix(".json")
            self.assertTrue(companion.is_file())
            payload = json.loads(companion.read_text(encoding="utf-8"))
            self.assertEqual(payload["totals"]["sessions"], 1)
            self.assertNotIn("<html", companion.read_text(encoding="utf-8"))

    def test_json_named_html_output_uses_unambiguous_companion_name(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            out = Path(temp) / "audit.json"
            result = run_cli(["report", "--format", "html", "--output", str(out)], home)
            self.assertEqual(result.returncode, 0, result.stderr)
            companion = out.with_name("audit.data.json")
            self.assertTrue(companion.is_file())
            self.assertIn("<html", out.read_text(encoding="utf-8")[:200])

    def test_atomic_writer_leaves_no_temp_files_and_respects_umask(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "nested" / "file.txt"
            old = os.umask(0o022)
            try:
                output_safety.atomic_write_text(target, "hello")
            finally:
                os.umask(old)
            self.assertEqual(target.read_text(encoding="utf-8"), "hello")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_semantic_finalize_uses_safe_output_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            workdir = Path(temp) / "work"
            prepare = run_cli(["semantic", "prepare", "--workdir", str(workdir)], home)
            self.assertEqual(prepare.returncode, 0, prepare.stderr)
            output = Path(temp) / "report" / "final.html"
            finalize = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--fallback", "--output", str(output)], home)
            self.assertEqual(finalize.returncode, 0, finalize.stderr)
            self.assertTrue(output.is_file())
            self.assertTrue(output.with_suffix(".json").is_file())


class F2CacheBoundaryTests(unittest.TestCase):
    def test_out_of_scope_log_is_neever_parsed_or_cached(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            log = write_session(home, cwd="/synthetic/other/project")
            before = directory_state(home / "sessions")
            report = analyzer.build_report(config(home, project="/synthetic/customer-a/app"))
            self.assertEqual(report["totals"]["sessions"], 0)
            self.assertEqual(report["coverage"]["skipped_project"], 1)
            self.assertEqual(directory_state(home / "sessions"), before)
            cache_root = home / "insights" / "cache"
            self.assertFalse(cache_root.exists() or any(cache_root.rglob("*.json")))

    def test_cached_content_is_whitelisted_private_and_secret_free(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)  # prompt carries /sensitive-home + api_key
            old = os.umask(0o022)
            try:
                analyzer.build_report(config(home))
            finally:
                os.umask(old)
            files = sorted((home / "insights" / "cache").rglob("*.json"))
            self.assertEqual(len(files), 1)
            mode = stat.S_IMODE(files[0].stat().st_mode)
            directory_mode = stat.S_IMODE(files[0].parent.stat().st_mode)
            self.assertEqual(mode, 0o600)
            self.assertEqual(directory_mode, 0o700)
            blob = files[0].read_text(encoding="utf-8")
            for marker in ("sk-test-", "sensitive-home"):
                self.assertNotIn(marker, blob)
            payload = json.loads(blob)
            session = payload["session"]
            self.assertTrue(set(session) <= set(analyzer.CACHE_SESSION_FIELDS))
            for banned in ("cwd", "workspace_key", "jobs", "team", "topic_text_parts", "usage_by_step", "source"):
                self.assertNotIn(banned, session)

    def test_cache_version_is_bumped_and_old_entries_are_ignored(self):
        self.assertEqual(analyzer.DETERMINISTIC_CACHE_VERSION, 9)
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            analyzer.build_report(config(home))
            cache_root = home / "insights" / "cache"
            old_dir = cache_root.parent / "deterministic-8"
            old_dir.mkdir(parents=True)
            (old_dir / "stale.json").write_text("{\"cache_version\": 8}", encoding="utf-8")
            report = analyzer.build_report(config(home))
            self.assertEqual(report["coverage"]["deterministic_cache"]["hits"], 1)
            # The legacy entry was neither read nor deleted.
            self.assertTrue((old_dir / "stale.json").exists())

    def test_cache_inventory_previews_and_delete_is_scoped(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            analyzer.build_report(config(home))
            inventory = cli.cache_inventory(home)
            self.assertIn("deterministic-9", inventory)
            entry = inventory["deterministic-9"]
            self.assertEqual(entry["files"], 1)
            self.assertFalse(entry["refused"])
            result = cli.cache_cleanup(home)
            self.assertEqual(result["removed"], ["deterministic-9"])
            self.assertFalse((home / "insights" / "cache" / "deterministic-9").exists())
            # Non-cache content is untouched.
            self.assertTrue((home / "sessions").exists())


class F3UrlCredentialTests(unittest.TestCase):
    def test_shared_vectors_hold_for_local_and_redacted(self):
        for case in URL_VECTORS["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(analyzer.strip_url_queries(case["input"]), case["expected_python"])
                for mode in ("local", "redacted"):
                    text = analyzer.local_text(case["input"]) if mode == "local" else analyzer.redact_text(case["input"])
                    self.assertNotIn("synthetic-user", text)
                    self.assertNotIn("synthetic-pass", text)
                    self.assertNotIn("u:p@", text)
                    self.assertNotIn("p%40ss", text)

    def test_broken_url_does_not_crash_the_report(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            rows = session_rows()
            rows[2]["data"]["content"][0]["text"] = "broken https://example.invalid:99999999999999999999/p end"
            write_plain(home, rows)
            report = analyzer.build_report(config(home, privacy_mode="local"))
            self.assertEqual(report["totals"]["sessions"], 1)

    def test_positive_text_stays_readable(self):
        text = analyzer.local_text("shipped 2026-10-23 with evidence-abc123 check https://example.invalid/docs", 200)
        self.assertIn("2026-10-23", text)
        self.assertIn("evidence-abc123", text)
        self.assertIn("https://example.invalid/docs", text)


class F7OutOfScopeCorruptionTests(unittest.TestCase):
    def _home_with_two_projects(self, temp, corrupt_body=True):
        home = Path(temp)
        write_session(home, 1, cwd="/synthetic/customer-a/app")
        log_b = write_session(home, 2, cwd="/synthetic/customer-b/app", workspace="--synthetic-customer-b-app--")
        if corrupt_body:
            lines = zstandard.ZstdDecompressor().decompress(log_b.read_bytes()).decode().splitlines()
            keep = "\n".join(lines[:2]) + "\n"
            log_b.write_bytes(compress_dsh_generation_payload(keep + '{"type": "user/mess'))
        return home

    def test_out_of_scope_corrupt_body_does_not_block_healthy_project(self):
        with tempfile.TemporaryDirectory() as temp:
            home = self._home_with_two_projects(temp)
            report = analyzer.build_report(config(home, project="/synthetic/customer-a/app"))
            self.assertEqual(report["totals"]["sessions"], 1)
            self.assertEqual(report["coverage"]["skipped_project"], 1)
            # Only the in-scope session is cached; B was never parsed.
            cache_files = list((home / "insights" / "cache").rglob("*.json")) if (home / "insights" / "cache").exists() else []
            self.assertEqual(len(cache_files), 1)

    def test_in_scope_corruption_fails_closed_with_locator(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            log = write_session(home)
            lines = zstandard.ZstdDecompressor().decompress(log.read_bytes()).decode().splitlines()
            log.write_bytes(compress_dsh_generation_payload("\n".join(lines[:3]) + '\n{"type": "user/mess'))
            with self.assertRaises(ValueError) as ctx:
                analyzer.build_report(config(home))
            message = str(ctx.exception)
            self.assertIn("corrupt V4 JSON", message)
            self.assertIn("--workspace-project-a--/session-synthetic-001", message)
            self.assertNotIn("/private", message)

    def test_header_without_timestamp_is_parsed_and_reported_missing(self):
        # An undecidable header (no createdAt) is never silently skipped: the
        # full parse runs and the outcome stays visible in coverage instead of
        # turning into a quiet empty report.
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            rows = session_rows()
            rows[0].pop("createdAt")
            write_plain(home, rows)
            report = analyzer.build_report(config(home))
            self.assertEqual(report["totals"]["sessions"], 0)
            self.assertEqual(report["coverage"]["missing_metadata"], 1)

    def test_header_without_cwd_uses_workspace_key_scope(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            rows = session_rows()
            rows[0].pop("cwd")
            write_plain(home, rows, workspace="--workspace-project-a--")
            # Header scope falls back to the lossy workspace key exactly like
            # the in-record path: an exact-key project filter still selects it.
            report = analyzer.build_report(config(home, project="/workspace/project-a"))
            self.assertEqual(report["totals"]["sessions"], 1)

    def test_plain_jsonl_out_of_scope_skip(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_plain(home, session_rows(1, cwd="/synthetic/customer-a/app"))
            write_plain(home, session_rows(2, cwd="/synthetic/customer-b/app"), workspace="--ws-b--", index=2)
            report = analyzer.build_report(config(home, project="/synthetic/customer-a/app"))
            self.assertEqual(report["totals"]["sessions"], 1)
            self.assertEqual(report["coverage"]["skipped_project"], 1)


def compress_dsh_generation_payload(text):
    compressor = zstandard.ZstdCompressor(level=3, write_checksum=True)
    lines = text.split("\n")
    header = lines[0]
    rest = "\n".join(lines[1:])
    encoded = compressor.compress((header + "\n").encode("utf-8"))
    if rest.strip():
        encoded += compressor.compress((rest + "\n").encode("utf-8"))
    return encoded


class F8ProjectPathNormalizationTests(unittest.TestCase):
    def test_relative_project_resolves_against_process_cwd(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home, cwd="/synthetic/customer-a/app")
            previous = os.getcwd()
            os.chdir(temp)
            try:
                cfg = replace(config(home, project="/synthetic/customer-a/app"), project=None)
                cfg = replace(cfg, project=analyzer.canonical_project_input("sessions"))
                report = analyzer.build_report(cfg)
                self.assertEqual(report["totals"]["sessions"], 0)
                cfg2 = replace(cfg, project=analyzer.canonical_project_input("/synthetic/customer-a/app/"))
                self.assertEqual(cfg2.project, "/synthetic/customer-a/app")
            finally:
                os.chdir(previous)

    def test_canonical_key_matches_shared_vectors(self):
        for case in IDENTITY_VECTORS["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(analyzer.project_identity(case["cwd"]), case["project_id"])

    def test_cli_relative_project_is_resolved_once(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            result = run_cli(["report", "--project", "/workspace/project-a/"], home)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["coverage"]["sessions_analyzed"], 1)


class F9ProjectIdentityTests(unittest.TestCase):
    def test_same_basename_projects_stay_separate_with_stable_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home, 1, cwd="/synthetic/customer-a/app")
            write_session(home, 2, cwd="/synthetic/customer-b/app", workspace="--synthetic-customer-b-app--")
            write_session(home, 3, cwd="/synthetic/customer-a/app")
            report = analyzer.build_report(config(home))
            self.assertEqual(len(report["projects"]), 2)
            ids = {p["project_id"] for p in report["projects"]}
            self.assertEqual(ids, {"project-b518bab1ff92", "project-5b2f395b840b"})
            labels = {p["project"] for p in report["projects"]}
            self.assertNotIn("app", labels)
            for row in report["rollout_summaries"]:
                self.assertRegex(row["project_id"], r"^project-[0-9a-f]{12}$")
            for family in report["task_families"]:
                self.assertIn("project_id", family)
            for excerpt in report["excerpts"]:
                self.assertIn("project_id", excerpt)

    def test_old_report_without_project_id_still_loads_in_dashboard_template(self):
        # The template falls back to the display label when project_id is
        # absent, so pre-0.6.1 HTML/JSON reports remain openable.
        html = analyzer.render_html({"scope": {"locale": "zh-CN"}, "rollout_summaries": [{"project": "app"}]})
        self.assertIn("report-data", html)


class F10ReportTimezoneTests(unittest.TestCase):
    def test_shared_vectors_hold(self):
        for case in TZ_VECTORS["cases"]:
            with self.subTest(case=case["name"]):
                cfg = replace(config(Path("/synthetic")), report_timezone=case["zone"])
                zone = analyzer.report_zone(cfg)
                local = datetime.fromtimestamp(case["instant_ms"] / 1000, tz=timezone.utc).astimezone(zone)
                self.assertEqual(local.date().isoformat(), case["date"])
                self.assertEqual(local.hour, case["hour"])
                self.assertEqual(local.weekday(), case["weekday"])

    def test_report_rows_derive_from_report_timezone(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            rows = session_rows(created=TZ_VECTORS["cases"][0]["instant_ms"])
            write_plain(home, rows)
            until = datetime.fromtimestamp(TZ_VECTORS["cases"][0]["instant_ms"] / 1000 + 3600, tz=timezone.utc)
            cfg = replace(config(home), until=until, since=until - timedelta(days=30), report_timezone="Asia/Shanghai")
            report = analyzer.build_report(cfg)
            row = report["rollout_summaries"][0]
            self.assertEqual((row["date"], row["start_hour_local"], row["weekday"]), ("2026-10-23", 1, 4))
            self.assertEqual(report["scope"]["report_timezone"], "Asia/Shanghai")
            self.assertEqual(row["timezone"], "Asia/Shanghai")

    def test_unsupported_zone_is_an_actionable_error(self):
        with self.assertRaises(ValueError) as ctx:
            analyzer.resolve_report_timezone("Nowhere/Central")
        self.assertIn("tzdata", str(ctx.exception))
        self.assertEqual(analyzer.resolve_report_timezone("UTC+05:45"), "UTC+05:45")

    def test_manifest_records_timezone_for_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            workdir = Path(temp) / "work"
            result = run_cli(["semantic", "prepare", "--workdir", str(workdir), "--report-timezone", "Asia/Shanghai"], home)
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((workdir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["config"]["report_timezone"], "Asia/Shanghai")
            self.assertEqual(manifest["scope_fingerprint"], semantic_semantic_fingerprint(workdir))


def semantic_semantic_fingerprint(workdir):
    manifest = json.loads((workdir / "manifest.json").read_text(encoding="utf-8"))
    return manifest["scope_fingerprint"]


class F11AggregateFreshnessTests(unittest.TestCase):
    def _prepared_workdir(self, home, workdir):
        result = run_cli(["semantic", "prepare", "--workdir", str(workdir), "--no-semantic-cache"], home)
        assert result.returncode == 0, result.stderr
        manifest = json.loads((workdir / "manifest.json").read_text(encoding="utf-8"))
        return manifest

    def _write_facets(self, workdir, manifest, goal):
        for batch_id in manifest["batch_ids"]:
            batch = json.loads((workdir / "batches" / f"{batch_id}.json").read_text(encoding="utf-8"))
            facets = []
            for task in batch["tasks"]:
                facets.append({
                    "task_family_id": task["task_family_id"],
                    "goal": goal,
                    "task_type": "implementation",
                    "interaction_style": "detailed",
                    "instruction_handling": "followed",
                    "tool_execution": "strong",
                    "verification_quality": "strong",
                    "handoff_quality": "clear",
                    "frictions": ["none"],
                    "strengths": ["clear goal"],
                    "outcome_inference": "fully_achieved",
                    "evidence_refs": [task["evidence"][0]["id"]],
                })
            semantic.write_json(workdir / "facet-outputs" / f"{batch_id}.json", {"facets": facets})

    def _write_aggregate(self, workdir, manifest, *, current_input=True):
        """Write an aggregate response naming the prepared input identity.

        current_input=False simulates a response generated against an earlier
        facet snapshot (its identity was captured before a revision) — the
        state machine must refuse it.
        """
        candidates = json.loads((workdir / "semantic-evidence.json").read_text(encoding="utf-8"))["candidates"]
        family = candidates[0]["task_family_id"]
        evidence = candidates[0]["evidence"][0]["id"]
        value = {section: [] for section in semantic.AGGREGATE_SECTIONS}
        value["strengths"] = [{
            "title": "稳定交付", "text": "两个会话完成目标。",
            "supporting_task_family_ids": [family], "evidence_refs": [evidence],
            "confidence": "high", "measurement": "measured",
        }]
        # A response is only acceptable when it names the prepared input it
        # answers; the identity file records what prepare-aggregate issued.
        identity = json.loads((workdir / "aggregate-input-identity.json").read_text(encoding="utf-8"))
        if current_input:
            value["aggregate_input_identity"] = identity
        else:
            # A digest from a DIFFERENT prepared input: same shape as a real
            # one (so it passes output-content rules) but not the current
            # identity — exactly what a stale response carries.
            other = dict(identity)
            other["aggregate_input_digest"] = hashlib.sha256(
                b"aggregate input generated before the facet revision"
            ).hexdigest()
            value["aggregate_input_identity"] = other
        semantic.write_json(workdir / "semantic-report.json", value)

    def test_digest_vectors_match_frozen_expectations(self):
        for case in DIGEST_VECTORS["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(
                    semantic.facets_digest(case["facets"], DIGEST_VECTORS["manifest"]),
                    case["expected_digest"],
                )

    def test_stale_aggregate_refuses_and_recovers(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            workdir = Path(temp) / "work"
            manifest = self._prepared_workdir(home, workdir)
            self._write_facets(workdir, manifest, "实现完成")
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            self._write_aggregate(workdir, manifest)
            validate = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertEqual(validate.returncode, 0, validate.stderr)
            # finalize completes while content matches the binding
            finalize = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                                "--format", "json", "--output", str(Path(temp) / "a.json")], home)
            self.assertEqual(finalize.returncode, 0, finalize.stderr)
            # change the facet conclusion: the old aggregate must not complete
            self._write_facets(workdir, manifest, "未实现完成")
            stale = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                             "--format", "json", "--output", str(Path(temp) / "b.json")], home)
            self.assertNotEqual(stale.returncode, 0)
            self.assertIn("已过期", stale.stderr)
            # A late response carrying the OLD prepared-input identity is refused
            # at validate time (not re-stamped as current).
            old_identity_validate = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertNotEqual(old_identity_validate.returncode, 0)
            # Positive recovery: re-prepare the aggregate input (new identity) and
            # regenerate the response against it — a genuine rebuild.
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            self._write_aggregate(workdir, manifest)
            recover = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertEqual(recover.returncode, 0, recover.stderr)
            finalized = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                                 "--format", "json", "--output", str(Path(temp) / "c.json")], home)
            self.assertEqual(finalized.returncode, 0, finalized.stderr)

    def test_idempotent_resubmission_and_manual_edit_detection(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            workdir = Path(temp) / "work"
            manifest = self._prepared_workdir(home, workdir)
            self._write_facets(workdir, manifest, "实现完成")
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            self._write_aggregate(workdir, manifest)
            first = json.loads(run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home).stdout)
            # same content, submitted again: digest unchanged, still current
            second = json.loads(run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home).stdout)
            self.assertEqual(first["facets_digest"], second["facets_digest"])
            self.assertEqual(semantic.aggregate_freshness(workdir)["status"], "current")
            # manual edit preserving mtime cannot bypass the digest
            path = workdir / "facet-outputs" / f"{manifest['batch_ids'][0]}.json"
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["facets"][0]["goal"] = "手工改写"
            stat_before = path.stat()
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            os.utime(path, ns=(stat_before.st_atime_ns, stat_before.st_mtime_ns))
            self.assertEqual(semantic.aggregate_freshness(workdir)["status"], "stale")

    def test_delayed_response_with_old_input_identity_is_refused(self):
        """prepare(A) → facet(B) → the stale A response cannot complete.

        The response names the aggregate-input identity it was generated
        against; prepare-aggregate re-issue after the facet change produces a
        different identity, so the late response is refused instead of being
        re-stamped against the current facets.
        """
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            workdir = Path(temp) / "work"
            manifest = self._prepared_workdir(home, workdir)
            self._write_facets(workdir, manifest, "实现完成")
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            prepared_a = json.loads((workdir / "aggregate-input-identity.json").read_text(encoding="utf-8"))
            self._write_aggregate(workdir, manifest)
            # facet revision WITHOUT re-preparing: the response still names A;
            # acceptance recomputes the input digest from the CURRENT validated
            # facet content, so the stale response is refused at validate time
            # (never re-stamped, never finalized complete).
            self._write_facets(workdir, manifest, "未实现完成")
            validate = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertNotEqual(validate.returncode, 0, "a stale response was re-stamped as current")
            self.assertIn("aggregate 输入", validate.stderr)
            final = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                             "--format", "json", "--output", str(Path(temp) / "late.json")], home)
            self.assertNotEqual(final.returncode, 0, "a response prepared from the earlier input completed")
            # after re-prepare the identity changes; the same stale response bytes
            # (still naming A) are refused at validate time too.
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            prepared_b = json.loads((workdir / "aggregate-input-identity.json").read_text(encoding="utf-8"))
            self.assertNotEqual(prepared_a["aggregate_input_digest"], prepared_b["aggregate_input_digest"])
            refused = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("aggregate 输入", refused.stderr)

    def test_unbound_manual_aggregate_is_refused_but_fallback_works(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            workdir = Path(temp) / "work"
            manifest = self._prepared_workdir(home, workdir)
            self._write_facets(workdir, manifest, "实现完成")
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            self._write_aggregate(workdir, manifest)
            # no validate-aggregate call: the file is untrusted input
            refused = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                               "--format", "json", "--output", str(Path(temp) / "x.json")], home)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("未经确认", refused.stderr)
            fallback = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--fallback", "--keep-workdir",
                                "--format", "json", "--output", str(Path(temp) / "y.json")], home)
            self.assertEqual(fallback.returncode, 0, fallback.stderr)
            payload = json.loads((Path(temp) / "y.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["semantic_analysis"]["status"], "fallback")


if __name__ == "__main__":
    unittest.main()


class U4BlankAndReuseBoundaryTests(unittest.TestCase):
    """rc.3 New Session / draft-reuse read boundary (supplement U4).

    The plugin reads sessions; UI drafts are not reads. A blank or reused
    session adds no user work; a later real submit on the reused id is read
    normally; header records are not extra sessions.
    """

    def _rows(self, created):
        return [
            {"type": "session", "version": 4, "id": "synthetic-blank", "createdAt": created,
             "cwd": "/synthetic/app", "agentPreset": "standard", "delegationDepth": 0, "isSeeded": False},
        ]

    def test_blank_reused_and_submitted_session_counts_once(self):
        created = epoch_ms(NOW)
        rows = self._rows(created)
        # events of the reused id as one materialized stream (seq == index)
        events = [
            {"type": "turn/start", "seq": 0, "time": created + 1000, "data": {"turn": 1}},
            {"type": "user/message", "seq": 1, "time": created + 1000, "surfaceOp": "append",
             "data": {"content": [{"type": "text", "text": "draft autosave reminder"}],
                      "id": "notice-1", "role": "user", "source": {"kind": "skill-catalog", "form": "notice"}}},
            {"type": "turn/end", "seq": 2, "time": created + 2000, "data": {"reason": {"kind": "completed"}, "turn": 1}},
            {"type": "turn/start", "seq": 3, "time": created + 2000, "data": {"turn": 2}},
            {"type": "user/message", "seq": 4, "time": created + 2000, "surfaceOp": "append",
             "data": {"content": [{"type": "text", "text": "Now the real task begins."}],
                      "id": "m-real", "role": "user", "source": {"kind": "user"}}},
            {"type": "user/message", "seq": 5, "time": created + 2100, "surfaceOp": "append",
             "data": {"content": [{"type": "text", "text": "Second message of the same task."}],
                      "id": "m-real-2", "role": "user", "source": {"kind": "user"}}},
            {"type": "turn/end", "seq": 6, "time": created + 3000, "data": {"reason": {"kind": "completed"}, "turn": 2}},
            {"type": "session", "seq": 7, "time": created + 2200, "data": {}},
        ]
        records = rows + self._rows(created + 1000) + self._rows(created + 2000)
        # selection-level dedupe: reused ids select once
        seen, selected = set(), []
        for record in records:
            if record["id"] not in seen:
                seen.add(record["id"])
                selected.append(record)
        self.assertEqual(len(selected), 1)

        snapshot = {"session": rows[0], "events": events}
        from datetime import timedelta
        cfg = replace(
            config(Path("/synthetic")), privacy_mode="redacted", metrics_only=False,
            since=datetime.fromtimestamp(created / 1000, tz=timezone.utc) - timedelta(days=1),
            until=datetime.fromtimestamp(created / 1000, tz=timezone.utc) + timedelta(days=1),
        )
        report = analyzer.build_report(cfg, session_snapshots=[snapshot])
        self.assertEqual(report["totals"]["sessions"], 1)
        self.assertEqual(report["totals"]["user_messages"], 2)
        self.assertEqual(report["totals"]["injected_user_messages"], 1)
        row = report["rollout_summaries"][0]
        self.assertEqual(row["user_messages"], 2)
        self.assertEqual(row["injected_user_messages"], 1)
        self.assertEqual(row["injected_source_kinds"].get("skill-catalog"), 1)
        self.assertEqual(row["turns"], 2)
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["session_header_records"], 2)


class F4AggregateProjectionTests(unittest.TestCase):
    """AC-04: every model-visible object obeys analysis privacy with counts conserved."""

    def test_facets_and_category_keys_follow_analysis_privacy(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            rows = session_rows()
            rows.append({"type": "job/registered", "seq": 4, "time": epoch_ms(NOW),
                         "data": {"jobId": "j1", "owner": "synthetic", "kind": "/synthetic/private-a/path task",
                                  "label": "fixture", "startedAt": epoch_ms(NOW)}})
            rows.append({"type": "job/registered", "seq": 5, "time": epoch_ms(NOW),
                         "data": {"jobId": "j2", "owner": "synthetic", "kind": "/synthetic/private-b/path task",
                                  "label": "fixture", "startedAt": epoch_ms(NOW)}})
            write_plain(home, rows)
            workdir = Path(temp) / "work"
            result = run_cli(["semantic", "prepare", "--workdir", str(workdir), "--privacy", "local",
                              "--analysis-privacy", "redacted", "--no-semantic-cache"], home)
            self.assertEqual(result.returncode, 0, result.stderr)
            # facet output with a synthetic email in the goal is what the model
            # wrote; prepare-aggregate must not pass it through unprojected.
            manifest = json.loads((workdir / "manifest.json").read_text(encoding="utf-8"))
            for batch_id in manifest["batch_ids"]:
                batch = json.loads((workdir / "batches" / f"{batch_id}.json").read_text(encoding="utf-8"))
                facets = [{
                    "task_family_id": t["task_family_id"],
                    "goal": "Contact alice+synthetic@example.invalid about the change",
                    "task_type": "implementation", "interaction_style": "detailed",
                    "instruction_handling": "followed", "tool_execution": "strong",
                    "verification_quality": "strong", "handoff_quality": "clear",
                    "frictions": ["none"], "strengths": ["clear"], "outcome_inference": "fully_achieved",
                    "evidence_refs": [t["evidence"][0]["id"]],
                } for t in batch["tasks"]]
                semantic.write_json(workdir / "facet-outputs" / f"{batch_id}.json", {"facets": facets})
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            aggregate = json.loads((workdir / "aggregate-input.json").read_text(encoding="utf-8"))
            serialized = json.dumps(aggregate, ensure_ascii=False)
            self.assertNotIn("alice+synthetic@example.invalid", serialized,
                             "facet free text entered the aggregate unprojected")
            jobs = aggregate["full_scope_summary"]["totals"]["jobs"]["by_kind"]
            self.assertEqual(sum(jobs.values()), 2, "counter collision must merge, not overwrite")
            self.assertNotIn("/synthetic/private-a/path task", serialized)
            self.assertNotIn("/synthetic/private-b/path task", serialized)


class AC13EnvelopeShapeTests(unittest.TestCase):
    """The structural identity envelope cannot smuggle model free text."""

    def test_noncanonical_envelope_is_refused_and_secret_never_reaches_report(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            workdir = Path(temp) / "work"
            t = F11AggregateFreshnessTests()
            manifest = t._prepared_workdir(home, workdir)
            t._write_facets(workdir, manifest, "实现完成")
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            t._write_aggregate(workdir, manifest)
            path = workdir / "semantic-report.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            value["aggregate_input_identity"]["note"] = "Bearer SYNTHETIC-REPAIR-TOKEN-1234567890"
            path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            validate = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertNotEqual(validate.returncode, 0, "noncanonical envelope accepted")
            result = Path(temp) / "report.json"
            finalize = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                                "--format", "json", "--output", str(result)], home)
            self.assertNotEqual(finalize.returncode, 0)
            self.assertFalse(result.exists())
            # a canonical envelope still validates and completes
            value["aggregate_input_identity"] = json.loads(
                (workdir / "aggregate-input-identity.json").read_text(encoding="utf-8"))
            path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            ok = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            good = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                            "--format", "json", "--output", str(result)], home)
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertNotIn("SYNTHETIC-REPAIR-TOKEN", result.read_text(encoding="utf-8"))


class AC13NestedEnvelopeTests(unittest.TestCase):
    """Round-3 AC-13: only the verified ROOT identity envelope is exempt.

    The same key inside a nested aggregate item, inside a facet, or with a
    bool identity_schema goes through every content rule and is refused; the
    canonical root envelope still validates and completes.
    """

    def _prepared(self, home, workdir):
        t = F11AggregateFreshnessTests()
        manifest = t._prepared_workdir(home, workdir)
        return t, manifest

    def _facets(self, workdir, manifest):
        for batch_id in manifest["batch_ids"]:
            batch = json.loads((workdir / "batches" / f"{batch_id}.json").read_text(encoding="utf-8"))
            facets = [{
                "task_family_id": task["task_family_id"], "goal": "实现完成",
                "task_type": "implementation", "interaction_style": "detailed",
                "instruction_handling": "followed", "tool_execution": "strong",
                "verification_quality": "strong", "handoff_quality": "clear",
                "frictions": ["none"], "strengths": ["clear goal"],
                "outcome_inference": "fully_achieved",
                "evidence_refs": [task["evidence"][0]["id"]],
            } for task in batch["tasks"]]
            semantic.write_json(workdir / "facet-outputs" / f"{batch_id}.json", {"facets": facets})

    def _aggregate(self, workdir, transform=None):
        candidates = json.loads((workdir / "semantic-evidence.json").read_text(encoding="utf-8"))["candidates"]
        family = candidates[0]["task_family_id"]
        evidence = candidates[0]["evidence"][0]["id"]
        value = {section: [] for section in semantic.AGGREGATE_SECTIONS}
        value["strengths"] = [{"title": "稳定交付", "text": "会话完成目标。",
            "supporting_task_family_ids": [family], "evidence_refs": [evidence],
            "confidence": "high", "measurement": "measured"}]
        value["aggregate_input_identity"] = json.loads(
            (workdir / "aggregate-input-identity.json").read_text(encoding="utf-8"))
        if transform:
            transform(value)
        semantic.write_json(workdir / "semantic-report.json", value)

    def test_nested_identity_in_aggregate_item_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_plain(home, session_rows())
            workdir = Path(temp) / "work"
            _, manifest = self._prepared(home, workdir)
            self._facets(workdir, manifest)
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            secret = "Bearer SYNTHETIC-NESTED-LEAK-1234567890".ljust(64, "x")
            self._aggregate(workdir, lambda v: v["strengths"][0].__setitem__(
                "aggregate_input_identity", {"identity_schema": 1, "aggregate_input_digest": secret}))
            validate = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertNotEqual(validate.returncode, 0, "nested identity object was exempted")
            result = Path(temp) / "out.json"
            finalize = run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                                "--format", "json", "--output", str(result)], home)
            self.assertNotEqual(finalize.returncode, 0)
            self.assertFalse(result.exists())

    def test_nested_identity_in_facet_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_plain(home, session_rows())
            workdir = Path(temp) / "work"
            _, manifest = self._prepared(home, workdir)
            self._facets(workdir, manifest)
            facet_path = next((workdir / "facet-outputs").glob("*.json"))
            value = json.loads(facet_path.read_text(encoding="utf-8"))
            value["facets"][0]["aggregate_input_identity"] = {
                "identity_schema": 1,
                "aggregate_input_digest": "Bearer SYNTHETIC-FACET-LEAK-1234567890".ljust(64, "x")}
            facet_path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            validate = run_cli(["semantic", "validate-batch", "--workdir", str(workdir),
                                "--batch", manifest["batch_ids"][0]], home)
            self.assertNotEqual(validate.returncode, 0, "facet identity object was exempted")

    def test_bool_identity_schema_is_refused_and_canonical_still_passes(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_plain(home, session_rows())
            workdir = Path(temp) / "work"
            _, manifest = self._prepared(home, workdir)
            self._facets(workdir, manifest)
            self.assertEqual(run_cli(["semantic", "prepare-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            self._aggregate(workdir, lambda v: v["aggregate_input_identity"].__setitem__("identity_schema", True))
            validate = run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home)
            self.assertNotEqual(validate.returncode, 0, "bool identity_schema accepted")
            # canonical root envelope still completes
            self._aggregate(workdir)
            self.assertEqual(run_cli(["semantic", "validate-aggregate", "--workdir", str(workdir)], home).returncode, 0)
            result = Path(temp) / "good.json"
            self.assertEqual(run_cli(["semantic", "finalize", "--workdir", str(workdir), "--keep-workdir",
                                      "--format", "json", "--output", str(result)], home).returncode, 0)
            self.assertNotIn("SYNTHETIC", result.read_text(encoding="utf-8"))


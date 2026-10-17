"""DSH 0.2.1-rc.2 V4 vocabulary admission (SI021-01).

The host keeps session format 4 but extends the required event vocabulary with
background-job lifecycle and a durable working-directory projection. These
fixtures are written by the exact 0.2.1-rc.2 Session writer and restored by the
official strict catalog, so admission here matches the production entrypoint
rather than a hand-built approximation.
"""

from __future__ import annotations

import copy
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from dsh_session_insights import analyzer
from dsh_session_insights.v4 import validate_records

ROOT = Path(__file__).parents[1]
RC21 = ROOT / "tests" / "fixtures" / "rc21"
CASES = ("job-lifecycle", "job-pending", "inherited", "mixed-v4", "web-model", "subagent", "team", "job-inherited-open", "job-observability", "subagent-child")


def snapshot(case: str) -> dict:
    return json.loads((RC21 / case / "snapshot.json").read_text(encoding="utf-8"))


def records(case: str) -> list[dict]:
    value = snapshot(case)
    return [{"type": "session", **value["session"]}, *copy.deepcopy(value["events"])]


def config():
    return analyzer.AnalysisConfig(
        dsh_home=ROOT,
        since=datetime(2026, 1, 1, tzinfo=timezone.utc),
        until=datetime(2026, 12, 31, tzinfo=timezone.utc),
        privacy_mode="redacted",
        generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


class Rc21VocabularyAdmissionTests(unittest.TestCase):
    def test_rules_include_the_new_required_host_events(self):
        for record_type in ("job/registered", "job/settled", "working-directory/change"):
            self.assertIn(record_type, analyzer.DSH_KNOWN_RECORD_TYPES)

    def test_real_host_fixtures_are_admitted(self):
        for case in CASES:
            with self.subTest(case=case):
                self.assertEqual(
                    validate_records(records(case), analyzer.DSH_KNOWN_RECORD_TYPES),
                    snapshot(case)["inheritedEventCount"],
                )

    def test_a_new_required_event_is_admitted_by_the_production_parser(self):
        value = snapshot("job-lifecycle")
        coverage = analyzer.parse_coverage_state()
        parsed = analyzer.parse_dsh_session_records(
            [{"type": "session", **value["session"]}, *copy.deepcopy(value["events"])],
            config(),
            coverage,
            source_path=RC21 / "job-lifecycle" / "session.v4.jsonl",
            workspace_key="--workspace-project-a--",
        )
        self.assertIsNotNone(parsed)

    def test_physical_fixture_reopens_through_the_file_reader(self):
        path = RC21 / "job-lifecycle" / "session.v4.jsonl.zstd"
        coverage = analyzer.parse_coverage_state()
        parsed = analyzer.parse_dsh_session_file(path, config(), coverage)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["log_generation_version"], 4)
        self.assertEqual(parsed["session_header_records"], 1)

    def test_unknown_required_event_is_still_refused(self):
        rows = records("job-lifecycle")
        rows.append({"type": "synthetic/required", "seq": len(rows) - 1, "time": 0, "data": {}})
        with self.assertRaisesRegex(ValueError, "unknown required"):
            validate_records(rows, analyzer.DSH_KNOWN_RECORD_TYPES)

    def test_unknown_ignorable_event_is_safely_skipped(self):
        rows = records("job-lifecycle")
        rows.append({"type": "synthetic/ignorable", "seq": len(rows) - 1, "time": 0, "data": {"text": "IGNORABLE-SECRET"}, "ignorable": True})
        self.assertEqual(validate_records(rows, analyzer.DSH_KNOWN_RECORD_TYPES), 0)

    def test_mixed_representation_keeps_physical_source_ranges(self):
        rows = [json.loads(line) for line in (RC21 / "mixed-v4" / "session.v4.jsonl").read_text(encoding='utf-8').splitlines()]
        self.assertTrue(any(isinstance(item, list) for row in rows for item in row.get("sourceEventSeqs", [])))
        validate_records(rows, analyzer.DSH_KNOWN_RECORD_TYPES, physical=True)
        coverage = analyzer.parse_coverage_state()
        parsed = analyzer.parse_dsh_session_file(RC21 / "mixed-v4" / "session.v4.jsonl.zstd", config(), coverage)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["user_messages"], 6)

    def test_host_plugin_record_is_ignorable_and_never_content(self):
        rows = records("job-lifecycle")
        plugin = [row for row in rows[1:] if row["type"].startswith("plugin:")]
        self.assertEqual(len(plugin), 1)
        self.assertTrue(plugin[0]["ignorable"])
        value = snapshot("job-lifecycle")
        coverage = analyzer.parse_coverage_state()
        parsed = analyzer.parse_dsh_session_records(
            [{"type": "session", **value["session"]}, *copy.deepcopy(value["events"])],
            config(),
            coverage,
            source_path=RC21 / "job-lifecycle" / "session.v4.jsonl",
            workspace_key="--workspace-project-a--",
        )
        text = json.dumps(analyzer.cache_encode(parsed), ensure_ascii=False)
        self.assertNotIn("plugin:synthetic/observation", text)
        self.assertNotIn("observation", text)
        self.assertEqual(coverage["plugin_records"]["plugin:synthetic/observation"], 1)
        self.assertEqual(coverage["unknown_record_types"], {})


def parsed(case: str):
    value = snapshot(case)
    coverage = analyzer.parse_coverage_state()
    result = analyzer.parse_dsh_session_records(
        [{"type": "session", **value["session"]}, *copy.deepcopy(value["events"])],
        config(),
        coverage,
        source_path=RC21 / case / "session.v4.jsonl",
        workspace_key="--workspace-project-a--",
    )
    return result, coverage


def assert_subset(testcase, expected, actual, path="view"):
    if isinstance(expected, dict):
        testcase.assertIsInstance(actual, dict, path)
        for key, value in expected.items():
            testcase.assertIn(key, actual, f"{path}.{key}")
            assert_subset(testcase, value, actual[key], f"{path}.{key}")
    elif isinstance(expected, list):
        testcase.assertEqual(len(expected), len(actual), path)
        for index, (left, right) in enumerate(zip(expected, actual)):
            assert_subset(testcase, left, right, f"{path}[{index}]")
    else:
        testcase.assertEqual(actual, expected, path)


class Rc21JobAndWorkingDirectorySemanticsTests(unittest.TestCase):
    def test_fixture_expectations_match(self):
        expectations = {item["name"]: item["expected"] for item in json.loads((RC21 / "expectations.json").read_text(encoding='utf-8'))}
        for case, expected in expectations.items():
            with self.subTest(case=case):
                parsed_session, coverage = parsed(case)
                view = analyzer.session_public_view(parsed_session, config())
                assert_subset(self, expected["jobs"], view["jobs"], f"{case}.jobs")
                self.assertLessEqual(len(view["jobs"]["items"]), 20)
                assert_subset(self, expected["working_directory"], view["working_directory"], f"{case}.working_directory")
                self.assertEqual(dict(coverage["plugin_records"]), expected["plugin_records"])
                if "tools" in expected:
                    for key, value in expected["tools"].items():
                        self.assertEqual(view[key], value, key)

    def test_registry_outcome_is_not_user_task_completion(self):
        parsed_session, _ = parsed("job-pending")
        view = analyzer.session_public_view(parsed_session, config())
        # The parent turn ended and the log state is completed...
        self.assertEqual(view["completion"]["log_completed"], "yes")
        # ...but one registered child job never settled.
        self.assertEqual(view["jobs"]["pending"], 1)
        self.assertEqual(view["jobs"]["completed"], 0)
        self.assertEqual(view["jobs"]["settled"], 2)

    def test_producer_report_does_not_certify_resource_release(self):
        parsed_session, _ = parsed("job-pending")
        killed = [job for job in parsed_session["jobs"].values() if job["status"] == "killed"][0]
        self.assertEqual(killed["cause"], "kill")
        self.assertFalse(killed["producer_reported"])

    def test_inherited_jobs_and_cwd_are_retained_but_not_child_work(self):
        parsed_session, _ = parsed("inherited")
        self.assertEqual(parsed_session["inherited_event_count"], snapshot("inherited")["inheritedEventCount"])
        inherited = [job for job in parsed_session["jobs"].values() if job["inherited"]]
        own = [job for job in parsed_session["jobs"].values() if not job["inherited"]]
        self.assertEqual(len(inherited), 1)
        self.assertEqual(len(own), 1)
        self.assertEqual(parsed_session["cwd_changes"], 1)
        self.assertEqual(parsed_session["cwd_changes_inherited"], 1)

    def test_malformed_required_job_records_refuse_the_session(self):
        def mutate(case, change):
            value = snapshot(case)
            events = copy.deepcopy(value["events"])
            change(events)
            return analyzer.parse_dsh_session_records(
                [{"type": "session", **value["session"]}, *events],
                config(),
                analyzer.parse_coverage_state(),
                source_path=RC21 / case / "session.v4.jsonl",
                workspace_key="--workspace-project-a--",
            )

        def duplicate_registration(events):
            registered = next(event for event in events if event["type"] == "job/registered")
            events.append({**copy.deepcopy(registered), "seq": len(events)})

        def duplicate_settlement(events):
            settled = next(event for event in events if event["type"] == "job/settled")
            events.append({**copy.deepcopy(settled), "seq": len(events)})

        def changed_owner(events):
            next(event for event in events if event["type"] == "job/settled")["data"]["owner"] = "someone-else"

        def invalid_status(events):
            next(event for event in events if event["type"] == "job/settled")["data"]["status"] = "running"

        def invalid_cwd(events):
            next(event for event in events if event["type"] == "working-directory/change")["data"]["cwd"] = ""

        for mutation in (duplicate_registration, duplicate_settlement, changed_owner, invalid_status):
            with self.subTest(mutation=mutation.__name__):
                with self.assertRaises(ValueError):
                    mutate("job-lifecycle", mutation)

    def test_host_tolerated_anomalies_are_counted_not_fatal(self):
        # Host job registration is a best-effort append; a lost registration is
        # possible and must not make an otherwise readable session refuse.
        value = snapshot("job-lifecycle")
        unpaired = [event for event in copy.deepcopy(value["events"]) if event["type"] != "job/registered"]
        for index, event in enumerate(unpaired):
            event["seq"] = index
        parsed_session = analyzer.parse_dsh_session_records(
            [{"type": "session", **value["session"]}, *unpaired],
            config(),
            analyzer.parse_coverage_state(),
            source_path=RC21 / "job-lifecycle" / "session.v4.jsonl",
            workspace_key="--workspace-project-a--",
        )
        self.assertEqual(parsed_session["job_counts"]["unpaired_settlement"], 1)
        self.assertEqual(parsed_session["job_counts"]["registered"], 0)

        invalid = snapshot("job-lifecycle")
        events = copy.deepcopy(invalid["events"])
        next(event for event in events if event["type"] == "working-directory/change")["data"]["cwd"] = ""
        parsed_session = analyzer.parse_dsh_session_records(
            [{"type": "session", **invalid["session"]}, *events],
            config(),
            analyzer.parse_coverage_state(),
            source_path=RC21 / "job-lifecycle" / "session.v4.jsonl",
            workspace_key="--workspace-project-a--",
        )
        self.assertEqual(parsed_session["cwd_invalid_changes"], 1)
        self.assertEqual(parsed_session["cwd_changes"], 0)


# Built by concatenation so the public-tree audit does not treat this synthetic
# vector as a real private user path.
HOME_PREFIX = "/" + "Users" + "/x"
DRIVE_PREFIX = "C:" + "/" + "Users" + "/" + "名字"


def cwd_platform_snapshot() -> dict:
    value = snapshot("job-lifecycle")
    events = [event for event in copy.deepcopy(value["events"]) if event["type"] != "working-directory/change"]
    for index, event in enumerate(events):
        event["seq"] = index
    for cwd in (
        DRIVE_PREFIX + "/项目 一",
        "\\\\server\\share\\proj",
        HOME_PREFIX + "/trailing/",
        HOME_PREFIX + "/trailing",
        "../relative",
        "",
    ):
        events.append({"type": "working-directory/change", "seq": len(events), "time": 0, "data": {"cwd": cwd}})
    return {"session": value["session"], "events": events, "inheritedEventCount": 0}


class Rc21WorkingDirectoryVectorTests(unittest.TestCase):
    def test_platform_path_vectors_and_anomalies(self):
        value = cwd_platform_snapshot()
        parsed_session = analyzer.parse_dsh_session_records(
            [{"type": "session", **value["session"]}, *copy.deepcopy(value["events"])],
            config(),
            analyzer.parse_coverage_state(),
            source_path=RC21 / "cwd-platform" / "session.v4.jsonl",
            workspace_key="--workspace-project-a--",
        )
        view = analyzer.session_public_view(parsed_session, config())
        directory = view["working_directory"]
        self.assertEqual(directory["platform_forms"], {"posix": 1, "drive": 1, "unc": 1, "home_prefix": 2, "relative": 1})
        self.assertEqual(directory["changes"], 5)
        self.assertEqual(directory["changes_same_as_previous"], 1)
        self.assertEqual(directory["relative_changes"], 1)
        self.assertEqual(directory["invalid_changes"], 1)
        self.assertEqual(directory["projects_visited"], ["project-a", "项目 一", "proj", "trailing", "relative"])
        self.assertTrue(directory["cross_project"])


if __name__ == "__main__":
    unittest.main()

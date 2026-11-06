"""rc.1 structured caller-cancellation regression corpus (repair round for
the 0.8.0 candidate review F1/F2 findings).

The three physical fixtures under ``tests/fixtures/rc1-cancellation/`` are
byte-identical logs that the official strict/current catalog reopens (proven
in the JavaScript contract run), so every positive case here is a real
host-admissible log — never an isolated copied result with a rewritten turn.

F1: inherited calls keep their scoped identity across the inherited cut.
F2: final semantic batch evidence IDs address one fact each and the facet
reference consumer resolves them.
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dsh_session_insights import analyzer

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "rc1-cancellation"


def load_snapshot(name: str) -> dict:
    rows = [json.loads(line) for line in (FIXTURES / name / "session.v4.jsonl").read_text(encoding="utf-8").splitlines()]
    header = dict(rows[0])
    header.pop("type")
    return {"session": header, "events": rows[1:]}


def config_for(session_header: dict, **overrides):
    now = datetime.fromtimestamp((session_header["createdAt"] + 86400000) / 1000, tz=timezone.utc)
    values = dict(
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
    values.update(overrides)
    return analyzer.AnalysisConfig(**values)


def build(session_snapshot: dict):
    report, sessions = analyzer.build_report(
        config_for(session_snapshot["session"]),
        session_snapshots=[session_snapshot],
        include_internal_sessions=True,
    )
    return report, report["session_summaries"][0], sessions[0]["semantic_messages"]


def cancelled_facts(messages: list[dict]) -> list[dict]:
    return [m["tool_facts"] for m in messages if m.get("tool_facts", {}).get("outcome") == "cancelled"]


def native_build(session_snapshot: dict) -> dict:
    """Run the JavaScript analyzer over the same snapshot and return its build."""
    payload = json.dumps(
        {
            "snapshots": [session_snapshot],
            "options": {
                "now": session_snapshot["session"]["createdAt"] + 86400000,
                "days": 30,
                "privacy": "redacted",
                "locale": "en",
                "analysis_depth": "evidence",
            },
        }
    )
    result = subprocess.run(
        ["node", str(ROOT / "tests-js" / "fixtures" / "native-report.mjs")],
        input=payload, text=True, encoding="utf-8", capture_output=True,
        env={**os.environ, "DSH_RUNTIME": os.environ.get("DSH_RUNTIME", str(ROOT / "tests" / "dsh-runtime"))},
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


class InheritedCancellationIdentityTests(unittest.TestCase):
    """F1: scoped call identity travels across the inherited cut."""

    def test_inherited_ptc_cancellation_keeps_scoped_identity(self):
        snapshot = load_snapshot("inherited-ptc")
        report, session, messages = build(snapshot)
        facts = cancelled_facts(messages)
        self.assertEqual(len(facts), 1)
        self.assertEqual(
            facts[0],
            {
                "tool": "bash",
                "outcome": "cancelled",
                "cancelled": "ABORTED",
                "record_identity": '["fixture-call-1:ptc:1",null,null]',
                "call_id": "fixture-call-1:ptc:1",
                "turn": None,
                "step": None,
                "exit_code": None,
                "cause": None,
                "verification": True,
                "state_change": False,
                "git_commit": False,
            },
        )
        self.assertEqual(session["tool_execution"]["inner_cancelled"], 1)
        self.assertEqual(report["totals"]["tool_failures"], 0)

    def test_inherited_outer_cancellation_keeps_scoped_identity(self):
        snapshot = load_snapshot("inherited-outer")
        report, session, messages = build(snapshot)
        facts = cancelled_facts(messages)
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["tool"], "bash")
        self.assertEqual(facts[0]["verification"], True, "the inherited bash npm-test call keeps its verification fact")
        self.assertEqual(facts[0]["record_identity"], '["fixture-call-7",1,1]')
        self.assertEqual(session["tool_execution"]["outer_cancelled"], 1)
        self.assertEqual(report["totals"]["tool_failures"], 0)

    def test_cancelled_result_without_matching_scope_stays_unknown(self):
        snapshot = load_snapshot("inherited-outer")
        orphan = copy.deepcopy(snapshot)
        orphan["events"][6]["data"]["message"]["source"]["callId"] = "fixture-call-never-recorded"
        orphan["events"][6]["data"]["message"]["toolCallId"] = "fixture-call-never-recorded"
        from dsh_session_insights.v4 import validate_records

        records = [{"type": "session", **orphan["session"]}, *orphan["events"]]
        validate_records(records, analyzer.DSH_KNOWN_RECORD_TYPES)
        _, _, messages = build(orphan)
        facts = cancelled_facts(messages)
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["tool"], "unknown", "missing scoped match keeps unknown")
        self.assertFalse(facts[0]["verification"])
        self.assertEqual(facts[0]["record_identity"], '["fixture-call-never-recorded",1,1]')

    def test_cancel_facts_agree_with_the_native_analyzer(self):
        # Compare the final tool facts and scope — not only counters — across
        # both runtimes on the same strict-valid inputs.
        for name in ("inherited-ptc", "inherited-outer"):
            snapshot = load_snapshot(name)
            _, _, messages = build(snapshot)
            reference = cancelled_facts(messages)
            native = native_build(snapshot)
            native_facts = [
                m["tool_facts"]
                for m in native["sessions"][0]["messages"]
                if m.get("tool_facts", {}).get("outcome") == "cancelled"
            ]
            self.assertEqual(reference, native_facts, name)


class CancellationBatchIdentityTests(unittest.TestCase):
    """F2: final batch evidence IDs address one fact; references resolve."""

    def _prepare(self, home: Path, workspace="--workspace-project-a--", session_id="synthetic-fixture-001"):
        rows = [json.loads(line) for line in (FIXTURES / "repeated-cancellation" / "session.v4.jsonl").read_text(encoding="utf-8").splitlines()]
        session_dir = home / "sessions" / workspace / session_id
        session_dir.mkdir(parents=True)
        import zstandard

        lines = [json.dumps(row, ensure_ascii=False, sort_keys=True) for row in rows]
        compressor = zstandard.ZstdCompressor(level=3, write_checksum=True)
        encoded = compressor.compress((lines[0] + "\n").encode("utf-8"))
        encoded += compressor.compress(("\n".join(lines[1:]) + "\n").encode("utf-8"))
        (session_dir / "session.v4.jsonl.zstd").write_bytes(encoded)
        command = [
            sys.executable, "-m", "dsh_session_insights", "semantic", "prepare",
            "--workdir", str(home / "work"), "--days", "120", "--no-semantic-cache",
        ]
        result = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT),
            env={**os.environ, "PYTHONPATH": str(ROOT / "src"), "DSH_HOME": str(home)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((home / "work" / "manifest.json").read_text(encoding="utf-8"))

    def _cancelled_ids(self, home: Path, manifest: dict) -> list[str]:
        ids = []
        for batch_id in manifest["batch_ids"]:
            batch = json.loads((home / "work" / "batches" / f"{batch_id}.json").read_text(encoding="utf-8"))
            for task in batch["tasks"]:
                for item in task["evidence"]:
                    if item.get("tool_facts", {}).get("outcome") == "cancelled":
                        ids.append(item["id"])
        return ids

    def test_same_tool_and_code_in_two_turns_get_unique_evidence_ids(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            manifest = self._prepare(home)
            ids = self._cancelled_ids(home, manifest)
            self.assertEqual(len(ids), 2, "both cancellations reach the final batch")
            self.assertNotEqual(ids[0], ids[1], "different turns must not share an evidence ID")
            turns = []
            for batch_id in manifest["batch_ids"]:
                batch = json.loads((home / "work" / "batches" / f"{batch_id}.json").read_text(encoding="utf-8"))
                for task in batch["tasks"]:
                    for item in task["evidence"]:
                        facts = item.get("tool_facts") or {}
                        if facts.get("outcome") == "cancelled":
                            turns.append(facts["turn"])
            self.assertEqual(sorted(turns), [1, 2])

    def test_facet_references_resolve_to_the_distinct_facts(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            manifest = self._prepare(home)
            ids = self._cancelled_ids(home, manifest)
            self.assertEqual(len(ids), 2)
            from dsh_session_insights import semantic

            workdir = home / "work"
            batch_id = manifest["batch_ids"][0]
            facets = []
            for batch_id_iter in manifest["batch_ids"]:
                batch = json.loads((workdir / "batches" / f"{batch_id_iter}.json").read_text(encoding="utf-8"))
                for task in batch["tasks"]:
                    facets.append({
                        "task_family_id": task["task_family_id"],
                        "goal": "Run the suite",
                        "task_type": "implementation",
                        "interaction_style": "detailed",
                        "instruction_handling": "followed",
                        "tool_execution": "strong",
                        "verification_quality": "strong",
                        "handoff_quality": "clear",
                        "frictions": [],
                        "strengths": [],
                        "outcome_inference": "mostly_achieved",
                        "evidence_refs": list(ids),
                    })
            output = {"facets": facets}
            (workdir / "facet-outputs").mkdir(exist_ok=True)
            (workdir / "facet-outputs" / f"{batch_id}.json").write_text(
                json.dumps(output, ensure_ascii=False), encoding="utf-8")
            accepted = semantic.validate_batch_file(workdir, batch_id)
            self.assertEqual([facet["evidence_refs"] for facet in accepted], [list(ids)])

            # A fabricated reference must be refused: IDs address facts.
            bad = copy.deepcopy(facets)
            bad[0]["evidence_refs"] = list(ids) + ["evidence-0000000000000000000"]
            (workdir / "facet-outputs" / f"{batch_id}.json").write_text(
                json.dumps({"facets": bad}, ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(ValueError) as refused:
                semantic.validate_batch_file(workdir, batch_id)
            self.assertIn("未知证据", str(refused.exception))


if __name__ == "__main__":
    unittest.main()

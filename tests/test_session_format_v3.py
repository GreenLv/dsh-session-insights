"""Native V3 session-format regression coverage.

These tests fix the behavior table for versioned session logs:

* one log generation per logical session, chosen by canonical filename
  version rather than mtime;
* a corrupt, unknown-newer, or encoding-mismatched current generation is
  diagnosed instead of silently reported from an older one;
* `system/message` and synthetic `user/message` context are never user work;
* `assistant/attempt` is counted without fabricating a delivered reply;
* a `surfaceOp` replacement shadows conversation text out of the semantic
  summary while historical tool and token statistics stay intact.

Passing legacy fixtures does not establish any of this.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import zstandard

from dsh_session_insights import analyzer

from helpers import NOW, compress_dsh_generation


NOW_DT = datetime.fromisoformat(NOW.replace("Z", "+00:00"))
STAMP = int(NOW_DT.timestamp() * 1000)
WORKSPACE = "--workspace-project-a--"
CWD = "/workspace/project-a"


def v3_header(session_id: str) -> dict:
    return {
        "type": "session",
        "version": 3,
        "id": session_id,
        "createdAt": STAMP,
        "cwd": CWD,
        "isSeeded": False,
        "delegationDepth": 0,
        "agentPreset": "standard",
    }


def text_block(text: str) -> dict:
    return {"type": "text", "text": text}


def event(seq: int, record_type: str, data: dict, *, surface_op=None, time_ms: int | None = None) -> dict:
    record = {
        "type": record_type,
        "seq": seq,
        "time": STAMP + seq if time_ms is None else time_ms,
        "data": data,
    }
    if surface_op is not None:
        record["surfaceOp"] = surface_op
    return record


def message(message_id: str, role: str, source: dict, text: str, *, extra_blocks: list[dict] | None = None) -> dict:
    """One contract-shaped message.

    DSH admits exactly `{id, role, source, content}` on every message and
    requires a non-empty `id`; a fixture without one is rejected by a real host
    as corrupt even though a tolerant reader can still parse it.
    """
    return {
        "id": message_id,
        "role": role,
        "source": source,
        "content": [text_block(text), *(extra_blocks or [])],
    }


def tool_call_block(call_id: str, name: str, arguments: str) -> dict:
    """The assistant-side advertisement a later `tool/call` must match exactly."""
    return {"type": "tool-call", "id": call_id, "name": name, "arguments": arguments}


# One tool invocation, advertised by the assistant message that requested it and
# completed by its result. DSH rejects a `tool/call` that does not match an
# advertised tool call on the preceding assistant message, so these records
# share these exact values.
TOOL_CALL_ID = "call-1"
TOOL_NAME = "bash"
TOOL_ARGUMENTS = "{}"


def v3_events(prefix: str = "v3") -> list[dict]:
    """One native V3 conversation with the full surface vocabulary."""
    return [
        event(0, "turn/start", {"turn": 1}),
        event(1, "step/start", {"turn": 1, "step": 1}),
        event(
            2,
            "system/message",
            {
                "turn": 1,
                "step": 1,
                "message": message(
                    "msg-system-1",
                    "system",
                    {"kind": "plugin", "plugin": "@deepseek-ai/dsh-system-prompt"},
                    "SECRET-SYSTEM-PROMPT",
                ),
            },
            surface_op="append",
        ),
        event(
            3,
            "user/message",
            message("msg-user-1", "user", {"kind": "user"}, f"Implement synthetic {prefix} feature"),
            surface_op="append",
        ),
        event(
            4,
            "user/message",
            message(
                "msg-user-2",
                "user",
                {"kind": "agent-instructions"},
                "AGENTS.md instructions injected by the harness",
            ),
            surface_op="append",
        ),
        event(
            5,
            "assistant/message",
            {
                "turn": 1,
                "step": 1,
                "usage": {"inputTokens": 120, "outputTokens": 40, "reasoningTokens": 20, "cacheReadTokens": 300},
                "message": message(
                    "msg-assistant-1",
                    "assistant",
                    {"kind": "model", "provider": "synthetic-provider", "model": "synthetic-model"},
                    "ORIGINAL-ASSISTANT-REPLY",
                    extra_blocks=[tool_call_block(TOOL_CALL_ID, TOOL_NAME, TOOL_ARGUMENTS)],
                ),
                "stream": [],
            },
            surface_op="append",
        ),
        event(6, "tool/call", {"turn": 1, "step": 1, "callId": TOOL_CALL_ID, "name": TOOL_NAME, "arguments": TOOL_ARGUMENTS}),
        event(
            7,
            "tool/result",
            {
                "turn": 1,
                "step": 1,
                "message": {
                    "id": "msg-tool-1",
                    "role": "user",
                    "source": {"kind": "tool", "callId": TOOL_CALL_ID},
                    "content": [
                        {"type": "tool-result", "toolCallId": TOOL_CALL_ID, "isError": False, "content": [text_block("ok")]}
                    ],
                },
            },
            surface_op="append",
        ),
        event(8, "step/end", {"turn": 1, "step": 1}),
        event(9, "step/start", {"turn": 1, "step": 2}),
        # An attempt settles inside an open step without committing a message.
        # Each stream record wraps its payload as `{type:'chunk', time, chunk}`,
        # matching how DSH records a failed or retried settlement.
        event(
            10,
            "assistant/attempt",
            {
                "turn": 1,
                "step": 2,
                "stream": [
                    {
                        "type": "chunk",
                        "time": STAMP + 10,
                        "chunk": {
                            "type": "finish",
                            "reason": {
                                "kind": "error",
                                "failure": {"message": "synthetic transport failure", "code": "TRANSPORT"},
                            },
                        },
                    }
                ],
            },
        ),
        event(11, "step/end", {"turn": 1, "step": 2}),
        # A title cites the earlier human user/message it was derived from;
        # `messageSeqs` must be exactly the human sources, and empty for a
        # non-user title.
        event(
            12,
            "session/title",
            {
                "title": f"Synthetic {prefix} task",
                "messageSeqs": [3],
                "source": {
                    "kind": "provider",
                    "provider": "synthetic-title",
                    "model": {"provider": "synthetic-provider", "model": "synthetic-model"},
                },
            },
        ),
        event(13, "turn/end", {"turn": 1, "reason": {"kind": "completed"}}),
    ]


def write_v3_session(
    home: Path,
    *,
    session_id: str = "session-v3-001",
    events: list[dict] | None = None,
    header: dict | None = None,
    filename: str = "session.v3.jsonl.zstd",
    compression: str = "zstd",
    workspace: str = WORKSPACE,
) -> Path:
    session_dir = home / "sessions" / workspace / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    records = [header or v3_header(session_id), *(v3_events() if events is None else events)]
    lines = [json.dumps(item, ensure_ascii=False) for item in records]
    path = session_dir / filename
    if compression == "zstd":
        path.write_bytes(compress_dsh_generation(lines))
    else:
        path.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
    return path


def first_frame_plaintext(data: bytes) -> bytes:
    """Decode only the independently decodable first Zstandard frame."""
    magic = b"\x28\xb5\x2f\xfd"
    offsets: list[int] = []
    index = 0
    while index + 4 <= len(data):
        if data[index : index + 4] == magic:
            offsets.append(index)
            index += 4
        else:
            index += 1
    end = offsets[1] if len(offsets) > 1 else len(data)
    return zstandard.ZstdDecompressor().decompressobj().decompress(data[offsets[0] : end])


def write_v0_session(home: Path, *, session_id: str = "session-v3-001", prompt: str = "Legacy prompt") -> Path:
    """One generation-0 log shaped the way an older DSH release wrote it.

    A real generation-0 header carries `agentPreset` and no `isSeeded`, its
    events carry `seq`, and a surface event already carries its `surfaceOp`
    position marker: the migration chain does not invent a missing marker, so
    omitting it makes the whole generation unreadable.
    """
    session_dir = home / "sessions" / WORKSPACE / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "type": "session",
            "version": 0,
            "id": session_id,
            "createdAt": STAMP,
            "cwd": CWD,
            "delegationDepth": 0,
            "agentPreset": "standard",
        },
        {"type": "turn/start", "seq": 0, "time": STAMP, "data": {"turn": 1}},
        {"type": "step/start", "seq": 1, "time": STAMP, "data": {"turn": 1, "step": 1}},
        {
            "type": "user/message",
            "seq": 2,
            "time": STAMP,
            "surfaceOp": "append",
            "data": {
                "id": "msg-legacy-1",
                "role": "user",
                "source": {"kind": "user"},
                "content": [text_block(prompt)],
            },
        },
        {"type": "step/end", "seq": 3, "time": STAMP + 500, "data": {"turn": 1, "step": 1}},
        {"type": "turn/end", "seq": 4, "time": STAMP + 1000, "data": {"turn": 1, "reason": {"kind": "completed"}}},
    ]
    path = session_dir / "session.jsonl.zstd"
    path.write_bytes(compress_dsh_generation([json.dumps(item, ensure_ascii=False) for item in records]))
    return path


class SessionFormatV3Tests(unittest.TestCase):
    def config(self, home: Path, **overrides) -> analyzer.AnalysisConfig:
        values = dict(
            dsh_home=home,
            since=NOW_DT - timedelta(days=30),
            until=NOW_DT,
            privacy_mode="redacted",
            generated_at=NOW_DT,
            semantic_capture=True,
            deterministic_cache=False,
        )
        values.update(overrides)
        return analyzer.AnalysisConfig(**values)

    def build(self, home: Path, *, session_snapshots=None, **overrides):
        return analyzer.build_report(self.config(home, **overrides), session_snapshots=session_snapshots)

    # --- discovery and generation selection -------------------------------

    def test_v3_only_session_is_discovered_with_real_metrics(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home)
            report = self.build(home)
            self.assertEqual(report["totals"]["sessions"], 1)
            self.assertEqual(report["totals"]["turns"], 1)
            self.assertEqual(report["totals"]["tokens"]["uncached_input_tokens"], 120)
            self.assertEqual(report["totals"]["tokens"]["cached_input_tokens"], 300)
            self.assertEqual(report["coverage"]["generation_diagnostics"]["versioned_generations"], 1)
            self.assertEqual(report["coverage"]["unknown_record_types"], {})
            self.assertEqual(report["rollout_summaries"][0]["log_generation_version"], 3)

    def test_plaintext_v3_session_is_discovered(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home, filename="session.v3.jsonl", compression="none")
            coverage = {
                "unreadable_files": 0,
                "malformed_lines": 0,
                "unknown_record_types": analyzer.Counter(),
            }
            found = analyzer.discover_dsh_session_logs(home / "sessions", coverage)
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0].version, 3)
            self.assertTrue(found[0].path.name.endswith(".jsonl"))

    def test_coexisting_generations_select_highest_and_count_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v0_session(home, prompt="LEGACY-ONLY-PROMPT")
            write_v3_session(home)
            report = self.build(home)
            self.assertEqual(report["totals"]["sessions"], 1)
            self.assertEqual(report["coverage"]["generation_diagnostics"]["coexisting_generations"], 1)
            # The V3 generation wins: its prompt is present, the legacy one is not.
            self.assertNotIn("LEGACY-ONLY-PROMPT", json.dumps(report, ensure_ascii=False))
            self.assertEqual(report["rollout_summaries"][0]["log_generation_version"], 3)

    def test_legacy_only_session_still_reads(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v0_session(home)
            report = self.build(home)
            self.assertEqual(report["totals"]["sessions"], 1)
            self.assertEqual(report["coverage"]["generation_diagnostics"]["legacy_generations"], 1)
            self.assertEqual(report["rollout_summaries"][0]["log_generation_version"], 0)

    def test_corrupt_current_generation_is_reported_not_silently_downgraded(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v0_session(home)
            session_dir = home / "sessions" / WORKSPACE / "session-v3-001"
            (session_dir / "session.v3.jsonl.zstd").write_bytes(b"not a zstd frame")
            report = self.build(home)
            # The newer generation is selected but unreadable: no legacy report.
            self.assertEqual(report["totals"]["sessions"], 0)
            self.assertEqual(report["coverage"]["unreadable_files"], 1)
            self.assertNotIn("LEGACY-ONLY-PROMPT", json.dumps(report, ensure_ascii=False))

    def test_unknown_newer_generation_is_skipped_and_warned(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v0_session(home)
            write_v3_session(home, filename="session.v9.jsonl.zstd")
            report = self.build(home)
            self.assertEqual(report["totals"]["sessions"], 0)
            self.assertEqual(report["coverage"]["generation_diagnostics"]["newer_generation"], 1)
            self.assertTrue(any("V3" in item for item in report["warnings"]), report["warnings"])

    def test_noncanonical_names_are_never_selected(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home, filename="session.v03.jsonl.zstd")
            write_v3_session(home, filename="session.v0.jsonl.zstd")
            report = self.build(home)
            self.assertEqual(report["totals"]["sessions"], 0)

    def test_generation_grammar_matches_upstream(self):
        # Canonical names.
        self.assertEqual(analyzer.parse_dsh_generation_filename("session.jsonl.zstd"), 0)
        self.assertEqual(analyzer.parse_dsh_generation_filename("session.v3.jsonl.zstd"), 3)
        self.assertEqual(analyzer.parse_dsh_generation_filename("session.v12.jsonl", "none"), 12)
        self.assertEqual(analyzer.parse_dsh_generation_filename("session.jsonl", "none"), 0)
        self.assertIsNone(analyzer.parse_dsh_generation_filename("session.v12.jsonl", "zstd"))
        # Noncanonical: temporary, uppercase, leading zero, explicit v0, other encodings.
        for name in (
            "session.v03.jsonl.zstd",
            "session.v0.jsonl.zstd",
            "session.V3.jsonl.zstd",
            "session.jsonl.tmp",
            "session.v3.jsonl.zstd.tmp",
            ".session.v3.jsonl.zstd",
            "session-other.v3.jsonl.zstd",
        ):
            self.assertIsNone(analyzer.parse_dsh_generation_filename(name), name)

    # --- V3 event and message semantics -----------------------------------

    def test_system_message_is_not_user_work_and_never_leaked(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home)
            report = self.build(home)
            self.assertEqual(report["totals"]["system_messages"], 1)
            self.assertNotIn("SECRET-SYSTEM-PROMPT", json.dumps(report, ensure_ascii=False))

    def test_injected_user_context_is_not_user_work(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home)
            report = self.build(home)
            # Only the direct human prompt counts as user work.
            self.assertEqual(report["totals"]["user_messages"], 1)
            self.assertEqual(report["totals"]["injected_user_messages"], 1)
            summary = report["rollout_summaries"][0]
            self.assertEqual(summary["injected_source_kinds"], {"agent-instructions": 1})
            self.assertNotIn("AGENTS.md instructions injected", json.dumps(report, ensure_ascii=False))

    def test_injected_context_is_absent_from_semantic_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home)
            report, sessions = analyzer.build_report(
                self.config(home), include_internal_sessions=True
            )
            texts = " ".join(message["text"] for message in sessions[0]["semantic_messages"])
            self.assertIn("Implement synthetic v3 feature", texts)
            self.assertNotIn("AGENTS.md instructions injected", texts)
            self.assertNotIn("SECRET-SYSTEM-PROMPT", texts)

    def test_assistant_attempt_counted_without_fabricated_reply(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home)
            report = self.build(home)
            self.assertEqual(report["totals"]["assistant_attempts"], 1)
            self.assertEqual(report["totals"]["assistant_messages"], 1)
            summary = report["rollout_summaries"][0]
            self.assertEqual(summary["assistant_attempts"], 1)
            # No usage is invented for an attempt that carried none.
            self.assertEqual(report["totals"]["tokens"]["total_tokens"], 120 + 300 + 40)

    def test_surface_replacement_shadows_semantic_text_but_keeps_event_stats(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            events = [
                event(0, "turn/start", {"turn": 1}),
                event(1, "step/start", {"turn": 1, "step": 1}),
                event(
                    2,
                    "user/message",
                    message("msg-shadow-user", "user", {"kind": "user"}, "ORIGINAL-SHADOWED-PROMPT"),
                    surface_op="append",
                ),
                event(
                    3,
                    "assistant/message",
                    {
                        "turn": 1,
                        "step": 1,
                        "usage": {"inputTokens": 100, "outputTokens": 10},
                        "message": message(
                            "msg-shadow-assistant", "assistant", {"kind": "model", "provider": "p", "model": "m"},
                            "ORIGINAL-SHADOWED-REPLY",
                            extra_blocks=[tool_call_block("c1", "bash", "{}")],
                        ),
                        "stream": [],
                    },
                    surface_op="append",
                ),
                event(4, "tool/call", {"turn": 1, "step": 1, "callId": "c1", "name": "bash", "arguments": "{}"}),
                event(
                    5,
                    "tool/result",
                    {
                        "turn": 1,
                        "step": 1,
                        "message": {
                            "id": "msg-shadow-tool",
                            "role": "user",
                            "source": {"kind": "tool", "callId": "c1"},
                            "content": [
                                {"type": "tool-result", "toolCallId": "c1", "isError": False, "content": [text_block("ok")]}
                            ],
                        },
                    },
                    surface_op="append",
                ),
                event(6, "step/end", {"turn": 1, "step": 1}),
                event(7, "compaction/summary", {"summary": [text_block("compacted")], "shadowedSeqs": [1, 2]}),
                event(
                    8,
                    "user/message",
                    message("msg-summary-node", "user", {"kind": "user"}, "COMPACTED-SUMMARY-NODE"),
                    surface_op={"op": "replace", "startSeq": 2, "endSeq": 3},
                ),
                event(9, "turn/end", {"turn": 1, "reason": {"kind": "completed"}}),
            ]
            write_v3_session(home, events=events)
            report, sessions = analyzer.build_report(
                self.config(home, locale="en"), include_internal_sessions=True
            )
            texts = " ".join(message["text"] for message in sessions[0]["semantic_messages"])
            # Shadowed conversation text leaves the semantic summary...
            self.assertNotIn("ORIGINAL-SHADOWED-PROMPT", texts)
            self.assertNotIn("ORIGINAL-SHADOWED-REPLY", texts)
            self.assertIn("COMPACTED-SUMMARY-NODE", texts)
            # ...while historical event statistics survive the replacement.
            self.assertEqual(report["totals"]["turns"], 1)
            self.assertEqual(report["totals"]["tool_calls"], 1)
            self.assertEqual(report["totals"]["tokens"]["uncached_input_tokens"], 100)
            self.assertEqual(sessions[0]["semantic_shadowed_messages"], 2)
            self.assertEqual(report["coverage"]["surface_replacements"], 1)
            self.assertTrue(any("shadowed" in item for item in report["warnings"]))

    def test_replacements_follow_live_surface_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            events = [event(0, "turn/start", {"turn": 1}), event(1, "step/start", {"turn": 1, "step": 1})]
            for seq, text, op in [(2, "FIRST", "append"), (3, "MIDDLE", "append"),
                                  (4, "KEEP", "append"),
                                  (5, "REPLACEMENT", {"op": "replace", "startSeq": 2, "endSeq": 2}),
                                  (6, "FINAL", {"op": "replace", "startSeq": 5, "endSeq": 3})]:
                events.append(event(seq, "user/message", message(f"m{seq}", "user", {"kind": "user"}, text), surface_op=op))
            write_v3_session(home, events=events)
            report, sessions = analyzer.build_report(self.config(home), include_internal_sessions=True)
            texts = [item["text"] for item in sessions[0]["semantic_messages"]]
            self.assertEqual(texts, ["KEEP", "FINAL"])
            self.assertEqual(report["coverage"]["surface_replacements"], 2)
            self.assertEqual(sessions[0]["compaction_shadowed_events"], 3)

    def test_flat_artifact_diagnostic_ignores_non_logs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "project"
            project.mkdir()
            for name in ("notes.txt", "session.lock", "old.jsonl", "old.jsonl.zstd"):
                (project / name).write_text("")
            self.assertEqual(analyzer.detect_legacy_flat_session_logs(root, analyzer.parse_coverage_state()), 2)

    def test_inherited_cut_is_recorded_from_tagged_end_seed(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            events = [event(0, "turn/start", {"turn": 1})]
            events.append(event(1, "session/end-seed", {"inherited": True}))
            events.append(
                event(
                    2,
                    "user/message",
                    message("msg-local", "user", {"kind": "user"}, "local prompt"),
                    surface_op="append",
                )
            )
            events.append(event(3, "turn/end", {"turn": 1, "reason": {"kind": "completed"}}))
            write_v3_session(home, events=events)
            report = self.build(home)
            self.assertEqual(report["rollout_summaries"][0]["inherited_event_count"], 1)

    # --- cross-flow equivalence and cache ---------------------------------

    def test_file_and_snapshot_entries_agree_on_v3(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home)
            file_report = self.build(home)
            header = v3_header("session-v3-001")
            header.pop("type")
            snapshot = {"session": header, "events": v3_events()}
            snapshot_report = self.build(home, session_snapshots=[snapshot])
            for key in (
                "sessions",
                "turns",
                "user_messages",
                "assistant_messages",
                "tool_calls",
                "system_messages",
                "injected_user_messages",
                "assistant_attempts",
                "tokens",
            ):
                self.assertEqual(file_report["totals"][key], snapshot_report["totals"][key], key)

    def test_cache_is_keyed_to_the_selected_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            # Start with the legacy generation only.
            write_v0_session(home, prompt="LEGACY-GENERATION-PROMPT")
            config = self.config(home, deterministic_cache=True)
            first = analyzer.build_report(config)
            self.assertEqual(first["rollout_summaries"][0]["log_generation_version"], 0)
            self.assertEqual(first["coverage"]["deterministic_cache"]["misses"], 1)
            second = analyzer.build_report(config)
            self.assertEqual(second["coverage"]["deterministic_cache"]["hits"], 1)
            self.assertEqual(first["totals"], second["totals"])
            # Publishing the current generation selects a different file for the
            # same logical session; the legacy cache entry must not be reused.
            write_v3_session(home)
            third = analyzer.build_report(config)
            self.assertEqual(third["coverage"]["generation_diagnostics"]["coexisting_generations"], 1)
            self.assertEqual(third["rollout_summaries"][0]["log_generation_version"], 3)
            self.assertEqual(third["coverage"]["deterministic_cache"]["hits"], 0)
            self.assertEqual(third["totals"]["turns"], 1)
            self.assertNotIn("LEGACY-GENERATION-PROMPT", json.dumps(third, ensure_ascii=False))
            # Re-parsing the same selection is then cacheable again.
            fourth = analyzer.build_report(config)
            self.assertEqual(fourth["coverage"]["deterministic_cache"]["hits"], 1)
            self.assertEqual(fourth["totals"], third["totals"])

    def test_cache_version_reflects_generation_aware_parsing(self):
        self.assertEqual(analyzer.DETERMINISTIC_CACHE_VERSION, 2)
        self.assertEqual(analyzer.DSH_SESSION_FORMAT_VERSION, 3)

    def test_written_generations_satisfy_the_header_frame_contract(self):
        """A written generation must be openable by DSH, not merely by us.

        DSH asserts that the independently decodable first Zstandard frame holds
        exactly one header line. A single-frame fixture is readable by a tolerant
        reader but is rejected by a real host, so the framing is pinned here.
        """
        expected = json.dumps(v3_header("session-frame-check"), ensure_ascii=False) + "\n"
        data = compress_dsh_generation([json.dumps(v3_header("session-frame-check"), ensure_ascii=False)]
                                       + [json.dumps(item, ensure_ascii=False) for item in v3_events()])
        first = first_frame_plaintext(data)
        self.assertEqual(first.count(b"\n"), 1, "first frame must hold exactly one line")
        self.assertTrue(first.endswith(b"\n"), "first frame must end with a newline")
        self.assertEqual(first.decode("utf-8"), expected)

    def test_committed_fixture_satisfies_the_header_frame_contract(self):
        """The repository fixture is read by real hosts, so it must conform too."""
        root = Path(__file__).parents[1]
        fixture = root / "tests" / "fixtures" / "session.jsonl.zstd"
        data = fixture.read_bytes()
        first = first_frame_plaintext(data)
        self.assertEqual(first.count(b"\n"), 1, "committed fixture first frame is not one header line")
        self.assertTrue(first.endswith(b"\n"))
        header = json.loads(first.decode("utf-8"))
        self.assertEqual(header.get("type"), "session")

    def test_written_v3_session_passes_the_installed_dsh_validators(self):
        """Run the real upstream validators over a written V3 session.

        Local assertions cannot tell whether a fixture is one a DSH host would
        open: message members, tool-call advertisement, the step lifecycle, and
        the title source rule are all enforced upstream. This defers to those
        validators and skips cleanly when no DSH runtime is installed.
        """
        root = Path(__file__).parents[1]
        script = root / "scripts" / "verify_session_contract.mjs"
        if not script.is_file():
            self.skipTest("contract verifier is absent")
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            write_v3_session(home, session_id="session-contract-001")
            completed = subprocess.run(
                ["node", str(script), str(home / "sessions")],
                text=True,
                capture_output=True,
                check=False,
            )
            if completed.returncode == 0 and '"status": "skipped"' in completed.stdout:
                self.skipTest("no DSH runtime installed; contract check skipped")
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            result = json.loads(completed.stdout)
            self.assertEqual(result["status"], "pass", result)
            self.assertEqual(result["results"][0]["scope"], "native-v3")
            self.assertEqual(result["results"][0]["errors"], [])

    def test_public_tree_audit_recognizes_the_same_generations(self):
        """The boundary audit must not drift from the analyzer's grammar."""
        import importlib.util

        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location(
            "public_tree_audit_sync", root / "scripts" / "audit_public_tree.py"
        )
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        canonical = [
            "session.jsonl",
            "session.jsonl.zstd",
            "session.v1.jsonl.zstd",
            "session.v3.jsonl",
            "session.v12.jsonl.zstd",
        ]
        noncanonical = [
            "session.v0.jsonl.zstd",
            "session.v03.jsonl.zstd",
            "session.V3.jsonl.zstd",
            "session.jsonl.tmp",
            "session-other.v3.jsonl.zstd",
        ]
        for name in canonical:
            self.assertIsNotNone(module.SESSION_LOG_NAME_RE.match(name), name)
            compression = "zstd" if name.endswith(".zstd") else "none"
            self.assertIsNotNone(analyzer.parse_dsh_generation_filename(name, compression), name)
        for name in noncanonical:
            self.assertIsNone(module.SESSION_LOG_NAME_RE.match(name), name)

    # --- plugin bridge end-to-end -----------------------------------------

    def bridge(self, root: Path, request: dict, *snapshots: dict) -> dict:
        """Run the real plugin bridge subprocess over the given snapshots."""
        env = dict(os.environ)
        env["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
        env["DSH_HOME"] = str(root)
        payload = "\n".join(json.dumps(item) for item in (request, *snapshots)) + "\n"
        completed = subprocess.run(
            [sys.executable, "-m", "dsh_session_insights.plugin_bridge"],
            input=payload,
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout.strip().splitlines()[-1])

    def v3_snapshot(self, session_id: str = "session-v3-bridge", events: list[dict] | None = None) -> dict:
        header = v3_header(session_id)
        header.pop("type")
        return {"kind": "session", "snapshot": {"session": header, "events": v3_events() if events is None else events}}

    def test_bridge_deterministic_report_renders_v3_metrics(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "insights" / "runs" / "run-1" / "report.html"
            result = self.bridge(
                root,
                {
                    "schema": "dsh-session-insights/bridge-1",
                    "operation": "report",
                    "options": {"days": 30, "now": NOW, "output": str(output), "locale": "en"},
                },
                self.v3_snapshot(),
            )
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["sessions"], 1)
            # The report data, not merely the file, must carry the V3 accounting.
            report = json.loads(output.with_suffix(".json").read_text(encoding="utf-8"))
            self.assertEqual(report["totals"]["user_messages"], 1)
            self.assertEqual(report["totals"]["injected_user_messages"], 1)
            self.assertEqual(report["totals"]["system_messages"], 1)
            self.assertEqual(report["totals"]["assistant_attempts"], 1)
            self.assertEqual(report["coverage"]["unknown_record_types"], {})
            serialized = json.dumps(report, ensure_ascii=False)
            self.assertNotIn("SECRET-SYSTEM-PROMPT", serialized)
            self.assertNotIn("AGENTS.md instructions injected", serialized)
            html = output.read_text(encoding="utf-8")
            self.assertIn('<html lang="en">', html)
            self.assertIn("DSH Session Insights", html)

    def test_bridge_semantic_prepare_produces_a_batch_for_v3(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workdir = root / "insights" / "runs" / "run-v3"
            result = self.bridge(
                root,
                {
                    "schema": "dsh-session-insights/bridge-1",
                    "operation": "prepare",
                    "options": {
                        "days": 30,
                        "now": NOW,
                        "workdir": str(workdir),
                        "locale": "en",
                        "privacy": "redacted",
                    },
                },
                self.v3_snapshot(),
            )
            self.assertTrue(result["ok"], result)
            # `now` must be honoured so the window is caller-controlled, not wall-clock.
            self.assertEqual(result["selected"], 1)
            manifest = json.loads((workdir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["batch_ids"], ["batch-001"])
            batch = json.loads((workdir / "batches" / "batch-001.json").read_text(encoding="utf-8"))
            self.assertEqual(len(batch["tasks"]), 1)
            # Injected context and the system prompt stay out of semantic evidence.
            evidence = (workdir / "semantic-evidence.json").read_text(encoding="utf-8")
            self.assertNotIn("SECRET-SYSTEM-PROMPT", evidence)
            self.assertNotIn("AGENTS.md instructions injected", evidence)

    def test_bridge_reports_errors_instead_of_claiming_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env = dict(os.environ)
            env["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
            env["DSH_HOME"] = str(root)
            completed = subprocess.run(
                [sys.executable, "-m", "dsh_session_insights.plugin_bridge"],
                input=json.dumps({"schema": "dsh-session-insights/bridge-1", "operation": "nope"}) + "\n",
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertNotIn('"ok": true', completed.stdout)


if __name__ == "__main__":
    unittest.main()

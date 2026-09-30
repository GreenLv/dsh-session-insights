from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import zstandard

from dsh_session_insights import analyzer

from helpers import NOW, records, write_session


NOW_DT = datetime.fromisoformat(NOW.replace("Z", "+00:00"))


def config(home: Path, **overrides):
    values = dict(dsh_home=home, since=NOW_DT - timedelta(days=30), until=NOW_DT,
                  privacy_mode="redacted", generated_at=NOW_DT)
    values.update(overrides)
    return analyzer.AnalysisConfig(**values)


def write_raw(home: Path, name: str, payload: bytes) -> Path:
    path = home / "sessions" / "--workspace-project-a--" / "session-synthetic-001" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def compress(frames: list[bytes]) -> bytes:
    compressor = zstandard.ZstdCompressor(level=3, write_checksum=True)
    return b"".join(compressor.compress(frame) for frame in frames)


class ReadBudgetTests(unittest.TestCase):
    def test_decoded_byte_budget_refuses_with_explainable_error(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            path = home / "sessions" / "--workspace-project-a--" / "session-synthetic-001" / "session.v4.jsonl.zstd"
            with mock.patch.object(analyzer, "MAX_DECODED_LOG_BYTES", 16):
                with self.assertRaises(analyzer.DshSessionLogResourceLimit) as raised:
                    analyzer.read_dsh_jsonl_lines(path)
                self.assertIn("refusing to truncate", str(raised.exception))
                coverage = analyzer.parse_coverage_state()
                self.assertIsNone(analyzer.parse_dsh_session_file(path, config(home), coverage))
                self.assertEqual(coverage["resource_limited_files"], 1)
                self.assertEqual(coverage["unreadable_files"], 0)

    def test_line_count_and_single_line_budgets(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            path = write_session(home)
            with mock.patch.object(analyzer, "MAX_LOG_LINES", 2):
                with self.assertRaises(analyzer.DshSessionLogResourceLimit):
                    analyzer.read_dsh_jsonl_lines(path)
            with mock.patch.object(analyzer, "MAX_LOG_LINE_BYTES", 8):
                with self.assertRaises(analyzer.DshSessionLogResourceLimit):
                    analyzer.read_dsh_jsonl_lines(path)

    def test_uncompressed_budgets_apply_too(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            lines = [json.dumps(item) for item in records()]
            path = write_raw(home, "session.v4.jsonl", ("\n".join(lines) + "\n").encode("utf-8"))
            with mock.patch.object(analyzer, "MAX_DECODED_LOG_BYTES", 16):
                with self.assertRaises(analyzer.DshSessionLogResourceLimit):
                    analyzer.read_dsh_jsonl_lines(path)
            # Without a budget breach the same file parses fully.
            self.assertEqual(len(analyzer.read_dsh_jsonl_lines(path)), len(lines))

    def test_multiframe_logs_decode_completely(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            rows = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in records()]
            header = (rows[0] + "\n").encode("utf-8")
            events = ("\n".join(rows[1:]) + "\n").encode("utf-8")
            path = write_raw(home, "session.v4.jsonl.zstd", compress([header, events]))
            lines = analyzer.read_dsh_jsonl_lines(path)
            self.assertEqual(len(lines), len(rows))
            coverage = analyzer.parse_coverage_state()
            session = analyzer.parse_dsh_session_file(path, config(home), coverage)
            self.assertIsNotNone(session)
            self.assertEqual(coverage["resource_limited_files"], 0)

    def test_header_frame_oversize_is_a_resource_refusal(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            rows = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in records()]
            bloated_header = (rows[0] + " " + "x" * 2048 + "\n").encode("utf-8")
            path = write_raw(home, "session.v4.jsonl.zstd", compress([bloated_header]))
            with mock.patch.object(analyzer, "MAX_HEADER_FRAME_BYTES", 1024):
                with self.assertRaises(analyzer.DshSessionLogResourceLimit):
                    analyzer.read_dsh_jsonl_lines(path)

    def test_truncated_frame_and_corrupt_utf8_are_unreadable_not_limited(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            rows = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in records()]
            # Real DSH layout: frame one is the header, frame two the events;
            # truncating the tail cuts the event frame only.
            good = compress([(rows[0] + "\n").encode("utf-8"), ("\n".join(rows[1:]) + "\n").encode("utf-8")])
            truncated = write_raw(home, "session.v4.jsonl.zstd", good[: len(good) - 12])
            self.assertIsNone(analyzer.read_dsh_jsonl_lines(truncated))
            corrupt = write_raw(home, "session.v4.jsonl", ("\n".join(rows[:-1]) + "\n").encode("utf-8") + b"\xff\xfe\xff\n")
            self.assertIsNone(analyzer.read_dsh_jsonl_lines(corrupt))
            coverage = analyzer.parse_coverage_state()
            self.assertIsNone(analyzer.parse_dsh_session_file(corrupt, config(home), coverage))
            self.assertEqual(coverage["resource_limited_files"], 0)
            self.assertEqual(coverage["unreadable_files"], 1)

    def test_resource_refusal_surfaces_as_report_warning_without_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            write_session(home)
            with mock.patch.object(analyzer, "MAX_DECODED_LOG_BYTES", 16):
                report = analyzer.build_report(config(home))
            self.assertEqual(report["coverage"]["resource_limited_files"], 1)
            self.assertEqual(report["totals"]["sessions"], 0)
            self.assertTrue(any("read budget" in item or "资源上限" in item for item in report["warnings"]))

    def test_high_compression_ratio_is_refused_not_expanded(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            # A proper header frame followed by ~256 KiB of zeros compresses to
            # a few hundred bytes; the decoded budget, not the encoded size,
            # must bound the read.
            rows = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in records()]
            header = (rows[0] + "\n").encode("utf-8")
            path = write_raw(home, "session.v4.jsonl.zstd", compress([header, b"0" * (256 * 1024)]))
            with mock.patch.object(analyzer, "MAX_DECODED_LOG_BYTES", 4096):
                with self.assertRaises(analyzer.DshSessionLogResourceLimit):
                    analyzer.read_dsh_jsonl_lines(path)
            self.assertLess(path.stat().st_size, 4096)


if __name__ == "__main__":
    unittest.main()

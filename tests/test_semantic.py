from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from helpers import NOW, write_session


def valid_facet(task: dict, *, english: bool = False) -> dict:
    return {
        "task_family_id": task["task_family_id"],
        "goal": "Complete a bounded, verified implementation task" if english else "完成一个范围明确且经过验证的实现任务",
        "task_type": "implementation",
        "interaction_style": "The user supplied the goal and then clarified scope." if english else "用户先给目标，随后明确范围。",
        "instruction_handling": "followed",
        "tool_execution": "adequate",
        "verification_quality": "strong",
        "handoff_quality": "clear",
        "frictions": ["Scope needed clarification" if english else "范围需要明确"],
        "strengths": ["Validation evidence was preserved" if english else "保留验证证据"],
        "outcome_inference": "mostly_achieved",
        "evidence_refs": [task["evidence"][0]["id"]],
    }


def aggregate_item(title: str, tasks: list[dict], *, english: bool = False) -> dict:
    return {
        "title": title,
        "text": "Synthetic tasks show an emphasis on scope control and validation evidence." if english else "合成任务显示用户重视范围控制与验证证据。",
        "supporting_task_family_ids": [item["task_family_id"] for item in tasks],
        "evidence_refs": [item["evidence"][0]["id"] for item in tasks],
        "confidence": "high",
        "measurement": "inferred",
    }


class SemanticTests(unittest.TestCase):
    def run_cli(self, *args: str, expected: int = 0):
        env = os.environ.copy()
        source = str(Path(__file__).parents[1] / "src")
        env["PYTHONPATH"] = source + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        result = subprocess.run([sys.executable, "-m", "dsh_session_insights", "semantic", *args],
                                capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, check=False)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def prepare(self, home: Path, workdir: Path, *extra: str) -> dict:
        result = self.run_cli("prepare", "--dsh-home", str(home), "--since", "2026-08-01", "--until", "2026-08-21",
                              "--workdir", str(workdir), "--now", NOW, *extra)
        return json.loads(result.stdout)

    def write_valid_batches(self, workdir: Path, *, english: bool = False) -> list[dict]:
        manifest = json.loads((workdir / "manifest.json").read_text(encoding="utf-8"))
        tasks: list[dict] = []
        for batch_id in manifest["batch_ids"]:
            batch = json.loads((workdir / "batches" / f"{batch_id}.json").read_text(encoding="utf-8"))
            tasks.extend(batch["tasks"])
            output = workdir / "facet-outputs" / f"{batch_id}.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"facets": [valid_facet(item, english=english) for item in batch["tasks"]]}, ensure_ascii=False), encoding="utf-8")
            self.run_cli("validate-batch", "--workdir", str(workdir), "--batch", batch_id)
        return tasks

    def test_prepare_defaults_redact_and_batch(self):
        with tempfile.TemporaryDirectory() as temp:
            home, work = Path(temp) / "home", Path(temp) / "work"
            write_session(home)
            result = self.prepare(home, work, "--no-semantic-cache")
            manifest = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
            evidence = (work / "semantic-evidence.json").read_text(encoding="utf-8")
            self.assertEqual(result["selected"], 1)
            self.assertEqual(manifest["privacy"], "redacted")
            self.assertEqual(manifest["analysis_privacy"], "redacted")
            self.assertEqual(manifest["analysis_depth"], "evidence")
            self.assertNotIn("/sensitive-home", evidence)
            self.assertNotIn("sk-test-", evidence)

    def test_metrics_skips_all_batches(self):
        with tempfile.TemporaryDirectory() as temp:
            home, work = Path(temp) / "home", Path(temp) / "work"
            write_session(home)
            result = self.prepare(home, work, "--privacy", "metrics")
            self.assertTrue(result["metrics_semantic_skipped"])
            self.assertEqual(result["selected"], 0)
            self.assertEqual(list((work / "batches").glob("*.json")) if (work / "batches").exists() else [], [])

    def test_analysis_metrics_skips_even_local_report(self):
        with tempfile.TemporaryDirectory() as temp:
            home, work = Path(temp) / "home", Path(temp) / "work"
            write_session(home)
            result = self.prepare(home, work, "--privacy", "local", "--analysis-privacy", "metrics")
            self.assertTrue(result["metrics_semantic_skipped"])

    def test_local_analysis_is_explicit_and_secret_still_redacted(self):
        with tempfile.TemporaryDirectory() as temp:
            home, work = Path(temp) / "home", Path(temp) / "work"
            write_session(home)
            self.prepare(home, work, "--analysis-privacy", "local", "--no-semantic-cache")
            evidence = (work / "semantic-evidence.json").read_text(encoding="utf-8")
            self.assertIn("/sensitive-home/person/project", evidence)
            self.assertNotIn("sk-test-", evidence)

    def test_validation_cache_hit_and_invalidation(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "home"
            source1 = write_session(home, 1)
            write_session(home, 2, cwd="/workspace/project-b", workspace="--workspace-project-b--")
            work1 = Path(temp) / "work1"
            self.prepare(home, work1)
            self.write_valid_batches(work1)
            work2 = Path(temp) / "work2"
            second = self.prepare(home, work2)
            self.assertEqual(second["cache_hits"], 2)
            write_session(home, 1, secret=False)
            work3 = Path(temp) / "work3"
            third = self.prepare(home, work3)
            self.assertEqual(third["cache_hits"], 1)
            self.assertEqual(third["cache_misses"], 1)

    def test_invalid_facet_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            home, work = Path(temp) / "home", Path(temp) / "work"
            write_session(home)
            self.prepare(home, work, "--no-semantic-cache")
            manifest = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
            batch_id = manifest["batch_ids"][0]
            batch = json.loads((work / "batches" / f"{batch_id}.json").read_text(encoding="utf-8"))
            facet = valid_facet(batch["tasks"][0])
            facet["accepted"] = True
            facet["evidence_refs"] = ["unknown-evidence"]
            out = work / "facet-outputs" / f"{batch_id}.json"
            out.parent.mkdir(parents=True)
            out.write_text(json.dumps({"facets": [facet]}), encoding="utf-8")
            result = self.run_cli("validate-batch", "--workdir", str(work), "--batch", batch_id, expected=2)
            self.assertIn("evidence_refs", result.stderr)
            self.assertIn("accepted", result.stderr)

    def test_complete_finalize_fallback_and_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            home, work = Path(temp) / "home", Path(temp) / "work"
            write_session(home)
            self.prepare(home, work, "--no-semantic-cache")
            tasks = self.write_valid_batches(work)
            self.run_cli("prepare-aggregate", "--workdir", str(work))
            sections = {name: [aggregate_item(name, tasks)] for name in ("glance", "workflows", "operating_style", "strengths", "frictions", "horizon")}
            recommendation = aggregate_item("保留验证证据", tasks)
            recommendation.update({"recommendation_key": "verification_evidence", "action": "保留短验证摘要。",
                                   "copy_prompt": "请运行验证并报告摘要。", "singleton_observation": True})
            sections["recommendations"] = [recommendation]
            (work / "semantic-report.json").write_text(json.dumps(sections, ensure_ascii=False), encoding="utf-8")
            self.run_cli("validate-aggregate", "--workdir", str(work))
            output = Path(temp) / "complete.html"
            self.run_cli("finalize", "--workdir", str(work), "--output", str(output))
            companion = json.loads(output.with_suffix(".json").read_text(encoding="utf-8"))
            self.assertEqual(companion["semantic_analysis"]["status"], "complete")
            self.assertTrue(work.exists())

            fallback_work = Path(temp) / "fallback"
            self.prepare(home, fallback_work, "--no-semantic-cache")
            fallback = Path(temp) / "fallback.json"
            self.run_cli("finalize", "--workdir", str(fallback_work), "--fallback", "--format", "json", "--output", str(fallback))
            self.assertEqual(json.loads(fallback.read_text(encoding="utf-8"))["semantic_analysis"]["status"], "fallback")

            auto = self.run_cli("prepare", "--dsh-home", str(home), "--days", "30", "--privacy", "metrics", "--now", NOW)
            auto_work = Path(json.loads(auto.stdout)["workdir"])
            auto_output = Path(temp) / "auto.json"
            self.run_cli("finalize", "--workdir", str(auto_work), "--format", "json", "--output", str(auto_output))
            self.assertFalse(auto_work.exists())

    def test_aggregate_contract_discloses_validator_enums(self):
        with tempfile.TemporaryDirectory() as temp:
            home, work = Path(temp) / "home", Path(temp) / "work"
            write_session(home)
            self.prepare(home, work, "--no-semantic-cache")
            self.write_valid_batches(work)
            self.run_cli("prepare-aggregate", "--workdir", str(work))
            aggregate_input = json.loads((work / "aggregate-input.json").read_text(encoding="utf-8"))
            enum_values = aggregate_input["output_contract"]["enum_values"]
            self.assertEqual(set(enum_values["confidence"]), {"high", "medium", "low"})
            self.assertEqual(set(enum_values["measurement"]), {"measured", "proxy", "inferred"})

    def test_english_finalize_localizes_framework_owned_semantic_strings(self):
        with tempfile.TemporaryDirectory() as temp:
            home, work = Path(temp) / "home", Path(temp) / "work"
            write_session(home)
            self.prepare(home, work, "--locale", "en", "--no-semantic-cache")
            tasks = self.write_valid_batches(work, english=True)
            self.run_cli("prepare-aggregate", "--workdir", str(work))
            sections = {
                name: [aggregate_item(name.title(), tasks, english=True)]
                for name in ("glance", "workflows", "operating_style", "strengths", "frictions", "horizon")
            }
            recommendation = aggregate_item("Preserve validation evidence", tasks, english=True)
            recommendation.update({
                "recommendation_key": "verification_evidence",
                "action": "Keep a short validation summary.",
                "copy_prompt": "Run validation and report a concise summary.",
                "singleton_observation": True,
            })
            sections["recommendations"] = [recommendation]
            (work / "semantic-report.json").write_text(json.dumps(sections), encoding="utf-8")
            self.run_cli("validate-aggregate", "--workdir", str(work))
            output = Path(temp) / "complete-en.html"
            self.run_cli("finalize", "--workdir", str(work), "--output", str(output))
            report = json.loads(output.with_suffix(".json").read_text(encoding="utf-8"))
            framework_strings = [
                *(item["evidence"] for item in report["narrative"]["wins"]),
                *(item["starting_point"] for item in report["narrative"]["horizon"]),
                *(item["evidence"] for item in report["recommendations"]),
            ]
            self.assertFalse(any(re.search(r"[\u3400-\u9fff]", value) for value in framework_strings), framework_strings)
            self.assertIn("semantic evidence item", framework_strings[0])
            self.assertIn("supporting task family", framework_strings[-1])


if __name__ == "__main__":
    unittest.main()

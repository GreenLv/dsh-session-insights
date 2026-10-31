from __future__ import annotations

import json
import re
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from dsh_session_insights import analyzer, messages, semantic
from helpers import NOW, records

CJK_RE = re.compile(r"[\u3400-\u9fff]")
CYRILLIC_RE = re.compile(r"[\u0400-\u04ff]")


class RussianLocaleTests(unittest.TestCase):
    def config(self, home: Path, *, locale: str = "ru", privacy: str = "local") -> analyzer.AnalysisConfig:
        now = datetime.fromisoformat(NOW.replace("Z", "+00:00"))
        return analyzer.AnalysisConfig(
            dsh_home=home,
            since=now - timedelta(days=30),
            until=now,
            generated_at=now,
            privacy_mode=privacy,
            metrics_only=privacy == "metrics",
            semantic_capture=True,
            deterministic_cache=False,
            locale=locale,
        )

    def report(self, *, privacy: str = "local", locale: str = "ru") -> dict:
        rows = records()
        snapshots = [{"session": rows[0], "events": rows[1:]}]
        return analyzer.build_report(
            self.config(Path("/synthetic"), privacy=privacy, locale=locale),
            session_snapshots=snapshots,
        )

    def test_russian_report_text_is_localized(self) -> None:
        report = self.report()
        self.assertEqual(report["scope"]["locale"], "ru")
        narrative = json.dumps(report["narrative"], ensure_ascii=False)
        recommendations = json.dumps(
            analyzer.build_recommendations(
                {"tool_failures": 2, "unchanged_retries": 1, "permission_blocks": 1, "sessions": 3,
                 "aborted_turns": 0, "patches": 0, "git_commits": 0, "failed_patches": 0},
                {"correction_like_messages": 2, "correction_rate_per_user_message": 0.2,
                 "long_running_sessions": 1, "multi_agent_sessions": 0},
                {"partial_sessions": 0},
                [{"project": "/project", "sessions": 5, "tool_calls": 10, "active_hours": 2.0}],
                locale="ru",
            ),
            ensure_ascii=False,
        )
        self.assertEqual(report["narrative"]["glance"][0]["label"], "Что получается")
        self.assertTrue(CYRILLIC_RE.search(narrative), narrative)
        self.assertTrue(recommendations and CYRILLIC_RE.search(recommendations), recommendations)
        self.assertNotRegex(narrative, CJK_RE)
        self.assertNotRegex(recommendations, CJK_RE)
        self.assertEqual(json.loads(recommendations)[0]["feature"], "Проверка и восстановление")

    def test_metrics_titles_are_russian(self) -> None:
        report = self.report(privacy="metrics")
        self.assertEqual(report["session_summaries"][0]["title"], "Содержимое скрыто")

    def test_empty_home_warning_is_russian(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            report = analyzer.build_report(self.config(Path(temp)))
        self.assertTrue(report["warnings"])
        self.assertTrue(all(CYRILLIC_RE.search(item) for item in report["warnings"]), report["warnings"])
        self.assertNotRegex(" ".join(report["warnings"]), CJK_RE)

    def test_russian_count_forms(self) -> None:
        self.assertEqual(analyzer.russian_count(1, "сессия", "сессии", "сессий"), "1 сессия")
        self.assertEqual(analyzer.russian_count(3, "сессия", "сессии", "сессий"), "3 сессии")
        self.assertEqual(analyzer.russian_count(11, "сессия", "сессии", "сессий"), "11 сессий")
        self.assertEqual(analyzer.russian_count(1.5, "час", "часа", "часов"), "1,5 часа")
        self.assertEqual(analyzer.russian_count(2, "патч", "патча", "патчей"), "2 патча")
        self.assertEqual(analyzer.russian_count(12, "сессия", "сессии", "сессий"), "12 сессий")
        self.assertEqual(analyzer.russian_count(21, "патч", "патча", "патчей"), "21 патч")
        self.assertEqual(analyzer.russian_count(1.0, "час", "часа", "часов"), "1 час")
        self.assertEqual(messages.t("ru", "excerpt.no_title"), "Нет подходящего заголовка")

    def test_rendered_html_declares_russian_locale(self) -> None:
        html = analyzer.render_html(self.report())
        self.assertIn('<html lang="ru">', html)
        self.assertIn('const locale = ["zh-CN", "en", "ru"]', html)
        self.assertIn("Семейства задач, роли и свидетельства завершения", html)

    def test_cli_accepts_russian_locale(self) -> None:
        self.assertEqual(analyzer.make_parser().parse_args(["--locale", "ru"]).locale, "ru")

    def test_semantic_recommendation_evidence_is_russian(self) -> None:
        items = [{
            "recommendation_key": "verification",
            "title": "Сохраняйте свидетельства проверки",
            "text": "Проверка подтверждает изменения.",
            "action": "Фиксируйте результаты проверки.",
            "copy_prompt": "Проверьте изменение и приложите свидетельства.",
            "supporting_task_family_ids": ["family-a", "family-b"],
            "evidence_refs": ["evidence-a"],
            "confidence": "high",
            "measurement": "inferred",
        }]
        recommendations = semantic.semantic_recommendations(items, locale="ru")
        self.assertEqual(
            recommendations[0]["evidence"],
            "Поддерживающих семейств задач: 2; high; inferred",
        )
        self.assertEqual(recommendations[0]["feature"], "Проверка и восстановление")

    def test_manifest_rejects_unknown_locale(self) -> None:
        with self.assertRaises(ValueError):
            semantic.config_from_manifest({
                "dsh_home": "/synthetic", "since": NOW, "until": NOW,
                "privacy": "local", "generated_at": NOW, "locale": "de",
            })


    def test_markdown_report_is_russian(self) -> None:
        markdown = analyzer.render_markdown(self.report())
        self.assertTrue(markdown.startswith("# DSH Session Insights"))
        self.assertIn("## Обзор", markdown)
        self.assertIn("## Рекомендуемые подходы", markdown)
        self.assertNotRegex(markdown, CJK_RE)

    def test_markdown_is_localized_for_each_supported_locale(self) -> None:
        cases = (
            ("en", "## Coverage"),
            ("ru", "## Покрытие"),
            ("zh-CN", "## 覆盖情况"),
        )
        for locale, heading in cases:
            markdown = analyzer.render_markdown(self.report(locale=locale))
            self.assertIn(heading, markdown)
            if locale != "zh-CN":
                self.assertNotRegex(markdown, CJK_RE)

    def test_recommendation_ids_are_locale_independent(self) -> None:
        totals = {
            "tool_failures": 2, "unchanged_retries": 1, "permission_blocks": 1, "sessions": 3,
            "aborted_turns": 0, "patches": 0, "git_commits": 0, "failed_patches": 0,
        }
        metrics = {
            "correction_like_messages": 2, "correction_rate_per_user_message": 0.2,
            "long_running_sessions": 1, "multi_agent_sessions": 0,
        }
        projects = [{"project": "/project", "sessions": 5, "tool_calls": 10, "active_hours": 2.0}]
        ids = [
            [item["id"] for item in analyzer.build_recommendations(totals, metrics, {"partial_sessions": 0}, projects, locale)]
            for locale in analyzer.SUPPORTED_LOCALES
        ]
        self.assertTrue(ids[0])
        self.assertTrue(all(value == ids[0] for value in ids))

    def test_english_singular_warning_grammar(self) -> None:
        self.assertIn("1 rollout contains", messages.t("en", "warning.partial_sessions", count=1))
        self.assertIn("1 session stores", messages.t("en", "warning.newer_generation", count=1, version=4))
        self.assertIn("1 session directory uses", messages.t("en", "warning.encoding_mismatch", count=1))
        self.assertIn("1 carries", messages.t("en", "warning.attempts", attempts=1, covered=1))

    def test_report_dispatch_returns_russian_recommendations(self) -> None:
        totals = {
            "tool_failures": 2, "unchanged_retries": 1, "permission_blocks": 1, "sessions": 3,
            "aborted_turns": 0, "patches": 0, "git_commits": 0, "failed_patches": 0,
        }
        metrics = {
            "correction_like_messages": 2, "correction_rate_per_user_message": 0.2,
            "long_running_sessions": 1, "multi_agent_sessions": 0,
        }
        recommendations = analyzer.build_recommendations(
            totals, metrics, {"partial_sessions": 0},
            [{"project": "/project", "sessions": 5, "tool_calls": 10, "active_hours": 2.0}],
            "ru",
        )
        self.assertTrue(recommendations)
        self.assertEqual(recommendations[0]["feature"], "Проверка и восстановление")
        self.assertNotRegex(json.dumps(recommendations, ensure_ascii=False), CJK_RE)

    def test_message_catalog_has_all_locales(self) -> None:
        for key, entry in messages.MESSAGES.items():
            self.assertEqual(set(entry), set(messages.LOCALES), key)
        label_keys = set(messages.MARKDOWN_LABELS["zh-CN"])
        for locale in messages.LOCALES:
            self.assertEqual(set(messages.MARKDOWN_LABELS[locale]), label_keys, locale)
        for locale in messages.LOCALES:
            self.assertEqual(messages.missing_keys(locale), [])
        with self.assertRaises(KeyError):
            messages.t("ru", "missing.key")
        russian_strings = [
            value
            for entry in messages.MESSAGES.values()
            for value in (entry["ru"],)
            if isinstance(value, str)
        ]
        self.assertNotRegex("\n".join(russian_strings), CJK_RE)

    def test_unknown_report_locale_falls_back_to_chinese_html(self) -> None:
        report = self.report()
        report["scope"]["locale"] = "de"
        self.assertIn('<html lang="zh-CN">', analyzer.render_html(report))

if __name__ == "__main__":
    unittest.main()

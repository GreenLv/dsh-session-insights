from __future__ import annotations

import json
import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


TEMPLATE = Path(__file__).parents[1] / "src" / "dsh_session_insights" / "assets" / "dashboard.html"
CJK_RE = re.compile(r"[\u3400-\u9fff]")


class _StaticTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ignored_depth = 0
        self.values: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"style", "script"}:
            self.ignored_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"style", "script"}:
            self.ignored_depth -= 1

    def handle_data(self, data: str) -> None:
        value = data.strip()
        if self.ignored_depth == 0 and value and CJK_RE.search(value):
            self.values.append(value)


class DashboardLocalizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.template = TEMPLATE.read_text(encoding="utf-8")
        match = re.search(
            r"const staticEnglishText = new Map\((\[.*?\])\);",
            cls.template,
            flags=re.DOTALL,
        )
        if match is None:
            raise AssertionError("static English text map is missing")
        cls.static_pairs = json.loads(match.group(1))
        cls.static_map = dict(cls.static_pairs)

    def test_static_ui_uses_complete_string_lookup(self) -> None:
        self.assertNotIn("englishReplacements", self.template)
        self.assertNotIn("split(source).join(target)", self.template)
        self.assertEqual(len(self.static_pairs), len(self.static_map), "duplicate static localization key")
        self.assertEqual(self.static_map["全部项目"], "All projects")
        self.assertEqual(self.static_map["你的工作内容"], "What you work on")
        self.assertEqual(self.static_map["任务族、角色与完成证据"], "Task families, roles, and completion evidence")
        self.assertNotIn("轮", self.static_map, "single-character translation rules are unsafe")

    def test_every_static_chinese_text_node_has_an_exact_english_entry(self) -> None:
        parser = _StaticTextParser()
        parser.feed(self.template.split('<script id="report-data"', 1)[0])
        missing = sorted(set(parser.values).difference(self.static_map))
        self.assertEqual(missing, [], f"static UI text lacks exact English mappings: {missing}")

    def test_dynamic_ui_routes_bilingual_text_explicitly(self) -> None:
        required_contracts = [
            'ui(`前段样本稀疏',
            'Only the first 30 sessions are shown for readability',
            'per session on average`,',
            'Daily ${labels[measure][0].toLowerCase()}',
            '"# DSH Session Insights"',
            'Local self-contained report with no network requests.',
        ]
        for contract in required_contracts:
            self.assertIn(contract, self.template)


if __name__ == "__main__":
    unittest.main()

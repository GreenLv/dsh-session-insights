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
            r"const staticText = new Map\((\[.*?\])\);",
            cls.template,
            flags=re.DOTALL,
        )
        if match is None:
            raise AssertionError("static translation map is missing")
        cls.static_rows = json.loads(match.group(1))
        cls.static_map = {row[0]: row[1] for row in cls.static_rows}

    def test_static_ui_uses_complete_string_lookup(self) -> None:
        self.assertNotIn("englishReplacements", self.template)
        self.assertNotIn("split(source).join(target)", self.template)
        self.assertEqual(len(self.static_rows), len(self.static_map), "duplicate static localization key")
        self.assertEqual(self.static_map["全部项目"], ["All projects", "Все проекты"])
        self.assertEqual(self.static_map["你的工作内容"], ["What you work on", "Над чем вы работаете"])
        self.assertEqual(
            self.static_map["任务族、角色与完成证据"],
            ["Task families, roles, and completion evidence", "Семейства задач, роли и свидетельства завершения"],
        )
        for source, translations in self.static_map.items():
            self.assertEqual(len(translations), 2, f"expected English and Russian for {source}")
            for translation in translations:
                self.assertTrue(translation.strip(), f"empty translation for {source}")
            self.assertNotRegex(translations[1], CJK_RE, f"Russian translation keeps CJK text: {source}")

    def test_every_static_chinese_text_node_has_an_exact_translation(self) -> None:
        parser = _StaticTextParser()
        parser.feed(self.template.split('<script id="report-data"', 1)[0])
        missing = sorted(set(parser.values).difference(self.static_map))
        self.assertEqual(missing, [], f"static UI text lacks exact translations: {missing}")

    def test_dynamic_ui_routes_trilingual_text_explicitly(self) -> None:
        required_contracts = [
            'ui(`前段样本稀疏',
            'Only the first 30 sessions are shown for readability',
            'Для читаемости показаны только первые 30 сессий',
            'per session on average',
            '"# DSH Session Insights"',
            'Local self-contained report with no network requests.',
            'Локальный автономный отчёт без сетевых запросов.',
            '## Области проектов',
        ]
        for contract in required_contracts:
            self.assertIn(contract, self.template)

    def test_russian_dynamic_labels_cover_primary_views(self) -> None:
        required_contracts = [
            'Семейства задач, роли и использование rollout',
            'Сбои вызовов инструментов',
            'Свидетельства локального содержимого',
            'Первый период',
            'Семантический анализ завершён',
            'Статус внедрения',
        ]
        for contract in required_contracts:
            self.assertIn(contract, self.template)


    def test_every_ui_call_has_three_localized_arguments(self) -> None:
        source = self.template.split('"use strict";', 1)[1]
        calls: list[list[str]] = []
        offset = 0
        while True:
            start = source.find('ui(', offset)
            if start == -1:
                break
            if source[max(0, start - 9):start].endswith('function '):
                offset = start + 3
                continue
            index = start + 3
            depth = 1
            state = 'code'
            args: list[str] = []
            arg_start = index
            while index < len(source) and depth:
                char = source[index]
                if state == 'code':
                    if char in "'\"`":
                        state = char
                    elif char == '(':
                        depth += 1
                    elif char == ')':
                        depth -= 1
                        if depth == 0:
                            break
                    elif char == ',' and depth == 1:
                        args.append(source[arg_start:index])
                        arg_start = index + 1
                    index += 1
                elif state == 'template':
                    if char == '\\':
                        index += 2
                    elif char == '`':
                        state = 'code'
                        index += 1
                    elif char == '$' and source[index + 1:index + 2] == '{':
                        index += 2
                        braces = 1
                        while index < len(source) and braces:
                            if source[index] == '{':
                                braces += 1
                            elif source[index] == '}':
                                braces -= 1
                            index += 1
                    else:
                        index += 1
                else:
                    if char == '\\':
                        index += 2
                    elif char == state:
                        state = 'code'
                        index += 1
                    else:
                        index += 1
            args.append(source[arg_start:index])
            calls.append([arg.strip() for arg in args if arg.strip()])
            offset = index + 1
        self.assertTrue(calls)
        wrong = [args for args in calls if len(args) != 3]
        self.assertEqual(wrong, [], f"ui() must receive zh, en and ru: {wrong}")


if __name__ == "__main__":
    unittest.main()

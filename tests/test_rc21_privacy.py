"""New free-string projections: production report, JSON, HTML and Markdown parity."""
import copy
from dataclasses import replace
import json
import re
import subprocess
import unittest
from pathlib import Path

from dsh_session_insights import analyzer
from test_021_events import config, snapshot
import test_native_parity

ROOT = Path(__file__).parents[1]


class Rc21PrivacyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Share the exact synthetic matrix/constructor with the Node owning test.
        result = subprocess.run(['node', '--input-type=module', '-e',
            "import {privacyValues,privacySnapshot} from './tests-js/fixtures/rc21-privacy.mjs'; "
            "process.stdout.write(JSON.stringify(privacyValues.map(v=>({...v,snapshot:privacySnapshot(v.value)}))))"],
            cwd=ROOT, capture_output=True, text=True, check=True)
        cls.cases = json.loads(result.stdout)

    def test_free_string_projection_and_rendered_outputs(self):
        for vector in self.cases:
            for privacy in ('local', 'redacted', 'metrics'):
                for locale in ('en', 'zh-CN'):
                    with self.subTest(case=vector['name'], privacy=privacy, locale=locale):
                        cfg = replace(config(), privacy_mode=privacy, metrics_only=privacy == 'metrics', locale=locale)
                        value = vector['snapshot']
                        report = analyzer.build_report(cfg, session_snapshots=[value])
                        html = analyzer.render_html(report)
                        markdown = analyzer.render_markdown(report)
                        embedded = json.loads(re.search(r'<script id="report-data"[^>]*>([\s\S]*?)</script>', html)[1])
                        self.assertEqual(embedded, report)
                        if vector['sensitive'] and (privacy != 'local' or vector.get('forbidden')):
                            forbidden = vector.get('forbidden', vector['value'])
                            for text in (json.dumps(report), json.dumps(embedded), markdown):
                                self.assertNotIn(json.dumps(forbidden)[1:-1], text)
                        if privacy == 'metrics':
                            self.assertNotIn(vector['value'], json.dumps(report))
                        jobs = report['session_summaries'][0]['jobs']
                        self.assertEqual(jobs['by_kind'], report['totals']['jobs']['by_kind'])
                        self.assertEqual(jobs['by_kind'][jobs['items'][0]['kind']], 1)
                        test_native_parity.NativeParityTests.compare(self, [value], privacy, locale)
                        native = subprocess.run(['node', str(ROOT / 'tests-js/fixtures/privacy-report.mjs')],
                            input=json.dumps({'snapshots': [value], 'options': {
                                'now': value['session']['createdAt'] + 86400000, 'days': 30,
                                'privacy': privacy, 'locale': locale, 'analysis_depth': 'evidence'}}),
                            capture_output=True, text=True, check=True)
                        rendered = json.loads(native.stdout)
                        native_embedded = json.loads(re.search(r'<script id="report-data"[^>]*>([\s\S]*?)</script>', rendered['html'])[1])
                        self.assertEqual(native_embedded, rendered['report'])
                        # Provider aggregation and plugin coverage are beyond the
                        # older generic parity comparator's selected fields.
                        for key in ('providers', 'provider_models'):
                            canonical = lambda rows: sorted(json.dumps(row, sort_keys=True) for row in rows)
                            self.assertEqual(canonical(report[key]), canonical(rendered['report'][key]))
                        self.assertEqual(report['coverage']['plugin_records'], rendered['report']['coverage']['plugin_records'])

    def test_normal_categories_and_collision_counts(self):
        for privacy in ('local', 'redacted', 'metrics'):
            cfg = replace(config(), privacy_mode=privacy, metrics_only=privacy == 'metrics')
            for kind in ('bash', 'pwsh', 'pty-send', 'workflow', 'subagent'):
                value = snapshot('job-lifecycle')
                for event in value['events']:
                    if event['type'].startswith('job/'):
                        event['data']['kind'] = kind
                report = analyzer.build_report(cfg, session_snapshots=[value])
                self.assertEqual(report['totals']['jobs']['by_kind'], {kind: 1})
                self.assertEqual(report['session_summaries'][0]['jobs']['items'][0]['kind'], kind)
        values = []
        for suffix in ('one', 'two'):
            value = snapshot('job-lifecycle')
            value['session']['id'] += suffix
            for event in value['events']:
                if event['type'].startswith('job/'):
                    event['data']['kind'] = 'api_key' + '=synthetic-' + suffix
            values.append(value)
        report = analyzer.build_report(config(), session_snapshots=values)
        self.assertEqual(sum(report['totals']['jobs']['by_kind'].values()), 2)

    def test_nested_descriptor_values_are_not_copied_to_reports(self):
        value = copy.deepcopy(self.cases[0]['snapshot'])
        data = next(event['data'] for event in value['events'] if event['type'] == 'subagent/descriptor')
        for key in ('version', 'mode', 'provider', 'agentProvider', 'agentModel'):
            data[key] = {'raw': '/synthetic/private/nested'}
        for privacy in ('redacted', 'metrics'):
            cfg = replace(config(), privacy_mode=privacy, metrics_only=privacy == 'metrics')
            report = analyzer.build_report(cfg, session_snapshots=[value])
            self.assertTrue(all(item is None for item in report['session_summaries'][0]['subagent'].values()))
            self.assertNotIn('/synthetic/private/nested', json.dumps(report))
            test_native_parity.NativeParityTests.compare(self, [value], privacy)

    def test_subagent_fork_counts_as_subagent_usage(self):
        value = snapshot('subagent')
        next(event['data'] for event in value['events']
             if event['type'] == 'tool/call' and event['data']['name'] == 'subagent')['name'] = 'subagent_fork'
        report = analyzer.build_report(config(), session_snapshots=[value])
        self.assertEqual(report['totals']['subagents'], 1)
        self.assertEqual(report['session_summaries'][0]['subagents'], 1)
        self.assertEqual(report['totals']['delegation']['dispatches_by_tool']['subagent_fork'], 1)
        test_native_parity.NativeParityTests.compare(self, [value])

"""Host-independent cwd display family, through public report projections."""
import json
import re
import subprocess
import unittest
from dataclasses import replace
from pathlib import Path, PurePosixPath, PureWindowsPath
from unittest.mock import patch

from dsh_session_insights import analyzer
from test_021_events import config, snapshot
import test_native_parity

ROOT = Path(__file__).parents[1]
VECTORS = json.loads((ROOT / 'tests/fixtures/rc21-cwd-label-vectors.json').read_text())
CONTEXTS = ('origin', 'own', 'inherited', 'inherited-own')


def cwd_label_snapshot(vector, context):
    base = snapshot('job-lifecycle')
    cwd = ''.join(vector['cwd_parts'])
    value = {'session': {**base['session'], 'id': 'synthetic-cwd-' + vector['name'], 'isSeeded': True},
             'events': [], 'inheritedEventCount': 0}
    def add(kind, data):
        value['events'].append({'type': kind, 'data': data, 'seq': len(value['events']),
                                'time': base['session']['createdAt']})
    if context == 'origin':
        value['session']['cwd'] = cwd
    if context in ('inherited', 'inherited-own'):
        add('working-directory/change', {'cwd': cwd})
        value['inheritedEventCount'] = 1
    add('session/end-seed', {'inherited': True})
    if context == 'own':
        add('working-directory/change', {'cwd': cwd})
    if context == 'inherited-own':
        add('working-directory/change', {'cwd': '/synthetic/after-cut'})
    return value


def expected_directory_labels(vector, context):
    trajectory = [vector['label']] if context == 'origin' else ['project-a', vector['label']]
    if context == 'inherited-own':
        trajectory.append('after-cut')
    return {'trajectory': trajectory,
            'origin_label': vector['label'] if context == 'origin' else 'project-a',
            'effective_at_cut': 'project-a' if context == 'own' else vector['label']}


class Rc21CwdLabelFamilyTests(unittest.TestCase):
    def test_label_oracle_avoids_host_filesystem_path_semantics(self):
        # This is the actual cross-platform counterexample, on every test host.
        self.assertEqual(PureWindowsPath('//server/share').name, '')
        self.assertEqual(PurePosixPath('//server/share').name, 'share')
        for vector in VECTORS:
            with self.subTest(case=vector['name']):
                # Both ambient and explicit filesystem interpretation are
                # forbidden inside the trajectory display projection.
                with patch.object(analyzer, 'Path', side_effect=AssertionError('ambient Path used')), \
                     patch.object(analyzer, 'PureWindowsPath', side_effect=AssertionError('Windows anchor used')):
                    self.assertEqual(analyzer.cwd_label(''.join(vector['cwd_parts'])), vector['label'])

    def test_production_trajectory_projection_and_rendering_family(self):
        for context in CONTEXTS:
            values = [cwd_label_snapshot(vector, context) for vector in VECTORS]
            for privacy in ('local', 'redacted', 'metrics'):
                for locale in ('en', 'zh-CN'):
                    with self.subTest(context=context, privacy=privacy, locale=locale):
                        cfg = replace(config(), privacy_mode=privacy, metrics_only=privacy == 'metrics', locale=locale)
                        report = analyzer.build_report(cfg, session_snapshots=values)
                        html = analyzer.render_html(report)
                        embedded = json.loads(re.search(r'<script id="report-data"[^>]*>([\s\S]*?)</script>', html)[1])
                        output = subprocess.run(['node', str(ROOT / 'tests-js/fixtures/native-report.mjs')],
                            input=json.dumps({'snapshots': values, 'options': {
                                'now': values[0]['session']['createdAt'] + 86400000, 'days': 30,
                                'privacy': privacy, 'locale': locale, 'analysis_depth': 'evidence'}}),
                            capture_output=True, text=True, encoding='utf-8', check=True)
                        native = json.loads(output.stdout)['report']
                        for index, vector in enumerate(VECTORS):
                            directory = report['session_summaries'][index]['working_directory']
                            for key, expected in expected_directory_labels(vector, context).items():
                                self.assertEqual(directory[key], expected, vector['name'] + '.' + key)
                            self.assertEqual(directory, native['session_summaries'][index]['working_directory'])
                            self.assertEqual(directory, embedded['session_summaries'][index]['working_directory'])
                            encoded = json.dumps(directory, ensure_ascii=False)
                            raw = ''.join(vector['cwd_parts'])
                            if '/' in raw or '\\' in raw:
                                self.assertNotIn(json.dumps(raw, ensure_ascii=False)[1:-1], encoded, vector['name'])
                            self.assertNotIn('synthetic-cwd-secret', encoded)
                            self.assertNotIn('synthetic_cwd_secret', encoded)
                        # Existing header-project display/filtering is outside
                        # this trajectory projection; full parity still covers
                        # every context whose immutable origin is unchanged.
                        if context != 'origin':
                            test_native_parity.NativeParityTests.compare(self, values, privacy, locale)

    def test_filter_still_uses_immutable_header_origin(self):
        value = cwd_label_snapshot({'name': 'filter', 'cwd_parts': ['/synthetic/other'], 'label': 'other'}, 'inherited-own')
        origin = analyzer.build_report(replace(config(), project=value['session']['cwd']), session_snapshots=[value])
        changed = analyzer.build_report(replace(config(), project='/synthetic/other'), session_snapshots=[value])
        self.assertEqual(origin['totals']['sessions'], 1)
        self.assertEqual(changed['totals']['sessions'], 0)

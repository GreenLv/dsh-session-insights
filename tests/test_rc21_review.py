"""Review counterexamples, shared with Node, through production report entrypoints."""
import copy
import json
import subprocess
import unittest
from pathlib import Path

from dsh_session_insights import analyzer
from test_021_events import config, snapshot
import test_native_parity

ROOT = Path(__file__).parents[1]
VECTORS = json.loads((ROOT / 'tests/fixtures/rc21-review-vectors.json').read_text())


def cwd_snapshot(vector):
    base = snapshot('job-lifecycle')
    value = {'session': {**base['session'], 'isSeeded': True}, 'events': [],
             'inheritedEventCount': len(vector['inherited'])}
    def add(kind, data):
        value['events'].append({'type': kind, 'seq': len(value['events']),
                                'time': base['session']['createdAt'], 'data': data})
    for cwd in vector['inherited']:
        add('working-directory/change', {'cwd': cwd})
    add('session/end-seed', {'inherited': True})
    for cwd in vector['own']:
        add('working-directory/change', {'cwd': cwd})
    return value


def settlement_snapshot(vector, paired, inherited=False):
    value = snapshot('job-lifecycle')
    if not paired:
        value['events'] = [event for event in value['events'] if event['type'] != 'job/registered']
    if inherited:
        value['events'] = [event for event in value['events'] if event['type'].startswith('job/')]
        value['session']['isSeeded'] = True
        value['inheritedEventCount'] = len(value['events'])
        value['events'].append({'type': 'session/end-seed', 'data': {'inherited': True},
                                'time': value['session']['createdAt']})
    for seq, event in enumerate(value['events']):
        event['seq'] = seq
    data = next(event['data'] for event in value['events'] if event['type'] == 'job/settled')
    if vector.get('missing'):
        data.pop(vector['field'], None)
    else:
        data[vector['field']] = copy.deepcopy(vector['value'])
    return value


def report(value):
    return analyzer.build_report(config(), session_snapshots=[value])['session_summaries'][0]


class Rc21ReviewTests(unittest.TestCase):
    def test_cwd_cut_order_and_platform_vectors(self):
        for vector in VECTORS['cwd']:
            with self.subTest(case=vector['name']):
                value = cwd_snapshot(vector)
                directory = report(value)['working_directory']
                for key, expected in vector['expected'].items():
                    self.assertEqual(directory[key], expected, key)
                self.assertEqual(directory['inherited_labels'], list(dict.fromkeys(
                    cwd.rsplit('/', 1)[-1] for cwd in vector['inherited'] if cwd)))
                self.assertEqual(directory['origin_label'], 'project-a')
                for privacy in ('local', 'redacted', 'metrics'):
                    for locale in ('en', 'zh-CN'):
                        test_native_parity.NativeParityTests.compare(self, [value], privacy, locale)

    def test_settlement_validation_is_independent_of_pairing(self):
        for paired, inherited in ((True, False), (False, False), (True, True), (False, True)):
            for vector in VECTORS['settlement']:
                with self.subTest(paired=paired, inherited=inherited, case=vector['name']):
                    value = settlement_snapshot(vector, paired, inherited)
                    if vector['accepted']:
                        jobs = report(value)['jobs']
                        self.assertEqual(jobs['unpaired_settlement'], 0 if paired else 1)
                        self.assertEqual(jobs['settled'], 1 if paired else 0)
                        test_native_parity.NativeParityTests.compare(self, [value])
                    else:
                        error = f"invalid job settlement: {vector['field']}"
                        with self.assertRaisesRegex(ValueError, error):
                            report(value)
                        output = subprocess.run(
                            ['node', str(ROOT / 'tests-js/fixtures/native-report.mjs')],
                            input=json.dumps({'snapshots': [value], 'options': {
                                'now': value['session']['createdAt'] + 86400000,
                                'days': 30, 'privacy': 'redacted', 'locale': 'en'}}),
                            text=True, encoding='utf-8', capture_output=True)
                        self.assertNotEqual(output.returncode, 0)
                        self.assertIn(error, output.stderr)

    def test_nonfinite_finished_time_is_refused(self):
        for paired in (True, False):
            for value in (float('nan'), float('inf'), float('-inf')):
                with self.subTest(paired=paired, value=value):
                    with self.assertRaisesRegex(ValueError, 'invalid job settlement: finishedAt'):
                        report(settlement_snapshot({'field': 'finishedAt', 'value': value}, paired))


if __name__ == '__main__':
    unittest.main()

"""Differential migration checks against the retained Python snapshot reader."""
import copy
import json
from pathlib import Path
import subprocess
import unittest
from datetime import datetime, timedelta
from dsh_session_insights import analyzer
from helpers import records, NOW
from test_session_format_v3 import v3_header, v3_events

ROOT = Path(__file__).resolve().parents[1]

class NativeParityTests(unittest.TestCase):
    def test_legacy_and_v3_statistics_across_privacy_modes(self):
        snapshots = []
        for i in range(1, 9):
            rows = records(i)
            snapshots.append({'session': rows[0], 'events': rows[1:]})
        snapshots.append({'session': v3_header('native-v3'), 'events': v3_events()})
        child = copy.deepcopy(snapshots[0])
        child['session'].update(id='child', origin='subagent', parentSession='synthetic-1')
        snapshots.append(child)
        for privacy in ('local', 'redacted', 'metrics'):
            for locale in ('en', 'zh-CN'):
                with self.subTest(privacy=privacy, locale=locale):
                    self.compare(snapshots, privacy, locale)

    def compare(self, snapshots, privacy='redacted', locale='en'):
        now = datetime.fromisoformat(NOW.replace('Z', '+00:00'))
        config = analyzer.AnalysisConfig(dsh_home=Path('/synthetic'), since=now-timedelta(days=30), until=now, generated_at=now, privacy_mode=privacy, metrics_only=privacy=='metrics', semantic_capture=True, deterministic_cache=False, locale=locale)
        reference = analyzer.build_report(config, session_snapshots=snapshots)
        output = subprocess.run(['node', str(ROOT/'tests-js/fixtures/native-report.mjs')], input=json.dumps({'snapshots':snapshots,'options':{'now':int(now.timestamp()*1000),'days':30,'privacy':privacy,'locale':locale,'analysis_depth':'evidence'}}), text=True, encoding='utf-8', capture_output=True)
        self.assertEqual(output.returncode, 0, output.stderr)
        native = json.loads(output.stdout)['report']
        for key, value in reference['totals'].items():
            self.assertEqual(native['totals'][key], value, f'totals.{key}')
        for key in ('projects','task_family_totals','interaction_metrics','role_metrics','platform_metrics','usage_profile'):
            self.assertEqual(native[key], reference[key], key)
        omitted = {'failure_rule_version'}
        for expected, actual in zip(reference['session_summaries'], native['session_summaries'], strict=True):
            for key, value in expected.items():
                if key not in omitted:
                    self.assertEqual(actual[key], value, f'session.{key}')
        for expected, actual in zip(reference['task_families'], native['task_families'], strict=True):
            self.assertEqual(actual, expected, 'task_family')
        return native

    def test_retry_approval_and_partial_turn_statistics(self):
        snapshot={'session':v3_header('retries'),'events':[]}
        def add(kind, **data):
            snapshot['events'].append({'type':kind,'seq':len(snapshot['events']),'data':data,'time':snapshot['session']['createdAt']})
        add('turn/start',turn=1)
        add('user/message',content=[{'type':'text','text':'Review implementation'}])
        for i in range(3):
            add('tool/call',name='bash',callId=str(i),arguments='python -m unittest')
            add('tool/result',callId=str(i),message={'content':[{'type':'text','text':'Command failed'}],'isError':True})
        add('tool/call',name='bash',callId='repair',arguments='touch repaired.txt')
        add('tool/result',callId='repair',message={'content':[{'type':'text','text':'Command completed'}],'isError':False})
        add('tool/call',name='bash',callId='4',arguments='python -m unittest')
        add('tool/result',callId='4',message={'content':[{'type':'text','text':'Command completed'}],'isError':False})
        add('approval/asked',id='approval',callId='5')
        add('approval/decided',id='approval',outcome='rejected')
        add('tool/call',name='bash',callId='5',arguments='touch x')
        add('tool/result',callId='5',error={'code':'FS_SANDBOX_DENIED'},message={'content':[{'type':'text','text':'permission denied'}]})
        self.compare([snapshot])

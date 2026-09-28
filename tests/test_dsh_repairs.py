"""Exact official admission plus Node/Python snapshot and CLI-file regression."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from dsh_session_insights import analyzer
import test_native_parity
ROOT = test_native_parity.ROOT

class DshRepairTests(unittest.TestCase):
    compare = test_native_parity.NativeParityTests.compare
    @classmethod
    def setUpClass(cls):
        runtime = os.environ.get('DSH_RUNTIME')
        if not runtime:
            raise RuntimeError('DSH_RUNTIME required for exact-target positive differential fixtures')
        result = subprocess.run(['node', str(ROOT/'scripts/dsh-repair-fixtures.mjs'), runtime, '--check'], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f'Official target fixture check failed:\n{result.stdout}\n{result.stderr}')
        cls.cases = json.loads(result.stdout)['cases']

    @staticmethod
    def recovery_expected(e):
        recovery = e.get('recovery') or [0, 0]
        return {'outcome_unknown': recovery[0], 'not_started': recovery[1]}

    def test_official_admitted_repairs_through_both_production_paths(self):
        for case in self.cases:
            with self.subTest(case=case['name']):
                s, e = case['snapshot'], case['expected']
                if case['name'] == 'nested-seed':
                    self.assertEqual(s['inheritedEventCount'],11)
                r = self.compare([s])
                self.assertEqual(r['totals']['tool_failures'], e['failures'])
                self.assertEqual(r['totals']['permission_blocks'], e['permission'])
                self.assertEqual(r['totals']['tool_recovery'], self.recovery_expected(e))
                self.assertEqual(r['session_summaries'][0]['verification']['successes'], e['success'])
                self.assertEqual(r['session_summaries'][0]['verification']['failures'], e.get('verificationFailures', 0))
                self.assertEqual(r['session_summaries'][0]['tool_recovery'], self.recovery_expected(e))
                with tempfile.TemporaryDirectory() as home:
                    path=Path(home)/'sessions/project/case';path.mkdir(parents=True)
                    shutil.copy2(ROOT/'tests/fixtures/rc2-repairs'/case['name']/'session.v4.jsonl',path/'session.v4.jsonl')
                    now=datetime.fromtimestamp((s['session']['createdAt']+86400000)/1000,tz=timezone.utc)
                    config=analyzer.AnalysisConfig(dsh_home=Path(home),since=now-timedelta(days=30),until=now,generated_at=now,privacy_mode='redacted',semantic_capture=True,deterministic_cache=False,locale='en')
                    cli=analyzer.build_report(config)
                    self.assertEqual(cli['totals']['sessions'],1)
                    self.assertEqual(cli['totals']['tool_failures'],e['failures'])
                    self.assertEqual(cli['totals']['tool_recovery'],self.recovery_expected(e))
                    self.assertEqual(cli['totals']['permission_blocks'],e['permission'])
                    self.assertEqual(cli['session_summaries'][0]['verification']['failures'],e.get('verificationFailures',0))
                    self.assertEqual(cli['session_summaries'][0]['tool_recovery'],self.recovery_expected(e))

    def test_official_recovery_parity_across_privacy_and_locale(self):
        official = [c for c in self.cases if c['name'].startswith('recovery-') and (c['expected'].get('recovery') or [0, 0]) != [0, 0]]
        self.assertGreaterEqual(len(official), 4)
        for case in official:
            for privacy in ('local', 'redacted', 'metrics'):
                for locale in ('en', 'zh-CN'):
                    with self.subTest(case=case['name'], privacy=privacy, locale=locale):
                        r = self.compare([case['snapshot']], privacy, locale)
                        self.assertEqual(r['totals']['tool_recovery'], self.recovery_expected(case['expected']))
                        self.assertEqual(r['totals']['tool_failures'], case['expected']['failures'])

    def test_cli_repeat_analysis_keeps_recovery_stable(self):
        case = next(c for c in self.cases if c['name'] == 'recovery-mixed-group')
        s = case['snapshot']
        with tempfile.TemporaryDirectory() as home:
            path=Path(home)/'sessions/project/case';path.mkdir(parents=True)
            shutil.copy2(ROOT/'tests/fixtures/rc2-repairs'/'recovery-mixed-group'/'session.v4.jsonl',path/'session.v4.jsonl')
            now=datetime.fromtimestamp((s['session']['createdAt']+86400000)/1000,tz=timezone.utc)
            config=analyzer.AnalysisConfig(dsh_home=Path(home),since=now-timedelta(days=30),until=now,generated_at=now,privacy_mode='redacted',semantic_capture=False,deterministic_cache=True,locale='en')
            first=analyzer.build_report(config)
            second=analyzer.build_report(config)
            self.assertEqual(first['totals']['tool_recovery'],{'outcome_unknown':1,'not_started':1})
            self.assertEqual(first['totals']['tool_failures'],1)
            self.assertEqual(second['totals']['tool_recovery'],first['totals']['tool_recovery'])
            self.assertEqual(second['totals']['tool_failures'],first['totals']['tool_failures'])

    def test_settled_call_keeps_outcome_and_late_recovery_is_not_counted(self):
        case = next(c for c in self.cases if c['name'] == 'recovery-text-only')
        s = json.loads(json.dumps(case['snapshot']))
        s['events'][5]['data']['message']['isError'] = False
        s['events'][5]['data']['message']['content'] = [{'type': 'text', 'text': 'Command completed'}]
        late = json.loads(json.dumps(s['events'][5]))
        late['data']['message']['id'] = 'late-recovery'
        late['data']['error'] = {'name': 'ToolOutcomeUnknownError', 'code': 'TOOL_OUTCOME_UNKNOWN'}
        s['events'].insert(6, late)
        for i, event in enumerate(s['events']):
            event['seq'] = i
        r = self.compare([s])
        self.assertEqual(r['totals']['tool_failures'], 0)
        self.assertEqual(r['session_summaries'][0]['verification']['successes'], 1)
        self.assertEqual(r['totals']['tool_recovery'], {'outcome_unknown': 0, 'not_started': 0})

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

class Rc2RepairTests(unittest.TestCase):
    compare = test_native_parity.NativeParityTests.compare
    @classmethod
    def setUpClass(cls):
        runtime = os.environ.get('DSH_RUNTIME')
        if not runtime:
            raise RuntimeError('DSH_RUNTIME required for exact rc.2 positive differential fixtures')
        result = subprocess.run(['node', str(ROOT/'scripts/rc2-repair-fixtures.mjs'), runtime, '--check'], check=True, capture_output=True, text=True)
        cls.cases = json.loads(result.stdout)['cases']

    def test_official_admitted_repairs_through_both_production_paths(self):
        for case in self.cases:
            with self.subTest(case=case['name']):
                s, e = case['snapshot'], case['expected']
                if case['name'] == 'nested-seed':
                    self.assertEqual(s['inheritedEventCount'],11)
                r = self.compare([s])
                self.assertEqual(r['totals']['tool_failures'], e['failures'])
                self.assertEqual(r['totals']['permission_blocks'], e['permission'])
                self.assertEqual(r['session_summaries'][0]['verification']['successes'], e['success'])
                self.assertEqual(r['session_summaries'][0]['verification']['failures'], e.get('verificationFailures', 0))
                with tempfile.TemporaryDirectory() as home:
                    path=Path(home)/'sessions/project/case';path.mkdir(parents=True)
                    shutil.copy2(ROOT/'tests/fixtures/rc2-repairs'/case['name']/'session.v4.jsonl',path/'session.v4.jsonl')
                    now=datetime.fromtimestamp((s['session']['createdAt']+86400000)/1000,tz=timezone.utc)
                    config=analyzer.AnalysisConfig(dsh_home=Path(home),since=now-timedelta(days=30),until=now,generated_at=now,privacy_mode='redacted',semantic_capture=True,deterministic_cache=False,locale='en')
                    cli=analyzer.build_report(config)
                    self.assertEqual(cli['totals']['sessions'],1)
                    self.assertEqual(cli['totals']['tool_failures'],e['failures'])
                    self.assertEqual(cli['totals']['permission_blocks'],e['permission'])
                    self.assertEqual(cli['session_summaries'][0]['verification']['failures'],e.get('verificationFailures',0))

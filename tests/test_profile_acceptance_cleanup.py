"""The real annex consumer accepts producer success and cleanup failures."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from validate_host_annex import validate  # noqa: E402


class ProfileAcceptanceRoundTrip(unittest.TestCase):
    def test_real_portable_finally_faults_remain_valid_failed_receipts(self):
        for mode in ('dispose-failure', 'timeout'):
            with self.subTest(mode=mode):
                proc = subprocess.run(['node', str(ROOT / 'tests-js/fixtures/portable-finally-probe.mjs'), mode], cwd=ROOT, text=True, encoding='utf-8', capture_output=True, check=True)
                result = json.loads(proc.stdout)
                self.assertEqual(result['calls'], [])
                self.assertEqual(validate(result['annex'])['acceptance_status'], 'failed')
                self.assertIn('scratch-work', result['annex']['cleanup']['remaining_ids'])

    def test_real_entrypoint_setup_failure_has_valid_failed_receipt(self):
        with tempfile.TemporaryDirectory(prefix='dsi-profile-setup-') as raw:
            base = Path(raw)
            artifact = {'repository': 'https://example.invalid/repo', 'commit': '1' * 40,
                        'filename': 'candidate.tgz', 'sha256': '2' * 64, 'size_bytes': 1, 'file_count': 1}
            (base / 'artifact.json').write_text(json.dumps(artifact), encoding='utf-8')
            proc = subprocess.run(['node', str(ROOT / 'scripts/verify_profile_acceptance.mjs'), str(base), str(base / 'missing-host'), 'web'], cwd=ROOT, text=True, encoding='utf-8', capture_output=True)
            self.assertEqual(proc.returncode, 1)
            annex = json.loads((base / 'web-native-annex.json').read_text(encoding='utf-8'))
            self.assertEqual(validate(annex)['acceptance_status'], 'failed')
            self.assertEqual(annex['cleanup'], {'status': 'passed', 'remaining_ids': []})

    def test_cleanup_outcomes_round_trip(self):
        script = r'''
import {finalizeProfileAcceptance} from './scripts/acceptance_cleanup.mjs'
const fault=process.argv[1], sha='2'.repeat(64), commit='1'.repeat(40)
const evidence={mode:'executed',source_result_sha256:null,source_gate_id:null,invalidation_reason:null}
const gate={id:'operation',required:true,status:fault==='body'?'failed':'passed',subject:{kind:'artifact',id:sha},exit_code:fault==='body'?1:0,note:null,evidence}
const annex={schema:'native-acceptance/v2',status:'failed',product:'dsh-session-insights',gate_profile:'actual-web-host',repository:{url:'https://example.invalid/repo',commit},runtime_tree_sha256:null,artifact:{filename:'candidate.tgz',sha256:sha,size_bytes:1,file_count:1,git_head:commit},platform:{os:'macos',shell:'posix',toolchain:{node:process.version,dsh:'test'}},gates:[gate],cleanup:{status:'not_run',remaining_ids:[]},run:{started_at:new Date().toISOString(),finished_at:'',run_url:null},unperformed_actions:[]}
let receipt
const action=id=>async()=>{if(fault===id)throw Error('synthetic')}
const result=await finalizeProfileAcceptance({annex,failure:fault==='body'?Error('body'):undefined,hadWork:true,disposeOwner:action('owner'),shutdownApp:action('profile'),leaveWork:action('cwd'),removeWork:action('native-test-tree'),reportCleanupErrors:async()=>{},writeAnnex:async v=>{receipt=v},onClean:()=>{}})
console.log(JSON.stringify({result,receipt}))
'''
        for fault in ('none', 'body', 'owner', 'profile', 'cwd', 'native-test-tree'):
            with self.subTest(fault=fault):
                proc = subprocess.run(['node', '--input-type=module', '-e', script, fault], cwd=ROOT, text=True, encoding='utf-8', capture_output=True, check=True)
                output = json.loads(proc.stdout)
                expected = 'passed' if fault == 'none' else 'failed'
                self.assertEqual(output['result']['status'], expected)
                self.assertEqual(validate(output['receipt'])['acceptance_status'], expected)


if __name__ == '__main__':
    unittest.main()

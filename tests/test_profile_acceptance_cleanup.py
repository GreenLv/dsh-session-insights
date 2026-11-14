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
    def test_witness_projection_round_trips_success_and_failure_through_real_validator(self):
        script = r'''
import {projectWitnessGate} from './scripts/source_log_witness.mjs'
const passed=process.argv[1]==='pass', sha='2'.repeat(64), commit='1'.repeat(40)
const gate=projectWitnessGate({passed,artifactSha256:sha,witnessSha256:'3'.repeat(64)})
const annex={schema:'native-acceptance/v2',status:passed?'passed':'failed',product:'dsh-session-insights',gate_profile:'actual-web-host',repository:{url:'https://example.invalid/repo',commit},runtime_tree_sha256:null,artifact:{filename:'candidate.tgz',sha256:sha,size_bytes:1,file_count:1,git_head:commit},platform:{os:'macos',shell:'posix',toolchain:{node:process.version,dsh:'test'}},gates:[gate],cleanup:{status:'passed',remaining_ids:[]},run:{started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z',run_url:null},unperformed_actions:[]}
console.log(JSON.stringify(annex))
'''
        for mode in ('pass', 'fail'):
            with self.subTest(mode=mode):
                proc = subprocess.run(['node', '--input-type=module', '-e', script, mode], cwd=ROOT, text=True, encoding='utf-8', capture_output=True, check=True)
                annex = json.loads(proc.stdout)
                expected = 'passed' if mode == 'pass' else 'failed'
                self.assertEqual(validate(annex)['acceptance_status'], expected)
                self.assertIn('3' * 64, annex['gates'][0]['note'])

    def test_real_portable_finally_faults_remain_valid_failed_receipts(self):
        source = (ROOT / 'scripts/verify_host_acceptance.mjs').read_bytes().replace(b'\r\n', b'\n')
        for line_ending in ('lf', 'crlf'):
            with tempfile.TemporaryDirectory(prefix='dsi-portable-lines-') as raw:
                root = Path(raw)
                script = root / 'scripts/verify_host_acceptance.mjs'
                script.parent.mkdir()
                script.write_bytes(source if line_ending == 'lf' else source.replace(b'\n', b'\r\n'))
                for mode in ('dispose-failure', 'timeout'):
                    with self.subTest(line_ending=line_ending, mode=mode):
                        proc = subprocess.run(['node', str(ROOT / 'tests-js/fixtures/portable-finally-probe.mjs'), mode], cwd=root, text=True, encoding='utf-8', capture_output=True, check=True)
                        result = json.loads(proc.stdout)
                        self.assertEqual(result['calls'], [])
                        self.assertEqual(validate(result['annex'])['acceptance_status'], 'failed')
                        self.assertIn('scratch-work', result['annex']['cleanup']['remaining_ids'])

    def test_real_entrypoint_setup_failure_has_valid_failed_receipt(self):
        with tempfile.TemporaryDirectory(prefix='dsi-profile-setup-') as raw:
            base = Path(raw)
            proc = subprocess.run(['node', str(ROOT / 'scripts/verify_profile_acceptance.mjs'), str(base), str(base / 'missing-host'), 'web', '1' * 40, '2' * 64, '3' * 64], cwd=ROOT, text=True, encoding='utf-8', capture_output=True)
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

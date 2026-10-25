import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {COHORT_PATHS,POLICY_PATH,digest,inspectReport,assessAudit,captureAudit,verifyResults} from '../scripts/audit_node_deps.mjs'

const workflow='.github/workflows/ci.yml'
const files=Object.fromEntries([...COHORT_PATHS,workflow].map(p=>[p,readFileSync(new URL('../'+p,import.meta.url))]))
const policy=JSON.parse(readFileSync(new URL('../'+POLICY_PATH,import.meta.url),'utf8'))
const raw=readFileSync(new URL('../tests/fixtures/npm-audit-known-root.json',import.meta.url),'utf8')
const report=JSON.parse(raw),lock=JSON.parse(files['package-lock.json'])
const clone=value=>structuredClone(value)
const assess=(value=report,p=policy,f=files,scan={})=>assessAudit({raw:JSON.stringify(value),exit_code:1,...scan},p,f)
function changedFile(path,mutate){const value=JSON.parse(files[path]);mutate(value);return {...files,[path]:Buffer.from(JSON.stringify(value))}}
function outputs(fn){const dir=mkdtempSync(join(tmpdir(),'dsi-audit-'));try{return fn(dir)}finally{rmSync(dir,{recursive:true,force:true})}}
const knownScan=()=>({status:1,signal:null,stdout:raw,stderr:''})

test('single-release exception accepts the real 23-node report with one advisory',()=>{
  const result=assess()
  assert.equal(result.status,'accepted_known_risk');assert.equal(result.affected_packages,23);assert.equal(result.advisories,1)
  assert.equal(result.graph_sha256,policy.report_graph_sha256)
})

function smallCycle(exitToLeaf){
  const value=clone(report),tools='@deepseek-ai/dsh-tools',todo='@deepseek-ai/dsh-tool-todo'
  value.vulnerabilities=Object.fromEntries(['zod',tools,todo].map(n=>[n,value.vulnerabilities[n]]))
  value.vulnerabilities[tools].via=[todo]
  value.vulnerabilities[todo].via=exitToLeaf?[tools,'zod']:[tools]
  value.vulnerabilities[tools].effects=[todo];value.vulnerabilities[todo].effects=[tools]
  value.vulnerabilities.zod.effects=exitToLeaf?[todo]:[]
  value.metadata.vulnerabilities.high=3;value.metadata.vulnerabilities.total=3
  return value
}
test('a known-leaf subset cannot replace the exact whole reviewed graph',()=>{
  const value=clone(report),llm='@deepseek-ai/dsh-llm'
  value.vulnerabilities={zod:value.vulnerabilities.zod,[llm]:value.vulnerabilities[llm]}
  value.vulnerabilities.zod.effects=[llm];value.vulnerabilities[llm].effects=[]
  value.metadata.vulnerabilities.high=2;value.metadata.vulnerabilities.total=2
  assert.equal(inspectReport(value,lock).advisories,1)
  assert.throws(()=>assess(value),/graph drifted/)
})
for(const exitToLeaf of [false,true])test('cycles are refused even if an accepted leaf '+(exitToLeaf?'is an exit':'exists elsewhere'),()=>{
  // A controlled lock with this extra edge makes the cycle structurally
  // resolved; the cycle guard must still refuse it, independently of pinning.
  const changedLock=clone(lock)
  changedLock.packages['node_modules/@deepseek-ai/dsh-tools'].peerDependencies['@deepseek-ai/dsh-tool-todo']='0.2.1-rc.2'
  assert.throws(()=>inspectReport(smallCycle(exitToLeaf),changedLock),/cyclic advisory chain/)
})

for(const [name,mutate] of [
  ['unknown advisory',r=>{r.vulnerabilities.zod.via[0].url='https://github.com/advisories/GHSA-xxxx-yyyy-zzzz'}],
  ['known mixed with unknown advisory',r=>{const v=clone(r.vulnerabilities.zod.via[0]);v.url='https://github.com/advisories/GHSA-xxxx-yyyy-zzzz';r.vulnerabilities.zod.via.push(v)}],
  ['same advisory with a changed affected range',r=>{r.vulnerabilities.zod.via[0].range='<9.0.0'}],
  ['critical severity',r=>{r.vulnerabilities.zod.severity='critical'}],
  ['unresolved via',r=>{r.vulnerabilities.zod.via.push('unresolved-package')}],
  ['changed edges',r=>{r.vulnerabilities['@deepseek-ai/dsh-agent'].via.pop()}],
  ['other tree node path',r=>{r.vulnerabilities.zod.nodes=['node_modules/other/node_modules/zod']}],
  ['empty via',r=>{r.vulnerabilities.zod.via=[]}],
  ['duplicate edges',r=>{r.vulnerabilities.zod.via.push(clone(r.vulnerabilities.zod.via[0]))}],
  ['false count',r=>{r.metadata.vulnerabilities.high=0}],
  ['scanner error alongside findings',r=>{r.error={code:'ENETUNREACH'}}],
])test('audit rejects '+name,()=>{const value=clone(report);mutate(value);assert.throws(()=>assess(value))})

test('empty, malformed, unsupported and clean-shaped output cannot waive this known cohort',()=>{
  for(const text of ['', ' ', '{}', 'null', '[]','not JSON'])assert.throws(()=>assessAudit({raw:text,exit_code:1},policy,files))
  const empty=clone(report);empty.vulnerabilities={};empty.metadata.vulnerabilities.high=0;empty.metadata.vulnerabilities.total=0
  assert.throws(()=>inspectReport(empty,lock),/empty/)
  const unsupported=clone(report);unsupported.auditReportVersion=1;assert.throws(()=>assess(unsupported))
})
test('npm failure, cancellation and contradictory success exits never pass',()=>{
  for(const scan of [{exit_code:0},{exit_code:2},{exit_code:null},{signal:'SIGTERM'},{error:'ETIMEDOUT'}])assert.throws(()=>assess(report,policy,files,scan),/scanner failure/)
})

for(const path of COHORT_PATHS)test('exception expires when cohort file changes: '+path,()=>{
  assert.throws(()=>assess(report,policy,{...files,[path]:Buffer.concat([files[path],Buffer.from('\n')])}),/cohort changed/)
})
test('host queue drift expires the exception independently of manifest hashes',()=>{
  const drift={...files,[workflow]:Buffer.from(String(files[workflow]).replace("dsh: '0.2.1-rc.3'","dsh: '0.2.1-rc.4'"))}
  assert.throws(()=>assess(report,policy,drift),/host queue changed/)
})
test('an updated hash cannot broaden the fixed package version or host family',()=>{
  for(const [path,mutate,reason] of [
    ['package.json',p=>{p.version='0.6.2'},/project version/],
    ['package-lock.json',p=>{p.packages['node_modules/zod'].version='4.4.4'},/zod 4.4.3/],
    ['tests/dsh-runtime-rc3/package.json',p=>{Object.keys(p.dependencies).forEach(k=>{p.dependencies[k]='0.2.1-rc.4'})},/host pins/],
  ]){
    const drift=changedFile(path,mutate),p=clone(policy);p.cohort.files[path]=digest(drift[path])
    assert.throws(()=>assess(report,p,drift),reason)
  }
})
test('policy cannot silently expand to another CVE, version, calendar expiry or missing host lock',()=>{
  for(const mutate of [p=>{p.exception.cve='CVE-2099-0001'},p=>{p.product_version='0.6.2'},p=>{p.expiry.calendar_expiry='2099-01-01'},p=>{delete p.cohort.files['tests/dsh-host-rc3/package-lock.json']}]){
    const p=clone(policy);mutate(p);assert.throws(()=>assess(report,p))
  }
})

test('both scopes preserve the real failing scanner exit and raw JSON before assessment',()=>outputs(dir=>{
  for(const scope of ['prod','full']){
    const result=captureAudit(scope,join(dir,scope),{runner:knownScan})
    assert.equal(result.status,'accepted_known_risk');assert.equal(result.scan.exit_code,1)
    assert.equal(readFileSync(join(dir,scope,'audit.json'),'utf8'),raw)
    assert.equal(result.command.includes('--omit=dev'),scope==='prod')
    assert.ok(result.command.includes('--audit-level=high'))
  }
  assert.equal(verifyResults(dir,{prod:'success',full:'success',python:'success'}).status,'passed_with_known_upstream_risk')
  writeFileSync(join(dir,'full/audit.json'),raw+'\n')
  assert.throws(()=>verifyResults(dir,{prod:'success',full:'success',python:'success'}),/bytes changed/)
}))
test('scanner failure is retained and does not prevent the independent full scan',()=>outputs(dir=>{
  let calls=0
  const prod=captureAudit('prod',join(dir,'prod'),{runner:()=>{calls++;return {status:2,stdout:'{}',stderr:'synthetic database unreachable'}}})
  const full=captureAudit('full',join(dir,'full'),{runner:()=>{calls++;return knownScan()}})
  assert.equal(calls,2);assert.equal(prod.status,'failed');assert.equal(prod.scan.exit_code,2);assert.equal(full.status,'accepted_known_risk')
  assert.equal(readFileSync(join(dir,'prod/stderr.log'),'utf8'),'synthetic database unreachable')
  assert.throws(()=>verifyResults(dir,{prod:'failure',full:'success',python:'success'}),/required audit step/)
}))
test('required summary rejects absent, skipped, failed and cancelled Python or Node steps',()=>outputs(dir=>{
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{runner:knownScan})
  for(const name of ['prod','full','python'])for(const outcome of [undefined,'skipped','failure','cancelled']){
    assert.throws(()=>verifyResults(dir,{prod:'success',full:'success',python:'success',[name]:outcome}),/required audit step/)
  }
}))
test('spawn exceptions still emit a failed scan receipt',()=>outputs(dir=>{
  const result=captureAudit('prod',dir,{runner:()=>{throw new Error('synthetic spawn failure')}})
  assert.equal(result.status,'failed');assert.equal(result.scan.error,'SPAWN_ERROR')
  assert.equal(JSON.parse(readFileSync(join(dir,'result.json'),'utf8')).status,'failed')
}))

test('CI always collects all audits, checks outcome, and propagates Python pipeline failures',()=>{
  const source=String(files[workflow]),job=source.split('\n  dependency-security:\n')[1].split('\n  dsh-contract:\n')[0]
  for(const id of ['audit_prod','audit_full','audit_python']){
    const step=job.split('        id: '+id+'\n')[1].split('\n      - name:')[0]
    assert.match(step,/if: always\(\)/);assert.match(step,/continue-on-error: true/)
    assert.ok(job.includes('${{ steps.'+id+'.outcome }}'))
  }
  const python=job.split('        id: audit_python\n')[1].split('\n      - name:')[0]
  assert.match(python,/set -euo pipefail/)
  assert.match(job,/--verify-results reports\/dependency-audit/)
  if(process.platform!=='win32'){
    const protectedPipe=spawnSync('bash',['-c','set -euo pipefail\n(exit 37) | tee\nprintf unreachable'],{encoding:'utf8'})
    const unprotectedPipe=spawnSync('bash',['-c','(exit 37) | tee\nprintf masked'],{encoding:'utf8'})
    assert.equal(protectedPipe.status,37);assert.equal(protectedPipe.stdout,'')
    assert.equal(unprotectedPipe.status,0);assert.equal(unprotectedPipe.stdout,'masked')
  }
})

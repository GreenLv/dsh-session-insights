import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {COHORT_PATHS,POLICY_PATH,digest,hostQueueDigest,inspectReport,assessAudit,captureAudit,verifyResults} from '../scripts/audit_node_deps.mjs'

const workflow='.github/workflows/ci.yml'
const files=Object.fromEntries([...COHORT_PATHS,workflow].map(p=>[p,readFileSync(new URL('../'+p,import.meta.url))]))
const raw=readFileSync(new URL('../tests/fixtures/npm-audit-known-root.json',import.meta.url),'utf8')
const report=JSON.parse(raw),lock=JSON.parse(files['package-lock.json'])
const clone=value=>structuredClone(value)
const assess=(value=report,p=policy,files_=files,scan={})=>assessAudit({raw:JSON.stringify(value),exit_code:1,...scan},p,files_)
// The repository no longer carries a standing exception: the 0.6.1 grant
// expired with its release cohort. These tests synthesize a policy bound to
// the exact current files to exercise the authorized-exception branch.
function syntheticPolicy(reportValue=report,filesValue=files,lockValue=lock){
  const policy={
    schema:'dsi-node-audit-exception/v1',
    product_version:JSON.parse(filesValue['package.json']).version,
    authorization:{decision:'accepted',recorded_on:'2026-11-02',authority:'Synthetic test authority',scope:'test-only cohort binding'},
    exception:{advisory:'GHSA-mrhx-c7xc-m3w5',cve:'CVE-2023-54404',package:'zod',version:'4.4.3',severity:'high',range:'<4.6.6',patched_version:'4.6.6'},
    audited_scope:'Synthetic tests only.',
    prerequisite:'Synthetic.',
    cohort:{files:Object.fromEntries(COHORT_PATHS.map(p=>[p,digest(filesValue[p])])),host_queue_sha256:hostQueueDigest(filesValue[workflow])},
    report_graph_sha256:inspectReport(reportValue,lockValue).sha256,
    expiry:{kind:'event_bound',events:['Synthetic'],required_action:'Synthetic.',calendar_expiry:null,automatic_monitoring:false},
    sources:['synthetic://test'],
  }
  return policy
}
function changedFile(path,mutate){const value=JSON.parse(files[path]);mutate(value);return {...files,[path]:Buffer.from(JSON.stringify(value))}}
function outputs(fn){const dir=mkdtempSync(join(tmpdir(),'dsi-audit-'));try{return fn(dir)}finally{rmSync(dir,{recursive:true,force:true})}}
const knownScan=()=>({status:1,signal:null,stdout:raw,stderr:''})
const policy=syntheticPolicy()
const PASSING=['clean','accepted_known_risk']
// A rejected scan must either throw or return a non-passing assessment; when
// it returns, the reason (or an optional pattern) names the actual violation.
const rejectedWith=(fn,pattern)=>{
  let out
  try{out=fn()}catch(e){if(pattern)assert.match(String(e?.message||''),pattern);return}
  assert.ok(out&&!PASSING.includes(out.status),'expected a non-passing assessment, got '+(out&&out.status))
  if(pattern)assert.match(String(out?.reason||''),pattern)
}
const cleanReport={
  auditReportVersion:2,
  vulnerabilities:{},
  metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0,total:0},dependencies:{prod:37,total:38}},
}


test('exception path accepts the real 23-node report with one advisory under a cohort-bound policy',()=>{
  const result=assess()
  assert.equal(result.status,'accepted_known_risk');assert.equal(result.affected_packages,23);assert.equal(result.advisories,1)
  assert.equal(result.graph_sha256,policy.report_graph_sha256)
})

test('a clean scan passes with a valid non-empty inventory and no policy present',()=>{
  const result=assessAudit({raw:JSON.stringify(cleanReport),exit_code:0},null,files)
  assert.equal(result.status,'clean');assert.equal(result.advisories,0);assert.ok(result.dependencies>0)
})
for(const [name,mutate] of [
  ['empty dependency inventory',r=>{r.metadata.dependencies={prod:0,total:0}}],
  ['nonzero vulnerability counts on a zero exit',r=>{r.metadata.vulnerabilities.high=1;r.metadata.vulnerabilities.total=1}],
  ['vulnerability entries despite a zero exit',r=>{r.vulnerabilities.zod=report.vulnerabilities.zod}],
  ['malformed clean report',r=>{delete r.metadata}],
])test('clean scan cannot pass with '+name,()=>{
  const value=clone(cleanReport);mutate(value)
  assert.throws(()=>assessAudit({raw:JSON.stringify(value),exit_code:0},null,files))
})
test('an empty lock inventory cannot masquerade as a clean pass',()=>{
  const value=clone(cleanReport);value.metadata.dependencies={prod:0,total:0}
  assert.throws(()=>assessAudit({raw:JSON.stringify(value),exit_code:0},policy,files),/empty or invalid dependency inventory/)
})

test('findings without an exception policy report unauthorized_findings with advisory detail',()=>{
  const result=assess(report,null,files)
  assert.equal(result.status,'unauthorized_findings')
  assert.equal(result.affected_packages,23)
  assert.deepEqual(result.direct_advisories,['https://github.com/advisories/GHSA-mrhx-c7xc-m3w5'])
  assert.equal(result.highest_severity,'high')
  assert.match(result.reason,/policy missing|expired/)
})
test('an expired policy never authorizes fresh findings',()=>{
  const expired=clone(policy);expired.product_version='0.0.1'
  const result=assess(report,expired,files)
  assert.equal(result.status,'unauthorized_findings')
  assert.match(result.reason,/product/)
})

for(const scope of ['prod','full'])test('real npm10 CI '+scope+' report retains the exact accepted via graph despite omitted reverse effects',()=>{
  const value=JSON.parse(readFileSync(new URL('../tests/fixtures/npm-audit-ci-'+scope+'.json',import.meta.url),'utf8'))
  const result=assess(value)
  assert.equal(result.graph_sha256,policy.report_graph_sha256)
  assert.equal(result.affected_packages,23)
})

test('omitted reverse effects do not remove or broaden validated advisory chains',()=>{
  const value=clone(report)
  for(const row of Object.values(value.vulnerabilities))row.effects=[]
  assert.equal(assess(value).graph_sha256,policy.report_graph_sha256)
})

test('a reported effect contradicting the complete via map remains rejected',()=>{
  const value=clone(report);value.vulnerabilities.zod.effects=['zod']
  rejectedWith(()=>assess(value),/inconsistent advisory effects/)
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
  rejectedWith(()=>assess(value),/graph drifted/)
})
for(const exitToLeaf of [false,true])test('cycles are refused even if an accepted leaf '+(exitToLeaf?'is an exit':'exists elsewhere'),()=>{
  // A controlled lock with this extra edge makes the cycle structurally
  // resolved; the cycle guard must still refuse it, independently of pinning.
  const changedLock=clone(lock)
  changedLock.packages['node_modules/@deepseek-ai/dsh-tools'].peerDependencies['@deepseek-ai/dsh-tool-todo']='0.2.1-rc.5'
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
])test('audit rejects '+name,()=>{const value=clone(report);mutate(value);rejectedWith(()=>assess(value))})

test('empty, malformed, unsupported and clean-shaped output cannot waive this known cohort',()=>{
  for(const text of ['', ' ', '{}', 'null', '[]','not JSON'])assert.throws(()=>assessAudit({raw:text,exit_code:1},policy,files))
  const empty=clone(report);empty.vulnerabilities={};empty.metadata.vulnerabilities.high=0;empty.metadata.vulnerabilities.total=0
  assert.throws(()=>inspectReport(empty,lock),/empty/)
  const unsupported=clone(report);unsupported.auditReportVersion=1;assert.throws(()=>assess(unsupported))
})
test('npm failure, cancellation and contradictory success exits never pass',()=>{
  for(const scan of [{exit_code:2},{exit_code:null},{signal:'SIGTERM'},{error:'ETIMEDOUT'}])assert.throws(()=>assess(report,policy,files,scan),/scanner/)
  // A zero exit is only meaningful with a genuinely clean report: the known
  // finding report on a zero exit must not pass.
  assert.throws(()=>assessAudit({raw:JSON.stringify(report),exit_code:0},policy,files),/clean/)
})
test('a network-style scanner error report cannot pass in any state',()=>{
  const networkError={error:{code:'ENETUNREACH',summary:'npm audit failed',detail:'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed'}}
  for(const exit of [1,0])assert.throws(()=>assessAudit({raw:JSON.stringify(networkError),exit_code:exit},null,files))
})

for(const path of COHORT_PATHS)test('exception expires when cohort file changes: '+path,()=>{
  rejectedWith(()=>assess(report,policy,{...files,[path]:Buffer.concat([files[path],Buffer.from('\n')])}),/cohort changed/)
})
test('host queue drift expires the exception independently of manifest hashes',()=>{
  // The policy keeps the originally accepted queue digest; only the workflow
  // file drifts, so the queue mismatch alone must void the exception.
  const drift={...files,[workflow]:Buffer.from(String(files[workflow]).replace("dsh: '0.2.1-rc.5'","dsh: '0.2.1-rc.4'"))}
  const result=assess(report,policy,drift)
  assert.equal(result.status,'unauthorized_findings');assert.match(result.reason,/host queue/)
})
test('an updated hash cannot broaden the fixed package version or host family',()=>{
  for(const [path,mutate,reason] of [
    ['package.json',p=>{p.version='9.9.9'},/project version/],
    ['package-lock.json',p=>{p.packages['node_modules/zod'].version='4.4.4'},/zod 4.4.3/],
    ['tests/dsh-runtime-rc5/package.json',p=>{Object.keys(p.dependencies).forEach(k=>{p.dependencies[k]='0.2.1-rc.4'})},/host pins/],
  ]){
    const drift=changedFile(path,mutate),p=clone(policy);p.cohort.files[path]=digest(drift[path])
    rejectedWith(()=>assess(report,p,drift),reason)
  }
})
test('policy cannot silently expand to another CVE, version, calendar expiry or missing host lock',()=>{
  for(const mutate of [p=>{p.exception.cve='CVE-2099-0001'},p=>{p.exception.version='4.5.0'},p=>{p.expiry.calendar_expiry='2099-01-01'},p=>{delete p.cohort.files['tests/dsh-host-rc5/package-lock.json']}]){
    const p=clone(policy);mutate(p);rejectedWith(()=>assess(report,p))
  }
})

// Stage a full cohort root (repository files plus an optional synthetic
// policy) so captureAudit and verifyResults exercise their real file paths.
function stageRoot(withPolicy){
  const dir=mkdtempSync(join(tmpdir(),'dsi-audit-root-'))
  for(const path of [...COHORT_PATHS,workflow]){
    const target=join(dir,path);mkdirSync(join(target,'..'),{recursive:true})
    writeFileSync(target,files[path])
  }
  if(withPolicy){
    mkdirSync(join(dir,'config'),{recursive:true})
    writeFileSync(join(dir,POLICY_PATH),JSON.stringify(policy,null,2)+'\n')
  }
  return dir
}
test('both scopes preserve the real failing scanner exit and raw bytes, and the summary passes only on matching states',()=>outputs(dir=>{
  const root=stageRoot(true)
  for(const scope of ['prod','full']){
    const result=captureAudit(scope,join(dir,scope),{root,runner:knownScan})
    assert.equal(result.status,'accepted_known_risk');assert.equal(result.scan.exit_code,1)
    assert.equal(readFileSync(join(dir,scope,'audit.json'),'utf8'),raw)
    assert.equal(result.command.includes('--omit=dev'),scope==='prod')
    assert.ok(result.command.includes('--audit-level=high'))
  }
  assert.equal(verifyResults(dir,{prod:'success',full:'success',python:'success'},{root}).status,'passed_with_known_upstream_risk')
  writeFileSync(join(dir,'full/audit.json'),raw+'\n')
  assert.throws(()=>verifyResults(dir,{prod:'success',full:'success',python:'success'},{root}),/bytes changed/)
  rmSync(root,{recursive:true,force:true})
}))
test('without a policy file the same failing scan reports unauthorized findings and the summary refuses',()=>outputs(dir=>{
  const root=stageRoot(false)
  const result=captureAudit('prod',join(dir,'prod'),{root,runner:knownScan})
  assert.equal(result.status,'unauthorized_findings')
  assert.equal(JSON.parse(readFileSync(join(dir,'prod/result.json'),'utf8')).status,'unauthorized_findings')
  assert.throws(()=>verifyResults(dir,{prod:'success',full:'success',python:'success'},{root}),/missing or failed/)
  rmSync(root,{recursive:true,force:true})
}))
test('a genuinely clean scan passes both scopes without any policy and reports exception_fixed',()=>outputs(dir=>{
  const root=stageRoot(false)
  const cleanScan=()=>({status:0,signal:null,stdout:JSON.stringify(cleanReport),stderr:''})
  for(const scope of ['prod','full']){
    const result=captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
    assert.equal(result.status,'clean');assert.equal(result.scan.exit_code,0)
    assert.equal(result.assessment.dependencies,cleanReport.metadata.dependencies.total)
  }
  const summary=verifyResults(dir,{prod:'success',full:'success',python:'success'},{root})
  assert.equal(summary.status,'passed');assert.equal(summary.exception_fixed,true)
  rmSync(root,{recursive:true,force:true})
}))
test('scopes disagreeing on the exception state cannot produce a summary',()=>outputs(dir=>{
  const root=stageRoot(true)
  const cleanScan=()=>({status:0,signal:null,stdout:JSON.stringify(cleanReport),stderr:''})
  captureAudit('prod',join(dir,'prod'),{root,runner:knownScan})
  captureAudit('full',join(dir,'full'),{root,runner:cleanScan})
  assert.throws(()=>verifyResults(dir,{prod:'success',full:'success',python:'success'},{root}),/disagree/)
  rmSync(root,{recursive:true,force:true})
}))
test('scanner failure is retained and does not prevent the independent full scan',()=>outputs(dir=>{
  const root=stageRoot(true)
  let calls=0
  const prod=captureAudit('prod',join(dir,'prod'),{root,runner:()=>{calls++;return {status:2,stdout:'{}',stderr:'synthetic database unreachable'}}})
  const full=captureAudit('full',join(dir,'full'),{root,runner:()=>{calls++;return knownScan()}})
  assert.equal(calls,2);assert.equal(prod.status,'failed');assert.equal(prod.scan.exit_code,2);assert.equal(full.status,'accepted_known_risk')
  assert.equal(readFileSync(join(dir,'prod/stderr.log'),'utf8'),'synthetic database unreachable')
  assert.throws(()=>verifyResults(dir,{prod:'failure',full:'success',python:'success'},{root}),/required audit step/)
  rmSync(root,{recursive:true,force:true})
}))
test('required summary rejects absent, skipped, failed and cancelled Python or Node steps',()=>outputs(dir=>{
  const root=stageRoot(true)
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:knownScan})
  for(const name of ['prod','full','python'])for(const outcome of [undefined,'skipped','failure','cancelled']){
    assert.throws(()=>verifyResults(dir,{prod:'success',full:'success',python:'success',[name]:outcome},{root}),/required audit step/)
  }
  rmSync(root,{recursive:true,force:true})
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

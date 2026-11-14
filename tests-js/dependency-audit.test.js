import test from 'node:test'
import assert from 'node:assert/strict'
import fs, {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {COHORT_PATHS,HOST_RISK_POLICY_PATH,HOST_REPORT_PROJECTION,hostReportDigest,canonical,digest,assessAudit,assessTreeAudit,captureAudit,verifyResults,TREE_AUDITS} from '../scripts/audit_node_deps.mjs'

const workflow='.github/workflows/ci.yml'
const files=Object.fromEntries([...COHORT_PATHS,workflow].map(p=>[p,readFileSync(new URL('../'+p,import.meta.url))]))
const clone=value=>structuredClone(value)
const cleanReport={
  auditReportVersion:2,
  vulnerabilities:{},
  metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0,total:0},dependencies:{prod:36,total:37}},
}
function outputs(fn){const dir=mkdtempSync(join(tmpdir(),'dsi-audit-'));try{return fn(dir)}finally{rmSync(dir,{recursive:true,force:true})}}
const cleanScan=()=>({status:0,signal:null,stdout:JSON.stringify(cleanReport),stderr:''})
const TREE_LABELS=TREE_AUDITS.map(t=>t.label)
const allOutcomes=(extra={})=>({prod:'success',full:'success',python:'success',...Object.fromEntries(TREE_LABELS.map(l=>[l,'success'])),...extra})
// Tree captures are staged clean unless a test overrides them.
function stageTreeCaptures(dir,root,runner=cleanScan){
  for(const tree of TREE_AUDITS)captureAudit('tree',join(dir,'tree',tree.label),{root,runner,tree:tree.label})
}
function stageRoot(){
  const dir=mkdtempSync(join(tmpdir(),'dsi-audit-root-'))
  for(const path of [...COHORT_PATHS,workflow]){
    const target=join(dir,path);mkdirSync(join(target,'..'),{recursive:true})
    writeFileSync(target,files[path])
  }
  return dir
}
// One known-advisory finding shape, used to prove findings always fail.
function findingReport(){
  return {auditReportVersion:2,
    vulnerabilities:{zod:{name:'zod',severity:'high',isDirect:true,
      via:[{source:1,name:'zod',dependency:'zod',title:'known advisory',url:'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5',severity:'high',range:'<4.6.6'}],
      effects:[],range:'<4.6.6',nodes:['node_modules/zod'],fixAvailable:false}},
    metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:1,critical:0,total:1},dependencies:{prod:36,total:37}}}
}
const findingScan=()=>({status:1,signal:null,stdout:JSON.stringify(findingReport()),stderr:''})

test('findings always report unauthorized and never an authorized state',()=>outputs(dir=>{
  const root=stageRoot()
  const result=captureAudit('prod',join(dir,'prod'),{root,runner:findingScan})
  assert.equal(result.status,'unauthorized_findings')
  assert.equal(result.scan.exit_code,1)
  assert.equal(result.assessment.affected_packages,1)
  assert.deepEqual(result.assessment.direct_advisories,['https://github.com/advisories/GHSA-mrhx-c7xc-m3w5'])
  assert.equal(result.assessment.highest_severity,'high')
  rmSync(root,{recursive:true,force:true})
}))
test('empty, malformed, unsupported output can never pass',()=>{
  // Assessed directly: a capture converts assessment failures into 'failed'
  // receipts (covered by the receipt tests), but the assessment itself must
  // throw so no malformed shape can ever summarize into a pass.
  for(const text of ['', ' ', '{}', 'null', '[]','not JSON'])
    assert.throws(()=>assessAudit({raw:text,exit_code:1}))
})
test('npm failure, cancellation and contradictory success exits never pass',()=>{
  for(const scan of [{exit_code:2},{exit_code:null,signal:'SIGTERM'},{exit_code:null,error:'ETIMEDOUT'}])
    assert.throws(()=>assessAudit({raw:JSON.stringify(cleanReport),...scan}),/scanner/)
  // A zero exit is only meaningful with a genuinely clean report: the finding
  // report on a zero exit must not pass.
  assert.throws(()=>assessAudit({raw:JSON.stringify(findingReport()),exit_code:0}),/clean/)
  // The same holds for tree-scope assessment.
  assert.throws(()=>assessTreeAudit({raw:JSON.stringify(findingReport()),exit_code:0}),/clean/)
})
test('a network-style scanner error report cannot pass in any state',()=>{
  const networkError={error:{code:'ENETUNREACH',summary:'npm audit failed',detail:'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed'}}
  for(const report of [networkError,{...cleanReport,...networkError},{...findingReport(),...networkError}])
    for(const exit of [1,0])assert.throws(()=>assessAudit({raw:JSON.stringify(report),exit_code:exit}))
})
test('both scopes preserve the real scanner exit and raw bytes, and the summary passes on clean states',()=>outputs(dir=>{
  const root=stageRoot()
  for(const scope of ['prod','full']){
    const result=captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
    assert.equal(result.status,'clean');assert.equal(result.scan.exit_code,0)
    assert.equal(readFileSync(join(dir,scope,'audit.json'),'utf8'),JSON.stringify(cleanReport))
    assert.equal(result.command.includes('--omit=dev'),scope==='prod')
    assert.ok(result.command.includes('--audit-level=high'))
  }
  stageTreeCaptures(dir,root)
  const summary=verifyResults(dir,allOutcomes(),{root})
  assert.equal(summary.status,'passed');assert.equal(summary.exception_fixed,true)
  assert.ok(summary.input_cohort_sha256)
  writeFileSync(join(dir,'full/audit.json'),JSON.stringify(cleanReport)+'\n')
  assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/bytes changed/)
  rmSync(root,{recursive:true,force:true})
}))
test('an unauthorized scan fails the summary even when both steps ran',()=>outputs(dir=>{
  const root=stageRoot()
  captureAudit('prod',join(dir,'prod'),{root,runner:findingScan})
  captureAudit('full',join(dir,'full'),{root,runner:cleanScan})
  stageTreeCaptures(dir,root)
  assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/required npm assessment missing or failed/)
  rmSync(root,{recursive:true,force:true})
}))
test('scanner failure is retained and does not prevent the independent full scan',()=>outputs(dir=>{
  const root=stageRoot()
  let calls=0
  const prod=captureAudit('prod',join(dir,'prod'),{root,runner:()=>{calls++;return {status:2,stdout:'{}',stderr:'synthetic database unreachable'}}})
  const full=captureAudit('full',join(dir,'full'),{root,runner:()=>{calls++;return cleanScan()}})
  assert.equal(calls,2);assert.equal(prod.status,'failed');assert.equal(prod.scan.exit_code,2);assert.equal(full.status,'clean')
  assert.equal(readFileSync(join(dir,'prod/stderr.log'),'utf8'),'synthetic database unreachable')
  assert.throws(()=>verifyResults(dir,allOutcomes({prod:'failure'}),{root}),/required audit step/)
  rmSync(root,{recursive:true,force:true})
}))
test('required summary rejects absent, skipped, failed and cancelled audit steps',()=>outputs(dir=>{
  const root=stageRoot()
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
  stageTreeCaptures(dir,root)
  for(const name of Object.keys(allOutcomes()))for(const outcome of [undefined,'skipped','failure','cancelled']){
    assert.throws(()=>verifyResults(dir,allOutcomes({[name]:outcome}),{root}),/required audit step/)
  }
  rmSync(root,{recursive:true,force:true})
}))
test('spawn exceptions still emit a failed scan receipt',()=>outputs(dir=>{
  const result=captureAudit('prod',dir,{runner:()=>{throw new Error('synthetic spawn failure')}})
  assert.equal(result.status,'failed');assert.equal(result.scan.error,'SPAWN_ERROR')
  assert.equal(JSON.parse(readFileSync(join(dir,'result.json'),'utf8')).status,'failed')
}))
test('unknown tree labels are refused before any scan',()=>outputs(dir=>{
  assert.throws(()=>captureAudit('tree',dir,{runner:cleanScan,tree:'runtime-rc.1'}),/unknown audit tree/)
  assert.throws(()=>captureAudit('prod',dir,{runner:cleanScan,tree:'runtime'}),/--tree only applies/)
}))

// RV-01: the summary must summarize the captured inputs. A clean scan of one
// tree must never endorse a different candidate.
test('same-input clean captures re-read cleanly',()=>outputs(dir=>{
  const root=stageRoot()
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
  stageTreeCaptures(dir,root)
  const summary=verifyResults(dir,allOutcomes(),{root})
  assert.equal(summary.status,'passed');assert.ok(summary.input_cohort_sha256)
  rmSync(root,{recursive:true,force:true})
}))
test('swapping the lock or manifest after a clean capture voids the summary',()=>outputs(dir=>{
  const root=stageRoot()
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
  stageTreeCaptures(dir,root)
  const candidateLock=JSON.parse(files['package-lock.json'])
  candidateLock.packages['node_modules/semver'].version='9.9.9'
  writeFileSync(join(root,'package-lock.json'),JSON.stringify(candidateLock))
  assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/drifted after capture/)
  rmSync(root,{recursive:true,force:true})
}))
test('scopes that captured different inputs cannot be summarized together',()=>outputs(dir=>{
  const root=stageRoot()
  captureAudit('prod',join(dir,'prod'),{root,runner:cleanScan})
  writeFileSync(join(root,'package-lock.json'),Buffer.concat([files['package-lock.json'],Buffer.from('\n')]))
  captureAudit('full',join(dir,'full'),{root,runner:cleanScan})
  assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/scopes captured different inputs/)
  rmSync(root,{recursive:true,force:true})
}))
test('captures from before input binding existed cannot be summarized',()=>outputs(dir=>{
  const root=stageRoot()
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
  stageTreeCaptures(dir,root)
  for(const scope of ['prod','full']){
    const p=join(dir,scope,'result.json'),r=JSON.parse(readFileSync(p,'utf8'));delete r.input_binding
    writeFileSync(p,JSON.stringify(r,null,2)+'\n')
  }
  assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/predates input binding/)
  rmSync(root,{recursive:true,force:true})
}))
test('a capture cannot be summarized after cohort drift',()=>outputs(dir=>{
  const root=stageRoot()
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
  stageTreeCaptures(dir,root)
  writeFileSync(join(root,'package-lock.json'),Buffer.concat([files['package-lock.json'],Buffer.from('\n')]))
  assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/drifted after capture/)
  rmSync(root,{recursive:true,force:true})
}))

// Tree audits: every acceptance tree must scan clean and stay bound to its
// own bytes; unknown labels are refused and drift voids the summary.
test('tree audits bind their own bytes and refuse unknown labels',()=>outputs(dir=>{
  const root=stageRoot()
  stageTreeCaptures(dir,root)
  for(const tree of TREE_AUDITS){
    const r=JSON.parse(readFileSync(join(dir,'tree',tree.label,'result.json'),'utf8'))
    assert.equal(r.tree,tree.label);assert.equal(r.status,'clean')
    assert.equal(r.input_binding.manifest_sha256,digest(files[tree.dir+'/package.json']))
    assert.equal(r.input_binding.lock_sha256,digest(files[tree.dir+'/package-lock.json']))
  }
  assert.throws(()=>captureAudit('tree',join(dir,'bad'),{root,runner:cleanScan,tree:'nonexistent'}),/unknown audit tree/)
  rmSync(root,{recursive:true,force:true})
}))
test('a primary tree carrying findings cannot pass the summary',()=>outputs(dir=>{
  const root=stageRoot()
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
  stageTreeCaptures(dir,root)
  captureAudit('tree',join(dir,'tree','host'),{root,runner:findingScan,tree:'host'})
  assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/tree audit must scan clean.*host/)
  rmSync(root,{recursive:true,force:true})
}))
test('tree audit input drift voids the summary',()=>outputs(dir=>{
  const root=stageRoot()
  for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
  stageTreeCaptures(dir,root)
  writeFileSync(join(root,'tests/dsh-runtime/package-lock.json'),Buffer.concat([files['tests/dsh-runtime/package-lock.json'],Buffer.from('\n')]))
  // The tree lock is part of both the root cohort binding and the per-tree
  // binding; either guard refusing is correct — the summary must be voided.
  assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/drifted after capture|tree audit input drifted/)
  rmSync(root,{recursive:true,force:true})
}))

// A→B→A swap protection: the scanner runs against a private snapshot of the
// bound bytes, so a source-tree swap during the runner cannot make a scan of
// B endorse A.
function cleanFixtureManifest(){
  const lock=JSON.parse(files['package-lock.json']),semver={...lock.packages['node_modules/semver']}
  delete semver.dev;delete semver.peer
  return Buffer.from(JSON.stringify({name:'dsh-session-insights',version:'0.8.2',private:true,dependencies:{semver:semver.version}},null,2)+'\n')
}
function semverEntry(){
  const lock=JSON.parse(files['package-lock.json']),semver={...lock.packages['node_modules/semver']}
  delete semver.dev;delete semver.peer;return semver
}
function cleanFixtureLock(){
  const manifest=JSON.parse(cleanFixtureManifest())
  return Buffer.from(JSON.stringify({name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,packages:{'':{name:manifest.name,version:manifest.version,dependencies:manifest.dependencies},'node_modules/semver':semverEntry()}},null,2)+'\n')
}
test('an A->B->A source swap during the runner keeps the capture honest',()=>outputs(dir=>{
  const root=stageRoot()
  const manifest=cleanFixtureManifest(),lock=cleanFixtureLock()
  writeFileSync(join(root,'package.json'),manifest)
  writeFileSync(join(root,'package-lock.json'),lock)
  const realManifest=files['package.json'],realLock=files['package-lock.json']
  const drift=(command,args,options)=>{
    // Concurrent writer: B into the SOURCE tree, restore A afterwards.
    writeFileSync(join(root,'package.json'),realManifest)
    writeFileSync(join(root,'package-lock.json'),realLock)
    assert.notEqual(options.cwd,root,'scanner must not read the mutable source tree')
    assert.deepEqual(readFileSync(join(options.cwd,'package.json')),manifest)
    assert.deepEqual(readFileSync(join(options.cwd,'package-lock.json')),lock)
    const scan=cleanScan()
    writeFileSync(join(root,'package.json'),manifest)
    writeFileSync(join(root,'package-lock.json'),lock)
    return scan
  }
  const prod=captureAudit('prod',join(dir,'prod'),{root,runner:drift})
  const full=captureAudit('full',join(dir,'full'),{root,runner:drift})
  stageTreeCaptures(dir,root)
  // The snapshot provably held the bound clean bytes, so this is a legitimate
  // clean capture of the restored source input.
  assert.equal(prod.status,'clean');assert.equal(full.status,'clean')
  assert.equal(prod.input_binding.lock_sha256,digest(lock))
  assert.equal(verifyResults(dir,allOutcomes(),{root}).status,'passed')
  rmSync(root,{recursive:true,force:true})
}))
test('snapshot cleanup failure fails the capture with a recorded reason',()=>outputs(dir=>{
  const root=stageRoot()
  let scanDir=null,result
  const originalRemove=fs.rmSync
  // Directory chmod is not a portable deletion refusal on Windows. Inject one
  // EACCES at the actual cleanup call and restore the builtin before any other
  // fixture cleanup; the production entrypoint and receipt remain unchanged.
  fs.rmSync=(path,options)=>{
    if(scanDir&&path===scanDir)throw Object.assign(new Error('synthetic snapshot removal refusal'),{code:'EACCES'})
    return originalRemove(path,options)
  }
  syncBuiltinESMExports()
  try{
    result=captureAudit('prod',join(dir,'prod'),{root,runner:(command,args,options)=>{
      scanDir=options.cwd
      return cleanScan()
    }})
  }finally{fs.rmSync=originalRemove;syncBuiltinESMExports()}
  assert.equal(result.status,'failed')
  assert.match(String(result.reason),/scan snapshot cleanup failed: synthetic snapshot removal refusal/)
  assert.equal(JSON.parse(readFileSync(join(dir,'prod','result.json'),'utf8')).status,'failed')
  if(scanDir)rmSync(scanDir,{recursive:true,force:true})
  rmSync(root,{recursive:true,force:true})
}))

test('tree cleanup failures remain failures when the summary rereads a clean scan',()=>outputs(dir=>{
  const root=stageRoot()
  let scanDir
  try {
    for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
    stageTreeCaptures(dir,root)
    const originalRemove=fs.rmSync
    let result
    fs.rmSync=(path,options)=>{
      if(scanDir&&path===scanDir)throw Object.assign(new Error('synthetic tree cleanup refusal'),{code:'EACCES'})
      return originalRemove(path,options)
    }
    syncBuiltinESMExports()
    try {
      result=captureAudit('tree',join(dir,'tree','host'),{root,tree:'host',runner:(command,args,options)=>{
        scanDir=options.cwd
        return cleanScan()
      }})
    } finally {fs.rmSync=originalRemove;syncBuiltinESMExports()}
    assert.equal(result.status,'failed')
    assert.match(result.reason,/synthetic tree cleanup refusal/)
    assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/tree.*(?:failed|status)/)
  } finally {rmSync(root,{recursive:true,force:true})}
}))

test('a misattributed tree capture cannot pass even with clean bound bytes',()=>outputs(dir=>{
  const root=stageRoot()
  try {
    for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
    stageTreeCaptures(dir,root)
    const path=join(dir,'tree','host','result.json')
    const result=JSON.parse(readFileSync(path,'utf8'))
    result.scope='full'
    writeFileSync(path,JSON.stringify(result)+'\n')
    assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/tree.*(?:scope|misattributed)/)
  } finally {rmSync(root,{recursive:true,force:true})}
}))

function syntheticHostPolicy(root,report=findingReport()) {
  const tree=TREE_AUDITS.find(t=>t.label==='host')
  const policy={
    schema:'dsi-host-risk-acceptance/v1',
    product_version:JSON.parse(files['package.json']).version,
    host_version:tree.version,
    authorization:{decision:'accepted',recorded_on:'2026-11-13',scope:'Synthetic test-only decision'},
    manifest_sha256:digest(files[tree.dir+'/package.json']),
    lock_sha256:digest(files[tree.dir+'/package-lock.json']),
    advisories:[...new Set(Object.values(report.vulnerabilities).flatMap(r=>r.via.filter(v=>typeof v==='object').map(v=>v.url)))].sort(),
    report_projection:HOST_REPORT_PROJECTION,
    reviewed_findings_sha256:[hostReportDigest(report)],
    expiry:'Synthetic input-bound decision',note:'Synthetic report, never production authorization',
  }
  mkdirSync(join(root,'config'),{recursive:true})
  writeFileSync(join(root,HOST_RISK_POLICY_PATH),JSON.stringify(policy)+'\n')
  return policy
}

test('only the exact host decision can pass findings while retaining scanner exit 1',()=>outputs(dir=>{
  const root=stageRoot()
  try {
    syntheticHostPolicy(root)
    for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
    stageTreeCaptures(dir,root)
    const host=captureAudit('tree',join(dir,'tree','host'),{root,tree:'host',runner:findingScan})
    assert.equal(host.status,'accepted_known_risk')
    assert.equal(host.scan.exit_code,1)
    assert.equal(JSON.parse(readFileSync(join(dir,'tree/host/audit.json'),'utf8')).vulnerabilities.zod.severity,'high')
    assert.equal(verifyResults(dir,allOutcomes(),{root}).status,'passed_with_known_host_risk')
    const runtime=captureAudit('tree',join(dir,'tree','runtime'),{root,tree:'runtime',runner:findingScan})
    assert.equal(runtime.status,'unauthorized_findings','the host decision cannot authorize the runtime tree')
    const prod=captureAudit('prod',join(dir,'prod'),{root,runner:findingScan})
    assert.equal(prod.status,'unauthorized_findings','the host decision cannot authorize root production findings')
  } finally {rmSync(root,{recursive:true,force:true})}
}))

test('expired identities, new advisories and unreviewed report changes stay unauthorized',()=>outputs(dir=>{
  const root=stageRoot()
  try {
    for(const mutate of [
      p=>{p.product_version='0.0.0'},p=>{p.host_version='0.2.2-rc.1'},
      p=>{p.lock_sha256='0'.repeat(64)},p=>{p.manifest_sha256='0'.repeat(64)},
      p=>{p.authorization.decision='pending'},p=>{p.advisories.push('https://github.com/advisories/GHSA-unreviewed')},
      p=>{p.reviewed_findings_sha256=['0'.repeat(64)]},p=>{p.report_projection='unknown/v1'},
    ]) {
      const policy=syntheticHostPolicy(root);mutate(policy)
      writeFileSync(join(root,HOST_RISK_POLICY_PATH),JSON.stringify(policy)+'\n')
      const result=captureAudit('tree',join(dir,'tree','host'),{root,tree:'host',runner:findingScan})
      assert.equal(result.status,'unauthorized_findings')
      assert.ok(result.assessment.reason)
    }
    syntheticHostPolicy(root)
    const changed=findingReport();changed.vulnerabilities.zod.via[0].severity='critical'
    const result=captureAudit('tree',join(dir,'tree','host'),{root,tree:'host',runner:()=>({...findingScan(),stdout:JSON.stringify(changed)})})
    assert.equal(result.status,'unauthorized_findings','the same advisory URL cannot bless unreviewed report changes')
  } finally {rmSync(root,{recursive:true,force:true})}
}))

test('a changed decision invalidates retained host captures; clean scans need no decision',()=>outputs(dir=>{
  const root=stageRoot()
  try {
    const policy=syntheticHostPolicy(root)
    for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
    stageTreeCaptures(dir,root)
    captureAudit('tree',join(dir,'tree','host'),{root,tree:'host',runner:findingScan})
    policy.note='changed after capture'
    writeFileSync(join(root,HOST_RISK_POLICY_PATH),JSON.stringify(policy)+'\n')
    assert.throws(()=>verifyResults(dir,allOutcomes(),{root}),/decision changed after capture/)
    writeFileSync(join(root,HOST_RISK_POLICY_PATH),'invalid JSON')
    const clean=captureAudit('tree',join(dir,'tree','host'),{root,tree:'host',runner:cleanScan})
    assert.equal(clean.status,'clean')
    assert.equal(verifyResults(dir,allOutcomes(),{root}).status,'passed')
  } finally {rmSync(root,{recursive:true,force:true})}
}))

test('host report binding tolerates only typed npm advice; vulnerability facts remain exact',()=>outputs(dir=>{
  const root=stageRoot()
  try {
    syntheticHostPolicy(root)
    for(const scope of ['prod','full'])captureAudit(scope,join(dir,scope),{root,runner:cleanScan})
    stageTreeCaptures(dir,root)
    const capture=report=>captureAudit('tree',join(dir,'tree','host'),{root,tree:'host',runner:()=>({...findingScan(),stdout:JSON.stringify(report)})})
    for(const mutate of [r=>{r.vulnerabilities.zod.effects=['zod']},r=>{r.vulnerabilities.zod.fixAvailable=true},r=>{r.vulnerabilities.zod.fixAvailable={isSemVerMajor:true}},r=>{r.vulnerabilities.zod.fixAvailable={name:'upstream-parent',version:'9.0.0',isSemVerMajor:true}}]){
      const report=findingReport();mutate(report)
      const result=capture(report)
      assert.equal(result.status,'accepted_known_risk')
      assert.equal(result.scan.exit_code,1)
      assert.equal(readFileSync(join(dir,'tree/host/audit.json'),'utf8'),JSON.stringify(report))
      assert.equal(verifyResults(dir,allOutcomes(),{root}).status,'passed_with_known_host_risk')
    }
    const forbidden=[
      r=>{r.vulnerabilities.zod.severity='critical'},r=>{r.vulnerabilities.zod.isDirect=false},
      r=>{r.vulnerabilities.zod.range='*'},r=>{r.vulnerabilities.zod.nodes.push('node_modules/nested/zod')},
      r=>{r.vulnerabilities.zod.via[0].severity='critical'},r=>{r.vulnerabilities.zod.via[0].range='*'},
      r=>{r.vulnerabilities.zod.via[0].title='changed advisory'},r=>{r.vulnerabilities.zod.via.push('other-parent')},
      r=>{r.vulnerabilities.other=clone(r.vulnerabilities.zod)},r=>{r.metadata.dependencies.total++},
      r=>{r.metadata.vulnerabilities.high++},r=>{r.vulnerabilities.zod.unreviewed=true},
      r=>{delete r.vulnerabilities.zod.effects},r=>{r.vulnerabilities.zod.effects='zod'},
      r=>{r.vulnerabilities.zod.effects=['unknown-package']},r=>{r.vulnerabilities.zod.effects=['zod','zod']},
      r=>{delete r.vulnerabilities.zod.fixAvailable},r=>{r.vulnerabilities.zod.fixAvailable=null},
      r=>{r.vulnerabilities.zod.fixAvailable={name:'parent',version:'9',isSemVerMajor:true,error:'bad'}},
    ]
    for(const [i,mutate] of forbidden.entries()){
      const report=findingReport();mutate(report)
      assert.equal(capture(report).status,'unauthorized_findings','mutation '+i)
      assert.throws(()=>verifyResults(dir,allOutcomes(),{root}))
    }
  } finally {rmSync(root,{recursive:true,force:true})}
}))

test('CI always collects all audits, checks outcome, and propagates Python pipeline failures',()=>{
  const source=String(files[workflow]),job=source.split('\n  dependency-security:\n')[1].split('\n  dsh-contract:\n')[0]
  for(const id of ['audit_prod','audit_full','audit_runtime','audit_host','audit_python']){
    const step=job.split('        id: '+id+'\n')[1].split('\n      - name:')[0]
    assert.match(step,/if: always\(\)/);assert.match(step,/continue-on-error: true/)
    assert.ok(job.includes('${{ steps.'+id+'.outcome }}'),id)
  }
  assert.match(job,/--scope tree --tree runtime /)
  assert.match(job,/--scope tree --tree host /)
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

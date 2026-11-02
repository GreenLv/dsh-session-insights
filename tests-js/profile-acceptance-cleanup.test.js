import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {finalizeProfileAcceptance,cleanupPreservingFailure} from '../scripts/acceptance_cleanup.mjs'
import {classifyAcceptanceError} from '../scripts/acceptance_diagnostics.mjs'

function fixture({fails=[], failure=undefined, hadWork=true}={}) {
  const steps=[], diagnostics=[]
  const annex={gates:[{id:'operation',required:true,status:failure?'failed':'passed'}],run:{},cleanup:null}
  let receipt
  const action=id=>async()=>{steps.push(id);if(fails.includes(id))throw Object.assign(new Error('private synthetic detail'),{code:'EFAKE'})}
  const input={annex,failure,hadWork,
    disposeOwner:action('owner'),shutdownApp:action('profile'),leaveWork:action('cwd'),removeWork:action('native-test-tree'),
    reportCleanupErrors:async errors=>{steps.push('diagnostic');diagnostics.push(...errors);if(fails.includes('diagnostic'))throw Error('diagnostic failed')},
    writeAnnex:async value=>{steps.push('receipt');if(fails.includes('receipt'))throw Error('receipt failed');receipt=structuredClone(value)},
    onClean:()=>steps.push('clean'),
  }
  return {input,steps,diagnostics,getReceipt:()=>receipt}
}

test('successful cleanup writes a passed result once', async()=>{
  const f=fixture(), result=await finalizeProfileAcceptance(f.input)
  assert.deepEqual(f.steps,['owner','profile','cwd','native-test-tree','clean','receipt'])
  assert.deepEqual(result,{status:'passed',exitCode:0,receiptWritten:true})
  assert.deepEqual(f.getReceipt().cleanup,{status:'passed',remaining_ids:[]})
})

for(const fault of ['owner','profile','cwd','native-test-tree'])test(`${fault} cleanup failure continues other cleanup and fails receipt`,async()=>{
  const f=fixture({fails:[fault]}), result=await finalizeProfileAcceptance(f.input)
  assert.deepEqual(f.steps,fault==='native-test-tree'
    ? ['owner','profile','cwd','native-test-tree','diagnostic','receipt']
    : ['owner','profile','cwd','diagnostic','receipt'])
  assert.deepEqual(result,{status:'failed',exitCode:1,receiptWritten:true})
  assert.deepEqual(f.getReceipt().cleanup,{status:'failed',remaining_ids:fault==='native-test-tree'?[fault]:[fault,'native-test-tree']})
  assert.equal(f.getReceipt().status,'failed')
  assert.equal(f.diagnostics[0].error.message,'private synthetic detail')
})

test('a body failure survives successful cleanup',async()=>{
  const original=Object.assign(new Error('original failure'),{code:'EORIGINAL'})
  const f=fixture({failure:original}), result=await finalizeProfileAcceptance(f.input)
  assert.equal(f.input.failure,original)
  assert.equal(f.getReceipt().gates[0].status,'failed')
  assert.deepEqual(f.getReceipt().cleanup,{status:'passed',remaining_ids:[]})
  assert.equal(result.exitCode,1)
})

test('a cleanup diagnostic failure cannot prevent the receipt attempt',async()=>{
  const f=fixture({fails:['owner','diagnostic']}), result=await finalizeProfileAcceptance(f.input)
  assert.equal(f.steps.at(-1),'receipt')
  assert.equal(result.exitCode,1)
  assert.equal(f.getReceipt().status,'failed')
})

test('a failed receipt cannot return success',async()=>{
  const f=fixture({fails:['receipt']}), result=await finalizeProfileAcceptance(f.input)
  assert.deepEqual(result,{status:'failed',exitCode:1,receiptWritten:false})
  assert.equal(f.getReceipt(),undefined)
})

test('service cleanup continues after an error and preserves the original failure',async()=>{
  const original=new Error('original synthetic failure'), cleanupError=new Error('cleanup synthetic failure')
  const steps=[]
  await assert.rejects(cleanupPreservingFailure(original,[
    async()=>{steps.push('dispose');throw cleanupError},
    async()=>{steps.push('remove')},
  ]),error=>{
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors,[original,cleanupError])
    return true
  })
  assert.deepEqual(steps,['dispose','remove'])
})

test('real entrypoint setup failure writes a failed annex and removes its synthetic work tree',()=>{
  const base=mkdtempSync(join(tmpdir(),'dsi-profile-lifecycle-'))
  try{
    const commit='1'.repeat(40), hash='2'.repeat(64)
    writeFileSync(join(base,'artifact.json'),JSON.stringify({repository:'https://example.invalid/repo',commit,filename:'candidate.tgz',sha256:hash,size_bytes:1,file_count:1}))
    const p=spawnSync(process.execPath,[resolve('scripts/verify_profile_acceptance.mjs'),base,join(base,'missing-host'),'web'],{encoding:'utf8'})
    assert.equal(p.status,1,p.stderr)
    const annex=JSON.parse(readFileSync(join(base,'web-native-annex.json'),'utf8'))
    assert.equal(annex.status,'failed')
    assert.deepEqual(annex.cleanup,{status:'passed',remaining_ids:[]})
    assert.equal(annex.gates[0].status,'failed')
    const diagnostic=JSON.parse(readFileSync(join(base,'web-native-results','private-error.json'),'utf8'))
    assert.equal(diagnostic.code,'ENOENT')
    assert.ok(!JSON.stringify(diagnostic).includes(base))
    assert.ok(!p.stderr.includes(base))
    const receiptBefore=readFileSync(join(base,'web-native-annex.json'))
    const repeat=spawnSync(process.execPath,[resolve('scripts/verify_profile_acceptance.mjs'),base,join(base,'missing-host'),'web'],{encoding:'utf8'})
    assert.equal(repeat.status,1)
    assert.deepEqual(readFileSync(join(base,'web-native-annex.json')),receiptBefore)
    assert.deepEqual(JSON.parse(readFileSync(join(base,'web-native-results','private-error.json'),'utf8')),diagnostic)
  } finally {rmSync(base,{recursive:true,force:true})}
})

test('an existing profile receipt blocks a fresh run before creating outputs',()=>{
  const base=mkdtempSync(join(tmpdir(),'dsi-profile-existing-'))
  try{
    writeFileSync(join(base,'artifact.json'),JSON.stringify({repository:'https://example.invalid/repo',commit:'1'.repeat(40),filename:'candidate.tgz',sha256:'2'.repeat(64),size_bytes:1,file_count:1}))
    const receipt=join(base,'web-native-annex.json');writeFileSync(receipt,'previous receipt')
    const p=spawnSync(process.execPath,[resolve('scripts/verify_profile_acceptance.mjs'),base,join(base,'missing-host'),'web'],{encoding:'utf8'})
    assert.equal(p.status,1)
    assert.equal(readFileSync(receipt,'utf8'),'previous receipt')
    assert.throws(()=>readFileSync(join(base,'web-native-results','private-error.json')),{code:'ENOENT'})
  } finally {rmSync(base,{recursive:true,force:true})}
})

test('portable gate failure produces bounded local diagnosis and a failed annex',()=>{
  const base=mkdtempSync(join(tmpdir(),'dsi-portable-lifecycle-'))
  try{
    const artifact=join(base,'candidate.tgz'), annexPath=join(base,'annex.json')
    writeFileSync(artifact,'synthetic package with incorrect digest')
    const p=spawnSync(process.execPath,[resolve('scripts/verify_host_acceptance.mjs'),
      '--package',artifact,'--expected-sha256','2'.repeat(64),'--commit','1'.repeat(40),
      '--runtime',base,'--host',base,'--workdir',base,'--annex',annexPath],{encoding:'utf8'})
    assert.equal(p.status,1,p.stderr)
    const annex=JSON.parse(readFileSync(annexPath,'utf8'))
    assert.equal(annex.status,'failed')
    assert.equal(annex.gates.find(g=>g.id==='artifact_digest').status,'failed')
    const diag=JSON.parse(readFileSync(annexPath+'.diagnostic.json','utf8'))
    assert.equal(diag.stage,'artifact_digest')
    assert.ok(!JSON.stringify(diag).includes(base))
    const before=readFileSync(annexPath),diagnosticBefore=readFileSync(annexPath+'.diagnostic.json')
    const repeat=spawnSync(process.execPath,[resolve('scripts/verify_host_acceptance.mjs'),
      '--package',artifact,'--expected-sha256','2'.repeat(64),'--commit','1'.repeat(40),
      '--runtime',base,'--host',base,'--workdir',base,'--annex',annexPath],{encoding:'utf8'})
    assert.equal(repeat.status,1)
    assert.deepEqual(readFileSync(annexPath),before)
    assert.deepEqual(readFileSync(annexPath+'.diagnostic.json'),diagnosticBefore)
  } finally {rmSync(base,{recursive:true,force:true})}
})

test('diagnostics never serialize exception messages, paths or unbounded fields',()=>{
  const diag=classifyAcceptanceError('load_and_register',Object.assign(new Error('Bearer secret /private/path'),{code:'/secret'}))
  assert.deepEqual(diag,{stage:'load_and_register',name:'Error',code:null})
  assert.ok(!JSON.stringify(diag).includes('secret'))
})

for(const mode of ['dispose-failure','timeout'])test(`portable producer retains work when ${mode} leaves users unknown`,()=>{
  const p=spawnSync(process.execPath,[resolve('tests-js/fixtures/portable-finally-probe.mjs'),mode],{encoding:'utf8'})
  assert.equal(p.status,0,p.stderr)
  const result=JSON.parse(p.stdout)
  assert.deepEqual(result.calls,[])
  assert.equal(result.annex.status,'failed')
  assert.equal(result.annex.cleanup.status,'failed')
  assert.ok(result.annex.cleanup.remaining_ids.includes('scratch-work'))
  assert.ok(result.annex.cleanup.remaining_ids.includes(mode==='timeout'?'process-tree':'context'))
})

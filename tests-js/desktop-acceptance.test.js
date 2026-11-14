import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {cleanupFailedPreparation,redactOutput} from '../scripts/desktop_acceptance.mjs'

const script=fileURLToPath(new URL('../scripts/desktop_acceptance.mjs',import.meta.url))
const run=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8'})
const prepare=(output,artifactDir)=>['prepare','--output',output,'--artifact-dir',artifactDir,'--commit','1'.repeat(40),'--tgz-sha256','2'.repeat(64),'--receipt-sha256','3'.repeat(64),'--desktop-package','missing-package','--desktop-cli','missing-cli']

test('desktop entrypoint exposes only the bounded prepare/finalize interface',()=>{
  const help=run('--help');assert.equal(help.status,0);assert.match(help.stdout,/prepare .*finalize/)
  assert.equal(run('prepare').status,1)
  assert.equal(run('finalize','--output','x','--unknown','y').status,1)
})

test('profile startup output never prints access tokens or bearer values',()=>{
  const safe=redactOutput('http://127.0.0.1:1234/?token=qa-token&x=1 Bearer qatoken')
  assert.ok(!safe.includes('qa-token'));assert.ok(!safe.includes('qatoken'))
  assert.match(safe,/token=<redacted>/);assert.match(safe,/Bearer <redacted>/)
  const moduleUrl=new URL('../scripts/desktop_acceptance.mjs',import.meta.url).href
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {protectOutput} from ${JSON.stringify(moduleUrl)}; protectOutput(); process.stdout.write('http://host/?to'); process.stdout.write('ken=chunk'); process.stdout.write('secret&ok=1\\n');`],{encoding:'utf8'})
  assert.equal(child.status,0);assert.ok(!child.stdout.includes('chunksecret'));assert.match(child.stdout,/token=<redacted>/)
})

test('invalid inputs fail before reserve; setup failure retains a bounded exclusive receipt',()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-acceptance-'))
  try{
    const out=join(root,'new'), bad=prepare(out,join(root,'missing'))
    const badDigest=[...bad];badDigest[badDigest.indexOf('--commit')+1]='invalid'
    assert.equal(run(...badDigest).status,1);assert.equal(existsSync(out),false)
    const first=run(...bad);assert.equal(first.status,1)
    const file=join(out,'prepare-failed.json'),receipt=JSON.parse(readFileSync(file,'utf8'))
    assert.equal(receipt.status,'failed');assert.equal(receipt.cleanup,'removed');assert.equal(receipt.gui_observed,false)
    assert.equal(existsSync(join(out,'qa-home')),false)
    const saved=readFileSync(file);assert.equal(run(...bad).status,1);assert.deepEqual(readFileSync(file),saved)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('a nonempty user output directory is never adopted or modified',()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-occupied-'))
  try{
    const out=join(root,'occupied');mkdirSync(out);writeFileSync(join(out,'marker'),'preserve')
    assert.equal(run(...prepare(out,join(root,'missing'))).status,1)
    assert.equal(readFileSync(join(out,'marker'),'utf8'),'preserve')
    assert.equal(existsSync(join(out,'prepare-failed.json')),false)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('missing original before witness yields failed final receipt and cannot overwrite it',()=>{
  const out=mkdtempSync(join(tmpdir(),'dsi-desktop-final-'))
  try{
    writeFileSync(join(out,'prepared.json'),JSON.stringify({schema:'dsi-desktop-isolated/v1',status:'prepared_not_gui_accepted',output:out,expected:{commit:'1'.repeat(40),tgz:'2'.repeat(64)},host_version:'0.2.2-rc.3',before_sha256:'3'.repeat(64)}))
    assert.equal(run('finalize','--output',out).status,1)
    const path=join(out,'finalized.json'),data=JSON.parse(readFileSync(path,'utf8'))
    assert.equal(data.status,'failed');assert.equal(data.operation.status,'failed');assert.equal(data.source_logs.status,'failed');assert.equal(data.gui_observation,'not_asserted_by_runner')
    const before=readFileSync(path);assert.equal(run('finalize','--output',out).status,1);assert.deepEqual(readFileSync(path),before)
  } finally {rmSync(out,{recursive:true,force:true})}
})

test('prepare failure cleanup disposes its host and preserves a tree if shutdown or deletion fails',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-cleanup-'))
  try{
    const first=join(root,'first');mkdirSync(first);let shutdown=0
    assert.equal(await cleanupFailedPreparation(first,{shutdown:{shutdown:async()=>{shutdown++}}}),'removed')
    assert.equal(shutdown,1);assert.equal(existsSync(first),false)
    const second=join(root,'second');mkdirSync(second)
    assert.equal(await cleanupFailedPreparation(second,{shutdown:{shutdown:async()=>{throw new Error('synthetic')}}}),'retained_shutdown_failed')
    assert.equal(existsSync(second),true)
    const third=join(root,'third');mkdirSync(third)
    assert.equal(await cleanupFailedPreparation(third,null,{remove:async()=>{throw new Error('synthetic')}}),'retained_cleanup_failed')
    assert.equal(existsSync(third),true)
    let retried=0
    assert.equal(await cleanupFailedPreparation(third,{shutdown:{shutdown:async()=>{retried++}}},{shutdownAlreadyFailed:true}),'retained_shutdown_failed')
    assert.equal(retried,0);assert.equal(existsSync(third),true)
  } finally {rmSync(root,{recursive:true,force:true})}
})

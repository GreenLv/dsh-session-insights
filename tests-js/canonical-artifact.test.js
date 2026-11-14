import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync, spawnSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync} from 'node:fs'
import {join, resolve, dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {verifyCanonicalArtifact} from '../scripts/canonical_artifact.mjs'

const hash = x => createHash('sha256').update(x).digest('hex')
const source = resolve('.')
const temp = mkdtempSync(join(tmpdir(), 'dsi-canonical-contract-'))
const repo = join(temp, 'repo'), output = join(temp, 'output')
mkdirSync(repo)
const write = (path, bytes) => {mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, bytes)}
const git = (...args) => execFileSync('git', args, {cwd:repo, stdio:'pipe', encoding:'utf8'}).trim()
for (const path of ['scripts/acceptance_identity.mjs','scripts/canonical_artifact.mjs','scripts/pack_candidate.mjs','scripts/verify_candidate.mjs','scripts/verify_host_acceptance.mjs','scripts/acceptance_diagnostics.mjs','.github/workflows/ci.yml']) {
  const target = join(repo,path); mkdirSync(dirname(target),{recursive:true}); copyFileSync(join(source,path),target)
}
write(join(repo,'package.json'), JSON.stringify({name:'dsh-session-insights',version:'0.8.2',type:'module',files:['plugin/lib/*.js']},null,2)+'\n')
write(join(repo,'package-lock.json'), JSON.stringify({name:'dsh-session-insights',version:'0.8.2',lockfileVersion:3,packages:{}},null,2)+'\n')
write(join(repo,'plugin/lib/index.js'),'export const synthetic = true\n')
git('init','-q'); git('add','.'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','synthetic artifact test')
const commit = git('rev-parse','HEAD')
const pack = spawnSync(process.execPath,[join(repo,'scripts/pack_candidate.mjs'),commit,output],{cwd:repo,encoding:'utf8',timeout:120000,maxBuffer:5*1024*1024})
assert.equal(pack.status,0,`producer failed: ${pack.stderr}`)
const result=JSON.parse(pack.stdout.trim().split('\n').at(-1))
const receiptPath=join(output,'artifact.json'), tarballPath=join(output,result.filename)
const originalReceipt=readFileSync(receiptPath)
const expected={receiptPath,tarballPath,sourceRoot:repo,expectedCommit:commit,expectedSha256:result.sha256,expectedReceiptSha256:result.receipt_sha256}

test('actual single producer and independent consumer anchors agree',async()=>{
  const {receipt,receiptSha256}=await verifyCanonicalArtifact(expected)
  assert.equal(receiptSha256,hash(originalReceipt))
  assert.equal(receipt.schema,'dsh-session-insights/canonical-artifact/2')
  assert.equal(receipt.producer.node.version,process.version)
  assert.equal(receipt.producer.npm.entry,'npm-cli.js')
  assert.ok(receipt.producer.npm.file_count>0)
  assert.equal(receipt.inputs.packed_file_count,receipt.files.length)
})

test('producer rejects Node environment or command-line injection before packing',()=>{
  const rejectedEnv=join(temp,'rejected-env')
  const withEnv=spawnSync(process.execPath,[join(repo,'scripts/pack_candidate.mjs'),commit,rejectedEnv],{cwd:repo,encoding:'utf8',env:{...process.env,NODE_OPTIONS:'--no-warnings'}})
  assert.notEqual(withEnv.status,0);assert.equal(existsSync(rejectedEnv),false)
  const rejectedFlag=join(temp,'rejected-flag')
  const withFlag=spawnSync(process.execPath,['--no-warnings',join(repo,'scripts/pack_candidate.mjs'),commit,rejectedFlag],{cwd:repo,encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}})
  assert.notEqual(withFlag.status,0);assert.equal(existsSync(rejectedFlag),false)
})

test('missing independent receipt anchor and receipt tampering are refused',async()=>{
  await assert.rejects(verifyCanonicalArtifact({...expected,expectedReceiptSha256:undefined}),/independent receipt/)
  const forged=JSON.parse(originalReceipt); forged.producer.node.version='v24.9.0'
  const changed=join(temp,'forged.json');writeFileSync(changed,JSON.stringify(forged))
  await assert.rejects(verifyCanonicalArtifact({...expected,receiptPath:changed}),/receipt digest mismatch/)
  delete forged.producer.npm.tree_sha256
  writeFileSync(changed,JSON.stringify(forged))
  await assert.rejects(verifyCanonicalArtifact({...expected,receiptPath:changed,expectedReceiptSha256:hash(readFileSync(changed))}))
})

test('wrong commit, tarball digest, source input and project config are refused',async()=>{
  await assert.rejects(verifyCanonicalArtifact({...expected,expectedCommit:'1'.repeat(40)}))
  await assert.rejects(verifyCanonicalArtifact({...expected,expectedSha256:'2'.repeat(64)}))
  const manifest=join(repo,'package.json'), before=readFileSync(manifest)
  try {writeFileSync(manifest,Buffer.concat([before,Buffer.from(' ')]));await assert.rejects(verifyCanonicalArtifact(expected))}
  finally {writeFileSync(manifest,before)}
  try {writeFileSync(join(repo,'.npmrc'),'ignore-scripts=false\n');await assert.rejects(verifyCanonicalArtifact(expected),/pack configuration changed/)}
  finally {rmSync(join(repo,'.npmrc'),{force:true})}
})

test('CRLF checkout hashes committed source blobs without accepting content changes',async()=>{
  const workflow=join(repo,'.github/workflows/ci.yml'),before=readFileSync(workflow)
  try {
    git('config','core.autocrlf','true')
    writeFileSync(workflow,before.toString('utf8').replace(/\r?\n/g,'\r\n'))
    await verifyCanonicalArtifact(expected)
    writeFileSync(workflow,Buffer.concat([readFileSync(workflow),Buffer.from('# changed\r\n')]))
    await assert.rejects(verifyCanonicalArtifact(expected))
  } finally {writeFileSync(workflow,before);git('config','core.autocrlf','false')}
})

test('wrong inventory and missing producer details fail even with a fresh receipt digest',async()=>{
  const changed=join(temp,'changed.json')
  const forged=JSON.parse(originalReceipt);forged.files[0].sha256='3'.repeat(64)
  // A fresh trusted receipt digest does not replace an independent packaged
  // inventory check; changing package.json must violate the staged binding.
  forged.files.find(x=>x.path==='package.json').sha256='4'.repeat(64)
  writeFileSync(changed,JSON.stringify(forged))
  await assert.rejects(verifyCanonicalArtifact({...expected,receiptPath:changed,expectedReceiptSha256:hash(readFileSync(changed))}))
  delete forged.producer
  writeFileSync(changed,JSON.stringify(forged))
  await assert.rejects(verifyCanonicalArtifact({...expected,receiptPath:changed,expectedReceiptSha256:hash(readFileSync(changed))}))
})

test('both real package consumers refuse a non-manifest inventory mismatch before installation',()=>{
  const extract=join(temp,'extract');mkdirSync(extract)
  execFileSync('tar',['-xzf',tarballPath,'-C',extract])
  const forged=JSON.parse(originalReceipt)
  const nonManifest=forged.files.find(item=>item.path!=='package.json')
  assert.ok(nonManifest);nonManifest.sha256='3'.repeat(64)
  const altered=join(temp,'wrong-inventory.json');writeFileSync(altered,JSON.stringify(forged))
  const receiptSha=hash(readFileSync(altered))
  const candidateOut=join(temp,'candidate-output')
  const candidate=spawnSync(process.execPath,[join(repo,'scripts/verify_candidate.mjs'),join(extract,'package'),candidateOut,tarballPath,altered,commit,result.sha256,receiptSha],{cwd:repo,encoding:'utf8'})
  assert.notEqual(candidate.status,0)
  assert.match(candidate.stderr,/installed package differs from the accepted artifact/)
  assert.equal(existsSync(candidateOut),false)
  const annex=join(temp,'portable-annex.json')
  const host=spawnSync(process.execPath,[join(repo,'scripts/verify_host_acceptance.mjs'),'--package',tarballPath,'--receipt',altered,'--receipt-sha256',receiptSha,'--expected-sha256',result.sha256,'--commit',commit,'--runtime',temp,'--host',temp,'--workdir',temp,'--annex',annex],{cwd:repo,encoding:'utf8'})
  assert.equal(host.status,1)
  const evidence=JSON.parse(readFileSync(annex,'utf8'))
  assert.equal(evidence.status,'failed')
  assert.equal(evidence.gates.find(g=>g.id==='artifact_identity').status,'failed')
  assert.notEqual(evidence.gates.find(g=>g.id==='install_official_cli')?.status,'passed')
})

test.after(()=>rmSync(temp,{recursive:true,force:true}))

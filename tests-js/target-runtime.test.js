import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {cpSync,mkdirSync,readFileSync,readdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {runtime} from './fixtures/target-runtime.mjs'

test('failed target service staging removes only its own fresh directory',()=>{
  const prefix='.dsh-session-insights-under-test-'
  const entries=()=>readdirSync(join(runtime,'node_modules')).filter(name=>name.startsWith(prefix)).sort()
  const before=entries(), missing=mkdtempSync(join(tmpdir(),'dsi-missing-package-'))
  try {
    const p=spawnSync(process.execPath,[resolve('scripts/dsh-services.mjs'),runtime,missing],{encoding:'utf8'})
    assert.notEqual(p.status,0)
    assert.deepEqual(entries(),before)
  } finally {rmSync(missing,{recursive:true,force:true})}
})

test('selected runtime identity is checked instead of trusting its label',()=>{
  const p=spawnSync(process.execPath,['--input-type=module','-e',
    "import {assertTargetPackage} from './tests-js/fixtures/target-runtime.mjs'; assertTargetPackage('@deepseek-ai/dsh-session-format-catalog')"],{
    encoding:'utf8',env:{...process.env,DSH_RUNTIME:runtime,DSH_EXPECTED_VERSION:'0.0.0-negative-control'},
  })
  assert.notEqual(p.status,0)
  assert.match(p.stdout+p.stderr,/wrong target version/)
})

test('service context is disposed if initialization fails before the session tree exists',()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-service-early-'))
  try {
    const fakeRuntime=join(root,'runtime'), modules=join(fakeRuntime,'node_modules','@deepseek-ai')
    mkdirSync(modules,{recursive:true})
    writeFileSync(join(fakeRuntime,'package.json'),'{}')
    mkdirSync(join(root,'scripts'),{recursive:true})
    cpSync(resolve('scripts/dsh-services.mjs'),join(root,'scripts/dsh-services.mjs'))
    cpSync(resolve('scripts/acceptance_cleanup.mjs'),join(root,'scripts/acceptance_cleanup.mjs'))
    cpSync(resolve('plugin'),join(root,'plugin'),{recursive:true})
    mkdirSync(join(root,'tests/fixtures'),{recursive:true})
    cpSync(resolve('tests/fixtures/synthetic-session.jsonl'),join(root,'tests/fixtures/synthetic-session.jsonl'))
    const fake={
      cordis:"import {writeFileSync} from 'node:fs'; export class Context {constructor(){this.fiber={dispose:async()=>{writeFileSync(process.env.DSI_SYNTHETIC_DISPOSE_MARKER,'disposed');if(process.env.DSI_SYNTHETIC_DISPOSE_FAIL)throw new Error('synthetic disposal failure')}}}}",
      'dsh-session':"export class SessionStore {constructor(){throw new Error('synthetic early failure')}}; export class Session {}",
      'dsh-session-query':'export class SessionQueryEngine {}',
      'dsh-commands':'export class CommandRuntime {}',
      'dsh-tools':'export class ToolRuntime {}',
      'dsh-system-prompt':'export class SystemPrompt {}',
      'dsh-session-format-catalog':'export const sessionFormatCatalog = {}',
      'dsh-session-format-v3-to-v4':'export const releasedV4SessionFormatCodec = {}',
      'dsh-llm':'export function createUserMessage() {}',
    }
    for(const [name,source] of Object.entries(fake)) {
      const dir=join(modules,name);mkdirSync(dir,{recursive:true})
      writeFileSync(join(dir,'package.json'),JSON.stringify({name:'@deepseek-ai/'+name,version:'0.2.1-rc.2',type:'module',main:'index.js'}))
      writeFileSync(join(dir,'index.js'),source)
    }
    const marker=join(root,'disposed.txt')
    const p=spawnSync(process.execPath,[join(root,'scripts/dsh-services.mjs'),fakeRuntime,root],{
      encoding:'utf8',env:{...process.env,DSI_SYNTHETIC_DISPOSE_MARKER:marker},
    })
    assert.notEqual(p.status,0)
    assert.match(p.stderr,/synthetic early failure/)
    assert.equal(readFileSync(marker,'utf8'),'disposed')
    assert.ok(!readdirSync(join(fakeRuntime,'node_modules')).some(name=>name.startsWith('.dsh-session-insights-under-test-')))
    const failedDispose=spawnSync(process.execPath,[join(root,'scripts/dsh-services.mjs'),fakeRuntime,root],{
      encoding:'utf8',env:{...process.env,DSI_SYNTHETIC_DISPOSE_MARKER:marker,DSI_SYNTHETIC_DISPOSE_FAIL:'1'},
    })
    assert.notEqual(failedDispose.status,0)
    assert.match(failedDispose.stderr,/synthetic early failure/)
    assert.match(failedDispose.stderr,/synthetic disposal failure/)
    assert.ok(readdirSync(join(fakeRuntime,'node_modules')).some(name=>name.startsWith('.dsh-session-insights-under-test-')))
  } finally {rmSync(root,{recursive:true,force:true})}
})

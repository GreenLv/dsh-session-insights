// Production plugin loaded through real Cordis sibling-service contexts.
// Controlled approval decisions exercise lookup and ownership; the separate
// native approval scene verifies the official ApprovalService audit/persistence.
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../plugin/lib/index.js'
import {Store} from '../plugin/lib/storage.js'

const require=createRequire(join(resolve(process.env.DSH_RUNTIME || 'tests/dsh-runtime'),'package.json'))
const load=async name=>import(pathToFileURL(require.resolve(name)).href)
const {Context}=await load('@deepseek-ai/cordis')
const {SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt')
const {ToolRuntime}=await load('@deepseek-ai/dsh-tools')
const {CommandRuntime}=await load('@deepseek-ai/dsh-commands')

async function scene(run) {
  const home=mkdtempSync(join(tmpdir(),'dsi-approval-context-')),saved=process.env.DSH_HOME
  process.env.DSH_HOME=home
  const ctx=new Context()
  new SystemPrompt(ctx,{})
  new ToolRuntime(ctx)
  new CommandRuntime(ctx)
  ctx.provide('sessionQuery',{})
  const store=new Store(),create=()=>{const target=store.create();store.write(target,'report.json',{synthetic:true});return target}
  try { await run({ctx,create,tool:()=>ctx.tools.get('session_insights_cleanup')}) }
  finally {await ctx.fiber.dispose();if(saved===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=saved;rmSync(home,{recursive:true,force:true})}
}
async function provider(ctx,request) {
  const handle=ctx.plugin(scope=>{scope.provide('approval',{request})})
  await handle
  return handle
}
const exec=(callId='synthetic-call')=>({agent:{synthetic:true},callId,signal:new AbortController().signal})

test('G2 Cordis: optional service absent, late sibling, removal and plugin reload',()=>scene(async({ctx,create,tool})=>{
  const first=ctx.plugin(plugin);await first
  assert.equal(ctx.tools.schemas().length,7)
  assert.equal(ctx.get('approval'),undefined)
  const target=create(),before=readFileSync(join(target,'report.json'),'utf8')
  assert.equal(JSON.parse((await tool().execute({workdir:target},exec())).text).deleted,false)
  await assert.rejects(tool().execute({workdir:target,confirm:true},exec()),/requires a host approval service/)
  assert.equal(readFileSync(join(target,'report.json'),'utf8'),before)
  let calls=0
  const sibling=await provider(ctx,async()=>{calls++;return 'allowed-once'})
  await tool().execute({workdir:target,confirm:true},exec())
  assert.equal(calls,1);assert.equal(existsSync(target),false)
  await sibling.dispose()
  const retained=create()
  await assert.rejects(tool().execute({workdir:retained,confirm:true},exec()),/requires a host approval service/)
  assert.ok(existsSync(retained))
  await first.dispose();assert.equal(tool(),undefined)
  const second=ctx.plugin(plugin);await second
  await first.dispose();assert.ok(tool());assert.ok(ctx.commands.find(undefined,'session-insights'))
}))

test('G2 Cordis: sibling decisions bind each call and preserve unrelated runs',()=>scene(async({ctx,create,tool})=>{
  const requests=[];let outcome='allowed-once'
  await provider(ctx,async req=>{requests.push(req);return outcome})
  const handle=ctx.plugin(plugin);await handle
  const other=create(),agent={synthetic:true}
  for(const expected of ['allowed-once','rejected','cancelled','unavailable']) {
    outcome=expected
    const target=create(),execution={...exec('call-'+expected),agent}
    const operation=tool().execute({workdir:target,confirm:true},execution)
    if(expected==='allowed-once')await operation
    else await assert.rejects(operation,new RegExp('not approved \\('+expected+'\\)'))
    assert.equal(existsSync(target),expected!=='allowed-once');assert.ok(existsSync(other))
    const req=requests.at(-1)
    assert.equal(req.agent,agent);assert.equal(req.callId,execution.callId)
    assert.equal(req.toolName,'session_insights_cleanup');assert.ok(req.reason.includes(target))
    assert.ok(req.signal instanceof AbortSignal);assert.notEqual(req.signal,execution.signal)
  }
  assert.equal(requests.length,4) // the first grant cannot authorize the next run
}))

test('G2 Cordis: caller cancellation and owner disposal reach in-flight approval',()=>scene(async({ctx,create,tool})=>{
  let started,entered,signal
  await provider(ctx,async req=>{
    signal=req.signal;entered()
    await new Promise(resolve=>req.signal.addEventListener('abort',resolve,{once:true}))
    return 'cancelled'
  })
  let handle=ctx.plugin(plugin);await handle
  for(const mode of ['caller','owner']) {
    started=new Promise(resolve=>{entered=resolve})
    const target=create(),controller=new AbortController()
    const pending=assert.rejects(tool().execute({workdir:target,confirm:true},{...exec(),signal:controller.signal}),/not approved \(cancelled\)/)
    await started
    if(mode==='caller')controller.abort()
    else await handle.dispose()
    await pending;assert.ok(signal.aborted);assert.ok(existsSync(target))
  }
  assert.equal(tool(),undefined)
  const fresh=ctx.plugin(plugin);await fresh;await handle.dispose();assert.ok(tool())
}))

test('G2 Cordis: optional lookup respects service isolation',()=>scene(async({ctx,create,tool})=>{
  let outerCalls=0,innerCalls=0
  await provider(ctx,async()=>{outerCalls++;return 'allowed-once'})
  const isolated=ctx.isolate('approval'),handle=isolated.plugin(plugin);await handle
  assert.ok(ctx.get('approval'));assert.equal(isolated.get('approval'),undefined)
  const target=create()
  await assert.rejects(tool().execute({workdir:target,confirm:true},exec()),/requires a host approval service/)
  assert.equal(outerCalls,0);assert.ok(existsSync(target))
  await provider(isolated,async()=>{innerCalls++;return 'allowed-once'})
  await tool().execute({workdir:target,confirm:true},exec())
  assert.equal(outerCalls,0);assert.equal(innerCalls,1);assert.equal(existsSync(target),false)
}))

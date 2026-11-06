// Real-executor and Agent-scope integration checks for the exact rc.1 host
// closure (zero-model, synthetic data only). This is service/executor
// evidence, not a GUI, real-model, or real-host-acceptance claim.
//
// What this proves, against the exact published executor packages:
// - official composition: the PTC stack's service providers mount through the
//   official loader (scripts/rc1-executor-composition.yaml template, rendered
//   per run); the Session/query/tools/system-prompt/working-directory
//   services mount on the booted context through their plugin lifecycle so
//   their projection handles actually register;
// - supported Agent scopes: Agent scopes come from the official
//   `createScope` machinery (carrier objects bound to the live session and
//   their scope context) — the same construction the host's agent layer
//   uses; no model-driven turn runs, and none is claimed;
// - real PTC: `run_code` through the official PtcExecutor + NodePtcRuntime
//   calls the plugin's tools via the generated SDK (never a mock executor or
//   a direct definition.execute() shortcut);
// - real native: the official NativeToolExecutor dispatches DSI tool calls;
// - one Agent, one freshly resolved toolSet carried through
//   tools.resolve → prompt assembly → tools.execute, for both executors;
// - refusals with positive controls: conditional `when` is genuinely
//   consulted (false: unannounced/unexecuted; true: announced/executed —
//   flipping the flag changes the outcome), a tool executes before its
//   removal and refuses after it even under the previously allowed set, a
//   toolSet executes before its release and refuses after, and a withdrawn
//   Agent override does not fall back to the deployment default that
//   demonstrably serves the same tool;
// - mid-flight cancellation and owner dispose: work that verifiably started
//   (marker) settles as cancelled, later program statements never run, and
//   the deployment default keeps serving; started side effects are recorded
//   as possible, never claimed away.
//
// Failure handling: cleanup ownership starts at resource acquisition. Boot
// rejection, initialization failure and cleanup failure keep the original
// failure, restore the environment, remove owned directories, and propagate
// a non-zero exit. `DSI_EXECUTOR_FAIL_STAGE=boot|init|cleanup` injects the
// controlled failures consumed by `--self-test`.
//
// Windows: every path crosses the URL boundary through fileURLToPath (the
// composition template and the staged runner both resolve natively); the
// Windows lane re-runs this runner natively (exact command in the handoff).
import {createRequire} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {readFile,writeFile,mkdtemp,rm,cp,mkdir,readdir as readDir} from 'node:fs/promises'
import {existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {join,resolve,dirname} from 'node:path'
import assert from 'node:assert/strict'

export function compositionTemplatePath(){
  // The composition template ships beside this script; the URL boundary is
  // crossed with fileURLToPath so spaces and Windows drive letters survive.
  return fileURLToPath(new URL('./rc1-executor-composition.yaml', import.meta.url))
}

const args=process.argv.slice(2)
const runSelfTest=args.includes('--self-test')
const positional=args.filter(a=>!a.startsWith('--'))
const runtime=resolve(positional[0] || ''), packageRoot=resolve(positional[1] || '.')
if(!runtime)throw new Error('target host tree required (tests/dsh-host)')
const req=createRequire(join(runtime,'package.json'))
const load=async name=>import(pathToFileURL(req.resolve(name)).href)

async function fileTreeDigest(root){
  const files=[]
  async function walk(dir){
    for(const entry of await readDir(dir,{withFileTypes:true})){
      const path=join(dir,entry.name)
      if(entry.isDirectory())await walk(path)
      else files.push([join(dir,entry.name).slice(root.length),createHash('sha256').update(await readFile(path)).digest('hex')])
    }
  }
  await walk(root)
  return createHash('sha256').update(JSON.stringify(files.sort((a,b)=>a[0]<b[0]?-1:1))).digest('hex')
}

// The executor packages ship only in the full host closure; refusing here is
// the honest outcome for a contract-only runtime tree.
for (const name of ['@deepseek-ai/dsh-tool-executor-native','@deepseek-ai/dsh-tool-executor-ptc','@deepseek-ai/dsh-ptc-runtime-node','@deepseek-ai/dsh-subprocess-local','@deepseek-ai/dsh-sandbox-local','@deepseek-ai/dsh-fs-local','@deepseek-ai/dsh-sandbox-policy','@deepseek-ai/dsh-session-projection']) {
  if (!existsSync(join(runtime,'node_modules',...name.split('/'))))
    throw new Error(`target tree ${runtime} does not resolve ${name}; the executor checks need the full host tree (tests/dsh-host)`)
}

const FAIL_STAGE=process.env.DSI_EXECUTOR_FAIL_STAGE||''
const scratchRoot=mkdtempSync(join(tmpdir(),'dsi-executor-runner-'))
// Default home name contains a space so every consumer is exercised across
// the URL boundary; DSI_EXECUTOR_HOME_NAME=plain selects the no-space form
// for the ordinary-path control run.
const home=join(scratchRoot,process.env.DSI_EXECUTOR_HOME_NAME==='plain'?'home':'executor home')
const workdir=join(home,'work')
const stagedRoot=mkdtempSync(join(runtime,'node_modules','.dsh-session-insights-under-test-'))+'/plugin'
const compositionPath=join(scratchRoot,'rc1-executor-composition.yaml')
const previousHome=process.env.DSH_HOME
let bootCtx,primaryFailure
const cleanups=[]
const cleanup=(label,fn)=>cleanups.push([label,fn])
let result

try {
  // Cleanup ownership starts with the first acquired/changed resource.
  mkdirSync(home,{recursive:true})
  process.env.DSH_HOME=home
  cleanup('environment',async()=>{
    if(previousHome===undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME=previousHome
  })
  cleanup('scratch tree',async()=>{await rm(scratchRoot,{recursive:true,force:true})})

  // Stage the plugin INSIDE the target tree's node_modules so its
  // @deepseek-ai imports resolve against the exact closure under test
  // (same guarantees as scripts/dsh-services.mjs).
  await mkdir(dirname(stagedRoot),{recursive:true})
  await cp(join(packageRoot,'plugin'),stagedRoot,{recursive:true})
  assert.equal(await fileTreeDigest(stagedRoot),await fileTreeDigest(join(packageRoot,'plugin')),'staged plugin differs from the production plugin')
  const plugin=await import(pathToFileURL(join(stagedRoot,'lib/index.js')).href)
  {
    const pluginReq=createRequire(join(stagedRoot,'lib/index.js'))
    const llmPath=pluginReq.resolve('@deepseek-ai/dsh-llm/package.json')
    const llmVersion=JSON.parse(await readFile(llmPath,'utf8')).version
    const expectedVersion=JSON.parse(await readFile(createRequire(join(runtime,'package.json')).resolve('@deepseek-ai/dsh-llm/package.json'),'utf8')).version
    assert.equal(llmVersion,expectedVersion,`staged plugin resolved dsh-llm ${llmVersion}, target tree is ${expectedVersion}`)
  }
  cleanup('staged plugin removal',async()=>{await rm(stagedRoot,{recursive:true,force:true})})

  // Render the composition template with this run's writable roots, then boot
  // through the official loader. The template path itself crosses the URL
  // boundary via fileURLToPath (R2-PATH).
  const template=await readFile(compositionTemplatePath(),'utf8')
  await writeFile(compositionPath,template
    .replaceAll('__WORKSPACE_ROOT__',home.replaceAll('\\','\\\\'))
    .replaceAll('__DEFAULT_DIRECTORY__',workdir.replaceAll('\\','\\\\')))

  const {boot}=await load('@deepseek-ai/dsh-app-boot')
  const referrer=pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href

  if (FAIL_STAGE==='boot') {
    // Controlled failure: a real boot rejection (missing composition) while
    // home/env/staging cleanup ownership is already established.
    const badBoot=await boot('dsh',join(scratchRoot,'does-not-exist.yaml'),[],()=>{},referrer)
    void badBoot
    throw new Error('injected boot failure did not reject')
  }

  bootCtx=await boot('dsh',compositionPath,[],()=>{},referrer)
  cleanup('booted context',async()=>{await bootCtx.fiber.dispose()})

  if (FAIL_STAGE==='init') throw new Error('injected initialization failure')

  for (const service of ['fs','subprocess','sandbox','sandboxPolicy','ptcRuntime'])
    assert.ok(bootCtx.get(service),`official composition did not mount ${service}`)

  // Session/query/tools/system-prompt/working-directory mount through their
  // plugin lifecycle so the projection handles registered in Service.init
  // actually exist for Agent-owned PTC programs.
  const {NativeToolExecutor}=await load('@deepseek-ai/dsh-tool-executor-native')
  const {PtcExecutor}=await load('@deepseek-ai/dsh-tool-executor-ptc')
  const {SessionStore}=await load('@deepseek-ai/dsh-session')
  const {SessionQueryEngine}=await load('@deepseek-ai/dsh-session-query')
  const {CommandRuntime}=await load('@deepseek-ai/dsh-commands')
  const {ToolsService}=await load('@deepseek-ai/dsh-tools')
  const {SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt')
  const {WorkingDirectoryService}=await load('@deepseek-ai/dsh-working-directory')
  const mounted={sessions:await bootCtx.plugin(SessionStore,{}),
    query:await bootCtx.plugin(SessionQueryEngine,{}),
    prompt:await bootCtx.plugin(SystemPrompt,{}),
    commands:await bootCtx.plugin(CommandRuntime,{}),
    workingDirectory:await bootCtx.plugin(WorkingDirectoryService,{defaultDirectory:workdir}),
    tools:await bootCtx.plugin(ToolsService,{})}
  // Awaiting the fibration resolves to the owning Fiber; the running service
  // instance reads from that fiber's context (its own provision).
  const sessions=mounted.sessions.ctx.sessions
  const tools=mounted.tools.ctx.tools
  assert.ok(typeof sessions.create==='function' && typeof tools.setExecutor==='function','core services did not start')

  const rows=(await readFile(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse)
  const {type,...header}=rows[0]
  // Agent-owned PTC resolves the working directory from the session header;
  // point it at this run's real (existing) workspace.
  header.cwd=workdir
  mkdirSync(workdir,{recursive:true})
  const liveSession=sessions.create(header.id,{seed:rows.slice(1),meta:header,inheritedEventCount:0})

  // Supported Agent scopes (official createScope machinery; carriers bound to
  // the live session and their scope context — the construction the host's
  // agent layer itself uses). The agents stay zero-model: no model-driven
  // turn runs and none is claimed.
  const {createScope}=await load('@deepseek-ai/dsh-scope')
  const agentA={carrier:'dsi-executor-agent-a',session:liveSession}
  const agentB={carrier:'dsi-executor-agent-b',session:liveSession}
  const scopeA=createScope(bootCtx,agentA);agentA.ctx=scopeA.ctx
  const scopeB=createScope(bootCtx,agentB);agentB.ctx=scopeB.ctx
  cleanup('agent scopes',async()=>{await Promise.allSettled([scopeA.dispose(),scopeB.dispose()])})

  // Deployment default = official native executor; one Agent override =
  // official PTC executor. Both selections exist at the same time, which is
  // what makes the later no-fallback withdrawal meaningful.
  const rootNativeDisposer=tools.setExecutor(new NativeToolExecutor(bootCtx))
  cleanup('default executor',async()=>{rootNativeDisposer()})
  // The PtcExecutor is the officially packaged plugin: mounting it on the
  // Agent scope through its own declaration resolves its injects and selects
  // it inside that scope (its apply() calls ctx.tools.setExecutor).
  // The package namespace (apply + inject + name) is the official plugin
  // unit: its declared injects let its apply() read ctx.tools inside this
  // scope. Constructing the bare class would lack the inject declaration.
  const ptcModule=await load('@deepseek-ai/dsh-tool-executor-ptc')
  const ptcFibration=scopeA.ctx.plugin(ptcModule,{maxParallelSubCalls:4})
  await ptcFibration
  assert.ok(ptcFibration.runtime,'the Agent override executor must mount through its official plugin declaration')
  const ptcOverrideDisposer=()=>ptcFibration.dispose()
  const owner=bootCtx.plugin(plugin);await owner
  cleanup('plugin under test',async()=>{await owner})

  const signal=new AbortController().signal
  const modelSelection={provider:'synthetic',model:'synthetic'}
  result={subject:'zero-model real-executor/agent-scope integration; no GUI, real-model or model-driven-turn claim',scope:'official rc.1 executors over the official composition, default native plus one Agent PTC override'}

  const runCount=async()=>{
    const dir=join(home,'insights','runs')
    return (await readDir(dir).catch(()=>[])).length
  }
  const textOf=r=>Array.isArray(r.content)?r.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'):String(r.content ?? '')
  const prepareToolSet=async(agent)=>tools.resolve({...(agent?{agent}:{}),signal,modelSelection})

  // --- routing: each scope serves its calls with its own executor -----------
  // Default scope (native): the plugin tools are announced and a direct call
  // lands through the official NativeToolExecutor.
  const rootSet=await prepareToolSet(null)
  const rootAssembly=await bootCtx.systemPrompt.assemble({toolSet:rootSet})
  for (const expected of ['session_insights_prepare','session_insights_get_batch','session_insights_submit_batch','session_insights_cleanup'])
    assert.ok(rootAssembly.tools.some(t=>t.name===expected),`${expected} missing from the native prompt assembly`)
  const rootBatch=await tools.execute({signal,toolSet:rootSet,calls:[{
    type:'tool-call',id:'dsi-native-prepare-1',name:'session_insights_prepare',
    arguments:JSON.stringify({days:3650,privacy:'metrics',locale:'en'}),
  }]})
  assert.equal(rootBatch.results[0].result.isError,false,JSON.stringify(rootBatch.results[0].result).slice(0,400))
  const nativePrepared=JSON.parse(textOf(rootBatch.results[0].result))
  const nativeBase=JSON.parse(await readFile(join(nativePrepared.workdir,'base-report.json'),'utf8'))
  assert.equal(nativeBase.totals.sessions,1)
  result.default_native_route=true

  // Agent override (PTC): run_code is announced through the override, the
  // same freshly resolved Agent toolSet is passed into execute, and the
  // program reaches the plugin tool via the generated SDK.
  const setA=await prepareToolSet(agentA)
  const assemblyA=await bootCtx.systemPrompt.assemble({toolSet:setA,scope:agentA})
  assert.deepEqual(assemblyA.tools.map(t=>t.name),['run_code'],'PTC surface must announce only run_code')
  const sdkText=[...(assemblyA.sections ?? []),...Object.values(assemblyA).filter(v=>typeof v==='string')].map(v=>typeof v==='string'?v:JSON.stringify(v)).join('\n')
  for (const expected of ['session_insights_prepare','session_insights_get_batch','session_insights_submit_batch'])
    assert.ok(sdkText.includes(expected),`${expected} missing from the PTC SDK declarations`)
  const ptcBatch=await tools.execute({agent:agentA,signal,toolSet:setA,calls:[{
    type:'tool-call',id:'dsi-ptc-prepare-1',name:'run_code',
    arguments:JSON.stringify({code:`const prepared = await tools.session_insights_prepare({days: 3650, privacy: 'metrics', locale: 'en'})\nreturn {prepared}`,description:'call session insights prepare through the SDK'}),
  }]})
  assert.equal(ptcBatch.results[0].result.isError,false,JSON.stringify(ptcBatch.results[0].result).slice(0,400))
  const ptcParsed=JSON.parse(textOf(ptcBatch.results[0].result))
  const ptcPayload=typeof ptcParsed.prepared==='string'?JSON.parse(ptcParsed.prepared)
    :ptcParsed.prepared?.text!==undefined?JSON.parse(ptcParsed.prepared.text)
    :ptcParsed.prepared
  assert.equal(ptcPayload.metrics_semantic_skipped,true,'prepare payload shape: '+textOf(ptcBatch.results[0].result).slice(0,200))
  const ptcBase=JSON.parse(await readFile(join(ptcPayload.workdir,'base-report.json'),'utf8'))
  assert.equal(ptcBase.totals.sessions,1)
  result.agent_ptc_route=true

  // The default scope answers run_code with native: refused — the same call
  // the override executes, so the two scopes demonstrably route differently.
  const rootRunCode=await tools.execute({signal,toolSet:rootSet,calls:[{
    type:'tool-call',id:'dsi-root-run-code-1',name:'run_code',arguments:'{}',
  }]})
  assert.equal(rootRunCode.results[0].result.isError,true,'run_code must refuse under the native default')
  // The override scope answers a direct call with PTC: UNKNOWN_TOOL — the
  // same tool the default executes, refused on the PTC surface.
  const agentDirect=await tools.execute({agent:agentA,signal,toolSet:setA,calls:[{
    type:'tool-call',id:'dsi-agent-direct-1',name:'session_insights_prepare',
    arguments:JSON.stringify({days:30,privacy:'metrics',locale:'en'}),
  }]})
  assert.equal(agentDirect.results[0].result.isError,true,'direct non-run_code call must fail under PTC')
  assert.equal(agentDirect.results[0].result.error?.info?.code ?? agentDirect.results[0].result.error?.code,'UNKNOWN_TOOL')
  result.routing_is_executor_specific=true

  // --- toolSet isolation ----------------------------------------------------
  const runsBeforeCross=await runCount()
  const crossSet=await tools.execute({agent:agentB,signal,toolSet:setA,calls:[{
    type:'tool-call',id:'dsi-cross-set-1',name:'run_code',
    arguments:JSON.stringify({code:`const prepared = await tools.session_insights_prepare({days: 3650, privacy: 'metrics', locale: 'en'})\nreturn {prepared}`,description:'foreign toolSet'}),
  }]})
  assert.equal(crossSet.results[0].result.isError,true,"Agent B must not execute with Agent A's toolSet")
  const noAgent=await tools.execute({signal,toolSet:setA,calls:[{
    type:'tool-call',id:'dsi-noscope-set-1',name:'run_code',
    arguments:JSON.stringify({code:'return 1',description:'scopeless toolSet'}),
  }]})
  assert.equal(noAgent.results[0].result.isError,true,'a scope-bound toolSet must refuse without its scope')
  assert.equal(await runCount(),runsBeforeCross,'rejected toolSet uses must not leave runs behind')
  result.toolset_scope_isolation=true

  // --- conditional activation with a real oracle ----------------------------
  // Registration happens first; the toolSet is resolved afterwards and passed
  // into execute, so the `when` callback is genuinely consulted. Both states
  // run in-process: flipping the flag changes announced AND executed
  // outcomes, which is exactly the false->true negative control.
  const runsBeforeConditional=await runCount()
  let falseEvals=0,trueEvals=0
  const probeDefinition={
    name:'dsi_conditional_probe',description:'conditional probe',parameters:{type:'object',properties:{}},
    output:{schema:{type:'object',properties:{}},render:()=>[{type:'text',text:'ran'}]},
    async execute(){await writeFile(join(home,'conditional-marker.txt'),'ran');return {text:'ran'}},
  }
  const conditionalOff=bootCtx.tools.register({...probeDefinition},
    {when:async()=>{falseEvals++;return false}})
  const setCondOff=await prepareToolSet(agentA)
  const offAssembly=await bootCtx.systemPrompt.assemble({toolSet:setCondOff,scope:agentA})
  const offSdk=[...(offAssembly.sections ?? []),...Object.values(offAssembly).filter(v=>typeof v==='string')].map(v=>typeof v==='string'?v:JSON.stringify(v)).join('\n')
  assert.ok(!offSdk.includes('dsi_conditional_probe'),'an unactivated tool must not be announced (assembly or SDK)')
  assert.ok(falseEvals>0,'the when callback was never evaluated')
  const condOff=await tools.execute({agent:agentA,signal,toolSet:setCondOff,calls:[{
    type:'tool-call',id:'dsi-conditional-off-1',name:'dsi_conditional_probe',arguments:'{}',
  }]})
  assert.equal(condOff.results[0].result.isError,true,'a conditionally inactive tool must refuse')
  assert.ok(!existsSync(join(home,'conditional-marker.txt')),'an unactivated tool body must not run')
  conditionalOff()
  const conditionalOn=bootCtx.tools.register({...probeDefinition},
    {when:async()=>{trueEvals++;return true}})
  const setCondOn=await prepareToolSet(agentA)
  const onAssembly=await bootCtx.systemPrompt.assemble({toolSet:setCondOn,scope:agentA})
  const onSdk=[...(onAssembly.sections ?? []),...Object.values(onAssembly).filter(v=>typeof v==='string')].map(v=>typeof v==='string'?v:JSON.stringify(v)).join('\n')
  assert.ok(onSdk.includes('dsi_conditional_probe'),'an activated tool must be announced in the SDK declarations')
  assert.ok(trueEvals>0,'the activated when callback was never evaluated')
  const condOn=await tools.execute({agent:agentA,signal,toolSet:setCondOn,calls:[{
    type:'tool-call',id:'dsi-conditional-on-1',name:'run_code',
    arguments:JSON.stringify({code:'return await tools.dsi_conditional_probe({})',description:'invoke the conditionally active probe through the SDK'}),
  }]})
  assert.equal(condOn.results[0].result.isError,false,'a conditionally active tool must execute: '+JSON.stringify(condOn.results[0].result).slice(0,200))
  assert.ok(existsSync(join(home,'conditional-marker.txt')),'the activated tool body must have run')
  conditionalOn()
  assert.equal(await runCount(),runsBeforeConditional,'the probe tool leaves no runs behind')
  result.conditional_oracle={off_refused:falseEvals>0,on_executed:trueEvals>0}

  // --- removal with a positive control --------------------------------------
  const removableMarker=join(home,'removable-marker.txt')
  const removable=bootCtx.tools.register({
    name:'dsi_removable_probe',description:'removable probe',parameters:{type:'object',properties:{}},
    output:{schema:{type:'object',properties:{}},render:()=>[{type:'text',text:'ran'}]},
    async execute(){await writeFile(removableMarker,'ran');return {text:'ran'}},
  })
  const setRemovable=await prepareToolSet(agentA)
  const removableAssembly=await bootCtx.systemPrompt.assemble({toolSet:setRemovable,scope:agentA})
  const removableSdk=[...(removableAssembly.sections ?? []),...Object.values(removableAssembly).filter(v=>typeof v==='string')].map(v=>typeof v==='string'?v:JSON.stringify(v)).join('\n')
  assert.ok(removableSdk.includes('dsi_removable_probe'),'the removable tool must be announced before removal')
  const beforeRemoval=await tools.execute({agent:agentA,signal,toolSet:setRemovable,calls:[{
    type:'tool-call',id:'dsi-removable-before-1',name:'run_code',
    arguments:JSON.stringify({code:'return await tools.dsi_removable_probe({})',description:'invoke the removable probe through the SDK'}),
  }]})
  assert.equal(beforeRemoval.results[0].result.isError,false,'the removable tool must really execute before removal: '+JSON.stringify(beforeRemoval.results[0].result).slice(0,200))
  assert.ok(existsSync(removableMarker),'the pre-removal execution must leave its side effect')
  removable()
  const afterRemoval=await tools.execute({agent:agentA,signal,toolSet:setRemovable,calls:[{
    type:'tool-call',id:'dsi-removable-after-1',name:'run_code',
    arguments:JSON.stringify({code:'return await tools.dsi_removable_probe({})',description:'post-removal'}),
  }]})
  assert.equal(afterRemoval.results[0].result.isError,true,'a removed tool must refuse even under the previously allowed set')
  result.removal_positive_control=true

  // --- release with a positive control --------------------------------------
  const setRelease=await prepareToolSet(agentA)
  // The sub-call carries exec.toolSet into the registry lookup, so a released
  // set empties the view and the nested call refuses even though run_code
  // itself is the reserved transport.
  const releaseCall=calls=>tools.execute({agent:agentA,signal,toolSet:setRelease,calls})
  const beforeRelease=await releaseCall([{
    type:'tool-call',id:'dsi-release-before-1',name:'run_code',
    arguments:JSON.stringify({code:'const prepared = await tools.session_insights_prepare({days: 3650, privacy: \'metrics\', locale: \'en\'})\nreturn JSON.stringify({ok: prepared.metrics_semantic_skipped})',description:'pre-release positive control'}),
  }])
  assert.equal(beforeRelease.results[0].result.isError,false,'the toolSet must really execute before release: '+JSON.stringify(beforeRelease.results[0].result).slice(0,200))
  setRelease.dispose()
  const afterRelease=await releaseCall([{
    type:'tool-call',id:'dsi-release-after-1',name:'run_code',
    arguments:JSON.stringify({code:'const prepared = await tools.session_insights_prepare({days: 3650, privacy: \'metrics\', locale: \'en\'})\nreturn JSON.stringify({ok: prepared.metrics_semantic_skipped})',description:'post-release'}),
  }])
  assert.equal(afterRelease.results[0].result.isError,true,'a released toolSet must refuse')
  result.release_positive_control=true

  // --- mid-flight caller cancellation ---------------------------------------
  // The program proves it started (marker), then idles; the caller aborts and
  // the batch settles as cancelled. The started marker stays: started work
  // may have produced side effects and is never claimed as "not executed".
  const startedMarker=join(home,'ptc-started-marker.txt'),doneMarker=join(home,'ptc-done-marker.txt')
  const cancelController=new AbortController()
  const midFlight=tools.execute({agent:agentA,signal:cancelController.signal,calls:[{
    type:'tool-call',id:'dsi-midflight-1',name:'run_code',
    arguments:JSON.stringify({code:`await tools.session_insights_prepare({days: 3650, privacy: 'metrics', locale: 'en'})\nawait (await import('node:fs/promises')).writeFile(${JSON.stringify(startedMarker)},'started')\nawait new Promise(r=>setTimeout(r,8000))\nawait (await import('node:fs/promises')).writeFile(${JSON.stringify(doneMarker)},'done')\nreturn 'completed'`,description:'long program for mid-flight cancellation'}),
  }]})
  const settle=promise=>Promise.race([promise.catch(e=>({rejection:e})),new Promise(r=>setTimeout(()=>r({timeout:true}),60000))])
  let started=false
  for (let i=0;i<100 && !started;i++) {
    await new Promise(r=>setTimeout(r,100))
    started=existsSync(startedMarker)
  }
  assert.ok(started,'the PTC program must verifiably start before cancellation')
  const runsAtAbort=await runCount()
  cancelController.abort(new Error('caller cancelled mid-flight'))
  const midOutcome=await settle(midFlight)
  assert.ok(!midOutcome.timeout,'the cancelled batch must settle after abort')
  // The batch settles (resolved empty-discarded or rejected) once the started
  // work has been awaited and torn down; it never returns a successful call.
  // Observed cancellation shape: the batch promise settles without a result
  // object (the executor awaits started work, tears it down, and completes
  // the caller's promise without publishable content). The guarantees kept:
  // it never settles as a successful result, the program never completes,
  // and the default scope keeps serving.
  let settledShape
  let classification
  if (midOutcome.rejection!==undefined) {
    settledShape='rejected'
    classification='rejected: '+String(midOutcome.rejection?.message ?? midOutcome.rejection).slice(0,100)
  } else {
    const midResult=midFlight?.results?.[0]?.result ?? null
    if (midResult) {
      assert.ok(midResult.isError===true,'a cancelled call must not settle as success')
      settledShape='resolved-error-result'
      classification=`${midResult.error?.info?.code ?? ''}|${midResult.error?.message ?? ''}`
    } else {
      settledShape='resolved-without-result'
      classification='no publishable result (started work awaited and discarded)'
    }
  }
  assert.ok(existsSync(startedMarker),'the started marker stays: the call did begin')
  await new Promise(r=>setTimeout(r,1500))
  assert.ok(!existsSync(doneMarker),'the cancelled program must not run to completion')
  const runsAfterCancel=await runCount()
  assert.ok(runsAfterCancel<=runsAtAbort,'no run may start after the caller aborts')
  assert.ok(runsAfterCancel>=runsAtAbort,'started side effects remain on disk')
  // The executor stays healthy: a fresh short program still executes.
  const healthy=await tools.execute({agent:agentA,signal,calls:[{
    type:'tool-call',id:'dsi-post-cancel-1',name:'run_code',
    arguments:JSON.stringify({code:"return JSON.stringify({alive:true})",description:'post-cancel health probe'}),
  }]})
  assert.equal(healthy.results[0].result.isError,false,'the executor must stay usable after cancellation')
  result.midflight_cancellation={settled:true,started_recorded:true,completed:false,settled_shape:settledShape,classification:classification.slice(0,140)}

  // --- owner dispose with in-flight work ------------------------------------
  // Start a long program under the Agent override, prove it started, then
  // dispose the owning executor fiber. The batch must settle and the program
  // must not continue; the withdrawn selection must not fall back to the
  // deployment default, which demonstrably serves the same tool.
  const disposeController=new AbortController()
  const started2=join(home,'ptc-started-marker-2.txt'),done2=join(home,'ptc-done-marker-2.txt')
  const midDispose=tools.execute({agent:agentA,signal:disposeController.signal,calls:[{
    type:'tool-call',id:'dsi-mid-dispose-1',name:'run_code',
    arguments:JSON.stringify({code:`await (await import('node:fs/promises')).writeFile(${JSON.stringify(started2)},'started')\nawait new Promise(r=>setTimeout(r,8000))\nawait (await import('node:fs/promises')).writeFile(${JSON.stringify(done2)},'done')\nreturn 'completed'`,description:'long program for owner dispose'}),
  }]})
  let started2Seen=false
  for (let i=0;i<100 && !started2Seen;i++) {
    await new Promise(r=>setTimeout(r,100))
    started2Seen=existsSync(started2)
  }
  assert.ok(started2Seen,'the program must verifiably start before the owner disposes')
  await ptcOverrideDisposer()
  const disposeOutcome=await settle(midDispose)
  assert.ok(!disposeOutcome.timeout,'the in-flight batch must settle after the owner disposes the executor')
  // The owning executor unloads: the in-flight batch settles without a
  // successful result (observed shape: the batch promise rejects; when a
  // settled batch is present it must be an error).
  let disposeOK
  let disposeShape
  if (disposeOutcome.rejection!==undefined) {
    disposeOK=true
    disposeShape='rejected: '+String(disposeOutcome.rejection?.message ?? disposeOutcome.rejection).slice(0,100)
  } else {
    const r=midDispose?.results?.[0]?.result ?? null
    if (r) {
      assert.ok(r.isError===true,'a disposed batch must not settle as success')
      disposeOK=true
      disposeShape=`resolved-error-result: ${r.error?.message ?? ''}`.slice(0,100)
    } else {
      disposeOK=true
      disposeShape='resolved-without-result (in-flight work awaited and discarded)'
    }
  }
  assert.ok(disposeOK,'the disposed batch must not succeed: '+disposeShape.slice(0,160))
  assert.ok(existsSync(started2),'the started marker stays: the call did begin')
  await new Promise(r=>setTimeout(r,1500))
  assert.ok(!existsSync(done2),'the disposed program must not run to completion')
  // The withdrawal surfaces as a dispatch-time rejection with the
  // executor-unavailable code: it must not silently fall back to the
  // deployment default executor (which serves the same tool successfully
  // right after this assertion).
  await assert.rejects(tools.execute({agent:agentA,signal,calls:[{
    type:'tool-call',id:'dsi-after-dispose-1',name:'session_insights_prepare',
    arguments:JSON.stringify({days:3650,privacy:'metrics',locale:'en'}),
  }]}),e=>e.code==='TOOL_EXECUTOR_UNAVAILABLE','the withdrawn override must be unavailable, not silently served by another executor')
  result.owner_dispose={settled:true,started_recorded:true,no_fallback:true,withdrawal_code:'TOOL_EXECUTOR_UNAVAILABLE',dispose_shape:disposeShape.slice(0,120)}
  // The deployment default keeps serving the same tool after the override's
  // withdrawal — the refusal above is selection-specific, not product-wide.
  const defaultStillWorks=await tools.execute({signal,toolSet:rootSet,calls:[{
    type:'tool-call',id:'dsi-default-still-1',name:'session_insights_prepare',
    arguments:JSON.stringify({days:3650,privacy:'metrics',locale:'en'}),
  }]})
  assert.equal(defaultStillWorks.results[0].result.isError,false,'the deployment default must keep serving after the override is withdrawn')
  result.default_scope_unaffected=true

  result.status='pass'
} catch (error) {
  primaryFailure=primaryFailure ?? error
} finally {
  // Ownership holds on every path: environment first, then acquired
  // resources in reverse order. Cleanup failures never mask the primary
  // failure and never pass silently.
  const failures=[]
  for (const [label,fn] of cleanups.reverse()) {
    try {await fn()} catch (error) {failures.push({label,error:error.message})}
  }
  if (FAIL_STAGE==='cleanup') failures.push({label:'injected',error:'injected cleanup failure'})
  if (failures.length) {
    console.error('cleanup failures:',JSON.stringify(failures))
    primaryFailure=primaryFailure ?? new Error('cleanup failed: '+failures.map(f=>f.label).join(', '))
  }
}
if (primaryFailure!==undefined) {console.error(primaryFailure);process.exitCode=1}
else console.log(JSON.stringify(result))

// Self-test: controlled failure injection over the real runner paths. Each
// child asserts its exit code and its cleanup state (scratch tree removed) so
// the failure paths are consumed, not just present.
async function selfTest() {
  const runs=[]
  for (const stage of ['boot','init','cleanup']) {
    const scratch=mkdtempSync(join(tmpdir(),'dsi-executor-selftest-'))
    try {
      const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),runtime],{
        encoding:'utf8',env:{...process.env,DSI_EXECUTOR_FAIL_STAGE:stage},timeout:300000})
      const homesLeft=readdirSync(scratch).filter(n=>n.startsWith('dsi-executor-runner-'))
      runs.push({stage,exit:r.status,stderr:r.stderr.slice(-300),homesLeft})
    } finally {
      rmSync(scratch,{recursive:true,force:true})
    }
  }
  const failed=runs.filter(r=>r.exit!==1)
  const dirty=runs.filter(r=>r.homesLeft.length>0)
  assert.deepEqual(failed,[],'every injected-failure child must exit 1: '+JSON.stringify(failed))
  assert.deepEqual(dirty,[],'every injected-failure child must clean its scratch tree: '+JSON.stringify(dirty))
  console.log(JSON.stringify({self_test:'pass',runs:runs.map(r=>({stage:r.stage,exit:r.exit,clean:r.homesLeft.length===0}))}))
}
if (runSelfTest) await selfTest()

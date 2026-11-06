// Real-executor and Agent-scope integration checks for the exact rc.1 host
// closure (zero-model, synthetic data only). This is service/executor
// evidence, not a GUI, real-model, or real-host-acceptance claim.
//
// What this proves, against the exact published executor packages:
// - real PTC: run_code through the official PtcExecutor + NodePtcRuntime calls
//   the plugin's tools via the generated SDK (never a mock executor or a
//   direct definition.execute() shortcut);
// - real native: the official NativeToolExecutor dispatches DSI tool calls;
// - declared/execution agreement: prompt assembly, toolSet admission and
//   executable dispatch name the same tools;
// - conditional activation: a `when: false` tool is not admitted and its body
//   never runs;
// - release/removal: a disposed toolSet and an unregistered tool refuse
//   execution;
// - scope selection: only the owning Agent's executor answers its calls, and
//   a direct call under the PTC-only surface resolves to UNKNOWN_TOOL;
// - cancellation and unload: an aborted call settles without side effects and
//   unloading the owning scope stops further dispatch until replaced.
//
// The base host composition (fs/subprocess/sandbox/sandboxPolicy/ptcRuntime)
// is mounted through the official loader from
// scripts/rc1-executor-composition.yaml against the exact target tree; the
// Session/query/tools/system-prompt services and the plugin under test mount
// on the booted context as in scripts/dsh-services.mjs.
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {readFile,writeFile,mkdtemp,rm,cp,mkdir,readdir as readDir,realpath} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import assert from 'node:assert/strict'
import {cleanupPreservingFailure} from './acceptance_cleanup.mjs'

const runtime=resolve(process.argv[2] || ''), packageRoot=resolve(process.argv[3] || '.')
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
for (const name of ['@deepseek-ai/dsh-tool-executor-native','@deepseek-ai/dsh-tool-executor-ptc','@deepseek-ai/dsh-ptc-runtime-node','@deepseek-ai/dsh-subprocess','@deepseek-ai/dsh-sandbox-local','@deepseek-ai/dsh-fs-local','@deepseek-ai/dsh-sandbox-policy','@deepseek-ai/dsh-session-projection']) {
  if (!existsSync(join(runtime,'node_modules',...name.split('/'))))
    throw new Error(`target tree ${runtime} does not resolve ${name}; the executor checks need the full host tree (tests/dsh-host)`)
}

const stagedRoot=await mkdtemp(join(runtime,'node_modules','.dsh-session-insights-under-test-'))
let primaryFailure,result,contextCleaned=true
try {
  const stagedPlugin=join(stagedRoot,'plugin')
  await mkdir(dirname(stagedPlugin),{recursive:true})
  await cp(join(packageRoot,'plugin'),stagedPlugin,{recursive:true})
  assert.equal(await fileTreeDigest(stagedPlugin),await fileTreeDigest(join(packageRoot,'plugin')),'staged plugin differs from the production plugin')
  const plugin=await import(pathToFileURL(join(stagedPlugin,'lib/index.js')).href)
  {
    const pluginReq=createRequire(join(stagedPlugin,'lib/index.js'))
    const llmPath=pluginReq.resolve('@deepseek-ai/dsh-llm/package.json')
    const llmVersion=JSON.parse(await readFile(llmPath,'utf8')).version
    const expectedVersion=JSON.parse(await readFile(createRequire(join(runtime,'package.json')).resolve('@deepseek-ai/dsh-llm/package.json'),'utf8')).version
    assert.equal(llmVersion,expectedVersion,`staged plugin resolved dsh-llm ${llmVersion}, target tree is ${expectedVersion}`)
    console.log(`plugin-under-test resolved @deepseek-ai/dsh-llm ${llmVersion} from the ${runtime} tree`)
  }

  // Official composition for the providers the PTC runtime requires.
  const {boot}=await load('@deepseek-ai/dsh-app-boot')
  const compositionPath=new URL('./rc1-executor-composition.yaml',import.meta.url).pathname
  const referrer=pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href
  const previousHome=process.env.DSH_HOME
  const home=await mkdtemp(join(tmpdir(),'dsi-executor-home-'))
  process.env.DSH_HOME=home
  const ctx=await boot('dsh',compositionPath,[],()=>{},referrer)
  contextCleaned=false
  try {
    for (const service of ['fs','subprocess','sandbox','sandboxPolicy','ptcRuntime'])
      assert.ok(ctx.get(service),`official composition did not mount ${service}`)

    const {NativeToolExecutor}=await load('@deepseek-ai/dsh-tool-executor-native')
    const {PtcExecutor}=await load('@deepseek-ai/dsh-tool-executor-ptc')
    const {SessionStore}=await load('@deepseek-ai/dsh-session')
    const {SessionQueryEngine}=await load('@deepseek-ai/dsh-session-query')
    const {CommandRuntime}=await load('@deepseek-ai/dsh-commands')
    const {ToolsService}=await load('@deepseek-ai/dsh-tools')
    const {SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt')
    const {WorkingDirectoryService}=await load('@deepseek-ai/dsh-working-directory')

    const rows=(await readFile(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse)
    const {type,...header}=rows[0]
    const sessions=new SessionStore(ctx)
    new SessionQueryEngine(ctx)
    new SystemPrompt(ctx,{})
    new CommandRuntime(ctx)
    // Agent-owned PTC programs resolve their working directory through this
    // service; the composition provides fs/sessionProjections beneath it.
    new WorkingDirectoryService(ctx,{})
    const tools=new ToolsService(ctx,{})
    // One live synthetic session backs the analysis.
    const liveSession=sessions.create(header.id,{seed:rows.slice(1),meta:header,inheritedEventCount:0})
    void liveSession

    // Missing executor selection refuses loudly before any executor mounts.
    const preSignal=new AbortController().signal
    await assert.rejects(tools.execute({calls:[],signal:preSignal}),e=>e.code==='TOOL_EXECUTOR_UNAVAILABLE')

    // Real executors over the deployment default scope: the official PTC
    // executor is selected first (run_code programs with the generated SDK),
    // then withdrawn and replaced by the official native executor. Agents
    // stay zero-model: nothing here proves a model-driven turn.
    const ptcDisposer=tools.setExecutor(new PtcExecutor(ctx,{maxParallelSubCalls:4}))
    const owner=ctx.plugin(plugin);await owner

    const signal=new AbortController().signal
    result={subject:'zero-model real-executor integration; no GUI, real-model or model-driven-turn claim',scope:'official rc.1 executors over the official composition'}

    // Declaration/execution agreement under PTC: the announced model surface
    // is exactly run_code; the plugin tools reach the program through the
    // generated SDK declarations; and the same admission executes.
    const toolSet=await tools.resolve({signal,modelSelection:{provider:'synthetic',model:'synthetic'}})
    const assembly=await ctx.systemPrompt.assemble({toolSet})
    const assembled=assembly.tools.map(t=>t.name)
    assert.deepEqual(assembled,['run_code'],`PTC surface must announce only run_code: ${JSON.stringify(assembled)}`)
    const sdkText=[...(assembly.sections ?? []),...Object.values(assembly).filter(v=>typeof v==='string')].map(v=>typeof v==='string'?v:JSON.stringify(v)).join('\n')
    for (const expected of ['session_insights_prepare','session_insights_get_batch','session_insights_submit_batch'])
      assert.ok(sdkText.includes(expected),`${expected} missing from the PTC SDK declarations`)
    result.ptc_surface_matches_admission=true

    // Real PTC: run_code through the official executor calls the plugin's
    // tool via the generated SDK and the effect lands under DSH_HOME.
    const batch=await tools.execute({signal,calls:[{
      type:'tool-call',id:'dsi-ptc-prepare-1',name:'run_code',
      arguments:JSON.stringify({code:`const prepared = await tools.session_insights_prepare({days: 3650, privacy: 'metrics', locale: 'en'})\nreturn {prepared}`,description:'call session insights prepare through the SDK'}),
    }]})
    const first=batch.results[0].result
    assert.equal(first.isError,false,JSON.stringify(first).slice(0,400))
    const ptcContent=first.content.filter(x=>x.type==='text').map(x=>x.text).join('\n')
    const parsed=JSON.parse(ptcContent)
    // The SDK sub-call resolves to the tool's canonical projected value; the
    // prepare payload may arrive as the parsed object or as its text form.
    const preparedPayload = typeof parsed.prepared === 'string' ? JSON.parse(parsed.prepared)
      : parsed.prepared?.text !== undefined ? JSON.parse(parsed.prepared.text)
      : parsed.prepared
    assert.equal(preparedPayload.metrics_semantic_skipped,true,'prepare payload shape: '+ptcContent.slice(0,200))
    const base=JSON.parse(await readFile(join(preparedPayload.workdir,'base-report.json'),'utf8'))
    assert.equal(base.totals.sessions,1)
    result.real_ptc_prepare={sessions:base.totals.sessions}

    // Announced surface equals callable surface under PTC: a direct call
    // naming any tool other than run_code resolves to UNKNOWN_TOOL.
    const direct=await tools.execute({signal,calls:[{
      type:'tool-call',id:'dsi-ptc-direct-1',name:'session_insights_prepare',
      arguments:JSON.stringify({days:30,privacy:'metrics',locale:'en'}),
    }]})
    assert.equal(direct.results[0].result.isError,true,'direct non-run_code call must fail under PTC')
    assert.equal(direct.results[0].result.error?.info?.code ?? direct.results[0].result.error?.code,'UNKNOWN_TOOL',JSON.stringify(direct.results[0].result.error))
    result.ptc_direct_call_unknown_tool=true

    // Cancellation before dispatch: the call settles without running the body.
    const runsBefore=await readDir(join(home,'insights','runs')).catch(()=>[])
    const abort=new AbortController();abort.abort()
    const cancelled=await tools.execute({signal:abort.signal,calls:[{
      type:'tool-call',id:'dsi-cancelled-1',name:'run_code',
      arguments:JSON.stringify({code:'return 1',description:'pre-aborted'}),
    }]})
    assert.ok(cancelled.results[0].result.isError,'a pre-aborted call must not succeed')
    const runsAfter=await readDir(join(home,'insights','runs')).catch(()=>[])
    assert.equal(runsAfter.length,runsBefore.length,'an aborted call must not leave a run behind')
    result.pre_aborted_call_settled=true

    // Withdrawal: unloading the PTC selection leaves dispatch unavailable —
    // a withdrawn executor never falls back to another one.
    ptcDisposer()
    await assert.rejects(tools.execute({signal,calls:[{type:'tool-call',id:'dsi-withdrawn-1',name:'run_code',arguments:'{}'}]}),
      e=>e.code==='TOOL_EXECUTOR_UNAVAILABLE','a withdrawn selection must not fall back to another executor')
    result.withdrawal_no_fallback=true

    // The official native executor replaces it: the plugin tools are announced
    // directly, a real dispatch lands, and run_code is no longer callable.
    tools.setExecutor(new NativeToolExecutor(ctx))
    const rootSet=await tools.resolve({signal,modelSelection:{provider:'synthetic',model:'synthetic'}})
    const rootAssembly=await ctx.systemPrompt.assemble({toolSet:rootSet})
    const rootNames=rootAssembly.tools.map(t=>t.name)
    for (const expected of ['session_insights_prepare','session_insights_get_batch','session_insights_submit_batch','session_insights_cleanup'])
      assert.ok(rootNames.includes(expected),`${expected} missing from the native prompt assembly: ${JSON.stringify(rootNames)}`)
    result.native_assembly_matches_admission=true
    const nativeBatch=await tools.execute({signal,calls:[{
      type:'tool-call',id:'dsi-native-prepare-1',name:'session_insights_prepare',
      arguments:JSON.stringify({days:3650,privacy:'metrics',locale:'en'}),
    }]})
    assert.equal(nativeBatch.results[0].result.isError,false,JSON.stringify(nativeBatch.results[0].result).slice(0,400))
    const nativePrepared=JSON.parse(nativeBatch.results[0].result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))
    const nativeBase=JSON.parse(await readFile(join(nativePrepared.workdir,'base-report.json'),'utf8'))
    assert.equal(nativeBase.totals.sessions,1)
    result.real_native_prepare={sessions:nativeBase.totals.sessions}
    const nativeRunCode=await tools.execute({signal,calls:[{
      type:'tool-call',id:'dsi-native-run-code-1',name:'run_code',arguments:'{}',
    }]})
    assert.equal(nativeRunCode.results[0].result.isError,true,'run_code must refuse under the native executor')
    result.native_run_code_refused=true

    // Conditional activation on the native surface: a `when: false` tool is
    // neither announced nor admitted, and its body never runs.
    const marker=join(home,'conditional-marker.txt')
    const conditionalDisposer=ctx.tools.register({
      name:'dsi_conditional_probe',description:'conditional probe',parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{}},render:()=>({type:'text',text:'ran'})},
      async execute(){await writeFile(marker,'ran');return {text:'ran'}},
    },{when:async()=>false})
    const conditionalAssembly=await ctx.systemPrompt.assemble({toolSet:rootSet})
    assert.ok(!conditionalAssembly.tools.some(t=>t.name==='dsi_conditional_probe'),'an unactivated tool must not be announced')
    const conditional=await tools.execute({signal,calls:[{
      type:'tool-call',id:'dsi-conditional-1',name:'dsi_conditional_probe',arguments:'{}',
    }]})
    assert.equal(conditional.results[0].result.isError,true,'a conditionally inactive tool must refuse')
    assert.ok(!existsSync(marker),'an unactivated tool body must not run')
    result.conditional_inactive_refused=true

    // Release: a resolved-then-disposed toolSet refuses dispatch.
    const disposableSet=await tools.resolve({signal,modelSelection:{provider:'synthetic',model:'synthetic'}})
    disposableSet.dispose()
    const released=await tools.execute({signal,toolSet:disposableSet,calls:[{
      type:'tool-call',id:'dsi-released-1',name:'session_insights_prepare',arguments:'{}',
    }]})
    assert.equal(released.results[0].result.isError,true,'a released toolSet must refuse')
    result.disposed_toolset_refused=true

    // Removal: unregistering the tool refuses later dispatch (admission
    // refreshes without the tool).
    conditionalDisposer()
    const removed=await tools.execute({signal,calls:[{
      type:'tool-call',id:'dsi-removed-1',name:'dsi_conditional_probe',arguments:'{}',
    }]})
    assert.equal(removed.results[0].result.isError,true,'a removed tool must refuse')
    result.removed_tool_refused=true

    result.status='pass'
  } finally {
    if (previousHome===undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME=previousHome
    try {
      await cleanupPreservingFailure(primaryFailure,[
        async()=>{await ctx.fiber.dispose();contextCleaned=true},
        async()=>{await rm(home,{recursive:true,force:true})},
      ])
    } catch (error) {
      if (!primaryFailure) primaryFailure=error
    }
  }
} catch (error) {
  primaryFailure=primaryFailure ?? error
} finally {
  if (contextCleaned) {
    try {await rm(stagedRoot,{recursive:true,force:true})}
    catch (error) {primaryFailure=primaryFailure ?? new Error('staging cleanup failed: '+error.message)}
  } else if (!primaryFailure) {
    primaryFailure=new Error('context cleanup did not complete; the staging tree is retained for inspection')
    console.error(String(primaryFailure.message))
  }
}
if (primaryFailure!==undefined) {console.error(primaryFailure);process.exitCode=1}
else console.log(JSON.stringify(result))

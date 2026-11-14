// Isolated Desktop report preparation/readback. This runner never starts the
// GUI: the platform owner launches and observes the official Desktop separately.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFile,writeFile,mkdir,rm,readdir,realpath,stat} from 'node:fs/promises'
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {run,digest,fileManifest,HOST_TARGETS} from './acceptance_identity.mjs'
import {verifyCanonicalArtifact} from './canonical_artifact.mjs'
import {captureSourceLogs,compareSourceLogs,sessionWitnessScope,witnessGate} from './source_log_witness.mjs'

const source=fileURLToPath(new URL('../',import.meta.url))
const SHA=/^[0-9a-f]{64}$/, COMMIT=/^[0-9a-f]{40}$/
const ids=['gui082-target','gui082-unrelated']
export const DESKTOP_ISOLATION_OVERLAY='- id: hmr\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- id: mcp-manager\n  disabled: true\n'
const usage='prepare --output DIR --artifact-dir DIR --commit SHA --tgz-sha256 SHA --receipt-sha256 SHA --desktop-package PATH --desktop-cli PATH | finalize --output DIR'
function parse(argv) {
  if(argv.length===1&&argv[0]==='--help')return {help:true}
  const [mode,...rest]=argv
  if(!['prepare','finalize'].includes(mode)||rest.length%2)throw new Error(usage)
  const allowed=mode==='prepare'?['output','artifact-dir','commit','tgz-sha256','receipt-sha256','desktop-package','desktop-cli']:['output']
  const values={}
  for(let i=0;i<rest.length;i+=2){const flag=rest[i];if(!flag.startsWith('--'))throw new Error(usage);const key=flag.slice(2);if(!allowed.includes(key)||values[key]!==undefined||!rest[i+1]||rest[i+1].startsWith('--'))throw new Error(usage);values[key]=rest[i+1]}
  if(allowed.some(key=>!values[key]))throw new Error(usage)
  if(mode==='prepare'&&(!COMMIT.test(values.commit)||!SHA.test(values['tgz-sha256'])||!SHA.test(values['receipt-sha256'])))throw new Error('independent artifact identities required')
  return {mode,...values}
}
const safeWrite=(path,data)=>writeFile(path,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600})
export function redactOutput(value){return String(value).replace(/([?&](?:token|access_token|key)=)[^&\s"']+/gi,'$1<redacted>').replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer <redacted>')}
export function protectOutput(){
  for(const stream of [process.stdout,process.stderr]){
    const write=stream.write.bind(stream)
    let pending='',discarding=false
    stream.write=(chunk,encoding,callback)=>{
      if(typeof encoding==='function')callback=encoding
      let text=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk)
      while(text.length){
        const end=text.indexOf('\n'),part=end<0?text:text.slice(0,end)
        if(!discarding){
          pending+=part
          if(pending.length>65536){write('[oversized output omitted]\n');pending='';discarding=true}
        }
        if(end<0)break
        if(!discarding)write(redactOutput(pending)+'\n')
        pending='';discarding=false;text=text.slice(end+1)
      }
      if(typeof callback==='function')queueMicrotask(callback)
      return true
    }
    process.once('beforeExit',()=>{if(pending&&!discarding)write(redactOutput(pending));pending=''})
  }
}
const hostContext=async (desktopPackage,desktopCli)=>{
  if(!process.versions.electron||process.env.ELECTRON_RUN_AS_NODE!=='1')throw new Error('official Desktop Electron node entry required')
  const pkg=resolve(desktopPackage),root=dirname(pkg)
  assert.match(pkg.replaceAll('\\','/'),/\/app\.asar\/dsh\/package\.json$/)
  const cli=join(root,'node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js')
  assert.equal(resolve(desktopCli),cli,'CLI must belong to same official Desktop carrier')
  const meta=JSON.parse(await readFile(pkg,'utf8'))
  assert.equal(meta.name,'@deepseek-ai/dsh-desktop-runtime');assert.equal(meta.version,HOST_TARGETS.primary)
  await stat(cli)
  const req=createRequire(pkg)
  const host=JSON.parse(await readFile(req.resolve('@deepseek-ai/dsh/package.json'),'utf8'))
  assert.equal(host.name,'@deepseek-ai/dsh');assert.equal(host.version,HOST_TARGETS.primary)
  const load=async name=>import(pathToFileURL(req.resolve(name)).href)
  for(const [name,key] of [['@deepseek-ai/dsh/profile-boot','runProfile'],['@deepseek-ai/dsh-app-boot','initProfile'],['@deepseek-ai/dsh-official-bundles','PROFILE_TEMPLATES'],['@deepseek-ai/dsh-session-persistence-jsonl','apply'],['@deepseek-ai/dsh-session-format-catalog','sessionFormatCatalog'],['@deepseek-ai/dsh-launch-environment','createLaunchEnvironmentSnapshot'],['@deepseek-ai/dsh-home-paths','resolveDshHome'],['@deepseek-ai/dsh-home-paths','resolveAgentsHome'],['@deepseek-ai/cordis','Context']])
    assert.ok(key in await load(name),`official Desktop module missing required export: ${name}`)
  return {pkg,cli,load,meta}
}
const artifactAt=async (artifactDir,expected)=>{
  const receiptPath=join(artifactDir,'artifact.json'),proposed=JSON.parse(await readFile(receiptPath,'utf8'))
  assert.equal(typeof proposed.filename,'string');assert.equal(basename(proposed.filename),proposed.filename)
  const tarballPath=join(artifactDir,proposed.filename)
  const {receipt}=await verifyCanonicalArtifact({receiptPath,tarballPath,sourceRoot:source,expectedCommit:expected.commit,expectedSha256:expected.tgz,expectedReceiptSha256:expected.receipt})
  return {receipt,tarballPath}
}
export const privateEnv=async out=>{
  const userConfig=join(out,'empty-user-npmrc'),globalConfig=join(out,'empty-global-npmrc')
  await writeFile(userConfig,'',{flag:'wx',mode:0o600});await writeFile(globalConfig,'',{flag:'wx',mode:0o600})
  // The child gets only ordinary OS launch variables. Never copy inherited
  // credentials or arbitrary npm/profile settings into an acceptance host.
  const env={}
  for(const key of ['PATH','HOME','TMPDIR','TMP','TEMP','SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','PATHEXT','USERPROFILE','LANG','LC_ALL'])
    if(process.env[key]!==undefined)env[key]=process.env[key]
  Object.assign(env,{DSH_HOME:join(out,'qa-home'),DSH_AGENTS_HOME:join(out,'qa-agents'),DSH_TELEMETRY_DISABLED:'1',ELECTRON_RUN_AS_NODE:'1',npm_config_cache:join(out,'npm-cache'),npm_config_store_dir:join(out,'pnpm-store'),npm_config_userconfig:userConfig,npm_config_globalconfig:globalConfig})
  delete env.NODE_OPTIONS
  return env
}
const fixture=async (sourceRoot,load,name,id,cwd)=>{
  const {sessionFormatCatalog}=await load('@deepseek-ai/dsh-session-format-catalog')
  const rows=(await readFile(join(sourceRoot,'tests/fixtures/rc2-repairs',name,'session.v4.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
  const delta=Date.now()-60000-rows[0].createdAt;rows[0].id=id;rows[0].cwd=cwd;rows[0].createdAt+=delta
  for(const row of rows.slice(1))row.time+=delta
  const restore=sessionFormatCatalog.createRestore(rows[0],{recovery:'strict',validation:'current'})
  for(const row of rows.slice(1))restore.decodeRow(row)
  return restore.finish()
}
// Shared failure cleanup: never remove a tree when the isolated host's
// shutdown failed; its files may still be in use. Retain a terminal outcome.
export async function cleanupFailedPreparation(home,app,{remove=rm,shutdownAlreadyFailed=false}={}){
  if(shutdownAlreadyFailed)return 'retained_shutdown_failed'
  if(app)try{await app.shutdown.shutdown(0)}catch{return 'retained_shutdown_failed'}
  try{await remove(home,{recursive:true,force:true});return 'removed'}catch{return 'retained_cleanup_failed'}
}

// Official profile boot and plugins resolve these roots from the current
// process, independently of the launch-environment snapshot and child env.
// Enter the task roots before importing carrier modules, and restore the caller
// even when boot, assertion, session writes, or shutdown fails.
export async function withIsolatedDesktopEnv({home,agentsHome,project},action){
  home=await realpath(home);agentsHome=await realpath(agentsHome);project=await realpath(project)
  const keys=['DSH_HOME','DSH_AGENTS_HOME','DSH_TELEMETRY_DISABLED']
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]])),cwd=process.cwd()
  try{
    process.chdir(project)
    process.env.DSH_HOME=home;process.env.DSH_AGENTS_HOME=agentsHome;process.env.DSH_TELEMETRY_DISABLED='1'
    return await action()
  }finally{
    for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]
    process.chdir(cwd)
  }
}

export function assertSanitizedProcessEnv(){
  // Check names only; do not read or retain any credential values. A clean
  // environment is supplied by the platform owner when launching this runner.
  assert.equal(Object.keys(process.env).some(key=>/(^|_)(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)(_|$)/i.test(key)),false,'credential-like environment present; launch in a sanitized environment')
}
export function assertDesktopEnvironment({home,agentsHome,project,resolveDshHome,resolveAgentsHome}){
  assertSanitizedProcessEnv()
  assert.equal(process.env.DSH_HOME,home);assert.equal(process.env.DSH_AGENTS_HOME,agentsHome)
  assert.equal(process.env.DSH_TELEMETRY_DISABLED,'1');assert.equal(process.cwd(),project)
  assert.equal(resolveDshHome(),home);assert.equal(resolveAgentsHome(),agentsHome)
}

// This guard is invoked immediately after boot and before create/append. A
// missing or unsupported persistence root is failure, never assumed isolated.
export function assertDesktopBeforeSessionWrite({home,project,context}){
  const profile=context?.get('profileContext')
  assert.ok(profile);assert.equal(profile.home,home)
  assert.equal(profile.dir,join(home,'profiles','web'))
  assert.equal(profile.cwd,project)
  assert.ok(profile.startedBundles?.includes('dsh-session-insights'),'isolated candidate bundle not loaded')
  assert.equal(context.get('mcpManager')==null,true,'external MCP manager must be disabled')
  const persistence=context.get('sessionPersistence')
  assert.equal(typeof persistence?.root,'string','actual persistence root unavailable')
  assert.equal(resolve(persistence.root),join(home,'sessions'),'persistence root outside isolated home')
  // Cordis supplies trace proxies, so two lookups need not have reference
  // equality. Return the checked service and use exactly that writer below.
  return persistence
}

export async function persistIsolatedFixtures({home,project,context,entries,buildSnapshot}){
  const persistence=assertDesktopBeforeSessionWrite({home,project,context})
  for(const entry of entries){
    const snapshot=await buildSnapshot(entry)
    const handle=await persistence.create(snapshot.header,{inheritedEventCount:snapshot.inheritedEventCount})
    try{await handle.append(snapshot.events);await handle.flush()}finally{await handle.close()}
  }
}
async function prepare(o){
  assertSanitizedProcessEnv()
  const output=resolve(o.output)
  await mkdir(output,{mode:0o700}) // Existing outputs and earlier receipts remain untouched.
  const out=await realpath(output),home=join(out,'qa-home'),agentsHome=join(out,'qa-agents'),project=join(out,'project'),other=join(out,'unrelated')
  let app,shutdownFailed=false,prepared=false,cleanupResult=null,operationStage='artifact_identity'
  try{
    assertSanitizedProcessEnv()
    const expected={commit:o.commit,tgz:o['tgz-sha256'],receipt:o['receipt-sha256']}
    const artifactDir=resolve(o['artifact-dir']),{receipt,tarballPath}=await artifactAt(artifactDir,expected)
    await mkdir(home,{mode:0o700});await mkdir(agentsHome,{mode:0o700});await mkdir(project);await mkdir(other)
    const state=await withIsolatedDesktopEnv({home,agentsHome,project},async()=>{
     try{
    assertSanitizedProcessEnv()
    operationStage='carrier_identity'
    const carrier=await hostContext(o['desktop-package'],o['desktop-cli'])
    const paths=await carrier.load('@deepseek-ai/dsh-home-paths')
    assertDesktopEnvironment({home,agentsHome,project,...paths})
    const env=await privateEnv(out)
    const {initProfile}=await carrier.load('@deepseek-ai/dsh-app-boot')
    const {PROFILE_TEMPLATES}=await carrier.load('@deepseek-ai/dsh-official-bundles')
    initProfile(join(home,'profiles','desktop'),PROFILE_TEMPLATES.web.bundles)
    initProfile(join(home,'profiles','web'),PROFILE_TEMPLATES.web.bundles)
    // Electron's node mode is the official desktop-host CLI used by the
    // application wrapper; the user data and DSH_HOME are task-owned.
    // The headless preparation boots an isolated Web profile with the
    // Desktop patch. The package must resolve in both profile roots; the
    // Desktop installation alone cannot satisfy Web's dependency resolution.
    for(const profile of ['desktop','web']){
      operationStage=`install_${profile}`
      await run(process.execPath,['--expose-internals',carrier.cli,'plugin','--profile',profile,'add',tarballPath],{env,cwd:project,timeout:180000,maxBuffer:8*1024*1024})
      const ownReq=createRequire(join(home,'profiles',profile,'package.json'))
      const installed=dirname(await realpath(ownReq.resolve('dsh-session-insights/package.json')))
      assert.deepEqual(await fileManifest(installed),receipt.files)
      assert.equal(JSON.parse(await readFile(join(installed,'package.json'),'utf8')).gitHead,expected.commit)
    }
    const {runProfile}=await carrier.load('@deepseek-ai/dsh/profile-boot')
    const {createLaunchEnvironmentSnapshot}=await carrier.load('@deepseek-ai/dsh-launch-environment')
    const overlay=join(out,'synthetic.patch.yml')
    await writeFile(overlay,DESKTOP_ISOLATION_OVERLAY,{flag:'wx',mode:0o600})
    operationStage='isolated_boot'
    app=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:{DSH_HOME:home,DSH_AGENTS_HOME:agentsHome,DSH_TELEMETRY_DISABLED:'1'}}]),profile:'web',patchFiles:[join(home,'profiles','desktop','cordis.patch.yml'),overlay],args:['--no-open','--host','127.0.0.1','--port','0']})
    operationStage='isolation_guard_and_fixtures'
    assertDesktopEnvironment({home,agentsHome,project,...paths})
    await persistIsolatedFixtures({home,project,context:app.ctx,entries:[['recovery-mixed-group',ids[0],project],['optional-isError',ids[1],other]],buildSnapshot:([name,id,cwd])=>fixture(source,carrier.load,name,id,cwd)})
    operationStage='isolated_shutdown'
    try{await app.shutdown.shutdown(0)}catch(error){shutdownFailed=true;throw error}
    app=null
    operationStage='source_capture'
    const before=await captureSourceLogs(join(home,'sessions'),{label:'desktop-source-logs:before'})
    await safeWrite(join(out,'source-log-before-unscoped.json'),before)
    operationStage='source_scope'
    const scope=sessionWitnessScope(before,ids)
    const baseline=Buffer.from(JSON.stringify({before,scope},null,2)+'\n')
    await writeFile(join(out,'source-log-before.json'),baseline,{flag:'wx',mode:0o600})
    const command=`/session-insights --days 30 --project ${JSON.stringify(project)} --locale en --deterministic --no-open`
    return {schema:'dsi-desktop-isolated/v1',status:'prepared_not_gui_accepted',output:out,artifact_dir:artifactDir,expected,desktop_package:carrier.pkg,desktop_cli:carrier.cli,desktop_binary_sha256:digest(await readFile(process.execPath)),runner_sha256:digest(await readFile(fileURLToPath(import.meta.url))),host_version:carrier.meta.version,project,command,ids,before_sha256:digest(baseline),gui_observed:false,model_requests:0}
     }catch(error){
       // Keep the isolated process environment until the task host is stopped.
       cleanupResult=await cleanupFailedPreparation(home,app,{shutdownAlreadyFailed:shutdownFailed});app=null
       throw error
     }
    })
    await safeWrite(join(out,'prepared.json'),state)
    prepared=true
    console.log(JSON.stringify({status:state.status,prepared_sha256:digest(await readFile(join(out,'prepared.json'))),command:state.command,home,agents_home:agentsHome,user_data_dir:join(out,'qa-userdata')}))
  }catch(error){
    // Preserve a potentially live tree. Otherwise remove only our own failed
    // isolated tree, retaining the failure receipt and any non-secret output.
    const cleanup=cleanupResult??await cleanupFailedPreparation(home,app,{shutdownAlreadyFailed:shutdownFailed})
    app=null
    // This is a private developer trace for the credential-free synthetic
    // runner, separate from bounded annex diagnostics and never a release asset.
    await writeFile(join(out,'developer-trace.private.txt'),redactOutput(String(error.stack??error)),{flag:'wx',mode:0o600})
    const origin=String(error.stack??'').match(/\b(desktop_acceptance|source_log_witness)\.mjs:(\d+):(\d+)/)
    await safeWrite(join(out,'prepare-failed.json'),{status:'failed',stage:'prepare',operation_stage:operationStage,source_origin:origin?{module:origin[1],line:Number(origin[2]),column:Number(origin[3])}:null,error_name:error.name??'Error',error_code:error.code??null,cleanup,gui_observed:false})
    throw error
  }finally{if(app&&!prepared)try{await app.shutdown.shutdown(0)}catch{}}
}
function contained(path,root){const rel=relative(root,path);return rel!==''&&!isAbsolute(rel)&&!rel.startsWith('..'+sep)&&rel!=='..'}
async function finalize(o){
  assertSanitizedProcessEnv()
  const out=await realpath(resolve(o.output))
  for(const name of ['finalized.json','source-log-result.json','gui-report.json','gui-report.html'])await assert.rejects(stat(join(out,name)),{code:'ENOENT'})
  const preparedBytes=await readFile(join(out,'prepared.json'))
  const prepared=JSON.parse(preparedBytes.toString('utf8'))
  assert.equal(prepared.schema,'dsi-desktop-isolated/v1');assert.equal(prepared.status,'prepared_not_gui_accepted');assert.equal(prepared.output,out)
  const home=join(out,'qa-home'),agentsHome=join(out,'qa-agents'),project=join(out,'project')
  assert.equal(prepared.project,project)
  const result={schema:'dsi-desktop-isolated-result/v1',status:'failed',prepared_sha256:digest(preparedBytes),artifact_commit:prepared.expected.commit,artifact_sha256:prepared.expected.tgz,host:prepared.host_version,gui_observation:'not_asserted_by_runner',operation:{status:'not_run'},source_logs:{status:'not_run'},cleanup:{status:'not_run',note:'owner controls GUI process and task tree'},errors:[]}
  let baseline,after,comparison,gate,ctx
  try{
    assertSanitizedProcessEnv()
    const beforeBytes=await readFile(join(out,'source-log-before.json'));assert.equal(digest(beforeBytes),prepared.before_sha256)
    baseline=JSON.parse(beforeBytes.toString('utf8'))
    assert.equal(resolve(baseline.before.root),join(out,'qa-home','sessions'))
    assert.deepEqual(sessionWitnessScope(baseline.before,ids),baseline.scope)
    assert.equal(digest(await readFile(fileURLToPath(import.meta.url))),prepared.runner_sha256,'acceptance runner changed after preparation')
    const {receipt}=await artifactAt(prepared.artifact_dir,prepared.expected)
    await withIsolatedDesktopEnv({home,agentsHome,project},async()=>{
     try{
    assertSanitizedProcessEnv()
    const carrier=await hostContext(prepared.desktop_package,prepared.desktop_cli)
    const paths=await carrier.load('@deepseek-ai/dsh-home-paths')
    assertDesktopEnvironment({home,agentsHome,project,...paths})
    assert.equal(digest(await readFile(process.execPath)),prepared.desktop_binary_sha256)
    const installed=dirname(await realpath(createRequire(join(out,'qa-home','profiles','desktop','package.json')).resolve('dsh-session-insights/package.json')))
    assert.deepEqual(await fileManifest(installed),receipt.files)
    const {Context}=await carrier.load('@deepseek-ai/cordis')
    const jsonl=await carrier.load('@deepseek-ai/dsh-session-persistence-jsonl')
    ctx=new Context();await jsonl.apply(ctx,{root:join(out,'qa-home','sessions'),compression:'zstd'})
    assert.equal(resolve(ctx.sessionPersistence.root),join(home,'sessions'))
    const matches=[]
    for(const item of await ctx.sessionPersistence.list()){
      if(ids.includes(item.header.id))continue
      const handle=await ctx.sessionPersistence.open(item.header.id,'read')
      let slice
      try{slice=await handle.read(0)}finally{await handle.close()}
      const events=slice.events??slice
      for(const event of events.filter(e=>e.type==='command/run'&&e.data?.name==='session-insights'&&typeof e.data.args==='string'&&e.data.args.includes(JSON.stringify(prepared.project))&&e.data.args.includes('--deterministic')&&e.data.args.includes('--no-open'))){
        const done=events.find(e=>e.type==='command/done'&&e.data?.commandId===event.data.commandId&&e.seq>event.seq)
        if(done)matches.push({run:event,done,driver:item.header.id})
      }
    }
    assert.equal(matches.length,1,'one matching persisted command pair required')
    const match=matches[0];assert.equal(match.done.data.kind,'success')
    const html=await realpath(resolve(match.done.data.text))
    const runRoot=await realpath(join(out,'qa-home','insights','runs'))
    assert.ok(contained(html,runRoot)&&basename(html).endsWith('.html'),'report must be inside isolated run root')
    const htmlBytes=await readFile(html);assert.ok(htmlBytes.length>0)
    const jsonNames=(await readdir(dirname(html))).filter(n=>n.includes('report')&&n.endsWith('.json'))
    assert.equal(jsonNames.length,1)
    const jsonPath=await realpath(join(dirname(html),jsonNames[0]));assert.ok(contained(jsonPath,runRoot))
    const reportBytes=await readFile(jsonPath),report=JSON.parse(reportBytes.toString('utf8'))
    assert.equal(report.schema,'dsh-session-insights/1');assert.ok(report.totals.sessions>0)
    const anon=id=>'rollout-'+createHash('sha256').update(id).digest('hex').slice(0,12)
    const reportIds=(report.session_summaries??[]).map(x=>x.rollout_id)
    assert.ok(reportIds.includes(anon(ids[0])));assert.ok(!reportIds.includes(anon(ids[1])))
    // Retain and read back the exact report bytes before any owner-directed
    // disposal of the isolated home. Files are private and never overwritten.
    await writeFile(join(out,'gui-report.json'),reportBytes,{flag:'wx',mode:0o600})
    await writeFile(join(out,'gui-report.html'),htmlBytes,{flag:'wx',mode:0o600})
    assert.equal(digest(await readFile(join(out,'gui-report.json'))),digest(reportBytes))
    assert.equal(digest(await readFile(join(out,'gui-report.html'))),digest(htmlBytes))
    result.operation={status:'passed',command_id:match.run.data.commandId,driver:match.driver,report_json_sha256:digest(reportBytes),report_html_sha256:digest(htmlBytes),sessions:report.totals.sessions,target_selected:true,unrelated_excluded:true}
     }finally{
      if(ctx)try{await ctx.fiber.dispose()}catch(error){result.errors.push({stage:'reader_dispose',name:error.name??'Error',code:error.code??null})}
      ctx=null
     }
    })
  }catch(error){result.operation={status:'failed'};result.errors.push({stage:'operation',name:error.name??'Error',code:error.code??null})}
  finally{
    if(ctx)try{await ctx.fiber.dispose()}catch(error){result.errors.push({stage:'reader_dispose',name:error.name??'Error',code:error.code??null})}
    try{
      if(!baseline)throw new Error('before-capture unavailable or invalid')
      after=await captureSourceLogs(join(out,'qa-home','sessions'),{label:'desktop-source-logs:after'})
      comparison=compareSourceLogs(baseline.before,after)
      gate=witnessGate('source_log_witness',baseline.before,after,comparison,{scope:baseline.scope})
      const evidence=Buffer.from(JSON.stringify({before:baseline.before,after,scope:baseline.scope,comparison,gate},null,2)+'\n')
      await writeFile(join(out,'source-log-result.json'),evidence,{flag:'wx',mode:0o600})
      result.source_logs={status:gate.status,evidence_sha256:digest(evidence)}
    }catch(error){result.source_logs={status:'failed'};result.errors.push({stage:'source_logs',name:error.name??'Error',code:error.code??null})}
    result.status=result.operation.status==='passed'&&result.source_logs.status==='passed'&&result.errors.length===0?'report_verified_gui_unobserved':'failed'
    await safeWrite(join(out,'finalized.json'),result)
  }
  console.log(JSON.stringify({status:result.status,operation:result.operation.status,source_logs:result.source_logs.status,gui_observation:result.gui_observation}))
  if(result.status==='failed')process.exitCode=1
}
async function main(){
  protectOutput()
  const o=parse(process.argv.slice(2))
  if(o.help){console.log(usage);return}
  if(o.mode==='prepare')await prepare(o);else await finalize(o)
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(()=>{console.error(JSON.stringify({status:'failed',stage:'input_or_prepare'}));process.exitCode=1})

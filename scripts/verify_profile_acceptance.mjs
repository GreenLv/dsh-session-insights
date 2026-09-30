import {createRequire} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {readFile,writeFile,mkdir,mkdtemp,rm,readdir,realpath,stat,cp} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import assert from 'node:assert/strict'
import {run,digest,fileManifest} from './acceptance_identity.mjs'
// The Web host prints a scratch access URL during boot. Keep its token out of
// tool output and retained acceptance logs.
const originalStdoutWrite=process.stdout.write.bind(process.stdout)
process.stdout.write=(chunk,...args)=>originalStdoutWrite(
 typeof chunk==='string'||Buffer.isBuffer(chunk)
  ? chunk.toString().replace(/([?&]token=)[^&\s]+/g,'$1<redacted>')
  : chunk,...args)
const base=resolve(process.argv[2] || ''), hostRoot=resolve(process.argv[3] || '')
const profile=process.argv[4] || 'web'
if(!process.argv[2] || !process.argv[3] || !['web','headless'].includes(profile))throw new Error('artifact directory, official CLI runtime root, web|headless required')
const source=fileURLToPath(new URL('../',import.meta.url))
const {inspectRuntime}=await import('./acceptance_identity.mjs')
const canonical=JSON.parse(await readFile(join(base,'artifact.json'),'utf8'))
const tgz=join(base,canonical.filename)
const work=await mkdtemp(join(base,'macos-native-')),home=join(work,'dsh-home'),project=join(work,'中文 项目 目录')
await mkdir(home,{mode:0o700});await mkdir(project)
process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1';process.chdir(project)
const hostManifest=await realpath(join(hostRoot,'node_modules/@deepseek-ai/dsh/package.json'))
const req=createRequire(hostManifest),load=async n=>import(pathToFileURL(req.resolve(n)).href)
const {runProfile}=await load('@deepseek-ai/dsh/profile-boot')
const {createLaunchEnvironmentSnapshot}=await load('@deepseek-ai/dsh-launch-environment')
const {sessionFormatCatalog}=await load('@deepseek-ai/dsh-session-format-catalog')
const tools=['session_insights_prepare','session_insights_get_batch','session_insights_submit_batch','session_insights_get_aggregate','session_insights_submit_aggregate','session_insights_finalize','session_insights_cleanup']
const output=join(base,`${profile}-native-results`);await mkdir(output,{recursive:true,mode:0o700})
const annex={schema:'native-acceptance/v2',status:'failed',product:'dsh-session-insights',gate_profile:`actual-${profile}-host`,repository:{url:canonical.repository,commit:canonical.commit},runtime_tree_sha256:null,artifact:{filename:canonical.filename,sha256:canonical.sha256,size_bytes:canonical.size_bytes,file_count:canonical.file_count,git_head:canonical.commit},platform:{os:process.platform==='win32'?'windows':'macos',shell:process.platform==='win32'?'pwsh':'posix',toolchain:{node:process.version,architecture:process.arch,dsh:'0.2.0-rc.2'}},gates:[],cleanup:{status:'not_run',remaining_ids:[]},run:{started_at:new Date().toISOString(),finished_at:'',run_url:null},unperformed_actions:['commit','push','merge','tag','package_publish','release','public_promotion']}
let app,owner,currentGate='artifact_digest',failure
const record=(id,note,subject={kind:'artifact',id:canonical.sha256})=>{annex.gates.push({id,required:true,status:'passed',subject,exit_code:0,note,evidence:{mode:'executed',source_result_sha256:null,source_gate_id:null,invalidation_reason:null}});console.log(JSON.stringify({gate:id,status:'passed'}))}
const begin=id=>{currentGate=id}
const env={...process.env,npm_config_cache:join(work,'npm-cache'),npm_config_store_dir:join(work,'pnpm-store'),XDG_CACHE_HOME:join(work,'cache'),XDG_DATA_HOME:join(work,'data')}
const cli=async args=>run(process.execPath,[join(dirname(hostManifest),'lib/bin.js'),'plugin','--profile',profile,...args],{env,cwd:project,timeout:180000,maxBuffer:8*1024*1024})
const overlay=join(work,'native.patch.yml')
await writeFile(overlay,'- id: hmr\n  disabled: true\n- id: session-title-llm\n  disabled: true\n'+(profile==='headless'?'- id: headless-runner\n  disabled: true\n':''))
const boot=()=>runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:{DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'}}]),profile,patchFiles:[overlay],args:profile==='web'?['--no-open','--host','127.0.0.1','--port','0']:[]})
const fixture=async(name,id,cwd)=>{
 const rows=(await readFile(join(source,'tests/fixtures/rc2-repairs',name,'session.v4.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
 const delta=Date.now()-60000-rows[0].createdAt;rows[0].id=id;rows[0].cwd=cwd;rows[0].createdAt+=delta;for(const row of rows.slice(1))row.time+=delta
 const restore=sessionFormatCatalog.createRestore(rows[0],{recovery:'strict',validation:'current'});for(const row of rows.slice(1))restore.decodeRow(row)
 return restore.finish()
}
const execute=async(name,args,signal=new AbortController().signal)=>JSON.parse((await app.ctx.tools.get(name).execute(args,{signal})).text)
const runs=()=>readdir(join(home,'insights/runs')).catch(e=>{if(e.code==='ENOENT')return [];throw e})
const checkedReport=async(locale,prefix)=>{
 const before=new Set(await runs())
 const command=await app.ctx.commands.execute(owner.agent,`/session-insights --days 30 --project ${JSON.stringify(project)} --locale ${locale} --deterministic --no-open`,[],new AbortController().signal)
 assert.equal(command.result.kind,'success')
 const after=await runs(),fresh=after.filter(id=>!before.has(id));assert.equal(fresh.length,1)
 const dir=join(home,'insights/runs',fresh[0]),files=await readdir(dir)
 const json=files.find(x=>x.endsWith('.json')&&x.includes('report')),html=files.find(x=>x.endsWith('.html'))
 assert.ok(json&&html)
 const report=JSON.parse(await readFile(join(dir,json),'utf8'))
 assert.equal(report.totals.sessions,1);assert.equal(report.totals.tool_failures,1);assert.equal(report.totals.repeated_retries,0)
 assert.deepEqual(report.totals.tool_recovery,{outcome_unknown:1,not_started:1});assert.equal(report.scope.locale,locale)
 assert.ok((await stat(join(dir,html))).size>0)
 await cp(join(dir,json),join(output,`${prefix}.json`));await cp(join(dir,html),join(output,`${prefix}.html`))
 return {dir,report}
}
try{
 begin('artifact_digest');assert.equal(digest(await readFile(tgz)),canonical.sha256);record(currentGate,'canonical producer SHA-256 compared before install')
 begin('runtime_closure');const runtime=await inspectRuntime(dirname(hostManifest));annex.runtime_tree_sha256=runtime.sha256;await writeFile(join(output,'runtime-inventory.json'),JSON.stringify(runtime,null,2)+'\n');record(currentGate,`${runtime.identities.length} actual CLI-resolved DSH/Cordis package inventories`,{kind:'runtime_tree',id:runtime.sha256})
 begin('official_cli_install');await cli(['add',tgz]);record(currentGate,'official CLI installed canonical package under isolated home')
 begin('installed_loaded_manifest');const profilePath=join(home,'profiles',profile,'package.json');const installed=dirname(await realpath(createRequire(profilePath).resolve('dsh-session-insights/package.json')));assert.deepEqual(await fileManifest(installed),canonical.files);assert.equal(JSON.parse(await readFile(join(installed,'package.json'),'utf8')).gitHead,canonical.commit);record(currentGate,'all installed package files match canonical artifact and embedded commit')
 begin('install_noop');const profileState=async()=>(await fileManifest(dirname(profilePath))).filter(file=>!file.path.startsWith('.plugin-manager/logs/'));const beforeInstall=await profileState();await cli(['add',tgz]);assert.deepEqual(await profileState(),beforeInstall);assert.deepEqual(await fileManifest(installed),canonical.files);record(currentGate,'second official install preserves installed/configuration bytes; manager operation logs are separately excluded')
 begin('official_reinstall');await cli(['remove','dsh-session-insights']);await cli(['add',tgz]);const reinstalled=dirname(await realpath(createRequire(profilePath).resolve('dsh-session-insights/package.json')));assert.deepEqual(await fileManifest(reinstalled),canonical.files);record(currentGate,'official uninstall and reinstall restored all canonical package bytes')
 begin('profile_service_boot');app=await boot();for(const name of ['sessionPersistence','sessionQuery','agents','commands','tools'])assert.ok(app.ctx.get(name));assert.ok(app.ctx.profileContext.startedBundles.includes('dsh-session-insights'));assert.ok(tools.every(n=>app.ctx.tools.get(n)));record(currentGate,profile==='web'?'official Web profile boot mounted installed Bundle; private overlay disables HMR watcher and title model':'official Headless profile services mounted installed Bundle; one-shot runner is paused for deterministic service checks; actual CLI model task is a separate gate')
 begin('real_persistence');for(const item of [['recovery-mixed-group','native-target',project],['optional-isError','native-unrelated',join(work,'unrelated')]]){const a=await fixture(...item);const h=await app.ctx.sessionPersistence.create(a.header,{inheritedEventCount:a.inheritedEventCount});try{await h.append(a.events);await h.flush()}finally{await h.close()}}
 assert.equal((await app.ctx.sessionPersistence.list()).length,2);record(currentGate,'two nonempty official strict fixtures appended, flushed and closed through actual JSONL persistence')
 await app.shutdown.shutdown(0);app=undefined
 begin('cold_read');app=await boot();assert.equal(app.ctx.sessions.get('native-target'),undefined);const cold=await app.ctx.sessionQuery.observeSession('native-target',{projectionMode:'none'});try{assert.equal(cold.events.length,18);assert.ok(cold.events.some(e=>e.data?.error?.code==='TOOL_OUTCOME_UNKNOWN'));assert.ok(cold.events.some(e=>e.data?.error?.code==='TOOL_NOT_STARTED'))}finally{cold[Symbol.dispose]()};record(currentGate,'after full profile disposal and restart, cold query restored 18 durable events including both recovery statuses')
 begin('agent_command');owner=await app.ctx.agents.create({sessionId:'native-command-agent',meta:{cwd:join(work,'driver')}});assert.equal(owner.agent.status,'idle');const zh=await checkedReport('zh-CN','report-zh');assert.ok(owner.agent.session.snapshotEvents().some(e=>e.type==='command/done'));record(currentGate,'actual factory-created Agent executed registered slash command with durable command completion')
 begin('project_isolation');assert.equal((await app.ctx.sessionQuery.listSessions()).length,3);assert.equal(zh.report.totals.sessions,1);record(currentGate,'production filter selected one recovery session among two durable projects and the live command Agent using Chinese and spaces')
 begin('bilingual_report');await checkedReport('en','report-en');record(currentGate,'both language commands produced nonempty HTML/JSON: one ordinary failure, recovery counts 1/1, no confirmed retry')
 begin('cancel_quiescence');const before=(await runs()).sort(),controller=new AbortController();const pending=execute('session_insights_prepare',{days:30,project,privacy:'redacted',locale:'en'},controller.signal);setImmediate(()=>controller.abort());await assert.rejects(pending,e=>e.name==='AbortError'||e.code==='SESSION_QUERY_ABORTED'||/cancel/i.test(e.message));await new Promise(r=>setTimeout(r,500));assert.deepEqual((await runs()).sort(),before);record(currentGate,'cancelled pending real prepare; no late run during 500ms observation; worker phase is not inferred')
 begin('rerun_after_cancel');const rerun=await execute('session_insights_prepare',{days:30,project,privacy:'redacted',locale:'en'});assert.equal(rerun.selected,1);assert.ok(rerun.batches.length);const final=await execute('session_insights_finalize',{workdir:rerun.workdir,fallback:true});assert.equal(JSON.parse(await readFile(final.data,'utf8')).totals.sessions,1);record(currentGate,'populated rerun and explicit deterministic fallback succeeded after cancellation')
 begin('cleanup_tool');const preview=await execute('session_insights_cleanup',{workdir:rerun.workdir});assert.ok(preview);await execute('session_insights_cleanup',{workdir:rerun.workdir,confirm:true});await assert.rejects(stat(rerun.workdir),{code:'ENOENT'});record(currentGate,'preview then confirmed cleanup removed only the agreed test run')
 await owner.dispose();owner=undefined;await app.shutdown.shutdown(0);app=undefined;await cli(['remove','dsh-session-insights']);record('uninstall_official_cli','official CLI removed isolated installation after host disposal')
}catch(e){failure=e;await writeFile(join(output,'private-error.txt'),String(e.stack||e));annex.gates.push({id:currentGate,required:true,status:'failed',subject:{kind:'artifact',id:canonical.sha256},exit_code:1,note:'native gate failed; private diagnostics retained locally',evidence:{mode:'executed',source_result_sha256:null,source_gate_id:null,invalidation_reason:null}})}finally{
 try{if(owner)await owner.dispose();if(app)await app.shutdown.shutdown(0);await rm(work,{recursive:true,force:true});await assert.rejects(stat(work),{code:'ENOENT'});annex.cleanup.status='passed';record('dispose_cleanup','owned Agent/profile disposed and isolated test tree removal independently confirmed')}catch(e){failure=e;annex.cleanup={status:'failed',remaining_ids:['native-test-tree']}}
 annex.status=failure?'failed':'passed';annex.run.finished_at=new Date().toISOString();await writeFile(join(base,`${profile}-native-annex.json`),JSON.stringify(annex,null,2)+'\n');console.log(JSON.stringify({status:annex.status,gates:annex.gates.length,cleanup:annex.cleanup.status}));if(failure)process.exitCode=1
}

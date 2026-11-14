import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {DESKTOP_ISOLATION_OVERLAY,cleanupFailedPreparation,redactOutput,withIsolatedDesktopEnv,persistIsolatedFixtures,privateEnv} from '../scripts/desktop_acceptance.mjs'

// Match async fs.realpath in production, including Windows 8.3 aliases.
const script=fileURLToPath(new URL('../scripts/desktop_acceptance.mjs',import.meta.url))
const cleanEnv=Object.fromEntries(['PATH','HOME','TMPDIR','TMP','TEMP','SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','PATHEXT','USERPROFILE','LANG','LC_ALL'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))
const run=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',env:cleanEnv})
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
    const canonical=realpathSync.native(out)
    writeFileSync(join(out,'prepared.json'),JSON.stringify({schema:'dsi-desktop-isolated/v1',status:'prepared_not_gui_accepted',output:canonical,project:join(canonical,'project'),expected:{commit:'1'.repeat(40),tgz:'2'.repeat(64)},host_version:'0.2.2-rc.3',before_sha256:'3'.repeat(64)}))
    assert.equal(run('finalize','--output',out).status,1)
    const path=join(out,'finalized.json'),data=JSON.parse(readFileSync(path,'utf8'))
    assert.equal(data.status,'failed');assert.equal(data.operation.status,'failed');assert.equal(data.source_logs.status,'failed');assert.equal(data.gui_observation,'not_asserted_by_runner')
    const before=readFileSync(path);assert.equal(run('finalize','--output',out).status,1);assert.deepEqual(readFileSync(path),before)
  } finally {rmSync(out,{recursive:true,force:true})}
})

test('actual official root resolvers see task roots throughout isolated action and environment restores',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-env-')),home=join(root,'qa-home'),agentsHome=join(root,'qa-agents'),project=join(root,'project')
  const originalCwd=process.cwd(),keys=['DSH_HOME','DSH_AGENTS_HOME','DSH_TELEMETRY_DISABLED'],original=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
  try {
    mkdirSync(home);mkdirSync(agentsHome);mkdirSync(project)
    const req=createRequire(fileURLToPath(new URL('../tests/dsh-host/package.json',import.meta.url)))
    const paths=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-home-paths')).href)
    for(const fails of [false,true]){
      const work=()=>withIsolatedDesktopEnv({home,agentsHome,project},async()=>{
        assert.equal(paths.resolveDshHome(),realpathSync.native(home));assert.equal(paths.resolveAgentsHome(),realpathSync.native(agentsHome))
        assert.equal(process.cwd(),realpathSync.native(project));assert.equal(process.env.DSH_TELEMETRY_DISABLED,'1')
        if(fails)throw new Error('synthetic failure')
      })
      if(fails)await assert.rejects(work(),/synthetic failure/);else await work()
      assert.equal(process.cwd(),originalCwd)
      for(const key of keys)assert.equal(process.env[key],original[key])
    }
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('production environment guard accepts official isolated resolvers and rejects a resolver that escapes',()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-env-guard-'))
  try {
    const home=join(root,'qa-home'),agents=join(root,'qa-agents'),project=join(root,'project')
    mkdirSync(home);mkdirSync(agents);mkdirSync(project)
    const moduleUrl=new URL('../scripts/desktop_acceptance.mjs',import.meta.url).href
    const hostManifest=fileURLToPath(new URL('../tests/dsh-host/package.json',import.meta.url))
    const code=`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {realpath} from 'node:fs/promises';import {withIsolatedDesktopEnv,assertDesktopEnvironment} from ${JSON.stringify(moduleUrl)};const [h,a,p]=await Promise.all(process.argv.slice(1).map(x=>realpath(x)));const req=createRequire(${JSON.stringify(hostManifest)});await withIsolatedDesktopEnv({home:h,agentsHome:a,project:p},async()=>{const paths=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-home-paths')).href);assertDesktopEnvironment({home:h,agentsHome:a,project:p,...paths});let refused=false;try{assertDesktopEnvironment({home:h,agentsHome:a,project:p,...paths,resolveDshHome:()=>'/outside'})}catch{refused=true}if(!refused)throw Error('escaped root was accepted')});process.stdout.write('passed');`
    const p=spawnSync(process.execPath,['--input-type=module','-e',code,home,agents,project],{env:cleanEnv,encoding:'utf8'})
    assert.equal(p.status,0,p.stderr);assert.equal(p.stdout,'passed')
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('child environment contains task agent root and excludes inherited synthetic token',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-child-env-')),key='DSI_SYNTHETIC_TEST_TOKEN'
  try{
    assert.equal(process.env[key],undefined);process.env[key]='synthetic-not-a-credential'
    const env=await privateEnv(root)
    assert.equal(env.DSH_HOME,join(root,'qa-home'));assert.equal(env.DSH_AGENTS_HOME,join(root,'qa-agents'))
    assert.notEqual(env.npm_config_userconfig,env.npm_config_globalconfig)
    assert.equal(Object.hasOwn(env,key),false)
  } finally {delete process.env[key];rmSync(root,{recursive:true,force:true})}
})

test('production session write guard rejects wrong home, cwd, profile, MCP and persistence roots before create',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-guard-')),home=join(root,'qa-home'),project=join(root,'project')
  try{
    let writes=0,closes=0
    const persistence={root:join(home,'sessions'),create:async()=>{writes++;return {append:async()=>{},flush:async()=>{},close:async()=>{closes++}}}}
    const profileContext={home,dir:join(home,'profiles','web'),cwd:project,startedBundles:['dsh-session-insights']}
    const makeContext=(profile=profileContext,writer=persistence,service=writer,mcp=undefined)=>({profileContext:profile,sessionPersistence:writer,get:name=>name==='profileContext'?profile:name==='sessionPersistence'?service:name==='mcpManager'?mcp:undefined})
    const context=makeContext()
    let builds=0
    const input={home,project,context,entries:['first','second'],buildSnapshot:async id=>{builds++;return {header:{id},events:[],inheritedEventCount:0}}}
    await persistIsolatedFixtures(input);assert.equal(writes,2);assert.equal(closes,2)
    const outside={...persistence,root:join(root,'outside')}
    const cases=[
      makeContext({...profileContext,home:join(root,'daily')}),
      makeContext({...profileContext,dir:join(root,'daily-profile')}),
      makeContext({...profileContext,cwd:root}),
      makeContext({...profileContext,startedBundles:[]}),
      makeContext(profileContext,persistence,persistence,{}),
      makeContext(profileContext,outside,outside),
      makeContext(profileContext,persistence,outside),
      makeContext(profileContext,persistence,{}),
    ]
    for(const bad of cases){
      const previous=writes,priorBuilds=builds
      await assert.rejects(persistIsolatedFixtures({...input,context:bad}))
      assert.equal(writes,previous,'rejected before creating any session')
      assert.equal(builds,priorBuilds,'rejected before building or writing a fixture')
    }
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('official overlay parser recognizes explicit MCP, title-model and HMR disables',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-overlay-'))
  try{
    const req=createRequire(fileURLToPath(new URL('../tests/dsh-host/package.json',import.meta.url)))
    const {loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
    const path=join(root,'isolation.patch.yml');writeFileSync(path,DESKTOP_ISOLATION_OVERLAY)
    const patches=loadOverlayPatches('dsi-test',path)
    assert.deepEqual(patches.map(p=>[p.id,p.disabled]),[['hmr',true],['session-title-llm',true],['mcp-manager',true]])
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('real Cordis trace services keep the validated JSONL writer for the actual write',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsi-desktop-real-service-'))
  let ctx
  try{
    const home=join(root,'qa-home'),project=join(root,'project')
    mkdirSync(home);mkdirSync(project)
    const canonicalHome=realpathSync.native(home),canonicalProject=realpathSync.native(project)
    const req=createRequire(fileURLToPath(new URL('../tests/dsh-host/package.json',import.meta.url)))
    const {Context}=await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
    const jsonl=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
    ctx=new Context()
    ctx.provide('profileContext',{home:canonicalHome,dir:join(canonicalHome,'profiles','web'),cwd:canonicalProject,startedBundles:['dsh-session-insights']})
    await jsonl.apply(ctx,{root:join(canonicalHome,'sessions'),compression:'zstd'})
    const selected={get:name=>ctx.get(name),get sessionPersistence(){throw new Error('unvalidated second writer lookup')}}
    await persistIsolatedFixtures({home:canonicalHome,project:canonicalProject,context:selected,entries:['qa-proxy-session'],buildSnapshot:async id=>({header:{version:4,id,createdAt:Date.now(),cwd:canonicalProject,isSeeded:false},events:[{type:'turn/start',seq:0,time:Date.now(),data:{turn:1}}],inheritedEventCount:0})})
    const handle=await ctx.get('sessionPersistence').open('qa-proxy-session','read')
    try{assert.equal((await handle.read(0)).events.length,1)}finally{await handle.close()}
  }finally{if(ctx)await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('credential-like environment is rejected before a carrier can load',()=>{
  const moduleUrl=new URL('../scripts/desktop_acceptance.mjs',import.meta.url).href
  const code=`import {assertSanitizedProcessEnv} from ${JSON.stringify(moduleUrl)};assertSanitizedProcessEnv();process.stdout.write('ok');`
  const env={PATH:process.env.PATH??'',HOME:process.env.HOME??'',TMPDIR:tmpdir()}
  const good=spawnSync(process.execPath,['--input-type=module','-e',code],{env,encoding:'utf8'})
  assert.equal(good.status,0);assert.equal(good.stdout,'ok')
  const bad=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...env,DSH_SYNTHETIC_TOKEN:'qa-value'},encoding:'utf8'})
  assert.notEqual(bad.status,0);assert.ok(!bad.stderr.includes('qa-value'))
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

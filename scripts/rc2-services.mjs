// Real rc.2 Session + query service integration, with synthetic data only.
// This is service/codec evidence, not a GUI or real-model acceptance claim.
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {resolve,join} from 'node:path'
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
const runtime=process.argv[2], packageRoot=resolve(process.argv[3] || '.')
if(!runtime) throw new Error('runtime required')
const req=createRequire(join(resolve(runtime),'package.json'))
const load=async name=>import(pathToFileURL(req.resolve(name)).href)
const {Context}=await load('@deepseek-ai/cordis')
const {SessionStore,Session}=await load('@deepseek-ai/dsh-session')
const {SessionQueryEngine}=await load('@deepseek-ai/dsh-session-query')
const {CommandRuntime}=await load('@deepseek-ai/dsh-commands')
const {ToolRuntime}=await load('@deepseek-ai/dsh-tools')
const {SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt')
const {sessionFormatCatalog}=await load('@deepseek-ai/dsh-session-format-catalog')
const {releasedV4SessionFormatCodec}=await load('@deepseek-ai/dsh-session-format-v3-to-v4')
const plugin=await import(pathToFileURL(join(packageRoot,'plugin/lib/index.js')).href)
const rows=(await readFile(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse)
const {type,...header}=rows[0]
const ctx=new Context()
const sessions=new SessionStore(ctx)
const query=new SessionQueryEngine(ctx)
new SystemPrompt(ctx,{})
new CommandRuntime(ctx)
new ToolRuntime(ctx,{})
const first=ctx.plugin(plugin)
await new Promise(r=>setImmediate(r))
assert.ok(ctx.tools.get('session_insights_prepare'))
await first.dispose()
assert.equal(ctx.tools.get('session_insights_prepare'),undefined)
const second=ctx.plugin(plugin)
await new Promise(r=>setImmediate(r))
assert.ok(ctx.tools.get('session_insights_prepare'))
await first.dispose()
assert.ok(ctx.tools.get('session_insights_prepare'))
const live=sessions.create(header.id,{seed:rows.slice(1),meta:header,inheritedEventCount:0})
assert.equal((await query.listSessions()).length,1)
const detached=await plugin._test.collectSnapshots({sessionQuery:query},{now:header.createdAt+86400000,days:30})
assert.equal(detached[0].events.length,live.snapshotEvents().length)
const notice=plugin._test.orchestrationPrompt({workdir:'/synthetic/run'},'en')
live.append('turn/start',{turn:2})
live.append('user/message',notice,{surfaceOp:'append'})
live.append('step/start',{turn:2,step:1})
const h=live.append('request/header',{reason:'resume',startsSeries:true,header:{config:{provider:'synthetic-provider',model:'synthetic-model'},tools:[{name:'synthetic_tool',description:'Synthetic test',parameters:{type:'object'}}]}})
live.append('developer/message',{turn:2,step:1,headerSeq:h.seq,message:{id:'tool-add',role:'developer',source:{kind:'tool-registry'},content:[{type:'tool-addition',toolName:'synthetic_tool'}]}},{surfaceOp:'append'})
live.append('developer/message',{turn:2,step:1,message:{id:'tool-remove',role:'developer',source:{kind:'tool-registry'},content:[{type:'tool-removal',toolName:'synthetic_tool'}]}},{surfaceOp:'append'})
live.append('step/end',{turn:2,step:1})
live.append('turn/end',{turn:2,reason:{kind:'completed'}})
// Encode actual session events, write to an isolated file and restore using the
// same official strict catalog used by persistence, then create a new Session.
const folder=await mkdtemp(join(tmpdir(),'insights-rc2-services-'))
try {
 const encoded=[{type:'session',...live.header},...live.snapshotEvents().map(e=>releasedV4SessionFormatCodec.encodeEvent(e))]
 const path=join(folder,'session.v4.jsonl')
 await writeFile(path,encoded.map(r=>JSON.stringify(r)).join('\n')+'\n')
 const back=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse)
 const restore=sessionFormatCatalog.createRestore(back[0],{recovery:'strict',validation:'current'})
 for(const row of back.slice(1))restore.decodeRow(row)
 const artifact=restore.finish()
 const reopened=Session.create(artifact.header.id,artifact.events,artifact.header,artifact.inheritedEventCount)
 assert.equal(reopened.snapshotEvents().find(e=>e.type==='user/message' && e.data.id===notice.id).data.source.kind,'session-insights')
 // Inject only a synthetic persistence seam; query, Session preparation and
 // interrupted-tail handling are the real rc.2 implementation.
 const coldCtx=new Context(), coldSessions=new SessionStore(coldCtx)
 let closed=0, mode='ok'
 const coldHeader={...header,id:'cold-synthetic'}
 const backend={identity:'synthetic-readonly', async stat(id,{signal}={}) {signal?.throwIfAborted();return {header:{...coldHeader,id},revision:mode}},async open(id,access,{signal}={}) {
   assert.equal(access,'read');signal?.throwIfAborted()
   return {header:{...coldHeader,id},inheritedEventCount:0,async read(from,to,{signal}={}) {
     if(mode==='cancel') { await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted() }
     if(mode==='corrupt') {const error=new Error('synthetic corruption');error.name='SessionPersistenceCorruptionError';throw error}
     return {events:structuredClone(rows.slice(1,-1)),eventState:'detached'}
   },async close(){closed++}}
 }}
 coldCtx.provide('sessionPersistence',backend)
 const coldQuery=new SessionQueryEngine(coldCtx,{preparedSessionCacheSize:1})
 try {
   const lease=await coldQuery.observeSession(coldHeader.id,{projectionMode:'none'})
   assert.equal(lease.events.at(-1).data.reason.kind,'interrupted');lease[Symbol.dispose]()
   assert.equal(closed,1)
   mode='cancel';const controller=new AbortController()
   const cancelled=coldQuery.observeSession(coldHeader.id,{signal:controller.signal,projectionMode:'none'})
   setImmediate(()=>controller.abort());await assert.rejects(cancelled,e=>e.code==='SESSION_QUERY_ABORTED');assert.equal(closed,2)
   mode='corrupt';await assert.rejects(coldQuery.observeSession(coldHeader.id,{projectionMode:'none'}),e=>e.code==='SESSION_QUERY_CORRUPT_SESSION');assert.equal(closed,3)
 } finally {await coldCtx.fiber.dispose()}
 var result={status:'pass',scope:'real rc.2 Session/query/codec, synthetic input; no model or GUI',persistedEvents:artifact.events.length,noticeReopened:true,queryDetached:true,realCordisRegistrationReload:true,developerHistoryReopened:true,coldReadClosed:closed,coldCancelled:true,coldCorruptionPropagated:true}
} finally {await ctx.fiber.dispose();await rm(folder,{recursive:true,force:true})}

console.log(JSON.stringify(result))

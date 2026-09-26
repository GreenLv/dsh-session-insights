import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildReport } from '../plugin/lib/analyzer.js'
import { validateV4 } from '../plugin/lib/v4.js'
import { _test, apply } from '../plugin/lib/index.js'
const rows = JSON.parse('[' + readFileSync(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8').trim().split('\n').join(',') + ']')
const snapshot = () => { const [header,...events] = structuredClone(rows); delete header.type; return {session:header,events,inheritedEventCount:0} }
const options = {now:rows[0].createdAt+86400000,days:30,privacy:'redacted',locale:'en',analysis_depth:'evidence'}
const report = s => buildReport([s],options).report
const add = (s,type,data,extra={}) => s.events.push({type,data,seq:s.events.length,time:options.now-100,...extra})
const msg = (id,role,kind,text) => ({id,role,source:{kind},content:[{type:'text',text}]})
test('V4 admission rejects missing/old/future headers, legacy wrappers, call conflicts and required extensions',()=>{
 for (const version of [undefined,3,5]) {const s=snapshot();s.session.version=version;assert.throws(()=>report(s),/V4/)}
 const bad=snapshot();bad.events[5].data.message.toolCallId='conflict';assert.throws(()=>report(bad),/identity conflict/)
 const legacy=snapshot();legacy.events[2].data.source={kind:'plugin',plugin:'test'};assert.throws(()=>report(legacy),/source/)
 const unknown=snapshot();add(unknown,'example/required',{});assert.throws(()=>report(unknown),/required/)
 unknown.events.at(-1).ignorable=true;assert.equal(report(unknown).totals.sessions,1)
})
test('developer, system and tool nodes remain in surface order before evidence filtering',()=>{
 const s=snapshot()
 add(s,'developer/message',{message:msg('dev','developer','tool-registry','SECRET-DEVELOPER')},{surfaceOp:'append'})
 add(s,'system/message',{message:msg('sys','system','system-prompt','SECRET-SYSTEM')},{surfaceOp:'append'})
 add(s,'user/message',msg('new','user','user','Current synthetic request'),{surfaceOp:{op:'replace',startSeq:2,endSeq:11},sourceEventSeqs:[2,3,5,6,10,11]})
 validateV4(s)
 const built=buildReport([s],options), text=JSON.stringify(built.sessions)
 assert.ok(!text.includes('SECRET-DEVELOPER'));assert.ok(!text.includes('SECRET-SYSTEM'))
 assert.equal(built.report.totals.tool_calls,1);assert.equal(built.report.totals.tokens.total_tokens,460)
 assert.equal(built.sessions[0].messages.filter(m=>m.role==='user').length,1)
})
test('PTC pairs subcalls, counts pending work and retains both outer and inner failed outcomes',()=>{
 const s=snapshot();s.events[4].data.name='run_code'
 for (const id of ['a','b','c']) add(s,'tool/ptc-dispatch-start',{rootCallId:'fixture-call-1',parentCallId:'fixture-call-1',subCallId:id,name:'bash',arguments:'npm test'})
 for (const id of ['b','a']) add(s,'tool/ptc-dispatch',{rootCallId:'fixture-call-1',parentCallId:'fixture-call-1',subCallId:id,name:'bash',arguments:'npm test',isError:id==='b',content:[{type:'text',text:'Tests complete'}]})
 const r=report(s);assert.equal(r.totals.tool_calls,4)
 assert.deepEqual(r.session_summaries[0].tool_execution,{outer_calls:1,inner_calls:3,outer_failures:0,inner_failures:1,inner_incomplete:1})
 assert.equal(r.totals.tool_failures,1)
 const outer=s.events.splice(5,1)[0];outer.data.message.isError=true;s.events.push(outer);s.events.forEach((e,i)=>e.seq=i)
 const failed=report(s);assert.equal(failed.totals.tool_failures,2);assert.equal(failed.session_summaries[0].tool_execution.outer_failures,1)
})
test('Auto review final denial is permission blocked, never failed verification; text cannot change explicit success',()=>{
 const s=snapshot();s.events[5].data.message.isError=true;s.events[5].data.error={code:'AUTO_REVIEW_DENIED',message:'review denied'}
 const r=report(s);assert.equal(r.totals.permission_blocks,1);assert.equal(r.session_summaries[0].verification.failures,0)
 const success=snapshot();success.events[5].data.message.content[0].text='Auto review denied; human allowed. Command failed'
 const t=report(success);assert.equal(t.totals.tool_failures,0);assert.equal(t.totals.permission_blocks,0);assert.equal(t.session_summaries[0].verification.successes,1)
})
test('inherited prefix is not counted as child work and marker mismatch fails',()=>{
 const s=snapshot();s.session.isSeeded=true;s.session.origin='subagent';s.session.parentSession='parent'
 add(s,'session/end-seed',{inherited:true});s.inheritedEventCount=10
 add(s,'user/message',msg('child','user','user','Child own work'),{surfaceOp:'append'})
 const r=report(s);assert.equal(r.totals.user_messages,1);assert.equal(r.totals.tool_calls,0);assert.equal(r.totals.tokens.total_tokens,0)
 s.inheritedEventCount=9;assert.throws(()=>report(s),/cut/)
})
test('observe leases release once after clone, clone failure, cancellation and size rejection',async()=>{
 for(const mode of ['ok','clone','cancel','size']) {
  const s=snapshot(), c=new AbortController();let releases=0
  const query={async listSessions(){return [{header:s.session}]},async observeSession(id,opts){assert.equal(opts.projectionMode,'none');assert.equal(opts.signal,c.signal);if(mode==='cancel')c.abort();return {header:s.session,events:mode==='clone'?[()=>{}]:mode==='size'?[{padding:'x'.repeat(64*1024*1024)}]:s.events,inheritedEventCount:0,[Symbol.dispose](){releases++}}}}
  const running=_test.collectSnapshots({sessionQuery:query},options,c.signal)
  if(mode==='ok') { const result=await running;assert.notEqual(result[0].events,s.events) }
  else await assert.rejects(running)
  assert.equal(releases,1,mode)
 }
})
test('unload cancels owned query and waits; a new plugin instance remains independent',async()=>{
 let dispose, command, finish;const pending=new Promise(r=>finish=r)
 const ctx={effect(fn){dispose=fn()},commands:{register(c){command=c}},tools:{register(){}},sessionQuery:{async listSessions(signal){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await pending;return []}}}
 apply(ctx);const operation=command.handler({rawInput:'--deterministic'})
 await new Promise(r=>setImmediate(r));let stopped=false;const unload=dispose().then(()=>stopped=true)
 await new Promise(r=>setImmediate(r));assert.equal(stopped,false);finish();await unload;assert.match((await operation).text,/cancelled/)
})
test('notice helper creates immutable unique producer-owned user messages',()=>{
 const a=_test.orchestrationPrompt({workdir:'/synthetic/run'},'en'),b=_test.orchestrationPrompt({workdir:'/synthetic/run'},'en')
 assert.notEqual(a.id,b.id);assert.equal(a.source.kind,'session-insights');assert.equal(a.role,'user');assert.ok(Object.isFrozen(a));assert.ok(!('plugin' in a.source))
})
test('selection accepts 2000 but rejects 2001 snapshots and handles empty collections',async()=>{
 const run=async count=>{const data=Array.from({length:count},(_,i)=>({header:{...snapshot().session,id:`s${i}`}}));let releases=0;const sessionQuery={async listSessions(){return data},async observeSession(id){return {header:data.find(r=>r.header.id===id).header,events:[],inheritedEventCount:0,[Symbol.dispose](){releases++}}}};try{return await _test.collectSnapshots({sessionQuery},options)}finally{assert.equal(releases,count)}}
 assert.equal((await run(0)).length,0);assert.equal((await run(2000)).length,2000);await assert.rejects(run(2001),/bound/)
})
test('image offload, schedule context and opaque events never introduce body evidence',()=>{
 const s=snapshot();s.events[2].data.content.push({type:'image',data:'SENSITIVE-IMAGE',mediaType:'image/png'})
 add(s,'image/offload',{targets:[{seq:2,imageIndexes:[0]}]})
 add(s,'user/message',msg('schedule','user','schedule','SENSITIVE-SCHEDULE'),{surfaceOp:'append'})
 add(s,'workspace/changes',{diff:'SENSITIVE-DIFF'})
 add(s,'opaque/test',{text:'SENSITIVE-EXTENSION'},{ignorable:true})
 const built=buildReport([s],options), text=JSON.stringify(built.sessions)
 for(const secret of ['SENSITIVE-IMAGE','SENSITIVE-SCHEDULE','SENSITIVE-DIFF','SENSITIVE-EXTENSION']) assert.ok(!text.includes(secret))
 assert.equal(built.report.totals.user_messages,2);assert.ok(text.includes('Implement the synthetic fixture'))
})

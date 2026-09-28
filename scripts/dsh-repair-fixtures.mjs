// Differential regression corpus: every positive is admitted by the exact target DSH.
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
const req=createRequire(join(resolve(process.argv[2]),'package.json'))
const {sessionFormatCatalog}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')))
const {interruptedTurnClosers,TOOL_OUTCOME_UNKNOWN,TOOL_NOT_STARTED}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session')))
const {releasedV4SessionFormatCodec}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')))
const version=JSON.parse(readFileSync(req.resolve('@deepseek-ai/dsh-session-format-catalog/package.json'))).version
const TARGET='0.2.0-rc.1'
if(version!==TARGET)throw Error('exact target DSH '+TARGET+' required, got '+version)
const base=readFileSync(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse)
const target=new URL('../tests/fixtures/rc2-repairs/',import.meta.url)
const cases=[]
function add(name,rows,expected){
 const restore=sessionFormatCatalog.createRestore(rows[0],{recovery:'strict',validation:'current'})
 for(const e of rows.slice(1))restore.decodeRow(e)
 const result=restore.finish(),text=rows.map(r=>JSON.stringify(r)).join('\n')+'\n'
 const path=new URL(name+'/session.v4.jsonl',target)
 if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==text)throw Error('fixture drift: '+name)}
 else {mkdirSync(new URL(name+'/',target),{recursive:true});writeFileSync(path,text)}
 cases.push({name,expected,snapshot:{session:result.header,events:result.events,inheritedEventCount:result.inheritedEventCount}})
 return result
}
// R01 recovery family: closers come from the official ToolCallRecovery of the
// exact target package, then pass the strict catalog before reaching either
// production analyzer. Hand-written rows only build controls that must NOT be
// classified as recovery.
function addRecovery(name,events,expected){
 renumber(events)
 const closers=interruptedTurnClosers(events)
 if(!closers.length)throw Error('recovery fixture needs an open tail: '+name)
 const byCode=closers.filter(e=>e.type==='tool/result').map(e=>e.data.error.code)
 for(const code of byCode)if(code!==TOOL_OUTCOME_UNKNOWN&&code!==TOOL_NOT_STARTED)throw Error('unexpected recovery code '+code)
 const encoded=events.map(e=>releasedV4SessionFormatCodec.encodeEvent(e)).concat(closers.map(e=>releasedV4SessionFormatCodec.encodeEvent(e)))
 const rows=[structuredClone(base[0]),...encoded]
 const result=add(name,rows,expected)
 const again=interruptedTurnClosers(result.events)
 if(again.length)throw Error('official recovery must close an interrupted tail exactly once: '+name)
 return result
}
const renumber=events=>events.forEach((e,i)=>{e.seq=i;e.time=base[0].createdAt+i*1000})
const userMessage=(turn,step,id,text)=>({type:'user/message',surfaceOp:'append',data:{turn,step,id,role:'user',source:{kind:'user'},content:[{type:'text',text}]}})
const assistantCall=(turn,step,id,callId)=>({type:'assistant/message',surfaceOp:'append',data:{turn,step,stream:[],message:{id,role:'assistant',source:{kind:'model',provider:'synthetic-provider',model:'synthetic-model'},content:[{type:'text',text:'Synthetic request.'},{type:'tool-call',id:callId,name:'bash',arguments:'{"command": "python -m unittest"}'}]}}})
const toolCall=(turn,step,callId)=>({type:'tool/call',data:{turn,step,callId,name:'bash',arguments:'{"command": "python -m unittest"}'}})
const toolResult=(turn,step,callId,isError,text,error)=>({type:'tool/result',surfaceOp:'append',data:{turn,step,message:{id:'result-'+callId+(error?'-recovery':''),role:'tool',source:{kind:'tool',callId},toolCallId:callId,...(isError===null?{}:{isError}),content:[{type:'text',text}]},...(error?{error}:{})}})
const turnStart=t=>({type:'turn/start',data:{turn:t}})
const turnEnd=(t,kind)=>({type:'turn/end',data:{turn:t,reason:{kind:kind??'completed'}}})
const stepStart=(t,s)=>({type:'step/start',data:{turn:t,step:s}})
const stepEnd=(t,s)=>({type:'step/end',data:{turn:t,step:s}})
// Unrecorded start: the assistant request never reached a tool/call record.
const recoveredFirst = addRecovery('recovery-not-started',[
 turnStart(1),stepStart(1,1),userMessage(1,1,'u1','Synthetic first task.'),
 assistantCall(1,1,'assistant-a','call-a'),
],{failures:0,permission:0,success:0,recovery:[0,1]})
// Reusing the same call id after a repaired turn must preserve two distinct
// uncertainty records. Let the official recoverer produce each closer.
addRecovery('recovery-repeated-identity',[
 ...recoveredFirst.events,
 turnStart(2),stepStart(2,1),userMessage(2,1,'u2','Synthetic second task.'),
 assistantCall(2,1,'assistant-b','call-a'),
],{failures:0,permission:0,success:0,recovery:[0,2]})
// Recorded start without a durable result; the call args are a verification
// command, and recovery must not become a failed verification.
addRecovery('recovery-outcome-unknown',[
 turnStart(1),stepStart(1,1),userMessage(1,1,'u1','Synthetic first task.'),
 assistantCall(1,1,'assistant-a','call-a'),toolCall(1,1,'call-a'),
],{failures:0,permission:0,success:0,recovery:[1,0]})
// Mixed group: one normal success, one normal failure, then one started and
// one unrecorded request; normal accounting stays, recovery counts once each.
const mixedRecovered = addRecovery('recovery-mixed-group',[
 turnStart(1),stepStart(1,1),userMessage(1,1,'u1','Synthetic first task.'),
 assistantCall(1,1,'assistant-a','call-a'),toolCall(1,1,'call-a'),toolResult(1,1,'call-a',false,'Command completed'),
 stepEnd(1,1),stepStart(1,2),
 assistantCall(1,2,'assistant-b','call-b'),toolCall(1,2,'call-b'),toolResult(1,2,'call-b',true,'Command failed'),
 assistantCall(1,2,'assistant-c','call-c'),toolCall(1,2,'call-c'),
 assistantCall(1,2,'assistant-d','call-d'),
],{failures:1,permission:0,success:1,verificationFailures:1,recovery:[1,1],retries:0})
// Same call identity across two turns: the settled first turn keeps its
// success; the unrecorded second-turn request is the only recovery.
addRecovery('recovery-id-boundary',[
 turnStart(1),stepStart(1,1),userMessage(1,1,'u1','Synthetic first task.'),
 assistantCall(1,1,'assistant-a','call-a'),toolCall(1,1,'call-a'),toolResult(1,1,'call-a',false,'Command completed'),
 stepEnd(1,1),turnEnd(1),
 turnStart(2),stepStart(2,1),userMessage(2,1,'u2','Synthetic retry request.'),
 assistantCall(2,1,'assistant-b','call-a'),
],{failures:0,permission:0,success:1,recovery:[0,1]})
// Recovery behind a surface replacement: the closer appends after a replaced
// surface without changing tool statistics.
addRecovery('recovery-surface-replace',[
 turnStart(1),stepStart(1,1),
 userMessage(1,1,'u1','Synthetic first task.'),
 assistantCall(1,1,'assistant-a','call-a'),toolCall(1,1,'call-a'),
 {type:'user/message',surfaceOp:{op:'replace',startSeq:2,endSeq:3},sourceEventSeqs:[2,3],data:{turn:1,step:1,id:'u-replacement',role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic replacement summary.'}]}},
],{failures:0,permission:0,success:0,recovery:[1,0]})
let r=structuredClone(base);delete r[6].data.message.isError;add('optional-isError',r,{failures:0,permission:0,success:1})
r=structuredClone(base);r[4].data.message.source.plugin='custom-owner';add('custom-source-metadata',r,{failures:0,permission:0,success:1})
r=structuredClone(base);r[0].isSeeded=true;for(let i=0;i<2;i++)r.push({type:'session/end-seed',seq:r.length-1,time:r.at(-1).time,data:{inherited:true}});add('nested-seed',r,{failures:0,permission:0,success:0,cut:11})
for(const name of ['outer-own-failure','inner-fail-caught','propagated-failure','human-denied','human-allowed','auto-denied','no-call-id','duplicate-denied','permission-text-only','inherited-denied','nested-pending','nested-complete','auto-denied-duplicate']){
 r=structuredClone(base);r[4].data.message.content[1].name='run_code';r[4].data.message.content[1].arguments='{}';r[5].data.name='run_code';r[5].data.arguments='{}'
 const identity={rootCallId:'fixture-call-1',parentCallId:'fixture-call-1',subCallId:'fixture-call-1:ptc:1',name:'bash',arguments:'npm test'}
 const innerFail=!['outer-own-failure','human-allowed','nested-pending','nested-complete'].includes(name)
 const denied=['human-denied','duplicate-denied','inherited-denied','auto-denied-duplicate'].includes(name)
 const added=[{type:'tool/ptc-dispatch-start',data:identity}]
 if(denied || ['human-allowed','no-call-id'].includes(name)){
  added.push({type:'approval/asked',data:{id:'approval-1',...(name==='no-call-id'?{}:{callId:identity.subCallId}),toolName:'bash'}},{type:'approval/decided',data:{id:'approval-1',outcome:name==='human-allowed'?'approved':'rejected'}})
  if(name==='duplicate-denied')added.push(structuredClone(added.at(-1)))
 }
 if(name==='inherited-denied'){r[0].isSeeded=true;added.push({type:'session/end-seed',data:{inherited:true}})}
 if(['nested-pending','nested-complete'].includes(name)) {
  const nested={...identity,parentCallId:identity.subCallId,subCallId:'nested-call'}
  added.push({type:'tool/ptc-dispatch-start',data:nested})
  if(name==='nested-complete')added.push({type:'tool/ptc-dispatch',data:{...nested,isError:false,content:[{type:'text',text:'Command completed'}]}})
 }
 added.push({type:'tool/ptc-dispatch',data:{...identity,isError:innerFail,content:[{type:'text',text:name==='permission-text-only'?'permission denied':innerFail?'Synthetic failure':'Command completed'}],...(name.startsWith('auto-denied')?{error:{name:'PermissionError',code:'AUTO_REVIEW_DENIED',reason:'Synthetic denial'}}:{})}})
 r.splice(6,0,...added);r.slice(1).forEach((e,i)=>{e.seq=i;e.time=base[0].createdAt+i*1000;if(e.type==='session/title')e.data.messageSeqs=[2,6+added.length]})
 const outer=r.find(e=>e.type==='tool/result');outer.data.message.isError=['outer-own-failure','propagated-failure'].includes(name);outer.data.message.content=[{type:'text',text:name==='outer-own-failure'?'ReferenceError: missingVariable is not defined':name==='propagated-failure'?'Synthetic failure':'Caught inner result'}]
 // Even known-by-construction propagation has no serialized causal identity;
 // count two failed results, with outer/inner components explicitly preserved.
 add(name,r,{failures:(innerFail?1:0)+(outer.data.message.isError?1:0),permission:denied || name==='auto-denied'?1:0,success:innerFail?0:name==='nested-complete'?2:1,verificationFailures:innerFail && !denied && name!=='auto-denied'?1:0,pending:name==='nested-pending'?1:0})
}
// Controls below are hand-written adversarial inputs, not official output.
// (A recovery result behind an already-settled call is invalid V4 — the strict
// catalog rejects it; that rejection lives in dsh-contract-tests.mjs, and the
// analyzer-side settled guard is covered by inline differential tests.)
const addClosed=(name,events,expected)=>{renumber(events);add(name,[structuredClone(base[0]),...events],expected)}
// Unknown outcomes break confirmed-failure retry attribution, including for a
// later ordinary call of the same operation. This does not erase the earlier
// failure or the recorded call workload.
addClosed('recovery-followed-by-success',[
 ...mixedRecovered.events,
 turnStart(2),stepStart(2,1),userMessage(2,1,'u2','Synthetic later task.'),
 assistantCall(2,1,'assistant-e','call-e'),toolCall(2,1,'call-e'),toolResult(2,1,'call-e',false,'Command completed'),
 stepEnd(2,1),turnEnd(2),
],{failures:1,permission:0,success:2,verificationFailures:1,recovery:[1,1],retries:0})
// Text that merely mentions a recovery code stays an ordinary failure.
addClosed('recovery-text-only',[
 turnStart(1),stepStart(1,1),userMessage(1,1,'u1','Synthetic first task.'),
 assistantCall(1,1,'assistant-a','call-a'),toolCall(1,1,'call-a'),
 toolResult(1,1,'call-a',true,'Command failed; log text mentions TOOL_OUTCOME_UNKNOWN but no structured code was recorded.'),
 stepEnd(1,1),turnEnd(1),
],{failures:1,permission:0,success:0,verificationFailures:1,recovery:[0,0]})
// A structured error without a recovery code keeps ordinary failure rules.
addClosed('recovery-no-code',[
 turnStart(1),stepStart(1,1),userMessage(1,1,'u1','Synthetic first task.'),
 assistantCall(1,1,'assistant-a','call-a'),toolCall(1,1,'call-a'),
 toolResult(1,1,'call-a',true,'Synthetic failure',{name:'ToolError',reason:'Synthetic ordinary error'}),
 stepEnd(1,1),turnEnd(1),
],{failures:1,permission:0,success:0,verificationFailures:1,recovery:[0,0]})
console.log(JSON.stringify({status:'pass',version,cases}))
const expectations=JSON.stringify(cases.map(({name,expected})=>({name,expected})),null,2)+'\n'
const manifest=new URL('expectations.json',target)
if(process.argv.includes('--check')){if(readFileSync(manifest,'utf8')!==expectations)throw Error('expectation drift')}
else writeFileSync(manifest,expectations)

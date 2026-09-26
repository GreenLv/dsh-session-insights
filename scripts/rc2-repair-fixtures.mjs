// Differential regression corpus: every positive is admitted by exact rc.2.
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
const req=createRequire(join(resolve(process.argv[2]),'package.json'))
const {sessionFormatCatalog}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')))
const version=JSON.parse(readFileSync(req.resolve('@deepseek-ai/dsh-session-format-catalog/package.json'))).version
if(version!=='0.1.7-rc.2')throw Error('exact rc.2 required')
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
}
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
console.log(JSON.stringify({status:'pass',version,cases}))
const expectations=JSON.stringify(cases.map(({name,expected})=>({name,expected})),null,2)+'\n'
const manifest=new URL('expectations.json',target)
if(process.argv.includes('--check')){if(readFileSync(manifest,'utf8')!==expectations)throw Error('expectation drift')}
else writeFileSync(manifest,expectations)

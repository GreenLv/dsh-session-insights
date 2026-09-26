// Deterministic nonempty rc.2 fixture, admitted by the official strict catalog.
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {resolve,join} from 'node:path'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {zstdCompressSync} from 'node:zlib'
const require=createRequire(join(resolve(process.argv[2]),'package.json'))
const {sessionFormatCatalog}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
const {releasedV4SessionFormatCodec}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href)
const rows=(await readFile(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse)
rows[0].id='synthetic-rc2-extended'
const events=rows.slice(1),stamp=rows[0].createdAt
for(const e of events) {if(e.seq>=2)e.seq++;if(e.type==='session/title')e.data.messageSeqs=e.data.messageSeqs.map(n=>n>=2?n+1:n)}
events.splice(2,0,{seq:2,time:stamp,type:'system/message',surfaceOp:'append',data:{turn:1,step:1,message:{id:'system-head',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'Synthetic system head'}]}}})
const add=(type,data,extra={})=>{const seq=events.length;events.push({seq,type,time:stamp+seq*1000,data,...extra});return seq}
const message=(id,role,kind,content)=>({id,role,source:{kind},content})
add('turn/start',{turn:2})
add('user/message',message('u2','user','user',[{type:'text',text:'Synthetic second task with PTC and dynamic tools.'}]),{surfaceOp:'append'})
add('step/start',{turn:2,step:1})
const headerSeq=add('request/header',{reason:'resume',startsSeries:true,header:{config:{provider:'synthetic-provider',model:'synthetic-model'},tools:[{name:'run_code',description:'synthetic transport',parameters:{type:'object'}}]}})
add('developer/message',{turn:2,step:1,headerSeq,message:message('addition','developer','tool-registry',[{type:'tool-addition',toolName:'run_code'}])},{surfaceOp:'append'})
add('assistant/message',{turn:2,step:1,stream:[],message:{id:'assistant2',role:'assistant',source:{kind:'model',provider:'synthetic-provider',model:'synthetic-model'},content:[{type:'tool-call',id:'outer',name:'run_code',arguments:'{}'}]}},{surfaceOp:'append'})
add('tool/call',{turn:2,step:1,callId:'outer',name:'run_code',arguments:'{}'})
for(const id of ['inner-a','inner-b','inner-pending'])add('tool/ptc-dispatch-start',{rootCallId:'outer',parentCallId:'outer',subCallId:id,name:'bash',arguments:'npm test'})
for(const id of ['inner-b','inner-a'])add('tool/ptc-dispatch',{rootCallId:'outer',parentCallId:'outer',subCallId:id,name:'bash',arguments:'npm test',isError:id==='inner-b',content:[{type:'text',text:'Synthetic execution result'}]})
add('tool/result',{turn:2,step:1,message:{id:'outer-result',role:'tool',source:{kind:'tool',callId:'outer'},toolCallId:'outer',isError:false,content:[{type:'text',text:'Outer caught the inner failure'}]}},{surfaceOp:'append'})
add('developer/message',{turn:2,step:1,message:message('removal','developer','tool-registry',[{type:'tool-removal',toolName:'run_code'}])},{surfaceOp:'append'})
add('step/end',{turn:2,step:1})
add('turn/end',{turn:2,reason:{kind:'completed'}})
add('turn/start',{turn:3})
add('step/start',{turn:3,step:1})
for(let i=0;i<4;i++)add('user/message',message(`schedule-${i}`,'user','schedule',[{type:'text',text:'Synthetic injected context'}]),{surfaceOp:'append'})
// Replacement spans user, assistant, tool and developer nodes. System joins it.
const sys=add('system/message',{turn:3,step:1,message:message('system','system','system-prompt',[{type:'text',text:'SYNTHETIC PRIVATE SYSTEM BODY'}])},{surfaceOp:'append'})
const sources=events.filter(e=>e.surfaceOp==='append' && e.seq!==2).map(e=>e.seq)
add('user/message',message('replacement','user','user',[{type:'text',text:'Synthetic current summary after replacement.'}]),{surfaceOp:{op:'replace',startSeq:3,endSeq:sys},sourceEventSeqs:sources})
add('step/end',{turn:3,step:1})
add('turn/end',{turn:3,reason:{kind:'completed'}})
const encoded=[rows[0],...events.map(e=>releasedV4SessionFormatCodec.encodeEvent(e))]
const restore=sessionFormatCatalog.createRestore(encoded[0],{recovery:'strict',validation:'current'})
for(const row of encoded.slice(1))restore.decodeRow(row)
const restored=restore.finish()
if(restored.events.length!==events.length)throw new Error('fixture restore count mismatch')
const folder=new URL('../tests/fixtures/rc2-extended/',import.meta.url);await mkdir(folder,{recursive:true})
const lines=encoded.map(r=>JSON.stringify(r)+'\n')
await writeFile(new URL('session.v4.jsonl',folder),lines.join(''))
await writeFile(new URL('session.v4.jsonl.zstd',folder),Buffer.concat([zstdCompressSync(Buffer.from(lines[0])),zstdCompressSync(Buffer.from(lines.slice(1).join('')))]))
console.log(JSON.stringify({status:'pass',events:events.length,physicalRangeEncoding:encoded.some(r=>r.sourceEventSeqs?.some(Array.isArray))}))

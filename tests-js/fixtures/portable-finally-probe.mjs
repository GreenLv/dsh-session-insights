// Exercise the real portable producer's finally block with synthetic faults.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import vm from 'node:vm'

const mode=process.argv[2]
if(!['dispose-failure','timeout'].includes(mode))throw Error('unsupported synthetic fault')
// Git on Windows may check out source with CRLF. JavaScript parses these line
// endings equivalently; normalize only the probe's in-memory source string.
const source=(await readFile(resolve('scripts/verify_host_acceptance.mjs'),'utf8')).replace(/\r\n/g,'\n')
const anchor=source.indexOf('  } finally {\n    let contextDisposed = !ctx')
const start=anchor+'  } finally {'.length
const end=source.indexOf('\n  }\n  return annex.status',start)
assert.ok(anchor>=0&&end>start,'portable finally block was not found')
const requiredText=source.match(/const REQUIRED = (\[[^\n]+\])/)[1]
const required=vm.runInNewContext(requiredText)
const commit='1'.repeat(40),calls=[]
const annex={schema:'native-acceptance/v2',status:'failed',product:'dsh-session-insights',gate_profile:'portable-installed-artifact',
 repository:{url:'https://example.invalid/repo',commit},runtime_tree_sha256:null,artifact:null,
 platform:{os:'macos',shell:'posix',toolchain:{node:process.version}},gates:[],cleanup:{status:'not_run',remaining_ids:[]},
 run:{started_at:new Date().toISOString(),finished_at:'',run_url:null},unperformed_actions:[]}
const scope={annex,ctx:mode==='dispose-failure'?{fiber:{dispose:async()=>{throw Error('synthetic disposal')}}}:undefined,
 work:'synthetic-work',quiescenceUnknown:false,savedHome:undefined,process:{env:{}},stage:'host_cli_identity',
 REQUIRED:required,TOOLS:[],options:{commit,annex:'synthetic-annex'},dirname,assert,
 rm:async()=>calls.push('remove'),stat:async()=>{},mkdir:async()=>{},writeFile:async()=>{},record:()=>{throw Error('unexpected record')},
 classifyAcceptanceError:()=>({stage:'host_cli_identity',name:'Error',code:null}),console:{error:()=>{}},
}
if(mode==='timeout') {
  const catchAnchor=source.indexOf('  } catch (error) {\n    // A killed/timed-out subprocess')
  const catchStart=catchAnchor+'  } catch (error) {'.length
  assert.ok(catchAnchor>=0&&anchor>catchStart,'portable catch block was not found')
  scope.syntheticError=Object.assign(new Error('synthetic timeout'),{killed:true,signal:'SIGTERM'})
  await vm.runInNewContext('(async(error)=>{'+source.slice(catchStart,anchor)+'})(syntheticError)',scope)
  assert.equal(scope.quiescenceUnknown,true)
}
await vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',scope)
console.log(JSON.stringify({annex,calls}))

import test from 'node:test'
import assert from 'node:assert/strict'
import workers from 'node:worker_threads'
import {syncBuiltinESMExports} from 'node:module'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Store} from '../plugin/lib/storage.js'
import {loadManifest} from '../plugin/lib/semantic.js'

const rows=readFileSync(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse)
const {apply, _test}=await import('../plugin/lib/index.js')
const signal=new AbortController().signal
async function scope(operation) {
  const home=mkdtempSync(join(tmpdir(),'si-review 中文 空格-')),previous=process.env.DSH_HOME
  process.env.DSH_HOME=home
  try {await operation(home)} finally {
    if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
    rmSync(home,{recursive:true,force:true})
  }
}
function register(query) {
  const tools=[],commands=[];let dispose
  apply({effect(fn){dispose=fn()},tools:{register(t){tools.push(t)}},commands:{register(c){commands.push(c)}},sessionQuery:query})
  return {prepare:args=>tools.find(t=>t.name==='session_insights_prepare').execute(args,{signal}),commands,dispose}
}
test('project-scoped production prepare and resume preserve normalized scope',()=>scope(async home=>{
  const cwd=join(home,'项目 目录'),header={...rows[0],createdAt:Date.now()-1000,cwd}
  const reg=register({async listSessions(){return [{header}]},async observeSession(){return {header,events:rows.slice(1),inheritedEventCount:0,[Symbol.dispose](){}}}})
  try {
    const first=JSON.parse((await reg.prepare({project:cwd,locale:'en'})).text)
    assert.equal(first.selected,1)
    const again=JSON.parse((await reg.prepare({resume:true,project:cwd+'/',locale:'en'})).text)
    assert.equal(again.workdir,first.workdir)
    await assert.rejects(reg.prepare({resume:true,workdir:first.workdir,project:home}),/scope mismatch/)
    await assert.rejects(reg.prepare({resume:true,project:home,locale:'en'}),/no resumable/)
  } finally {await reg.dispose()}
}))
test('manifest rejects drift in every selection field, fingerprint and mirrored options',()=>scope(async()=>{
  const reg=register({async listSessions(){return []}})
  try {
    const first=JSON.parse((await reg.prepare({locale:'en'})).text),store=new Store(),original=store.read(first.workdir,'manifest.json')
    for(const [key,value] of Object.entries({project:'/other',days:7,window_end:'bad-date',privacy:'local',analysis_privacy:'metrics',analysis_depth:'conversation',locale:'zh-CN'})){
      store.write(first.workdir,'manifest.json',{...original,selection:{...original.selection,[key]:value}})
      assert.throws(()=>loadManifest(store,first.workdir),/manifest/,key)
      await assert.rejects(reg.prepare({resume:true,workdir:first.workdir}),/manifest/)
    }
    for(const patch of [{scope_fingerprint:'bad'},{selection:undefined},{locale:'zh-CN'},{analysis_privacy:'metrics'},...['0.2.0-rc..2','01.2.3','0.2.0-01'].map(target_dsh_version=>({target_dsh_version}))]){
      store.write(first.workdir,'manifest.json',{...original,...patch})
      assert.throws(()=>loadManifest(store,first.workdir),/manifest/)
    }
    store.write(first.workdir,'manifest.json',original)
    assert.equal(loadManifest(store,first.workdir).locale,'en')
  } finally {await reg.dispose()}
}))
test('mixed command and tool calls cap actual live Workers through termination',()=>scope(async()=>{
  const Original=workers.Worker;let active=0,peak=0,started=0
  workers.Worker=class extends Original {constructor(...args){super(...args);active++;started++;peak=Math.max(peak,active);this.once('exit',()=>active--)}}
  syncBuiltinESMExports()
  const reg=register({async listSessions(){return []}})
  try {
    await Promise.all(Array.from({length:8},(_,i)=>i%2?reg.prepare({locale:'en'}):reg.commands[0].handler({rawInput:'--deterministic --no-open',signal})))
    assert.equal(started,8)
    assert.equal(peak,_test.ANALYSIS_CONCURRENCY)
    await reg.dispose();assert.equal(active,0)
  } finally {workers.Worker=Original;syncBuiltinESMExports();await reg.dispose()}
}))
test('snapshot count limit rejects before acquiring a 2001st query lease',async()=>{
  let observed=0,disposed=0
  const records=Array.from({length:2001},(_,i)=>({header:{id:String(i),createdAt:1,cwd:'/synthetic'}}))
  await assert.rejects(_test.collectSnapshots({sessionQuery:{async listSessions(){return records},async observeSession(id){observed++;return {header:records[Number(id)].header,events:[],inheritedEventCount:0,[Symbol.dispose](){disposed++}}}}},{days:1,now:2},signal),/bound/)
  assert.equal(observed,2000);assert.equal(disposed,2000)
})

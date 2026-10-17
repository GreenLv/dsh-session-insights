import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildReport} from '../plugin/lib/analyzer.js'
import {renderReport} from '../plugin/lib/semantic.js'
import {privacyValues,privacySnapshot,renderMemory} from './fixtures/rc21-privacy.mjs'
const options=(snapshot,privacy,locale)=>({now:snapshot.session.createdAt+86400000,days:30,privacy,locale,analysis_depth:'evidence'})
const reportFor=(snapshot,privacy='redacted',locale='en')=>buildReport([snapshot],options(snapshot,privacy,locale)).report
for(const vector of privacyValues) test(`new free-string report fields are privacy shaped: ${vector.name}`,()=>{
 for(const privacy of ['local','redacted','metrics']) for(const locale of ['en','zh-CN']) {
  const report=reportFor(privacySnapshot(vector.value),privacy,locale)
  const json=JSON.stringify(report),html=renderMemory(report,renderReport)
  // Decode the embedded report JSON so HTML escaping cannot hide a leak.
  const embedded=JSON.parse(html.match(/<script id="report-data"[^>]*>([\s\S]*?)<\/script>/)[1])
  assert.deepEqual(embedded,JSON.parse(json))
  if(vector.sensitive && (privacy!=='local'||vector.forbidden)) {
   const forbidden=vector.forbidden||vector.value
   assert.ok(!json.includes(JSON.stringify(forbidden).slice(1,-1)),`${privacy}: ${forbidden}`)
   assert.ok(!JSON.stringify(embedded).includes(JSON.stringify(forbidden).slice(1,-1)))
  }
  if(privacy==='metrics') assert.ok(!json.includes(vector.value),vector.name)
  const jobs=report.session_summaries[0].jobs
  assert.deepEqual(jobs.by_kind,report.totals.jobs.by_kind)
  assert.equal(jobs.by_kind[jobs.items[0].kind],1)
  assert.equal(Object.values(report.totals.team.members_by_phase).reduce((a,b)=>a+b,0),1)
 }
})
test('normal producer kinds and standard vocabulary stay meaningful; collisions retain counts',()=>{
 for(const privacy of ['local','redacted','metrics']) {
  for(const kind of ['bash','pwsh','pty-send','workflow','subagent']) {
   const report=reportFor(privacySnapshot(kind),privacy)
   assert.equal(report.totals.jobs.by_kind[kind],1)
   assert.equal(report.session_summaries[0].jobs.items[0].kind,kind)
  }
 }
 const one=privacySnapshot('api_key'+'=synthetic-one'),two=privacySnapshot('api_key'+'=synthetic-two')
 two.session.id+='-two'
 const {report}=buildReport([one,two],options(one,'redacted','en'))
 assert.equal(Object.values(report.totals.jobs.by_kind).reduce((a,b)=>a+b,0),2)
 assert.equal(report.totals.jobs.registered,2)
})
test('descriptor unexpected nested data is never projected as raw content',()=>{
 const snapshot=privacySnapshot('safe')
 const data=snapshot.events.find(event=>event.type==='subagent/descriptor').data
 for(const key of ['version','mode','provider','agentProvider','agentModel']) data[key]={raw:'/synthetic/private/nested'}
 for(const privacy of ['redacted','metrics']) {
  const report=reportFor(snapshot,privacy)
  assert.deepEqual(report.session_summaries[0].subagent,{version:null,mode:null,provider:null,agent_provider:null,agent_model:null})
  assert.ok(!JSON.stringify(report).includes('/synthetic/private/nested'))
 }
})
test('subagent_fork contributes to existing subagent usage and delegation counters',()=>{
 const snapshot=JSON.parse(readFileSync(new URL('../tests/fixtures/rc21/subagent/snapshot.json',import.meta.url),'utf8'))
 snapshot.events.find(event=>event.type==='tool/call'&&event.data.name==='subagent').data.name='subagent_fork'
 const report=reportFor(snapshot)
 assert.equal(report.totals.subagents,1)
 assert.equal(report.session_summaries[0].subagents,1)
 assert.equal(report.totals.delegation.dispatches_by_tool.subagent_fork,1)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildReport} from '../plugin/lib/analyzer.js'
import {validateV4} from '../plugin/lib/v4.js'
const root=new URL('../tests/fixtures/rc2-repairs/',import.meta.url)
for(const {name,expected} of JSON.parse(readFileSync(new URL('expectations.json',root)))) {
 test(`target admitted repair regression: ${name}`,()=>{
  const [session,...events]=readFileSync(new URL(name+'/session.v4.jsonl',root),'utf8').trim().split('\n').map(JSON.parse)
  const snapshot={session,events},cut=validateV4(snapshot)
  if(expected.cut!==undefined)assert.equal(cut,expected.cut)
  const r=buildReport([snapshot],{now:session.createdAt+86400000,days:30,privacy:'redacted',locale:'en',analysis_depth:'evidence'}).report
  assert.equal(r.totals.tool_failures,expected.failures)
  assert.equal(r.totals.permission_blocks,expected.permission)
  assert.deepEqual(r.totals.tool_recovery,{outcome_unknown:expected.recovery?.[0]??0,not_started:expected.recovery?.[1]??0})
  const s=r.session_summaries[0]
  assert.equal(s.verification.successes,expected.success)
  assert.equal(s.verification.failures,expected.verificationFailures??0)
  assert.equal(s.tool_execution.inner_incomplete,expected.pending??0)
  assert.deepEqual(s.tool_recovery,{outcome_unknown:expected.recovery?.[0]??0,not_started:expected.recovery?.[1]??0})
 })
}
test('nested seed still rejects an earlier marker as the declared inherited cut',()=>{
 const [session,...events]=readFileSync(new URL('nested-seed/session.v4.jsonl',root),'utf8').trim().split('\n').map(JSON.parse)
 assert.throws(()=>validateV4({session,events,inheritedEventCount:10}),/cut/)
})
test('a settled call keeps its outcome and a late recovery result is not counted',()=>{
 const [session,...events]=readFileSync(new URL('recovery-text-only/session.v4.jsonl',root),'utf8').trim().split('\n').map(JSON.parse)
 // Hand-built beyond official admission (the strict catalog rejects a second
 // result): one success settles the call, then an official-shaped recovery
 // result for the same call scope must not double-count or overwrite it.
 events[5].data.message.isError=false
 events[5].data.message.content=[{type:'text',text:'Command completed'}]
 const result=structuredClone(events[5])
 result.data.message.id='late-recovery'
 result.data.error={name:'ToolOutcomeUnknownError',code:'TOOL_OUTCOME_UNKNOWN'}
 events.splice(6,0,result)
 events.forEach((e,i)=>{e.seq=i})
 const snapshot={session,events}
 validateV4(snapshot)
 const r=buildReport([snapshot],{now:session.createdAt+86400000,days:30,privacy:'redacted',locale:'en',analysis_depth:'evidence'}).report
 assert.equal(r.totals.tool_failures,0)
 assert.deepEqual(r.session_summaries[0].verification,{successes:1,failures:0,kinds:{bash:1}})
 assert.deepEqual(r.totals.tool_recovery,{outcome_unknown:0,not_started:0})
})
test('recovery counts are stable across repeated analysis of one snapshot',()=>{
 const [session,...events]=readFileSync(new URL('recovery-mixed-group/session.v4.jsonl',root),'utf8').trim().split('\n').map(JSON.parse)
 const snapshot={session,events}
 const options={now:session.createdAt+86400000,days:30,privacy:'redacted',locale:'en',analysis_depth:'evidence'}
 const first=buildReport([snapshot],options).report
 const second=buildReport([structuredClone(snapshot)],options).report
 assert.deepEqual(second.totals.tool_recovery,first.totals.tool_recovery)
 assert.deepEqual(first.totals.tool_recovery,{outcome_unknown:1,not_started:1})
 assert.equal(first.totals.tool_failures,1)
})

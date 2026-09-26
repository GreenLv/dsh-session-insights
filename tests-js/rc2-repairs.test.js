import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildReport} from '../plugin/lib/analyzer.js'
import {validateV4} from '../plugin/lib/v4.js'
const root=new URL('../tests/fixtures/rc2-repairs/',import.meta.url)
for(const {name,expected} of JSON.parse(readFileSync(new URL('expectations.json',root)))) {
 test(`rc.2 admitted repair regression: ${name}`,()=>{
  const [session,...events]=readFileSync(new URL(name+'/session.v4.jsonl',root),'utf8').trim().split('\n').map(JSON.parse)
  const snapshot={session,events},cut=validateV4(snapshot)
  if(expected.cut!==undefined)assert.equal(cut,expected.cut)
  const r=buildReport([snapshot],{now:session.createdAt+86400000,days:30,privacy:'redacted',locale:'en',analysis_depth:'evidence'}).report
  assert.equal(r.totals.tool_failures,expected.failures)
  assert.equal(r.totals.permission_blocks,expected.permission)
  const s=r.session_summaries[0]
  assert.equal(s.verification.successes,expected.success)
  assert.equal(s.verification.failures,expected.verificationFailures??0)
  assert.equal(s.tool_execution.inner_incomplete,expected.pending??0)
 })
}
test('nested seed still rejects an earlier marker as the declared inherited cut',()=>{
 const [session,...events]=readFileSync(new URL('nested-seed/session.v4.jsonl',root),'utf8').trim().split('\n').map(JSON.parse)
 assert.throws(()=>validateV4({session,events,inheritedEventCount:10}),/cut/)
})

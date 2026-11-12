import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {resolve,join} from 'node:path'
import {readFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
import {HOST_TARGETS} from './acceptance_identity.mjs'
// The expected exact version must be the single acceptance target: the host
// catalog equals the product vocabulary exactly (no per-version subset or
// union exemptions), and unknown required events keep their explicit
// rejection. CI exports DSH_EXPECTED_VERSION per matrix entry.
const expectedVersion=process.env.DSH_EXPECTED_VERSION
if(!expectedVersion)throw new Error('exact expected DSH version required (set DSH_EXPECTED_VERSION for this runtime)')
if(expectedVersion!==HOST_TARGETS.primary)
  throw new Error(`expected version ${expectedVersion} is not the acceptance target (${HOST_TARGETS.primary})`)
const require=createRequire(join(resolve(process.argv[2]),'package.json'))
const {sessionFormatCatalog}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
const {KNOWN_SESSION_EVENT_TYPES}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
const {default:rules}=await import('../plugin/lib/rules.js')
assert.deepEqual([...KNOWN_SESSION_EVENT_TYPES].sort(),rules.DSH_KNOWN_RECORD_TYPES.filter(t=>t!=='session').sort(),
  `the host catalog for ${expectedVersion} must equal the product vocabulary exactly`)
const rows=(await readFile(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse)
function restore(records){const reader=sessionFormatCatalog.createRestore(records[0],{recovery:'strict',validation:'current'});for(const row of records.slice(1))reader.decodeRow(row);return reader.finish()}
assert.equal(restore(rows).events.length,10)
const cases=[
 ['old producer wrapper',r=>r[3].data.source={kind:'plugin',plugin:'test'},/producer-owned source/],
 ['tool role',r=>r[6].data.message.role='user',/tool/],
 ['call identity',r=>r[6].data.message.toolCallId='other',/call|tool/i],
 ['bad reference',r=>r[3].sourceEventSeqs=[99],/sourceEventSeqs|seq/i],
 ['broken sequence',r=>r[4].seq=50,/seq/i],
 ['settled call result repeat',r=>{r.splice(7,0,structuredClone(r[6]));r.slice(1).forEach((e,i)=>e.seq=i)},/lifecycle|result/i],
]
for(const [label,mutate,expected] of cases){const copy=structuredClone(rows);mutate(copy);assert.throws(()=>restore(copy),expected,label)}
// Session.append contract: the product never wraps append, but its fixtures
// and service probes rely on the real signatures. rc.2 keeps the single-event
// call (one event returned) and adds the array overload (upstream guide
// docs/upgrade-guide/v0.2.2-rc.1/session-append-overloads): single stays
// single, arrays commit in order and return the committed events.
const {Session}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
{
  const probe=Session.create('append-overload-probe')
  const single=probe.append('turn/start',{turn:1})
  assert.equal(typeof single.seq,'number','single append must return one committed event')
  assert.equal(single.type,'turn/start')
  const batch=probe.append([
    ['step/start',{turn:1,step:1}],
    ['step/end',{turn:1,step:1}],
    ['turn/end',{turn:1,reason:{kind:'completed'}}],
  ])
  assert.ok(Array.isArray(batch),'array append must return the committed events as an array')
  assert.equal(batch.length,3)
  assert.deepEqual(batch.map(e=>e.type),['step/start','step/end','turn/end'])
  assert.deepEqual(batch.map(e=>e.seq),[single.seq+1,single.seq+2,single.seq+3],'batch commit must keep order and contiguous seq')
}
console.log(JSON.stringify({status:'pass',scope:'official target strict catalog',targetVersion:expectedVersion,positiveEvents:10,negativeCases:cases.map(c=>c[0]),knownEvents:KNOWN_SESSION_EVENT_TYPES.size}))

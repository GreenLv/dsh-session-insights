import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {resolve,join} from 'node:path'
import {readFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
const require=createRequire(join(resolve(process.argv[2]),'package.json'))
const {sessionFormatCatalog}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
const {KNOWN_SESSION_EVENT_TYPES}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
const {default:rules}=await import('../plugin/lib/rules.js')
assert.deepEqual([...KNOWN_SESSION_EVENT_TYPES].sort(),rules.DSH_KNOWN_RECORD_TYPES.filter(t=>t!=='session').sort())
const rows=(await readFile(new URL('../tests/fixtures/synthetic-session.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse)
function restore(records){const reader=sessionFormatCatalog.createRestore(records[0],{recovery:'strict',validation:'current'});for(const row of records.slice(1))reader.decodeRow(row);return reader.finish()}
assert.equal(restore(rows).events.length,10)
const cases=[
 ['old producer wrapper',r=>r[3].data.source={kind:'plugin',plugin:'test'},/producer-owned source/],
 ['tool role',r=>r[6].data.message.role='user',/tool/],
 ['call identity',r=>r[6].data.message.toolCallId='other',/call|tool/i],
 ['bad reference',r=>r[3].sourceEventSeqs=[99],/sourceEventSeqs|seq/i],
 ['broken sequence',r=>r[4].seq=50,/seq/i],
]
for(const [label,mutate,expected] of cases){const copy=structuredClone(rows);mutate(copy);assert.throws(()=>restore(copy),expected,label)}
console.log(JSON.stringify({status:'pass',scope:'official rc.2 strict catalog',positiveEvents:10,negativeCases:cases.map(c=>c[0]),knownEvents:KNOWN_SESSION_EVENT_TYPES.size}))

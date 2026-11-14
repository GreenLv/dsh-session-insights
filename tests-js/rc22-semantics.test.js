import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport } from '../plugin/lib/analyzer.js'
import { validateV4, INPUT_IDENTITY } from '../plugin/lib/v4.js'
import { targetRequire, assertTargetPackage } from './fixtures/target-runtime.mjs'
import { Store } from '../plugin/lib/storage.js'
import { prepareSemantic, getBatch } from '../plugin/lib/semantic.js'

// rc.2 semantic regressions on the native side: structured approval non-grants
// and the team/mode lifecycle. Structured codes are matched by their persisted
// identity, never by success text; team configuration never upgrades into user
// work, authorization or completion. The rc.2-only team/mode fixture is also
// checked through the sole supported rc.2 catalog and V4 admission. Historical
// fixture names describe data provenance, not an older supported host.
const rows = JSON.parse('[' + readFileSync(new URL('../tests/fixtures/synthetic-session.jsonl', import.meta.url), 'utf8').trim().split('\n').join(',') + ']')
const options = { now: rows[0].createdAt + 86400000, days: 30, privacy: 'redacted', locale: 'en', analysis_depth: 'evidence' }
const snapshot = () => {
  const [header, ...events] = structuredClone(rows)
  delete header.type
  return { session: header, events, inheritedEventCount: 0 }
}
const withResultError = (error, { infoVariant = false } = {}) => {
  const s = snapshot()
  const result = s.events[5]
  result.data.message.isError = true
  result.data.message.content = [{ type: 'text', text: 'Command completed successfully' }]
  result.data.error = infoVariant ? { message: 'approval denial', info: error } : error
  return s
}
const report = (s) => buildReport([s], options).report
const blockedFacts = (built) =>
  built.sessions[0].messages.filter((m) => m.tool_facts?.outcome === 'blocked').map((m) => m.tool_facts)

test('identity targets rc.3 semantics', () => {
  assert.equal(INPUT_IDENTITY.target_dsh_version, '0.2.2-rc.3')
  assert.equal(INPUT_IDENTITY.analyzer_semantics, 'v4-dsh022rc3.1')
})

test('APPROVAL_CANCELLED is neither caller cancellation nor human rejection', () => {
  const built = buildReport([withResultError({ name: 'ApprovalError', code: 'APPROVAL_CANCELLED', reason: 'the approval window was cancelled' })], options)
  const t = built.report.session_summaries[0].tool_execution
  assert.equal(t.approval_cancelled, 1)
  assert.equal(t.outer_cancelled, 0)
  assert.equal(t.outer_failures, 0)
  assert.equal(built.report.totals.tool_failures, 0)
  assert.equal(built.report.session_summaries[0].permission_blocks, 0)
  assert.equal(built.report.session_summaries[0].denied_approvals, 0)
  assert.equal(built.report.session_summaries[0].verification.successes, 0, 'success text must not classify a blocked call')
  const facts = blockedFacts(built)
  assert.equal(facts.length, 1)
  assert.equal(facts[0].approval, 'APPROVAL_CANCELLED')
  assert.equal(facts[0].cause, null)
})

test('APPROVAL_UNAVAILABLE is not a human rejection', () => {
  const built = buildReport([withResultError({ name: 'ApprovalError', code: 'APPROVAL_UNAVAILABLE' })], options)
  const t = built.report.session_summaries[0].tool_execution
  assert.equal(t.approval_unavailable, 1)
  assert.equal(t.approval_cancelled, 0)
  assert.equal(built.report.totals.tool_failures, 0)
  assert.equal(built.report.session_summaries[0].permission_blocks, 0)
})

test('error.info.code variant carries the same classification', () => {
  const built = buildReport([withResultError({ name: 'ApprovalError', code: 'APPROVAL_UNAVAILABLE' }, { infoVariant: true })], options)
  assert.equal(built.report.session_summaries[0].tool_execution.approval_unavailable, 1)
  assert.equal(built.report.totals.tool_failures, 0)
})

test('identical approval non-grants in separate turns retain separate evidence', async () => {
  const [session, ...events] = readFileSync(new URL('../tests/fixtures/rc1-cancellation/repeated-cancellation/session.v4.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
  for (const event of events)
    if (event.type === 'tool/result') event.data.error = { name: 'ApprovalError', code: 'APPROVAL_CANCELLED' }
  assertTargetPackage('@deepseek-ai/dsh-session-format-catalog')
  const { sessionFormatCatalog } = await import(pathToFileURL(targetRequire.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const restore = sessionFormatCatalog.createRestore(session, { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(event)
  restore.finish()
  const built = buildReport([{ session, events }], { ...options, now: session.createdAt + 86400000 })
  assert.equal(built.report.session_summaries[0].tool_execution.approval_cancelled, 2)
  const facts = blockedFacts(built)
  assert.equal(facts.length, 2, 'distinct call scopes must not collapse because their summaries match')
  assert.deepEqual(facts.map(f => f.turn), [1, 2])
  assert.equal(new Set(facts.map(f => f.record_identity)).size, 2)
  const home = mkdtempSync(join(tmpdir(), 'dsi-approval-evidence-'))
  try {
    const store = new Store(home), run = store.create()
    const prepared = prepareSemantic(store, run, built)
    const evidence = prepared.batches.flatMap(id => getBatch(store, run, id).tasks)
      .flatMap(task => task.evidence).filter(item => item.tool_facts?.outcome === 'blocked')
    assert.equal(evidence.length, 2, 'both recorded non-grants must reach the semantic consumer')
    assert.equal(new Set(evidence.map(item => item.id)).size, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('APPROVAL_REJECTED is a permission boundary failure', () => {
  const built = buildReport([withResultError({ name: 'ApprovalError', code: 'APPROVAL_REJECTED', reason: 'the user rejected tool bash' })], options)
  const t = built.report.session_summaries[0].tool_execution
  assert.equal(t.approval_cancelled, 0)
  assert.equal(t.approval_unavailable, 0)
  assert.equal(t.outer_failures, 1)
  assert.equal(built.report.totals.tool_failures, 1)
  assert.equal(built.report.session_summaries[0].permission_blocks, 1)
})

test('text mentioning approval codes never creates blocked facts', () => {
  const s = snapshot()
  s.events[5].data.message.isError = true
  s.events[5].data.message.content = [{ type: 'text', text: 'APPROVAL_UNAVAILABLE APPROVAL_CANCELLED happened' }]
  const built = buildReport([s], options)
  assert.equal(blockedFacts(built).length, 0)
  assert.equal(built.report.totals.tool_failures, 1)
})

test('team/mode is configuration context, counted once per record', () => {
  const s = snapshot()
  s.events.push({ type: 'team/mode', data: { enabled: true }, seq: s.events.length, time: options.now - 100 })
  const built = buildReport([s], options)
  assert.equal(built.report.session_summaries[0].team.mode_changes, 1)
  assert.equal(built.report.totals.team.mode_changes, 1)
  assert.equal(built.report.totals.task_started, 1, 'team/mode must not create a user task')
  assert.equal(built.report.totals.permission_blocks, 0)
})

test('non-boolean and absent team/mode data stay at zero', () => {
  const s = snapshot()
  s.events.push({ type: 'team/mode', data: {}, seq: s.events.length, time: options.now - 100 })
  assert.equal(report(s).session_summaries[0].team.mode_changes, 0)
  // rc.1-shaped log without the event at all.
  assert.equal(report(snapshot()).session_summaries[0].team.mode_changes, 0)
})

test('V4 admission accepts the rc.2-only team/mode corpus', () => {
  const [header, ...events] = readFileSync(new URL('../tests/fixtures/rc22/session.v4.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
  delete header.type
  const s = { session: header, events, inheritedEventCount: 0 }
  assert.equal(validateV4(s), 0)
  const built = buildReport([s], options)
  assert.equal(built.report.session_summaries[0].team.mode_changes, 1)
})

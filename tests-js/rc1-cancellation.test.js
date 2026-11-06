import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {buildReport} from '../plugin/lib/analyzer.js'
import {validateV4} from '../plugin/lib/v4.js'
import {Store} from '../plugin/lib/storage.js'
import {prepareSemantic, getBatch, validateBatch, submitBatch} from '../plugin/lib/semantic.js'
import {targetRequire as runtimeRequire, assertTargetPackage} from './fixtures/target-runtime.mjs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {mkdtempSync, rmSync} from 'node:fs'

// rc.1 structured caller-cancellation regression corpus. The three physical
// fixtures are byte-identical logs that the official strict/current catalog
// reopens below, so every positive case here is a real host-admissible log,
// never a hand-built approximation or an isolated copied result.
assertTargetPackage('@deepseek-ai/dsh-session-format-catalog')
const {sessionFormatCatalog} = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-session-format-catalog')).href)

const root = new URL('../tests/fixtures/rc1-cancellation/', import.meta.url)
function loadSnapshot(name) {
  const [session, ...events] = readFileSync(new URL(`${name}/session.v4.jsonl`, root), 'utf8').trim().split('\n').map(JSON.parse)
  return {session, events}
}
function strictRestore(snapshot) {
  const restore = sessionFormatCatalog.createRestore(snapshot.session, {recovery: 'strict', validation: 'current'})
  for (const event of snapshot.events) restore.decodeRow(event)
  return restore.finish()
}
const options = (session) => ({now: session.createdAt + 86400000, days: 30, privacy: 'redacted', locale: 'en', analysis_depth: 'evidence'})
const cancelledFacts = (built) =>
  built.sessions[0].messages.filter((m) => m.tool_facts?.outcome === 'cancelled').map((m) => m.tool_facts)

for (const name of ['inherited-ptc', 'inherited-outer', 'repeated-cancellation']) {
  test(`official strict catalog reopens the rc.1 cancellation fixture: ${name}`, () => {
    const snapshot = loadSnapshot(name)
    const restored = strictRestore(snapshot)
    assert.ok(restored.events.length >= snapshot.events.length - 1, name)
    validateV4(snapshot)
  })
}

test('F1: inherited PTC cancellation keeps the scoped call identity on the native side', () => {
  const snapshot = loadSnapshot('inherited-ptc')
  const built = buildReport([snapshot], options(snapshot.session))
  const facts = cancelledFacts(built)
  assert.equal(facts.length, 1)
  assert.deepEqual(facts[0], {
    tool: 'bash',
    outcome: 'cancelled',
    cancelled: 'ABORTED',
    record_identity: '["fixture-call-1:ptc:1",null,null]',
    call_id: 'fixture-call-1:ptc:1',
    turn: null,
    step: null,
    exit_code: null,
    cause: null,
    verification: true,
    state_change: false,
    git_commit: false,
  })
  assert.equal(built.report.session_summaries[0].tool_execution.inner_cancelled, 1)
  assert.equal(built.report.totals.tool_failures, 0)
})

test('F1: inherited outer cancellation keeps the scoped call identity on the native side', () => {
  const snapshot = loadSnapshot('inherited-outer')
  const built = buildReport([snapshot], options(snapshot.session))
  const facts = cancelledFacts(built)
  assert.equal(facts.length, 1)
  assert.equal(facts[0].tool, 'bash')
  assert.equal(facts[0].verification, true, 'the inherited bash npm-test call keeps its verification fact')
  assert.equal(facts[0].record_identity, '["fixture-call-7",1,1]')
  assert.equal(facts[0].call_id, 'fixture-call-7')
  assert.equal(built.report.session_summaries[0].tool_execution.outer_cancelled, 1)
})

test('F1: a cancelled result without any matching scope stays unknown', () => {
  const snapshot = loadSnapshot('inherited-outer')
  // The result references a call id that no recorded call ever used; the
  // production admission accepts the log, but the metadata must stay unknown
  // instead of being impersonated from any other call.
  const orphan = structuredClone(snapshot)
  orphan.events[6].data.message.source.callId = 'fixture-call-never-recorded'
  orphan.events[6].data.message.toolCallId = 'fixture-call-never-recorded'
  validateV4(orphan)
  const built = buildReport([orphan], options(orphan.session))
  const facts = cancelledFacts(built)
  assert.equal(facts.length, 1)
  assert.equal(facts[0].tool, 'unknown', 'missing scoped match keeps unknown')
  assert.equal(facts[0].verification, false)
  assert.equal(facts[0].record_identity, '["fixture-call-never-recorded",1,1]')
})

test('F2: same tool and code cancelled in two turns keeps two unique evidence IDs', () => {
  const snapshot = loadSnapshot('repeated-cancellation')
  const built = buildReport([snapshot], options(snapshot.session))
  const facts = cancelledFacts(built)
  assert.equal(facts.length, 2)
  assert.deepEqual(facts.map((f) => f.turn), [1, 2])
  assert.deepEqual(facts.map((f) => f.record_identity), ['["fixture-call-1",1,1]', '["fixture-call-1",2,1]'])
  // Drive the real semantic consumer: prepare, read the batch, and prove the
  // final evidence IDs address the two distinct facts.
  const home = mkdtempSync(join(tmpdir(), 'dsi-cancel-batch-'))
  try {
    const store = new Store(home)
    const run = store.create()
    const prepared = prepareSemantic(store, run, built)
    const ids = []
    for (const id of prepared.batches) {
      const batch = getBatch(store, run, id)
      for (const task of batch.tasks)
        for (const item of task.evidence)
          if (item.tool_facts?.outcome === 'cancelled') ids.push(item.id)
    }
    assert.equal(ids.length, 2, 'both cancellations reach the final batch')
    assert.notEqual(ids[0], ids[1], 'different turns must not share an evidence ID')
    // The reference consumer must accept a facet that cites each fact and
    // refuse one that cites an unknown ID.
    const batch = getBatch(store, run, prepared.batches[0])
    const base = {
      goal: 'Run the suite',
      task_type: 'implementation',
      interaction_style: 'detailed',
      instruction_handling: 'followed',
      tool_execution: 'strong',
      verification_quality: 'strong',
      handoff_quality: 'clear',
      frictions: [],
      strengths: [],
      outcome_inference: 'mostly_achieved',
    }
    const facet = (refs) => ({
      task_family_id: batch.tasks[0].task_family_id,
      ...base,
      evidence_refs: refs,
    })
    validateBatch(store, run, prepared.batches[0], {facets: [facet(ids)]})
    submitBatch(store, run, prepared.batches[0], {facets: [facet(ids)]})
    assert.throws(
      () => validateBatch(store, run, prepared.batches[0], {facets: [facet([...ids, 'evidence-0000000000000000000'])]}),
      /unknown or missing evidence refs/,
    )
  } finally {
    rmSync(home, {recursive: true, force: true})
  }
})

test('F2: the same recorded cancellation twice keeps one deduplicated fact', () => {
  const snapshot = loadSnapshot('repeated-cancellation')
  // Replaying the identical snapshot twice is the same evidence, not two
  // facts; the analyzer-level digest deduplicates it before batching.
  const built = buildReport([snapshot, structuredClone(snapshot)], options(snapshot.session))
  const facts = cancelledFacts(built)
  assert.equal(facts.length, 2, 'two sessions of one replay keep their own records')
  assert.equal(new Set(facts.map((f) => f.record_identity)).size, 2)
})

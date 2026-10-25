// DSI-AUDIT-20261023 regression tests: production call chains for the native
// runtime (F4-F11, G2). Synthetic data only; each refusal has a positive
// control so a blanket rejection cannot pass.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReport, secretErrors, projectIdOf, calendarInZone, validateReportTimezone } from '../plugin/lib/analyzer.js'
import {
  prepareSemantic, getBatch, submitBatch, prepareAggregate, submitAggregate,
  finalize, facetsDigest, aggregateFreshness, projectForAnalysis,
} from '../plugin/lib/semantic.js'
import { Store } from '../plugin/lib/storage.js'
import { validateV4 } from '../plugin/lib/v4.js'
import { apply, _test } from '../plugin/lib/index.js'

const NOW = 1786423200000
const urlVectors = JSON.parse(readFileSync(new URL('../tests/fixtures/url-sanitize-vectors.json', import.meta.url), 'utf8'))
const identityVectors = JSON.parse(readFileSync(new URL('../tests/fixtures/project-identity-vectors.json', import.meta.url), 'utf8'))
const tzVectors = JSON.parse(readFileSync(new URL('../tests/fixtures/report-timezone-vectors.json', import.meta.url), 'utf8'))
const digestVectors = JSON.parse(readFileSync(new URL('../tests/fixtures/aggregate-digest-vectors.json', import.meta.url), 'utf8'))

function snapshot(index, cwd, extraEvents = [], createdAt = NOW) {
  const events = [
    { type: 'turn/start', seq: 0, time: createdAt, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: createdAt, surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `Implement the synthetic fixture ${index}.` }],
        id: `m-user-${index}`, role: 'user', source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: createdAt, surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'Keep the change narrow.' }],
        id: `m-user2-${index}`, role: 'user', source: { kind: 'user' } } },
    { type: 'turn/end', seq: 3, time: createdAt + 1000, data: { reason: { kind: 'completed' }, turn: 1 } },
  ]
  let seq = 4
  for (const event of extraEvents) events.push({ seq: seq++, time: createdAt, ...event })
  return {
    session: { type: 'session', version: 4, id: `synthetic-${index}`, createdAt, cwd,
      agentPreset: 'standard', delegationDepth: 0, isSeeded: false },
    events,
  }
}

function facetFor(task, goal) {
  return {
    task_family_id: task.task_family_id, goal, task_type: 'implementation',
    interaction_style: 'detailed', instruction_handling: 'followed', tool_execution: 'strong',
    verification_quality: 'strong', handoff_quality: 'clear',
    frictions: ['none'], strengths: ['clear goal'], outcome_inference: 'fully_achieved',
    evidence_refs: task.evidence.slice(0, 1).map((item) => item.id),
  }
}

function aggregateFor(store, run) {
  const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'))
  const candidates = JSON.parse(readFileSync(join(run, 'semantic-evidence.json'), 'utf8')).candidates
  const family = candidates[0].task_family_id
  const evidence = candidates[0].evidence[0].id
  const value = { semantic_schema_version: '1.2.0' }
  for (const section of ['glance', 'workflows', 'operating_style', 'strengths', 'frictions', 'recommendations', 'horizon'])
    value[section] = []
  value.strengths = [{ title: '稳定交付', text: '会话完成目标。',
    supporting_task_family_ids: [family], evidence_refs: [evidence],
    confidence: 'high', measurement: 'measured' }]
  // The response names the prepared input it answers; callers run
  // prepareAggregate first so the issued identity matches the current facets.
  value.aggregate_input_identity = JSON.parse(readFileSync(join(run, 'aggregate-input-identity.json'), 'utf8'))
  return value
}

// --- F4: aggregate model input obeys analysis privacy ----------------------
test('F4: aggregate full_scope_summary projects report-side fields by analysis privacy', () => {
  const snap = snapshot(1, '/synthetic/customer-a/app', [
    { type: 'job/registered', data: { jobId: 'j1', owner: 'synthetic', kind: '/synthetic/private/path task', label: 'label', startedAt: NOW } },
    { type: 'job/settled', data: { jobId: 'j1', owner: 'synthetic', kind: '/synthetic/private/path task', label: 'label', startedAt: NOW, finishedAt: NOW + 5, status: 'completed', cause: 'producer', producerReported: true } },
  ])
  validateV4(snap)
  const tmp = mkdtempSync(join(tmpdir(), 'f4-'))
  try {
    const built = buildReport([snap], { privacy: 'local', analysis_privacy: 'redacted', now: NOW + 60000, days: 30, locale: 'zh-CN', analysis_depth: 'evidence' })
    const store = new Store(tmp)
    const run = store.create()
    prepareSemantic(store, run, built)
    const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'))
    for (const id of manifest.batch_ids) {
      const batch = getBatch(store, run, id)
      submitBatch(store, run, id, { facets: batch.tasks.map((t) => facetFor(t, '实现完成')) })
    }
    const aggInput = prepareAggregate(store, run)
    const serialized = JSON.stringify(aggInput.full_scope_summary)
    assert.ok(!serialized.includes('/synthetic/private/path'), 'private job kind leaked into model input')
    // Positive control: the local/redacted pair still completes the flow.
    submitAggregate(store, run, aggregateFor(store, run))
    const result = finalize(store, run)
    assert.equal(result.status, 'complete')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('F4: model-input projection scrubs values and keys across shapes', () => {
  const projected = projectForAnalysis({
    a: '/synthetic/private/path task',
    b: ['alice+audit@example.invalid'],
    c: 3,
    d: { 'Bearer SYNTHETIC-TOKEN-1234567890': true, nested: { path: 'C:\\Users\\someone\\secret' } },
    ok: 'measured',
  }, 'redacted')
  assert.deepEqual(projected, {
    a: '<path> task', b: ['<redacted-email>'], c: 3,
    d: { 'Bearer <redacted>': true, nested: { path: '~\\secret' } }, ok: 'measured',
  })
  // local keeps readable text while still removing credentials
  const localView = projectForAnalysis({ a: 'Bearer SYNTHETIC-TOKEN-1234567890' }, 'local')
  assert.deepEqual(localView, { a: 'Bearer <redacted>' })
})

// --- F5: injected source kinds are never raw extension strings -------------
test('F5: injected_source_kinds use the source vocabulary with pseudonyms', () => {
  const secretKind = 'Bearer SYNTHETIC-TOKEN-1234567890'
  const snap = snapshot(1, '/synthetic/customer-a/app', [
    { type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'extension note' }], id: 'm-inj', role: 'user', source: { kind: secretKind } } },
    { type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'settled notice' }], id: 'm-inj2', role: 'user', source: { kind: 'subagent-settled' } } },
  ])
  validateV4(snap) // the official admission accepts a free source.kind string
  for (const privacy of ['redacted', 'metrics', 'local']) {
    const report = buildReport([snap], { privacy, now: NOW + 60000, days: 30, locale: 'zh-CN' }).report
    const kinds = report.rollout_summaries[0].injected_source_kinds
    const serialized = JSON.stringify(kinds)
    assert.ok(!serialized.includes('SYNTHETIC-TOKEN'), `${privacy} leaked the raw kind`)
    assert.equal(kinds['subagent-settled'], 1, `${privacy} keeps the documented kind readable`)
    // the injected notice is still counted as synthetic context, never human
    assert.equal(report.rollout_summaries[0].injected_user_messages, 2)
    assert.equal(report.rollout_summaries[0].user_messages, 2)
    assert.equal(report.totals.delegation.settlements, 1)
  }
  const redacted = buildReport([snap], { privacy: 'redacted', now: NOW + 60000, days: 30, locale: 'zh-CN' }).report
  assert.ok(!('Bearer SYNTHETIC-TOKEN-1234567890' in redacted.rollout_summaries[0].injected_source_kinds))
})

// --- F6: model output validation covers identity categories -----------------
test('F6: output validation rejects emails, URLs and paths by report privacy', () => {
  assert.deepEqual(secretErrors({ text: 'contact alice+audit@example.invalid' }, 'redacted'),
    ['redacted output contains an email address'])
  assert.deepEqual(secretErrors({ text: 'contact alice+audit@example.invalid' }, 'local'), [])
  assert.deepEqual(secretErrors({ text: 'see https://u:p@example.invalid/x' }, 'local'),
    ['output contains a URL with credentials or query'])
  assert.deepEqual(secretErrors({ 'C:\\Users\\someone\\file': 1 }, 'redacted'),
    ['redacted output contains an absolute path'])
  // object keys are checked as strings, so JSON escaping cannot hide content
  assert.deepEqual(secretErrors({ key: 'mailto bob+ops@example.invalid' }, 'redacted'),
    ['redacted output contains an email address'])
  // positive control: evidence IDs, dates and plain text stay valid
  assert.deepEqual(secretErrors({ text: 'evidence-abc123 done 2026-10-23' }, 'redacted'), [])
})

// --- F8: entry path normalization -------------------------------------------
test('F8: native entry refuses relative project paths with an actionable error', () => {
  for (const value of ['.', 'src', 'a/b', '~workspace'])
    assert.throws(() => _test.normalizeOptions({ project: value }), /project must be an absolute path/)
  assert.equal(_test.normalizeOptions({ project: '/synthetic/app/' }).project, '/synthetic/app')
  assert.equal(_test.normalizeProjectInput('C:\\Synthetic\\App\\', 'win32'), 'C:\\Synthetic\\App\\')

})

test('F8: selection, worker and resume share the canonical key', () => {
  const opts = _test.normalizeOptions({ project: '/synthetic/customer-a/app/', report_timezone: 'UTC' })
  const inside = snapshot(1, '/synthetic/customer-a/app/sub')
  const outside = snapshot(2, '/synthetic/customer-b/app')
  const coverageIn = { skipped_project: 0, skipped_outside_window: 0 }
  const coverageOut = { skipped_project: 0, skipped_outside_window: 0 }
  const { parseSnapshot } = await_import_free()
  parseSnapshot(inside, { ...opts, now: NOW + 60000, days: 30 }, coverageIn)
  parseSnapshot(outside, { ...opts, now: NOW + 60000, days: 30 }, coverageOut)
  assert.equal(coverageIn.skipped_project, 0)
  assert.equal(coverageOut.skipped_project, 1)
  const scope = _test.requestedScope({ project: '/synthetic/customer-a/app/', report_timezone: 'UTC' })
  assert.equal(scope.project, '/synthetic/customer-a/app')
  // a different project is a different recorded scope, not a widening alias
  assert.notEqual(_test.requestedScope({ project: '/synthetic/customer-a/app/other', report_timezone: 'UTC' }).project, scope.project)
})

function await_import_free() {
  // parseSnapshot is exported indirectly through the analyzer module already
  // imported; keep this file free of top-level await for broader tooling.
  return analyzerExports
}

import * as analyzerExports from '../plugin/lib/analyzer.js'

// --- F9: project identity ----------------------------------------------------
test('F9: project identity vectors match the frozen shared fixture', () => {
  for (const vector of identityVectors.cases)
    assert.equal(projectIdOf(vector.cwd), vector.project_id, vector.name)
})

test('F9: same-basename projects stay separate with anonymous suffixes', () => {
  const report = buildReport(
    [snapshot(1, '/synthetic/customer-a/app'), snapshot(2, '/synthetic/customer-b/app'), snapshot(3, '/synthetic/customer-a/app')],
    { privacy: 'redacted', now: NOW + 60000, days: 30, locale: 'zh-CN' },
  ).report
  assert.equal(report.projects.length, 2)
  const byId = new Map(report.projects.map((p) => [p.project_id, p.project]))
  assert.deepEqual([...byId.keys()].sort(), ['project-5b2f395b840b', 'project-b518bab1ff92'])
  for (const label of byId.values()) {
    assert.notEqual(label, 'app')
    assert.match(label, /^app-[0-9a-f]{8}$/)
  }
  for (const row of report.rollout_summaries) assert.match(row.project_id, /^project-[0-9a-f]{12}$/)
  for (const family of report.task_families) assert.match(family.project_id, /^project-[0-9a-f]{12}$/)
  // counts are conserved across the split
  assert.equal(report.projects.reduce((n, p) => n + p.sessions, 0), 3)
})

// --- F10: report timezone -----------------------------------------------------
test('F10: shared timezone vectors hold in the native projection', () => {
  for (const vector of tzVectors.cases) {
    const got = calendarInZone(vector.instant_ms, vector.zone)
    assert.deepEqual(got, { date: vector.date, hour: vector.hour, weekday: vector.weekday }, vector.name)
  }
  assert.throws(() => validateReportTimezone('Nowhere/Central'), RangeError)
})

test('F10: report rows record the zone and manifest selection carries it', () => {
  const instant = tzVectors.cases[0].instant_ms
  const report = buildReport([snapshot(1, '/synthetic/app', [], instant)],
    { privacy: 'redacted', now: instant + 60000, days: 30, locale: 'zh-CN', report_timezone: 'Asia/Shanghai' }).report
  const row = report.rollout_summaries[0]
  assert.equal(row.date, '2026-10-23')
  assert.equal(row.start_hour_local, 1)
  assert.equal(row.weekday, 4)
  assert.equal(report.scope.report_timezone, 'Asia/Shanghai')
})

// --- F11: aggregate freshness -------------------------------------------------
test('F11: digest vectors match the frozen cross-language expectations', () => {
  for (const vector of digestVectors.cases)
    assert.equal(facetsDigest(vector.facets, { scope_fingerprint: digestVectors.manifest.scope_fingerprint }),
      vector.expected_digest, vector.name)
})

test('F11: stale aggregate refuses, rebuild recovers, fallback degrades explicitly', () => {
  const snap = snapshot(1, '/synthetic/customer-a/app')
  const tmp = mkdtempSync(join(tmpdir(), 'f11-'))
  try {
    const built = buildReport([snap], { privacy: 'redacted', now: NOW + 60000, days: 30, locale: 'zh-CN', analysis_depth: 'evidence', report_timezone: 'UTC' })
    const store = new Store(tmp)
    const run = store.create()
    prepareSemantic(store, run, built)
    const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'))
    const submit = (goal) => {
      for (const id of manifest.batch_ids) {
        const batch = getBatch(store, run, id)
        submitBatch(store, run, id, { facets: batch.tasks.map((t) => facetFor(t, goal)) })
      }
    }
    submit('实现完成')
    prepareAggregate(store, run)
    submitAggregate(store, run, aggregateFor(store, run))
    assert.equal(aggregateFreshness(store, run).status, 'current')
    const complete = finalize(store, run)
    assert.equal(complete.status, 'complete')

    // Same content resubmitted: idempotent, still current.
    submit('实现完成')
    prepareAggregate(store, run)
    submitAggregate(store, run, aggregateFor(store, run))
    assert.equal(aggregateFreshness(store, run).status, 'current')

    // Changed facet conclusion: the old aggregate must not complete. The
    // stale response names the earlier prepared input; acceptance recomputes
    // the input digest from the current facets and refuses it.
    submit('未实现完成')
    assert.throws(() => submitAggregate(store, run, aggregateFor(store, run)), /current validated aggregate input/)
    assert.equal(aggregateFreshness(store, run).status, 'stale')
    assert.throws(() => finalize(store, run), /aggregate is stale/)
    const fallback = finalize(store, run, true)
    assert.equal(fallback.status, 'fallback')

    // Positive recovery: re-prepare the input (new identity) and regenerate
    // the response against it — a genuine rebuild, not a re-stamp.
    prepareAggregate(store, run)
    submitAggregate(store, run, aggregateFor(store, run))
    assert.equal(aggregateFreshness(store, run).status, 'current')
    assert.equal(finalize(store, run).status, 'complete')

    // A manual facet edit with unchanged mtime cannot bypass the digest.
    const facetPath = join(run, 'facet-outputs', manifest.batch_ids[0] + '.json')
    const payload = JSON.parse(readFileSync(facetPath, 'utf8'))
    payload.facets[0].goal = '手工改写'
    const stats = statSync(facetPath)
    writeFileSync(facetPath, JSON.stringify(payload, null, 2) + '\n')
    utimesSync(facetPath, stats.atime, stats.mtime)
    assert.equal(aggregateFreshness(store, run).status, 'stale')

    // An aggregate file placed without the submit path is untrusted.
    rmSync(join(run, 'aggregate-binding.json'))
    assert.equal(aggregateFreshness(store, run).status, 'unbound')
    assert.throws(() => finalize(store, run), /not verified/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// --- G2: cleanup deletion requires a trusted human approval ------------------
function harnessWithApproval(outcome, { holdOpen = false } = {}) {
  const tools = []
  const requests = []
  apply({
    effect() {},
    commands: { register() {} },
    tools: { register(value) { tools.push(value) } },
    sessionQuery: {},
    approval: {
      // Shaped like the official ApprovalService.request prechecks: the agent
      // and call identity must be present, and cancellation settles
      // 'cancelled' without asking the answerer.
      async request(req) {
        assert.ok(req.agent !== undefined, 'approval request must carry the agent')
        assert.ok(req.callId !== undefined || req.toolName === 'session_insights_cleanup', 'approval request must identify the call')
        requests.push(req)
        if (req.signal?.aborted) return 'cancelled'
        if (holdOpen) {
          // Hold the decision open until the caller's signal aborts, so a
          // withdrawal during an in-flight request settles 'cancelled'.
          await new Promise((resolveWait) =>
            req.signal.addEventListener('abort', resolveWait, { once: true }))
          return 'cancelled'
        }
        return outcome
      },
    },
  })
  return { tools: new Map(tools.map((item) => [item.name, item])), requests }
}

test('G2: cleanup preview is read-only and deletion needs an allowed-once approval', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'g2-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const store = new Store(tmp)
    const run = store.create()
    store.write(run, 'report.json', { placeholder: true })

    const denied = harnessWithApproval('rejected')
    const cleanup = denied.tools.get('session_insights_cleanup')
    const preview = await cleanup.execute({ workdir: run }, { signal: null })
    const previewValue = JSON.parse(preview.text)
    assert.equal(previewValue.deleted, false)
    assert.equal(previewValue.files.length, 2) // marker + report.json
    assert.ok(previewValue.files.every((file) => typeof file.path === 'string'))

    // confirm=true with a rejected approval deletes nothing.
    await assert.rejects(
      () => cleanup.execute({ workdir: run, confirm: true }, { signal: null, agent: {}, callId: 'c1' }),
      /not approved \(rejected\)/,
    )
    assert.ok(existsSync(join(run, 'report.json')))
    assert.equal(denied.requests.length, 1)
    // The approval reason names the exact run and byte size.
    assert.match(denied.requests[0].reason, /Permanently delete the session-insights run/)

    // One allowed-once approval scoped to this call completes the deletion.
    const allowed = harnessWithApproval('allowed-once')
    const allowedCleanup = allowed.tools.get('session_insights_cleanup')
    const controller = new AbortController()
    const result = await allowedCleanup.execute(
      { workdir: run, confirm: true },
      { signal: controller.signal, agent: { session: { synthetic: true } }, callId: 'c2' },
    )
    assert.equal(JSON.parse(result.text).deleted, true)
    assert.ok(!existsSync(join(run, 'report.json')))
    // The approval request bound this exact call: agent, callId and the live
    // signal all reached the service.
    assert.equal(allowed.requests[0].agent.session.synthetic, true)
    assert.equal(allowed.requests[0].callId, 'c2')
    assert.ok(allowed.requests[0].signal instanceof AbortSignal)

    // Cancellation settles 'cancelled' without deletion: abort while the
    // approval request is in flight, not before the call starts.
    const cancelRun = new Store(tmp).create()
    writeFileSync(join(cancelRun, 'report.json'), '{}')
    const canceller = harnessWithApproval('allowed-once', { holdOpen: true })
    const cancelCleanup = canceller.tools.get('session_insights_cleanup')
    const aborter = new AbortController()
    const inflight = assert.rejects(
      () => cancelCleanup.execute({ workdir: cancelRun, confirm: true },
        { signal: aborter.signal, agent: {}, callId: 'c3' }),
      /not approved \(cancelled\)/,
    )
    setTimeout(() => aborter.abort(), 5)
    await inflight
    assert.ok(existsSync(join(cancelRun, 'report.json')))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('G2: without an approval service the deletion fails closed', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'g2b-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const store = new Store(tmp)
    const run = store.create()
    const tools = []
    apply({
      effect() {},
      commands: { register() {} },
      tools: { register(value) { tools.push(value) } },
      sessionQuery: {},
    })
    const cleanup = new Map(tools.map((item) => [item.name, item])).get('session_insights_cleanup')
    await assert.rejects(
      () => cleanup.execute({ workdir: run, confirm: true }, { signal: null }),
      /fails closed/,
    )
    // preview still works without the service
    const preview = await cleanup.execute({ workdir: run }, { signal: null })
    assert.equal(JSON.parse(preview.text).deleted, false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(tmp, { recursive: true, force: true })
  }
})

// --- AC-04: facets + category keys obey analysis privacy, counts conserved ---
test('F4: aggregate facets and job-kind keys project with count conservation', () => {
  const rows = readFileSync(new URL('../tests/fixtures/synthetic-session.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
  const events = rows.slice(1)
  for (const [i, kind] of ['/synthetic/private-a/path task', '/synthetic/private-b/path task'].entries())
    events.push({ type: 'job/registered', seq: events.length, time: rows[0].createdAt + 1000,
      data: { jobId: `synthetic-job-${i}`, owner: 'synthetic', kind, label: 'fixture', startedAt: rows[0].createdAt } })
  const built = buildReport([{ session: rows[0], events }], { now: rows[0].createdAt + 86400000, days: 30, privacy: 'local', analysis_privacy: 'redacted', locale: 'en' })
  const tmp = mkdtempSync(join(tmpdir(), 'f4b-'))
  try {
    const store = new Store(tmp)
    const run = store.create()
    const prepared = prepareSemantic(store, run, built)
    for (const id of prepared.batches) {
      const batch = getBatch(store, run, id)
      submitBatch(store, run, id, { facets: batch.tasks.map((t) => ({
        task_family_id: t.task_family_id, goal: 'Contact alice+synthetic@example.invalid',
        task_type: 'implementation', interaction_style: 'detailed', instruction_handling: 'followed',
        tool_execution: 'strong', verification_quality: 'strong', handoff_quality: 'clear',
        frictions: ['none'], strengths: ['clear'], outcome_inference: 'fully_achieved',
        evidence_refs: [t.evidence[0].id],
      })) })
    }
    const input = prepareAggregate(store, run)
    const serialized = JSON.stringify(input)
    assert.ok(!serialized.includes('alice+synthetic@example.invalid'), 'facet email leaked into aggregate input')
    assert.ok(!serialized.includes('/synthetic/private-a/path task'), 'raw private kind leaked')
    const jobs = input.full_scope_summary.totals.jobs.by_kind
    assert.equal(Object.values(jobs).reduce((a, b) => a + b, 0), 2, 'counter collision lost counts')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// --- AC-13: noncanonical identity envelope is refused; canonical passes ------
test('F6/AC-13: envelope extra fields are rejected and never reach the report', () => {
  const rows = readFileSync(new URL('../tests/fixtures/synthetic-session.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
  const built = buildReport([{ session: rows[0], events: rows.slice(1) }], { now: rows[0].createdAt + 86400000, days: 30, privacy: 'redacted', locale: 'zh-CN', analysis_depth: 'evidence', report_timezone: 'UTC' })
  const tmp = mkdtempSync(join(tmpdir(), 'ac13-'))
  try {
    const store = new Store(tmp)
    const run = store.create()
    const prepared = prepareSemantic(store, run, built)
    for (const id of prepared.batches) {
      const batch = getBatch(store, run, id)
      submitBatch(store, run, id, { facets: batch.tasks.map((t) => facetFor(t, '实现完成')) })
    }
    const input = prepareAggregate(store, run)
    const value = aggregateFor(store, run)
    value.aggregate_input_identity = { ...input.input_identity, note: 'Bearer SYNTHETIC-REPAIR-TOKEN-1234567890' }
    assert.throws(() => submitAggregate(store, run, value), /exactly identity_schema and aggregate_input_digest|secret signal|aggregate_input_identity/)
    // canonical envelope still accepted
    const clean = aggregateFor(store, run)
    submitAggregate(store, run, clean)
    const result = finalize(store, run)
    assert.ok(!readFileSync(result.data, 'utf8').includes('SYNTHETIC-REPAIR-TOKEN'))
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

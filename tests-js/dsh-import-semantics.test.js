import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReport } from '../plugin/lib/analyzer.js'
import { importSyntheticExports, importerIdentity } from './fixtures/import-sessions.mjs'

// D02 regression: the official rc.3 DeepSeek chat-export importer (published
// `@deepseek-ai/dsh-deepseek-chat-import` sources, whose digests are recorded) converts a
// synthetic export through the official session-persistence-jsonl backend, and
// the existing DSI analysis semantics hold on the imported sessions. The
// imported model source `deepseek-chat-export` is an observed source label, not
// a local model request; missing usage stays unavailable instead of being
// fabricated as a measured zero; excluded/unfinished replies become error
// turns, never inferred successes.
const harness = await importSyntheticExports()
const options = { now: Date.parse('2026-11-10T08:00:00Z'), days: 30, privacy: 'redacted', locale: 'en', analysis_depth: 'evidence' }
const { report } = buildReport(harness.snapshots, options)
const summaries = report.session_summaries
const title = (s) => s.title ?? ''

test('official importer identity is the exact rc.3 published package', () => {
  const identity = importerIdentity()
  assert.equal(identity.name, '@deepseek-ai/dsh-deepseek-chat-import')
  assert.equal(identity.version, '0.2.2-rc.3')
  for (const rel of Object.keys(identity.sources)) {
    assert.match(identity.sources[rel], /^[0-9a-f]{64}$/)
    assert.equal(identity.sources[rel], harness.importerIdentity.sourceDigests[rel], 'transformed input is the exact installed package source')
  }
})

test('all representative conversations import through the official persistence path', () => {
  assert.equal(harness.result.skipped.length, 0, JSON.stringify(harness.result.skipped))
  assert.equal(harness.result.sessionIds.length, 4)
  assert.equal(harness.snapshots.length, 4)
  for (const snap of harness.snapshots) {
    assert.equal(snap.session.cwd, harness.result.workspacePath, 'imported sessions carry the workspace cwd')
    assert.equal(snap.events[0].type, 'turn/start')
    assert.equal(snap.session.version, 4)
  }
  assert.ok(harness.persistedEntryCount > 0, 'persistence root was populated before harness cleanup')
})

test('normal conversation: title, staged web tools, completed reasons, imported source label', () => {
  const snap = harness.snapshots.find((s) => s.events.some((e) => e.type === 'session/title' && e.data.title.includes('rc.3')))
  assert.ok(snap, 'the titled conversation with web tools is present')
  assert.equal(snap.events.filter((e) => e.type === 'turn/end').length, 3, 'two imported turns plus the continued one')
  assert.equal(snap.events.filter((e) => e.type === 'tool/call' && e.data.name === 'web_search').length, 1)
  assert.equal(snap.events.filter((e) => e.type === 'tool/call' && e.data.name === 'web_fetch').length, 1)
  for (const e of snap.events.filter((e) => e.type === 'assistant/message')) {
    assert.equal(e.data.message.source.kind, 'model')
    assert.equal(e.data.message.source.provider, 'deepseek-chat-export')
    assert.equal(e.data.message.source.model, 'deepseek-chat-export')
  }
  // The imported source label reaches the report as an observation, and the
  // report counts no local model request for it: no request/header event
  // exists in an imported session, so the only provider record is the observed
  // deepseek-chat-export label, and usage stays unavailable.
  assert.equal(summaries.length, 4)
  assert.deepEqual((report.providers ?? []).map((p) => p.provider), ['deepseek-chat-export'])
  assert.equal(report.totals.tokens.total_tokens, 0)
  assert.equal(report.totals.assistant_attempts_with_usage ?? 0, 0)
  // conv-c keeps no assistant message at all, so it records no source label.
  for (const s of summaries) assert.ok(s.provider === 'deepseek-chat-export' || s.provider === null, String(s.provider))
})

test('file and image references become synthetic attachment cards without an attachment store', () => {
  const snap = harness.snapshots.find((s) => s.events.some((e) => e.type === 'user/message' && Array.isArray(e.data.content) && e.data.content.some((b) => b.type === 'file')))
  assert.ok(snap, 'the attachment conversation is present')
  const content = snap.events.find((e) => e.type === 'user/message').data.content
  const attachments = content.filter((b) => b.type === 'file')
  assert.equal(attachments.length, 2)
  assert.deepEqual(attachments.map((b) => [b.attachment.name, b.attachment.bytes]).sort(), [['diagram.png', 1234], ['notes.txt', 20]])
  for (const block of attachments) assert.match(block.attachment.attachmentId, /^sha256:[0-9a-f]{64}$/)
})

test('excluded replies become error turns with their export codes, never successes', () => {
  const snap = harness.snapshots.find((s) => s.events.some((e) => e.type === 'turn/end' && e.data.reason?.kind === 'error' && e.data.reason.error?.code === 'DEEPSEEK_EXPORT_FAILED'))
  assert.ok(snap, 'the failure conversation is present')
  const ends = snap.events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)
  assert.deepEqual(ends.map((r) => r.error?.code), [
    'DEEPSEEK_EXPORT_FAILED',
    'DEEPSEEK_EXPORT_TEMPLATE_RESPONSE',
    'DEEPSEEK_EXPORT_EMPTY_REPLY',
    'DEEPSEEK_EXPORT_NO_REPLY',
  ])
  // The content-filtered pair produces no turn at all: four user messages,
  // five in the export.
  assert.equal(snap.events.filter((e) => e.type === 'user/message').length, 4)
})

test('report semantics: error turns stay failures, failed search stays a tool failure, usage stays unavailable', () => {
  assert.equal(report.totals.turns, 10)
  assert.equal(report.totals.aborted_turns, 4, 'the four excluded-reply turns are counted as aborted, not completed')
  assert.equal(report.totals.task_complete, 6, 'imported completed turns never upgrade an excluded reply')
  assert.equal(report.totals.tool_failures, 1, 'the recorded failed search is a tool failure')
  const failed = summaries.find((s) => s.tool_failures === 1)
  assert.ok(failed, 'the failed-search session carries the tool failure')
  assert.equal(failed.tool_failures, 1, 'structured failed-search evidence survives the completed reply')
  assert.equal(failed.tool_calls, 1, 'unfinished searches are excluded by the official importer')

  // Missing usage is unavailable, not a fabricated measured zero.
  for (const s of summaries) {
    assert.equal(s.tokens.total_tokens, 0)
    assert.equal(s.tokens.token_measurement?.usage_samples ?? s.tokens.usage_samples ?? 0, 0, JSON.stringify(s.tokens))
  }
  assert.match(report.measurement_contract.attempts, /usage is unavailable, not estimated/)
})

test('imported sessions continue under the same identity and stay analyzable', () => {
  const snap = harness.snapshots.find((s) => s.session.id === harness.continuedSessionId)
  assert.ok(snap, 'the continued session is present')
  const kinds = snap.events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason.kind)
  assert.deepEqual(kinds, ['completed', 'completed', 'completed'])
  assert.ok(snap.events.at(-1).time > snap.events[0].time, 'the continued turn extends the time window')
  assert.equal(snap.events.at(-1).seq, snap.events.length - 1, 'contiguous sequence across the import/continue boundary')
})

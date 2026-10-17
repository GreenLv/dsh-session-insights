// Build synthetic fixtures with the exact target DSH (0.2.1-rc.2) Session
// writer, then persist the same events through the released V4 codec and
// restore them with the official strict catalog. No model, no private data.
//
// Outputs, for each case:
//   tests/fixtures/rc21/<case>/session.v4.jsonl[.zstd]  physical V4 log
//   tests/fixtures/rc21/<case>/snapshot.json            host-restored logical snapshot
// and tests/fixtures/rc21/expectations.json (case list + analyzer expectations).
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {join, resolve} from 'node:path'
import {readFile, writeFile, mkdir, rm} from 'node:fs/promises'
import {zstdCompressSync} from 'node:zlib'
import assert from 'node:assert/strict'

const TARGET = '0.2.1-rc.2'
if (!process.argv[2]) throw new Error('exact target runtime root required')
const runtime = resolve(process.argv[2])
const req = createRequire(join(runtime, 'package.json'))
const load = async (name) => import(pathToFileURL(req.resolve(name)).href)
const {Context} = await load('@deepseek-ai/cordis')
const {SessionStore, appendPluginRecord} = await load('@deepseek-ai/dsh-session')
const {sessionFormatCatalog} = await load('@deepseek-ai/dsh-session-format-catalog')
const {releasedV4SessionFormatCodec} = await load('@deepseek-ai/dsh-session-format-v3-to-v4')
const version = JSON.parse(await readFile(req.resolve('@deepseek-ai/dsh-session-format-catalog/package.json'), 'utf8')).version
assert.equal(version, TARGET, `exact runtime ${TARGET} required, got ${version}`)

const root = new URL('../tests/fixtures/rc21/', import.meta.url)
const source = new URL('../tests/fixtures/synthetic-session.jsonl', import.meta.url)
const rows = (await readFile(source, 'utf8')).trim().split('\n').map(JSON.parse)
const baseHeader = rows[0]
const baseEvents = rows.slice(1)
const STAMP = baseHeader.createdAt

const cases = []
const ctx = new Context()
const sessions = new SessionStore(ctx)

function normalizedHeader(id, extra = {}) {
  // Strip the header envelope fields the logical snapshot carries separately.
  const {type, ...header} = structuredClone(baseHeader)
  return {...header, id, createdAt: STAMP, ...extra}
}

function createSession(id, {seed = baseEvents, inherited = 0, extraHeader = {}, plugin = false} = {}) {
  const header = normalizedHeader(id, extraHeader)
  const session = inherited
    ? sessions.create(id, {seed, meta: header, inheritedEventCount: inherited})
    : sessions.create(id, {seed, meta: header})
  return {session, header}
}

function stableEvents(session) {
  return session.snapshotEvents().map((event, index) => ({...event, time: STAMP + (index + 1) * 1000}))
}

function toolCall(callId = 'fixture-call-1') {
  return {callId, rootCallId: callId}
}

function job(jobId, kind, label, startedAt, tool = toolCall()) {
  return {jobId, owner: 'placeholder', kind, label, startedAt, ...(tool === null ? {} : {toolCall: tool})}
}

function buildCase(name, header, events, expected, inheritedEventCount = 0) {
  const encoded = [
    {type: 'session', ...header},
    ...events.map((event) => releasedV4SessionFormatCodec.encodeEvent(event)),
  ]
  // Restore exactly as persistence does; a fixture the target host cannot
  // reopen must fail the producer instead of being committed.
  const restore = sessionFormatCatalog.createRestore(encoded[0], {recovery: 'strict', validation: 'current'})
  for (const row of encoded.slice(1)) restore.decodeRow(row)
  const artifact = restore.finish()
  assert.equal(artifact.events.length, events.length, `${name}: restore count`)
  assert.equal(artifact.header.version, 4, `${name}: format`)
  cases.push({
    name,
    expected,
    snapshot: {
      session: artifact.header,
      events: artifact.events,
      inheritedEventCount: artifact.inheritedEventCount,
    },
  })
  return encoded
}

async function writeCase(name, encoded) {
  const folder = new URL(name + '/', root)
  await mkdir(folder, {recursive: true})
  const lines = encoded.map((row) => JSON.stringify(row) + '\n')
  await writeFile(new URL('session.v4.jsonl', folder), lines.join(''))
  const header = Buffer.from(lines[0])
  const rest = Buffer.from(lines.slice(1).join(''))
  await writeFile(
    new URL('session.v4.jsonl.zstd', folder),
    Buffer.concat([zstdCompressSync(header), zstdCompressSync(rest)]),
  )
}

// 1. A completed subagent job, a working-directory change, and one ignorable
//    plugin record in one ordinary completed session.
{
  const id = 'synthetic-rc21-job-lifecycle'
  const {session, header} = createSession(id)
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  const registration = job('bash-0123456789abcdef', 'bash', 'Synthetic foreground bash', STAMP + 4000)
  session.append('job/registered', {...registration, owner: id})
  session.append('working-directory/change', {cwd: '/synthetic/workspace/project-b'})
  session.append('job/settled', {
    ...registration,
    owner: id,
    finishedAt: STAMP + 6000,
    status: 'completed',
    cause: 'producer',
    producerReported: true,
  })
  // A surface-owned message keeps the session replayable after the boundary.
  session.append('user/message', {
    id: 'job-lifecycle-user', role: 'user', source: {kind: 'user'},
    content: [{type: 'text', text: 'Synthetic follow-up after the background job.'}],
  }, {surfaceOp: 'append'})
  if (!header.isSeeded) appendPluginRecord(session, 'plugin:synthetic/observation', {count: 1, note: 'synthetic'})
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('job-lifecycle', header, events, {
    jobs: {registered: 1, settled: 1, completed: 1, failed: 0, killed: 0, pending: 0, inherited: 0, producer_reported: 1, by_kind: {bash: 1}, by_cause: {producer: 1}},
    working_directory: {changes: 1, inherited_changes: 0, trajectory: ['project-a', 'project-b'], projects_visited: ['project-a', 'project-b'], cross_project: true, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {'plugin:synthetic/observation': 1},
    physical_ranges: false,
  })
  await writeCase('job-lifecycle', encoded)
}

// 2. Registered-but-never-settled job whose parent turn ends while the child
//    still runs; a failed and a killed settlement are separate records.
{
  const id = 'synthetic-rc21-job-pending'
  const {session, header} = createSession(id)
  const pending = job('bash-fedcba9876543210', 'bash', 'Background bash still running', STAMP + 3000)
  const failed = job('workflow-0011223344556677', 'workflow', 'Failed workflow', STAMP + 3100, null)
  const killed = job('pty-send-8899aabbccddeeff', 'pty-send', 'Killed background terminal', STAMP + 3200, null)
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  for (const record of [pending, failed, killed]) session.append('job/registered', {...record, owner: id})
  session.append('working-directory/change', {cwd: '/synthetic/workspace/project-b'})
  session.append('job/settled', {...failed, owner: id, finishedAt: STAMP + 5000, status: 'failed', cause: 'producer', producerReported: true})
  session.append('job/settled', {...killed, owner: id, finishedAt: STAMP + 5100, status: 'killed', cause: 'kill', producerReported: false})
  // The parent turn ends completed; the registered job remains running.
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('job-pending', header, events, {
    jobs: {registered: 3, settled: 2, completed: 0, failed: 1, killed: 1, pending: 1, inherited: 0, producer_reported: 1, by_kind: {bash: 1, workflow: 1, 'pty-send': 1}, by_cause: {producer: 1, kill: 1}},
    working_directory: {changes: 1, inherited_changes: 0, trajectory: ['project-a', 'project-b'], projects_visited: ['project-a', 'project-b'], cross_project: true, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
    physical_ranges: false,
  })
  await writeCase('job-pending', encoded)
}

// 3. Forked session: the inherited prefix carries a settled job and the
//    child's own section registers another job plus a cwd change.
{
  const id = 'synthetic-rc21-inherited'
  const prefix = structuredClone(baseEvents)
  const parentJob = job('workflow-aabbccddeeff0011', 'workflow', 'Inherited settled workflow', STAMP + 1000, null)
  delete parentJob.owner
  prefix.push(
    {type: 'job/registered', time: STAMP, data: {...parentJob, owner: 'synthetic-parent'}},
    {type: 'working-directory/change', time: STAMP, data: {cwd: '/synthetic/workspace/project-parent'}},
    {type: 'job/settled', time: STAMP, data: {...parentJob, owner: 'synthetic-parent', finishedAt: STAMP + 2000, status: 'completed', cause: 'producer', producerReported: true}},
  )
  prefix.forEach((event, index) => { event.seq = index; event.time = STAMP + (index + 1) * 1000 })
  const {session, header} = createSession(id, {seed: prefix, inherited: prefix.length, extraHeader: {isSeeded: true}})
  session.append('working-directory/change', {cwd: '/synthetic/workspace/project-b'})
  const childJob = job('bash-1029384756abcdef', 'bash', 'Child-owned bash job', STAMP + 4000)
  session.append('job/registered', {...childJob, owner: id})
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  session.append('job/settled', {...childJob, owner: id, finishedAt: STAMP + 6000, status: 'completed', cause: 'producer', producerReported: true})
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('inherited', header, events, {
    jobs: {registered: 2, settled: 2, completed: 2, failed: 0, killed: 0, pending: 0, inherited: 1, producer_reported: 2, by_kind: {workflow: 1, bash: 1}, by_cause: {producer: 2}},
    working_directory: {changes: 1, inherited_changes: 1, trajectory: ['project-a', 'project-parent', 'project-b'], projects_visited: ['project-a', 'project-parent', 'project-b'], cross_project: true, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
  }, prefix.length)
  await writeCase('inherited', encoded)
}

// 4. Mixed V4 representation: a real surface replacement encodes its
//    sourceEventSeqs as physical ranges; job/cwd records follow it.
{
  const id = 'synthetic-rc21-mixed-v4'
  const {session, header} = createSession(id)
  session.append('turn/start', {turn: 2})
  const first = session.append('user/message', {
    id: 'mixed-first', role: 'user', source: {kind: 'user'},
    content: [{type: 'text', text: 'Synthetic first mixed request.'}],
  }, {surfaceOp: 'append'})
  const second = session.append('user/message', {
    id: 'mixed-second', role: 'user', source: {kind: 'user'},
    content: [{type: 'text', text: 'Synthetic second mixed request.'}],
  }, {surfaceOp: 'append'})
  const third = session.append('user/message', {
    id: 'mixed-third', role: 'user', source: {kind: 'user'},
    content: [{type: 'text', text: 'Synthetic third mixed request.'}],
  }, {surfaceOp: 'append'})
  session.append('user/message', {
    id: 'mixed-replacement', role: 'user', source: {kind: 'user'},
    content: [{type: 'text', text: 'Synthetic replacement summary.'}],
  }, {
    surfaceOp: {op: 'replace', startSeq: first.seq, endSeq: third.seq},
    sourceEventSeqs: [first.seq, second.seq, third.seq],
  })
  const mixedJob = job('pwsh-5566778899aabbcc', 'pwsh', 'Mixed representation pwsh job', STAMP + 4000)
  session.append('job/registered', {...mixedJob, owner: id})
  session.append('working-directory/change', {cwd: '/synthetic/workspace/project-b'})
  session.append('job/settled', {...mixedJob, owner: id, finishedAt: STAMP + 6000, status: 'completed', cause: 'producer', producerReported: true})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('mixed-v4', header, events, {
    jobs: {registered: 1, settled: 1, completed: 1, failed: 0, killed: 0, pending: 0, inherited: 0, producer_reported: 1, by_kind: {pwsh: 1}, by_cause: {producer: 1}},
    working_directory: {changes: 1, inherited_changes: 0, trajectory: ['project-a', 'project-b'], projects_visited: ['project-a', 'project-b'], cross_project: true, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
    physical_ranges: true,
  })
  await writeCase('mixed-v4', encoded)
}

// 5. Search/Fetch calls and a recorded model selection. Native tool calls
//    (not PTC sub-calls) keep one counted call per invocation.
{
  const id = 'synthetic-rc21-web-model'
  const {session, header} = createSession(id)
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  session.append('user/message', {
    id: 'web-request', role: 'user', source: {kind: 'user'},
    content: [{type: 'text', text: 'Search and fetch synthetic documentation.'}],
  }, {surfaceOp: 'append'})
  const call = (callId, name, args) => {
    session.append('assistant/message', {
      turn: 2, step: 1, stream: [],
      message: {id: `assistant-${callId}`, role: 'assistant',
        source: {kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model'},
        content: [{type: 'text', text: 'Synthetic request.'}, {type: 'tool-call', id: callId, name, arguments: args}]},
    }, {surfaceOp: 'append'})
    session.append('tool/call', {turn: 2, step: 1, callId, name, arguments: args})
    session.append('tool/result', {
      turn: 2, step: 1,
      message: {id: `result-${callId}`, role: 'tool', source: {kind: 'tool', callId},
        toolCallId: callId, isError: false, content: [{type: 'text', text: 'Synthetic tool output.'}]},
    }, {surfaceOp: 'append'})
  }
  call('search-1', 'web_search', '{"queries":["synthetic one","synthetic two"]}')
  call('fetch-1', 'web_fetch', '{"url":"https://example.invalid/synthetic"}')
  session.append('model/selection', {provider: 'synthetic-provider', model: 'synthetic-model-v2', reasoningEffort: 'high'})
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('web-model', header, events, {
    jobs: {registered: 0, settled: 0, completed: 0, failed: 0, killed: 0, pending: 0, inherited: 0, producer_reported: 0},
    working_directory: {changes: 0, inherited_changes: 0, trajectory: ['project-a'], projects_visited: ['project-a'], cross_project: false, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
    tools: {web_searches: 1, web_fetches: 1, model_selections: 1},
    physical_ranges: false,
  })
  await writeCase('web-model', encoded)
}

// 6. Async subagent dispatch: a tool result, a catalog fact, and a
//    runtime-owned settlement notice. Subagents are never background jobs.
{
  const id = 'synthetic-rc21-subagent'
  const {session, header} = createSession(id)
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  session.append('user/message', {
    id: 'sub-user', role: 'user', source: {kind: 'user'},
    content: [{type: 'text', text: 'Delegate synthetic child work.'}],
  }, {surfaceOp: 'append'})
  session.append('assistant/message', {
    turn: 2, step: 1, stream: [],
    message: {id: 'assistant-sub', role: 'assistant',
      source: {kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model'},
      content: [{type: 'text', text: 'Synthetic request.'},
        {type: 'tool-call', id: 'sub-1', name: 'subagent', arguments: '{"prompt":"Synthetic child work"}'}]},
  }, {surfaceOp: 'append'})
  session.append('tool/call', {turn: 2, step: 1, callId: 'sub-1', name: 'subagent', arguments: '{"prompt":"Synthetic child work"}'})
  session.append('tool/result', {
    turn: 2, step: 1,
    message: {id: 'result-sub-1', role: 'tool', source: {kind: 'tool', callId: 'sub-1'},
      toolCallId: 'sub-1', isError: false, content: [{type: 'text', text: 'started subagent child-1'}]},
  }, {surfaceOp: 'append'})
  session.append('subagent/catalog', {childId: 'child-1', childCreatedAt: STAMP + 1000, version: 2, mode: 'external'})
  session.append('user/message', {
    id: 'settled-child-1', role: 'user',
    source: {kind: 'subagent-settled', form: 'notice', summary: 'completed', senderSessionId: 'child-1'},
    content: [{type: 'text', text: 'Subagent child-1 completed.'}],
  }, {surfaceOp: 'append'})
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('subagent', header, events, {
    jobs: {registered: 0, settled: 0, completed: 0, failed: 0, killed: 0, pending: 0, inherited: 0, producer_reported: 0},
    working_directory: {changes: 0, inherited_changes: 0, trajectory: ['project-a'], projects_visited: ['project-a'], cross_project: false, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
    delegation: {dispatches: 1, dispatches_by_tool: {subagent: 1}, settlements: 1, completion_notices: 0, relays_received: 0, relays_sent: 0},
    tools: {user_messages: 3, injected_user_messages: 1},
    physical_ranges: false,
  })
  await writeCase('subagent', encoded)
}

// 7. Team roster/task snapshots (whole-value, last-wins), legacy mailbox
//    events from old logs, a relay inbox message, and a send_message result.
{
  const id = 'synthetic-rc21-team'
  const teamId = 'team-synthetic'
  const {session, header} = createSession(id)
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  const member = (childId, name, phase, error) => ({
    version: 2, teamId,
    member: {id: childId, name, description: `Synthetic ${name}`, provider: 'synthetic-provider',
      context: 'fresh', phase, ...(error ? {error} : {})},
  })
  session.append('team/member', member('child-a', 'Child A', 'provisioning'))
  session.append('team/member', member('child-a', 'Child A', 'active'))
  session.append('team/member', member('child-b', 'Child B', 'failed', 'synthetic failure'))
  const task = (id, revision, status, ownerId) => ({
    version: 2, teamId,
    task: {id, revision, subject: `Synthetic ${id}`, description: 'Synthetic team task',
      status, ownerId, blockedBy: [], writeScopes: []},
  })
  session.append('team/task', task('task-1', 1, 'pending', 'child-a'))
  session.append('team/task', task('task-1', 2, 'in_progress', 'child-a'))
  session.append('team/task', task('task-1', 3, 'completed', 'child-a'))
  session.append('team/task', task('task-2', 1, 'deleted', 'child-b'))
  session.append('team/message/queued', {
    version: 2, teamId,
    message: {id: 'msg-1', senderId: 'lead', senderName: 'Lead', targetId: 'child-a',
      content: [{type: 'text', text: 'Synthetic team message'}]},
  })
  session.append('team/message/delivered', {version: 2, teamId, messageId: 'msg-1', targetId: 'child-a'})
  session.append('user/message', {
    id: 'team-relay', role: 'user',
    source: {kind: 'agent-message', form: 'relay', senderSessionId: 'lead'},
    content: [{type: 'text', text: 'Team message from Lead: Synthetic team message'}],
  }, {surfaceOp: 'append'})
  session.append('assistant/message', {
    turn: 2, step: 1, stream: [],
    message: {id: 'assistant-send', role: 'assistant',
      source: {kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model'},
      content: [{type: 'text', text: 'Synthetic request.'},
        {type: 'tool-call', id: 'send-1', name: 'send_message', arguments: '{"target":"child-a","message":"synthetic"}'}]},
  }, {surfaceOp: 'append'})
  session.append('tool/call', {turn: 2, step: 1, callId: 'send-1', name: 'send_message', arguments: '{"target":"child-a","message":"synthetic"}'})
  session.append('tool/result', {
    turn: 2, step: 1,
    message: {id: 'result-send-1', role: 'tool', source: {kind: 'tool', callId: 'send-1'},
      toolCallId: 'send-1', isError: false, content: [{type: 'text', text: '{"messageId":"msg-2"}'}]},
  }, {surfaceOp: 'append'})
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('team', header, events, {
    jobs: {registered: 0, settled: 0, completed: 0, failed: 0, killed: 0, pending: 0, inherited: 0, producer_reported: 0},
    working_directory: {changes: 0, inherited_changes: 0, trajectory: ['project-a'], projects_visited: ['project-a'], cross_project: false, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
    delegation: {dispatches: 0, settlements: 0, completion_notices: 0, relays_received: 1, relays_sent: 1},
    team: {members: 2, members_by_phase: {active: 1, failed: 1}, tasks: 2, tasks_by_status: {completed: 1, deleted: 1}, task_transitions: 4, mailbox_legacy: 2},
    tools: {user_messages: 2, injected_user_messages: 1},
    physical_ranges: false,
  })
  await writeCase('team', encoded)
}

// 8. A fork cut between an ancestor job registration and its settlement:
//    inherited pending work is retained but never counted as child work.
{
  const id = 'synthetic-rc21-job-inherited-open'
  const prefix = structuredClone(baseEvents)
  prefix.push({type: 'job/registered', time: STAMP, data: {
    jobId: 'workflow-1122334455667788', owner: 'synthetic-parent', kind: 'workflow',
    label: 'Inherited still-running workflow', startedAt: STAMP + 1000,
  }})
  prefix.forEach((event, index) => { event.seq = index; event.time = STAMP + (index + 1) * 1000 })
  const {session, header} = createSession(id, {seed: prefix, inherited: prefix.length, extraHeader: {isSeeded: true}})
  const childJob = job('bash-9988776655443322', 'bash', 'Child bash job', STAMP + 4000)
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  session.append('job/registered', {...childJob, owner: id})
  session.append('job/settled', {...childJob, owner: id, finishedAt: STAMP + 6000, status: 'completed', cause: 'producer', producerReported: true})
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('job-inherited-open', header, events, {
    jobs: {registered: 2, settled: 1, completed: 1, failed: 0, killed: 0, pending: 1, inherited: 1, inherited_pending: 1, producer_reported: 1, by_kind: {workflow: 1, bash: 1}, by_cause: {producer: 1}},
    working_directory: {changes: 0, inherited_changes: 0, trajectory: ['project-a'], projects_visited: ['project-a'], cross_project: false, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
    physical_ranges: false,
  }, prefix.length)
  await writeCase('job-inherited-open', encoded)
}

// 9. Job observable edges plus workflow/retry/completion-notice records.
{
  const id = 'synthetic-rc21-job-observability'
  const {session, header} = createSession(id)
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  const bad = job('bash-negativeduration', 'bash', 'Teardown-failed bash', STAMP + 5000, null)
  const wf = job('workflow-observability', 'workflow', 'Observed workflow', STAMP + 5100, null)
  session.append('job/registered', {...bad, owner: id})
  session.append('job/registered', {...wf, owner: id})
  session.append('job/settled', {...bad, owner: id, finishedAt: STAMP + 4000, status: 'failed', cause: 'teardown', producerReported: false, detail: 'cancel threw during teardown'})
  session.append('job/settled', {...wf, owner: id, finishedAt: STAMP + 7000, status: 'completed', cause: 'producer', producerReported: true})
  session.append('tool-workflow/run-start', {runId: 'run-1', turn: 2})
  session.append('tool-workflow/agent-start', {runId: 'run-1', agentId: 'agent-1'})
  session.append('tool-workflow/agent-end', {runId: 'run-1', agentId: 'agent-1'})
  session.append('tool-workflow/run-end', {runId: 'run-1', turn: 2})
  session.append('request/header', {reason: 'initial', startsSeries: true, header: {config: {provider: 'synthetic-provider', model: 'synthetic-model'}}})
  session.append('llm/retry', {retryId: 'retry-1', turn: 2, step: 1, provider: 'synthetic-provider', mode: 'normal', policyKey: 'synthetic-policy', retry: 1, maxRetries: 3, delayMs: 100, failure: {code: 'synthetic'}})
  session.append('llm/retry-started', {retryId: 'retry-1', turn: 2, step: 1, retry: 1})
  session.append('llm/retry', {retryId: 'retry-1', turn: 2, step: 1, provider: 'synthetic-provider', mode: 'normal', policyKey: 'synthetic-policy', retry: 2, maxRetries: 3, delayMs: 200, failure: {code: 'synthetic'}})
  session.append('user/message', {
    id: 'job-notice-1', role: 'user',
    source: {kind: 'tool-jobs', form: 'notice', summary: 'completed'},
    content: [{type: 'text', text: 'background job bash-negativeduration finished'}],
  }, {surfaceOp: 'append'})
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('job-observability', header, events, {
    jobs: {registered: 2, settled: 2, completed: 1, failed: 1, killed: 0, pending: 0, inherited: 0, inherited_pending: 0, producer_reported: 1, unreported: 1, teardown: 1, duration_negative: 1, detail_present: 1, by_kind: {bash: 1, workflow: 1}, by_cause: {teardown: 1, producer: 1}},
    working_directory: {changes: 0, inherited_changes: 0, trajectory: ['project-a'], projects_visited: ['project-a'], cross_project: false, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
    delegation: {workflow_runs_started: 1, workflow_runs_ended: 1, workflow_agents_started: 1, workflow_agents_ended: 1, completion_notices: 1},
    tools: {llm_retries: 2, llm_retries_performed: 1, llm_retry_chains: 1, injected_user_messages: 1},
    physical_ranges: false,
  })
  await writeCase('job-observability', encoded)
}

// 10. Child-owned subagent descriptor identity.
{
  const id = 'synthetic-rc21-subagent-child'
  const {session, header} = createSession(id, {extraHeader: {origin: 'subagent', parentSession: 'synthetic-parent', delegationDepth: 1}})
  session.append('subagent/descriptor', {version: 3, mode: 'one-shot', provider: 'synthetic-provider', label: 'Synthetic child'})
  session.append('turn/start', {turn: 2})
  session.append('step/start', {turn: 2, step: 1})
  session.append('user/message', {
    id: 'child-task', role: 'user', source: {kind: 'user'},
    content: [{type: 'text', text: 'Synthetic child-owned task.'}],
  }, {surfaceOp: 'append'})
  session.append('assistant/message', {
    turn: 2, step: 1, stream: [],
    message: {id: 'child-assistant', role: 'assistant',
      source: {kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model'},
      content: [{type: 'text', text: 'Synthetic child result.'}]},
  }, {surfaceOp: 'append'})
  session.append('step/end', {turn: 2, step: 1})
  session.append('turn/end', {turn: 2, reason: {kind: 'completed'}})
  const events = stableEvents(session)
  const encoded = buildCase('subagent-child', header, events, {
    jobs: {registered: 0, settled: 0, completed: 0, failed: 0, killed: 0, pending: 0, inherited: 0, producer_reported: 0},
    working_directory: {changes: 0, inherited_changes: 0, trajectory: ['project-a'], projects_visited: ['project-a'], cross_project: false, attribution: 'header-origin-with-change-trajectory'},
    plugin_records: {},
    subagent: {version: 3, mode: 'one-shot', provider: 'synthetic-provider', agent_provider: null, agent_model: null},
    physical_ranges: false,
  })
  await writeCase('subagent-child', encoded)
}

const expectations = JSON.stringify(cases.map(({name, expected}) => ({name, expected})), null, 2) + '\n'
if (process.argv.includes('--check')) {
  const previous = JSON.parse(await readFile(new URL('expectations.json', root), 'utf8'))
  assert.deepEqual(previous, JSON.parse(expectations))
  for (const entry of cases) {
    const physical = await readFile(new URL(`${entry.name}/session.v4.jsonl`, root), 'utf8')
    const restored = sessionFormatCatalog.createRestore(
      JSON.parse(physical.split('\n')[0]),
      {recovery: 'strict', validation: 'current'},
    )
    for (const line of physical.trim().split('\n').slice(1)) restored.decodeRow(JSON.parse(line))
    restored.finish()
  }
} else {
  await mkdir(root, {recursive: true})
  await writeFile(new URL('expectations.json', root), expectations)
  for (const entry of cases) {
    await writeFile(new URL(`${entry.name}/snapshot.json`, root), JSON.stringify(entry.snapshot, null, 2) + '\n')
  }
}
console.log(JSON.stringify({status: 'pass', target: TARGET, cases: cases.map((c) => c.name), events: cases.map((c) => c.snapshot.events.length)}))
await ctx.fiber.dispose()

import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, _test } from '../plugin/lib/index.js'

function syntheticSessions(count = 1) {
  const now = Date.now()
  const records = []
  const snapshots = new Map()
  for (let index = 0; index < count; index += 1) {
    const id = `node-test-session-${index}`
    const header = { id, createdAt: now - (index + 1) * 1000, cwd: `/workspace/project-${index}` }
    records.push({ header, live: false, persisted: true })
    snapshots.set(id, {
      session: header,
      events: [
        { seq: 0, type: 'turn/start', time: now - 900, data: { turn: 1 } },
        { seq: 1, type: 'user/message', time: now - 800, data: { content: [{ type: 'text', text: `Implement and validate bounded feature ${index}.` }] } },
        { seq: 2, type: 'tool/call', time: now - 700, data: { turn: 1, step: 1, callId: `call-${index}`, name: 'bash', arguments: '{"command":"python -m unittest"}' } },
        { seq: 3, type: 'tool/result', time: now - 600, data: { turn: 1, step: 1, callId: `call-${index}`, result: { output: 'Command completed', metadata: { exitCode: 0 } } } },
        { seq: 4, type: 'assistant/message', time: now - 500, data: { turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 20 }, message: { role: 'assistant', content: [{ type: 'text', text: 'Implemented and validated the requested change.' }] } } },
        { seq: 5, type: 'turn/end', time: now - 100, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    })
  }
  return { records, snapshots }
}

function registerPlugin(sessionData = syntheticSessions()) {
  const commands = []
  const tools = []
  const followups = []
  let listCalls = 0
  apply({
    commands: { register(value) { commands.push(value) } },
    tools: { register(value) { tools.push(value) } },
    sessionQuery: {
      async listSessions() { listCalls += 1; return sessionData.records },
      async readSession(id) { return sessionData.snapshots.get(id) },
    },
  })
  return {
    commands,
    tools: new Map(tools.map((item) => [item.name, item])),
    followups,
    agent: { followup(message) { followups.push(message) } },
    get listCalls() { return listCalls },
  }
}

test('plugin declares its required DSH services', () => {
  assert.deepEqual(inject, ['commands', 'tools', 'sessionQuery'])
})

test('command parser accepts the documented surface', () => {
  assert.deepEqual(
    _test.parseCommandInput('--days 14 --privacy redacted --analysis-depth evidence --locale en --deterministic --no-open'),
    { days: '14', privacy: 'redacted', analysis_depth: 'evidence', locale: 'en', deterministic: true, no_open: true },
  )
  assert.throws(() => _test.parseCommandInput('--unknown'), /unknown option/)
})

test('Windows project filters require native path syntax', () => {
  assert.equal(_test.normalizeProjectInput('C:\\work space\\project', 'win32'), 'C:\\work space\\project')
  assert.equal(_test.normalizeProjectInput('\\\\server\\share\\project', 'win32'), '\\\\server\\share\\project')
  assert.throws(
    () => _test.normalizeProjectInput('/path/to/project', 'win32'),
    /project must use a Windows path/,
  )
  assert.equal(_test.normalizeProjectInput('/path/to/project', 'darwin'), '/path/to/project')
})

test('registers one command and the six workflow tools', () => {
  const commands = []
  const tools = []
  apply({
    commands: { register(value) { commands.push(value) } },
    tools: { register(value) { tools.push(value) } },
    sessionQuery: {},
  })
  assert.deepEqual(commands.map((item) => item.name), ['session-insights'])
  assert.deepEqual(tools.map((item) => item.name), [
    'session_insights_prepare',
    'session_insights_get_batch',
    'session_insights_submit_batch',
    'session_insights_get_aggregate',
    'session_insights_submit_aggregate',
    'session_insights_finalize',
  ])
})

test('bridge uses a versioned JSONL envelope', () => {
  const lines = _test.bridgeLines('report', { days: 7 }, [{ session: { id: 'one' }, events: [] }])
  assert.equal(lines[0].schema, 'dsh-session-insights/bridge-1')
  assert.equal(lines[1].kind, 'session')
})

test('orchestration message uses a supported ContextForm and bounded repair contract', () => {
  const message = _test.orchestrationPrompt({ workdir: '/tmp/run' }, 'en')
  assert.equal(message.source.form, 'notice')
  assert.match(message.content[0].text, /Repair invalid output once per phase/)
  assert.match(message.content[0].text, /finalize\(fallback=true\)/)
})

test('resume reuses the latest semantic run without reading sessions again', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-insights-resume-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporary
  try {
    const registered = registerPlugin(syntheticSessions(6))
    const signal = new AbortController().signal
    const first = await registered.tools.get('session_insights_prepare').execute({ days: 30, locale: 'en' }, { signal })
    const prepared = JSON.parse(first.text)
    assert.equal(prepared.resumed, undefined)
    assert.equal(registered.listCalls, 1)
    const second = await registered.tools.get('session_insights_prepare').execute({ resume: true, locale: 'en' }, { signal })
    const resumed = JSON.parse(second.text)
    assert.equal(resumed.resumed, true)
    assert.equal(await realpath(resumed.workdir), await realpath(prepared.workdir))
    assert.equal(registered.listCalls, 1)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('repeated runs accept nonexistent descendants below an aliased DSH home', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-insights-alias-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporary
  try {
    const registered = registerPlugin(syntheticSessions(6))
    const signal = new AbortController().signal
    const first = JSON.parse((await registered.tools.get('session_insights_prepare').execute({ days: 30, locale: 'en' }, { signal })).text)
    const second = JSON.parse((await registered.tools.get('session_insights_prepare').execute({ days: 30, locale: 'en' }, { signal })).text)
    assert.notEqual(first.workdir, second.workdir)
    await access(first.workdir)
    await access(second.workdir)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await registered.commands[0].handler({ rawInput: '--deterministic --locale en', signal, agent: registered.agent })
      assert.equal(result.kind, 'success', result.text)
      await access(result.text.replace(/^Session insights report: /, ''))
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('cancellation terminates the Python child promptly', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const running = _test.runPython(['-c', 'import time; time.sleep(30)'], { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(running, /session insights cancelled/)
  assert.ok(Date.now() - started < 5000, 'cancelled child did not terminate promptly')
})

test('invalid semantic output is removed before deterministic fallback', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-insights-fallback-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporary
  try {
    const registered = registerPlugin(syntheticSessions(6))
    const signal = new AbortController().signal
    const prepared = JSON.parse((await registered.tools.get('session_insights_prepare').execute({ days: 30, locale: 'en' }, { signal })).text)
    assert.ok(prepared.batches.length > 0, 'fixture did not produce a semantic batch')
    const batch = prepared.batches[0]
    await assert.rejects(
      registered.tools.get('session_insights_submit_batch').execute({ workdir: prepared.workdir, batch, payload_json: '{"facets":[]}' }, { signal }),
    )
    await assert.rejects(access(join(prepared.workdir, 'facet-outputs', `${batch}.json`)))
    const finalized = JSON.parse((await registered.tools.get('session_insights_finalize').execute({ workdir: prepared.workdir, fallback: true }, { signal })).text)
    await access(finalized.report)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('deterministic slash command streams sessionQuery data into a report', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-insights-node-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporary
  try {
    const commands = []
    const now = Date.now()
    const header = { id: 'node-test-session', createdAt: now - 1000, cwd: '/workspace/project' }
    const snapshot = {
      session: header,
      events: [
        { seq: 0, type: 'turn/start', time: now - 900, data: { turn: 1 } },
        { seq: 1, type: 'user/message', time: now - 800, data: { content: [{ type: 'text', text: 'Review the bounded implementation.' }] } },
        { seq: 2, type: 'assistant/message', time: now - 500, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } } },
        { seq: 3, type: 'turn/end', time: now - 100, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    }
    apply({
      commands: { register(value) { commands.push(value) } },
      tools: { register() {} },
      sessionQuery: {
        async listSessions() { return [{ header, live: false, persisted: true }] },
        async readSession() { return snapshot },
      },
    })
    const result = await commands[0].handler({ rawInput: '--deterministic --locale en', signal: new AbortController().signal })
    assert.equal(result.kind, 'success', result.text)
    const reportPath = result.text.replace(/^Session insights report: /, '')
    await access(reportPath)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

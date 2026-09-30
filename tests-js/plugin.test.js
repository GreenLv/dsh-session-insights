import { readFileSync } from 'node:fs'
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
    const rows = readFileSync(new URL('../tests/fixtures/synthetic-session.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
    const {type, ...header} = rows[0]
    Object.assign(header, {id, createdAt: now - 1000, cwd: `/workspace/project-${index}`})
    records.push({header, live: false, persisted: true})
    snapshots.set(id, {session: header, inheritedEventCount: 0, events: rows.slice(1)})
  }
  return { records, snapshots }
}

function registerPlugin(sessionData = syntheticSessions()) {
  const commands = []
  const tools = []
  const followups = []
  let listCalls = 0
  apply({
    effect() {},
    commands: { register(value) { commands.push(value) } },
    tools: { register(value) { tools.push(value) } },
    sessionQuery: {
      async listSessions() { listCalls += 1; return sessionData.records },
      async observeSession(id) { const s = sessionData.snapshots.get(id); return {header:s.session,events:s.events,inheritedEventCount:0,[Symbol.dispose]() {}} },
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

test('registers one command and the workflow and cleanup tools', () => {
  const commands = []
  const tools = []
  apply({
    effect() {},
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
    'session_insights_cleanup',
  ])
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
    assert.equal(resumed.selection.project, null)
    assert.equal(resumed.selection.days, 30)
    assert.equal(registered.listCalls, 1)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('resume cannot cross project, privacy, locale or window scope', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-insights-resume-scope-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporary
  try {
    const registered = registerPlugin(syntheticSessions(6))
    const signal = new AbortController().signal
    await registered.tools.get('session_insights_prepare').execute({ days: 30, locale: 'en' }, { signal })
    for (const [label, request] of [
      ['another project', { resume: true, days: 30, locale: 'en', project: '/workspace/project-9' }],
      ['wider privacy', { resume: true, days: 30, locale: 'en', privacy: 'metrics' }],
      ['other locale', { resume: true, days: 30, locale: 'zh-CN' }],
      ['other window', { resume: true, days: 7, locale: 'en' }],
    ]) {
      await assert.rejects(
        registered.tools.get('session_insights_prepare').execute(request, { signal }),
        /no resumable native run matches/,
        label,
      )
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('explicit workdir resume reports scope contradictions and multi-run ambiguity', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-insights-resume-explicit-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporary
  try {
    const registered = registerPlugin(syntheticSessions(6))
    const signal = new AbortController().signal
    const first = JSON.parse((await registered.tools.get('session_insights_prepare').execute({ days: 30, locale: 'en' }, { signal })).text)
    await assert.rejects(
      registered.tools.get('session_insights_prepare').execute({ resume: true, workdir: first.workdir, days: 7 }, { signal }),
      /resume scope mismatch/,
    )
    // A second run with the same scope makes the implicit request ambiguous.
    await registered.tools.get('session_insights_prepare').execute({ days: 30, locale: 'en' }, { signal })
    await assert.rejects(
      registered.tools.get('session_insights_prepare').execute({ resume: true, days: 30, locale: 'en' }, { signal }),
      /multiple runs match/,
    )
    const again = JSON.parse((await registered.tools.get('session_insights_prepare').execute({ resume: true, workdir: first.workdir }, { signal })).text)
    assert.equal(await realpath(again.workdir), await realpath(first.workdir))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('analysis gate caps concurrent runs and queues the rest cancellably', async () => {
  let blocked = []
  const commands = []
  const tools = []
  apply({
    effect() {},
    commands: { register(value) { commands.push(value) } },
    tools: { register(value) { tools.push(value) } },
    sessionQuery: {
      listSessions(signal) {
        return new Promise((resolve) => blocked.push({ resolve, signal }))
      },
      async observeSession() { throw new Error('not reached') },
    },
  })
  const prepare = tools.find((t) => t.name === 'session_insights_prepare')
  const signal = new AbortController().signal
  const running = Array.from({ length: _test.ANALYSIS_CONCURRENCY + 2 }, () =>
    prepare.execute({ days: 30, locale: 'en' }, { signal }))
  await new Promise((r) => setImmediate(r))
  assert.equal(blocked.length, _test.ANALYSIS_CONCURRENCY, 'only the concurrency cap may run at once')
  // Cancelling one queued request removes it without starting it.
  const cancellable = new AbortController()
  const queued = prepare.execute({ days: 30, locale: 'en' }, { signal: cancellable.signal })
  assert.equal(blocked.length, _test.ANALYSIS_CONCURRENCY)
  cancellable.abort()
  await assert.rejects(queued, /cancelled/)
  for (const entry of blocked.splice(0).reverse()) entry.resolve([])
  assert.equal(JSON.parse((await running[0]).text).selected, 0)
  await new Promise((r) => setImmediate(r))
  assert.ok(blocked.length > 0, 'queued work starts as slots free up')
  for (const entry of blocked) entry.resolve([])
  await Promise.allSettled(running)
})

test('analysis gate rejects beyond its queue limit', async () => {
  const commands = []
  const tools = []
  let blocked = 0
  apply({
    effect() {},
    commands: { register(value) { commands.push(value) } },
    tools: { register(value) { tools.push(value) } },
    sessionQuery: {
      listSessions() {
        blocked += 1
        return new Promise(() => {})
      },
      async observeSession() { throw new Error('not reached') },
    },
  })
  const prepare = tools.find((t) => t.name === 'session_insights_prepare')
  const signal = new AbortController().signal
  const running = Array.from({ length: _test.ANALYSIS_CONCURRENCY + _test.ANALYSIS_QUEUE_LIMIT }, () =>
    prepare.execute({ days: 30, locale: 'en' }, { signal }))
  await new Promise((r) => setImmediate(r))
  await assert.rejects(
    prepare.execute({ days: 30, locale: 'en' }, { signal }),
    /queue is full/,
  )
  for (const run of running) run.catch(() => {})
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
      await access(result.text.split('\n')[0].replace(/^Session insights report: /, ''))
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('cancellation terminates native analysis promptly', async () => {
  const controller = new AbortController()
  const data = syntheticSessions(1)
  const snapshot = [...data.snapshots.values()][0]
  snapshot.events = Array.from({ length: 100000 }, (_, seq) => ({ seq, type: 'tool/call', data: { callId: String(seq), name: 'bash', arguments: 'test' } }))
  const started = Date.now()
  const running = _test.analyze([snapshot], { now: Date.now() }, controller.signal)
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(running, /session insights cancelled/)
  assert.ok(Date.now() - started < 5000)
})

test('invalid semantic output is never persisted before deterministic fallback', async () => {
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

test('--no-open returns a bare path line without any view hint', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-insights-no-open-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporary
  try {
    const registered = registerPlugin(syntheticSessions(6))
    const signal = new AbortController().signal
    const open = await registered.commands[0].handler({ rawInput: '--deterministic --locale en', signal, agent: registered.agent })
    assert.match(open.text.split('\n')[0], /^Session insights report: \S+$/)
    assert.match(open.text, /Open the report file in a local browser/)
    const closed = await registered.commands[0].handler({ rawInput: '--deterministic --locale en --no-open', signal, agent: registered.agent })
    assert.equal(closed.kind, 'success')
    assert.ok(closed.text.endsWith('/report.html'))
    assert.equal(closed.text.split('\n').length, 1)
    await access(closed.text)
    const metrics = await registered.commands[0].handler({ rawInput: '--privacy metrics --locale en --no-open', signal, agent: registered.agent })
    assert.equal(metrics.kind, 'success')
    assert.equal(metrics.text.split('\n').length, 1)
    await access(metrics.text)
    assert.ok(!closed.text.includes('Open the report file'), 'no view hint may be appended with --no-open')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('deterministic slash command analyzes sessionQuery data into a report', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-insights-node-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = temporary
  try {
    const commands = []
    const now = Date.now()
    const snapshot = [...syntheticSessions().snapshots.values()][0], header = snapshot.session
    apply({
      effect() {},
    effect() {},
      commands: { register(value) { commands.push(value) } },
      tools: { register() {} },
      sessionQuery: {
        async listSessions() { return [{ header, live: false, persisted: true }] },
        async observeSession() { return {header:snapshot.session,events:snapshot.events,inheritedEventCount:0,[Symbol.dispose]() {}} },
      },
    })
    const result = await commands[0].handler({ rawInput: '--deterministic --locale en', signal: new AbortController().signal })
    assert.equal(result.kind, 'success', result.text)
    const reportPath = result.text.split('\n')[0].replace(/^Session insights report: /, '')
    await access(reportPath)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

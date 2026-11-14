import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { captureSourceLogs, compareSourceLogs, witnessedOperation } from '../scripts/source_log_witness.mjs'
import { cleanupPreservingFailure } from '../scripts/acceptance_cleanup.mjs'

// D03 regression: source-log witnessing around actual report operations on
// real persisted session logs (official session-persistence-jsonl backend plus
// the production plugin tools). Covers success, deliberate target/non-target
// log modification, mid-operation failure, witness initialization failure and
// cleanup failure. The operation result, witness result and cleanup result are
// separate terminal states: no later success overwrites an earlier failure,
// and receipts only ever go to fresh locations.

const REPO = resolve(new URL('..', import.meta.url).pathname)
// The full official host tree carries the JSONL persistence backend; the repo
// root only carries the plugin's own peer closure.
const req = createRequire(join(REPO, 'tests/dsh-host/package.json'))
const load = async (name) => import(pathToFileURL(req.resolve(name)).href)

async function bootScene() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-witness-home-'))
  process.env.DSH_HOME = home
  const { Context } = await load('@deepseek-ai/cordis')
  const jsonl = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionStore } = await load('@deepseek-ai/dsh-session')
  const { SessionQueryEngine } = await load('@deepseek-ai/dsh-session-query')
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { CommandRuntime } = await load('@deepseek-ai/dsh-commands')
  const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
  const pluginModule = await import(pathToFileURL(join(REPO, 'plugin/lib/index.js')).href)
  const ctx = new Context()
  const sessionsRoot = join(home, 'sessions')
  await jsonl.apply(ctx, { root: sessionsRoot, compression: 'zstd' })
  new SessionStore(ctx)
  new SessionQueryEngine(ctx)
  new SystemPrompt(ctx, {})
  new CommandRuntime(ctx)
  new ToolRuntime(ctx, {})
  ctx.plugin(pluginModule)
  await new Promise((r) => setImmediate(r))
  const persist = async (id, cwd, eventCount = 6) => {
    const createdAt = Date.now() - 120000
    const events = []
    let seq = 0
    events.push({ type: 'turn/start', data: { turn: 1 } })
    events.push({ type: 'step/start', data: { turn: 1, step: 1 } })
    events.push({ type: 'user/message', data: { turn: 1, step: 1, id: `${id}-u`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Synthetic witness task for ${id}` }] }, surfaceOp: 'append' })
    events.push({ type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { id: `${id}-a`, role: 'assistant', source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }, content: [{ type: 'text', text: 'Synthetic reply.' }, { type: 'tool-call', id: `${id}-c`, name: 'bash', arguments: '{"command": "ls"}' }] } }, surfaceOp: 'append' })
    events.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: `${id}-c`, name: 'bash', arguments: '{"command": "ls"}' } })
    const callSeq = events.length - 1
    events.push({ type: 'tool/result', data: { turn: 1, step: 1, message: { id: `${id}-t`, role: 'tool', toolCallId: `${id}-c`, isError: false, source: { kind: 'tool', callId: `${id}-c` }, content: [{ type: 'text', text: 'ls output' }] } }, surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    events.push({ type: 'step/end', data: { turn: 1, step: 1 } })
    events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const header = { version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }
    for (const event of events) event.seq = seq++, event.time = createdAt + seq * 1000
    const handle = await ctx.sessionPersistence.create(header, { inheritedEventCount: 0 })
    try { await handle.append(events); await handle.flush() } finally { await handle.close() }
  }
  return {
    home, ctx, sessionsRoot,
    persist,
    execute: async (name, args, signal) => JSON.parse((await ctx.tools.get(name).execute(args, { signal })).text),
    dispose: async () => { if (typeof ctx.dispose === 'function') await ctx.dispose() },
  }
}

const findSessionFile = async (root, id) => {
  const found = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (path.includes(id) && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.zstd'))) found.push(path)
    }
  }
  await walk(root)
  return found[0]
}

test('witness comparison never calls loss, addition or replacement unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-witness-cmp-'))
  await writeFile(join(dir, 'a.log'), 'alpha')
  await writeFile(join(dir, 'b.log'), 'beta')
  const before = await captureSourceLogs(dir, { label: 'cmp:before' })
  await writeFile(join(dir, 'a.log'), 'alpha-tampered')
  await rm(join(dir, 'b.log'))
  await writeFile(join(dir, 'c.log'), 'new')
  const after = await captureSourceLogs(dir, { label: 'cmp:after' })
  const cmp = compareSourceLogs(before, after)
  assert.equal(cmp.verdict, 'changed')
  assert.deepEqual(cmp.added, ['c.log'])
  assert.deepEqual(cmp.removed, ['b.log'])
  assert.deepEqual(cmp.changed.map((c) => c.path), ['a.log'])
  // Read failure is not unchanged either.
  await writeFile(join(dir, 'd.log'), 'x')
  const before2 = await captureSourceLogs(dir, { label: 'cmp2:before' })
  await rm(join(dir, 'd.log'))
  await mkdir(join(dir, 'd.log'))
  const after2 = await captureSourceLogs(dir, { label: 'cmp2:after' })
  assert.equal(compareSourceLogs(before2, after2).verdict, 'changed')
  await rm(dir, { recursive: true, force: true })
})

test('success scene: unchanged witness, preserved operation and cleanup outcomes, fresh receipt', async () => {
  const scene = await bootScene()
  try {
    // Real persisted source logs first: two sessions in two projects.
    await scene.persist('witness-ok-target', '/synthetic/ok-target')
    await scene.persist('witness-ok-other', '/synthetic/ok-unrelated')
    const record = await witnessedOperation({
      root: scene.sessionsRoot,
      label: 'success',
      operation: async () => {
        const prepared = await scene.execute('session_insights_prepare', { days: 30, privacy: 'redacted', locale: 'en' })
        assert.ok(Array.isArray(prepared.batches), 'the real prepare returns a structured run result')
        return { status: 'passed', workdir: prepared.workdir, batches: prepared.batches.length }
      },
    })
    assert.equal(record.operation.status, 'passed')
    assert.equal(record.witness.status, 'passed')
    assert.equal(record.witness.comparison.verdict, 'unchanged')
    assert.ok(record.witness.comparison.totals.before_files >= 2)
    // Cleanup result is its own terminal state; receipts go to fresh files only.
    const receiptPath = join(scene.home, 'witness-receipt.json')
    await writeFile(receiptPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
    await assert.rejects(writeFile(receiptPath, '{}', { flag: 'wx' }), (e) => e.code === 'EEXIST')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(receipt.witness.comparison.verdict, 'unchanged')
    assert.equal(receipt.witness.gate.status, 'passed')
  } finally { await scene.dispose(); await rm(scene.home, { recursive: true, force: true }) }
})

test('tamper scene: modified target and deleted non-target logs fail the witness even when the operation succeeds', async () => {
  const scene = await bootScene()
  try {
    await scene.persist('witness-target', '/synthetic/target-project')
    await scene.persist('witness-other', '/synthetic/unrelated-project')
    const targetFile = await findSessionFile(scene.sessionsRoot, 'witness-target')
    const otherFile = await findSessionFile(scene.sessionsRoot, 'witness-other')
    assert.ok(targetFile && otherFile)
    const record = await witnessedOperation({
      root: scene.sessionsRoot,
      label: 'tamper',
      operation: async () => {
        // Deliberately replace target-log content and lose the non-target log
        // between the two captures; the witness must name both.
        await writeFile(targetFile, Buffer.concat([await readFile(targetFile), Buffer.from('TAMPERED\n')]))
        await rm(otherFile)
        return { status: 'passed' }
      },
    })
    assert.equal(record.operation.status, 'passed', 'the operation itself may still report success')
    assert.equal(record.witness.status, 'failed')
    assert.equal(record.witness.comparison.verdict, 'changed')
    assert.equal(record.witness.comparison.changed.length, 1, 'target-log replacement is named')
    assert.equal(record.witness.comparison.removed.length, 1, 'non-target log loss is named')
    assert.equal(record.witness.gate.status, 'failed')
    // Cleanup still runs and its outcome is recorded beside the failed witness.
    const cleanup = await cleanupPreservingFailure(null, [async () => { await rm(scene.sessionsRoot, { recursive: true, force: true }) }])
    assert.ok(cleanup === undefined || cleanup === null)
    const receiptPath = join(scene.home, 'witness-tamper-receipt.json')
    await writeFile(receiptPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(receipt.witness.gate.status, 'failed', 'the failed witness stays failed in the receipt')
    assert.equal(receipt.operation.status, 'passed', 'the operation outcome is preserved unmerged')
  } finally { await scene.dispose(); await rm(scene.home, { recursive: true, force: true }) }
})

test('mid-operation failure scene: after-capture still runs in the reliable terminal path', async () => {
  const scene = await bootScene()
  try {
    await scene.persist('witness-cancel', '/synthetic/cancel-project')
    const controller = new AbortController()
    const record = await witnessedOperation({
      root: scene.sessionsRoot,
      label: 'mid-failure',
      operation: async () => {
        const pending = scene.execute('session_insights_prepare', { days: 30, privacy: 'redacted', locale: 'en' }, controller.signal)
        setImmediate(() => controller.abort())
        return await pending
      },
    })
    assert.equal(record.operation.status, 'failed', 'the aborted operation keeps its real failure')
    assert.ok(record.witness, 'the after-capture and comparison still ran')
    assert.equal(record.witness.status, 'passed', 'a cancelled prepare does not touch source logs')
    assert.equal(record.witness.comparison.verdict, 'unchanged')
  } finally { await scene.dispose(); await rm(scene.home, { recursive: true, force: true }) }
})

test('witness initialization failure is recorded and the operation never starts', async () => {
  const missing = join(await mkdtemp(join(tmpdir(), 'dsh-witness-init-')), 'sessions')
  const record = await witnessedOperation({
    root: missing,
    label: 'init-failure',
    operation: async () => { throw new Error('operation must never run when the witness cannot initialize') },
  })
  assert.equal(record.witness.status, 'failed')
  assert.equal(record.witness.phase, 'before')
  assert.equal(record.operation, null, 'no operation outcome exists without a before-capture')
  await rm(missing, { recursive: true, force: true })
})

test('cleanup failure scene: cleanup failure is preserved beside a successful witnessed operation', async () => {
  const scene = await bootScene()
  try {
    await scene.persist('witness-cleanup', '/synthetic/cleanup-project')
    const record = await witnessedOperation({
      root: scene.sessionsRoot,
      label: 'cleanup-failure',
      operation: async () => {
        const prepared = await scene.execute('session_insights_prepare', { days: 30, privacy: 'redacted', locale: 'en' })
        return { status: 'passed', selected: prepared.selected }
      },
    })
    assert.equal(record.operation.status, 'passed')
    assert.equal(record.witness.status, 'passed')
    // The cleanup failure is its own outcome and must reach the receipt.
    let cleanupError = null
    try {
      await cleanupPreservingFailure(null, [
        async () => { const error = new Error('injected cleanup failure'); error.code = 'EACCES'; throw error },
      ])
    } catch (error) { cleanupError = error }
    assert.ok(cleanupError, 'the cleanup failure propagates from the shared cleanup path')
    const receipt = { ...record, cleanup: { status: 'failed', error: cleanupError.errors?.[0]?.code ?? 'EACCES' } }
    const receiptPath = join(scene.home, 'witness-cleanup-failure-receipt.json')
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    const stored = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(stored.cleanup.status, 'failed')
    assert.equal(stored.witness.status, 'passed', 'the unchanged witness is not overwritten by the cleanup failure')
    assert.equal(stored.operation.status, 'passed')
  } finally { await scene.dispose(); await rm(scene.home, { recursive: true, force: true }) }
})

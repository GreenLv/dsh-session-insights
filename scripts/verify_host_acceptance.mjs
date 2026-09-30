#!/usr/bin/env node
// Portable installed-artifact gate. Uses real target Session/query and tool
// services with populated synthetic input. Full profile boot, JSONL persistence
// and model roundtrips require separate native-host gates.
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {resolve, join, dirname, basename} from 'node:path'
import {readFile, writeFile, mkdir, mkdtemp, rm, readdir, symlink, cp, realpath, stat} from 'node:fs/promises'
import assert from 'node:assert/strict'
import {run, digest, fileManifest, inspectRuntime, TARGET} from './acceptance_identity.mjs'
const MINIMUM_DSH_RANGE = '>=0.2.0-rc.2'

const TOOLS = ['session_insights_prepare', 'session_insights_get_batch', 'session_insights_submit_batch', 'session_insights_get_aggregate', 'session_insights_submit_aggregate', 'session_insights_finalize', 'session_insights_cleanup']
const REQUIRED = ['artifact_digest', 'artifact_identity', 'runtime_closure', 'host_cli_identity', 'install_official_cli', 'installed_manifest', 'uninstall_official_cli', 'reload_official_cli', 'reloaded_manifest', 'loaded_manifest', 'load_and_register', 'project_isolation', 'deterministic_report', 'cancel_recovers', 'rerun_after_cancel', 'registration_reload', 'dispose_cleanup']

function parseArgs(argv) {
  const result = {}, paths = new Set(['package', 'runtime', 'host', 'workdir', 'annex'])
  const keys = ['package', 'expected-sha256', 'commit', 'runtime', 'host', 'workdir', 'annex']
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2)
    if (argv[i] !== '--' + key || !keys.includes(key) || result[key] || !argv[i + 1]) throw new Error('invalid or duplicate option')
    result[key] = paths.has(key) ? resolve(argv[++i]) : argv[++i]
  }
  if (keys.some(key => !result[key])) throw new Error('all acceptance options are required')
  if (!/^[0-9a-f]{40}$/.test(result.commit) || !/^[0-9a-f]{64}$/.test(result['expected-sha256'])) throw new Error('full commit and lowercase SHA-256 are required')
  return result
}

async function findInstalled(root) {
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = join(root, entry.name)
    if (entry.name === 'dsh-session-insights') {
      try { if (JSON.parse(await readFile(join(path, 'package.json'), 'utf8')).name === entry.name) return await realpath(path) } catch {}
    }
    if (entry.isDirectory()) {
      const found = await findInstalled(path)
      if (found) return found
    }
  }
  return null
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const annex = {
    schema: 'native-acceptance/v2', status: 'failed', product: 'dsh-session-insights', gate_profile: 'portable-installed-artifact',
    repository: {url: 'https://github.com/GreenLv/dsh-session-insights', commit: options.commit},
    runtime_tree_sha256: null, artifact: null,
    platform: {os: {win32: 'windows', darwin: 'macos', linux: 'linux'}[process.platform], shell: process.platform === 'win32' ? 'pwsh' : 'posix', toolchain: {node: process.version, architecture: process.arch}},
    gates: [], cleanup: {status: 'not_run', remaining_ids: []},
    run: {started_at: new Date().toISOString(), finished_at: '', run_url: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null},
    unperformed_actions: ['commit', 'push', 'merge', 'tag', 'package_publish', 'release', 'public_promotion'],
  }
  let stage = 'artifact_digest', work, ctx, handle, savedHome = process.env.DSH_HOME
  const record = (id, ok, note, subject = annex.artifact ? {kind: 'artifact', id: annex.artifact.sha256} : {kind: 'commit', id: options.commit}) => {
    annex.gates.push({id, required: true, status: ok ? 'passed' : 'failed', subject, exit_code: ok ? 0 : 1, note,
      evidence: {mode: 'executed', source_result_sha256: null, source_gate_id: null, invalidation_reason: null}})
    console.error(`[${ok ? 'passed' : 'failed'}] ${id}: ${note}`)
    if (!ok) throw new Error('gate failed')
  }
  const gate = async (id, operation) => { stage = id; await operation() }
  try {
    const bytes = await readFile(options.package)
    record('artifact_digest', digest(bytes) === options['expected-sha256'], 'accepted SHA-256 compared before install')
    work = await mkdtemp(join(options.workdir, 'host-acceptance-'))
    const home = join(work, 'dsh-home'), extraction = join(work, 'artifact')
    await mkdir(home); await mkdir(extraction)
    // Store resolves DSH_HOME in this process, not just CLI children.
    process.env.DSH_HOME = home
    await gate('artifact_identity', async () => {
      await run('tar', ['-xzf', options.package, '-C', extraction])
      const metadata = JSON.parse(await readFile(join(extraction, 'package/package.json'), 'utf8'))
      assert.equal(metadata.name, 'dsh-session-insights'); assert.equal(metadata.version, '0.6.0')
      assert.equal(metadata.engines.dsh, MINIMUM_DSH_RANGE); assert.equal(metadata.dsh.engines.dsh, MINIMUM_DSH_RANGE)
      assert.equal(metadata.gitHead, options.commit)
      const files = await fileManifest(join(extraction, 'package'))
      assert.ok(files.length > 0)
      annex.artifact = {filename: basename(options.package), sha256: digest(bytes), size_bytes: bytes.length, file_count: files.length, git_head: metadata.gitHead}
      record('artifact_identity', true, `0.6.0, exact host, embedded commit, ${files.length} files`)
    })
    await gate('runtime_closure', async () => {
      const runtime = await inspectRuntime(options.runtime)
      annex.runtime_tree_sha256 = runtime.sha256
      record('runtime_closure', true, `${runtime.identities.length} resolved DSH/Cordis package inventories`, {kind: 'runtime_tree', id: runtime.sha256})
    })
    const hostPackage = await realpath(join(options.host, 'node_modules/@deepseek-ai/dsh/package.json'))
    const dshBin = join(dirname(hostPackage), 'lib/bin.js')
    await gate('host_cli_identity', async () => {
      assert.equal(JSON.parse(await readFile(hostPackage, 'utf8')).version, TARGET)
      assert.equal((await run(process.execPath, [dshBin, '--version'], {env: {...process.env}, cwd: work})).stdout.trim(), TARGET)
      record('host_cli_identity', true, `actual CLI --version ${TARGET}`)
    })
    const cliEnv = {...process.env, npm_config_cache: join(work, 'npm-cache'), npm_config_store_dir: join(work, 'pnpm-store'), XDG_CACHE_HOME: join(work, 'cache'), XDG_DATA_HOME: join(work, 'data')}
    const cli = args => run(process.execPath, [dshBin, 'plugin', '--profile', 'web', ...args], {env: cliEnv, cwd: work, maxBuffer: 8 * 1024 * 1024, timeout: 180000})
    const expectedFiles = await fileManifest(join(extraction, 'package'))
    await gate('install_official_cli', async () => {
      await cli(['add', options.package]); assert.ok(await findInstalled(home))
      record('install_official_cli', true, 'official CLI installed into scratch DSH_HOME')
    })
    await gate('installed_manifest', async () => {
      assert.deepEqual(await fileManifest(await findInstalled(home)), expectedFiles)
      record('installed_manifest', true, `${expectedFiles.length} installed files match artifact`)
    })
    await gate('uninstall_official_cli', async () => {
      await cli(['remove', 'dsh-session-insights']); assert.equal(await findInstalled(home), null)
      record('uninstall_official_cli', true, 'official CLI removed scratch installation')
    })
    await gate('reload_official_cli', async () => {
      await cli(['add', options.package]); assert.ok(await findInstalled(home))
      record('reload_official_cli', true, 'same artifact reinstalled')
    })
    const finalDir = await findInstalled(home)
    await gate('reloaded_manifest', async () => {
      assert.deepEqual(await fileManifest(finalDir), expectedFiles)
      record('reloaded_manifest', true, 'reinstalled bytes independently compared')
    })
    const loadRoot = join(work, 'load-root'), loaded = join(loadRoot, 'dsh-session-insights')
    await mkdir(loadRoot)
    await symlink(await realpath(join(options.runtime, 'node_modules')), join(loadRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await cp(finalDir, loaded, {recursive: true})
    await gate('loaded_manifest', async () => {
      assert.deepEqual(await fileManifest(loaded), expectedFiles)
      record('loaded_manifest', true, 'loaded package copy matches accepted installed bytes')
    })
    const req = createRequire(join(options.runtime, 'package.json')), load = name => import(pathToFileURL(req.resolve(name)).href)
    const {Context} = await load('@deepseek-ai/cordis')
    const {SessionStore} = await load('@deepseek-ai/dsh-session')
    const {SessionQueryEngine} = await load('@deepseek-ai/dsh-session-query')
    const {CommandRuntime} = await load('@deepseek-ai/dsh-commands')
    const {ToolRuntime} = await load('@deepseek-ai/dsh-tools')
    const {SystemPrompt} = await load('@deepseek-ai/dsh-system-prompt')
    const {sessionFormatCatalog} = await load('@deepseek-ai/dsh-session-format-catalog')
    const plugin = await import(pathToFileURL(join(loaded, 'plugin/lib/index.js')).href)
    const {Store} = await import(pathToFileURL(join(loaded, 'plugin/lib/storage.js')).href)
    ctx = new Context(); const sessions = new SessionStore(ctx)
    new SessionQueryEngine(ctx); new SystemPrompt(ctx, {}); new CommandRuntime(ctx); new ToolRuntime(ctx, {})
    handle = ctx.plugin(plugin); await new Promise(r => setImmediate(r))
    await gate('load_and_register', async () => {
      assert.ok(TOOLS.every(name => ctx.tools.get(name))); assert.ok(ctx.commands.find(undefined, 'session-insights'))
      record('load_and_register', true, 'seven tools and command present in real registries')
    })
    const project = join(work, '测试 项目 目录'), unrelatedProject = join(work, 'unrelated')
    const fixture = async (name, id, cwd) => {
      const rows = (await readFile(new URL(`../tests/fixtures/rc2-repairs/${name}/session.v4.jsonl`, import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse)
      const delta = Date.now() - 60000 - rows[0].createdAt
      rows[0].id = id; rows[0].cwd = cwd; rows[0].createdAt += delta
      for (const row of rows.slice(1)) row.time += delta
      const restore = sessionFormatCatalog.createRestore(rows[0], {recovery: 'strict', validation: 'current'})
      for (const row of rows.slice(1)) restore.decodeRow(row)
      const restored = restore.finish()
      return sessions.create(id, {seed: restored.events, meta: restored.header, inheritedEventCount: restored.inheritedEventCount})
    }
    await fixture('recovery-mixed-group', 'acceptance-target', project)
    await fixture('optional-isError', 'acceptance-unrelated', unrelatedProject)
    await gate('project_isolation', async () => {
      const all = await ctx.sessionQuery.listSessions()
      const selected = await plugin._test.collectSnapshots(ctx, {now: Date.now(), days: 30, project})
      assert.equal(all.length, 2); assert.equal(selected.length, 1); assert.equal(selected[0].session.id, 'acceptance-target')
      record('project_isolation', true, 'actual query and production project filter select one of two populated sessions')
    })
    const signal = new AbortController().signal, args = {days: 30, project, privacy: 'redacted', locale: 'zh-CN'}
    const execute = async (name, args, signal) => JSON.parse((await ctx.tools.get(name).execute(args, {signal})).text)
    const prepareAndFinalize = async locale => {
      const prepared = await execute('session_insights_prepare', {...args, locale}, signal)
      assert.ok(prepared.selected > 0); assert.ok(prepared.batches.length > 0)
      assert.ok(prepared.workdir.startsWith(home + (process.platform === 'win32' ? '\\' : '/')))
      const final = await execute('session_insights_finalize', {workdir: prepared.workdir, fallback: true}, signal)
      const report = JSON.parse(await readFile(final.data, 'utf8'))
      assert.equal(report.totals.sessions, 1); assert.equal(report.totals.tool_failures, 1)
      assert.equal(report.totals.repeated_retries, 0)
      assert.deepEqual(report.totals.tool_recovery, {outcome_unknown: 1, not_started: 1})
      assert.equal(report.semantic_analysis.status, 'fallback'); assert.ok((await stat(final.report)).size > 0)
      return prepared.workdir
    }
    await gate('deterministic_report', async () => {
      const first = await prepareAndFinalize('zh-CN'), second = await prepareAndFinalize('en')
      assert.notEqual(first, second)
      record('deterministic_report', true, 'both languages: one session, one ordinary failure, both recovery counters equal one')
    })
    await gate('cancel_recovers', async () => {
      const store = new Store(), before = store.list().sort(), controller = new AbortController()
      const pending = execute('session_insights_prepare', args, controller.signal)
      setImmediate(() => controller.abort())
      await assert.rejects(pending, /cancel/)
      await new Promise(r => setTimeout(r, 500))
      assert.deepEqual(store.list().sort(), before)
      record('cancel_recovers', true, 'pending real prepare cancelled; no new run during 500 ms observation (phase unspecified)')
    })
    await gate('rerun_after_cancel', async () => {
      await prepareAndFinalize('zh-CN'); record('rerun_after_cancel', true, 'populated tool workflow succeeded after cancellation')
    })
    await gate('registration_reload', async () => {
      const old = handle; await old.dispose(); assert.ok(TOOLS.every(name => !ctx.tools.get(name))); assert.equal(ctx.commands.find(undefined, 'session-insights'), undefined)
      handle = ctx.plugin(plugin); await new Promise(r => setImmediate(r)); await old.dispose()
      assert.ok(TOOLS.every(name => ctx.tools.get(name))); assert.ok(ctx.commands.find(undefined, 'session-insights'))
      record('registration_reload', true, 'dispose and fresh registration; repeated old disposer preserves new owner')
    })
  } catch {
    if (!annex.gates.some(g => g.id === stage)) {
      annex.gates.push({id: stage, required: true, status: 'failed', subject: annex.artifact ? {kind: 'artifact', id: annex.artifact.sha256} : {kind: 'commit', id: options.commit}, exit_code: 1, note: 'operation failed; no private paths or subprocess output published', evidence: {mode: 'executed', source_result_sha256: null, source_gate_id: null, invalidation_reason: null}})
      console.error(`[failed] ${stage}`)
    }
  } finally {
    if (ctx) {
      try { await ctx.fiber.dispose(); assert.ok(!ctx.tools || TOOLS.every(name => !ctx.tools.get(name))); record('dispose_cleanup', true, 'context disposed and tools absent') }
      catch { if (!annex.gates.some(g => g.id === 'dispose_cleanup')) annex.gates.push({id: 'dispose_cleanup', required: true, status: 'failed', subject: {kind: 'commit', id: options.commit}, exit_code: 1, note: 'context disposal failed', evidence: {mode: 'executed', source_result_sha256: null, source_gate_id: null, invalidation_reason: null}}) }
    }
    try {
      if (work) { await rm(work, {recursive: true, force: true, maxRetries: 3}); await assert.rejects(stat(work), {code: 'ENOENT'}) }
      annex.cleanup = {status: 'passed', remaining_ids: []}
    } catch { annex.cleanup = {status: 'failed', remaining_ids: ['scratch-work']} }
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    for (const id of REQUIRED) if (!annex.gates.some(g => g.id === id)) annex.gates.push({id, required: true, status: 'not_run', subject: {kind: 'commit', id: options.commit}, exit_code: null, note: 'prerequisite failed', evidence: {mode: 'executed', source_result_sha256: null, source_gate_id: null, invalidation_reason: null}})
    for (const id of ['full_profile_boot', 'real_jsonl_persistence', 'real_agent_command', 'real_model_workflow']) annex.gates.push({id, required: false, status: 'not_run', subject: {kind: 'commit', id: options.commit}, exit_code: null, note: 'separate actual-host acceptance; outside this portable service gate', evidence: {mode: 'executed', source_result_sha256: null, source_gate_id: null, invalidation_reason: null}})
    annex.status = annex.gates.every(g => !g.required || g.status === 'passed') && annex.cleanup.status === 'passed' ? 'passed' : 'failed'
    annex.run.finished_at = new Date().toISOString()
    await mkdir(dirname(options.annex), {recursive: true}); await writeFile(options.annex, JSON.stringify(annex, null, 2) + '\n')
  }
  return annex.status === 'passed' ? 0 : 1
}

main().then(code => {process.exitCode = code}, () => {console.error('invalid acceptance invocation'); process.exitCode = 1})

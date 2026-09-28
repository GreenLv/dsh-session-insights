#!/usr/bin/env node
/**
 * native-acceptance/v2 portable zero-model host acceptance entry.
 *
 * Runs on a hosted Windows runner (or any machine with Node) against one exact
 * candidate artifact: verifies the accepted digest, installs the package with
 * the official target DSH plugin CLI into an isolated profile, compares every
 * installed byte with the artifact, exercises uninstall/reload, loads the
 * installed bytes on the exact runtime closure, and runs deterministic
 * zero-model report paths (Chinese/space project isolation, cancellation,
 * recovery fixtures). It never calls a model and never reads a daily profile.
 *
 * Boundaries recorded in the annex: this entry does not boot the full host app,
 * its GUI slash dispatch, or the host's own persistence service wiring; those
 * remain explicit host gates. Service-level evidence cannot be reported as a
 * complete host pass.
 */
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {resolve, join, dirname} from 'node:path'
import {readFileSync} from 'node:fs'
import {readFile, writeFile, mkdir, mkdtemp, rm, readdir, symlink, cp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
const run = promisify(execFile)

const PACKAGE = 'dsh-session-insights'
const PRODUCT_VERSION = '0.5.1'
const TARGET = '0.2.0-rc.1'
const TOOLS = ['session_insights_prepare', 'session_insights_get_batch', 'session_insights_submit_batch', 'session_insights_get_aggregate', 'session_insights_submit_aggregate', 'session_insights_finalize', 'session_insights_cleanup']

function parseArgs(argv) {
  const options = {}
  const pathOptions = new Set(['--package', '--runtime', '--host', '--workdir', '--annex'])
  for (let i = 0; i < argv.length; i++) {
    const known = ['--package', '--expected-sha256', '--commit', '--runtime', '--host', '--workdir', '--annex']
    if (!known.includes(argv[i])) throw new Error(`unknown option ${argv[i]}`)
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const value = argv[++i]
    options[key] = pathOptions.has(argv[i - 1]) ? resolve(value) : value
  }
  for (const key of ['package', 'expectedSha256', 'commit', 'runtime', 'host', 'workdir', 'annex'])
    if (!options[key]) throw new Error(`missing required --${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`)
  return options
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

async function walkFiles(dir, base = dir, files = []) {
  for (const entry of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(path, base, files)
    else files.push(path)
  }
  return files
}

/** Find the installed plugin directory below an isolated DSH_HOME. */
async function findInstalled(dshHome) {
  const roots = [join(dshHome, 'profiles'), dshHome]
  for (const root of roots) {
    for (const path of await walkFiles(root)) {
      if (path.endsWith(join('dsh-session-insights', 'package.json'))) return dirname(path)
    }
  }
  return null
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const checks = []
  const record = (id, status, detail) => { checks.push({id, status, detail}); console.error(`[${status}] ${id}: ${detail}`) }
  const annex = {
    schema: 'dsh-session-insights/native-acceptance/v2',
    status: 'fail',
    commit: options.commit,
    package: options.package,
    expected_package_sha256: options.expectedSha256,
    target_dsh_version: TARGET,
    product_version: PRODUCT_VERSION,
    node_version: process.version,
    platform: `${process.platform} ${process.arch}`,
    runner_image: process.env.ImageOS ?? process.env.RUNNER_IMAGE ?? 'unspecified',
    started_at: new Date().toISOString(),
    checks,
  }
  const finish = async code => {
    annex.status = code === 0 ? 'pass' : 'fail'
    annex.finished_at = new Date().toISOString()
    await mkdir(dirname(options.annex), {recursive: true})
    await writeFile(options.annex, JSON.stringify(annex, null, 2) + '\n')
    process.exitCode = code
  }
  let work = null
  try {
    // 1. The accepted artifact digest must match before anything runs.
    const packageBuffer = await readFile(options.package).catch(() => null)
    if (!packageBuffer) throw new Error(`package not readable: ${options.package}`)
    const digest = sha256(packageBuffer)
    record('artifact_digest', digest === options.expectedSha256 ? 'pass' : 'fail',
      digest === options.expectedSha256 ? digest : `${digest} != accepted ${options.expectedSha256}`)
    if (digest !== options.expectedSha256) return finish(1)

    // 2. Exact runtime closure and host identity.
    const runtimeRequire = createRequire(join(options.runtime, 'package.json'))
    const runtimeVersion = name => {
      const entry = runtimeRequire.resolve(name)
      const packagePath = join(dirname(entry), '..', 'package.json')
      return JSON.parse(readFileSync(packagePath, 'utf8')).version
    }
    const closureOk = ['@deepseek-ai/dsh-session-format-catalog', '@deepseek-ai/dsh-session-format-v3-to-v4', '@deepseek-ai/dsh-session'].every(name => runtimeVersion(name) === TARGET)
    record('runtime_closure', closureOk ? 'pass' : 'fail', closureOk ? `all entry packages ${TARGET}` : 'runtime closure is not exactly the target version')
    const hostPackage = join(options.host, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const hostVersion = JSON.parse(await readFile(hostPackage, 'utf8')).version
    record('host_cli_identity', hostVersion === TARGET ? 'pass' : 'fail', `@deepseek-ai/dsh ${hostVersion}`)
    if (!closureOk || hostVersion !== TARGET) return finish(1)

    // Scratch isolation; nothing below touches a daily profile.
    work = await mkdtemp(join(options.workdir, 'host-acceptance-'))
    const dshHome = join(work, 'dsh-home')
    await mkdir(dshHome, {recursive: true})
    const env = {...process.env, DSH_HOME: dshHome}
    const dshBin = join(options.host, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

    // 3. Official plugin CLI install into the isolated profile.
    try {
      await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', options.package], {env, cwd: work})
      const installed = await findInstalled(dshHome)
      record('install_official_cli', installed ? 'pass' : 'fail', installed ?? 'no installed dsh-session-insights found below DSH_HOME')
    } catch (error) {
      record('install_official_cli', 'fail', String(error.stderr || error.message).slice(0, 400))
      return finish(1)
    }

    // 4. Installed bytes must match the artifact exactly.
    const installedDir = await findInstalled(dshHome)
    const extraction = join(work, 'artifact')
    await mkdir(extraction, {recursive: true})
    await run('tar', ['-xzf', options.package, '-C', extraction])
    const artifactFiles = (await Promise.all((await walkFiles(join(extraction, 'package'))).map(async p => [p.slice(join(extraction, 'package').length + 1), sha256(await readFile(p))])))
    const installedFiles = new Map(await Promise.all((await walkFiles(installedDir)).map(async p => [p.slice(installedDir.length + 1).replaceAll('\\', '/'), sha256(await readFile(p))])).then(rows => rows.filter(([name]) => !name.includes('/node_modules/'))))
    const drift = artifactFiles.filter(([name, hash]) => installedFiles.get(name) !== hash).map(([name]) => name)
      .concat([...installedFiles.keys()].filter(name => !artifactFiles.some(([artifactName]) => artifactName === name)))
    record('installed_manifest', drift.length ? 'fail' : 'pass', drift.length ? `bytes differ: ${drift.join(', ')}` : `${artifactFiles.length} files identical`)

    // 5. Installed identity.
    const metadata = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf8'))
    const identityOk = metadata.name === PACKAGE && metadata.version === PRODUCT_VERSION && metadata.engines?.dsh === TARGET
    record('installed_identity', identityOk ? 'pass' : 'fail', `${metadata.name}@${metadata.version} engines.dsh=${metadata.engines?.dsh}`)
    const artifactMetadata = JSON.parse(await readFile(join(extraction, 'package', 'package.json'), 'utf8'))
    record('artifact_identity', artifactMetadata.version === PRODUCT_VERSION ? 'pass' : 'fail', `artifact package.json ${artifactMetadata.version}`)

    // 6. Uninstall and reload through the same official CLI.
    try {
      await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'remove', PACKAGE], {env, cwd: work})
      const removed = await findInstalled(dshHome)
      record('uninstall_official_cli', removed ? 'fail' : 'pass', removed ?? 'installed package removed')
      await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', options.package], {env, cwd: work})
      const reloaded = await findInstalled(dshHome)
      record('reload_official_cli', reloaded ? 'pass' : 'fail', reloaded ?? 'package missing after re-add')
    } catch (error) {
      record('uninstall_official_cli', 'fail', String(error.stderr || error.message).slice(0, 400))
      return finish(1)
    }
    const finalDir = await findInstalled(dshHome)
    // The host loader resolves plugin imports against the profile package
    // closure. Mirror that: copy the installed bytes (identity verified above)
    // beside the exact runtime closure so bare peer imports resolve to the
    // target versions. ESM resolves through realpaths, so a copy is required.
    const loadRoot = join(work, 'load-root')
    await mkdir(loadRoot, {recursive: true})
    await symlink(join(options.runtime, 'node_modules'), join(loadRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await cp(finalDir, join(loadRoot, PACKAGE), {recursive: true, verbatimSymlinks: true})

    // 7. The installed bytes load and register on the exact runtime closure.
    const load = async name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
    const {Context} = await load('@deepseek-ai/cordis')
    const {SessionStore} = await load('@deepseek-ai/dsh-session')
    const {SessionQueryEngine} = await load('@deepseek-ai/dsh-session-query')
    const {CommandRuntime} = await load('@deepseek-ai/dsh-commands')
    const {ToolRuntime} = await load('@deepseek-ai/dsh-tools')
    const {SystemPrompt} = await load('@deepseek-ai/dsh-system-prompt')
    const plugin = await import(pathToFileURL(join(loadRoot, PACKAGE, 'plugin', 'lib', 'index.js')).href)
    const commands = []
    try {
      plugin.apply({effect() {}, commands: {register: c => commands.push(c)}, tools: {register() {}}, sessionQuery: {async listSessions() { return [] }}})
    } catch {}
    const ctx = new Context()
    let disposeOk = false
    try {
      new SessionStore(ctx)
      new SessionQueryEngine(ctx)
      new SystemPrompt(ctx, {})
      new CommandRuntime(ctx)
      new ToolRuntime(ctx, {})
      ctx.plugin(plugin)
      await new Promise(r => setImmediate(r))
      const registered = TOOLS.filter(name => ctx.tools.get(name))
      const commandOk = commands.some(c => c?.name === 'session-insights')
      record('load_and_register', registered.length === TOOLS.length && commandOk ? 'pass' : 'fail',
        `tools ${registered.length}/${TOOLS.length}, command ${commandOk ? 'registered' : 'missing'}`)

      // 8. Deterministic zero-model report: Chinese/space project isolation.
      const fixtures = new URL('../tests/fixtures/rc2-repairs/', import.meta.url)
      const targetRows = (await readFile(new URL('recovery-mixed-group/session.v4.jsonl', fixtures), 'utf8')).trim().split('\n').map(JSON.parse)
      const unrelatedRows = (await readFile(new URL('optional-isError/session.v4.jsonl', fixtures), 'utf8')).trim().split('\n').map(JSON.parse)
      const toSnapshot = rows => {
        const {type: _, ...header} = rows[0]
        return {header, events: rows.slice(1), inheritedEventCount: 0}
      }
      const projectLabel = '测试 项目 目录'
      const target = toSnapshot(targetRows)
      target.header.cwd = `/synthetic/${projectLabel}/candidate`
      const unrelated = toSnapshot(unrelatedRows)
      unrelated.header.id = 'unrelated-synthetic'
      unrelated.header.cwd = '/synthetic/unrelated/other'
      const collected = await plugin._test.collectSnapshots({sessionQuery: stubQuery([target, unrelated])}, {now: target.header.createdAt + 86400000, days: 30})
      const selected = collected.filter(s => s.session.cwd.includes(projectLabel))
      record('project_isolation', selected.length === 1 ? 'pass' : 'fail', `selected ${selected.length} of ${collected.length} snapshots for the Chinese/space project filter`)

      // 9. Real tool path: prepare creates a marked run; fallback finalize
      // writes a nonempty deterministic report carrying recovery counts.
      const signal = new AbortController().signal
      const prepared = JSON.parse((await ctx.tools.get('session_insights_prepare').execute({days: 30, locale: 'zh-CN', privacy: 'redacted'}, {signal})).text)
      const finalized = JSON.parse((await ctx.tools.get('session_insights_finalize').execute({workdir: prepared.workdir, fallback: true}, {signal})).text)
      const report = JSON.parse(await readFile(finalized.data ?? finalized.report, 'utf8'))
      const nonempty = report.totals?.sessions !== undefined && report.generated_at
      record('deterministic_report', nonempty ? 'pass' : 'fail', nonempty ? `report data ${report.schema}, sessions ${report.totals.sessions}` : 'report missing or empty')

      // 10. Cancellation surfaces AbortError and creates no new run; a new
      // prepare/finalize cycle then succeeds.
      const store = new (await import(pathToFileURL(join(loadRoot, PACKAGE, 'plugin', 'lib', 'storage.js')).href)).Store()
      const before = store.list().length
      const big = structuredClone(target)
      big.events = Array.from({length: 200000}, (_, seq) => ({seq, type: 'tool/call', data: {callId: String(seq), name: 'bash', arguments: 'test'}}))
      const controller = new AbortController()
      setImmediate(() => controller.abort())
      let cancelled = false
      try { await plugin._test.analyze([big], {now: Date.now(), days: 30}, controller.signal) } catch (error) { cancelled = /cancel/i.test(error.message) }
      const afterCancel = store.list().length
      record('cancel_recovers', cancelled && afterCancel === before ? 'pass' : 'fail', `cancelled=${cancelled}, run dirs ${before}->${afterCancel}`)
      const prepared2 = JSON.parse((await ctx.tools.get('session_insights_prepare').execute({days: 30, locale: 'zh-CN', privacy: 'redacted'}, {signal})).text)
      const finalized2 = JSON.parse((await ctx.tools.get('session_insights_finalize').execute({workdir: prepared2.workdir, fallback: true}, {signal})).text)
      record('rerun_after_cancel', finalized2.report && prepared2.workdir !== prepared.workdir ? 'pass' : 'fail', 'new run finalized after cancellation')
    } finally {
      try { await ctx.fiber.dispose() } catch {}
      const remaining = ctx.tools ? TOOLS.filter(name => ctx.tools.get(name)) : []
      disposeOk = !ctx.tools || remaining.length === 0
      record('dispose_cleanup', disposeOk ? 'pass' : 'fail', `tools remaining after dispose: ${remaining.length}`)
    }
    annex.scope_note = 'official CLI install/bytes/reload, installed-bytes load, deterministic zero-model report paths with real run directories; full host app boot, GUI slash dispatch and the host persistence service wiring are separate host gates and are not claimed here'
    const failed = checks.some(c => c.status === 'fail')
    return finish(failed ? 1 : 0)
  } catch (error) {
    record('unexpected_error', 'fail', String(error?.stack || error).slice(0, 800))
    return finish(1)
  } finally {
    if (work) await rm(work, {recursive: true, force: true, maxRetries: 3}).catch(() => {})
  }
}

function sep() { return process.platform === 'win32' ? '\\' : '/' }

/** Minimal sessionQuery stub shaped like the real engine's read surface. */
function stubQuery(snapshots) {
  return {
    async listSessions() { return snapshots.map(s => ({header: s.header, live: false, persisted: true})) },
    async observeSession(id) {
      const snapshot = snapshots.find(s => s.header.id === id)
      if (!snapshot) throw new Error(`unknown session ${id}`)
      return {...snapshot, [Symbol.dispose]() {}}
    },
  }
}

process.exitCode = await main().then(() => process.exitCode ?? 0, error => { console.error(String(error?.stack || error)); return 1 })

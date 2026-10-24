// Identity helpers for release tooling. No credentials or local paths are
// included in returned inventories.
//
// Host target selection lives in HOST_TARGETS: every acceptance tool, CI
// matrix entry and receipt derives its expected host version from here and
// verifies the actually resolved package/CLI identity against it at runtime —
// the expected value is never re-declared per script and never taken from the
// artifact under test.
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFile, readdir, realpath} from 'node:fs/promises'
import {dirname, join, relative, resolve} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
export const run = promisify(execFile)
export const digest = value => createHash('sha256').update(value).digest('hex')

// The single map of acceptance host targets. `primary` is the release
// acceptance host; `compatibility` hosts keep their source/contract coverage.
export const HOST_TARGETS = Object.freeze({
  primary: '0.2.1-rc.3',
  compatibility: Object.freeze(['0.2.1-rc.2']),
})
// Back-compat export for tools not yet parameterized (tests, one-off checks):
// the primary acceptance target.
export const TARGET = HOST_TARGETS.primary
export const MINIMUM_DSH_RANGE = '>=0.2.1-rc.2'
export const PRODUCT_VERSION = '0.6.1'

export async function fileManifest(root) {
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push({path: relative(root, path).replaceAll('\\', '/'), sha256: digest(await readFile(path))})
      else throw new Error('unexpected non-regular package member')
    }
  }
  await walk(root)
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

// Walk the runtime's actual DSH/Cordis closure and assert every member's
// published identity equals `expectedVersion`. The expected version is an
// argument, not a constant: the same helper verifies the rc.3 primary runtime
// and the rc.2 compatibility runtime without reordering anything.
export async function inspectRuntime(root, expectedVersion = TARGET) {
  const anchor = join(resolve(root), 'package.json')
  const manifest = JSON.parse(await readFile(anchor, 'utf8'))
  const identities = [], seen = new Set()
  async function visit(name, from) {
    const req = createRequire(from)
    let resolved
    try { resolved = req.resolve(name + '/package.json') }
    catch { resolved = req.resolve(name) }
    const entry = await realpath(resolved)
    let dir = dirname(entry), metadata, packagePath
    for (;;) {
      packagePath = join(dir, 'package.json')
      try { metadata = JSON.parse(await readFile(packagePath, 'utf8')) } catch {}
      if (metadata?.name === name) break
      const parent = dirname(dir)
      if (parent === dir) throw new Error('package metadata unavailable')
      dir = parent
    }
    if (seen.has(packagePath)) return
    seen.add(packagePath)
    if ((name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) && metadata.version !== expectedVersion)
      throw new Error(`mixed DSH runtime closure: ${name}@${metadata.version} at ${packagePath} (expected ${expectedVersion})`)
    if (name === '@deepseek-ai/cordis' && metadata.version !== '4.0.5') throw new Error('unexpected Cordis runtime')
    identities.push({name, version: metadata.version, files: await fileManifest(dir)})
    for (const dependency of Object.keys({...metadata.dependencies, ...metadata.peerDependencies})) {
      if (!dependency.startsWith('@deepseek-ai/dsh-') && dependency !== '@deepseek-ai/cordis') continue
      try {
        const dependencyRequire = createRequire(packagePath)
        try { dependencyRequire.resolve(dependency + '/package.json') }
        catch { dependencyRequire.resolve(dependency) }
      }
      catch { if (metadata.peerDependenciesMeta?.[dependency]?.optional) continue; throw new Error('required DSH peer missing') }
      await visit(dependency, packagePath)
    }
  }
  const roots = Object.keys(manifest.dependencies || {}).filter(name => name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/cordis')
  if (!roots.length) throw new Error('runtime root has no DSH packages')
  for (const name of roots) await visit(name, anchor)
  identities.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return {identities, sha256: digest(JSON.stringify(identities))}
}

// Check the runtime against its own declared target: read the version from the
// runtime's package.json dependencies and verify the closure matches it. Used
// by CI to prove each matrix entry really runs the version it claims.
export async function inspectRuntimeSelfConsistent(root) {
  const anchor = join(resolve(root), 'package.json')
  const manifest = JSON.parse(await readFile(anchor, 'utf8'))
  const declared = new Set(
    Object.values(manifest.dependencies || {})
      .filter(v => v.startsWith('@deepseek-ai/') || /^\d/.test(v)),
  )
  if (declared.size !== 1) throw new Error(`runtime root declares mixed DSH versions: ${[...declared].join(', ')}`)
  const expected = [...declared][0]
  const closure = await inspectRuntime(root, expected)
  return {...closure, expected}
}

export async function npm(args, options = {}) {
  const cli = process.env.npm_execpath || (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : await realpath((await run('which', ['npm'])).stdout.trim()))
  return run(process.execPath, [cli, ...args], options)
}

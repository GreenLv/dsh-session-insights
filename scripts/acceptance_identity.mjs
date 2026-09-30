// Identity helpers for release tooling. No credentials or local paths are
// included in returned inventories.
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFile, readdir, realpath} from 'node:fs/promises'
import {dirname, join, relative, resolve} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
export const run = promisify(execFile)
export const digest = value => createHash('sha256').update(value).digest('hex')
export const TARGET = '0.2.0-rc.2'

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

export async function inspectRuntime(root) {
  const anchor = join(resolve(root), 'package.json')
  const manifest = JSON.parse(await readFile(anchor, 'utf8'))
  const identities = [], seen = new Set()
  async function visit(name, from) {
    const req = createRequire(from), entry = await realpath(req.resolve(name))
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
    if (name.startsWith('@deepseek-ai/dsh-') && metadata.version !== TARGET) throw new Error('mixed DSH runtime closure')
    if (name === '@deepseek-ai/cordis' && metadata.version !== '4.0.4') throw new Error('unexpected Cordis runtime')
    identities.push({name, version: metadata.version, files: await fileManifest(dir)})
    for (const dependency of Object.keys({...metadata.dependencies, ...metadata.peerDependencies})) {
      if (!dependency.startsWith('@deepseek-ai/dsh-') && dependency !== '@deepseek-ai/cordis') continue
      try { createRequire(packagePath).resolve(dependency) }
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

export async function npm(args, options = {}) {
  const cli = process.env.npm_execpath || (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : await realpath((await run('which', ['npm'])).stdout.trim()))
  return run(process.execPath, [cli, ...args], options)
}

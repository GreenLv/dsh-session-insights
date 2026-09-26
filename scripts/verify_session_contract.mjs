#!/usr/bin/env node
/** Exact rc.2, nonempty native V4 gate. Missing runtime/files always fail. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TARGET = '0.1.7-rc.2'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
async function loadValidators(runtime) {
  const require = createRequire(join(resolve(runtime), 'package.json'))
  const identities = []
  const modules = {}
  for (const [key, name] of Object.entries({catalog: '@deepseek-ai/dsh-session-format-catalog', format: '@deepseek-ai/dsh-session-format-v3-to-v4', session: '@deepseek-ai/dsh-session'})) {
    const entry = require.resolve(name)
    const packagePath = join(dirname(entry), '..', 'package.json')
    const metadata = JSON.parse(await readFile(packagePath, 'utf8'))
    if (metadata.version !== TARGET) throw new Error(`${name}: expected ${TARGET}, got ${metadata.version}`)
    identities.push({name, version: metadata.version, path: entry, sha256: createHash('sha256').update(await readFile(entry)).digest('hex')})
    modules[key] = await import(pathToFileURL(entry).href)
  }
  // Verify the entire DSH dependency closure, not just the three entrypoints.
  const checked = new Set(identities.map(i => i.path))
  const visit = async (name, from) => {
    const local = createRequire(from), entry = local.resolve(name)
    if (checked.has(entry)) return
    checked.add(entry)
    const packagePath = join(dirname(entry), '..', 'package.json')
    const metadata = JSON.parse(await readFile(packagePath, 'utf8'))
    if (name.startsWith('@deepseek-ai/dsh-') && metadata.version !== TARGET) throw new Error(`${name}: mixed DSH version ${metadata.version}`)
    identities.push({name,version:metadata.version,path:entry,sha256:createHash('sha256').update(await readFile(entry)).digest('hex')})
    for (const dependency of Object.keys({...metadata.dependencies,...metadata.peerDependencies})) {
      if (dependency.startsWith('@deepseek-ai/dsh-')) {
        try {local.resolve(dependency)} catch {if(metadata.peerDependenciesMeta?.[dependency]?.optional)continue;throw new Error(`missing required ${dependency}`)}
        await visit(dependency,packagePath)
      }
    }
  }
  for (const identity of [...identities]) {
    checked.delete(identity.path)
    identities.splice(identities.indexOf(identity),1)
    await visit(identity.name,join(resolve(runtime),'package.json'))
  }
  return {...modules, identities}
}

/** Offsets of every Zstandard frame magic in one buffer. */
function frameOffsets(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === magic[0] && buffer[index + 1] === magic[1]
      && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) {
      offsets.push(index)
      index += 3
    }
  }
  return offsets
}

async function decodeFrames(path) {
  const { zstdDecompressSync } = await import('node:zlib')
  const buffer = await readFile(path)
  const offsets = frameOffsets(buffer)
  if (offsets.length === 0) throw new Error('no Zstandard frame found')
  const frames = offsets.map((start, index) => buffer.subarray(start, index + 1 < offsets.length ? offsets[index + 1] : buffer.length))
  return frames.map((frame) => zstdDecompressSync(frame))
}

/** Validate one compressed generation the way DSH opens it. */
async function verifyLog(path, validators) {
  const errors = []
  if (!/^session\.v4\.jsonl(?:\.zstd)?$/.test(basename(path))) throw new Error('V4 canonical filename required')
  const frames = path.endsWith('.zstd') ? await decodeFrames(path) : [await readFile(path)]
  const headerFrame = frames[0]
  // DSH: assertZstdHeaderFrame — the first frame is exactly one header line.
  if (path.endsWith('.zstd') && (headerFrame.length === 0 || headerFrame.indexOf(0x0a) !== headerFrame.length - 1)) {
    errors.push('first frame is not exactly one header line')
  }
  const rows = Buffer.concat(frames)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        errors.push(`row ${index}: invalid JSON (${error.message})`)
        return undefined
      }
    })
    .filter((row) => row !== undefined)
  if (rows.length === 0) {
    errors.push('no records decoded')
    return { path, errors, events: 0 }
  }
  const [headerRow, ...eventRows] = rows
  if (headerRow.type !== 'session') errors.push('first record is not the session header')
  const header = { ...headerRow }
  delete header.type
  const version = header.version
  if (version === undefined) {
    errors.push('header has no format version')
    return { path, errors, events: eventRows.length, scope: 'unknown' }
  }
  // Restore through the installed catalog: the same physical dispatch and
  // adjacent migration chain persistence uses. This validates a historical
  // generation the way the host will migrate it, not merely its framing.
  const scope = 'native-v4'
  if (version !== 4) return {path, errors: ['only native V4 is supported'], events: eventRows.length, scope}
  if (!eventRows.length) errors.push('nonempty fixture required')
  try {
    const read = validators.catalog.sessionFormatCatalog.readHeader(headerRow)
    if (read.status === 'unsupported') {
      errors.push(`header: unsupported (${read.reason})`)
    } else if (read.status === 'malformed') {
      errors.push(`header: malformed (${read.reason})`)
    } else {
      const restore = validators.catalog.sessionFormatCatalog.createRestore(headerRow, {
        recovery: 'strict',
        validation: 'current',
      })
      for (const row of eventRows) restore.decodeRow(row)
      restore.finish()
    }
  } catch (error) {
    errors.push(`restore: ${error.message}`)
  }
  // V4 admission is also checked independently of catalog restoration.
  if (version === 4) {
    for (const [index, row] of eventRows.entries()) {
      try {
        validators.format.assertV4RowAdmission(row)
      } catch (error) {
        errors.push(`row ${index + 1} (${row.type}): ${error.message}`)
      }
    }
  }
  return { path, errors, events: eventRows.length, formatVersion: version, scope }
}

function canonical(name) {
  return /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.test(name)
}

/** Walk the DSH layout (`<root>/<project>/<session>/<log>`) up to a bounded depth. */
async function walk(dir, depth, targets) {
  if (depth > 3) return
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isFile()) {
      if (canonical(entry.name)) targets.push(path)
    } else if (entry.isDirectory()) {
      await walk(path, depth + 1, targets)
    }
  }
}

async function collectTargets(args) {
  const targets = []
  for (const arg of args) {
    const info = await stat(arg)
    if (info.isFile()) {
      targets.push(arg)
      continue
    }
    await walk(arg, 0, targets)
  }
  return [...new Set(targets)].sort()
}

async function main() {
  const argv = process.argv.slice(2), paths = []
  let runtime = process.env.DSH_RUNTIME, expected = TARGET
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runtime') runtime = argv[++i]
    else if (argv[i] === '--expected-dsh-version') expected = argv[++i]
    else if (argv[i] === '--required') continue
    else if (argv[i] === '--fixture') paths.push(resolve(import.meta.dirname, '../tests/fixtures'))
    else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`)
    else paths.push(argv[i])
  }
  if (!runtime || expected !== TARGET) throw new Error('explicit rc.2 runtime and exact expected version required')
  const validators = await loadValidators(runtime)
  const targets = await collectTargets(paths)
  if (!targets.length) throw new Error('no fixture files; validation cannot skip')
  const results = []
  for (const target of targets) {
    try { results.push(await verifyLog(target, validators)) }
    catch (error) { results.push({path: target, errors: [error.message], events: 0}) }
  }
  const failed = results.some(r => r.errors.length || !r.events)
  console.log(JSON.stringify({status: failed ? 'fail' : 'pass', targetVersion: TARGET, runtime, packages: validators.identities, checked: results.length, events: results.reduce((n,r) => n+r.events,0), results}, null, 2))
  return failed ? 1 : 0
}
try { process.exitCode = await main() }
catch (error) { console.error(JSON.stringify({status: 'fail', error: error.message})); process.exitCode = 1 }

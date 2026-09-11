#!/usr/bin/env node
/**
 * Validate synthetic session logs against the installed DSH packages.
 *
 * A fixture that only a tolerant reader can parse is not evidence of host
 * compatibility: DSH enforces a first Zstandard frame holding exactly the header
 * line, and exact message/event payload members. Both rules have already caught
 * fixture defects that unit tests passed over, so this check runs the real
 * upstream validators instead of a local approximation.
 *
 * Usage:
 *   node scripts/verify_session_contract.mjs <session-dir|log-file> [...]
 *   node scripts/verify_session_contract.mjs --fixture      # tests/fixtures
 *
 * The DSH runtime is located from $DSH_RUNTIME, then ~/.dsh-runtime. When no
 * runtime is present the check reports `skipped` and exits 0, so it stays usable
 * on a machine without DSH installed.
 */

import { mkdtemp, readFile, readdir, rm, stat, symlink, mkdir, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const NEEDED = [
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-session-format-v2-to-v3',
  '@deepseek-ai/dsh-session',
]

function runtimeRoot() {
  const candidates = [process.env.DSH_RUNTIME, join(homedir(), '.dsh-runtime')]
  return candidates.find((candidate) => candidate && existsSync(join(candidate, 'node_modules', '.pnpm')))
}

/** Resolve one @deepseek-ai package inside the pnpm virtual store. */
async function locatePackage(store, name) {
  const bare = name.slice('@deepseek-ai/'.length)
  const entries = await readdir(store)
  const match = entries
    .filter((entry) => entry.startsWith(`@deepseek-ai+${bare}@`))
    .sort()
    .pop()
  if (match === undefined) return undefined
  const path = join(store, match, 'node_modules', name)
  return existsSync(path) ? path : undefined
}

/** Import the upstream validators, resolving peers through a temporary link farm. */
async function loadValidators(store) {
  const farm = await mkdtemp(join(tmpdir(), 'dsh-contract-'))
  const scope = join(farm, 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const name of NEEDED) {
    const target = await locatePackage(store, name)
    if (target === undefined) throw new Error(`cannot locate ${name} in the DSH runtime`)
    await symlink(await realpath(target), join(scope, name.slice('@deepseek-ai/'.length)), 'dir')
  }
  const format = await import(pathToFileURL(join(farm, 'node_modules', '@deepseek-ai', 'dsh-session-format-v2-to-v3', 'lib', 'index.js')).href)
  const session = await import(pathToFileURL(join(farm, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href)
  const catalog = await import(pathToFileURL(join(farm, 'node_modules', '@deepseek-ai', 'dsh-session-format-catalog', 'lib', 'index.js')).href)
  return { farm, format, session, catalog }
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
  const frames = await decodeFrames(path)
  const headerFrame = frames[0]
  // DSH: assertZstdHeaderFrame — the first frame is exactly one header line.
  if (headerFrame.length === 0 || headerFrame.indexOf(0x0a) !== headerFrame.length - 1) {
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
  let scope = version === 3 ? 'native-v3' : `migrated-v${version}-to-v3`
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
  // V3-only checks, kept because the catalog path may stop before them.
  if (version === 3) {
    for (const [index, row] of eventRows.entries()) {
      try {
        validators.format.assertV3RowAdmission(row)
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
  const argv = process.argv.slice(2)
  const root = resolve(import.meta.dirname, '..')
  const args = argv.includes('--fixture')
    ? [join(root, 'tests', 'fixtures')]
    : argv.filter((item) => !item.startsWith('--'))
  if (args.length === 0) {
    console.error('usage: node scripts/verify_session_contract.mjs <session-dir|log-file> [...] | --fixture')
    return 2
  }
  const store = runtimeRoot()
  if (store === undefined) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'no DSH runtime found (set DSH_RUNTIME to enable)' }, null, 2))
    return 0
  }
  const validators = await loadValidators(join(store, 'node_modules', '.pnpm'))
  try {
    const targets = await collectTargets(args)
    if (targets.length === 0) {
      console.log(JSON.stringify({ status: 'skipped', reason: 'no canonical session log found' }, null, 2))
      return 0
    }
    const results = []
    for (const target of targets) {
      try {
        results.push(await verifyLog(target, validators))
      } catch (error) {
        results.push({ path: target, errors: [error.message], events: 0 })
      }
    }
    const failed = results.filter((item) => item.errors.length > 0)
    console.log(JSON.stringify({
      status: failed.length === 0 ? 'pass' : 'fail',
      runtime: store,
      checked: results.length,
      results,
    }, null, 2))
    return failed.length === 0 ? 0 : 1
  } finally {
    await rm(validators.farm, { recursive: true, force: true })
  }
}

process.exitCode = await main()

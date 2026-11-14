// Source-log witness for acceptance operations (D03). Captures the persisted
// session-log tree before and after an actual report operation, compares the
// two collections, and classifies every difference. A verdict of `unchanged`
// requires identical path sets, identical content digests and zero read errors
// in both captures: loss, addition, replacement or an unreadable file is never
// written as unchanged. This is a different proof from the output-privacy
// canary; the two checks stay separate.
import {createHash} from 'node:crypto'
import {readdir, readFile, stat, lstat, realpath} from 'node:fs/promises'
import {join, relative, resolve} from 'node:path'

export const WITNESS_SCHEMA = 'source-log-witness/v1'
export const COMPARE_SCHEMA = 'source-log-witness-compare/v1'

async function walkFiles(root) {
  const out = []
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, {withFileTypes: true}) }
    catch (error) { throw Object.assign(error, {path: dir}) }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out.push(path)
      else out.push({linkOrSpecial: path})
    }
  }
  await walk(root)
  return out.sort()
}

// Capture one point-in-time collection of every regular file under `root`:
// relative path, byte size and SHA-256 content digest, plus per-file read
// errors and the collection record. The root is stored resolved; callers keep
// machine paths out of shared artifacts.
export async function captureSourceLogs(root, {label, captured_at = new Date().toISOString()} = {}) {
  const resolved = resolve(root)
  // Realpath first so a missing or unreadable root is an explicit collection
  // failure, never an empty "unchanged" collection.
  await realpath(resolved)
  const files = {}, errors = []
  let bytes = 0
  for (const entry of await walkFiles(resolved)) {
    if (typeof entry !== 'string') {
      errors.push({path: relative(resolved, entry.linkOrSpecial), code: 'not_regular_file'})
      continue
    }
    try {
      const info = await stat(entry)
      const data = await readFile(entry)
      const rel = relative(resolved, entry).replaceAll('\\', '/')
      files[rel] = {sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, size_bytes: info.size, mtime_ms: Math.trunc(info.mtimeMs)}
      bytes += data.length
    } catch (error) {
      errors.push({path: relative(resolved, entry).replaceAll('\\', '/'), code: error.code ?? 'read_error', message: String(error.message ?? error)})
    }
  }
  return {
    schema: WITNESS_SCHEMA,
    label,
    root,
    captured_at,
    files,
    errors,
    totals: {files: Object.keys(files).length, bytes, error_count: errors.length},
  }
}

// Compare two captures. `unchanged` requires both captures to have collected
// without read errors, the same path set, and identical digests per path.
export function compareSourceLogs(before, after) {
  if (before.schema !== WITNESS_SCHEMA || after.schema !== WITNESS_SCHEMA) throw new Error('witness capture schema mismatch')
  const added = [], removed = [], changed = [], errors = [
    ...before.errors.map((e) => ({phase: 'before', ...e})),
    ...after.errors.map((e) => ({phase: 'after', ...e})),
  ]
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)])
  for (const path of [...paths].sort()) {
    const a = before.files[path], b = after.files[path]
    if (a && !b) removed.push(path)
    else if (!a && b) added.push(path)
    else if (a.sha256 !== b.sha256) changed.push({path, before: a.sha256, after: b.sha256})
  }
  const verdict = errors.length === 0 && added.length === 0 && removed.length === 0 && changed.length === 0
    ? 'unchanged' : 'changed'
  return {
    schema: COMPARE_SCHEMA,
    verdict,
    added, removed, changed,
    read_errors: errors,
    totals: {before_files: before.totals.files, after_files: after.totals.files, differences: added.length + removed.length + changed.length},
  }
}

// Resolve each expected session to its directory using exact path components,
// including errors, so an unreadable log cannot silently disappear from the
// scope. Require one directory and a readable nonempty session-log collection
// for each identity. Returned roots include trailing slash to prevent prefix
// collisions with a different session name.
export function sessionWitnessScope(before, ids) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw new Error('expected distinct session identities')
  const roots = []
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\'))
      throw new Error('invalid session identity')
    const paths = [...Object.keys(before.files), ...before.errors.map(e => e.path)]
    const matches = paths.flatMap(path => {
      const parts = path.split('/'), index = parts.indexOf(id)
      return index < 0 || index === parts.length - 1 ? [] : [parts.slice(0, index + 1).join('/') + '/']
    })
    const unique = [...new Set(matches)]
    if (unique.length !== 1) throw new Error('session log directory missing or ambiguous')
    const root = unique[0]
    const log = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/
    if (!Object.entries(before.files).some(([path, file]) => path.startsWith(root) && log.test(path.slice(root.length)) && file.bytes > 0))
      throw new Error('session has no readable nonempty source log')
    if (before.errors.some(error => error.path === root.slice(0, -1) || error.path.startsWith(root)))
      throw new Error('session source-log capture contains a read error')
    roots.push(root)
  }
  return roots
}

// The detailed gate is retained in a private witness file. `scope`, when
// supplied, contains whole session-directory prefixes, not the before-file
// list: additions within those directories must be detected, while new host
// sessions outside them remain visible in the full-tree comparison.
export function witnessGate(id, before, after, comparison, {scope} = {}) {
  if (scope === undefined) {
    const passed = comparison.verdict === 'unchanged'
    return {
      id,
      required: true,
      status: passed ? 'passed' : 'failed',
      subject: {kind: 'source_log_witness', id: `${before.totals.files}->${after.totals.files}`},
      exit_code: passed ? 0 : 1,
      note: passed
        ? `source logs unchanged across the observed operation interval: ${before.totals.files} files, ${before.totals.bytes} bytes captured before and after, zero read errors`
        : `source logs did not stay unchanged: ${comparison.totals.differences} differences, ${comparison.read_errors.length} read errors (loss, addition, replacement and read failure are never recorded as unchanged)`,
      evidence: {mode: 'executed', comparison: {verdict: comparison.verdict, added: comparison.added, removed: comparison.removed, changed: comparison.changed, read_errors: comparison.read_errors}, before_captured_at: before.captured_at, after_captured_at: after.captured_at},
    }
  }
  if (!Array.isArray(scope) || !scope.length || scope.some(root => typeof root !== 'string' || !root.endsWith('/')))
    throw new Error('nonempty session directory scope required')
  const within = path => scope.some(root => path === root.slice(0, -1) || path.startsWith(root))
  const scoped = {
    added: comparison.added.filter(within),
    removed: comparison.removed.filter(within),
    changed: comparison.changed.filter(c => within(c.path)),
    read_errors: comparison.read_errors.filter(e => within(e.path)),
  }
  const log = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/
  const hasLog = (capture, root) => Object.entries(capture.files).some(([path, file]) => path.startsWith(root) && log.test(path.slice(root.length)) && file.bytes > 0)
  const missing = scope.filter(root => !hasLog(before, root) || !hasLog(after, root))
  const passed = scoped.added.length === 0 && scoped.removed.length === 0 && scoped.changed.length === 0
    && scoped.read_errors.length === 0 && missing.length === 0
  return {
    id,
    required: true,
    status: passed ? 'passed' : 'failed',
    subject: {kind: 'source_log_witness', id: `scope:${scope.length}`},
    exit_code: passed ? 0 : 1,
    note: passed
      ? `witnessed target/non-target logs unchanged across the observed operation interval: ${scope.length} session directories digested before and after, zero scoped read errors; full-tree collection recorded alongside`
      : `witnessed target/non-target logs did not stay unchanged: ${scoped.changed.length} changed, ${scoped.removed.length} lost, ${scoped.added.length} added, ${scoped.read_errors.length} read errors, ${missing.length} missing from a capture (loss, replacement and read failure are never recorded as unchanged)`,
    evidence: {mode: 'executed', scope: [...scope].sort(), scoped, full_tree: {verdict: comparison.verdict, added: comparison.added, removed: comparison.removed, changed: comparison.changed, read_errors: comparison.read_errors, before_files: before.totals.files, after_files: after.totals.files}, before_captured_at: before.captured_at, after_captured_at: after.captured_at},
  }
}

// Project the detailed private witness into the existing native-acceptance/v2
// contract. The artifact is the gate subject; the note binds the separately
// retained private witness bytes, without exposing local paths in the annex.
export function projectWitnessGate({passed, artifactSha256, witnessSha256 = null, reason = 'source-log witness'}) {
  if (!/^[0-9a-f]{64}$/.test(artifactSha256) || (witnessSha256 !== null && !/^[0-9a-f]{64}$/.test(witnessSha256)))
    throw new Error('invalid witness or artifact identity')
  return {
    id: 'source_log_witness', required: true, status: passed ? 'passed' : 'failed',
    subject: {kind: 'artifact', id: artifactSha256}, exit_code: passed ? 0 : 1,
    note: `${reason}; private witness sha256: ${witnessSha256 ?? 'unavailable'}`,
    evidence: {mode: 'executed', source_result_sha256: null, source_gate_id: null, invalidation_reason: null},
  }
}

// One witnessed operation lifecycle. Runs `captureBefore`, then `operation`,
// then `captureAfter` and the comparison in a try/finally so an operation
// failure still produces its after-capture and comparison. The three outcomes
// (operation, witness, cleanup) are returned separately and never merged: a
// later success does not overwrite an earlier failure.
export async function witnessedOperation({root, label, operation, capture = captureSourceLogs, compare = compareSourceLogs}) {
  const record = {label, operation: null, witness: null}
  let before = null
  try {
    before = await capture(root, {label: `${label}:before`})
  } catch (error) {
    record.witness = {status: 'failed', phase: 'before', error: {code: error.code ?? 'capture_error', message: String(error.message ?? error)}}
    return record
  }
  let operationError = null
  try {
    record.operation = await operation()
  } catch (error) {
    operationError = error
    record.operation = {status: 'failed', error: {name: error.name, code: error.code ?? null, message: String(error.message ?? error)}}
  }
  let after = null
  try {
    after = await capture(root, {label: `${label}:after`})
    const comparison = compare(before, after)
    record.witness = {status: comparison.verdict === 'unchanged' ? 'passed' : 'failed', comparison, gate: witnessGate('source_log_witness', before, after, comparison)}
  } catch (error) {
    record.witness = {status: 'failed', phase: 'after', error: {code: error.code ?? 'capture_error', message: String(error.message ?? error)}}
  }
  if (operationError) record.operation_error = operationError
  return record
}

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

// Native-acceptance gate record for one witness comparison. Required: a
// `changed` verdict (including any read error) fails the gate. An optional
// `scope` (relative paths of the witnessed target/non-target logs) binds the
// verdict to those paths while the full-tree comparison stays recorded in the
// evidence: scope-internal loss, replacement or read failure fails, and an
// in-scope addition fails; out-of-scope additions (the host's own new sessions
// inside the interval) stay visible but do not flip the scoped verdict.
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
  const scoped = {
    added: comparison.added.filter((path) => scope.includes(path)),
    removed: comparison.removed.filter((path) => scope.includes(path)),
    changed: comparison.changed.filter((c) => scope.includes(c.path)),
    read_errors: comparison.read_errors.filter((e) => scope.includes(e.path)),
  }
  const missing = scope.filter((path) => before.files[path] === undefined || after.files[path] === undefined)
  const passed = scoped.added.length === 0 && scoped.removed.length === 0 && scoped.changed.length === 0
    && scoped.read_errors.length === 0 && missing.length === 0
  return {
    id,
    required: true,
    status: passed ? 'passed' : 'failed',
    subject: {kind: 'source_log_witness', id: `scope:${scope.length}`},
    exit_code: passed ? 0 : 1,
    note: passed
      ? `witnessed target/non-target logs unchanged across the observed operation interval: ${scope.length} scoped paths digested before and after, zero read errors; full-tree collection recorded alongside`
      : `witnessed target/non-target logs did not stay unchanged: ${scoped.changed.length} changed, ${scoped.removed.length} lost, ${scoped.added.length} added, ${scoped.read_errors.length} read errors, ${missing.length} missing from a capture (loss, replacement and read failure are never recorded as unchanged)`,
    evidence: {mode: 'executed', scope: [...scope].sort(), scoped, full_tree: {verdict: comparison.verdict, added: comparison.added, removed: comparison.removed, changed: comparison.changed, read_errors: comparison.read_errors, before_files: before.totals.files, after_files: after.totals.files}, before_captured_at: before.captured_at, after_captured_at: after.captured_at},
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

// Pure result/verdict consumers for the executor-contract runner. Extracted
// so both the runner and the repo-maintained table-driven tests exercise the
// exact same judgment logic; importing this module has no side effects.
//
// R3-RESULT: consume the actually awaited batch — never a promise. Shapes:
//   {timeout:true}                     → timed out (never accepted for an
//                                        expected cancel/dispose)
//   {rejection}                        → the batch promise rejected; only
//                                        valid when the caller explicitly
//                                        expects a rejection
//   {results:[{callId, result:{isError, error, ...}}]} → the real batch
// Unknown shapes, unexpected successes and missing payloads are rejected —
// they never silently pass.

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Live tools.execute() returns one canonical ToolExecutionResult per call.
// content is a model-facing projection and can include logs or sandbox
// notices; only the execution-local value is the successful body output.
// This consumer is not for durable Session events, which omit that value.
export function readSuccessfulToolValue(batch, expectedCallId) {
  if (typeof expectedCallId !== 'string' || !expectedCallId)
    throw new TypeError('expected callId must be a non-empty string')
  if (!isRecord(batch) || !Array.isArray(batch.results) || batch.results.length !== 1)
    throw new TypeError('expected exactly one live tool result')
  const row = batch.results[0]
  if (!isRecord(row) || row.callId !== expectedCallId)
    throw new TypeError(`tool result callId mismatch: expected ${expectedCallId}`)
  const result = row.result
  if (!isRecord(result))
    throw new TypeError('expected a successful live tool result')
  if (result.isError === true) {
    const code = result.error?.info?.code ?? result.error?.code ?? 'UNKNOWN'
    const message = result.error?.message ?? 'missing failure message'
    throw new Error(`tool ${expectedCallId} failed (${code}): ${message}`)
  }
  if (result.isError !== false)
    throw new TypeError('expected a successful live tool result')
  if (Object.hasOwn(result, 'error'))
    throw new TypeError('successful live tool result must not contain an error')
  if (!Object.hasOwn(result, 'value') || result.value === undefined)
    throw new TypeError('successful live tool result is missing value')
  return result.value
}

// session_insights_prepare's declared canonical output is exactly an object
// with a text string containing one JSON value. Parse that string as a whole:
// extra bytes and malformed/wrong-type business payloads are failures.
export function readDsiPrepareValue(value) {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'text')
    || typeof value.text !== 'string')
    throw new TypeError('DSI prepare value must contain text')
  const payload = JSON.parse(value.text)
  if (!isRecord(payload) || typeof payload.workdir !== 'string' || !payload.workdir.trim()
    || typeof payload.metrics_semantic_skipped !== 'boolean')
    throw new TypeError('DSI prepare payload must contain workdir and metrics_semantic_skipped')
  return payload
}

// run_code's canonical value contains captured logs, optional sandbox facts,
// and these runner programs' object return values. Keep the sandbox facts
// instead of parsing content, where partial/denied notices can be appended.
// requireWorkspaceWrite is used for the real Agent PTC checks; allowDenied
// is reserved for programs intentionally testing a denied operation.
export function readPtcProgramResult(batch, expectedCallId,
  {requireWorkspaceWrite = false, allowDenied = false} = {}) {
  const value = readSuccessfulToolValue(batch, expectedCallId)
  if (!isRecord(value) || Object.keys(value).some(key => !['logs','sandbox','result'].includes(key))
    || !Object.hasOwn(value, 'logs') || !Array.isArray(value.logs)
    || !value.logs.every(item => typeof item === 'string'))
    throw new TypeError('PTC value must contain a logs string array')
  const sandbox = value.sandbox
  if (Object.hasOwn(value, 'sandbox') && sandbox === undefined)
    throw new TypeError('PTC value has malformed sandbox facts')
  if (sandbox !== undefined) {
    if (!isRecord(sandbox) || !['read-only','workspace-write','danger-full-access'].includes(sandbox.mode)
      || Object.keys(sandbox).some(key => !['mode','denied','enforcement'].includes(key))
      || typeof sandbox.denied !== 'boolean'
      || (Object.hasOwn(sandbox, 'enforcement') && sandbox.enforcement === undefined)
      || (sandbox.enforcement !== undefined && !['full','partial'].includes(sandbox.enforcement)))
      throw new TypeError('PTC value has malformed sandbox facts')
    if (sandbox.denied && !allowDenied)
      throw new TypeError('PTC reported an unexpected sandbox denial')
  }
  if (requireWorkspaceWrite && (!sandbox || sandbox.mode !== 'workspace-write'
    || !['full','partial'].includes(sandbox.enforcement)))
    throw new TypeError('PTC must report workspace-write and its enforcement')
  if (!Object.hasOwn(value, 'result') || !isRecord(value.result))
    throw new TypeError('PTC value must contain an object result')
  return {program: value.result, sandbox: sandbox ?? null, logs: value.logs}
}

export function classifySettledBatch(settled) {
  if (settled && settled.timeout === true)
    return {shape: 'timeout', ok: false, classification: 'timeout'}
  if (settled && settled.rejection !== undefined)
    return {shape: 'rejected', ok: false,
      classification: 'rejected: ' + String(settled.rejection?.message ?? settled.rejection)}
  const rows = settled?.results
  if (!Array.isArray(rows) || rows.length === 0)
    return {shape: 'malformed', ok: false, classification: 'missing result rows'}
  const row = rows[0]
  if (typeof row?.callId !== 'string' || !row.callId)
    return {shape: 'malformed', ok: false, classification: 'missing callId on the result row'}
  const result = row.result
  if (!result || typeof result.isError !== 'boolean')
    return {shape: 'malformed', ok: false, classification: 'missing or malformed result payload'}
  if (result.isError === false)
    return {shape: 'unexpected-success', ok: false, callId: row.callId,
      classification: `call ${row.callId} unexpectedly succeeded`}
  const code = result.error?.info?.code ?? result.error?.code ?? ''
  return {shape: 'error-result', ok: true, callId: row.callId, code,
    classification: `${code}|${result.error?.message ?? ''}`}
}

// R3-ISOLATION: a cross-scope refusal is only attributed to toolSet ownership
// when the batch is an error result for the exact call and the refusal is the
// registry's unknown-tool outcome — i.e. the tool disappeared from view
// because the set does not belong to this scope. Any other shape is a
// problem, never an automatic pass.
export function foreignSetRefusalProblem(batch, expectedCallId) {
  const rows = batch?.results
  if (!Array.isArray(rows) || rows.length === 0)
    return 'missing result rows'
  const row = rows[0]
  if (row?.callId !== expectedCallId)
    return 'callId mismatch: ' + String(row?.callId ?? 'none')
  const result = row.result
  if (!result || result.isError !== true)
    return 'not an error result: the tool ran or the batch is malformed'
  const code = result.error?.info?.code ?? result.error?.code ?? ''
  if (code !== 'UNKNOWN_TOOL')
    return 'unexpected refusal code: ' + (code || '(none)')
  return null
}

// R3/R4-CLEANUP: one child receipt verdict. A non-zero exit alone is NOT
// clean: a child that exits 1 but leaks its scratch tree OR its staging root
// must fail this verdict — each tracked resource is checked separately.
export function selfTestVerdict(run) {
  if (run.exit !== 1)
    return 'child must exit 1 (got ' + run.exit + ')'
  if (run.scratchLeft)
    return 'child exited non-zero but leaked its scratch tree'
  if (run.stagingLeft)
    return 'child exited non-zero but leaked its staging root'
  return null
}

// Await a promise with a bounded timeout that is always cleaned up: the timer
// is cleared on every path (success, rejection, timeout), and it never keeps
// the process alive on its own.
export async function settleWithTimeout(promise, ms = 60000) {
  let timer
  try {
    // On success the settled batch passes through unchanged; only the two
    // exceptional outcomes get wrapper shapes ({rejection} / {timeout}).
    return await Promise.race([
      promise.catch(error => ({rejection: error})),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({timeout: true}), ms)
        if (timer.unref) timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

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

// R3-CLEANUP: one child receipt verdict. A non-zero exit alone is NOT clean:
// a child that exits 1 but leaks its scratch tree must fail this verdict.
export function selfTestVerdict(run) {
  if (run.exit !== 1)
    return 'child must exit 1 (got ' + run.exit + ')'
  if (run.scratchLeft)
    return 'child exited non-zero but leaked its scratch tree'
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

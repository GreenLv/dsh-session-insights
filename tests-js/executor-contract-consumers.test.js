// Table-driven consumers for the executor-contract runner's judgment logic
// (scripts/dsh-executor-consumers.mjs). These are cheap, dependency-free
// tests: they prove the runner's assertions can tell the expected outcomes
// apart — and that the negative controls fire — without starting the host
// stack. The negative controls here are the same ones the review required
// for the runner itself: an unexpected success, an unrelated rejection, a
// missing payload, a timeout and a leaking child must all be REFUSED by the
// consumers, never silently accepted.
import test from 'node:test'
import assert from 'node:assert/strict'
import {classifySettledBatch, foreignSetRefusalProblem, selfTestVerdict} from '../scripts/dsh-executor-consumers.mjs'

// --- classifySettledBatch --------------------------------------------------

const errorBatch = (callId, code, message) => ({
  results: [{callId, result: {isError: true, error: {message, info: {code}}}}],
})
const successBatch = (callId) => ({
  results: [{callId, result: {isError: false, content: [{type: 'text', text: 'ok'}]}}],
})

test('the awaited cancellation batch classifies as ABORTED for the cancelled call', () => {
  const c = classifySettledBatch(errorBatch('dsi-midflight-1', 'ABORTED', 'tool call aborted'))
  assert.equal(c.shape, 'error-result')
  assert.equal(c.ok, true)
  assert.equal(c.callId, 'dsi-midflight-1')
  assert.equal(c.code, 'ABORTED')
  assert.match(c.classification, /ABORTED/)
})

test('the awaited dispose batch classifies as CODE_RUN_FAILED for the disposed call', () => {
  const c = classifySettledBatch(errorBatch('dsi-mid-dispose-1', 'CODE_RUN_FAILED',
    'code run failed (abort): PTC tool executor disposed\nFile sandbox: workspace-write; enforcement: full.'))
  assert.equal(c.shape, 'error-result')
  assert.equal(c.code, 'CODE_RUN_FAILED')
  assert.equal(c.callId, 'dsi-mid-dispose-1')
  assert.match(c.classification, /executor disposed/)
})

test('the consumer rejects an unexpected success (a cancelled call that reports success is a defect)', () => {
  const c = classifySettledBatch(successBatch('dsi-midflight-1'))
  assert.equal(c.shape, 'unexpected-success')
  assert.equal(c.ok, false)
})

test('the consumer rejects a timeout, an unrelated rejection and malformed payloads', () => {
  const timeout = classifySettledBatch({timeout: true})
  assert.equal(timeout.shape, 'timeout')
  assert.equal(timeout.ok, false)

  const unrelated = classifySettledBatch({rejection: new Error('ENETUNREACH: advisory service unreachable')})
  assert.equal(unrelated.shape, 'rejected')
  assert.equal(unrelated.ok, false)

  for (const malformed of [{}, {results: []}, {results: [{}]},
    {results: [{callId: 'x', result: {isError: 'yes'}}]}]) {
    const c = classifySettledBatch(malformed)
    assert.equal(c.shape, 'malformed', JSON.stringify(malformed))
    assert.equal(c.ok, false)
  }
})

// --- foreignSetRefusalProblem ----------------------------------------------

const unknownToolBatch = (callId) => ({
  results: [{callId, result: {isError: true,
    error: {message: 'unknown tool "session_insights_prepare"',
      info: {name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL'}}}}],
})

test('a proper scope-mismatch refusal (unknown tool for this set) holds', () => {
  assert.equal(foreignSetRefusalProblem(unknownToolBatch('dsi-foreign-b-1'), 'dsi-foreign-b-1'), null)
})

test('negative control: the refusal assertion flags a legitimate-owner success', () => {
  // The review's exact complaint: with the previous run_code negative, the
  // refusal held even for a legitimately-owned set. The consumer must flag a
  // success as NOT a refusal — that is what makes the runner's isolation
  // assertion meaningful when the foreign set is swapped back to a legal one.
  const problem = foreignSetRefusalProblem(successBatch('dsi-own-b-1'), 'dsi-own-b-1')
  assert.ok(problem !== null)
  assert.match(problem, /not an error result/)
})

test('the refusal assertion rejects unrelated errors and shape drift', () => {
  const wrongCall = foreignSetRefusalProblem(unknownToolBatch('other-call'), 'dsi-foreign-b-1')
  assert.match(wrongCall, /callId mismatch/)

  const wrongCode = foreignSetRefusalProblem(errorBatch('dsi-foreign-b-1', 'ABORTED', 'aborted'), 'dsi-foreign-b-1')
  assert.match(wrongCode, /unexpected refusal code/)

  for (const malformed of [{}, {results: []}]) {
    assert.ok(foreignSetRefusalProblem(malformed, 'x') !== null)
  }
})

// --- selfTestVerdict --------------------------------------------------------

test('a child that exits 1 and cleans its scratch tree passes the cleanup verdict', () => {
  assert.equal(selfTestVerdict({stage: 'boot', exit: 1, scratchLeft: false}), null)
})

test('negative control: a child that exits 1 but leaks its scratch tree FAILS the verdict', () => {
  const verdict = selfTestVerdict({stage: 'boot', exit: 1, scratchLeft: true})
  assert.ok(verdict !== null)
  assert.match(verdict, /leaked/)
})

test('a child that exits 0 fails the verdict — success is not the injected outcome', () => {
  assert.match(selfTestVerdict({stage: 'init', exit: 0, scratchLeft: false}), /exit 1/)
  assert.match(selfTestVerdict({stage: 'cleanup', exit: null, scratchLeft: false}), /exit 1/)
})

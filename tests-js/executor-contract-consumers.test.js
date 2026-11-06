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
import {classifySettledBatch, foreignSetRefusalProblem, readSuccessfulToolValue,
  readDsiPrepareValue, readPtcProgramResult, selfTestVerdict} from '../scripts/dsh-executor-consumers.mjs'

// Live canonical success values are distinct from model-facing content.
// Windows partial enforcement, runtime logs and denial guidance can all add
// text around the rendered business value, so content is deliberately varied.
const preparePayload = {workdir: 'C:\\isolated home\\run-1', metrics_semantic_skipped: true}
const prepareValue = {text: JSON.stringify(preparePayload)}
const sandbox = {mode: 'workspace-write', enforcement: 'partial', denied: false}
const canonicalBatch = (callId, value, content = [{type: 'text', text: 'presentation'}]) => ({
  results: [{callId, result: {isError: false, value, content}}],
})
const ptcValue = (overrides = {}) => ({logs: [], sandbox, result: {prepared: prepareValue}, ...overrides})

test('native prepare consumes canonical value regardless of its presentation', () => {
  const presentations = [
    [{type: 'text', text: JSON.stringify(preparePayload)}],
    [{type: 'text', text: 'a presentation, not JSON'}],
    [{type: 'text', text: JSON.stringify({workdir: 'forged'})}, {type: 'text', text: 'more text'}],
  ]
  for (const content of presentations) {
    const value = readSuccessfulToolValue(canonicalBatch('native', prepareValue, content), 'native')
    assert.deepEqual(readDsiPrepareValue(value), preparePayload)
  }
})

test('PTC prepare keeps canonical result with full, partial, logs and multi-block presentation', () => {
  const cases = [
    {label: 'full', value: ptcValue({sandbox: {...sandbox, enforcement: 'full'}}),
      content: [{type: 'text', text: JSON.stringify({prepared: prepareValue})}]},
    {label: 'partial', value: ptcValue(),
      content: [{type: 'text', text: JSON.stringify({prepared: prepareValue})+'\nFile sandbox enforcement is partial on this host.'}]},
    {label: 'logs and blocks', value: ptcValue({logs: ['first log', 'second log']}),
      content: [{type: 'text', text: 'first log\nsecond log'}, {type: 'text', text: 'not the business result'}]},
    {label: 'conflicting content', value: ptcValue(),
      content: [{type: 'text', text: JSON.stringify({prepared: {text: '{"workdir":"forged"}'}})}]},
  ]
  for (const {label, value, content} of cases) {
    const decoded = readPtcProgramResult(canonicalBatch('ptc', value, content), 'ptc', {requireWorkspaceWrite: true})
    assert.deepEqual(readDsiPrepareValue(decoded.program.prepared), preparePayload, label)
    assert.deepEqual(decoded.sandbox, value.sandbox, label)
    assert.deepEqual(decoded.logs, value.logs, label)
  }
})

test('Windows rc.1 observed partial footer leaves the canonical prepared value intact', () => {
  // Shape from the Windows native run: a single text block contains the
  // formatted program result followed by this exact partial-enforcement line.
  // The workdir is synthetic; the outer and nested value structure is retained.
  const value = ptcValue()
  const displayed = JSON.stringify(value.result, null, 2)+'\nFile sandbox enforcement is partial on this host.'
  const batch = canonicalBatch('ptc', value, [{type: 'text', text: displayed}])
  assert.equal(batch.results[0].result.content.length, 1)
  assert.equal(Object.hasOwn(batch.results[0].result, 'structuredContent'), false)
  assert.throws(() => JSON.parse(displayed), SyntaxError)
  const decoded = readPtcProgramResult(batch, 'ptc', {requireWorkspaceWrite: true})
  assert.deepEqual(readDsiPrepareValue(decoded.program.prepared), preparePayload)
  assert.deepEqual(decoded.sandbox, {mode: 'workspace-write', enforcement: 'partial', denied: false})
})

test('PTC intentionally denied boundary consumes program facts and preserves sandbox facts', () => {
  const program = {inside: 'written', outside: {status: 'refused', code: 'EACCES', path: 'C:\\isolated home\\outside'}}
  for (const denied of [false, true]) {
    const value = {logs: ['diagnostic log'], sandbox: {...sandbox, denied}, result: program}
    const presentation = [{type: 'text', text: '{"inside":"forged"}\nFile sandbox enforcement is partial on this host.\nThe sandbox denied an operation.'}]
    const decoded = readPtcProgramResult(canonicalBatch('fs', value, presentation), 'fs',
      {requireWorkspaceWrite: true, allowDenied: true})
    assert.deepEqual(decoded.program, program)
    assert.equal(decoded.sandbox.denied, denied)
    assert.equal(decoded.sandbox.enforcement, 'partial')
  }
  const unexpected = {logs: [], sandbox: {...sandbox, denied: true}, result: program}
  assert.throws(() => readPtcProgramResult(canonicalBatch('fs', unexpected), 'fs',
    {requireWorkspaceWrite: true}), /unexpected sandbox denial/)
})

test('single-call canonical consumer rejects wrong identity, errors, absent values and ambiguous batches', () => {
  const invalid = [
    {label: 'no batch', batch: undefined},
    {label: 'array batch', batch: Object.assign([], {results: [{callId: 'id', result: {isError: false, value: prepareValue}}]})},
    {label: 'no rows', batch: {results: []}},
    {label: 'duplicate rows', batch: {results: [{callId:'id'}, {callId:'id'}]}},
    {label: 'wrong call', batch: canonicalBatch('other', prepareValue)},
    {label: 'error with forged value', batch: {results: [{callId: 'id', result: {isError: true, value: prepareValue}}]}},
    {label: 'success with an error', batch: {results: [{callId: 'id', result: {isError: false, value: prepareValue, error: {message: 'failure'}}}]}},
    {label: 'success with undefined error', batch: {results: [{callId: 'id', result: {isError: false, value: prepareValue, error: undefined}}]}},
    {label: 'missing boolean', batch: {results: [{callId: 'id', result: {value: prepareValue}}]}},
    {label: 'missing value with valid content', batch: {results: [{callId: 'id', result: {isError: false, content: [{type: 'text', text: prepareValue.text}]}}]}},
    {label: 'undefined value', batch: canonicalBatch('id', undefined)},
  ]
  for (const {label, batch} of invalid)
    assert.throws(() => readSuccessfulToolValue(batch, 'id'), undefined, label)
  const failure = {results: [{callId: 'id', result: {isError: true,
    error: {message: 'sandbox unavailable', info: {code: 'CODE_RUN_FAILED'}}}}]}
  assert.throws(() => readSuccessfulToolValue(failure, 'id'), /CODE_RUN_FAILED.*sandbox unavailable/)
})

test('DSI prepare accepts one whole JSON object and refuses malformed, tailed or wrong-type data', () => {
  const invalid = [undefined, null, 'not an object', {}, {text: 12}, {...prepareValue, extra: true},
    {text: ''}, {text: '{broken'}, {text: prepareValue.text+'\ntrailing'},
    {text: prepareValue.text+'{}'}, {text: 'null'}, {text: '[]'}, {text: '12'},
    {text: '{}'}, {text: '{"workdir":42}'}, {text: '{"workdir":""}'},
    {text: '{"workdir":"x"}'}, {text: '{"workdir":"x","metrics_semantic_skipped":"true"}'}]
  for (const value of invalid)
    assert.throws(() => readDsiPrepareValue(value), undefined, JSON.stringify(value))
})

test('PTC consumer rejects missing or malformed canonical program and log shapes', () => {
  const invalid = [null, 'rendered only', {}, {logs: null, result: {}},
    {logs: [3], result: {}}, {logs: [], result: null}, {logs: [], result: []},
    {logs: [], result: 'rendered object'}, {logs: []}, {logs: [], result: {}, extra: true}]
  for (const value of invalid)
    assert.throws(() => readPtcProgramResult(canonicalBatch('ptc', value), 'ptc'), undefined, JSON.stringify(value))
  const preparedAsString = readPtcProgramResult(canonicalBatch('ptc', ptcValue({result: {prepared: prepareValue.text}})), 'ptc')
  assert.throws(() => readDsiPrepareValue(preparedAsString.program.prepared), /must contain text/)
})

test('PTC consumer validates sandbox facts and the real Agent workspace policy', () => {
  // Sandbox is optional in the general official value schema, but required
  // with reported enforcement for this runner's confined Agent checks.
  assert.equal(readPtcProgramResult(canonicalBatch('ptc', {logs: [], result: {prepared: prepareValue}}), 'ptc').sandbox, null)
  const invalid = [undefined, null, {}, {mode: 'wrong', denied: false, enforcement: 'partial'},
    {mode: 'workspace-write', denied: 'false', enforcement: 'partial'},
    {mode: 'workspace-write', denied: false, enforcement: 'unknown'},
    {mode: 'workspace-write', denied: false, enforcement: 'partial', extra: true},
    {mode: 'workspace-write', denied: false},
    {mode: 'read-only', denied: false, enforcement: 'partial'},
    {mode: 'danger-full-access', denied: false, enforcement: 'full'}]
  for (const facts of invalid) {
    const value = ptcValue({sandbox: facts})
    assert.throws(() => readPtcProgramResult(canonicalBatch('ptc', value), 'ptc',
      {requireWorkspaceWrite: true}), undefined, JSON.stringify(facts))
  }
})

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

test('a child that exits 1 and cleans every tracked resource passes the verdict', () => {
  assert.equal(selfTestVerdict({stage: 'boot', exit: 1, scratchLeft: false, stagingLeft: false}), null)
})

test('negative control: a child that exits 1 but leaks its scratch tree FAILS the verdict', () => {
  const verdict = selfTestVerdict({stage: 'boot', exit: 1, scratchLeft: true, stagingLeft: false})
  assert.ok(verdict !== null)
  assert.match(verdict, /leaked/)
})

test('negative control: a child that exits 1 but leaks its staging root FAILS the verdict', () => {
  // The staging root lives inside the runtime closure, outside the task root
  // the parent hands the child — exactly the shape the review proved the old
  // verdict could not see.
  const verdict = selfTestVerdict({stage: 'boot', exit: 1, scratchLeft: false, stagingLeft: true})
  assert.ok(verdict !== null)
  assert.match(verdict, /staging root/)
})

test('a child that exits 0 fails the verdict — success is not the injected outcome', () => {
  assert.match(selfTestVerdict({stage: 'init', exit: 0, scratchLeft: false, stagingLeft: false}), /exit 1/)
  assert.match(selfTestVerdict({stage: 'cleanup', exit: null, scratchLeft: false, stagingLeft: false}), /exit 1/)
})

import { readFileSync as readCanonical } from 'node:fs'
const canonicalRows = readCanonical(new URL('../tests/fixtures/synthetic-session.jsonl', import.meta.url),'utf8').trim().split('\n').map(JSON.parse)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  statSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../plugin/lib/storage.js'
import { buildReport, analyzeTool, sanitize } from '../plugin/lib/analyzer.js'
import {
  prepareSemantic,
  getBatch,
  submitBatch,
  prepareAggregate,
  submitAggregate,
  finalize,
  selectFamilies,
} from '../plugin/lib/semantic.js'
import { _test, apply } from '../plugin/lib/index.js'

function fixture() {
  const now = Date.now(),
    snapshots = Array.from({length: 3}, (_, i) => {
      const rows = JSON.parse(JSON.stringify(canonicalRows))
      const {type, ...session} = rows[0]
      Object.assign(session, {id: `native-${i}`, createdAt: now-1000, cwd:'/workspace/example'})
      rows[3].data.content[0].text = `Implement feature ${i} in /private/example/file.`
      rows[4].data.usage = {inputTokens:20,cacheReadTokens:30,cacheWriteTokens:4,outputTokens:10,reasoningTokens:3}
      rows[4].data.message.content[0].text = 'Implemented the requested feature.'
      rows[9].data.title = rows[3].data.content[0].text
      return {session, inheritedEventCount: 0, events: rows.slice(1)}
    })
  return {
    snapshots,
    options: {
      now,
      days: 30,
      privacy: 'redacted',
      analysis_depth: 'evidence',
      locale: 'en',
    },
  }
}
function scope(fn) {
  const home = mkdtempSync(join(tmpdir(), 'insights-security-'))
  try {
    const store = new Store(home),
      run = store.create()
    return fn({ home, store, run })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
function prepare(store, run, options = {}) {
  const f = fixture()
  return prepareSemantic(
    store,
    run,
    buildReport(f.snapshots, { ...f.options, ...options }),
  )
}
function facets(batch) {
  return {
    facets: batch.tasks.map((c) => ({
      task_family_id: c.task_family_id,
      goal: 'Implement feature',
      task_type: 'implementation',
      interaction_style: 'Iterative',
      instruction_handling: 'followed',
      tool_execution: 'strong',
      verification_quality: 'strong',
      handoff_quality: 'clear',
      frictions: [],
      strengths: ['Validation performed'],
      outcome_inference: 'mostly_achieved',
      evidence_refs: [c.evidence[0].id],
    })),
  }
}
function aggregate(input) {
  const first = input.evidence[0]
  const item = {
    title: 'Bounded observation',
    text: 'The provided evidence describes implementation work.',
    supporting_task_family_ids: [first.task_family_id],
    evidence_refs: [first.id],
    confidence: 'medium',
    measurement: 'inferred',
  }
  return Object.fromEntries(
    input.output_contract.required_sections.map((s) => [
      s,
      [
        s === 'recommendations'
          ? {
              ...item,
              recommendation_key: 'validation',
              action: 'Keep checking results.',
              copy_prompt: 'Validate the result.',
              singleton_observation: true,
            }
          : { ...item },
      ],
    ]),
  )
}

test('complete native semantic flow preserves structured completion and escapes HTML', () =>
  scope(({ store, run }) => {
    const result = prepare(store, run, { privacy: 'local' })
    for (const id of result.batches)
      submitBatch(store, run, id, facets(getBatch(store, run, id)))
    const input = prepareAggregate(store, run),
      value = aggregate(input)
    value.glance[0].text =
      'A literal </script><script>alert(1)</script> is evidence text.'
    submitAggregate(store, run, value)
    const final = finalize(store, run),
      report = JSON.parse(readFileSync(final.data, 'utf8')),
      html = readFileSync(final.report, 'utf8')
    assert.equal(report.semantic_analysis.status, 'complete')
    assert.equal(report.totals.tokens.total_tokens, 3 * 64)
    assert.equal(report.task_families[0].completion.verified_completed, 'yes')
    assert.equal(report.task_families[0].completion.accepted, 'unknown')
    assert.equal(report.semantic_facets.length, 3)
    assert.ok(report.semantic_evidence.some((e) => e.role === 'tool'))
    assert.ok(!html.includes('</script><script>alert(1)'))
    assert.ok(!html.includes('__DSH_SESSION_INSIGHTS_DATA__'))
    assert.match(html, /<html lang="en">/)
  }))

test('batch traversal, absolute paths and unlisted IDs never read or mutate artifacts', () =>
  scope(({ home, store, run }) => {
    prepare(store, run)
    const outside = join(home, 'outside.json')
    writeFileSync(outside, 'unchanged')
    for (const id of [
      '../outside',
      '../../outside',
      outside,
      'batch-999',
      'batch-001/../../outside',
      '..\\outside',
      'batch-001\0',
    ]) {
      assert.throws(() => getBatch(store, run, id))
      assert.throws(() => submitBatch(store, run, id, { facets: [] }))
    }
    assert.equal(readFileSync(outside, 'utf8'), 'unchanged')
    assert.throws(() => store.run(store.root))
    assert.throws(() => store.run(home))
  }))

test('linked roots, inputs, outputs, hard links and cleanup entries fail closed', () =>
  scope(({ home, store, run }) => {
    prepare(store, run)
    const outside = join(home, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'sentinel'), 'unchanged')
    const linked = join(run, 'linked')
    symlinkSync(
      outside,
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    assert.throws(
      () => store.write(run, 'linked/sentinel', { changed: true }),
      /unsafe/,
    )
    assert.throws(() => store.read(run, 'linked/sentinel'), /unsafe/)
    assert.throws(() => store.cleanup(run, true), /unsafe/)
    unlinkSync(linked)
    linkSync(join(outside, 'sentinel'), join(run, 'report.json'))
    assert.throws(() => store.write(run, 'report.json', {}), /unsafe/)
    assert.throws(() => store.read(run, 'report.json'), /unsafe/)
    assert.throws(() => store.cleanup(run, true), /unsafe/)
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'unchanged')
    rmSync(join(run, 'report.json'))
    rmSync(join(run, 'batches'), { recursive: true })
    symlinkSync(
      outside,
      join(run, 'batches'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    assert.throws(() => getBatch(store, run, 'batch-001'), /unsafe/)
  }))

test('symlink beneath the configured home cannot redirect the entire store', () => {
  const home = mkdtempSync(join(tmpdir(), 'insights-root-')),
    outside = mkdtempSync(join(tmpdir(), 'insights-outside-'))
  try {
    symlinkSync(
      outside,
      join(home, 'insights'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    assert.throws(() => new Store(home).create(), /unsafe/)
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('cleanup previews first, requires explicit confirmation, and preserves other runs and source logs', () =>
  scope(({ home, store, run }) => {
    prepare(store, run)
    const other = store.create()
    mkdirSync(join(home, 'sessions'))
    writeFileSync(join(home, 'sessions', 'sentinel'), 'source')
    const preview = store.cleanup(run)
    assert.equal(preview.deleted, false)
    assert.ok(preview.bytes > 0)
    assert.ok(preview.files.some((f) => f.path === 'semantic-evidence.json'))
    const deleted = store.cleanup(run, true)
    assert.equal(deleted.deleted, true)
    assert.throws(() => statSync(run))
    assert.ok(statSync(other).isDirectory())
    assert.equal(
      readFileSync(join(home, 'sessions', 'sentinel'), 'utf8'),
      'source',
    )
    const legacy = join(store.root, 'legacy-run')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'report.json'), 'legacy')
    assert.throws(() => store.cleanup(legacy, true))
    assert.equal(readFileSync(join(legacy, 'report.json'), 'utf8'), 'legacy')
  }))

test('new native artifacts have owner-only permissions on POSIX', () =>
  scope(({ store, run }) => {
    if (process.platform === 'win32') return
    prepare(store, run)
    assert.equal(statSync(run).mode & 0o777, 0o700)
    assert.equal(statSync(join(run, 'manifest.json')).mode & 0o777, 0o600)
  }))

test('tampered manifest paths cannot cause external cache writes', () =>
  scope(({ home, store, run }) => {
    const result = prepare(store, run),
      m = store.read(run, 'manifest.json')
    m.cache = { enabled: true, directory: home }
    store.write(run, 'manifest.json', m)
    const id = result.batches[0]
    submitBatch(store, run, id, facets(getBatch(store, run, id)))
    assert.deepEqual(readdirSync(home), ['insights'])
    m.batch_ids = ['../../escape']
    store.write(run, 'manifest.json', m)
    assert.throws(() => prepareAggregate(store, run), /manifest/)
  }))

test('invalid replacements never overwrite a previously validated batch', () =>
  scope(({ store, run }) => {
    const result = prepare(store, run),
      id = result.batches[0],
      valid = facets(getBatch(store, run, id))
    submitBatch(store, run, id, valid)
    for (const mutate of [
      (v) => v.facets.reverse(),
      (v) => (v.facets[0].evidence_refs = ['not-known']),
      (v) => (v.facets[0].accepted = true),
      (v) => (v.facets[0].goal = 'Bearer ' + 'a'.repeat(24)),
      (v) => (v.facets[0].goal = 'C:\\private\\report.txt'),
      (v) => (v.facets[0].goal = '/private/report.txt'),
      (v) => (v.facets[0].task_type = 'not-an-enum'),
    ]) {
      const v = structuredClone(valid)
      mutate(v)
      assert.throws(() => submitBatch(store, run, id, v))
      assert.deepEqual(store.read(run, `facet-outputs/${id}.json`), valid)
    }
  }))

test('aggregate rejects cross-family evidence, unsupported conclusions and premature submission', () =>
  scope(({ store, run }) => {
    const result = prepare(store, run)
    assert.throws(() => submitAggregate(store, run, {}))
    for (const id of result.batches)
      submitBatch(store, run, id, facets(getBatch(store, run, id)))
    const input = prepareAggregate(store, run),
      valid = aggregate(input)
    for (const mutate of [
      (v) =>
        (v.glance[0].supporting_task_family_ids = [
          input.facets[1].task_family_id,
        ]),
      (v) => (v.glance[0].verified_completed = 'yes'),
      (v) => (v.recommendations[0].singleton_observation = false),
      (v) => (v.glance[0].confidence = 'certain'),
    ]) {
      const v = structuredClone(valid)
      mutate(v)
      assert.throws(() => submitAggregate(store, run, v))
    }
    submitAggregate(store, run, valid)
    assert.equal(finalize(store, run).status, 'complete')
  }))

test('metrics and explicit fallback remain separate from semantic success', () =>
  scope(({ store, run }) => {
    const prepared = prepare(store, run, { privacy: 'metrics' })
    assert.equal(prepared.batches.length, 0)
    const final = finalize(store, run)
    assert.equal(final.status, 'not_applicable')
    const report = store.read(run, 'report.json')
    assert.equal(report.excerpts.length, 0)
    assert.equal(report.semantic_evidence.length, 0)
    const second = store.create()
    prepare(store, second)
    assert.throws(() => finalize(store, second))
    assert.equal(finalize(store, second, true).status, 'fallback')
  }))

test('structured failure cannot be overridden by success text in untrusted output', () => {
  const result = analyzeTool(
    { isError: true, text: 'Command completed\nExit code: 0' },
    { verification: true },
  )
  assert.equal(result.structured_failure, true)
  assert.equal(result.outcome, 'failure')
})

test('redaction removes secrets, paths, email, URL credentials and context instructions', () => {
  const text =
    'Bearer ' +
    'a'.repeat(24) +
    ' /private/example/path C:\\private\\example.txt person@example.org https://name:pass@example.org/path?q=secret <system-reminder>hidden</system-reminder>'
  const value = sanitize(text, 'redacted', 1000)
  for (const needle of [
    'a'.repeat(24),
    '/private/',
    'C:\\private',
    'person@example.org',
    'name:pass',
    'q=secret',
    'hidden',
  ])
    assert.ok(!value.includes(needle), needle)
})

test('native worker ignores Python configuration and does not inherit secret environment', async () => {
  const names = [
      'DSH_SESSION_INSIGHTS_PYTHON',
      'PYTHONPATH',
      'PYTHONSTARTUP',
      'INSIGHTS_TEST_SENTINEL',
    ],
    previous = Object.fromEntries(names.map((k) => [k, process.env[k]]))
  try {
    for (const k of names) process.env[k] = '/nonexistent/poison'
    const f = fixture(),
      value = await _test.analyze(f.snapshots, f.options)
    assert.equal(value.report.totals.sessions, 3)
    assert.ok(!JSON.stringify(value).includes('/nonexistent/poison'))
  } finally {
    for (const k of names) {
      if (previous[k] === undefined) delete process.env[k]
      else process.env[k] = previous[k]
    }
  }
})

test('pre-cancelled requests never query sessions or start analysis', async () => {
  const c = new AbortController()
  c.abort()
  let called = false
  await assert.rejects(
    _test.collectSnapshots(
      {
        sessionQuery: {
          listSessions() {
            called = true
            return []
          },
        },
      },
      { now: Date.now(), days: 30 },
      c.signal,
    ),
    /cancelled/,
  )
  assert.equal(called, false)
})

test('model-input privacy also redacts local report titles', () =>
  scope(({ store, run }) => {
    const f = fixture()
    prepareSemantic(
      store,
      run,
      buildReport(f.snapshots, {
        ...f.options,
        privacy: 'local',
        analysis_privacy: 'redacted',
      }),
    )
    const m = store.read(run, 'manifest.json'),
      batch = getBatch(store, run, m.batch_ids[0])
    assert.ok(
      store
        .read(run, 'base-report.json')
        .session_summaries[0].title.includes('/private/example/file'),
    )
    assert.ok(!JSON.stringify(batch).includes('/private/example/file'))
  }))

test('source events preserve historical counts while only live surface text enters semantic evidence', () =>
  scope(({ store, run }) => {
    const f = fixture(),
      s = f.snapshots[0]
    const message = (id, role, kind, text) => ({id,role,source:{kind},content:[{type:'text',text}]})
    s.events.push({seq:10,type:'system/message',surfaceOp:'append',data:{message:message('sys','system','system-prompt','SYSTEM-ONLY-SENTINEL')}})
    s.events.push({seq:11,type:'user/message',surfaceOp:'append',data:message('inj','user','session-insights','INJECTED-SENTINEL')})
    s.events.push({seq:12,type:'user/message',surfaceOp:{op:'replace',startSeq:3,endSeq:3},sourceEventSeqs:[3],data:message('replacement','user','compact-checkpoint','Replacement summary.')})
    const built = buildReport([s], f.options),
      row = built.report.session_summaries[0]
    assert.equal(row.system_messages, 1)
    assert.equal(row.injected_user_messages, 2)
    assert.equal(row.user_messages, 2)
    assert.equal(row.assistant_messages, 1)
    assert.equal(row.semantic_shadowed_messages, 1)
    prepareSemantic(store, run, built)
    const json = JSON.stringify(store.read(run, 'semantic-evidence.json'))
    assert.ok(!json.includes('SYSTEM-ONLY-SENTINEL'))
    assert.ok(!json.includes('INJECTED-SENTINEL'))
    assert.ok(!json.includes('Implemented the requested feature.'))
    assert.ok(!json.includes('Replacement summary.'))
  }))

test('token samples deduplicate stream updates and include cache writes without doubling reasoning', () => {
  const f = fixture(),
    s = f.snapshots[0]
  s.events.push({seq:10,type:'assistant/attempt',data:{stream:[{chunk:{type:'usage',usage:{inputTokens:9999}}}]}})
  const r = buildReport([s], f.options).report
  assert.equal(r.totals.tokens.total_tokens, 64)
  assert.equal(r.totals.tokens.reasoning_output_tokens, 3)
  assert.equal(r.totals.assistant_messages, 1)
  assert.equal(r.totals.assistant_attempts, 1)
})

test('bounded selection retains project diversity and excludes meta-analysis', () => {
  const families = Array.from({ length: 60 }, (_, i) => ({
    task_family_id: `family-${i}`,
    root_rollout_id: `root-${i}`,
    date: `2026-09-${String(1 + (i % 20)).padStart(2, '0')}`,
    project: i < 30 ? 'large' : `other-${i % 4}`,
    user_messages: 2,
    tool_calls: 1,
    meta_analysis: i === 0,
    structured_failures: i % 3,
    correction_messages: i % 2,
    retry_classification: { unchanged: 0 },
    completion: {
      accepted: 'unknown',
      verified_completed: i % 2 ? 'yes' : 'unknown',
    },
    complexity_score: i,
  }))
  const selected = selectFamilies(families)
  assert.equal(selected.length, 24)
  assert.equal(new Set(selected.map((f) => f.task_family_id)).size, 24)
  assert.ok(!selected.some((f) => f.meta_analysis))
  assert.ok(new Set(selected.map((f) => f.project)).size >= 4)
})

test('public runtime has no Python launcher, child-process import or dynamic code evaluation', () => {
  const folder = new URL('../plugin/lib/', import.meta.url)
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(new URL(file, folder), 'utf8')
    assert.doesNotMatch(
      code,
      /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?child_process/,
    )
    assert.doesNotMatch(code, /\beval\s*\(|new\s+Function\s*\(/)
    assert.doesNotMatch(code, /DSH_SESSION_INSIGHTS_PYTHON|PYTHONPATH/)
  }
})

test('artifact names cannot select a Windows drive or alternate data stream', () =>
  scope(({ store, run }) => {
    for (const name of [
      'Z:/outside.json',
      'C:outside.json',
      'report.json:stream',
      '../outside.json',
      '/outside.json',
    ]) {
      assert.throws(() => store.read(run, name), /invalid artifact name/)
      assert.throws(() => store.write(run, name, {}), /invalid artifact name/)
    }
  }))

test('resume rejects old DSH, format and analyzer manifest identities', () =>
  scope(({ store, run }) => {
    prepare(store, run)
    const original = store.read(run, 'manifest.json')
    for (const [key, value] of [['target_dsh_version', '0.1.7-rc.1'], ['input_format_version', 3], ['analyzer_semantics', 'old'], ['native_version', 1]]) {
      store.write(run, 'manifest.json', {...original, [key]: value})
      assert.throws(() => prepareAggregate(store, run), /manifest|version|identity/)
    }
  }))

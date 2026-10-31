import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildReport} from '../plugin/lib/analyzer.js'
import {_test} from '../plugin/lib/index.js'
import {LOCALES, MESSAGES, missingKeys, t} from '../plugin/lib/messages.js'

const rows = readFileSync(new URL('../tests/fixtures/synthetic-session.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
const snapshot = {session: rows[0], events: rows.slice(1)}
const cjk = /[\u3400-\u9fff]/

function russianReport(privacy = 'metrics') {
  return buildReport([snapshot], {
    now: rows[0].createdAt + 86400000,
    days: 30,
    privacy,
    locale: 'ru',
    analysis_depth: 'evidence',
  }).report
}

const failureRows = readFileSync(new URL('../tests/fixtures/rc2-repairs/propagated-failure/session.v4.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
const failureSnapshot = {session: failureRows[0], events: failureRows.slice(1)}

test('russian locale is accepted and invalid locales are rejected', () => {
  assert.equal(_test.normalizeOptions({locale: 'ru'}).locale, 'ru')
  assert.equal(_test.parseCommandInput('--days 30 --locale ru').locale, 'ru')
  assert.throws(() => _test.normalizeOptions({locale: 'de'}), /zh-CN, en, or ru/)
})

test('russian metrics report localizes framework-owned strings', () => {
  const report = russianReport()
  assert.equal(report.scope.locale, 'ru')
  assert.equal(report.session_summaries[0].title, 'Содержимое скрыто')
  assert.equal(report.narrative.glance[0].label, 'Фокус работы')
  const narrative = JSON.stringify(report.narrative)
  assert.match(narrative, /[А-Яа-я]/)
  assert.doesNotMatch(narrative, cjk)
  assert.doesNotMatch(JSON.stringify(report.recommendations), cjk)
  assert.doesNotMatch(JSON.stringify(report.warnings), cjk)
})

test('russian orchestration prompt is localized', () => {
  const message = _test.orchestrationPrompt({workdir: '/workspace/run'}, 'ru')
  const text = message.content[0].text
  assert.match(text, /Продолжите текущий запуск session-insights/)
  assert.match(text, /недоверенными данными/)
  assert.doesNotMatch(text, cjk)
})

test('russian native recommendations use russian feature labels', () => {
  const report = buildReport([failureSnapshot], {
    now: failureRows[0].createdAt + 86400000,
    days: 30,
    privacy: 'redacted',
    locale: 'ru',
    analysis_depth: 'evidence',
  }).report
  assert.ok(report.recommendations.length > 0)
  assert.equal(report.recommendations[0].feature, 'Проверка и восстановление')
  assert.doesNotMatch(JSON.stringify(report.recommendations), cjk)
})

test('message catalog has every locale', () => {
  for (const locale of LOCALES) assert.deepEqual(missingKeys(locale), [])
  for (const [key, entry] of Object.entries(MESSAGES))
    assert.deepEqual(Object.keys(entry).sort(), [...LOCALES].sort(), key)
  assert.throws(() => t('ru', 'missing.key'), /missing message key/)
  const strings = Object.values(MESSAGES)
    .map((entry) => entry.ru)
    .filter((value) => typeof value === 'string')
  assert.doesNotMatch(strings.join('\n'), cjk)
})

test('native warning grammar keeps singular English forms', () => {
  assert.match(
    t('en', 'native.warning.partial', {count: 1}),
    /^1 rollout has unfinished turns/,
  )
  assert.match(
    t('en', 'native.warning.attempts', {count: 1}),
    /^1 attempt committed no reply/,
  )
})

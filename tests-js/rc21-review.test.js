import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildReport} from '../plugin/lib/analyzer.js'
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const vectors = read('../tests/fixtures/rc21-review-vectors.json')
const base = read('../tests/fixtures/rc21/job-lifecycle/snapshot.json')
const options = {now: base.session.createdAt + 86400000, days: 30, privacy: 'redacted', analysis_depth: 'evidence', locale: 'en'}
const report = snapshot => buildReport([snapshot], options).report.session_summaries[0]
function cwdSnapshot(vector) {
  const snapshot = {session: {...base.session, isSeeded: true}, events: [], inheritedEventCount: vector.inherited.length}
  const add = (type, data) => snapshot.events.push({type, seq: snapshot.events.length, time: base.session.createdAt, data})
  for (const cwd of vector.inherited) add('working-directory/change', {cwd})
  add('session/end-seed', {inherited: true})
  for (const cwd of vector.own) add('working-directory/change', {cwd})
  return snapshot
}
for (const vector of vectors.cwd) test(`cwd cut and path identity: ${vector.name}`, () => {
  const directory = report(cwdSnapshot(vector)).working_directory
  for (const [key, expected] of Object.entries(vector.expected)) assert.deepEqual(directory[key], expected, key)
  const labels = vector.inherited.filter(Boolean).map(cwd => cwd.split('/').at(-1))
  assert.deepEqual(directory.inherited_labels, [...new Set(labels)])
  assert.equal(directory.origin_label, 'project-a')
})
for (const paired of [true, false]) for (const inherited of [true, false]) test(`terminal fields validated before pairing: paired=${paired}, inherited=${inherited}`, () => {
  for (const vector of vectors.settlement) {
    const snapshot = structuredClone(base)
    if (!paired) snapshot.events = snapshot.events.filter(event => event.type !== 'job/registered')
    if (inherited) {
      snapshot.events = snapshot.events.filter(event => event.type.startsWith('job/'))
      snapshot.session.isSeeded = true
      snapshot.inheritedEventCount = snapshot.events.length
      snapshot.events.push({type: 'session/end-seed', time: base.session.createdAt, data: {inherited: true}})
    }
    snapshot.events.forEach((event, seq) => { event.seq = seq })
    const data = snapshot.events.find(event => event.type === 'job/settled').data
    if (vector.missing) delete data[vector.field]
    else data[vector.field] = vector.value
    if (!vector.accepted) assert.throws(() => report(snapshot), new RegExp(`invalid job settlement: ${vector.field}`), vector.name)
    else {
      const jobs = report(snapshot).jobs
      assert.equal(jobs.unpaired_settlement, paired ? 0 : 1, vector.name)
      assert.equal(jobs.settled, paired ? 1 : 0, vector.name)
    }
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const snapshot = structuredClone(base)
    if (!paired) snapshot.events = snapshot.events.filter(event => event.type !== 'job/registered')
    snapshot.events.forEach((event, seq) => { event.seq = seq })
    snapshot.events.find(event => event.type === 'job/settled').data.finishedAt = value
    assert.throws(() => report(snapshot), /invalid job settlement: finishedAt/)
  }
})

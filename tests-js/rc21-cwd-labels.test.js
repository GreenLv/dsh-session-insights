import test from 'node:test'
import assert from 'node:assert/strict'
import {buildReport} from '../plugin/lib/analyzer.js'
import {renderReport} from '../plugin/lib/semantic.js'
import {renderMemory} from './fixtures/rc21-privacy.mjs'
import {cwdLabelVectors,cwdLabelSnapshot,expectedDirectoryLabels} from './fixtures/rc21-cwd-labels.mjs'
for(const context of ['origin','own','inherited','inherited-own']) test(`cwd display family: ${context}`,()=>{
 for(const privacy of ['local','redacted','metrics']) for(const locale of ['en','zh-CN']) {
  const snapshots=cwdLabelVectors.map(vector=>cwdLabelSnapshot(vector,context))
  const {report}=buildReport(snapshots,{now:snapshots[0].session.createdAt+86400000,days:30,privacy,locale,analysis_depth:'evidence'})
  if(context==='origin') {
   assert.deepEqual(report.session_summaries.map(row=>row.project),cwdLabelVectors.map(vector=>vector.label))
   assert.deepEqual(new Set(report.projects.map(row=>row.project)),new Set(cwdLabelVectors.map(vector=>vector.label)))
   const strings=[]
   const collect=value=>{if(typeof value==='string')strings.push(value);else if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){strings.push(key);collect(item)}}
   collect(report)
   for(const vector of cwdLabelVectors){const raw=vector.cwd_parts.join('');if(raw.includes('/')||raw.includes('\\'))assert.ok(!strings.includes(raw),vector.name)}
   assert.ok(!JSON.stringify(report).includes('synthetic-cwd-secret'))
   assert.ok(!JSON.stringify(report).includes('synthetic_cwd_secret'))
  }
  const html=renderMemory(report,renderReport)
  const embedded=JSON.parse(html.match(/<script id="report-data"[^>]*>([\s\S]*?)<\/script>/)[1])
  for(let index=0;index<cwdLabelVectors.length;index++) {
   const vector=cwdLabelVectors[index],directory=report.session_summaries[index].working_directory
   for(const [key,value] of Object.entries(expectedDirectoryLabels(vector,context)))assert.deepEqual(directory[key],value,`${vector.name}.${key}`)
   assert.deepEqual(embedded.session_summaries[index].working_directory,directory)
   const output=JSON.stringify(directory)
   if(vector.cwd_parts.join('').includes('/')||vector.cwd_parts.join('').includes('\\'))
    assert.ok(!output.includes(JSON.stringify(vector.cwd_parts.join('')).slice(1,-1)),vector.name)
   assert.ok(!output.includes('synthetic-cwd-secret'),vector.name)
   assert.ok(!output.includes('synthetic_cwd_secret'),vector.name)
  }
 }
})
test('cwd changes retain immutable header project selection',()=>{
 const snapshot=cwdLabelSnapshot({name:'filter',cwd_parts:['/synthetic/other'],label:'other'},'inherited-own')
 const options={now:snapshot.session.createdAt+86400000,days:30,privacy:'redacted'}
 assert.equal(buildReport([snapshot],{...options,project:snapshot.session.cwd}).report.totals.sessions,1)
 assert.equal(buildReport([snapshot],{...options,project:'/synthetic/other'}).report.totals.sessions,0)
})

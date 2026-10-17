// Test-only adapter for production report projection and actual HTML rendering.
import {buildReport} from '../../plugin/lib/analyzer.js'
import {renderReport} from '../../plugin/lib/semantic.js'
import {renderMemory} from './rc21-privacy.mjs'
let input=''
for await(const chunk of process.stdin) input+=chunk
const {snapshots,options}=JSON.parse(input)
const {report}=buildReport(snapshots,options)
process.stdout.write(JSON.stringify({report,html:renderMemory(report,renderReport)}))

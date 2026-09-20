// Test-only stdin adapter. The shipped runtime never invokes this process.
import { buildReport } from '../../plugin/lib/analyzer.js'
let input = ''
for await (const chunk of process.stdin) input += chunk
const { snapshots, options } = JSON.parse(input)
process.stdout.write(JSON.stringify(buildReport(snapshots, options)))

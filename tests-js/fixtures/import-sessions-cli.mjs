// CLI driver for the D02 import harness: emits the imported V4 snapshots as
// JSON on stdout for the Python-side differential test.
import { importSyntheticExports } from './import-sessions.mjs'

const harness = await importSyntheticExports()
process.stdout.write(JSON.stringify({
  snapshots: harness.snapshots,
  continued_session_id: harness.continuedSessionId,
  workspace_path: harness.result.workspacePath,
  session_count: harness.result.sessionIds.length,
  skipped: harness.result.skipped,
  importer: harness.importerIdentity,
}))

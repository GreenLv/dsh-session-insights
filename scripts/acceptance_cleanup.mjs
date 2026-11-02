// Isolated profile acceptance lifecycle. Hooks make the same production cleanup
// path testable without starting a real host or touching a user's profile.
export async function cleanupPreservingFailure(primaryFailure,actions) {
  const failures=[]
  for(const action of actions)try {await action()} catch(error) {failures.push(error)}
  if(failures.length)throw new AggregateError(primaryFailure?[primaryFailure,...failures]:failures,'acceptance cleanup failed')
}

export async function finalizeProfileAcceptance({
  annex, failure, hadWork, disposeOwner, shutdownApp, leaveWork, removeWork,
  reportCleanupErrors, writeAnnex, onClean,
}) {
  const errors = []
  const attempt = async (id, action) => {
    try { await action() } catch (error) { errors.push({id, error}) }
  }
  await attempt('owner', disposeOwner)
  await attempt('profile', shutdownApp)
  if (hadWork) {
    await attempt('cwd', leaveWork)
    // A failed disposer, shutdown or cwd transition leaves the work tree's
    // users unknown. Preserve it; deleting underneath an active host is unsafe.
    if (errors.length) errors.push({id: 'native-test-tree', error: Object.assign(new Error('cleanup deferred'), {name: 'CleanupDeferred'})})
    else await attempt('native-test-tree', removeWork)
  }
  annex.cleanup = {status: errors.length ? 'failed' : 'passed', remaining_ids: errors.map(e => e.id)}
  if (errors.length) {
    // Failure to record a diagnostic is itself a failed outcome, but must not
    // prevent attempting the canonical receipt.
    try { await reportCleanupErrors(errors) } catch { errors.push({id: 'diagnostic'}) }
  }
  if (!errors.length && hadWork) onClean()
  annex.status = !failure && errors.length === 0 && annex.gates.every(g =>
    (!g.required || g.status === 'passed') && g.status !== 'failed') ? 'passed' : 'failed'
  annex.run.finished_at = new Date().toISOString()
  try {
    await writeAnnex(annex)
  } catch {
    // A missing receipt cannot prove acceptance, even after successful work.
    return {status: 'failed', exitCode: 1, receiptWritten: false}
  }
  return {status: annex.status, exitCode: annex.status === 'passed' ? 0 : 1, receiptWritten: true}
}

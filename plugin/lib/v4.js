// Bounded admission for host-delivered V4 logical snapshots. The official
// rc.2 catalog remains the full fixture/physical-contract validator.
import rules from './rules.js'
export const INPUT_IDENTITY = Object.freeze({target_dsh_version: '0.1.7-rc.2', input_format_version: 4, analyzer_semantics: 'v4-rc2.2'})
const surfaceTypes = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
export function validateV4(snapshot) {
  if (snapshot?.session?.version !== 4 || !Array.isArray(snapshot.events)) throw new Error('DSH 0.1.7-rc.2 V4 snapshot required; migrate old logs upstream')
  const surface = [], markers = []
  for (const [seq, event] of snapshot.events.entries()) {
    if (event?.seq !== seq || !event.data || typeof event.data !== 'object') throw new Error('invalid V4 event sequence or data')
    if (!rules.DSH_KNOWN_RECORD_TYPES.includes(event.type)) {
      if (event.ignorable !== true) throw new Error('unknown required V4 event')
      continue
    }
    if (event.type === 'session/end-seed' && event.data.inherited === true) markers.push(seq)
    if (!surfaceTypes.has(event.type)) continue
    const m = event.type === 'user/message' ? event.data : event.data.message
    const role = event.type === 'tool/result' ? 'tool' : event.type.split('/')[0]
    if (!m || m.role !== role || typeof m.id !== 'string' || !m.id || !Array.isArray(m.content)
      || typeof m.source?.kind !== 'string' || !m.source.kind || m.source.kind === 'plugin')
      throw new Error('invalid V4 message role, identity or source')
    if (m.content.some(b => b.type === 'tool-result')) throw new Error('legacy tool-result wrapper is not V4')
    if (role === 'tool' && (typeof m.toolCallId !== 'string' || m.toolCallId !== m.source.callId || m.source.kind !== 'tool' || (m.isError !== undefined && typeof m.isError !== 'boolean')))
      throw new Error('V4 tool result call identity conflict')
    const sources = event.sourceEventSeqs
    if (sources !== undefined && (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length || sources.some(n => !Number.isSafeInteger(n) || n < 0 || n >= seq)))
      throw new Error('invalid V4 sourceEventSeqs')
    if (event.surfaceOp === 'append') surface.push(seq)
    else {
      const op = event.surfaceOp, start = surface.indexOf(op?.startSeq), end = surface.indexOf(op?.endSeq)
      if (op?.op !== 'replace' || start < 0 || end < start || surface.slice(start,end+1).some(n => !sources?.includes(n))) throw new Error('invalid V4 surface replacement')
      surface.splice(start,end-start+1,seq)
    }
  }
  const cut = snapshot.inheritedEventCount ?? (markers.at(-1) ?? 0)
  if (!Number.isSafeInteger(cut) || cut < 0 || cut > snapshot.events.length || (markers.at(-1) ?? 0) !== cut || (cut > 0 && !snapshot.session.isSeeded)) throw new Error('V4 inherited cut disagrees with marker')
  return cut
}

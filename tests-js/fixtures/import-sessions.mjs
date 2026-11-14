// Official rc.3 DeepSeek chat-export import harness for D02 regression tests.
// The conversion runs the PUBLISHED official importer sources
// (`@deepseek-ai/dsh-deepseek-chat-import/src/importer.ts`, copied verbatim out
// of node_modules so Node can strip types) against the official
// `@deepseek-ai/dsh-session-persistence-jsonl` backend mounted in a real
// cordis context. Nothing here fabricates import events: the only hand-written
// part is the synthetic `deepseek_data-*.zip` input, which follows the
// exporter's format_version 3 schema. No model, GUI or user data.
import { createRequire } from 'node:module'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const HOST_ROOT = fileURLToPath(new URL('../../tests/dsh-host', import.meta.url))
const req = createRequire(join(HOST_ROOT, 'package.json'))
const load = async (name) => import(pathToFileURL(req.resolve(name)).href)

export const importerIdentity = () => {
  const meta = JSON.parse(readFileSync(req.resolve('@deepseek-ai/dsh-deepseek-chat-import/package.json'), 'utf8'))
  const digest = (rel) => createHash('sha256').update(readFileSync(req.resolve(`@deepseek-ai/dsh-deepseek-chat-import/${rel}`))).digest('hex')
  return {
    name: meta.name,
    version: meta.version,
    sources: Object.fromEntries(['src/importer.ts', 'src/conversation.ts', 'src/format.ts', 'src/archive.ts'].map((rel) => [rel, digest(rel)])),
  }
}

// One synthetic export archive covering the representative conversation shapes
// the official importer maps: normal Q&A with staged web search/fetch, file and
// image references, failed/template/empty/no replies, a content-filtered pair,
// and an untitled single-turn conversation.
function exportArchive() {
  const T = (h, s = 0) => `2026-11-0${h}T08:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`
  const user = (id, parent, at, fragments, status = 'FINISHED') =>
    ({ id, parent_id: parent, role: 'USER', status, inserted_at: at, fragments })
  const reply = (id, parent, at, fragments, status = 'FINISHED') =>
    ({ id, parent_id: parent, role: 'ASSISTANT', status, inserted_at: at, fragments })
  const REQUEST = (content) => ({ type: 'REQUEST', content })
  const RESPONSE = (content) => ({ type: 'RESPONSE', content })
  const THINK = (content, elapsed_secs = 2) => ({ type: 'THINK', content, elapsed_secs })

  const convA = {
    id: 'conv-a',
    title: '  查找 rc.3 发布说明  ',
    current_message_id: 4,
    inserted_at: T(1),
    messages: [
      user(1, null, T(1, 10), [REQUEST('查找 DSH 0.2.2-rc.3 的发布说明并总结')]),
      reply(2, 1, T(1, 20), [
        THINK('先检索官方渠道。', 3),
        { type: 'TOOL_SEARCH', queries: ['DSH 0.2.2-rc.3 release notes'], status: 'FINISHED', stage_id: 1, results: [
          { url: 'https://example.com/dsh-rc3', title: 'rc.3 release notes', snippet: 'rc.3 adds the chat importer', published_at: '2026-11-13' },
        ] },
        { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://example.com/dsh-rc3', title: 'rc.3 release notes', stage_id: 1 },
        RESPONSE('rc.3 增加实验性导入器并修复桌面更新。'),
      ]),
      user(3, 2, T(1, 30), [REQUEST('继续：给出结论')]),
      reply(4, 3, T(1, 40), [RESPONSE('结论：升级到 rc.3 后可导入历史导出。')]),
    ],
  }

  const convB = {
    id: 'conv-b',
    title: '图和文件引用',
    current_message_id: 2,
    inserted_at: T(2),
    messages: [
      user(1, null, T(2, 10), [
        REQUEST('看一下这张图和这份清单'),
        { type: 'FILE', files: [
          { id: 'img-1', file_name: 'diagram.png', file_size: 1234, is_image: true, export_path: 'chat_sessions/conv-b_files/img-1.png' },
          { id: 'file-2', file_name: 'notes.txt', file_size: 20, is_image: false, export_path: null },
        ] },
      ]),
      reply(2, 1, T(2, 20), [RESPONSE('收到，已记录两个附件。')]),
    ],
  }

  const convC = {
    id: 'conv-c',
    title: '失败与模板回复',
    current_message_id: 9,
    inserted_at: T(3),
    messages: [
      user(1, null, T(3, 10), [REQUEST('第一问')]),
      reply(2, 1, T(3, 20), [RESPONSE('生成到一半被截断')], 'FAILED'),
      user(3, 2, T(3, 30), [REQUEST('第二问')]),
      reply(4, 3, T(3, 40), [{ type: 'TEMPLATE_RESPONSE', content: '服务暂时不可用' }]),
      user(5, 4, T(3, 50), [REQUEST('第三问')]),
      reply(6, 5, T(3, 60), [{ type: 'TIP', content: '仅提示语' }]),
      user(7, 6, T(3, 70), [REQUEST('第四问')]),
      reply(8, 7, T(3, 80), [RESPONSE('被过滤')], 'CONTENT_FILTER'),
      user(9, 8, T(3, 90), [REQUEST('第五问（无回复）')]),
    ],
  }

  const convD = {
    id: 'conv-d',
    title: null,
    current_message_id: null,
    inserted_at: T(4),
    messages: [
      user(1, null, T(4, 10), [REQUEST('问一句')]),
      reply(2, 1, T(4, 20), [RESPONSE('答一句')]),
      user(3, 2, T(4, 30), [REQUEST('再查一次')]),
      reply(4, 3, T(4, 40), [
        { type: 'TOOL_SEARCH', queries: ['DSH rc.3 status'], results: [], status: 'FAILED', stage_id: 1 },
        { type: 'TOOL_SEARCH', queries: [], results: [], status: 'WIP', stage_id: 1 },
        { type: 'TOOL_OPEN', status: 'WIP', url: null, title: null, stage_id: 1 },
        RESPONSE('搜索失败，稍后再试。'),
      ]),
    ],
  }

  const files = {
    'manifest.json': JSON.stringify({ export_format_version: 3 }),
    'chat_session_index.json': JSON.stringify([
      { id: 'conv-a', inserted_at: T(1), updated_at: T(1, 40) },
      { id: 'conv-b', inserted_at: T(2), updated_at: T(2, 20) },
      { id: 'conv-c', inserted_at: T(3), updated_at: T(3, 95) },
      { id: 'conv-d', inserted_at: T(4), updated_at: T(4, 20) },
    ]),
    'chat_sessions/conv-a.json': JSON.stringify(convA),
    'chat_sessions/conv-b.json': JSON.stringify(convB),
    'chat_sessions/conv-c.json': JSON.stringify(convC),
    'chat_sessions/conv-d.json': JSON.stringify(convD),
    'chat_sessions/conv-b_files/img-1.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
  }
  return files
}

// Run the official published importer sources over the official JSONL
// persistence backend. Returns the imported V4 snapshots plus identities.
export async function importSyntheticExports() {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-import-stage-'))
  const home = mkdtempSync(join(tmpdir(), 'dsh-import-home-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'dsh-import-ws-'))
  const workspacePath = join(workspaceRoot, 'project')
  let ctx
  mkdirSync(workspacePath, { recursive: true })
  try {
    // Stage the published importer TypeScript sources verbatim (verified by
    // hash against the installed package), mechanically transform them with
    // Node's own TypeScript transform (type stripping; no semantic rewrite),
    // and resolve official packages through the host tree. The stage sits
    // outside node_modules because Node refuses to strip types there.
    const pkgDir = dirname(req.resolve('@deepseek-ai/dsh-deepseek-chat-import/package.json'))
    const SOURCES = ['src/importer.ts', 'src/conversation.ts', 'src/format.ts', 'src/archive.ts', 'src/types.ts']
    mkdirSync(join(stage, 'src'), { recursive: true })
    symlinkSync(join(HOST_ROOT, 'node_modules'), join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const sourceDigests = {}
    for (const rel of SOURCES) {
      const published = readFileSync(join(pkgDir, rel), 'utf8')
      sourceDigests[rel] = createHash('sha256').update(published).digest('hex')
      let code = stripTypeScriptTypes(published, { mode: 'transform' })
      code = code.replaceAll(/(from\s+')(\.\/[^']+)\.ts(')/g, '$1$2.js$3')
      writeFileSync(join(stage, rel.replace(/\.ts$/, '.js')), code)
    }

    const { Context } = await load('@deepseek-ai/cordis')
    const jsonl = await load('@deepseek-ai/dsh-session-persistence-jsonl')
    const { Session } = await load('@deepseek-ai/dsh-session')
    const importer = await import(pathToFileURL(join(stage, 'src/importer.js')).href)
    const { zipSync, strToU8 } = await load('fflate')

    ctx = new Context()
    const sessionsRoot = join(home, 'sessions')
    await jsonl.apply(ctx, { root: sessionsRoot, compression: 'zstd' })
    const persistence = ctx.get('sessionPersistence')
    const warnings = []
    const createId = (() => { let n = 0; return () => `imported-${++n}` })()
    const archive = zipSync(Object.fromEntries(Object.entries(exportArchive()).map(([name, data]) =>
      [name, typeof data === 'string' ? strToU8(data) : new Uint8Array(data)])))

    const workspace = { id: 'ws-import', path: workspacePath, attachSession: async () => {} }
    const signal = new AbortController().signal
    const result = await importer.importDeepseekChatExport({
      persistence,
      workspaceRegistered: () => true,
      createId,
      warn: (message) => warnings.push(message),
    }, {
      archive,
      workspace,
      limits: { maxSessions: 1000, maxEntryBytes: 256 * 1024 * 1024, maxTitleBytes: 80 },
      onProgress: () => {},
    }, signal)

    const snapshots = []
    for (const id of result.sessionIds) {
      const handle = await persistence.open(id, 'read')
      const slice = await handle.read(0)
      const events = slice.events ?? slice
      snapshots.push({
        session: handle.header,
        events,
        inheritedEventCount: handle.inheritedEventCount,
      })
      await handle.close()
    }

    // Import-then-continue: the titled two-turn conversation joins a further
    // real turn through the same official persistence backend, as the host
    // does after an import.
    const continued = result.sessionIds.find((id) => {
      const snap = snapshots.find((s) => s.session.id === id)
      return snap && snap.events.some((e) => e.type === 'session/title')
        && snap.events.filter((e) => e.type === 'turn/end' && e.data.reason?.kind === 'completed').length === 2
    })
    assert.ok(continued, 'the titled two-turn conversation exists for continuation')
    const writeHandle = await persistence.open(continued, 'write')
    const base = snapshots.find((s) => s.session.id === continued)
    let seq = base.events.length
    const t0 = 1794201600000
    const push = (type, data, extra = {}) => writeHandle.append([{ type, seq: seq++, time: t0 + seq * 1000, ...data, ...extra }])
    await push('turn/start', { data: { turn: 3 } })
    await push('step/start', { data: { turn: 3, step: 1 } })
    await push('user/message', {
      data: { turn: 3, step: 1, id: 'continue-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '导入后继续：补充一点。' }] },
    }, { surfaceOp: 'append' })
    await push('assistant/message', {
      data: { turn: 3, step: 1, stream: [], message: { id: 'continue-a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek-chat-export', model: 'deepseek-chat-export' }, content: [{ type: 'text', text: '补充完成。' }] } },
    }, { surfaceOp: 'append' })
    await push('step/end', { data: { turn: 3, step: 1 } })
    await push('turn/end', { data: { turn: 3, reason: { kind: 'completed' } } })
    await writeHandle.close()
    const reread = await persistence.open(continued, 'read')
    const continuedSlice = await reread.read(0)
    const continuedSnap = {
      session: reread.header,
      events: continuedSlice.events ?? continuedSlice,
      inheritedEventCount: reread.inheritedEventCount,
    }
    await reread.close()
    snapshots[snapshots.findIndex((s) => s.session.id === continued)] = continuedSnap

    return {
      result: {
        sessionIds: result.sessionIds,
        workspacePath: result.workspacePath,
        conversationCount: result.conversationCount,
        omittedByLimit: result.omittedByLimit,
        skipped: result.skipped,
      },
      snapshots,
      warnings,
      sessionsRoot,
      persistedEntryCount: readdirSync(sessionsRoot).length,
      continuedSessionId: continued,
      importerIdentity: { ...importerIdentity(), sourceDigests },
      sessionFormatValidatedBy: 'Session.create via the official importer write path',
      Session,
    }
  } finally {
    try { if (ctx) await ctx.fiber.dispose() }
    finally {
      const errors = []
      for (const path of [stage, home, workspaceRoot]) {
        try { rmSync(path, { recursive: true, force: true }) }
        catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'import harness cleanup failed')
    }
  }
}

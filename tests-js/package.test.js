import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('npm artifact includes every native runtime module and the shared dashboard', () => {
  // npm test supplies its own CLI path; no global package resolution is needed.
  const temporary = mkdtempSync(join(tmpdir(), 'insights-pack-'))
  try {
    const output = execFileSync(
      process.execPath,
      [
        process.env.npm_execpath,
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        temporary,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: join(temporary, 'cache') },
      },
    )
    const [receipt] = JSON.parse(output),
      paths = new Set(receipt.files.map((f) => f.path))
    for (const file of [
      'index',
      'worker',
      'storage',
      'analyzer',
      'semantic',
      'rules',
    ])
      assert.ok(paths.has(`plugin/lib/${file}.js`), file)
    assert.ok(paths.has('src/dsh_session_insights/assets/dashboard.html'))
    assert.ok(paths.has('SECURITY.md'))
    assert.ok(
      ![...paths].some(
        (p) =>
          p.startsWith('tests') ||
          p.includes('.session-insights-native') ||
          p.startsWith('node_modules/'),
      ),
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

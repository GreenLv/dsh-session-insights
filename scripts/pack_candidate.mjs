#!/usr/bin/env node
// Produce one retained tarball from a clean exact commit. Package only the npm
// file list, adding the source identity to the staged manifest without editing
// the checkout. Consumers transport these bytes; they do not repack.
import {join, resolve, dirname} from 'node:path'
import {readFile, writeFile, mkdir, mkdtemp, cp, rm, stat} from 'node:fs/promises'
import assert from 'node:assert/strict'
import {run, npm, digest, fileManifest} from './acceptance_identity.mjs'

async function main() {
  const [commit, destination] = process.argv.slice(2)
  assert.match(commit || '', /^[0-9a-f]{40}$/)
  assert.ok(destination)
  const output = resolve(destination), root = process.cwd()
  assert.equal((await run('git', ['rev-parse', 'HEAD'], {cwd: root})).stdout.trim(), commit)
  assert.equal((await run('git', ['status', '--porcelain=v1'], {cwd: root})).stdout.trim(), '')
  await mkdir(output, {recursive: true})
  const temporary = await mkdtemp(join(output, 'producer-'))
  try {
    const env = {...process.env, npm_config_cache: join(temporary, 'npm-cache')}
    const [projection] = JSON.parse((await npm(['pack', '--dry-run', '--json', '--ignore-scripts'], {cwd: root, env})).stdout)
    assert.ok(projection.files.length > 0)
    const stage = join(temporary, 'package'), packDir = join(temporary, 'packed')
    await mkdir(stage); await mkdir(packDir)
    for (const item of projection.files) {
      assert.ok(!item.path.startsWith('/') && !item.path.split('/').includes('..'))
      const target = join(stage, item.path)
      await mkdir(dirname(target), {recursive: true}); await cp(join(root, item.path), target)
    }
    const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'dsh-session-insights'); assert.equal(manifest.version, '0.6.0')
    manifest.gitHead = commit
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const [packed] = JSON.parse((await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {cwd: stage, env})).stdout)
    const filename = packed.filename, path = join(output, filename)
    await assert.rejects(stat(path), {code: 'ENOENT'})
    await cp(join(packDir, filename), path, {errorOnExist: true, force: false})
    const extracted = join(temporary, 'readback')
    await mkdir(extracted); await run('tar', ['-xzf', path, '-C', extracted])
    const files = await fileManifest(join(extracted, 'package'))
    assert.deepEqual(files, await fileManifest(stage))
    assert.equal(JSON.parse(await readFile(join(extracted, 'package/package.json'), 'utf8')).gitHead, commit)
    assert.equal((await run('git', ['rev-parse', 'HEAD'], {cwd: root})).stdout.trim(), commit)
    assert.equal((await run('git', ['status', '--porcelain=v1'], {cwd: root})).stdout.trim(), '')
    const bytes = await readFile(path)
    const receipt = {schema: 'dsh-session-insights/canonical-artifact/1', repository: 'https://github.com/GreenLv/dsh-session-insights', commit, filename, sha256: digest(bytes), size_bytes: bytes.length, file_count: files.length, git_head: commit, files}
    await writeFile(join(output, 'artifact.json'), JSON.stringify(receipt, null, 2) + '\n')
    await writeFile(join(output, 'tgz.sha256'), `${receipt.sha256}  ${filename}\n`)
    console.log(JSON.stringify({status: 'passed', filename, sha256: receipt.sha256, size_bytes: bytes.length, file_count: files.length, commit}))
  } finally { await rm(temporary, {recursive: true, force: true}) }
}
main().catch(() => {console.error('candidate producer failed; require clean exact commit and vacant output'); process.exitCode = 1})

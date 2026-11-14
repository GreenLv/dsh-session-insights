#!/usr/bin/env node
// Produce one retained tarball from a clean exact commit. Package only the npm
// file list, adding the source identity to the staged manifest without editing
// the checkout. Consumers transport these bytes; they do not repack.
import {join, resolve, dirname} from 'node:path'
import {readFile, writeFile, mkdir, mkdtemp, cp, rm, stat} from 'node:fs/promises'
import assert from 'node:assert/strict'
import {run, npmCliPath, digest, fileManifest, PRODUCT_VERSION} from './acceptance_identity.mjs'
import {canonicalPackInputs, npmTreeIdentity} from './canonical_artifact.mjs'

async function main() {
  const [commit, destination] = process.argv.slice(2)
  assert.match(commit || '', /^[0-9a-f]{40}$/)
  assert.ok(destination)
  // A preloaded parent module or Node flag can change packing before child
  // environment sanitization is applied; no such injected producer is valid.
  assert.ok(!process.env.NODE_OPTIONS, 'producer NODE_OPTIONS must be empty')
  assert.deepEqual(process.execArgv, [], 'producer Node execution flags must be empty')
  const output = resolve(destination), root = process.cwd()
  assert.equal((await run('git', ['rev-parse', 'HEAD'], {cwd: root})).stdout.trim(), commit)
  assert.equal((await run('git', ['status', '--porcelain=v1'], {cwd: root})).stdout.trim(), '')
  await mkdir(output, {recursive: true})
  const temporary = await mkdtemp(join(output, 'producer-'))
  try {
    // Ambient npm configuration can change the package projection. Use empty
    // user/global files, clear npm config and Node injection variables, and
    // bind the optional project config as part of the source inputs.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_config_/i.test(key) && !['NODE_OPTIONS','NODE_PATH'].includes(key)))
    env.npm_config_cache = join(temporary, 'npm-cache')
    env.npm_config_userconfig = join(temporary, 'user.npmrc')
    env.npm_config_globalconfig = join(temporary, 'global.npmrc')
    await writeFile(env.npm_config_userconfig, '')
    await writeFile(env.npm_config_globalconfig, '')
    const inputIdentity = await canonicalPackInputs(root)
    const npmCli = await npmCliPath()
    const packNpm = (args, options={}) => run(process.execPath, [npmCli, ...args], {...options, env})
    const nodeIdentity = {version: process.version, binary_sha256: digest(await readFile(process.execPath))}
    const npmIdentity = await npmTreeIdentity(npmCli)
    assert.equal((await packNpm(['--version'])).stdout.trim(), npmIdentity.version)
    const [projection] = JSON.parse((await packNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], {cwd: root})).stdout)
    assert.ok(projection.files.length > 0)
    const stage = join(temporary, 'package'), packDir = join(temporary, 'packed')
    await mkdir(stage); await mkdir(packDir)
    for (const item of projection.files) {
      assert.ok(!item.path.startsWith('/') && !item.path.split('/').includes('..'))
      const target = join(stage, item.path)
      await mkdir(dirname(target), {recursive: true}); await cp(join(root, item.path), target)
    }
    const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'dsh-session-insights'); assert.equal(manifest.version, PRODUCT_VERSION)
    manifest.gitHead = commit
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const [packed] = JSON.parse((await packNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {cwd: stage})).stdout)
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
    assert.deepEqual(await canonicalPackInputs(root), inputIdentity, 'pack inputs changed during production')
    assert.equal(digest(await readFile(process.execPath)), nodeIdentity.binary_sha256, 'node binary changed during production')
    assert.deepEqual(await npmTreeIdentity(npmCli), npmIdentity, 'npm distribution changed during production')
    const stagedManifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
    const receipt = {
      schema: 'dsh-session-insights/canonical-artifact/2',
      repository: 'https://github.com/GreenLv/dsh-session-insights',
      commit, filename, sha256: digest(bytes), size_bytes: bytes.length, file_count: files.length, git_head: commit, files,
      producer: {
        node: nodeIdentity,
        npm: npmIdentity,
        packer: 'npm pack --ignore-scripts',
        platform: `${process.platform}-${process.arch}`,
      },
      inputs: {
        pack: inputIdentity,
        staged_manifest_sha256: digest(await readFile(join(stage, 'package.json'))),
        staged_manifest_git_head: stagedManifest.gitHead,
        packed_file_count: files.length,
      },
    }
    const receiptBytes = JSON.stringify(receipt, null, 2) + '\n'
    const receiptSha256 = digest(receiptBytes)
    await writeFile(join(output, 'artifact.json'), receiptBytes, {flag:'wx'})
    await writeFile(join(output, 'tgz.sha256'), `${receipt.sha256}  ${filename}\n`)
    await writeFile(join(output, 'artifact.json.sha256'), `${receiptSha256}  artifact.json\n`, {flag:'wx'})
    console.log(JSON.stringify({status: 'passed', filename, sha256: receipt.sha256, receipt_sha256: receiptSha256, size_bytes: bytes.length, file_count: files.length, commit, producer:receipt.producer}))
  } finally { await rm(temporary, {recursive: true, force: true}) }
}
main().catch(() => {console.error('candidate producer failed; require clean exact commit and vacant output'); process.exitCode = 1})

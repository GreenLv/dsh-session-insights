// Shared, fail-closed identity checks for the single CI-produced artifact.
// Receipt and tarball digests MUST arrive from the coordinator's independent
// producer readback; reading an expected digest from this receipt is circular.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, readdir, readlink, lstat, realpath} from 'node:fs/promises'
import {basename, dirname, join, relative, resolve, sep} from 'node:path'
import {run} from './acceptance_identity.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const SHA = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const REPOSITORY = 'https://github.com/GreenLv/dsh-session-insights'
const INPUT_PATHS = ['.github/workflows/ci.yml', 'package-lock.json', 'package.json', 'scripts/acceptance_identity.mjs', 'scripts/canonical_artifact.mjs', 'scripts/pack_candidate.mjs']

// Bind every file which can affect the pack command itself, including the
// npm allowlist in package.json and the CI producer definition. A project
// .npmrc can change npm pack semantics; absence is an explicit input too.
export async function canonicalPackInputs(root) {
  const entries = []
  // Hash canonical committed blob bytes so a Windows CRLF checkout and the
  // Linux producer agree, while rejecting modified source worktree/index.
  await run('git', ['diff', '--quiet', 'HEAD', '--', ...INPUT_PATHS], {cwd:root})
  for (const path of INPUT_PATHS) {
    const file = join(root, ...path.split('/'))
    assert.ok((await lstat(file)).isFile(), `input is not a regular file: ${path}`)
    const {stdout} = await run('git', ['show', `HEAD:${path}`], {cwd:root, encoding:'buffer', maxBuffer:8*1024*1024})
    entries.push({path, sha256: sha(stdout)})
  }
  let npmrc = null
  try {
    const file = join(root, '.npmrc')
    assert.ok((await lstat(file)).isFile(), '.npmrc is not a regular file')
    npmrc = sha(await readFile(file))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return {files: entries, project_npmrc_sha256: npmrc, npm_config: 'isolated-empty-user-and-global-config; npm_config_environment_cleared; ignore-scripts'}
}

// Capture the actual npm distribution, including bundled node_modules and
// internal symlinks. This is a tool identity, not the receiver's npm install.
export async function npmTreeIdentity(cli) {
  const entry = await realpath(cli), root = dirname(dirname(entry))
  const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(meta.name, 'npm')
  assert.match(meta.version, SEMVER)
  const entries = []
  async function visit(dir) {
    for (const item of (await readdir(dir, {withFileTypes: true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const path = join(dir,item.name), rel = relative(root,path).split(sep).join('/')
      if (item.isSymbolicLink()) {
        const target = await realpath(path)
        assert.ok(target === root || target.startsWith(root + sep), 'npm distribution contains an external symlink')
        entries.push({path:rel,link:await readlink(path)})
      } else if (item.isDirectory()) await visit(path)
      else if (item.isFile()) entries.push({path:rel,sha256:sha(await readFile(path))})
      else throw new Error(`unexpected npm distribution member: ${rel}`)
    }
  }
  await visit(root)
  entries.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assert.ok(entries.length > 0)
  return {version:meta.version, entry:basename(entry), entry_sha256:sha(await readFile(entry)), tree_sha256:sha(JSON.stringify(entries)), file_count:entries.length}
}

export async function verifyCanonicalArtifact({receiptPath, tarballPath, sourceRoot, expectedCommit, expectedSha256, expectedReceiptSha256}) {
  assert.match(expectedCommit || '', COMMIT, 'independent exact source commit required')
  assert.match(expectedSha256 || '', SHA, 'independent tarball SHA-256 required')
  assert.match(expectedReceiptSha256 || '', SHA, 'independent receipt SHA-256 required')
  const source = resolve(sourceRoot)
  const receiptBytes = await readFile(receiptPath), receiptSha256 = sha(receiptBytes)
  assert.equal(receiptSha256, expectedReceiptSha256, 'canonical receipt digest mismatch')
  const receipt = JSON.parse(receiptBytes.toString('utf8'))
  assert.equal(receipt.schema, 'dsh-session-insights/canonical-artifact/2')
  assert.equal(receipt.repository, REPOSITORY)
  assert.equal(receipt.commit, expectedCommit); assert.equal(receipt.git_head, expectedCommit)
  assert.equal((await run('git', ['rev-parse', 'HEAD'], {cwd:source})).stdout.trim(), expectedCommit, 'source checkout commit mismatch')
  assert.equal(receipt.filename, basename(tarballPath))
  assert.match(receipt.filename, /^dsh-session-insights-[0-9A-Za-z.+-]+\.tgz$/)
  assert.equal(receipt.sha256, expectedSha256)
  const bytes = await readFile(tarballPath)
  assert.equal(sha(bytes), expectedSha256, 'canonical tarball digest mismatch')
  assert.equal(receipt.size_bytes, bytes.length)
  assert.ok(Array.isArray(receipt.files) && receipt.files.length > 0)
  assert.equal(receipt.file_count, receipt.files.length)
  const seen = new Set()
  for (const item of receipt.files) {
    assert.deepEqual(Object.keys(item).sort(), ['path','sha256'])
    assert.ok(typeof item.path === 'string' && item.path && !item.path.startsWith('/') && !item.path.includes('\\') && item.path.split('/').every(p=>p && p!=='.' && p!=='..'))
    assert.match(item.sha256 || '', SHA); assert.ok(!seen.has(item.path), 'duplicate artifact path'); seen.add(item.path)
  }
  assert.equal(receipt.inputs?.staged_manifest_git_head, expectedCommit)
  assert.equal(receipt.inputs?.packed_file_count, receipt.files.length)
  assert.match(receipt.inputs?.staged_manifest_sha256 || '', SHA)
  assert.equal(receipt.files.find(item=>item.path==='package.json')?.sha256, receipt.inputs.staged_manifest_sha256)
  assert.deepEqual(receipt.inputs.pack, await canonicalPackInputs(source), 'producer source or pack configuration changed')
  const p = receipt.producer
  assert.ok(p && typeof p === 'object')
  assert.match(p.node?.version || '', SEMVER); assert.match(p.node?.binary_sha256 || '', SHA)
  assert.match(p.npm?.version || '', SEMVER); assert.equal(p.npm?.entry, 'npm-cli.js')
  assert.match(p.npm?.entry_sha256 || '', SHA); assert.match(p.npm?.tree_sha256 || '', SHA)
  assert.ok(Number.isInteger(p.npm?.file_count) && p.npm.file_count > 0)
  assert.equal(p.packer, 'npm pack --ignore-scripts')
  assert.match(p.platform || '', /^(?:linux|darwin|win32)-(?:x64|arm64|ia32|arm)$/)
  return {receipt, receiptSha256}
}

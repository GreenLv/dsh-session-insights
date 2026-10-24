// Verify the real official app-boot consumer, rather than a semver facsimile.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile,realpath} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const root=resolve(process.argv[2] || '')
if(!process.argv[2])throw new Error('official DSH runtime root required')
const req=createRequire(join(root,'package.json'))
const hostReq=createRequire(await realpath(join(root,'node_modules/@deepseek-ai/dsh/package.json')))
const bootPath=hostReq.resolve('@deepseek-ai/dsh-app-boot')
const {evaluatePluginCompatibility,getDshRuntimeVersion}=await import(pathToFileURL(bootPath).href)
// The runtime's own published identity is read from its installed packages and
// compared against the caller-provided expectation, so a wrong or mixed
// runtime fails here instead of silently validating against the wrong host.
const runtimeVersion=getDshRuntimeVersion()
const expectedVersion=process.argv[3]
if(!expectedVersion)throw new Error('expected runtime version required (from HOST_TARGETS)')
assert.equal(runtimeVersion,expectedVersion,`actual runtime ${runtimeVersion} != expected ${expectedVersion}`)
// Optionally also prove the contract runtime tree resolves to the same version
// (its packages are read directly), so CI cannot mix a rc.3 host with a rc.2
// contract runtime or vice versa.
const runtimeFlagIndex=process.argv.indexOf('--runtime')
if(runtimeFlagIndex>=0){
  const runtimeRoot=resolve(process.argv[runtimeFlagIndex+1]||'')
  const {inspectRuntime}=await import(new URL('./acceptance_identity.mjs',import.meta.url).href)
  await inspectRuntime(runtimeRoot,expectedVersion)
}
const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
// Floor 0.2.1-rc.2, later RCs, stable, future minor/major and build metadata
// are admitted by the declared range. 0.2.0-rc.2 and 0.2.1-rc.1 are refused.
const admitted=['0.2.1-rc.2','0.2.1-rc.3','0.2.1','0.3.0-rc.1','0.3.0','1.0.0','0.2.1-rc.2+build.7']
for(const version of admitted)assert.equal(evaluatePluginCompatibility(manifest,{},version),undefined,version)
const belowFloor=['0.2.0-rc.1','0.2.0-rc.2','0.2.0','0.2.1-rc.1']
for(const version of belowFloor)assert.ok(evaluatePluginCompatibility(manifest,{},version),version)
for(const version of ['not-a-version','0.2'])assert.throws(()=>evaluatePluginCompatibility(manifest,{},version))
console.log(JSON.stringify({status:'pass',consumer:'official dsh-app-boot',consumer_version:runtimeVersion,expected_version:expectedVersion,admitted,rejected:['0.2.0-rc.1','0.2.0-rc.2','0.2.0','0.2.1-rc.1','not-a-version','0.2'],scope:'version admission with constructed metadata; future host execution not claimed'}))

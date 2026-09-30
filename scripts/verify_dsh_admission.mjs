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
assert.equal(getDshRuntimeVersion(),'0.2.0-rc.2')
const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
const admitted=['0.2.0-rc.2','0.2.0-rc.3','0.2.0','0.2.1-rc.1','0.3.0-rc.1','1.0.0','0.2.0-rc.2+build.7']
for(const version of admitted)assert.equal(evaluatePluginCompatibility(manifest,{},version),undefined,version)
assert.ok(evaluatePluginCompatibility(manifest,{},'0.2.0-rc.1'))
for(const version of ['not-a-version','0.2'])assert.throws(()=>evaluatePluginCompatibility(manifest,{},version))
console.log(JSON.stringify({status:'pass',consumer:'official dsh-app-boot',consumer_version:getDshRuntimeVersion(),admitted,rejected:['0.2.0-rc.1','not-a-version','0.2'],scope:'version admission with constructed metadata; future host execution not claimed'}))

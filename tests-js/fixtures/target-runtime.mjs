import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {after} from 'node:test'

export const runtime=resolve(process.env.DSH_RUNTIME || 'tests/dsh-runtime')
export const targetRequire=createRequire(join(runtime,'package.json'))

// Reject accidental resolution from the repository's root node_modules.
export function assertTargetPackage(name, from=targetRequire) {
  const relative=join('node_modules',...name.split('/'),'package.json')
  const expected=realpathSync(join(runtime,relative))
  const actual=realpathSync(from.resolve(name+'/package.json'))
  assert.equal(actual,expected,`${name} did not resolve from the selected runtime`)
  const version=JSON.parse(readFileSync(actual,'utf8')).version
  if(process.env.DSH_EXPECTED_VERSION)assert.equal(version,process.env.DSH_EXPECTED_VERSION,`${name} has the wrong target version`)
  return {actual,version}
}

export async function loadTargetPlugin() {
  const staged=mkdtempSync(join(runtime,'node_modules','.dsi-test-plugin-'))
  try {
    const stagedPlugin=join(staged,'plugin'),sourcePlugin=resolve('plugin')
    cpSync(sourcePlugin,stagedPlugin,{recursive:true})
    const dashboard='src/dsh_session_insights/assets/dashboard.html'
    mkdirSync(join(staged,'src/dsh_session_insights/assets'),{recursive:true})
    cpSync(resolve(dashboard),join(staged,dashboard))
    assert.deepEqual(readFileSync(join(staged,dashboard)),readFileSync(resolve(dashboard)))
    writeFileSync(join(staged,'package.json'),'{"type":"module"}\n')
    for(const file of readdirSync(join(sourcePlugin,'lib'))) {
      assert.deepEqual(readFileSync(join(stagedPlugin,'lib',file)),readFileSync(join(sourcePlugin,'lib',file)))
    }
    assertTargetPackage('@deepseek-ai/dsh-llm',createRequire(join(stagedPlugin,'lib/index.js')))
    const plugin=await import(pathToFileURL(join(stagedPlugin,'lib/index.js')).href)
    after(()=>rmSync(staged,{recursive:true,force:true}))
    return plugin
  } catch(error) {rmSync(staged,{recursive:true,force:true});throw error}
}

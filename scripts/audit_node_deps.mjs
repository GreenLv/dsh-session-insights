// A single-release exception, not a general advisory allowlist. Raw npm scan
// output and its actual exit status are retained even when this assessment passes.
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'

const ROOT=fileURLToPath(new URL('../',import.meta.url))
export const POLICY_PATH='config/dependency-audit-exceptions.json'
export const COHORT_PATHS=['package.json','package-lock.json','pyproject.toml','src/dsh_session_insights/__init__.py',
  'tests/dsh-runtime/package.json','tests/dsh-runtime/package-lock.json',
  'tests/dsh-runtime-rc3/package.json','tests/dsh-runtime-rc3/package-lock.json',
  'tests/dsh-host/package.json','tests/dsh-host/package-lock.json',
  'tests/dsh-host-rc3/package.json','tests/dsh-host-rc3/package-lock.json','scripts/acceptance_identity.mjs']
const WORKFLOW='.github/workflows/ci.yml'
const GHSA='GHSA-mrhx-c7xc-m3w5',CVE='CVE-2023-54404',ADVISORY_URL=`https://github.com/advisories/${GHSA}`
const LEVELS=['info','low','moderate','high','critical']
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'
  return JSON.stringify(value)
}
function requireThat(ok,message){if(!ok)throw new Error(message)}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function sameKeys(value,keys){return object(value)&&canonical(Object.keys(value).sort())===canonical([...keys].sort())}
function strings(value){return Array.isArray(value)&&value.every(x=>typeof x==='string')&&new Set(value).size===value.length}
export function hostQueueDigest(workflow){
  const jobs=String(workflow).split('\n  dsh-contract:\n')
  requireThat(jobs.length===2,'acceptance host job missing or ambiguous')
  const job=jobs[1].split(/\n  [A-Za-z][\w-]*:\n/)[0]
  const strategy=job.match(/    strategy:\n([\s\S]*?)    runs-on:/)
  requireThat(strategy,'acceptance host queue missing')
  return digest(strategy[1])
}
export function verifyCohort(policy,files){
  requireThat(policy?.schema==='dsi-node-audit-exception/v1','unknown exception policy')
  requireThat(policy.product_version==='0.6.1','exception only applies to product 0.6.1')
  requireThat(policy.authorization?.decision==='accepted'&&policy.authorization.recorded_on==='2026-10-26','maintainer decision missing')
  requireThat(policy.exception?.advisory===GHSA&&policy.exception.cve===CVE&&policy.exception.package==='zod'&&policy.exception.version==='4.4.3'&&policy.exception.range==='<4.6.6'&&policy.exception.severity==='high','exception identity differs from the sole accepted risk')
  requireThat(policy.expiry?.kind==='event_bound'&&policy.expiry.calendar_expiry===null&&policy.expiry.automatic_monitoring===false,'exception must have the authorized event-bound expiry')
  requireThat(sameKeys(policy.cohort?.files,COHORT_PATHS),'exception cohort file set changed')
  requireThat(sameKeys(files,[...COHORT_PATHS,WORKFLOW]),'source cohort incomplete')
  for(const path of COHORT_PATHS)requireThat(digest(files[path])===policy.cohort.files[path],`exception expired: cohort changed (${path})`)
  const queue=hostQueueDigest(files[WORKFLOW])
  requireThat(queue===policy.cohort.host_queue_sha256,'exception expired: acceptance host queue changed')
  const pkg=JSON.parse(files['package.json']),lock=JSON.parse(files['package-lock.json'])
  requireThat(pkg.name==='dsh-session-insights'&&pkg.version==='0.6.1'&&lock.version==='0.6.1'&&lock.packages?.['']?.version==='0.6.1','exception expired: project version changed')
  const project=String(files['pyproject.toml']).match(/\[project\]([\s\S]*?)(?=\n\[|$)/)?.[1]
  requireThat(project&&/^version\s*=\s*"0\.6\.1"\s*$/m.test(project)&&/__version__\s*=\s*["']0\.6\.1["']/.test(String(files['src/dsh_session_insights/__init__.py'])),'exception expired: Python product version changed')
  for(const [dir,version] of [['tests/dsh-runtime','0.2.1-rc.2'],['tests/dsh-runtime-rc3','0.2.1-rc.3'],['tests/dsh-host','0.2.1-rc.2'],['tests/dsh-host-rc3','0.2.1-rc.3']]){
    const manifest=JSON.parse(files[dir+'/package.json'])
    requireThat(Object.keys(manifest.dependencies??{}).length>0&&Object.values(manifest.dependencies).every(v=>v===version),'exception expired: host pins changed')
  }
  requireThat(lock.packages?.['node_modules/zod']?.version==='4.4.3','only locked zod 4.4.3 is accepted')
  return {lock,sha256:digest(canonical({files:policy.cohort.files,host_queue_sha256:queue}))}
}

// Every advisory chain must terminate at the sole known leaf. The reviewed
// 23-node graph is a DAG; cycles are not accepted, even with another leaf exit.
// The exact node/edge/path/range shape is additionally pinned below.
export function inspectReport(report,lock){
  requireThat(sameKeys(report,['auditReportVersion','vulnerabilities','metadata'])&&report.auditReportVersion===2,'npm audit report is malformed or reports an error')
  const rows=report.vulnerabilities,metadata=report.metadata
  requireThat(object(rows)&&Object.keys(rows).length>0&&Object.keys(rows).length<=256,'empty or oversized vulnerability report')
  requireThat(sameKeys(metadata,['vulnerabilities','dependencies'])&&sameKeys(metadata.vulnerabilities,[...LEVELS,'total'])&&object(metadata.dependencies),'npm audit metadata missing')
  requireThat(Object.values(metadata.dependencies).every(n=>Number.isSafeInteger(n)&&n>=0)&&metadata.dependencies.total>0,'empty or invalid dependency inventory')
  const counts=Object.fromEntries(LEVELS.map(k=>[k,0])),graph=[],resolved=new Set()
  let directLeaves=0
  for(const name of Object.keys(rows).sort()){
    const row=rows[name]
    requireThat(sameKeys(row,['name','severity','isDirect','via','effects','range','nodes','fixAvailable'])&&row.name===name&&row.severity==='high'&&typeof row.isDirect==='boolean'&&typeof row.range==='string','new or changed vulnerability severity/name/range')
    requireThat(typeof row.fixAvailable==='boolean'||(object(row.fixAvailable)&&typeof row.fixAvailable.isSemVerMajor==='boolean'),'invalid fix metadata')
    requireThat(strings(row.nodes)&&canonical(row.nodes)===canonical(['node_modules/'+name]),'vulnerability outside the reviewed root node paths')
    const installed=lock.packages?.[row.nodes[0]]
    requireThat(installed&&typeof installed.version==='string','vulnerability node not resolved by the root lock')
    requireThat(name==='zod'?installed.version==='4.4.3':name.startsWith('@deepseek-ai/dsh-')&&installed.version==='0.2.1-rc.2','package version outside the accepted dependency chain')
    requireThat(Array.isArray(row.via)&&row.via.length>0&&row.via.length<=256&&strings(row.effects),'empty or invalid advisory chain')
    const via=[]
    for(const edge of row.via){
      if(typeof edge==='string'){
        requireThat(Object.hasOwn(rows,edge),'unresolved advisory-chain reference')
        const dependencies={...installed.dependencies,...installed.peerDependencies,...installed.optionalDependencies}
        const target=rows[edge]
        requireThat(Array.isArray(target?.nodes)&&target.nodes.length===1&&dependencies[edge]===lock.packages?.[target.nodes[0]]?.version,'advisory edge differs from an exact locked dependency')
        via.push(edge)
      }else{
        requireThat(name==='zod'&&sameKeys(edge,['source','name','dependency','title','url','severity','cwe','cvss','range'])&&edge.name==='zod'&&edge.dependency==='zod'&&edge.url===ADVISORY_URL&&edge.severity==='high'&&edge.range==='<4.6.6'&&Number.isSafeInteger(edge.source)&&edge.source>0,'unaccepted direct advisory')
        requireThat(typeof edge.title==='string'&&edge.title.length>0&&strings(edge.cwe)&&object(edge.cvss)&&Number.isFinite(edge.cvss.score)&&edge.cvss.score>=0&&edge.cvss.score<=10,'malformed direct advisory metadata')
        directLeaves++;resolved.add(name)
        via.push({source:edge.source,name:edge.name,dependency:edge.dependency,url:edge.url,severity:edge.severity,range:edge.range})
      }
    }
    requireThat(new Set(via.map(canonical)).size===via.length,'duplicate advisory edges')
    graph.push({name,severity:row.severity,isDirect:row.isDirect,range:row.range,nodes:[...row.nodes].sort(),effects:[...row.effects].sort(),via:via.sort((a,b)=>canonical(a)<canonical(b)?-1:canonical(a)>canonical(b)?1:0)})
    counts[row.severity]++
  }
  requireThat(directLeaves===1&&resolved.has('zod'),'expected exactly one known zod advisory leaf')
  for(const name of Object.keys(rows)){
    const effects=Object.keys(rows).filter(other=>rows[other].via.includes(name)).sort()
    requireThat(canonical([...rows[name].effects].sort())===canonical(effects),'inconsistent advisory effects')
  }
  const state=new Map(),byName=new Map(graph.map(row=>[row.name,row]))
  function visit(name){
    requireThat(state.get(name)!=='visiting','cyclic advisory chain')
    if(state.get(name)==='done')return
    state.set(name,'visiting')
    for(const edge of byName.get(name).via)if(typeof edge==='string')visit(edge)
    state.set(name,'done')
  }
  for(const name of byName.keys())visit(name)
  for(const level of LEVELS)requireThat(metadata.vulnerabilities[level]===counts[level],`incorrect ${level} count`)
  requireThat(metadata.vulnerabilities.total===graph.length,'incorrect vulnerability total')
  return {sha256:digest(canonical(graph)),affected_packages:graph.length,advisories:1}
}

export function assessAudit({raw,exit_code,signal=null,error=null},policy,files){
  requireThat(!error&&!signal&&exit_code===1,'npm scanner failure or unexpected exit status')
  requireThat(typeof raw==='string'&&raw.trim().length>0&&Buffer.byteLength(raw)<=4*1024*1024,'empty or oversized scan output')
  const cohort=verifyCohort(policy,files),report=inspectReport(JSON.parse(raw),cohort.lock)
  requireThat(report.sha256===policy.report_graph_sha256,'vulnerability graph drifted from the exact reviewed cohort')
  return {status:'accepted_known_risk',advisory:GHSA,cve:CVE,package:'zod',version:'4.4.3',affected_packages:report.affected_packages,advisories:1,cohort_sha256:cohort.sha256,graph_sha256:report.sha256}
}
function context(root){return {policy:JSON.parse(readFileSync(join(root,POLICY_PATH),'utf8')),files:Object.fromEntries([...COHORT_PATHS,WORKFLOW].map(p=>[p,readFileSync(join(root,p))]))}}

export function captureAudit(scope,output,{root=ROOT,runner=spawnSync}={}){
  requireThat(['prod','full'].includes(scope),'unknown audit scope')
  mkdirSync(output,{recursive:true})
  const args=['audit',...(scope==='prod'?['--omit=dev']:[]),'--audit-level=high','--json']
  let captured
  try{captured=process.platform==='win32'
    ?runner(process.env.ComSpec||'cmd.exe',['/d','/s','/c','npm '+args.join(' ')],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})
    :runner('npm',args,{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})}
  catch(e){captured={status:null,error:{code:e.code??'SPAWN_ERROR'}}}
  const raw=captured.stdout??'',stderr=captured.stderr??''
  writeFileSync(join(output,'audit.json'),raw);writeFileSync(join(output,'stderr.log'),stderr)
  const scan={exit_code:captured.status??null,signal:captured.signal??null,error:captured.error?.code??null,raw_sha256:digest(raw),stderr_sha256:digest(stderr)}
  const result={schema:'dsi-node-audit-result/v1',scope,command:['npm',...args],scan,status:'failed'}
  try{const {policy,files}=context(root);result.assessment=assessAudit({raw,...scan},policy,files);result.status='accepted_known_risk'}catch(e){result.reason=e.message}
  writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n')
  return result
}

export function verifyResults(output,outcomes,{root=ROOT}={}){
  requireThat(sameKeys(outcomes,['prod','full','python'])&&Object.values(outcomes).every(v=>v==='success'),'required audit step missing, failed, skipped or cancelled')
  const {policy,files}=context(root),assessments=[]
  for(const scope of ['prod','full']){
    const dir=join(output,scope),result=JSON.parse(readFileSync(join(dir,'result.json'),'utf8')),raw=readFileSync(join(dir,'audit.json'),'utf8'),stderr=readFileSync(join(dir,'stderr.log'))
    requireThat(result.schema==='dsi-node-audit-result/v1'&&result.scope===scope&&result.status==='accepted_known_risk','required npm assessment missing or failed')
    requireThat(digest(raw)===result.scan.raw_sha256&&digest(stderr)===result.scan.stderr_sha256,'retained scan bytes changed')
    assessments.push(assessAudit({raw,...result.scan},policy,files))
  }
  requireThat(assessments[0].cohort_sha256===assessments[1].cohort_sha256,'audit input cohort changed between scans')
  return {schema:'dsi-required-dependency-audits/v1',status:'passed_with_known_upstream_risk',exception_fixed:false,scopes:['prod','full','python'],assessments}
}
function main(){
  const args=process.argv.slice(2)
  if(args.length===4&&args[0]==='--scope'&&args[2]==='--output'){
    const result=captureAudit(args[1],resolve(args[3]));console.log(JSON.stringify(result));return result.status==='accepted_known_risk'?0:1
  }
  if(args.length===2&&args[0]==='--verify-results'){
    const out=resolve(args[1]);mkdirSync(out,{recursive:true})
    try{const result=verifyResults(out,{prod:process.env.AUDIT_PROD_OUTCOME,full:process.env.AUDIT_FULL_OUTCOME,python:process.env.AUDIT_PYTHON_OUTCOME});writeFileSync(join(out,'summary.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));return 0}
    catch(e){writeFileSync(join(out,'summary.json'),JSON.stringify({status:'failed',reason:e.message})+'\n');console.error(e.message);return 1}
  }
  throw new Error('use --scope prod|full --output DIR, or --verify-results DIR')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{process.exitCode=main()}catch(e){console.error(e.message);process.exitCode=1}}

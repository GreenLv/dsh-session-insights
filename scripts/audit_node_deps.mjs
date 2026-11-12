// Dependency audit gate, bound per dependency tree. A clean scan passes only
// with a valid non-empty inventory. Findings fail unless the host tree matches
// the maintainer's new 0.8.1 manifest/lock, advisory set and reviewed report.
// The retired 0.8.0 Zod policy cannot authorize any current finding.
// Raw npm scan output and its actual exit status are retained either way.
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {HOST_TREES,PRODUCT_VERSION} from './acceptance_identity.mjs'

const ROOT=fileURLToPath(new URL('../',import.meta.url))
const WORKFLOW='.github/workflows/ci.yml'
export const HOST_RISK_POLICY_PATH='config/host-dependency-risk.json'
// Cohort of one candidate: root manifests plus the exact rc.2 acceptance
// trees' manifest/lock. The 0.8.0 cohort used rc.1 in these same paths; its
// exception policy is historical and cannot authorize this candidate.
export const COHORT_PATHS=['package.json','package-lock.json','pyproject.toml','src/dsh_session_insights/__init__.py',
  'scripts/acceptance_identity.mjs',
  ...Object.values(HOST_TREES).flatMap(t=>[t.runtime+'/package.json',t.runtime+'/package-lock.json',t.host+'/package.json',t.host+'/package-lock.json'])]
// Per-tree audit identities. Both trees are primary acceptance trees: each
// must scan clean or satisfy its explicitly scoped maintainer decision.
// No runtime/root finding can use the host-only decision.
export const TREE_AUDITS=Object.freeze(Object.entries(HOST_TREES).flatMap(([version,tree])=>[
  Object.freeze({label:'runtime',dir:tree.runtime,version}),
  Object.freeze({label:'host',dir:tree.host,version}),
]))
const treeByLabel=Object.fromEntries(TREE_AUDITS.map(t=>[t.label,t]))
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
const LEVELS=['info','low','moderate','high','critical']
// Shape-check a report enough to summarize unauthorized findings. This path
// never approves: it reports what npm found, with its raw exit intact.
function summarizeFindings(report){
  requireThat(object(report)&&report.auditReportVersion===2,'npm audit report is malformed or reports an error')
  const rows=report.vulnerabilities,metadata=report.metadata
  requireThat(object(metadata)&&sameKeys(metadata,['vulnerabilities','dependencies'])&&object(metadata.dependencies),'npm audit metadata missing')
  requireThat(Object.values(metadata.dependencies).every(n=>Number.isSafeInteger(n)&&n>=0)&&metadata.dependencies.total>0,'empty or invalid dependency inventory')
  requireThat(object(rows)&&Object.keys(rows).length>0,'exit 1 without a vulnerability report')
  const advisories=new Set()
  let highest='info'
  const rank=Object.fromEntries(LEVELS.map((l,i)=>[l,i]))
  for(const row of Object.values(rows)){
    requireThat(object(row)&&typeof row.severity==='string','malformed vulnerability entry')
    if(rank[row.severity]>rank[highest])highest=row.severity
    for(const edge of Array.isArray(row.via)?row.via:[])if(object(edge)&&typeof edge.url==='string')advisories.add(edge.url)
  }
  return {affected_packages:Object.keys(rows).length,direct_advisories:[...advisories].sort(),highest_severity:highest,counts:metadata.vulnerabilities}
}
function cleanAssessment(report){
  requireThat(object(report)&&report.auditReportVersion===2,'clean scan report is malformed')
  requireThat(object(report.vulnerabilities)&&Object.keys(report.vulnerabilities).length===0,'clean exit with vulnerability entries')
  const metadata=report.metadata
  requireThat(object(metadata)&&sameKeys(metadata,['vulnerabilities','dependencies'])&&sameKeys(metadata.vulnerabilities,[...LEVELS,'total'])&&object(metadata.dependencies),'clean scan metadata missing')
  requireThat(Object.values(metadata.dependencies).every(n=>Number.isSafeInteger(n)&&n>=0)&&metadata.dependencies.total>0,'empty or invalid dependency inventory')
  requireThat(LEVELS.every(l=>metadata.vulnerabilities[l]===0)&&metadata.vulnerabilities.total===0,'clean exit with nonzero vulnerability counts')
  return {status:'clean',affected_packages:0,advisories:0,dependencies:metadata.dependencies.total}
}
export function assessAudit({raw,exit_code,signal=null,error=null}){
  requireThat(!error&&!signal,'npm scanner failed or was terminated')
  requireThat((exit_code===0||exit_code===1),'npm scanner unexpected exit status')
  requireThat(typeof raw==='string'&&raw.trim().length>0&&Buffer.byteLength(raw)<=4*1024*1024,'empty or oversized scan output')
  const report=JSON.parse(raw)
  if(exit_code===0)return cleanAssessment(report)
  return {status:'unauthorized_findings',...summarizeFindings(report)}
}
// Tree-scope findings start unauthorized. Only the exact current host decision
// can change that assessment; root/runtime findings never use it.
export function assessTreeAudit(scan,{tree=null,riskPolicy=null,files=null}={}){
  const assessment=assessAudit(scan)
  if(assessment.status==='clean'||tree?.label!=='host'||!riskPolicy)return assessment
  try {
    const policy=JSON.parse(riskPolicy)
    requireThat(sameKeys(policy,['schema','product_version','host_version','authorization','manifest_sha256','lock_sha256','advisories','reviewed_report_sha256','expiry','note'])
      &&policy.schema==='dsi-host-risk-acceptance/v1','invalid host risk decision')
    requireThat(policy.product_version===PRODUCT_VERSION&&JSON.parse(files['package.json']).version===PRODUCT_VERSION
      &&policy.host_version===tree.version,'host risk decision expired: product or host changed')
    requireThat(policy.authorization?.decision==='accepted'&&/^\d{4}-\d{2}-\d{2}$/.test(policy.authorization.recorded_on)
      &&typeof policy.authorization.scope==='string'&&policy.authorization.scope.length>0,'host risk authorization missing')
    requireThat(policy.manifest_sha256===digest(files[tree.dir+'/package.json'])
      &&policy.lock_sha256===digest(files[tree.dir+'/package-lock.json']),'host risk decision expired: manifest or lock changed')
    requireThat(strings(policy.advisories)&&policy.advisories.length>0
      &&canonical([...policy.advisories].sort())===canonical(assessment.direct_advisories),'host advisory set differs from the accepted decision')
    const reportHash=digest(canonical(JSON.parse(scan.raw)))
    requireThat(strings(policy.reviewed_report_sha256)&&policy.reviewed_report_sha256.length>0
      &&policy.reviewed_report_sha256.every(hash=>/^[0-9a-f]{64}$/.test(hash))
      &&policy.reviewed_report_sha256.includes(reportHash),'host report differs from the reviewed reports')
    return {...assessment,status:'accepted_known_risk',policy_sha256:digest(riskPolicy),report_sha256:reportHash}
  } catch(error) {return {...assessment,reason:error.message}}
}
function context(root){return {files:Object.fromEntries([...COHORT_PATHS,WORKFLOW].map(p=>[p,readFileSync(join(root,p))])),
  riskPolicy:existsSync(join(root,HOST_RISK_POLICY_PATH))?readFileSync(join(root,HOST_RISK_POLICY_PATH),'utf8'):null}}
// Identity of the inputs a scan actually ran against. verifyResults refuses to
// summarize captures whose inputs drifted afterwards, so a clean scan of one
// tree can never endorse a different candidate.
function inputBinding(files){
  return {schema:'dsi-audit-input-binding/v1',
    cohort_sha256:digest(canonical(Object.fromEntries([...COHORT_PATHS,WORKFLOW].map(p=>[p,digest(files[p])])))),
    manifest_sha256:digest(files['package.json']),
    lock_sha256:digest(files['package-lock.json'])}
}
function treeInputBinding(tree,files){
  return {schema:'dsi-audit-tree-binding/v1',tree:tree.label,
    manifest_sha256:digest(files[tree.dir+'/package.json']),
    lock_sha256:digest(files[tree.dir+'/package-lock.json'])}
}
export function captureAudit(scope,output,{root=ROOT,runner=spawnSync,tree=null}={}){
  if(tree!==null&&!treeByLabel[tree])throw new Error('unknown audit tree: '+tree)
  const treeAudit=tree===null?null:treeByLabel[tree]
  requireThat(['prod','full','tree'].includes(scope),'unknown audit scope')
  requireThat(scope!=='tree'||treeAudit,'tree scope requires a --tree label')
  requireThat(scope==='tree'||treeAudit===null,'--tree only applies to the tree scope')
  mkdirSync(output,{recursive:true})
  const args=['audit',...(scope==='prod'?['--omit=dev']:[]),'--audit-level=high','--json']
  // Bind the audited inputs BEFORE the scan runs, then materialize exactly
  // those bytes into a private snapshot and point the scanner at it. npm
  // therefore provably consumes the bound input even when the source tree is
  // swapped underneath us (A→B→A): concurrent writers can only reach the
  // source, and any mutation of the snapshot itself is detected below.
  const before=context(root)
  const binding=treeAudit?treeInputBinding(treeAudit,before.files):inputBinding(before.files)
  const manifestKey=treeAudit?treeAudit.dir+'/package.json':'package.json'
  const lockKey=treeAudit?treeAudit.dir+'/package-lock.json':'package-lock.json'
  const scanRoot=mkdtempSync(join(output,'scan-root-'))
  let captured
  const result={schema:'dsi-node-audit-result/v1',scope,tree:treeAudit?.label??null,command:['npm',...args],status:'failed'}
  try{
    result.input_binding=binding
    writeFileSync(join(scanRoot,'package.json'),before.files[manifestKey])
    writeFileSync(join(scanRoot,'package-lock.json'),before.files[lockKey])
    try{captured=process.platform==='win32'
      ?runner(process.env.ComSpec||'cmd.exe',['/d','/s','/c','npm '+args.join(' ')],{cwd:scanRoot,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})
      :runner('npm',args,{cwd:scanRoot,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})}
    catch(e){captured={status:null,error:{code:e.code??'SPAWN_ERROR'}}}
    const raw=captured.stdout??'',stderr=captured.stderr??''
    writeFileSync(join(output,'audit.json'),raw);writeFileSync(join(output,'stderr.log'),stderr)
    const scan={exit_code:captured.status??null,signal:captured.signal??null,error:captured.error?.code??null,raw_sha256:digest(raw),stderr_sha256:digest(stderr)}
    result.scan=scan
    // The snapshot must still be the bound bytes when the scanner returns.
    const snapshotUnchanged=digest(readFileSync(join(scanRoot,'package.json')))===binding.manifest_sha256
      &&digest(readFileSync(join(scanRoot,'package-lock.json')))===binding.lock_sha256
    requireThat(snapshotUnchanged,
      'audit input changed while the scanner ran; the retained output cannot be attributed to the bound input')
    result.assessment=treeAudit
      ?assessTreeAudit({raw,...scan},{tree:treeAudit,riskPolicy:before.riskPolicy,files:before.files})
      :assessAudit({raw,...scan})
    result.status=result.assessment.status
  }catch(e){result.reason=e.message}
  finally{
    // A snapshot that cannot be removed is a failed capture: the resource must
    // not outlive the receipt silently.
    try{rmSync(scanRoot,{recursive:true,force:true})}
    catch(e){result.status='failed';result.reason=(result.reason?result.reason+'; ':'')+'scan snapshot cleanup failed: '+e.message}
  }
  writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n')
  return result
}
const PASSING=['clean','accepted_known_risk']
export function verifyResults(output,outcomes,{root=ROOT}={}){
  const requiredScopes=['prod','full','python',...TREE_AUDITS.map(t=>t.label)]
  requireThat(sameKeys(outcomes,requiredScopes)&&Object.values(outcomes).every(v=>v==='success'),'required audit step missing, failed, skipped or cancelled')
  const {files,riskPolicy}=context(root)
  const current=inputBinding(files)
  const assessments=[],bindings=[]
  for(const scope of ['prod','full']){
    const dir=join(output,scope),result=JSON.parse(readFileSync(join(dir,'result.json'),'utf8')),raw=readFileSync(join(dir,'audit.json'),'utf8'),stderr=readFileSync(join(dir,'stderr.log'))
    requireThat(result.schema==='dsi-node-audit-result/v1'&&result.scope===scope&&result.status==='clean','required npm assessment missing or failed')
    requireThat(digest(raw)===result.scan.raw_sha256&&digest(stderr)===result.scan.stderr_sha256,'retained scan bytes changed')
    // The summarized input must be the captured input: reject drift between
    // capture and summary, and inputs that differ between the two scopes.
    requireThat(object(result.input_binding)
      &&result.input_binding.schema==='dsi-audit-input-binding/v1'
      &&sameKeys(result.input_binding,['schema','cohort_sha256','manifest_sha256','lock_sha256']),
      'capture predates input binding; recapture against the current inputs')
    bindings.push(result.input_binding)
    assessments.push(assessAudit({raw,...result.scan}))
    requireThat(assessments[assessments.length-1].status==='clean','re-assessed scan no longer passes')
  }
  // The two scopes must describe one captured input before either is compared
  // with the tree being summarized.
  requireThat(canonical(bindings[0])===canonical(bindings[1]),'audit scopes captured different inputs')
  requireThat(canonical(bindings[0])===canonical(current),'audit input drifted after capture; the retained scan no longer describes the current candidate')
  // Per-tree assessments: every acceptance tree must have a completed capture
  // bound to its CURRENT bytes and must scan clean or match the explicit
  // current host decision. Capture failures cannot inherit acceptance.
  const treeAssessments=[]
  for(const tree of TREE_AUDITS){
    const dir=join(output,'tree',tree.label)
    const result=JSON.parse(readFileSync(join(dir,'result.json'),'utf8')),raw=readFileSync(join(dir,'audit.json'),'utf8'),stderr=readFileSync(join(dir,'stderr.log'))
    requireThat(result.schema==='dsi-node-audit-result/v1'&&result.scope==='tree'&&result.tree===tree.label,'tree audit capture missing or misattributed: '+tree.label)
    requireThat(digest(raw)===result.scan.raw_sha256&&digest(stderr)===result.scan.stderr_sha256,'retained tree scan bytes changed: '+tree.label)
    requireThat(object(result.input_binding)
      &&result.input_binding.schema==='dsi-audit-tree-binding/v1'
      &&sameKeys(result.input_binding,['schema','tree','manifest_sha256','lock_sha256']),
      'tree capture predates binding; recapture: '+tree.label)
    requireThat(canonical(result.input_binding)===canonical(treeInputBinding(tree,files)),'tree audit input drifted after capture: '+tree.label)
    const assessment=assessTreeAudit({raw,...result.scan},{tree,riskPolicy,files})
    // Reassessing clean scanner bytes cannot erase a capture failure, such
    // as a snapshot that could not be removed after that successful scan.
    requireThat(result.status===assessment.status,'tree audit capture status conflicts with reassessment: '+tree.label)
    requireThat(PASSING.includes(assessment.status),'tree audit must scan clean or match its explicit decision: '+tree.label+' ('+assessment.status+')')
    requireThat(canonical(result.assessment)===canonical(assessment),'tree audit decision changed after capture: '+tree.label)
    treeAssessments.push({tree:tree.label,version:tree.version,...assessment})
  }
  return {schema:'dsi-required-dependency-audits/v2',status:treeAssessments.some(t=>t.status==='accepted_known_risk')?'passed_with_known_host_risk':'passed',exception_fixed:true,
    scopes:requiredScopes,input_cohort_sha256:current.cohort_sha256,assessments,trees:treeAssessments}
}
function main(){
  const args=process.argv.slice(2)
  if(args.length===4&&args[0]==='--scope'&&args[2]==='--output'&&args[1]!=='tree'){
    const result=captureAudit(args[1],resolve(args[3]));console.log(JSON.stringify(result));return PASSING.includes(result.status)?0:1
  }
  if(args.length===6&&args[0]==='--scope'&&args[1]==='tree'&&args[2]==='--tree'&&args[4]==='--output'){
    const result=captureAudit('tree',resolve(args[5]),{tree:args[3]});console.log(JSON.stringify(result));return PASSING.includes(result.status)?0:1
  }
  if(args.length===2&&args[0]==='--verify-results'){
    const out=resolve(args[1]);mkdirSync(out,{recursive:true})
    const outcomes={prod:process.env.AUDIT_PROD_OUTCOME,full:process.env.AUDIT_FULL_OUTCOME,python:process.env.AUDIT_PYTHON_OUTCOME}
    for(const tree of TREE_AUDITS)outcomes[tree.label]=process.env[`AUDIT_${tree.label.replaceAll(/[^A-Za-z0-9]/g,'_').toUpperCase()}_OUTCOME`]
    try{const result=verifyResults(out,outcomes);writeFileSync(join(out,'summary.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));return 0}
    catch(e){writeFileSync(join(out,'summary.json'),JSON.stringify({status:'failed',reason:e.message})+'\n');console.error(e.message);return 1}
  }
  throw new Error('use --scope prod|full --output DIR, --scope tree --tree LABEL --output DIR, or --verify-results DIR')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{process.exitCode=main()}catch(e){console.error(e.message);process.exitCode=1}}

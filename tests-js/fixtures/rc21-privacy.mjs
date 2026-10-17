import {readFileSync} from 'node:fs'
const read = name => JSON.parse(readFileSync(new URL(`../../tests/fixtures/rc21/${name}/snapshot.json`, import.meta.url),'utf8'))
export const privacyValues = [
  {name:'custom', value:'custom-extension', sensitive:false},
  {name:'posix', value:'/synthetic/private/free-category', sensitive:true},
  {name:'drive', value:'C:\\synthetic\\private\\free-category', sensitive:true},
  {name:'unc', value:'\\\\synthetic-server\\share\\free-category', sensitive:true},
  {name:'named', value:'api_key'+'=synthetic-category-secret', sensitive:true, forbidden:'synthetic-category-secret'},
  {name:'bearer', value:'Bearer '+'synthetic-category-secret', sensitive:true, forbidden:'synthetic-category-secret'},
  {name:'known', value:'sk-'+'synthetic_category_secret_123456', sensitive:true, forbidden:'synthetic_category_secret_123456'},
]
export function privacySnapshot(value) {
  const snapshot=read('job-lifecycle')
  for(const event of snapshot.events) if(event.type.startsWith('job/')) {
    event.data.kind=value
    event.data.label=value
  }
  const add = event => snapshot.events.push({...structuredClone(event),seq:snapshot.events.length})
  const member=read('team').events.find(event=>event.type==='team/member')
  member.data.member.phase=value; add(member)
  const task=read('team').events.find(event=>event.type==='team/task')
  task.data.task.status=value; add(task)
  const descriptor=read('subagent-child').events.find(event=>event.type==='subagent/descriptor')
  Object.assign(descriptor.data,{mode:value,provider:value,agentProvider:value,agentModel:value}); add(descriptor)
  const selection=read('web-model').events.find(event=>event.type==='model/selection')
  Object.assign(selection.data,{provider:value,model:value,reasoningEffort:value}); add(selection)
  add({type:'plugin:'+value,time:snapshot.session.createdAt,data:{},ignorable:true})
  return snapshot
}
export function renderMemory(report, renderReport) {
  const files=new Map()
  renderReport({write:(_run,name,value)=>files.set(name,value),path:(_run,name)=>name},'synthetic',report)
  return files.get('report.html')
}

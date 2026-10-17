import {readFileSync} from 'node:fs'
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url),'utf8'))
export const cwdLabelVectors=read('../../tests/fixtures/rc21-cwd-label-vectors.json')
export function cwdLabelSnapshot(vector, context) {
 const base=read('../../tests/fixtures/rc21/job-lifecycle/snapshot.json')
 const cwd=vector.cwd_parts.join('')
 const snapshot={session:{...base.session,id:`synthetic-cwd-${vector.name}`,isSeeded:true},events:[],inheritedEventCount:0}
 const add=(type,data)=>snapshot.events.push({type,seq:snapshot.events.length,time:base.session.createdAt,data})
 if(context==='origin') snapshot.session.cwd=cwd
 if(context==='inherited'||context==='inherited-own') {add('working-directory/change',{cwd});snapshot.inheritedEventCount=1}
 add('session/end-seed',{inherited:true})
 if(context==='own') add('working-directory/change',{cwd})
 if(context==='inherited-own') add('working-directory/change',{cwd:'/synthetic/after-cut'})
 return snapshot
}
export function expectedDirectoryLabels(vector, context) {
 const trajectory=context==='origin'?[vector.label]:['project-a',vector.label]
 if(context==='inherited-own')trajectory.push('after-cut')
 return {trajectory,origin_label:context==='origin'?vector.label:'project-a',effective_at_cut:context==='own'?'project-a':vector.label}
}

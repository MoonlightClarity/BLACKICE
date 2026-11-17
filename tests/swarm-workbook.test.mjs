import test from 'node:test';
import assert from 'node:assert/strict';
import {organizationOf,folderPath,taskFolder,inFolder,workbookRows,evidenceSummary,runtimeSummary} from '../public/next/workspaces/swarm-workbook.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createSwarmWorkspace} from '../public/next/workspaces/swarm.mjs';
const org={revision:1,folders:[{id:'research',name:'Research',parentId:null},{id:'europe',name:'Europe',parentId:'research'}],projectFolders:{a:'research',b:'europe'},itemFolders:{'b/other':null}};
const item=(id,phase='queued')=>({id,title:id,scope:'Work',phase,ownerId:null,dependsOn:[],requirementRevision:1,revision:1,requirements:'Evidence of outcome',verificationTarget:'integration',readiness:'not_ready',proof:{assessment:'unknown'},applicableEvidence:[],staleEvidence:[],unresolvedFailures:[],phaseHistory:[],integration:{status:'not_started'}});
const project=(id)=>({id,name:'Flow '+id,objective:'Independent work',revision:1,workers:[],items:[item('task-'+id),item('other','proposed')],sources:[],summary:{total:2,ready:0,blocked:0}});
const data={organization:org,projects:[project('a'),project('b')]};
test('folders include concurrent workflow tasks without flattening identities or proof',()=>{
 const before=JSON.stringify(data),rows=workbookRows(data,{folder:'research'});
 assert.equal(rows.length,3);assert.deepEqual(new Set(rows.map(r=>r.project.id)),new Set(['a','b']));
 assert.equal(JSON.stringify(data),before);assert.equal(workbookRows(data,{folder:':unfiled'}).length,1);
 assert.equal(folderPath(org,'europe'),'Research / Europe');assert.equal(taskFolder(org,data.projects[1],data.projects[1].items[1]),null);
});
test('folder and workflow filters intersect, status changes never inferred',()=>{
 assert.equal(workbookRows(data,{folder:'europe',projectId:'a'}).length,0);
 assert.equal(workbookRows(data,{phase:'queued'}).length,2);
 assert.equal(workbookRows(data,{query:'FLOW B'}).length,2);
 assert.equal(inFolder(org,'europe','research'),true);
});
test('unknown and inference never become observed; failed and stale records stay visible',()=>{
 const row=item('a');assert.equal(evidenceSummary(row).label,'Unknown');
 row.applicableEvidence=[{epistemic:'inferred',outcome:'pass'}];assert.equal(evidenceSummary(row).label,'Inferred');
 row.applicableEvidence.push({epistemic:'observed',outcome:'pass'});assert.equal(evidenceSummary(row).label,'Observed (reported)');
 row.unresolvedFailures=['bad'];assert.equal(evidenceSummary(row).state,'contradicted');row.staleEvidence=[{}];assert.equal(evidenceSummary(row).state,'contradicted');
 row.unresolvedFailures=[];assert.equal(evidenceSummary(row).state,'observed');row.applicableEvidence=[];assert.equal(evidenceSummary(row).state,'stale');
});
test('launch authorization is not mislabeled as a running worker',()=>{
 const row=item('a');assert.equal(runtimeSummary(row),'No launch recorded');
 row.nativeLaunch={state:'provider_attempted',applicable:true};assert.equal(runtimeSummary(row),'Dispatch authorized');
 row.nativeLaunch={state:'settled',applicable:true,result:{status:'completed'}};assert.equal(runtimeSummary(row),'Runtime completed');
 row.nativeLaunch.applicable=false;assert.equal(runtimeSummary(row),'Previous launch stale');
});
test('legacy organization defaults to unfiled without rewriting records',()=>{
 const legacy={projects:[project('a')]};assert.equal(organizationOf(legacy).revision,0);assert.equal(workbookRows(legacy,{folder:':unfiled'}).length,2);assert.equal(legacy.organization,undefined);
});
test('whole workspace shows simultaneous workflows, folder nesting and focused detail tabs',async t=>{
 const f=planningDOM(t),writes=[];const proto=Object.getPrototypeOf(f.mount),oldScroll=proto.scrollIntoView;proto.scrollIntoView=()=>{};t.after(()=>{if(oldScroll)proto.scrollIntoView=oldScroll;else delete proto.scrollIntoView;});
 const view=createSwarmWorkspace({mount:f.mount,api:async(route,method='GET',body)=>{if(method!=='GET')writes.push(body);return structuredClone(data);},events:{subscribe:()=>()=>{}}});
 t.after(()=>view.destroy());view.enter();await new Promise(r=>setImmediate(r));
 assert.equal(f.mount.querySelectorAll('.swarm-sheet tbody tr').length,4);
 assert.equal(f.mount.querySelectorAll('.swarm-folder-icon').length,4);
 await f.click('.swarm-folder-select[data-folder-id="research"]');
 assert.equal(f.mount.querySelectorAll('.swarm-sheet tbody tr').length,3);
 await f.click('.swarm-task-link');
 assert.equal([...f.mount.querySelectorAll('.swarm-detail-page')].filter(n=>!n.hidden).length,1);
 assert.equal(f.mount.querySelector('[data-detail-tab="overview"]').hidden,false);
 await f.click('.swarm-detail-tabs button[data-section="evidence"]');
 assert.equal(f.mount.querySelector('[data-detail-tab="overview"]').hidden,true);
 assert.equal(f.mount.querySelector('[data-detail-tab="evidence"]').hidden,false);
 assert.equal(writes.length,0,'navigation never dispatches or changes data');
 await f.click('.swarm-back');
 assert.equal(f.mount.querySelectorAll('.swarm-sheet tbody tr').length,3);
});


test('uncertain folder create retries the same identity and revision after refresh',async t=>{
 const f=planningDOM(t),current=structuredClone(data),writes=[];const proto=Object.getPrototypeOf(f.mount),oldInsert=proto.insertAdjacentElement;proto.insertAdjacentElement=function(_where,node){this.parentElement.append(node);};t.after(()=>{if(oldInsert)proto.insertAdjacentElement=oldInsert;else delete proto.insertAdjacentElement;});
 const view=createSwarmWorkspace({mount:f.mount,api:async(route,method='GET',body)=>{
  if(method==='GET')return structuredClone(current);
  writes.push(structuredClone(body));
  if(writes.length===1){current.organization.folders.push({id:body.value.id,name:body.value.name,parentId:body.value.parentId});current.organization.revision++;throw Error('Response lost after saving');}
  return {organization:structuredClone(current.organization),duplicate:true};
 },events:{subscribe:()=>()=>{}}});t.after(()=>view.destroy());
 const tick=()=>new Promise(r=>setImmediate(r));view.enter();await tick();
 await f.input('.swarm-folder-tools input','Saved once');
 await f.$('.swarm-folder-tools form').dispatch('submit');await tick();await tick();
 assert.equal(writes.length,1);
 view.leave();view.enter();await tick();await tick();
 assert.equal(f.$('.swarm-folder-tools input').value,'Saved once');
 await f.$('.swarm-folder-tools form').dispatch('submit');await tick();await tick();
 assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);
 assert.equal(current.organization.folders.filter(x=>x.name==='Saved once').length,1);
});
test('transient task search stays synchronized across folder navigation',async t=>{
 const f=planningDOM(t);const view=createSwarmWorkspace({mount:f.mount,api:async()=>structuredClone(data),events:{subscribe:()=>()=>{}}});t.after(()=>view.destroy());
 view.enter();await new Promise(r=>setImmediate(r));await f.input('.swarm-sheet-query','task-a');
 assert.equal(f.mount.querySelectorAll('.swarm-sheet tbody tr').length,1);
 await f.click('.swarm-folder-select[data-folder-id="research"]');
 assert.equal(f.$('.swarm-sheet-query').value,'task-a');
 assert.equal(f.mount.querySelectorAll('.swarm-sheet tbody tr').length,1);
});

test('active workspace with only archived projects offers exactly one creation form',async t=>{
 const f=planningDOM(t),current=structuredClone(data);current.projects.forEach(p=>p.lifecycle='archived');
 const view=createSwarmWorkspace({mount:f.mount,api:async()=>current,events:{subscribe:()=>()=>{}}});t.after(()=>view.destroy());
 view.enter();await new Promise(r=>setImmediate(r));
 assert.ok(f.$('.swarm-empty'));assert.equal(f.mount.querySelectorAll('.swarm-rail .swarm-create-project').length,0);
 assert.equal([...f.mount.querySelectorAll('button')].filter(x=>x.textContent==='Create project').length,1);
});
test('rejected folder revision can be discarded and retried at current revision',async t=>{
 const f=planningDOM(t),current=structuredClone(data),writes=[];
 const proto=Object.getPrototypeOf(f.mount),oldInsert=proto.insertAdjacentElement;proto.insertAdjacentElement=function(_where,node){this.parentElement.append(node);};t.after(()=>{if(oldInsert)proto.insertAdjacentElement=oldInsert;else delete proto.insertAdjacentElement;});
 const view=createSwarmWorkspace({mount:f.mount,api:async(route,method='GET',body)=>{
 if(method==='GET')return structuredClone(current);writes.push(structuredClone(body));
 if(writes.length===1){current.organization.revision++;throw Object.assign(Error('Folders changed'),{status:409,code:'SWARM_REVISION_CONFLICT'});}
 return {organization:structuredClone(current.organization)};
 },events:{subscribe:()=>()=>{}}});t.after(()=>view.destroy());const tick=()=>new Promise(r=>setImmediate(r));
 view.enter();await tick();await f.input('.swarm-folder-tools input','Same name');await f.$('.swarm-folder-tools form').dispatch('submit');await tick();await tick();
 view.leave();view.enter();await tick();await tick();
 const discard=[...f.mount.querySelectorAll('button')].find(x=>x.textContent==='Discard folder draft and reload');assert.ok(discard);await discard.dispatch('click');
 await f.input('.swarm-folder-tools input','Same name');await f.$('.swarm-folder-tools form').dispatch('submit');await tick();await tick();
 assert.equal(writes.length,2);assert.equal(writes[1].expectedOrganizationRevision,current.organization.revision);assert.notEqual(writes[0].mutationId,writes[1].mutationId);
});

test('valid all and unfiled folder IDs do not collide with navigation views',()=>{const current=structuredClone(data);current.organization.folders.push({id:'all',name:'Actual all',parentId:null},{id:'unfiled',name:'Actual unfiled',parentId:null});current.organization.projectFolders.a='all';current.organization.projectFolders.b='unfiled';current.organization.itemFolders={};assert.equal(workbookRows(current,{folder:'all'}).length,2);assert.equal(workbookRows(current,{folder:'unfiled'}).length,2);assert.equal(workbookRows(current,{folder:':all'}).length,4);assert.equal(workbookRows(current,{folder:':unfiled'}).length,0);});

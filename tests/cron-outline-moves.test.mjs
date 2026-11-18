import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createScheduleFolders} from '../public/next/workspaces/schedule-folders.mjs';
import {changeScheduleOrganization} from '../lib/schedule-organization.mjs';
const settle=async()=>{for(let n=0;n<8;n++)await new Promise(resolve=>setImmediate(resolve));};
async function fixture(t,{compact=false}={}){
 const dom=planningDOM(t),manager=dom.element('div'),list=dom.element('div');dom.mount.append(manager,list);
 let organization={revision:1,folders:[{id:'a',name:'Alpha',parentId:null},{id:'b',name:'Beta',parentId:null}],assignments:{job:'a'}},fail=false;
 const calls=[],jobs=[{id:'job',name:'Saved job'}];
 const api=async(route,method,body)=>{calls.push({route,method,body});if(fail)throw Object.assign(Error('Concurrent organization edit'),{status:409});organization=changeScheduleOrganization(organization,body,{id:'test-folder-'+organization.revision,deploymentIds:['job']});return organization;};
 const component=createScheduleFolders({mount:manager,compact,api,notify(){},refresh:async()=>render()});
 function render(){list.replaceChildren();const groups=component.group(list,jobs,organization);const row=dom.element('details'),summary=dom.element('summary');summary.textContent='Saved job';row.append(summary);groups.target(jobs[0]).append(row);groups.outlineControl(row,jobs[0]);row.dataset.scheduleId='job';}
 render();
 const folder=id=>list.querySelector('[data-schedule-folder="'+id+'"]').querySelector('summary'),job=()=>list.querySelector('[data-schedule-id="job"]').querySelector('summary');
 async function drag(from,to){const dataTransfer={setData(){}};await from.dispatch('dragstart',{dataTransfer});await to.dispatch('drop',{dataTransfer});await settle();}
 return{manager,refresh:render,advance(){organization={...organization,revision:organization.revision+1};render();},component,calls,folder,job,drag,state:()=>organization,fail(){fail=true;},list};
}
test('outline moves schedules and nested folders through CAS without changing jobs',async t=>{
 const f=await fixture(t);await f.drag(f.job(),f.folder('b'));assert.equal(f.state().assignments.job,'b');assert.equal(document.activeElement,f.job());assert.equal(f.calls[0].body.expectedRevision,1);
 await f.folder('b').dispatch('keydown',{key:'Enter',ctrlKey:true});await settle();assert.equal(f.state().folders.find(row=>row.id==='b').parentId,'a');
 await f.job().dispatch('keydown',{key:'Enter',ctrlKey:true,shiftKey:true});await settle();assert.equal(f.state().assignments.job,'a');
 await f.job().dispatch('keydown',{key:'Enter',ctrlKey:true});await settle();assert.equal(f.state().assignments.job,'b');
 const before=f.calls.length;await f.drag(f.folder('a'),f.folder('b'));assert.equal(f.calls.length,before,'cycle blocked without request');
 assert.ok(f.calls.every(call=>call.route==='/api/operations/folders'&&call.method==='POST'));
});
test('external drops, leave and conflict cannot silently reapply a move',async t=>{
 const f=await fixture(t);await f.folder('b').dispatch('drop',{dataTransfer:{getData:()=>'{"kind":"schedule","id":"job"}'}});assert.equal(f.calls.length,0);
 await f.job().dispatch('dragstart',{dataTransfer:{setData(){}}});f.component.leave();await f.folder('b').dispatch('drop',{});assert.equal(f.calls.length,0);
 f.fail();await f.drag(f.job(),f.folder('b'));assert.equal(f.calls.length,1);assert.equal(f.state().assignments.job,'a');
 await settle();assert.equal(f.calls.length,1,'conflict refresh never replays mutation');
});

test('folder names edit inline without toggling, moving or running schedules',async t=>{
 const f=await fixture(t);let summary=f.folder('a'),label=summary.querySelector('.next-schedule-folder-name'),input=summary.querySelector('input');
 await label.dispatch('click',{});assert.equal(input.hidden,false);assert.equal(document.activeElement,input);
 input.value='Changed';await input.dispatch('input',{});await input.dispatch('keydown',{key:'Escape'});assert.equal(f.calls.length,0);assert.equal(input.hidden,true);
 await label.dispatch('click',{});input.value='Renamed';await input.dispatch('input',{});await input.dispatch('keydown',{key:'Enter'});await settle();
 assert.equal(f.state().folders.find(row=>row.id==='a').name,'Renamed');assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.action,'update');assert.equal(f.calls[0].body.parentId,null);
 summary=f.folder('a');label=summary.querySelector('.next-schedule-folder-name');input=summary.querySelector('input');await label.dispatch('click',{});input.value='';await input.dispatch('keydown',{key:'Enter'});assert.equal(f.calls.length,1);
});

test('inline rename preserves edit-start revision across refresh',async t=>{
 const f=await fixture(t);await f.folder('a').querySelector('.next-schedule-folder-name').dispatch('click',{});let input=f.folder('a').querySelector('input');input.value='My draft';await input.dispatch('input',{});f.advance();input=f.folder('a').querySelector('input');assert.equal(input.value,'My draft');assert.equal(input.hidden,false);f.fail();await input.dispatch('keydown',{key:'Enter'});await settle();assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.expectedRevision,1);assert.equal(f.state().folders.find(row=>row.id==='a').name,'Alpha');assert.equal(f.folder('a').querySelector('input').value,'My draft');
});

test('compact outline creates folders directly without editing or filing dropdowns',async t=>{
 const f=await fixture(t,{compact:true});assert.equal(f.manager.querySelector('select'),null);
 await f.folder('a').querySelector('.next-schedule-folder-add').dispatch('click',{});
 const form=f.manager.querySelector('form'),input=form.querySelector('input');input.value='Inside Alpha';await form.dispatch('submit',{});await settle();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.action,'create');assert.equal(f.calls[0].body.parentId,'a');assert.equal(f.calls[0].body.expectedRevision,1);
 assert.ok(f.state().folders.some(folder=>folder.name==='Inside Alpha'&&folder.parentId==='a'));assert.equal(f.state().assignments.job,'a');
 await f.manager.querySelector('summary').dispatch('click',{});input.value='Root';await form.dispatch('submit',{});await settle();assert.equal(f.calls[1].body.parentId,null);
});
test('compact create conflict retains draft and does not replay or rebase silently',async t=>{
 const f=await fixture(t,{compact:true});await f.folder('a').querySelector('.next-schedule-folder-add').dispatch('click',{});
 const form=f.manager.querySelector('form'),input=form.querySelector('input');input.value='Unsent child';f.advance();f.fail();await form.dispatch('submit',{});await settle();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.expectedRevision,1);assert.equal(input.value,'Unsent child');assert.equal(f.calls[0].body.parentId,'a');
});
test('compact row navigation skips collapsed descendants and leaves inputs alone',async t=>{
 const f=await fixture(t,{compact:true});f.folder('a').parentElement.open=false;
 await f.folder('a').dispatch('keydown',{key:'ArrowDown'});assert.equal(document.activeElement,f.folder('b'));
 await f.folder('b').dispatch('keydown',{key:'Home'});assert.equal(document.activeElement,f.folder('a'));
 await f.folder('a').dispatch('keydown',{key:'ArrowRight'});assert.equal(f.folder('a').parentElement.open,true);
 await f.folder('a').dispatch('keydown',{key:'ArrowDown'});assert.equal(document.activeElement,f.job());assert.equal(f.calls.length,0);
 const input=f.folder('a').querySelector('input');input.hidden=false;await input.dispatch('keydown',{key:'ArrowDown'},true);assert.equal(f.calls.length,0);
});

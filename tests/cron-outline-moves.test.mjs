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
 return{mount:dom.mount,manager,refresh:render,advance(){organization={...organization,revision:organization.revision+1};render();},removeExternally(id){organization={...organization,revision:organization.revision+1,folders:organization.folders.filter(row=>row.id!==id)};render();},replace(value){organization=structuredClone(value);render();},component,calls,folder,job,drag,state:()=>organization,fail(){fail=true;},list};
}
test('outline moves schedules and nested folders through CAS without changing jobs',async t=>{
 const f=await fixture(t);await f.drag(f.job(),f.folder('b'));assert.equal(f.state().assignments.job,'b');assert.equal(document.activeElement,f.job());assert.equal(f.calls[0].body.expectedRevision,1);
 await f.folder('b').dispatch('keydown',{key:'Enter',ctrlKey:true});await settle();assert.equal(f.state().folders.find(row=>row.id==='b').parentId,'a');
 await f.job().dispatch('keydown',{key:'Enter',ctrlKey:true,shiftKey:true});await settle();assert.equal(f.state().assignments.job,'a');
 await f.job().dispatch('keydown',{key:'Enter',ctrlKey:true});await settle();assert.equal(f.state().assignments.job,'b');
 const before=f.calls.length;await f.drag(f.folder('a'),f.folder('b'));assert.equal(f.calls.length,before,'cycle blocked without request');
 assert.ok(f.calls.every(call=>call.route==='/api/operations/folders'&&call.method==='POST'));
});
test('Unfiled is a collapsible immutable folder and a live drag destination',async t=>{
 const f=await fixture(t,{compact:true}),unfiled=()=>f.list.querySelector('[data-schedule-unfiled]');
 let root=unfiled(),heading=root.querySelector('summary');
 assert.equal(root.tagName,'DETAILS');assert.ok(root.classList.contains('next-schedule-folder-branch'));
 assert.equal(heading.textContent,'Unfiled');assert.notEqual(heading.draggable,true);
 assert.equal(heading.querySelector('button'),null);assert.equal(heading.querySelector('input'),null);
 await heading.dispatch('keydown',{key:'F2'});assert.equal(f.calls.length,0);
 root.open=false;await root.dispatch('toggle');f.refresh();assert.equal(unfiled().open,false);
 await f.folder('b').dispatch('keydown',{key:'ArrowDown'});assert.equal(document.activeElement,unfiled().querySelector('summary'));
 await f.drag(f.job(),unfiled().querySelector('summary'));
 assert.equal(f.state().assignments.job,undefined);
 assert.equal(f.job().closest('[data-schedule-unfiled]'),unfiled());
 assert.equal(unfiled().open,true,'a drop reveals the filed row');
 await f.drag(f.job(),f.folder('b'));assert.equal(f.state().assignments.job,'b');
 assert.deepEqual(f.calls.map(call=>[call.body.action,call.body.folderId]),[['assign',null],['assign','b']]);
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



test('compact row navigation skips collapsed descendants and leaves inputs alone',async t=>{
 const f=await fixture(t,{compact:true});f.folder('a').parentElement.open=false;
 await f.folder('a').dispatch('keydown',{key:'ArrowDown'});assert.equal(document.activeElement,f.folder('b'));
 await f.folder('b').dispatch('keydown',{key:'Home'});assert.equal(document.activeElement,f.folder('a'));
 await f.folder('a').dispatch('keydown',{key:'ArrowRight'});assert.equal(f.folder('a').parentElement.open,true);
 await f.folder('a').dispatch('keydown',{key:'ArrowDown'});assert.equal(document.activeElement,f.job());assert.equal(f.calls.length,0);
 const input=f.folder('a').querySelector('input');input.hidden=false;await input.dispatch('keydown',{key:'ArrowDown'},true);assert.equal(f.calls.length,0);
});





test('explicit inline child and root creation use pinned target without manager selectors',async t=>{
 const f=await fixture(t,{compact:true});assert.equal(f.manager.querySelector('details'),null);assert.equal(f.manager.querySelector('select'),null);
 await f.folder('a').querySelector('.next-schedule-folder-add').dispatch('click',{});
 let form=f.mount.querySelector('form'),input=form.querySelector('input');assert.equal(form.getAttribute('aria-label'),'New folder in Alpha');assert.equal(form.hidden,false);
 input.value='Child';await form.dispatch('submit',{});await settle();assert.equal(f.calls[0].body.parentId,'a');assert.equal(f.calls[0].body.expectedRevision,1);
 await f.manager.querySelector('.next-schedule-new-folder').dispatch('click',{});form=f.mount.querySelector('form');input=form.querySelector('input');input.value='Root';await form.dispatch('submit',{});await settle();assert.equal(f.calls[1].body.parentId,null);
});
test('inline create conflict pins destination and preserves draft; Escape sends nothing',async t=>{
 const f=await fixture(t,{compact:true});await f.folder('a').querySelector('.next-schedule-folder-add').dispatch('click',{});const form=f.mount.querySelector('form'),input=form.querySelector('input');input.value='Keep';f.advance();f.fail();await form.dispatch('submit',{});await settle();assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.expectedRevision,1);assert.equal(f.calls[0].body.parentId,'a');assert.equal(input.value,'Keep');await input.dispatch('keydown',{key:'Escape'});assert.equal(form.hidden,true);assert.equal(f.calls.length,1);
});
test('focused folder name supports keyboard nesting rather than summary-only shortcut',async t=>{
 const f=await fixture(t,{compact:true});const label=f.folder('b').querySelector('.next-schedule-folder-name');await f.folder('b').dispatch('keydown',{key:'Enter',ctrlKey:true,target:label});await settle();assert.equal(f.state().folders.find(x=>x.id==='b').parentId,'a');
});

test('removing any folder cannot clear an open inline create draft',async t=>{
 const f=await fixture(t,{compact:true});await f.folder('a').querySelector('.next-schedule-folder-add').dispatch('click',{});
 const form=f.mount.querySelector('form'),input=form.querySelector('input');input.value='Unique unsaved child';
 await f.folder('b').querySelector('.next-schedule-folder-remove').dispatch('click',{});await settle();
 assert.equal(f.calls.length,0);assert.equal(input.value,'Unique unsaved child');assert.equal(form.hidden,false);assert.equal(form.getAttribute('aria-label'),'New folder in Alpha');
 await form.dispatch('submit',{});await settle();assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.parentId,'a');assert.equal(f.calls[0].body.expectedRevision,1);
});
test('externally removed create destination preserves draft without silently retargeting',async t=>{
 const f=await fixture(t,{compact:true});await f.folder('a').querySelector('.next-schedule-folder-add').dispatch('click',{});const form=f.mount.querySelector('form'),input=form.querySelector('input');input.value='Keep destination';f.removeExternally('a');
 assert.equal(input.value,'Keep destination');assert.equal(form.getAttribute('aria-label'),'New folder in Alpha');assert.equal(form.querySelector('button').disabled,true);
 await form.dispatch('submit',{});await settle();assert.equal(f.calls.length,0);assert.match(f.manager.textContent,/destination folder no longer exists/);
 await input.dispatch('keydown',{key:'Escape'});await f.manager.querySelector('.next-schedule-new-folder').dispatch('click',{});input.value='Root after cancellation';await form.dispatch('submit',{});await settle();assert.equal(f.calls[0].body.parentId,null);assert.equal(f.calls[0].body.expectedRevision,2);
});


test('Move SVG opens a searchable, alphabetized full-path picker without expanding folders',async t=>{
 const f=await fixture(t,{compact:true});
 f.replace({revision:4,folders:[
  {id:'z',name:'Zebra',parentId:null},
  {id:'d',name:'Delta',parentId:'z'},
  {id:'a',name:'Alpha',parentId:null},
  {id:'b',name:'Bravo',parentId:'a'},
 ],assignments:{job:'a'}});
 f.folder('z').parentElement.open=false;
 const trigger=f.job().querySelector('[data-move-schedule="job"]');
 assert.ok(trigger.querySelector('svg'));assert.equal(trigger.getAttribute('aria-label'),'Move cronjob Saved job');
 assert.ok(f.folder('a').querySelector('[data-move-folder="a"] svg'));
 await trigger.dispatch('click',{});
 const dialog=f.manager.querySelector('#next-schedule-move-dialog'),query=f.manager.querySelector('#next-schedule-move-query');
 assert.equal(dialog.open,true);assert.equal(document.activeElement,query);
 const folderChoices=f.manager.querySelectorAll('.next-schedule-move-choice').filter(node=>['a','b','z','d'].includes(node.dataset.moveDestination));
 assert.deepEqual(folderChoices.map(node=>node.textContent),['Alpha (current)','Alpha / Bravo','Zebra','Zebra / Delta']);
 assert.equal(f.manager.querySelector('[data-move-destination="a"]').disabled,true);
 query.value='DELTA';await query.dispatch('input',{});
 assert.deepEqual(f.manager.querySelectorAll('.next-schedule-move-choice').map(node=>node.textContent),['Zebra / Delta']);
 await f.manager.querySelector('[data-move-destination="d"]').dispatch('click',{});
 await settle();
 assert.equal(f.state().assignments.job,'d');
 assert.deepEqual(f.calls[0].body,{action:'assign',deploymentId:'job',folderId:'d',expectedRevision:4});
 assert.equal(dialog.open,false);
 assert.equal(document.activeElement,f.job().querySelector('[data-move-schedule="job"]'));
});

test('Folder Move excludes its entire subtree, supports nested destinations, and changes organization only',async t=>{
 const f=await fixture(t,{compact:true});
 f.replace({revision:9,folders:[
  {id:'root',name:'Zebra',parentId:null},
  {id:'child',name:'Delta',parentId:'root'},
  {id:'a',name:'Alpha',parentId:null},
  {id:'b',name:'Bravo',parentId:'a'},
 ],assignments:{job:'child'}});
 const action=f.folder('root').querySelector('[data-move-folder="root"]');
 await action.dispatch('click',{});
 assert.equal(f.manager.querySelector('[data-move-destination="root"]'),null);
 assert.equal(f.manager.querySelector('[data-move-destination="child"]'),null);
 assert.equal(f.manager.querySelector('[data-move-destination=""]').disabled,true);
 await f.manager.querySelector('#next-schedule-move-cancel').dispatch('click',{});
 assert.equal(document.activeElement,action);
 assert.equal(f.calls.length,0);
 await action.dispatch('click',{});
 await f.manager.querySelector('[data-move-destination="b"]').dispatch('click',{});
 await settle();
 assert.equal(f.state().folders.find(node=>node.id==='root').parentId,'b');
 assert.equal(f.state().folders.find(node=>node.id==='child').parentId,'root');
 assert.equal(f.state().assignments.job,'child');
 assert.deepEqual(f.calls.map(call=>call.body),[{action:'update',id:'root',name:'Zebra',parentId:'b',expectedRevision:9}]);
});

test('Large folder catalogs remain searchable without a pagination or open-tree prerequisite',async t=>{
 const f=await fixture(t,{compact:true});
 const folders=Array.from({length:87},(_,i)=>({id:'folder-'+i,name:'Folder '+String(i).padStart(3,'0'),parentId:null}));
 folders.push({id:'deep',name:'Exact target',parentId:'folder-80'});
 f.replace({revision:7,folders,assignments:{job:'folder-0'}});
 await f.job().querySelector('[data-move-schedule="job"]').dispatch('click',{});
 assert.equal(f.manager.querySelectorAll('.next-schedule-move-choice').length,89);
 const search=f.manager.querySelector('#next-schedule-move-query');
 search.value='exact';await search.dispatch('input',{});
 assert.deepEqual(f.manager.querySelectorAll('.next-schedule-move-choice').map(node=>node.textContent),['Folder 080 / Exact target']);
 await f.manager.querySelector('#next-schedule-move-cancel').dispatch('click',{});
 assert.equal(f.calls.length,0);
});

test('Move retains its opening revision, never replays a conflict, and closes on leave',async t=>{
 const f=await fixture(t,{compact:true});
 await f.job().querySelector('[data-move-schedule="job"]').dispatch('click',{});
 f.advance(); // organization changed externally while the dialog was open
 await f.manager.querySelector('[data-move-destination="b"]').dispatch('click',{});
 await settle();
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].body.expectedRevision,1);
 assert.equal(f.state().assignments.job,'a');
 assert.equal(f.manager.querySelector('#next-schedule-move-dialog').open,false);
 await f.job().querySelector('[data-move-schedule="job"]').dispatch('click',{});
 f.component.leave();
 assert.equal(f.manager.querySelector('#next-schedule-move-dialog').open,false);
 assert.equal(f.calls.length,1);
});

test('Open creation and rename drafts block Move without losing either draft',async t=>{
 const f=await fixture(t,{compact:true});
 await f.folder('a').querySelector('.next-schedule-folder-add').dispatch('click',{});
 const form=f.mount.querySelector('form'),name=form.querySelector('input');
 name.value='Keep this draft';
 await f.job().querySelector('[data-move-schedule="job"]').dispatch('click',{});
 assert.equal(f.manager.querySelector('#next-schedule-move-dialog').open,false);
 assert.match(f.manager.textContent,/Finish or cancel folder creation or rename/);
 assert.equal(name.value,'Keep this draft');
 await name.dispatch('keydown',{key:'Escape'});
 await f.folder('a').querySelector('.next-schedule-folder-name').dispatch('click',{});
 const rename=f.folder('a').querySelector('input');rename.value='Uncommitted name';await rename.dispatch('input',{});
 await f.folder('b').querySelector('[data-move-folder="b"]').dispatch('click',{});
 assert.equal(f.manager.querySelector('#next-schedule-move-dialog').open,false);
 assert.equal(rename.value,'Uncommitted name');
 assert.equal(f.calls.length,0);
});

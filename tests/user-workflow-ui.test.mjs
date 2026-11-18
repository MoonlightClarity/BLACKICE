import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createUserWorkflowsWorkspace} from '../public/next/workspaces/user-workflows.mjs';
const flush=()=>new Promise(r=>setTimeout(r,10));
test('workflow UI saves explicit approvals, blocks dirty runs and preserves text on conflict',async t=>{
 const dom=planningDOM(t),calls=[];let rows=[],conflict=false;
 const api=async(path,method='GET',value)=>{calls.push({path,method,value});if(method==='GET')return path==='/api/user-workflows'?{workflows:rows}:rows[0];if(conflict)throw Error('Workflow changed');const row={...value,id:'one',revision:(rows[0]?.revision||0)+1};rows=[row];return row;};
 const ui=createUserWorkflowsWorkspace({mount:dom.mount,api});ui.enter();await flush();
 await dom.input('#uw-name','My procedure');await dom.input('#uw-instructions','Use the supplied data.');
 assert.equal(dom.$('#uw-run').disabled,true);await dom.click('#uw-draft');await flush();
 assert.equal(rows[0].status,'draft');assert.equal(dom.$('#uw-run').disabled,true);
 await dom.$('#uw-form').dispatch('submit');await flush();assert.equal(rows[0].status,'approved');assert.equal(rows[0].expectedRevision,1);assert.equal(dom.$('#uw-run').disabled,false);
 await dom.input('#uw-instructions','Changed instructions');assert.equal(dom.$('#uw-run').disabled,true);
 conflict=true;await dom.$('#uw-form').dispatch('submit');await flush();assert.equal(dom.$('#uw-instructions').value,'Changed instructions');assert.match(dom.$('#uw-info').textContent,/unsaved text/);
 ui.leave();ui.enter();await flush();assert.equal(dom.$('#uw-instructions').value,'Changed instructions');ui.destroy();
});
test('uncertain execution retries same request and repeated click while busy starts once',async t=>{
 const dom=planningDOM(t),row={id:'one',name:'Workflow',description:'',instructions:'Do task',revision:1,status:'approved'},requests=[],navigation=[];
 let rejectFirst,first=true;
 const api=async(path,method='GET',value)=>{if(method==='GET')return path==='/api/user-workflows'?{workflows:[row]}:row;requests.push(value);if(first){first=false;return new Promise((_,reject)=>{rejectFirst=reject;});}return{id:'run-1'};};
 const ui=createUserWorkflowsWorkspace({mount:dom.mount,api,onNavigate:(...args)=>navigation.push(args)});ui.enter();await flush();await dom.click(dom.$('#uw-list').querySelector('button'));await flush();
 const pending=dom.click('#uw-run');await flush();await dom.click('#uw-run');assert.equal(requests.length,1);rejectFirst(Error('Response lost'));await pending;await dom.click('#uw-run');
 assert.equal(requests.length,2);assert.equal(requests[0].requestId,requests[1].requestId);assert.equal(navigation[0][1].requestId,'run-1');ui.destroy();
});

test('lost create response reuses draft identity, while unsaved new text can be explicitly discarded',async t=>{
 const dom=planningDOM(t),writes=[];let saved=null,lose=true;
 const api=async(path,method='GET',value)=>{if(method==='GET')return{workflows:saved?[saved]:[]};writes.push(value);saved={...value,revision:1};if(lose){lose=false;throw Error('Saved but response lost');}return saved;};
 const ui=createUserWorkflowsWorkspace({mount:dom.mount,api});ui.enter();await flush();
 await dom.input('#uw-name','Procedure');await dom.input('#uw-instructions','Do fixture task');await dom.click('#uw-draft');await flush();await dom.click('#uw-draft');await flush();
 assert.equal(writes.length,2);assert.ok(writes[0].id);assert.equal(writes[0].id,writes[1].id);assert.equal(writes[1].expectedRevision,0);
 await dom.click('#uw-new');await dom.input('#uw-name','Discard me');assert.equal(dom.$('#uw-reload').disabled,false);await dom.click('#uw-reload');assert.equal(dom.$('#uw-name').value,'');ui.destroy();
});

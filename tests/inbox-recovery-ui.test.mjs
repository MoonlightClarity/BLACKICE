import test from 'node:test';
import assert from 'node:assert/strict';
import {initInboxUI,inboxItemPresentation} from '../public/inbox-ui.mjs';

function fixture(t,item){
 const previous={document:globalThis.document,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout},nodes=new Map(),listeners=new Map(),requests=[],opened=[];
 const node=()=>({innerHTML:'',scrollTop:0,classList:{add(){}},querySelector(){return null;}});
 globalThis.document={querySelector:selector=>nodes.get(selector)||null,addEventListener(type,handler){listeners.set(type,handler);}};globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{};
 t.after(()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
 const data={status:{autoRun:false,paused:false,pending:item.status==='queued'?1:0,active:0,completed:0},settings:{pauseOnFailure:true},items:[item]},ui=initInboxUI({api:async(route,method='GET',body)=>{requests.push({route,method,body});return structuredClone(data);},showModal(){nodes.set('#inbox-view',node());nodes.set('#modal-root .modal',node());nodes.set('.inbox-list',node());nodes.set('.inbox-detail',node());},closeModal(){nodes.clear();},toast(){},escape:value=>String(value??'').replace(/[<>&"]/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[char])),icon:()=>'',getCwd:()=>item.cwd,onOpenRun:async id=>opened.push({run:id}),onOpenOperations:async()=>opened.push({operations:true}),draftStore:{list:()=>[],load:()=>null}});
 const click=action=>listeners.get('click')({target:{closest:()=>({dataset:{inbox:action,runId:item.retryHold?.runId||item.runId}})}});
 return{ui,html:()=>nodes.get('#inbox-view')?.innerHTML,requests,opened,click};
}
const item=extra=>({id:'saved-task',input:'Do the authorized work',title:'Saved work',cwd:'C:\\fixture',attachmentIds:[],createdAt:'2026-10-17T12:00:00Z',status:'queued',attempts:[],...extra});

for(const status of ['queued','failed'])test(`a ${status} operation task routes to its manager and never offers an inbox start/retry`,async t=>{
 const value=item({status,managedBy:'operations',runId:status==='failed'?'actual-run':null}),f=fixture(t,value);await f.ui.open({selectedId:value.id});assert.match(f.html(),/Manage operation/);assert.match(f.html(),/pause, execution and retries together/);assert.doesNotMatch(f.html(),/data-inbox="(?:run|retry|move)"/);await f.click('operations');assert.deepEqual(f.opened,[{operations:true}]);assert.equal(f.requests.filter(request=>request.method!=='GET').length,0);
});
test('a held external action clearly links its original chat even if a prior retry cleared runId',async t=>{
 const value=item({status:'interrupted',runId:null,retryHold:{runId:'original-run',message:'Inspect the original destination before creating new work.'}}),f=fixture(t,value);await f.ui.open({selectedId:value.id});assert.match(f.html(),/Inspect original run/);assert.match(f.html(),/Inspect the original destination/);assert.match(f.html(),/data-run-id="original-run">Open original chat/);assert.doesNotMatch(f.html(),/data-inbox="(?:run|retry)"/);await f.click('open-run');assert.deepEqual(f.opened,[{run:'original-run'}]);assert.equal(f.requests.filter(request=>request.method!=='GET').length,0);
});
test('ordinary saved work retains explicit Run now and failed work without external effects remains requeueable',async t=>{
 const queued=item({}),f=fixture(t,queued);await f.ui.open({selectedId:queued.id});assert.match(f.html(),/data-inbox="run"/);assert.doesNotMatch(f.html(),/Manage operation/);
});
test('failed ordinary tasks still offer Save to Next without claiming they are already queued',async t=>{
 const failed=item({status:'failed'}),f=fixture(t,failed);await f.ui.open({selectedId:failed.id});assert.match(f.html(),/data-inbox="retry"/);assert.match(f.html(),/Save to Next/);assert.equal(inboxItemPresentation(failed).label,'Failed');assert.equal(f.requests.filter(request=>request.method!=='GET').length,0);
});

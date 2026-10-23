import test from 'node:test';
import assert from 'node:assert/strict';
import { initAdvancedUI } from '../public/advanced-ui.mjs';
import { initConfigureUI } from '../public/configure-ui.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const workflow=()=>({id:'density-workflow',name:'Review',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'default',prompt:'Review the fixture.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{}});
function operationsFixture(t,snapshot){
  const f=planningDOM(t),root=f.element('div'),calls=[],oldInterval=globalThis.setInterval,oldClear=globalThis.clearInterval;
  root.id='modal-root';f.mount.append(root);globalThis.setInterval=()=>1;globalThis.clearInterval=()=>{};
  t.after(()=>{globalThis.setInterval=oldInterval;globalThis.clearInterval=oldClear;});
  const ui=initAdvancedUI({api:async(url,method='GET')=>{calls.push({url,method});assert.equal(url,'/api/operations');return snapshot;},showModal(id,html){root.innerHTML='<div class="modal">'+html+'</div>';},closeModal(){root.innerHTML='';},toast(){},escape:value=>String(value??''),icon:()=>'',getWorkflow:async()=>workflow(),getCwd:()=> 'C:\\fixture',getModels:()=>[],onWorkflow(){},onOpenRun(){}});
  return {...f,ui,calls};
}
function operationSnapshot(){
  return{status:{paused:false,running:0,queued:0,error:'Scheduler notice'},deployments:[{id:'alpha',name:'Morning report',enabled:false,trigger:{type:'manual'},overlap:'parallel'},{id:'beta',name:'Weekly check',enabled:false,trigger:{type:'manual'},overlap:'queue'}],jobs:[{id:'a',deploymentId:'alpha',deploymentName:'Morning report',status:'completed',attempts:[]},{id:'b',deploymentId:'beta',deploymentName:'Weekly check',status:'failed',attempts:[],error:'Fixture failed'}]};
}
test('schedule sections expose one panel and global attention opens the relevant unscoped history without admitting work',async t=>{
  const snapshot=operationSnapshot(),f=operationsFixture(t,snapshot);await f.ui.openOperations();
  assert.equal(f.$('#operations-schedules').hidden,false);assert.equal(f.$('#operations-jobs').hidden,true);assert.equal(f.$('#operations-jobs').inert,true);
  assert.equal(f.$('.operations-overview'),null);assert.equal(f.$('.operation-row-details').open,false);assert.ok(f.$('[data-op="run"]').closest('details'));
  assert.match(f.$('.operations-attention').textContent,/1 job needs attention/);assert.equal(f.$('.operations-attention').closest('[hidden],[inert]'),null);assert.match(f.$('#operations-error').textContent,/Scheduler notice/);
  await f.click('[data-op="jobs"][data-id="alpha"]');assert.equal(f.$('#operations-schedules').hidden,true);assert.equal(f.$('#operations-schedules').inert,true);assert.equal(f.$('#operations-jobs').hidden,false);assert.equal(f.$('#operations-jobs').inert,false);assert.match(f.$('.operations-scope').textContent,/Morning report/);
  await f.click('[data-op="section"][data-id="schedules"]');assert.equal(f.document.activeElement,f.$('#operations-schedules'));assert.equal(f.$('#operations-jobs').hidden,true);
  await f.click('[data-op="attention"]');assert.equal(f.$('#operations-jobs').hidden,false);assert.equal(f.$('.operations-scope'),null);assert.ok(f.$('[data-job="b"]'));assert.equal(f.$('[data-job="a"]'),null);assert.equal(f.document.activeElement.closest('[hidden],[inert]'),null);
  assert.equal(f.calls.every(call=>call.method==='GET'),true);
});
test('schedule detail expansion and summary focus survive refresh while hidden sections stay inert',async t=>{
  const snapshot=operationSnapshot(),f=operationsFixture(t,snapshot);await f.ui.openOperations();
  const details=f.$('[data-op-detail="schedule:alpha"]'),summary=details.querySelector('summary');details.open=true;summary.focus();snapshot.status.queued=1;
  await f.click('[data-op="refresh"]');
  const restored=f.$('[data-op-detail="schedule:alpha"]');assert.notEqual(restored,details);assert.equal(restored.open,true);assert.equal(f.document.activeElement,restored.querySelector('summary'));assert.equal(f.$('#operations-jobs').hidden,true);assert.equal(f.$('#operations-jobs').inert,true);assert.equal(f.calls.every(call=>call.method==='GET'),true);
});
function settingsFixture(t){
  let ui;t.after(()=>ui?.destroy());const f=planningDOM(t),instances={},counts={},calls=[];
  const snapshot={status:{connected:true,authenticated:true,version:'fixture-1',runtimeSettings:{},chatGPTConnector:{available:true,enabled:true},browserCredentials:{available:true},remoteAccess:{enabled:false},desktopLifecycle:{visible:true}},workflow:workflow(),workflows:[workflow()]};
  let connector={enabled:true,oauth:{requests:[],grants:[]},pending:{jobs:[]}},failure=false;
  const child=(key,html)=>options=>{counts[key]=(counts[key]||0)+1;instances[key]=options;options.mount.innerHTML=html;return{update(){},isInteracting:()=>false,destroy(){}};};
  ui=initConfigureUI({mount:f.mount,getSnapshot:()=>snapshot,api:async(url,method)=>{calls.push({url,method});if(failure)throw Error('Fixture connection unavailable');return connector;},
    mountConnector:child('connector','<h2>ChatGPT connector</h2><input id="connector-draft" value="Saved label">'),
    mountCredentials:child('credentials','<h2>Password manager</h2><input id="credentials-draft" value="Saved login">'),
    mountRemote:child('remote','<h2>Remote access</h2><input id="remote-draft" value="Saved agent">')});
  const toggle=async(key,open)=>{const panel=f.$('[data-configure-section="'+key+'"]');panel.open=open;await panel.dispatch('toggle',{},true);};
  return{...f,ui,snapshot,instances,counts,calls,toggle,setConnector(value){connector=value;},fail(){failure=true;}};
}
test('Settings reveals each integration deliberately and keeps child drafts, node identity and disclosure focus through redraws',async t=>{
  const f=settingsFixture(t);for(const key of ['connector','credentials','remote'])assert.equal(f.$('[data-configure-section="'+key+'"]').open,false);
  const nodes=Object.fromEntries(['connector','credentials','remote'].map(key=>[key,f.$('#configure-'+key+'-mount')]));
  f.ui.showCredentials();assert.equal(f.$('[data-configure-section="credentials"]').open,true);assert.equal(f.document.activeElement,f.$('#configure-credentials-mount h2'));f.$('#credentials-draft').value='Unsaved login label';
  f.ui.showRemote();const field=f.$('#remote-draft');field.value='Unsaved agent name';field.focus();field.setSelectionRange(2,10,'backward');f.snapshot.status.version='fixture-2';f.ui.update();
  for(const key of Object.keys(nodes))assert.equal(f.$('#configure-'+key+'-mount'),nodes[key]);assert.equal(f.$('#remote-draft'),field);assert.equal(f.document.activeElement,field);assert.equal(field.value,'Unsaved agent name');assert.deepEqual([field.selectionStart,field.selectionEnd,field.selectionDirection],[2,10,'backward']);assert.equal(f.$('#credentials-draft').value,'Unsaved login label');
  await f.toggle('remote',false);f.$('[data-configure-section="remote"] > summary').focus();f.snapshot.status.version='fixture-3';f.ui.update();assert.equal(f.$('[data-configure-section="remote"]').open,false);assert.equal(f.document.activeElement,f.$('[data-configure-section="remote"] > summary'));
  f.ui.showWorkflows();f.ui.showConnector();assert.equal(f.$('[data-configure-section="connector"]').open,true);assert.equal(f.document.activeElement,f.$('#configure-connector-mount h2'));for(const key of Object.keys(nodes))assert.equal(f.$('#configure-'+key+'-mount'),nodes[key]);assert.deepEqual(f.counts,{connector:1,credentials:1,remote:1});assert.deepEqual(f.calls,[]);
});
test('new connector attention reveals its own retained panel once without stealing focus or replaying actions',async t=>{
  const f=settingsFixture(t),api=f.instances.connector.api;f.ui.showRemote();const field=f.$('#remote-draft');field.focus();field.value='Keep this draft';
  f.setConnector({enabled:true,oauth:{requests:[{id:'request-one'}],grants:[]},pending:{jobs:[{jobId:'job-one'}]}});await api('/api/chatgpt-connector');
  assert.equal(f.$('[data-configure-section="connector"]').open,true);assert.equal(f.$('[data-configure-status="connector"]').textContent,'2 waiting');assert.equal(f.$('[data-configure-status="connector"]').dataset.attention,'true');assert.equal(f.document.activeElement,field);
  await f.toggle('connector',false);await api('/api/chatgpt-connector');assert.equal(f.$('[data-configure-section="connector"]').open,false,'polling the same request respects deliberate collapse');
  f.setConnector({enabled:true,oauth:{requests:[{id:'request-two'}],grants:[]},pending:{jobs:[]}});await api('/api/chatgpt-connector');assert.equal(f.$('[data-configure-section="connector"]').open,true);assert.equal(f.$('#remote-draft'),field);assert.equal(field.value,'Keep this draft');
  await f.toggle('connector',false);f.fail();await assert.rejects(api('/api/chatgpt-connector'),/unavailable/);assert.equal(f.$('[data-configure-status="connector"]').textContent,'Needs attention');assert.equal(f.$('[data-configure-status="connector"]').closest('[hidden],[inert]'),null);assert.equal(f.calls.every(call=>!call.method||call.method==='GET'),true);
});

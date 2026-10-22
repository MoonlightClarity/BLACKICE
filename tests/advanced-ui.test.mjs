import test from 'node:test';
import assert from 'node:assert/strict';
import { initAdvancedUI,operationLimitsFromDraft } from '../public/advanced-ui.mjs';

const workflow=()=>({id:'workflow',name:'Independent work',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'default',prompt:'Use actual tools.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{cwd:'C:\\fixture',maxParallel:null}});
function fixture(t,{deployments=[],api:onApi,onWorkflow,getWorkflow,getTaskDefaults}={}){
  const previous=Object.fromEntries(['document','FormData','setInterval','clearInterval'].map(key=>[key,{present:Object.hasOwn(globalThis,key),value:globalThis[key]}])),elements=new Map(),requests=[],modals=[],messages=[],created=[],intervals=new Map();let closed=0,timer=0,view=0;
  const element=()=>{let html='';return{get innerHTML(){return html;},set innerHTML(value){html=value;this.htmlWrites++;},htmlWrites:0,hidden:false,disabled:false,textContent:'',classList:{add(){}}};};
  function showModal(id,html){
    elements.clear();modals.push({id,html});elements.set('#modal-root .modal',element());
    if(id==='operations'){elements.set('#operations-view',element());elements.set('#operations-error',element());}
    if(id==='deployment'){
      const trigger=/name="trigger">([\s\S]*?)<\/select>/.exec(html)?.[1].match(/value="([^"]+)" selected/)?.[1]||'manual',button=element(),form={values:{name:'Nightly report',input:'Check the actual work',cwd:'C:\\fixture',trigger,seconds:'60',time:'09:00',weekday:'1',expression:'0 9 * * *',timezone:'UTC',model:'cloud::chosen',overlap:'parallel',attempts:'0',backoff:'30'},elements:{trigger:{value:trigger},enabled:{checked:html.includes('name="enabled" type="checkbox" checked')}},querySelector:()=>button};
      Object.defineProperty(form.elements.trigger,'value',{get(){return form.values.trigger;},set(value){form.values.trigger=value;}});
      form.elements.namedItem=name=>name==='trigger'?form.elements.trigger:Object.hasOwn(form.values,name)?{get value(){return form.values[name];},set value(value){form.values[name]=value;}}:null;
      elements.set('#deployment-form',form);for(const name of ['interval','time','weekday','cron','timezone','preview','limit-preview','back','error','discard','draft-note'])elements.set('#deployment-'+name,element());
    }
    if(id==='swarm'){
      const form={values:{name:'My large swarm',pattern:'research',members:'65',model:'cloud::chosen'},querySelectorAll:()=>[]};form.elements={namedItem:name=>({get value(){return form.values[name];}})};elements.set('#swarm-form',form);for(const name of ['assignment-list','autonomy-note','plan-preview','assignment-error'])elements.set('#swarm-'+name,element());
    }
  }
  globalThis.document={querySelector:selector=>elements.get(selector)||null};
  globalThis.FormData=class{constructor(form){this.entries=Object.entries(form.values);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}};
  globalThis.setInterval=callback=>{const id=++timer;intervals.set(id,callback);return id;};globalThis.clearInterval=id=>intervals.delete(id);
  const ui=initAdvancedUI({createPlanUI:()=>({update(){},destroy(){}}),api:async(path,method='GET',body)=>{requests.push({path,method,body});if(onApi){const value=await onApi(path,method,body);if(value!==undefined)return value;}if(path==='/api/operations')return{status:{paused:false,running:0,queued:0},deployments,jobs:[]};return{};},showModal,closeModal:()=>{closed++;elements.clear();},toast:(message,error)=>messages.push({message,error}),escape:value=>String(value??'').replace(/[<>&"]/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[char])),icon:()=>'',getWorkflow:getWorkflow||(async()=>workflow()),getCwd:()=> 'C:\\fixture',getTaskDefaults,getModels:()=>[{id:'cloud::chosen',displayName:'Chosen cloud'}],onWorkflow:async(value,context)=>{created.push(value);return onWorkflow?.(value,context);},onOpenRun(){},captureOwnership:()=>view,ownsOwnership:owner=>owner===view});
  t.after(()=>{for(const[key,old]of Object.entries(previous))if(old.present)globalThis[key]=old.value;else delete globalThis[key];});
  const submit=form=>form.onsubmit({target:form,preventDefault(){}});
  return{ui,elements,requests,modals,messages,created,closed:()=>closed,submit,replaceModal:showModal,navigate:()=>{view++;},poll:()=>[...intervals.values()].at(-1)?.()};
}


test('schedule manager links saved configuration to clearable job history without running work',async t=>{
 const deployments=[{id:'alpha',name:'Morning report',enabled:false,trigger:{type:'manual'},overlap:'parallel'},{id:'beta',name:'Weekly check',enabled:false,trigger:{type:'manual'},overlap:'parallel'}],jobs=[{id:'a',deploymentId:'alpha',deploymentName:'Morning report',status:'failed',attempts:[]},{id:'b',deploymentId:'beta',deploymentName:'Weekly check',status:'completed',attempts:[]}],f=fixture(t,{api:path=>path==='/api/operations'?{status:{paused:false},deployments,jobs}:undefined});
 await f.ui.openOperations();const view=f.elements.get('#operations-view');assert.match(f.modals.at(-1).html,/data-action="planning"/);assert.match(f.modals.at(-1).html,/data-action="projects"/);assert.match(view.innerHTML,/>Saved schedules/);assert.match(view.innerHTML,/>Job history/);
 const focus=[],scroll=[];view.querySelector=selector=>({scrollIntoView:()=>scroll.push(selector),focus:()=>focus.push(selector)});
 const click=(op,id)=>view.onclick({target:{closest:()=>({dataset:{op,id}})}});
 await click('jobs','alpha');assert.match(view.innerHTML,/Jobs for <strong>Morning report/);assert.match(view.innerHTML,/Showing 1 of 1 jobs for this schedule/);assert.match(view.innerHTML,/data-op="clear-filter">Show all schedules/);
 await click('section','schedules');assert.equal(focus.at(-1),'.operations-schedules');await click('filter','completed');assert.match(view.innerHTML,/No jobs match this view/);assert.match(view.innerHTML,/Clear job filters/);assert.equal(scroll.at(-1),'.operations-jobs');
 await click('clear-filter');assert.match(view.innerHTML,/Showing 2 of 2 jobs/);assert.doesNotMatch(view.innerHTML,/Jobs for <strong>/);assert.equal(f.requests.some(request=>request.method!=='GET'),false);
});

test('leaving schedule setup restores its unsaved values and enabled choice when returning from manager or Swarms',async t=>{
 const f=fixture(t);await f.ui.openSchedule();let form=f.elements.get('#deployment-form');form.values.input='Preserve this detailed task';form.values.name='Draft report';form.values.trigger='weekly';form.values.weekday='4';form.values.time='16:20';form.values.timezone='America/New_York';form.elements.enabled.checked=false;form.oninput();
 await f.elements.get('#deployment-back').onclick();assert.equal(f.modals.at(-1).id,'operations');await f.ui.openSchedule();form=f.elements.get('#deployment-form');assert.equal(form.values.input,'Preserve this detailed task');assert.equal(form.values.name,'Draft report');assert.equal(form.elements.trigger.value,'weekly');assert.equal(form.values.weekday,'4');assert.equal(form.values.time,'16:20');assert.equal(form.values.timezone,'America/New_York');assert.equal(form.elements.enabled.checked,false);assert.match(f.modals.at(-1).html,/id="deployment-draft-note">Your unsaved schedule draft is restored/);
 form.values.input='Revised draft';form.oninput();f.ui.openSwarm();assert.match(f.modals.at(-1).html,/data-action="operations"/);await f.ui.openSchedule();assert.equal(f.elements.get('#deployment-form').values.input,'Revised draft');assert.equal(f.requests.some(request=>request.path==='/api/operations/deployments'||request.path.endsWith('/trigger')),false);
});

test('schedule drafts can be discarded and a successful save clears only that draft',async t=>{
 const f=fixture(t);await f.ui.openSchedule();let form=f.elements.get('#deployment-form');form.values.input='Discard this local draft';form.oninput();await f.ui.openSchedule();await f.elements.get('#deployment-discard').onclick();form=f.elements.get('#deployment-form');assert.notEqual(form.values.input,'Discard this local draft');assert.match(f.modals.at(-1).html,/id="deployment-draft-note" hidden/);assert.equal(f.requests.some(request=>request.path==='/api/operations/deployments'),false);
 form.values.input='Save this schedule';form.values.trigger='manual';form.oninput();await f.submit(form);assert.equal(f.requests.filter(request=>request.path==='/api/operations/deployments').length,1);await f.ui.openSchedule();assert.match(f.modals.at(-1).html,/id="deployment-draft-note" hidden/);assert.notEqual(f.elements.get('#deployment-form').values.input,'Save this schedule');
});

test('restored edits retain their original revision so a newer saved schedule cannot be overwritten silently',async t=>{
 const deployments=[{id:'changed',name:'Saved report',revision:1,input:'Saved task',cwd:'C:\\fixture',workflow:workflow(),trigger:{type:'manual'},retry:{maxAttempts:0,backoffSeconds:30},overlap:'parallel',enabled:false}],f=fixture(t,{deployments,api:(path,method)=>{if(method==='PUT')throw Error('Schedule changed. Reload before saving.');}});
 await f.ui.openOperations();await f.elements.get('#operations-view').onclick({target:{closest:()=>({dataset:{op:'edit',id:'changed'}})}});let form=f.elements.get('#deployment-form');form.values.input='Unsaved local edit';form.oninput();await f.elements.get('#deployment-back').onclick();deployments[0]={...deployments[0],revision:2,input:'Newer saved task'};await f.ui.openOperations();await f.elements.get('#operations-view').onclick({target:{closest:()=>({dataset:{op:'edit',id:'changed'}})}});form=f.elements.get('#deployment-form');assert.equal(form.values.input,'Unsaved local edit');await f.submit(form);assert.equal(f.requests.find(request=>request.method==='PUT').body.expectedRevision,1);assert.match(f.elements.get('#deployment-error').textContent,/Schedule changed/);assert.equal(f.modals.at(-1).id,'deployment');
});

test('an older completed save cannot discard a newer schedule draft after navigation',async t=>{
 let release;const f=fixture(t,{api:(path,method)=>path==='/api/operations/deployments'&&method==='POST'?new Promise(resolve=>{release=resolve;}):undefined});await f.ui.openSchedule();const first=f.elements.get('#deployment-form');first.values.trigger='manual';first.values.input='First save';const pending=f.submit(first);await f.ui.openSchedule();const replacement=f.elements.get('#deployment-form');replacement.values.input='Newer unsaved task';replacement.oninput();release({});await pending;assert.strictEqual(f.elements.get('#deployment-form'),replacement);await f.elements.get('#deployment-back').onclick();await f.ui.openSchedule();assert.equal(f.elements.get('#deployment-form').values.input,'Newer unsaved task');
});

test('operation editor exposes Run together by default and sends the user overlap choice without changing workflow concurrency',async t=>{
  const f=fixture(t);await f.ui.deployWorkflow();const modal=f.modals.at(-1),form=f.elements.get('#deployment-form');
  assert.match(modal.html,/<option value="parallel" selected>Run together/);assert.match(modal.html,/<option value="queue">Queue in order/);assert.match(modal.html,/<option value="skip">Skip busy schedule ticks/);
  assert.equal(f.elements.get('#deployment-interval').hidden,true);form.elements.trigger.value='interval';form.elements.trigger.onchange();assert.equal(f.elements.get('#deployment-interval').hidden,false);
  form.values.trigger='interval';form.values.seconds='120';form.values.overlap='parallel';form.elements.enabled.checked=true;await f.submit(form);
  const saved=f.requests.find(request=>request.method==='POST');assert.equal(saved.path,'/api/operations/deployments');assert.equal(saved.body.overlap,'parallel');assert.deepEqual(saved.body.trigger,{type:'interval',everySeconds:120});assert.equal(saved.body.enabled,true);assert.equal(saved.body.workflow.settings.maxParallel,null);assert.equal(f.modals.at(-1).id,'operations');
});

test('finite schedule limits stay optional and send exact user choices without artificial iteration or duration ceilings',async t=>{
  const f=fixture(t);await f.ui.openSchedule();const modal=f.modals.at(-1),form=f.elements.get('#deployment-form');assert.match(modal.html,/<details class="deployment-limits"><summary>Limits · optional/);assert.match(modal.html,/name="maxIterations" type="number" min="1" step="1"/);assert.doesNotMatch(modal.html,/name="(?:maxIterations|runFor)"[^>]*max=/);assert.match(modal.html,/End at · /);assert.match(modal.html,/admitted work finishes/);assert.match(modal.html,/Pausing does not reset/);
  form.values.maxIterations='1000000';form.values.runFor='365';form.values.runForUnit='86400';form.values.endAt='2030-01-05T17:30';await f.submit(form);const saved=f.requests.find(request=>request.path==='/api/operations/deployments');assert.deepEqual(saved.body.limits,{maxIterations:1000000,runForSeconds:365*86400,endAt:new Date('2030-01-05T17:30').toISOString()});assert.equal(saved.body.overlap,'parallel');
});

test('blank limits clear previous choices and malformed limits leave the schedule editable without admitting work',async t=>{
  assert.deepEqual(operationLimitsFromDraft({}),{maxIterations:null,runForSeconds:null,endAt:null});for(const values of [{maxIterations:'0'},{maxIterations:'1.2'},{maxIterations:'Infinity'},{runFor:'-1'},{runFor:'1',runForUnit:'7'},{runFor:String(Number.MAX_SAFE_INTEGER),runForUnit:'3600'},{endAt:'not a date'}])assert.throws(()=>operationLimitsFromDraft(values));
  const f=fixture(t);await f.ui.openSchedule();const form=f.elements.get('#deployment-form');form.values.maxIterations='0';await f.submit(form);assert.match(f.elements.get('#deployment-error').textContent,/positive whole number/);assert.equal(f.requests.some(request=>request.path==='/api/operations/deployments'),false);assert.equal(f.modals.at(-1).id,'deployment');
});

test('editing finite limits shows saved values, lifetime count and the local zone without resetting its task snapshot',async t=>{
  const deployment={id:'limited',name:'Finite task',revision:4,input:'Repeat this task',cwd:'C:\\fixture',workflow:workflow(),attachmentIds:[],trigger:{type:'interval',everySeconds:60},overlap:'parallel',retry:{maxAttempts:0,backoffSeconds:30},enabled:true,limits:{maxIterations:7,runForSeconds:7200,endAt:'2030-01-05T17:30:00Z'},admittedJobs:3,limitStatus:{reached:false,remainingIterations:4,endsAt:'2030-01-05T17:30:00Z'}},f=fixture(t,{deployments:[deployment]});await f.ui.openOperations();let view=f.elements.get('#operations-view');assert.match(view.innerHTML,/3 \/ 7 jobs/);assert.match(view.innerHTML,/Ends /);await view.onclick({target:{closest:()=>({dataset:{op:'edit',id:'limited'}})}});const html=f.modals.at(-1).html;assert.match(html,/name="maxIterations"[^>]*value="7"/);assert.match(html,/name="runFor"[^>]*value="2"/);assert.match(html,/<option value="3600" selected>Hours/);assert.match(html,/3 jobs already admitted/);const form=f.elements.get('#deployment-form');form.values.maxIterations='';form.values.runFor='';form.values.endAt='';await f.submit(form);const saved=f.requests.find(request=>request.method==='PUT');assert.deepEqual(saved.body.limits,{maxIterations:null,runForSeconds:null,endAt:null});assert.equal(saved.body.expectedRevision,4);assert.deepEqual(saved.body.workflow,deployment.workflow);
});

test('a reached operation limit is readable and Run now displays its specific server failure',async t=>{
  const deployment={id:'finished',name:'Finished task',trigger:{type:'interval',everySeconds:10},enabled:true,overlap:'parallel',limits:{maxIterations:2},admittedJobs:2,limitStatus:{reached:true,reason:'Stopped after 2 admitted jobs.',remainingIterations:0,endsAt:null}},f=fixture(t,{deployments:[deployment],api:(route)=>{if(route.endsWith('/trigger'))throw Error('Stopped after 2 admitted jobs. Edit or remove its limits to admit more jobs.');}});await f.ui.openOperations();const view=f.elements.get('#operations-view');assert.match(view.innerHTML,/stopped/);assert.match(view.innerHTML,/Stopped after 2 admitted jobs/);assert.match(view.innerHTML,/data-op="run" data-id="finished">Run now/);await view.onclick({target:{closest:()=>({dataset:{op:'run',id:'finished'}})}});assert.match(f.messages.at(-1).message,/Edit or remove its limits/);assert.equal(f.messages.at(-1).error,true);
});

test('unchanged end dates preserve the exact second DST occurrence and edited dates disclose their resolved offset before saving',async t=>{
  const originalTZ=process.env.TZ;process.env.TZ='America/New_York';t.after(()=>{if(originalTZ===undefined)delete process.env.TZ;else process.env.TZ=originalTZ;});const savedEnd='2026-11-01T06:30:00.000Z';assert.equal(new Date(savedEnd).getTimezoneOffset(),300);
  assert.equal(operationLimitsFromDraft({endAt:'2026-11-01T01:30'},{previousEndAt:savedEnd}).endAt,savedEnd);assert.equal(operationLimitsFromDraft({endAt:'2026-11-01T01:30:00'},{previousEndAt:savedEnd}).endAt,savedEnd);assert.equal(operationLimitsFromDraft({endAt:'2026-11-01T01:31'},{previousEndAt:savedEnd}).endAt,'2026-11-01T05:31:00.000Z');assert.throws(()=>operationLimitsFromDraft({endAt:'2026-03-08T02:30'}),/valid end time/);assert.throws(()=>operationLimitsFromDraft({endAt:'2026-11-01T01:30:99'}),/valid end time/);
  const deployment={id:'fold',revision:2,name:'Fold schedule',input:'Keep the exact saved deadline.',cwd:'C:\\fixture',workflow:workflow(),trigger:{type:'interval',everySeconds:60},retry:{maxAttempts:0,backoffSeconds:30},overlap:'parallel',enabled:true,limits:{maxIterations:null,runForSeconds:null,endAt:savedEnd}},f=fixture(t,{deployments:[deployment]});await f.ui.openOperations();await f.elements.get('#operations-view').onclick({target:{closest:()=>({dataset:{op:'edit',id:'fold'}})}});const form=f.elements.get('#deployment-form');form.values.endAt='2026-11-01T01:30';form.onchange({target:{name:'endAt'}});assert.match(f.elements.get('#deployment-limit-preview').textContent,/GMT-05:00/);assert.match(f.elements.get('#deployment-limit-preview').textContent,/2026-11-01T06:30:00.000Z/);await f.submit(form);assert.equal(f.requests.find(request=>request.method==='PUT').body.limits.endAt,savedEnd);
});

for(const overlap of ['parallel','queue','skip'])test(`editing a deployment preserves ${overlap} and its revision, workflow and attachments`,async t=>{
  const deployment={id:'deploy',name:'Saved operation',revision:7,input:'Existing task',cwd:'C:\\fixture',workflow:workflow(),attachmentIds:['source-file'],trigger:{type:'interval',everySeconds:120},overlap,retry:{maxAttempts:0,backoffSeconds:30},enabled:true},f=fixture(t,{deployments:[deployment]});
  await f.ui.openOperations();const view=f.elements.get('#operations-view');assert.match(view.innerHTML,new RegExp(overlap==='parallel'?'run together':overlap==='queue'?'queue in order':'skip overlaps'));
  await view.onclick({target:{closest:()=>({dataset:{op:'edit',id:'deploy'}})}});assert.match(f.modals.at(-1).html,new RegExp(`<option value="${overlap}" selected>`));
  const form=f.elements.get('#deployment-form');form.values.overlap=overlap;await f.submit(form);const saved=f.requests.find(request=>request.method==='PUT');assert.equal(saved.path,'/api/operations/deployments/deploy');assert.equal(saved.body.expectedRevision,7);assert.equal(saved.body.overlap,overlap);assert.deepEqual(saved.body.attachmentIds,['source-file']);assert.deepEqual(saved.body.workflow,deployment.workflow);
});

test('swarm form creates the exact research team within the shared-plan representation limit',async t=>{
  const f=fixture(t);f.ui.openSwarm();const modal=f.modals.at(-1),form=f.elements.get('#swarm-form');assert.match(modal.html,/name="members" type="number" min="1" max="99" step="1"/);assert.match(modal.html,/200-step shared plan/);
  await f.submit(form);assert.equal(f.created.length,1);const swarm=f.created[0],agents=swarm.nodes.filter(node=>node.type==='agent');assert.equal(agents.length,66);assert.equal(swarm.settings.maxParallel,65);assert.equal(agents.filter(agent=>agent.id==='coordinator').length,1);assert.ok(agents.filter(agent=>agent.id!=='coordinator').every(agent=>agent.assignment.canWrite===false&&agent.sandbox==='read-only'));assert.ok(agents.every(agent=>agent.model==='cloud::chosen'));assert.equal(f.closed(),1);
});

test('swarm submit is exclusive while saving and failed validation leaves its form available',async t=>{
  let release;const f=fixture(t,{onWorkflow:()=>new Promise(resolve=>{release=resolve;})});f.ui.openSwarm();const form=f.elements.get('#swarm-form');form.values.members='1.2';await f.submit(form);assert.equal(f.created.length,0);assert.match(f.messages.at(-1).message,/positive whole number/);assert.equal(f.closed(),0);
  form.values.members='40';const saving=f.submit(form);await f.submit(form);assert.equal(f.created.length,1);assert.equal(f.created[0].settings.maxParallel,40);release();await saving;assert.equal(f.closed(),1);
});

test('waiting for a workflow never replaces a newer modal or a newer workspace view',async t=>{
  let release;const f=fixture(t,{getWorkflow:()=>new Promise(resolve=>{release=resolve;})});const pending=f.ui.deployWorkflow();f.replaceModal('other','Another dialog');release(workflow());await pending;assert.equal(f.modals.at(-1).id,'other');assert.equal(f.modals.filter(modal=>modal.id==='deployment').length,0);
  const next=f.ui.deployWorkflow();f.navigate();release(workflow());await next;assert.equal(f.modals.at(-1).id,'other');assert.equal(f.modals.filter(modal=>modal.id==='deployment').length,0);
});

for(const failure of [false,true])test(`a late operation save ${failure?'failure':'success'} cannot replace or report errors in a newer swarm dialog`,async t=>{
  let release,reject;const f=fixture(t,{api:(path,method)=>method==='POST'?new Promise((resolve,no)=>{release=resolve;reject=no;}):undefined});await f.ui.deployWorkflow();const form=f.elements.get('#deployment-form'),saving=f.submit(form);f.ui.openSwarm();const newForm=f.elements.get('#swarm-form');
  if(failure)reject(new Error('Old operation save failed.'));else release({});await saving;assert.equal(f.modals.at(-1).id,'swarm');assert.strictEqual(f.elements.get('#swarm-form'),newForm);assert.equal(f.requests.filter(request=>request.path==='/api/operations').length,0);assert.deepEqual(f.messages,[]);
  await f.submit(newForm);assert.equal(f.created.length,1,'a pending or completed older modal cannot lock an unrelated form');assert.equal(f.closed(),1);
});

test('a pending older save does not block a new modal and cannot clear its busy guard',async t=>{
  let releaseOperation,releaseSwarm;const f=fixture(t,{api:(path,method)=>method==='POST'?new Promise(resolve=>{releaseOperation=resolve;}):undefined,onWorkflow:()=>new Promise(resolve=>{releaseSwarm=resolve;})});await f.ui.deployWorkflow();const operationSaving=f.submit(f.elements.get('#deployment-form'));f.ui.openSwarm();const swarm=f.elements.get('#swarm-form'),swarmSaving=f.submit(swarm);assert.equal(f.created.length,1);releaseOperation({});await operationSaving;await f.submit(swarm);assert.equal(f.created.length,1,'older completion cannot unlock the current submission');releaseSwarm();await swarmSaving;assert.equal(f.closed(),1);
});

test('swarm adoption receives an ownership guard and late completion cannot close another dialog',async t=>{
  let release,ownership;const f=fixture(t,{onWorkflow:(value,context)=>{ownership=context;return new Promise(resolve=>{release=resolve;});}});f.ui.openSwarm();const saving=f.submit(f.elements.get('#swarm-form'));assert.equal(ownership.isCurrent(),true);f.replaceModal('other','Keep this dialog');assert.equal(ownership.isCurrent(),false);release(false);await saving;assert.equal(f.closed(),0);assert.equal(f.modals.at(-1).id,'other');
});

test('successful owned swarm adoption can change the workspace view and still close its own dialog',async t=>{
  let f;f=fixture(t,{onWorkflow:async(value,context)=>{assert.equal(context.isCurrent(),true);f.navigate();return true;}});f.ui.openSwarm();await f.submit(f.elements.get('#swarm-form'));assert.equal(f.closed(),1);
});

test('out-of-order Operations refreshes keep the newest mounted view',async t=>{
  const releases=[];const f=fixture(t,{api:path=>path==='/api/operations'?new Promise(resolve=>releases.push(resolve)):undefined}),old=f.ui.openOperations(),newer=f.ui.openOperations();
  releases[1]({status:{paused:false,running:17,queued:0},deployments:[],jobs:[]});await newer;const view=f.elements.get('#operations-view');assert.match(view.innerHTML,/17 running/);
  releases[0]({status:{paused:false,running:1,queued:0},deployments:[],jobs:[]});await old;assert.strictEqual(f.elements.get('#operations-view'),view);assert.match(view.innerHTML,/17 running/);assert.doesNotMatch(view.innerHTML,/1 running/);
});

test('Schedule a task creates a separate task with current preferences and never reads the selected workflow or chat draft',async t=>{
  const prefs={cwd:'C:\\current-chat',model:'cloud::chosen',effort:'ultra',desktop:true,context:{preset:'900k'},task:'UNSENT_CHAT_DRAFT',attachmentIds:['PRIVATE_CHAT_ATTACHMENT']},before=structuredClone(prefs),f=fixture(t,{getWorkflow:()=>{throw new Error('Unrelated workflow must not be read.');},getTaskDefaults:()=>prefs});
  await f.ui.openSchedule();const modal=f.modals.at(-1),form=f.elements.get('#deployment-form');assert.match(modal.html,/<h2>Schedule a task/);assert.match(modal.html,/name="trigger"/);assert.match(modal.html,/name="timezone"/);assert.match(modal.html,/name="model"/);assert.doesNotMatch(modal.html,/UNSENT_CHAT_DRAFT|PRIVATE_CHAT_ATTACHMENT/);assert.ok(modal.html.indexOf('What should BLACKICE do?')<modal.html.indexOf('Task options'));assert.equal(form.elements.enabled.checked,true);assert.equal(f.requests.filter(r=>r.path==='/api/operations/deployments').length,0,'opening setup creates nothing');
  form.values.name='';form.values.cwd=prefs.cwd;form.values.input='Read the project and report progress';form.values.trigger='weekdays';form.values.time='08:30';form.values.timezone='America/New_York';await f.submit(form);
  const saved=f.requests.find(r=>r.path==='/api/operations/deployments');assert.deepEqual(saved.body.trigger,{type:'cron',expression:'30 8 * * 1-5',timezone:'America/New_York'});assert.equal(saved.body.name,form.values.input);assert.equal(saved.body.workflow.nodes.find(n=>n.type==='agent').model,'cloud::chosen');assert.equal(saved.body.workflow.nodes.find(n=>n.type==='agent').effort,'ultra');assert.equal(saved.body.workflow.nodes.find(n=>n.type==='agent').desktop,true);assert.deepEqual(saved.body.workflow.settings.context,{preset:'900k'});assert.equal(saved.body.workflow.settings.cwd,prefs.cwd);assert.deepEqual(saved.body.attachmentIds,[]);assert.deepEqual(prefs,before);assert.equal(f.modals.at(-1).id,'operations');
});

test('Make repeatable carries the admitted workflow and files without enabling or starting a job',async t=>{
  const graph=workflow();graph.nodes.find(node=>node.type==='agent').effort='ultra';graph.settings.context={preset:'900k'};
  const seed={repeatTask:true,input:'Repeat the checked task.',cwd:'C:\\admitted-workspace',workflow:graph,attachmentIds:['admitted-file']},before=structuredClone(seed),f=fixture(t,{getWorkflow:()=>{throw Error('Selected editor workflow must not be read.');},getTaskDefaults:()=>({task:'UNSENT_DRAFT',model:'unrelated::model',attachmentIds:['UNSENT_FILE']})});
  await f.ui.openSchedule(seed);const modal=f.modals.at(-1),form=f.elements.get('#deployment-form');assert.match(modal.html,/<h2>Make repeatable/);assert.match(modal.html,/Repeat the checked task/);assert.match(modal.html,/C:\\admitted-workspace/);assert.doesNotMatch(modal.html,/UNSENT_DRAFT|UNSENT_FILE|unrelated::model|name="model"/);assert.equal(form.elements.enabled.checked,false);assert.equal(f.requests.some(request=>request.path==='/api/operations/deployments'),false);
  form.values.input=seed.input;form.values.cwd=seed.cwd;form.values.trigger='manual';await f.submit(form);const saved=f.requests.find(request=>request.path==='/api/operations/deployments');assert.equal(saved.body.enabled,false);assert.deepEqual(saved.body.trigger,{type:'manual'});assert.deepEqual(saved.body.workflow,graph);assert.deepEqual(saved.body.attachmentIds,['admitted-file']);assert.deepEqual(seed,before);
});

test('calendar fields disclose only relevant controls and invalid recurrence stays editable without creating work',async t=>{
  const f=fixture(t);await f.ui.openSchedule();const form=f.elements.get('#deployment-form');assert.equal(f.elements.get('#deployment-time').hidden,false);assert.equal(f.elements.get('#deployment-weekday').hidden,true);assert.equal(f.elements.get('#deployment-cron').hidden,true);assert.equal(f.elements.get('#deployment-interval').hidden,true);
  form.values.trigger='weekly';form.elements.trigger.value='weekly';form.elements.trigger.onchange();assert.equal(f.elements.get('#deployment-weekday').hidden,false);
  form.values.time='25:00';await f.submit(form);assert.equal(f.requests.filter(r=>r.path==='/api/operations/deployments').length,0);assert.match(f.elements.get('#deployment-error').textContent,/valid time/);assert.equal(f.modals.at(-1).id,'deployment');
  form.values.trigger='cron';form.elements.trigger.value='cron';form.elements.trigger.onchange();assert.equal(f.elements.get('#deployment-time').hidden,true);assert.equal(f.elements.get('#deployment-cron').hidden,false);assert.equal(f.elements.get('#deployment-timezone').hidden,false);
});

test('schedule previews are read only, keep the newest choice and cannot update a replacement dialog',async t=>{
  const pending=[],f=fixture(t,{api:path=>path==='/api/operations/schedule-preview'?new Promise((resolve,reject)=>pending.push({resolve,reject})):undefined});await f.ui.openSchedule();const form=f.elements.get('#deployment-form'),preview=f.elements.get('#deployment-preview');assert.equal(pending.length,1);
  form.values.time='10:00';form.onchange({target:{name:'time'}});assert.equal(pending.length,2);pending[1].resolve({occurrences:[{local:'Tomorrow at 10:00 UTC'}]});await new Promise(resolve=>setImmediate(resolve));assert.match(preview.textContent,/10:00/);pending[0].resolve({occurrences:[{local:'Old time at 09:00'}]});await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch(preview.textContent,/09:00/);
  form.values.time='11:00';form.onchange({target:{name:'time'}});const oldText=preview.textContent;f.ui.openSwarm();pending[2].reject(new Error('Old preview failure'));await new Promise(resolve=>setImmediate(resolve));assert.equal(preview.textContent,oldText);assert.equal(f.modals.at(-1).id,'swarm');assert.equal(f.messages.length,0);assert.equal(f.requests.filter(r=>r.path==='/api/operations/deployments').length,0);
});

test('saved schedules describe local recurrence, next time and pause state in the manager',async t=>{
  const deployment={id:'calendar',name:'Morning task',revision:1,input:'Read actual work',cwd:'C:\\fixture',workflow:workflow(),trigger:{type:'cron',expression:'0 9 * * 1-5',timezone:'America/New_York'},overlap:'parallel',retry:{maxAttempts:0,backoffSeconds:30},enabled:true,nextAt:Date.UTC(2026,9,19,13)},f=fixture(t,{deployments:[deployment],api:path=>path==='/api/operations'?{status:{paused:true,running:0,queued:0},deployments:[deployment],jobs:[]}:undefined});
  await f.ui.openOperations();const html=f.elements.get('#operations-view').innerHTML;assert.match(html,/Weekdays at 09:00/);assert.match(html,/America\/New_York/);assert.match(html,/Next:/);assert.match(html,/Schedules are paused/);assert.match(html,/data-op="schedule"/);assert.match(f.modals.at(-1).html,/Schedules &amp; cronjobs/);
});

test('creating a swarm explains parallel work and hands adoption a task-entry intent without starting a run',async t=>{
  let context;const f=fixture(t,{onWorkflow:(workflow,value)=>{context=value;}});f.ui.openSwarm();assert.match(f.modals.at(-1).html,/Choose your team. Next, give it a task/);assert.match(f.modals.at(-1).html,/Creating a team starts no work/);assert.match(f.modals.at(-1).html,/Create &amp; give task/);assert.match(f.modals.at(-1).html,/<div class="modal-footer"><button type="button" class="button" data-action="projects">Back to saved swarms<\/button><button type="submit"/);assert.equal(f.created.length,0,'returning to the library must not adopt or start the one-off team');await f.submit(f.elements.get('#swarm-form'));assert.equal(context.requestTask,true);assert.equal(f.requests.length,0,'creating a team never launches a task or touches operational queues');
});

test('unchanged manager polls preserve mounted rows and their handler while changed status, errors and fresh modals render',async t=>{
  let status={paused:false,running:0,queued:0},jobs=[];const f=fixture(t,{api:path=>path==='/api/operations'?{status:structuredClone(status),deployments:[],jobs:structuredClone(jobs)}:undefined});
  await f.ui.openOperations();const view=f.elements.get('#operations-view'),handler=view.onclick,writes=view.htmlWrites;view.focusedRow={name:'Run now'};
  await f.ui.refresh();await f.ui.refresh();assert.equal(view.htmlWrites,writes,'identical fresh JSON does not replace DOM rows or keyboard focus');assert.equal(view.onclick,handler);assert.deepEqual(view.focusedRow,{name:'Run now'});
  status.running=1;await f.ui.refresh();assert.equal(view.htmlWrites,writes+1);assert.match(view.innerHTML,/1 running/);
  status.error='<img src=x onerror=run()>';await f.ui.refresh();assert.equal(view.htmlWrites,writes+2);assert.match(view.innerHTML,/&lt;img src=x onerror=run\(\)&gt;/);assert.doesNotMatch(view.innerHTML,/<img/);
  jobs=[{id:'job',deploymentName:'New run',status:'queued',attempts:[],createdAt:'2026-10-16T12:00:00Z'}];await f.ui.refresh();assert.equal(view.htmlWrites,writes+3);assert.match(view.innerHTML,/New run/);
  await f.ui.openOperations();const replacement=f.elements.get('#operations-view');assert.notEqual(replacement,view);assert.equal(replacement.htmlWrites,1,'a new modal always paints even with the same snapshot');assert.match(replacement.innerHTML,/New run/);
});

test('held external-action receipts explain recovery and open the original run without offering a fresh Retry',async t=>{
 const job={id:'held',deploymentId:'d',deploymentName:'Publication',status:'failed',createdAt:'2026-10-17T12:00:00Z',error:'Connection ended',attempts:[{number:1,runId:'latest-run',status:'failed',createdAt:'2026-10-17T12:00:00Z',finishedAt:'2026-10-17T12:01:00Z'}],retryHold:{runId:'original-run',message:'Inspect the original task before sending again.',receipts:[{id:'post',status:'uncertain'}]}},f=fixture(t,{api:path=>path==='/api/operations'?{status:{paused:false},deployments:[],jobs:[job]}:undefined});
 await f.ui.openOperations();const html=f.elements.get('#operations-view').innerHTML;assert.match(html,/Inspect the original task before sending again/);assert.match(html,/data-op="open"[^>]*data-id="original-run">Inspect original run/);assert.match(html,/uncertain external-action receipt/);assert.doesNotMatch(html,/data-op="retry"/);assert.match(html,/Execution history/);assert.match(html,/data-phase="attention"/);assert.equal(f.requests.filter(request=>request.method==='POST').length,0);
});

for(const [status,label] of [['running','Working'],['completed','Completed']])test(`a ${status} job with retained external receipts keeps its actual progress and ordinary inspection action`,async t=>{
 const job={id:'publication',deploymentId:'d',deploymentName:'Publication',status,createdAt:'2026-10-17T12:00:00Z',attempts:[{number:1,runId:'actual-run',status,createdAt:'2026-10-17T12:00:00Z'}],retryHold:{runId:'original-run',message:'Recovery warning applies only if this task fails.',receipts:[{id:'post',status:'confirmed'}]}},f=fixture(t,{api:path=>path==='/api/operations'?{status:{paused:false},deployments:[],jobs:[job]}:undefined});
 await f.ui.openOperations();const html=f.elements.get('#operations-view').innerHTML;assert.match(html,new RegExp(`<span class="operation-status">${label}</span>`));assert.match(html,/data-op="open"[^>]*data-id="actual-run">Observe/);assert.doesNotMatch(html,/Recovery warning applies|Inspect original run|data-op="retry"/);
});

test('job filters and pagination reveal older failures without starting, retrying or editing any work',async t=>{
 const jobs=[...Array.from({length:85},(_,index)=>({id:'job-'+index,deploymentId:'a',deploymentName:'Completed '+index,status:'completed',createdAt:'2026-10-17T12:00:00Z',attempts:[]})),{id:'old-failure',deploymentId:'a',deploymentName:'Older failed task',status:'failed',createdAt:'2026-10-16T12:00:00Z',attempts:[]}],f=fixture(t,{api:path=>path==='/api/operations'?{status:{paused:false},deployments:[],jobs}:undefined});
 await f.ui.openOperations();const view=f.elements.get('#operations-view');assert.match(view.innerHTML,/Showing 40 of 86/);assert.doesNotMatch(view.innerHTML,/data-job="old-failure"/);
 await view.onclick({target:{closest:()=>({dataset:{op:'filter',id:'attention'}})}});assert.match(view.innerHTML,/Showing 1 of 1/);assert.match(view.innerHTML,/Older failed task/);
 await view.onclick({target:{closest:()=>({dataset:{op:'filter',id:'all'}})}});await view.onclick({target:{closest:()=>({dataset:{op:'more'}})}});assert.match(view.innerHTML,/Showing 80 of 86/);await view.onclick({target:{closest:()=>({dataset:{op:'more'}})}});assert.match(view.innerHTML,/Showing 86 of 86/);assert.match(view.innerHTML,/Older failed task/);assert.equal(f.requests.filter(request=>request.method!=='GET').length,0);
});

test('failed initial operation reads keep a recoverable view and silent poll failures never spam toasts',async t=>{
 let failed=true;const f=fixture(t,{api:path=>{if(path==='/api/operations'){if(failed)throw Error('Offline');return{status:{paused:true},deployments:[],jobs:[]};}}});await f.ui.openOperations();let view=f.elements.get('#operations-view');assert.match(view.innerHTML,/Could not load schedules/);assert.match(view.innerHTML,/Try again/);assert.equal(f.messages.length,1);
 failed=false;await view.onclick({target:{closest:()=>({dataset:{op:'refresh'}})}});assert.match(view.innerHTML,/Schedules are paused/);failed=true;await f.ui.refresh({silent:true});assert.match(view.innerHTML,/Displaying the last loaded receipts/);assert.equal(f.messages.length,1);assert.match(view.innerHTML,/Schedules are paused/);
});

test('local job filters retain a failed-poll warning until a successful refresh clears it',async t=>{
 let failed=false;const f=fixture(t,{api:path=>{if(path==='/api/operations'){if(failed)throw Error('Offline after load');return{status:{paused:false,healthy:true},deployments:[],jobs:[]};}}});await f.ui.openOperations();const view=f.elements.get('#operations-view');failed=true;await f.ui.refresh({silent:true});assert.match(view.innerHTML,/Displaying the last loaded receipts/);
 await view.onclick({target:{closest:()=>({dataset:{op:'filter',id:'attention'}})}});assert.match(view.innerHTML,/Updates unavailable\. Displaying the last loaded receipts\. Offline after load/);assert.equal(f.messages.length,0);
 failed=false;await f.ui.refresh({silent:true});assert.doesNotMatch(view.innerHTML,/Updates unavailable|Offline after load/);assert.equal(f.elements.get('#operations-error').textContent,'');assert.equal(f.messages.length,0);
});

test('a poll slower than the timer interval is allowed to arrive and the next tick resumes after it settles',async t=>{
 let reads=0,release;const result=running=>({status:{paused:false,running,queued:0},deployments:[],jobs:[]}),f=fixture(t,{api:path=>{if(path==='/api/operations'){reads++;return reads===2?new Promise(resolve=>{release=resolve;}):result(reads);}}});await f.ui.openOperations();const view=f.elements.get('#operations-view'),pending=f.poll();await f.poll();await f.poll();assert.equal(reads,2,'later timer ticks share the outstanding read instead of invalidating it');release(result(9));await pending;assert.match(view.innerHTML,/9 running/);await f.poll();assert.equal(reads,3);assert.match(view.innerHTML,/3 running/);
});

test('an explicit refresh supersedes a pending poll without an older completion clearing its new polling gate',async t=>{
 let reads=0;const pending=[],result=running=>({status:{paused:false,running,queued:0},deployments:[],jobs:[]}),f=fixture(t,{api:path=>{if(path==='/api/operations'){reads++;return reads===1?result(1):new Promise(resolve=>pending.push(resolve));}}});await f.ui.openOperations();const oldPoll=f.poll(),manual=f.ui.refresh();assert.equal(reads,3);pending[0](result(2));await oldPoll;await f.poll();assert.equal(reads,3,'the older poll cannot unlock the newer explicit read');pending[1](result(12));await manual;assert.match(f.elements.get('#operations-view').innerHTML,/12 running/);const next=f.poll();assert.equal(reads,4);pending[2](result(13));await next;assert.match(f.elements.get('#operations-view').innerHTML,/13 running/);
});

test('an abandoned view cannot block replacement polling or report its delayed error in the replacement dialog',async t=>{
 let reads=0,rejectOld;const result=running=>({status:{paused:false,running,queued:0},deployments:[],jobs:[]}),f=fixture(t,{api:path=>{if(path==='/api/operations'){reads++;return reads===2?new Promise((resolve,reject)=>{rejectOld=reject;}):result(reads);}}});await f.ui.openOperations();const old=f.elements.get('#operations-view'),pending=f.poll();await f.ui.openOperations();const current=f.elements.get('#operations-view');assert.notEqual(current,old);await f.poll();assert.equal(reads,4);assert.match(current.innerHTML,/4 running/);rejectOld(Error('Abandoned request failed'));await pending;assert.doesNotMatch(current.innerHTML,/Abandoned request failed|Updates unavailable/);assert.equal(f.messages.length,0);
});

test('changed receipts restore expanded history before scroll and preserve the exact duplicate control that held focus',async t=>{
 let running=1;const job={id:'job',deploymentId:'d',deploymentName:'Task',status:'running',createdAt:'2026-10-17T12:00:00Z',attempts:[{number:1,status:'running',runId:'actual-run',createdAt:'2026-10-17T12:00:00Z'}]},f=fixture(t,{api:path=>path==='/api/operations'?{status:{paused:false,running,queued:0},deployments:[],jobs:[job]}:undefined});await f.ui.openOperations();const view=f.elements.get('#operations-view'),htmlProperty=Object.getOwnPropertyDescriptor(view,'innerHTML');let mounted,scroll=0;
 const mount=html=>{
  const details=[...html.matchAll(/<details\b[^>]*data-op-detail="([^"]+)"[^>]*>/g)].map(match=>({dataset:{opDetail:match[1]},open:false,querySelector:()=>({})}));
  const controls=[...html.matchAll(/<button\b([^>]*)>/g)].filter(match=>match[1].includes('data-op=')).map(match=>{const attr=name=>new RegExp(`${name}="([^"]*)"`).exec(match[1])?.[1],node={dataset:{op:attr('data-op'),opKey:attr('data-op-key'),id:attr('data-id')},focus(options){node.focusOptions=options;document.activeElement=node;},closest(){return node.dataset.opKey?.startsWith('attempt:')?details.find(item=>item.dataset.opDetail==='attempts:job'):null;}};return node;});return{details,controls};
 };
 mounted=mount(view.innerHTML);view.querySelectorAll=selector=>selector==='[data-op-detail]'?mounted.details:selector==='[data-op]'?mounted.controls:[];view.contains=node=>mounted.controls.includes(node);
 Object.defineProperty(view,'scrollTop',{get:()=>scroll,set:value=>{scroll=Math.min(value,mounted.details.some(item=>item.open)?700:116);}});
 Object.defineProperty(view,'innerHTML',{get:()=>htmlProperty.get.call(view),set:html=>{htmlProperty.set.call(view,html);mounted=mount(html);scroll=Math.min(scroll,116);document.activeElement=null;}});
 mounted.details.find(item=>item.dataset.opDetail==='attempts:job').open=true;view.scrollTop=289;document.activeElement=mounted.controls.find(node=>node.dataset.opKey==='job:job');assert.ok(document.activeElement);running=2;await f.ui.refresh();assert.equal(view.scrollTop,289,'restoring scroll before open history would clamp it to the collapsed height');assert.equal(mounted.details.find(item=>item.dataset.opDetail==='attempts:job').open,true);assert.equal(document.activeElement.dataset.opKey,'job:job','the primary action does not jump into the earlier duplicate attempt control');assert.deepEqual(document.activeElement.focusOptions,{preventScroll:true});
 document.activeElement=mounted.controls.find(node=>node.dataset.opKey==='filter:active');assert.ok(document.activeElement);running=3;await f.ui.refresh();assert.equal(document.activeElement.dataset.opKey,'filter:active','history filter focus does not jump to its earlier overview counterpart');assert.equal(view.scrollTop,289);
});


test('removed schedules explain stopped retries, retain the observed failure, and keep only supported retry controls',async t=>{
 const reason='The deployment was removed. No further retry attempts will start.',attempt={number:1,runId:'observed-run',status:'failed',createdAt:'2026-10-19T09:00:00Z',finishedAt:'2026-10-19T09:01:00Z',error:'Observed tool failure'},removed={id:'removed-job',deploymentId:'removed',deploymentName:'Removed schedule',status:'failed',createdAt:attempt.createdAt,error:attempt.error,retryStoppedReason:reason,attempts:[attempt]},kept={...removed,id:'kept-job',deploymentId:'kept',deploymentName:'Kept schedule',retryStoppedReason:null},deployment={id:'kept',name:'Kept schedule',enabled:false,trigger:{type:'manual'},overlap:'queue',retry:{maxAttempts:1,backoffSeconds:30}};
 const f=fixture(t,{api:path=>path==='/api/operations'?{status:{paused:false},deployments:[deployment],jobs:[removed,kept]}:undefined});
 await f.ui.openOperations();const html=f.elements.get('#operations-view').innerHTML;
 const removedHTML=html.match(/<article class="operation-job" data-job="removed-job"[\s\S]*?<\/article>/)[0],keptHTML=html.match(/<article class="operation-job" data-job="kept-job"[\s\S]*?<\/article>/)[0];
 assert.ok(removedHTML.includes(reason));assert.match(removedHTML,/Observed tool failure/);assert.match(removedHTML,/data-op="open"[^>]*data-id="observed-run"/);assert.doesNotMatch(removedHTML,/data-op="retry"/);
 assert.match(keptHTML,/data-op="retry"/);assert.equal(f.requests.filter(request=>request.method==='POST').length,0);
});

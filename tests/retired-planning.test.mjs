import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PLANNING_MODES,PLANNING_MODE_OPTIONS,PLANNING_INPUT_MODES,planningGuardrailsRequired,normalizePlanningMode} from '../public/planning-mode.mjs';
import {planningModeOf} from '../lib/planning-policy.mjs';
import {planningExecutionModeOf,assertExecutablePlanningMode} from '../public/response-cycle-model.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {normalizeChatOptions,restoreChatPlanningOptions,validateChatOptions,savedChatExecutionMode} from '../public/next/chat/options-model.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
import {submitChat} from '../public/next/chat/send.mjs';
import {createChatWorkspace} from '../public/next/chat/chat.mjs';
import {createChatFrame} from '../public/next/chat/render.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {HarnessEngine,validateWorkflow} from '../lib/engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {normalizePlanningOntology} from '../public/planning-module-policy.mjs';
import {readConversationOntology} from '../public/next/chat/ontology-preferences.mjs';
import {createScheduledChatWorkflow,scheduleChatOptionsMarkup} from '../public/next/workspaces/schedule-inspection-model.mjs';

test('only Modules and Off remain selectable; historical aliases are inert and cannot impose a planning gate',t=>{
  assert.deepEqual(PLANNING_MODES,['ontology','off']);
  assert.deepEqual(PLANNING_MODE_OPTIONS.map(x=>x.label),['Modules','Off']);
  for(const mode of ['forced','advisory','on','auto','maximal']){
    assert.ok(PLANNING_INPUT_MODES.includes(mode),'older records remain readable');
    assert.equal(normalizePlanningMode(mode),'off');
    assert.equal(planningModeOf(mode),'off');
    assert.equal(planningGuardrailsRequired('on','forced',true),false);
  }
  assert.equal(planningExecutionModeOf('plan_only'),'plan_only','historical record remains legible');
  assert.throws(()=>assertExecutablePlanningMode('plan_only'),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  const options=normalizeChatOptions({planningMode:'forced',planningExecutionMode:'plan_only'});
  assert.equal(options.planningMode,'ontology');
  assert.equal(options.planningExecutionMode,'plan_only','normalization preserves historical no-execution intent');
  assert.throws(()=>validateChatOptions({},options),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  assert.equal(restoreChatPlanningOptions(options).planningExecutionMode,'plan_only');
  assert.throws(()=>assertExecutablePlanningMode('automatic','plan_only'),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  assert.throws(()=>assertExecutablePlanningMode('invalid','plan_only'),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  assert.equal(assertExecutablePlanningMode(undefined,'automatic'),'automatic');
  const dom=planningDOM(t),frame=createChatFrame(dom.mount);
  assert.deepEqual(frame.plan.children.map(o=>o.value),['ontology','off']);
  assert.equal(frame.executionMode.value,'automatic');
  assert.equal(frame.executionMode.tagName,'INPUT');
  assert.doesNotMatch(frame.shell.innerHTML,/Legacy Forced|Legacy Advisory|>Plan only</);
  const existing=readConversationOntology({conversationId:'legacy',runs:[{id:'prior',planningMode:'on',planningEnforcement:'forced'}]});
  assert.equal(existing.planningMode,'ontology','legacy conversation reopens under module policy');
  assert.equal(existing.planningOntology.modules.anti_overalignment,'mandatory');
});

test('a scheduled chat rejects Plan-only and explicit Automatic never restores Forced',()=>{
  const options={planningMode:'forced',planningExecutionMode:'automatic',planningOntology:normalizePlanningOntology({modules:{decomposition:'forbidden'}})};
  assert.throws(()=>createScheduledChatWorkflow({task:'Process candidates',cwd:'C:\\fixture',options:{...options,planningExecutionMode:'plan_only'}}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  const workflow=createScheduledChatWorkflow({task:'Process candidates',cwd:'C:\\fixture',options});
  const verified=validateWorkflow(workflow);
  assert.equal(verified.settings.planningMode,'off');
  assert.equal(verified.settings.planningExecutionMode,'automatic');
  assert.equal(verified.settings.planningEnforcement,undefined);
  assert.equal(verified.settings.planningOntology.modules.decomposition,'forbidden');
  const markup=scheduleChatOptionsMarkup();
  assert.doesNotMatch(markup,/value="forced"|value="advisory"|value="plan_only"/);
  assert.match(markup,/value="ontology"/);
});

test('explicit Plan-only cannot start while old Forced with Automatic still completes useful work',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-retired-planning-'));
  const cwd=path.join(directory,'workspace');await mkdir(cwd);
  const tasks=await new TaskStateStore({dataDir:directory}).init();
  let runCount=0;
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}
    async runAgent(options){
      runCount++;
      assert.match(options.developerInstructions,/MODULAR PLANNING ONTOLOGY/);
      assert.doesNotMatch(options.developerInstructions,/Save this turn.s task outline first|Planning is On. Read/);
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));
      const receipt=await options.onToolCall({name:'relay_workspace',arguments:{action:'write',path:'leaf'+runCount+'.txt',text:'completed-'+runCount}});
      assert.equal(receipt.success,true,JSON.stringify(receipt));
      return{output:'Completed '+runCount,threadId:'retired-planning-thread'};
    }
    async close(){}
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),tasks,dataDir:directory,defaultCwd:cwd}).init();
  engine.runtimeSettings={get:()=>({executionGuardrails:true,subagentsEnabled:true})};
  let called=0;
  engine.responseCycle={
    forRun(){called++;throw Error('Retired planner must never start');},
    finishRun(){called++;throw Error('Retired planner must never finalize');},
    settleRun(){called++;throw Error('Retired planner must not settle');},
    captureRunUsage(){called++;throw Error('Retired planner must not meter');},
  };
  const waitFor=async id=>{for(let i=0;i<150;i++){const current=engine.getRun(id);if(current?.settled)return current;await new Promise(r=>setTimeout(r,10));}throw Error('Agent did not settle');};
  t.after(async()=>{await engine.close();await tasks.close();await rm(directory,{recursive:true,force:true});});
  const workflow=createMissionWorkflow({task:'Finish without old Planning',model:'fixture-model',cwd,planningMode:'ontology'});
  assert.throws(()=>engine.startRun({workflow,input:{task:'Do not execute',cwd,planningMode:'forced',planningExecutionMode:'plan_only'}}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  let admissions=0;
  const admit=engine.admittedClientRequest.bind(engine);
  engine.admittedClientRequest=(...args)=>{admissions++;return admit(...args);};
  for(const [inputMode,requestMode,workflowMode] of [
    ['plan_only','automatic','automatic'],['automatic','plan_only','automatic'],
    ['automatic','automatic','plan_only'],[undefined,undefined,'plan_only'],
    ['invalid','automatic','plan_only'],
  ]){
    const requested=structuredClone(workflow);requested.settings.planningExecutionMode=workflowMode;
    assert.throws(()=>engine.startRun({workflow:requested,planningExecutionMode:requestMode,
      requestId:'retired_start_'+admissions,input:{task:'Do not execute',cwd,planningExecutionMode:inputMode}}),
      {code:'PLANNING_EXECUTION_MODE_RETIRED'});
  }
  assert.equal(admissions,0,'retirement precedes receipt admission even for conflicting sources');
  assert.equal(engine.runs.size,0);
  assert.equal(runCount,0,'rejected without a provider turn');
  const started=engine.startRun({workflow,input:{task:'Finish without old Planning',cwd,planningMode:'forced',planningExecutionMode:'automatic'}});
  const complete=await waitFor(started.id);
  assert.equal(complete.status,'completed',complete.error||complete.nodes.agent?.error);
  assert.equal(complete.planningMode,'off');
  assert.equal(complete.planningExecutionMode,'automatic');
  assert.equal(complete.runtimeSettings.planningGuardrails,false);
  assert.equal(complete.planningOntology.modules.anti_overalignment,'mandatory');
  assert.equal(await readFile(path.join(cwd,'leaf1.txt'),'utf8'),'completed-1');
  assert.equal(called,0,'no extra model pass or response-cycle operation');
  assert.equal(runCount,1);
  const next=engine.continueRun(complete.id,{nodeId:'agent',message:'Continue useful work'});
  const continued=await waitFor(next.id);
  assert.equal(continued.status,'completed',continued.error||continued.nodes.agent?.error);
  assert.equal(continued.planningOntology.modules.anti_overalignment,'mandatory');
  assert.equal(await readFile(path.join(cwd,'leaf2.txt'),'utf8'),'completed-2');
  assert.equal(runCount,2);
  assert.equal(called,0);
  const retrySource=structuredClone(continued);retrySource.id='synthetic-automatic-retry';
  retrySource.status='failed';retrySource.nodes.agent.status='failed';retrySource.nodes.agent.output='';
  engine.runs.set(retrySource.id,retrySource);
  const retried=await waitFor(engine.retryRun(retrySource.id).id);
  assert.equal(retried.status,'completed',retried.error||retried.nodes.agent?.error);
  assert.equal(retried.planningExecutionMode,'automatic');
  assert.equal(await readFile(path.join(cwd,'leaf3.txt'),'utf8'),'completed-3');
  assert.equal(runCount,3);assert.equal(called,0);
});

test('restored settings-only and conflicting Plan-only runs remain readable but cannot be admitted',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-retired-restore-'));
  const workflow=createMissionWorkflow({task:'Saved no-execution request',model:'fixture-model',cwd:directory,planningMode:'ontology'});
  const saved=[
    {id:'settings-only',planningExecutionMode:undefined,settingsMode:'plan_only'},
    {id:'settings-conflict',planningExecutionMode:'automatic',settingsMode:'plan_only'},
    {id:'top-conflict',planningExecutionMode:'plan_only',settingsMode:'automatic'},
  ].map(({id,planningExecutionMode,settingsMode})=>{
    const graph=structuredClone(workflow);graph.settings.planningExecutionMode=settingsMode;
    return {id,taskId:id,workflowId:graph.id,workflowName:graph.name,workflow:graph,input:'Saved no-execution request',cwd:directory,
      planningMode:'off',...(planningExecutionMode===undefined?{}:{planningExecutionMode}),status:'failed',settled:true,
      createdAt:'2026-11-11T12:00:00Z',finishedAt:'2026-11-11T12:01:00Z',events:[],output:'Saved result',
      nodes:Object.fromEntries(graph.nodes.map(node=>[node.id,{status:node.type==='agent'?'failed':'completed',output:'Saved '+node.id}]))};
  });
  await writeFile(path.join(directory,'runs.json'),JSON.stringify(saved));
  let providerTurns=0;
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}
    async runAgent(){providerTurns++;throw Error('No provider turn is allowed');}
    async close(){}
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:directory,defaultCwd:directory}).init();
  t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
  let admissions=0,connections=0;
  engine.admittedClientRequest=()=>{admissions++;throw Error('No admission is allowed');};
  engine.assertConnections=()=>{connections++;throw Error('No connection check is allowed');};
  for(const savedRun of saved){
    const previous=engine.runs.get(savedRun.id),snapshot=structuredClone(previous);
    assert.equal(engine.getRun(savedRun.id).output,'Saved result');
    assert.equal(previous.planningExecutionMode,savedRun.planningExecutionMode);
    assert.equal(previous.workflow.settings.planningExecutionMode,savedRun.workflow.settings.planningExecutionMode);
    for(const requestedMode of [undefined,'automatic']){
      assert.throws(()=>engine.retryRun(previous.id,{planningExecutionMode:requestedMode}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
      assert.throws(()=>engine.continueRun(previous.id,{nodeId:'agent',message:'Continue',planningExecutionMode:requestedMode,requestId:'retired_continue'}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
    }
    const candidate={...structuredClone(previous),id:previous.id+'-dispatch',planningExecutionMode:'automatic'};
    if(previous.planningExecutionMode==='plan_only')candidate.parentRunId=previous.id;
    const before=structuredClone(candidate);
    assert.throws(()=>engine.dispatchRun(candidate),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
    assert.deepEqual(candidate,before,'dispatch rejects before mutating run settings or removing retained holds');
    const inherited={...structuredClone(previous),id:previous.id+'-child',parentRunId:previous.id,planningExecutionMode:'automatic'};
    inherited.workflow.settings.planningExecutionMode='automatic';
    assert.throws(()=>engine.dispatchRun(inherited),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
    assert.deepEqual(previous,snapshot,'read and rejected operations preserve the saved run');
    assert.throws(()=>engine.resumePlannedRun(previous.id,{}),{status:410,code:'PLANNING_CYCLE_RETIRED'});
    assert.throws(()=>engine.resumeViabilityRun(previous.id,{message:'Continue',planningExecutionMode:'automatic'}),{status:410,code:'PLANNING_CYCLE_RETIRED'});
  }
  for(const hold of [{responseCycle:{state:'paused_after_plan',requestId:'saved-cycle'}},{viability:{awaitingInput:true,requestId:'saved-readiness'}}]){
    const previous={...structuredClone(saved[0]),id:'held-'+Object.keys(hold)[0],planningExecutionMode:'automatic',...hold};
    previous.workflow.settings.planningExecutionMode='automatic';engine.runs.set(previous.id,previous);
    assert.throws(()=>engine.continueRun(previous.id,{nodeId:'agent',message:'Continue'}),{status:410,code:'PLANNING_CYCLE_RETIRED'});
    assert.deepEqual(engine.runs.get(previous.id),previous);
  }
  assert.equal(providerTurns,0);assert.equal(admissions,0);assert.equal(connections,0);
  const persisted=JSON.parse(await readFile(path.join(directory,'runs.json'),'utf8'));
  for(const run of saved){
    const record=persisted.find(item=>item.id===run.id);
    assert.equal(record.planningExecutionMode,run.planningExecutionMode);
    assert.equal(record.workflow.settings.planningExecutionMode,run.workflow.settings.planningExecutionMode);
  }
});

test('chat projection and submit retain every saved no-execution source without API mutation',async()=>{
  for(const [top,setting] of [[undefined,'plan_only'],['automatic','plan_only'],['plan_only','automatic']]){
    const run={id:'saved',taskId:'saved',status:'completed',settled:true,input:'Saved task',output:'Saved answer',events:[],
      planningExecutionMode:top,workflow:{settings:{planningExecutionMode:setting},nodes:[{id:'agent',type:'agent',model:'fixture'}]},
      nodes:{agent:{status:'completed',output:'Saved answer',threadId:'thread-fixture'}}};
    const family=projectFamily({rootId:'saved',runs:[run]}),projected=family.runs[0];
    assert.equal(projected.workflow.settings.planningExecutionMode,setting);
    assert.equal(savedChatExecutionMode(projected),'plan_only');
    const options=restoreChatPlanningOptions({planningExecutionMode:savedChatExecutionMode(projected)});
    assert.equal(options.planningExecutionMode,'plan_only');
    assert.throws(()=>validateChatOptions({},options),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
    let calls=0;
    await assert.rejects(()=>submitChat({api:async()=>{calls++;},runs:family.runs,task:'Continue',planningExecutionMode:'automatic'}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
    assert.equal(calls,0);
  }
});

function mountedChatDOM(t){
 const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),append=prototype.append,type=Object.getOwnPropertyDescriptor(prototype,'type');
 Object.defineProperties(prototype,{
   childNodes:{get(){return this.children;}},lastChild:{get(){return this.children.at(-1)||null;}},
   type:{get:type.get,set(value){this.setAttribute('type',value);}},
 });
 prototype.append=function(...items){for(const item of items)append.call(this,...(item.tagName==='#FRAGMENT'?[...item.children]:[item]));};
 prototype.replaceChildren=function(...items){for(const child of [...this.children])child.remove();this.rawText='';this.append(...items);};
 prototype.showModal=function(){this.open=true;};prototype.close=function(){this.open=false;};prototype.scrollIntoView=function(){};
 dom.document.createDocumentFragment=()=>dom.element('#fragment');
 return dom;
}
test('mounted Plan-only drafts require explicit new-request reset and saved requests stay retired',async t=>{
  const dom=mountedChatDOM(t),stored=new Map([['blackice.next.chatOptions',JSON.stringify({planningExecutionMode:'plan_only'})]]);
  const oldStorage=globalThis.localStorage,oldWorker=globalThis.Worker;
  globalThis.localStorage={getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)};
  const families=new Map([
    ['settings',undefined,'plan_only'],['conflict','automatic','plan_only'],
    ['top','plan_only','automatic'],['automatic','automatic','automatic'],
  ].map(([id,top,setting])=>[id,{rootId:id,state:'active',runs:[{
    id,taskId:id,createdAt:'2026-11-11T12:00:00Z',input:'Saved task',status:'completed',settled:true,
    planningExecutionMode:top,events:[],workflow:{settings:{planningExecutionMode:setting},
      nodes:[{id:'agent',type:'agent',name:'Agent',model:'fixture'}]},
    nodes:{agent:{status:'completed',threadId:'thread-'+id,output:'Saved answer'}}
  }]}]));
  const original=structuredClone(families);
  globalThis.Worker=class {
    handlers=new Map();cancelled=new Set();
    addEventListener(type,handler){this.handlers.set(type,handler);}
    postMessage(packet){
      if(packet.type==='cancel'){this.cancelled.add(packet.id);return;}
      queueMicrotask(()=>{if(!this.cancelled.has(packet.id))this.handlers.get('message')?.({data:{id:packet.id,ok:true,family:projectFamily(structuredClone(families.get(packet.runId)))}});});
    }
    terminate(){}
  };
  const status={cwd:'fixture-workspace',defaultModel:'fixture',models:[{id:'fixture',available:true}]};
  let mutations=0,allowNewRequest=false;const posted=[];
  const api=async(route,method,body)=>{
    if(method==='POST'){
      mutations++;posted.push({route,body:structuredClone(body)});
      if(!allowNewRequest)throw Error('No mutation is allowed');
      if(route==='/api/workflows')return body;
      if(route==='/api/runs'){
        const workflow=structuredClone(body.workflow);
        const run={id:'explicit-new',taskId:'explicit-new',createdAt:'2026-11-11T13:00:00Z',
          status:'completed',settled:true,input:body.input.task,output:'Synthetic new request',events:[],
          planningExecutionMode:body.input.planningExecutionMode,workflow,
          nodes:Object.fromEntries(workflow.nodes.map(node=>[node.id,{status:'completed',output:node.type==='agent'?'Synthetic new request':'',threadId:node.type==='agent'?'thread-explicit-new':undefined}]))};
        families.set(run.id,{rootId:run.id,state:'active',runs:[run]});return run;
      }
      throw Error('Unexpected mutation '+route);
    }
    if(route.startsWith('/api/conversations?'))return{conversations:[]};
    if(route==='/api/attachments')return[];
    if(route==='/api/status')return status;
    throw Error('Unexpected API '+route);
  };
  const workspace=createChatWorkspace({mount:dom.mount,api,events:{subscribe:()=>()=>{}},getStatus:()=>status});
  t.after(()=>{workspace.destroy();if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;});
  const wait=async predicate=>{for(let i=0;i<80;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Mounted chat state did not settle');};
  const rejectSubmit=async()=>{
    const before=mutations;
    dom.$('#next-chat-input').value='Do not run this stale request';
    await dom.$('#next-chat-form').dispatch('submit');
    await wait(()=>dom.$('#next-chat-hint').textContent.includes('Plan-only execution has been retired'));
    assert.equal(mutations,before);
    assert.equal(dom.$('#next-chat-input').value,'Do not run this stale request','rejected submit preserves draft');
  };
  workspace.enter();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(dom.$('#next-chat-execution-mode').value,'plan_only','saved new-chat draft survives startup repaint');
  assert.equal(dom.$('#next-chat-execution-notice').hidden,false);
  assert.match(dom.$('#next-chat-execution-notice').textContent,/Automatic can run tools when you send/);
  await rejectSubmit();
  for(const id of ['settings','conflict','top']){
    workspace.openConversationId(id);
    await wait(()=>workspace.getState().selected===id&&workspace.getState().runCount===1);
    assert.equal(dom.$('#next-chat-execution-mode').value,'plan_only');
    assert.equal(dom.$('#next-chat-execution-notice').hidden,true,'saved requests have no reset action');
    await dom.click('#next-chat-enable-automatic');
    assert.equal(dom.$('#next-chat-execution-mode').value,'plan_only','hidden action cannot reset a saved request');
    const plan=dom.$('#next-chat-plan');plan.value='off';await plan.dispatch('change');
    workspace.updateStatus(status);
    assert.equal(dom.$('#next-chat-execution-mode').value,'plan_only','unrelated choice and refreshed model catalog preserve saved intent');
    await rejectSubmit();
  }
  workspace.openConversationId('automatic');
  await wait(()=>workspace.getState().selected==='automatic'&&workspace.getState().runCount===1);
  assert.equal(dom.$('#next-chat-execution-mode').value,'automatic','ordinary Automatic history remains usable');
  await dom.click('#next-chat-new');
  assert.equal(dom.$('#next-chat-execution-mode').value,'plan_only','opening a different chat does not rewrite the saved new-chat draft');
  assert.deepEqual(families,original,'UI reads and rejects without changing archived records');
  const draft=dom.$('#next-chat-input').value;
  await dom.click('#next-chat-enable-automatic');
  assert.equal(mutations,0,'explicit reset changes only local draft options');
  assert.equal(dom.$('#next-chat-input').value,draft,'explicit reset preserves the current draft text');
  assert.equal(dom.$('#next-chat-execution-mode').value,'automatic');
  assert.equal(dom.$('#next-chat-execution-notice').hidden,true);
  assert.equal(JSON.parse(stored.get('blackice.next.chatOptions')).planningExecutionMode,'automatic');
  workspace.updateStatus(status);
  assert.equal(dom.$('#next-chat-execution-mode').value,'automatic','explicit choice survives repaint');
  allowNewRequest=true;
  dom.$('#next-chat-input').value='Run this new Automatic request';
  await dom.$('#next-chat-form').dispatch('submit');
  await wait(()=>workspace.getState().selected==='explicit-new'&&workspace.getState().runCount===1&&dom.$('#next-chat-hint').textContent.includes('Message sent.'));
  assert.deepEqual(posted.map(item=>item.route),['/api/workflows','/api/runs']);
  assert.equal(posted[0].body.settings.planningExecutionMode,'automatic');
  assert.equal(posted[1].body.input.planningExecutionMode,'automatic');
  assert.equal(posted[1].body.input.task,'Run this new Automatic request');
  allowNewRequest=false;
  workspace.openConversationId('settings');
  await wait(()=>workspace.getState().selected==='settings'&&workspace.getState().runCount===1);
  assert.equal(dom.$('#next-chat-execution-mode').value,'plan_only');
  await dom.click('#next-chat-enable-automatic');
  const planning=dom.$('#next-chat-plan');planning.value='off';await planning.dispatch('change');
  assert.equal(JSON.parse(stored.get('blackice.next.chatOptions')).planningExecutionMode,'automatic','saved-chat edits do not overwrite the explicit new-draft choice');
  await rejectSubmit();assert.equal(mutations,2,'saved request still rejects after a new Automatic request');
  for(const [id,saved] of original)assert.deepEqual(families.get(id),saved,'saved records remain unchanged');
  await dom.click('#next-chat-new');
  assert.equal(dom.$('#next-chat-execution-mode').value,'automatic','explicit new-request choice is retained');
});

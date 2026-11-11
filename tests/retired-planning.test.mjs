import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PLANNING_MODES,PLANNING_MODE_OPTIONS,PLANNING_INPUT_MODES,planningGuardrailsRequired,normalizePlanningMode} from '../public/planning-mode.mjs';
import {planningModeOf} from '../lib/planning-policy.mjs';
import {planningExecutionModeOf,assertExecutablePlanningMode} from '../public/response-cycle-model.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {normalizeChatOptions} from '../public/next/chat/options-model.mjs';
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
  assert.equal(options.planningExecutionMode,'automatic');
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
});

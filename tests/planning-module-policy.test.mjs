import {fixtureOutcomeReview,finishFixtureCandidate} from './fixture-modular-provider.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PLANNING_ONTOLOGY, PLANNING_ONTOLOGY_MODULES, ANTI_OVERALIGNMENT_STOP_CALIBRATION, normalizePlanningOntology, planningOntologyInstructions } from '../public/planning-module-policy.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { planningOntologyDirectTool } from '../lib/planning-ontology-direct-tool.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { normalizeChatOptions, restoreChatPlanningOptions } from '../public/next/chat/options-model.mjs';

const waitFor=async(fn)=>{for(let i=0;i<150;i++){const result=fn();if(result?.settled)return result;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Run did not settle');};
const content=response=>JSON.parse(response.contentItems[0].text);

test('selectable modules retain On/Off choices while retired delegation choices use the default',()=>{
  const base=normalizePlanningOntology();
  assert.equal(base.version,2);assert.equal(Object.hasOwn(base,'autoSelect'),false);
  assert.equal(PLANNING_ONTOLOGY_MODULES.length,9);
  assert.ok(PLANNING_ONTOLOGY_MODULES.every(module=>base.modules[module.id]===true));
  const legacy={version:1,autoSelect:false,modules:{inference:'mandatory',decomposition:'forbidden',subagents:'forbidden'}};
  const before=structuredClone(legacy),custom=normalizePlanningOntology(legacy);
  assert.deepEqual(legacy,before,'Historical input is not rewritten.');
  assert.equal(custom.modules.inference,true);assert.equal(custom.modules.feasibility,true);
  assert.equal(custom.modules.decomposition,false);assert.equal(custom.modules.subagents,true);
  const instructions=planningOntologyInstructions(custom);
  assert.match(instructions,/ON:.*Intent inference/);assert.match(instructions,/OFF:.*Task decomposition/);
  assert.match(instructions,/do not invent extra steps, new hard gates/i);
  assert.doesNotMatch(instructions,/AUTOMATIC SELECTION|MANDATORY:|FORBIDDEN:/);
  assert.match(instructions,/DEFAULT DELEGATION:.*when supported and worthwhile/);
  assert.doesNotMatch(instructions,/^(?:ON|OFF):.*Subagent orchestration/m);
  for(const module of PLANNING_ONTOLOGY_MODULES){
    const policy=normalizePlanningOntology({version:2,modules:{[module.id]:false}});
    const automatic=module.id==='subagents';
    assert.equal(policy.modules[module.id],automatic);assert.equal(Object.values(policy.modules).filter(v=>v===false).length,automatic?0:1);
  }
  for(const value of [{modules:{unknown:true}},{modules:{inference:'forced'}},{autoSelect:'yes'},
    {version:3},{version:2,autoSelect:false},{version:2,modules:{inference:'mandatory'}}])
    assert.throws(()=>normalizePlanningOntology(value),{code:'PLANNING_ONTOLOGY_INVALID'});
  assert.equal(normalizeChatOptions({}).planningMode,'ontology');
  assert.deepEqual(normalizeChatOptions({}).planningOntology,base);
  assert.equal(createMissionWorkflow({task:'Do useful work'}).settings.planningMode,'off');
});

test('old Forced new-chat preference migrates to Modules even when it had an explicit stored policy',()=>{
  const defaultPolicy=normalizePlanningOntology({modules:{inference:'mandatory',anti_overalignment:'mandatory'}});
  const migrated=restoreChatPlanningOptions({model:'default',planningMode:'forced',planningExecutionMode:'automatic'},defaultPolicy);
  assert.equal(migrated.planningMode,'ontology');
  assert.deepEqual(migrated.planningOntology,defaultPolicy);
  const explicitLegacy=restoreChatPlanningOptions({planningMode:'forced',planningOntology:defaultPolicy},null);
  assert.equal(explicitLegacy.planningMode,'ontology');
  const explicitOff=restoreChatPlanningOptions({planningMode:'off'},defaultPolicy);
  assert.equal(explicitOff.planningMode,'off');
  const newChat=restoreChatPlanningOptions({},defaultPolicy);
  assert.equal(newChat.planningMode,'ontology');
  assert.deepEqual(newChat.planningOntology,defaultPolicy);
});

test('anti-overalignment calibrates inference without records-only gates and preserves local real blockers',()=>{
  const instruction=ANTI_OVERALIGNMENT_STOP_CALIBRATION.join(' ');
  for(const expectation of [
    /MINIMUM-SCOPE BLOCKING/,
    /smallest affected field, action, destination or branch/,
    /immediately continue independently actionable leaves/,
    /If one application is blocked, continue other applications/,
    /NO independent authorized work/,
    /User-supplied answers and user uncertainty policy govern/,
    /grounded probability-based inference/,
    /reassess the shared assumption/,
    /quarantine only that affected submission/,
    /never fabricated completion/,
    /No separate per-action checklist/i
  ])assert.match(instruction,expectation);
  const policy=normalizePlanningOntology();
  assert.equal(policy.modules.anti_overalignment,true);
  assert.match(planningOntologyInstructions(policy),/MINIMUM-SCOPE BLOCKING/);
  const explicitOverride=normalizePlanningOntology({modules:{anti_overalignment:'forbidden'}});
  assert.equal(explicitOverride.modules.anti_overalignment,false,'user can still explicitly override the default');
  assert.match(planningOntologyInstructions(explicitOverride),/OFF:[\s\S]*Anti-overalignment calibration/);
});

test('direct ChatGPT ontology tool reads and saves the same runtime default atomically',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-ontology-tool-'));
  const settings=await new RuntimeSettingsStore({dataDir:dir}).init();
  t.after(async()=>{await settings.close();await rm(dir,{recursive:true,force:true});});
  const tool=planningOntologyDirectTool({runtimeSettings:settings});
  assert.equal(tool.definition.name,'blackice_planning_ontology');
  const initial=content(await tool.execute({requestId:'ont-get-1',action:'get'}));
  assert.equal(initial.policy.modules.verification,true);
  assert.equal(initial.modules.length,9);
  const selected={autoSelect:false,modules:{verification:'mandatory',decomposition:'forbidden',subagents:'forbidden'}};
  const result=content(await tool.execute({requestId:'ont-set-1',action:'set',ontology:selected}));
  assert.equal(result.saved,true);
  assert.equal(result.policy.modules.decomposition,false);
  assert.equal(result.activeRunsUnchanged,true);
  assert.deepEqual(result.policy,settings.get().planningOntology);
  assert.deepEqual(JSON.parse(await readFile(settings.file,'utf8')).planningOntology,result.policy);
  assert.equal(content(await tool.execute({requestId:'ont-get-2',action:'get'})).policy.version,2);
  await assert.rejects(tool.execute({requestId:'ont-invalid',action:'set',ontology:{modules:{x:'mandatory'}}}),{code:'PLANNING_ONTOLOGY_INVALID'});
  assert.deepEqual(settings.get().planningOntology,result.policy);
});

test('new ontology chats retain Planning choices and default delegation on continuation',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-ontology-runtime-'));
  const cwd=path.join(directory,'workspace');await mkdir(cwd);
  const tasks=await new TaskStateStore({dataDir:directory}).init();
  class Runtime extends EventEmitter {
    constructor(){super();this.calls=[];}
    status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}
    async runAgent(options){
      const review=fixtureOutcomeReview(options);if(review)return review;
      this.calls.push(options);
      assert.match(options.developerInstructions,/BLACKICE PLANNING MODULES \u2014 ON \/ OFF/);
      assert.match(options.developerInstructions,/MINIMUM-SCOPE BLOCKING/);
      assert.match(options.developerInstructions,/SOURCE AND INFERENCE CALIBRATION/);
      assert.match(options.developerInstructions,/continue other applications/i);
      assert.ok(!options.dynamicTools.some(tool=>tool.name==='relay_task'), 'forbidden decomposition removes task plan tool');
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_delegate'), 'retired subagent choice cannot silently remove default delegation');
      const forbidden=await options.onToolCall({name:'relay_control',arguments:{action:'planning_cycle_create'}});
      assert.equal(forbidden.code,'ONTOLOGY_MODULE_FORBIDDEN','a hidden planning-cycle action may not bypass Forbidden');
      const receipt=await options.onToolCall({name:'relay_workspace',arguments:{action:'write',path:'ontology-proof.txt',text:'tool works without plan'}});
      assert.equal(receipt.success,true,JSON.stringify(receipt));
      return finishFixtureCandidate(options,{output:'Acted without a planning contract.',threadId:'ontology-fixture-thread'});
    }
    async close(){}
  }
  const runtime=new Runtime();
  const engine=await new HarnessEngine({runtime,tasks,dataDir:directory,defaultCwd:cwd}).init();
  engine.runtimeSettings={get:()=>({executionGuardrails:true,subagentsEnabled:true})};
  t.after(async()=>{await engine.close();await tasks.close();await rm(directory,{recursive:true,force:true});});
  const policy=normalizePlanningOntology({autoSelect:true,modules:{decomposition:'forbidden',subagents:'forbidden',verification:'mandatory'}});
  const workflow=createMissionWorkflow({task:'Perform work now',model:'fixture-model',cwd,planningMode:'ontology'});
  const run=engine.startRun({workflow,input:{task:'Perform work now',cwd,planningMode:'ontology',planningOntology:policy}});
  const complete=await waitFor(()=>engine.getRun(run.id));
  assert.equal(complete.status,'completed',complete.error||complete.nodes.agent?.error);
  assert.equal(complete.planningMode,'off');
  assert.deepEqual(complete.planningOntology,policy);
  assert.equal(complete.runtimeSettings.planningGuardrails,false);
  assert.equal(await readFile(path.join(cwd,'ontology-proof.txt'),'utf8'),'tool works without plan');
  assert.equal(runtime.calls.length,1,'one execution turn; read-only outcome review is tracked separately');
  const next=engine.continueRun(complete.id,{nodeId:'agent',message:'Continue',planningMode:'ontology'});
  const continued=await waitFor(()=>engine.getRun(next.id));
  assert.equal(continued.status,'completed',continued.error||continued.nodes.agent?.error);
  assert.deepEqual(continued.planningOntology,policy);
  assert.equal(runtime.calls.length,2,'one execution turn per response, excluding read-only outcome review');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {ExecutionLayerOverrides} from '../lib/execution-layer-overrides.mjs';
import {ToolDescriptionOverrides} from '../lib/tool-description-overrides.mjs';

class Runtime extends EventEmitter{
 constructor(){super();this.received=[];}
 status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',model:'fixture',available:true}]};}
 async runAgent(options){
  this.received.push(options);
  await options.onPromptAccepted?.(options.prompt);
  return{output:'Synthetic fixture: no external side effects.'};
 }
}


test('optional planning guidance is editable and only delivered when Planning is enabled',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-plan-layer-'));
 const runtime=new Runtime(),layers=await new ExecutionLayerOverrides({dataDir}).init();
 const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:dataDir,executionLayers:layers}).init();
 t.after(async()=>{await engine.close();await rm(dataDir,{recursive:true,force:true,maxRetries:12,retryDelay:100});});
 const defs=await engine.executionLayerDefinitions();
 assert.ok(defs.some(row=>row.id==='planning'&&row.role==='developer'));
 assert.ok(defs.some(row=>row.id==='worker-prompt'&&row.role==='prompt'));
 assert.ok(defs.some(row=>row.id==='goal'&&row.role==='developer'));
 await layers.save({action:'replace',id:'planning',text:'USER_PLANNING_LAYER_3355',expectedRevision:0},defs);
 let number=0;
 const invoke=async mode=>{
  const task='Explain the current source content.';
  const flow=createMissionWorkflow({id:'planning_layer_fixture_'+(++number),task,model:'fixture',cwd:dataDir,planningMode:'off'});
  const run=engine.startRun({workflow:flow,input:{task,cwd:dataDir,chatPlanning:mode==='on'?'on':'off',planningMode:'off'}});
  await engine.executions.get(run.id);
  const saved=engine.getRun(run.id);
  assert.equal(saved.status,'completed',saved.error);
  return runtime.received.at(-1);
 };
 const off=await invoke('off');
 assert.doesNotMatch(off.developerInstructions,/USER_PLANNING_LAYER_3355/);
 const on=await invoke('on');
 assert.match(on.developerInstructions,/USER_PLANNING_LAYER_3355/);
});

test('saved layer edits reach model-facing developer, prompt and tool definitions and are captured in immutable audits',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-layer-wire-'));
 const runtime=new Runtime(),layers=await new ExecutionLayerOverrides({dataDir}).init(),
  tools=await new ToolDescriptionOverrides({dataDir}).init();
 const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:dataDir,executionLayers:layers,toolDescriptions:tools}).init();
 t.after(async()=>{await engine.close();await rm(dataDir,{recursive:true,force:true,maxRetries:12,retryDelay:100});});
 const defs=await engine.executionLayerDefinitions();
 let change=await layers.save({action:'replace',id:'capabilities',text:'ROUTING_EFFECTIVE_LAYER_A',expectedRevision:0},defs);
 change=await layers.save({action:'add',title:'My current runtime note',role:'prompt',text:'CUSTOM_PROMPT_LAYER_A',expectedRevision:change.revision},defs);
 const customId=change.affected;
 const known=engine.nativeToolDefinitions();
 const workspace=known.find(item=>item.name==='relay_workspace');
 assert.ok(workspace);
 await tools.save({name:'relay_workspace',description:'WORKSPACE_VISIBLE_OVERRIDE_A',expectedRevision:0},known);
 let seq=0;
 async function invoke(){
  const input='Describe how the workspace tools are available.';
  const flow=createMissionWorkflow({id:'authored_layer_fixture_'+(++seq),task:input,model:'fixture',cwd:dataDir,planningMode:'off'});
  const run=engine.startRun({workflow:flow,input});
  await engine.executions.get(run.id);
  const saved=engine.getRun(run.id);
  assert.equal(saved.status,'completed',saved.error);
  return{saved,received:runtime.received.at(-1)};
 }
 const first=await invoke();
 assert.match(first.received.developerInstructions,/ROUTING_EFFECTIVE_LAYER_A/);
 assert.match(first.received.prompt,/CUSTOM_PROMPT_LAYER_A/);
 assert.equal(first.received.dynamicTools.find(item=>item.name==='relay_workspace').description,'WORKSPACE_VISIBLE_OVERRIDE_A');
 assert.ok(first.saved.nodes.agent.instructionAudit.sections.some(section=>section.text.includes('CUSTOM_PROMPT_LAYER_A')));
 assert.ok(first.saved.nodes.agent.instructionAudit.sections.some(section=>section.text.includes('ROUTING_EFFECTIVE_LAYER_A')));
 const firstCaptured=structuredClone(first.saved.nodes.agent.instructionAudit);
 change=await layers.save({action:'replace',id:'capabilities',text:'ROUTING_EFFECTIVE_LAYER_B',expectedRevision:change.revision},defs);
 await layers.save({action:'delete',id:customId,expectedRevision:change.revision},defs);
 const second=await invoke();
 assert.match(second.received.developerInstructions,/ROUTING_EFFECTIVE_LAYER_B/);
 assert.doesNotMatch(second.received.developerInstructions,/ROUTING_EFFECTIVE_LAYER_A/);
 assert.doesNotMatch(second.received.prompt,/CUSTOM_PROMPT_LAYER_A/);
 assert.deepEqual(first.saved.nodes.agent.instructionAudit,firstCaptured,'later user edits cannot mutate saved receipts');
});

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

test('Runtime roles and tool disabling change real provider channels, not just labels',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-runtime-roles-'));
 const runtime=new Runtime(),layers=await new ExecutionLayerOverrides({dataDir}).init(),
  tools=await new ToolDescriptionOverrides({dataDir}).init();
 const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:dataDir,executionLayers:layers,toolDescriptions:tools}).init();
 t.after(async()=>{await engine.close();await rm(dataDir,{recursive:true,force:true,maxRetries:12,retryDelay:100});});
 const defs=await engine.executionLayerDefinitions();
 let row=await layers.save({action:'update',id:'capabilities',fields:{
   role:'prompt',title:'Owner routing label',text:'RUNTIME_ROUTING_IN_PROMPT_418',
   description:'User-authored role test'},expectedRevision:0},defs);
 assert.equal(row.layers.find(item=>item.id==='capabilities').role,'prompt');
 row=await layers.save({action:'update',id:'workspace-tools',fields:{
   role:'developer',text:'RUNTIME_WORKSPACE_IN_DEVELOPER_419'},expectedRevision:row.revision},defs);
 const native=engine.nativeToolDefinitions(),workspace=native.find(tool=>tool.name==='relay_workspace');
 assert.ok(workspace);
 const schema=structuredClone(workspace.inputSchema);
 schema.properties.action.description='OWNER_EDITED_TOOL_SCHEMA_420';
 let toolRow=await tools.save({name:'relay_workspace',description:'OWNER_EDITED_TOOL_DESCRIPTION_421',
   inputSchema:schema,expectedRevision:0},native);
 assert.equal(toolRow.revision,1);
 let number=0;
 const invoke=async()=>{
  const input='Check file-tool availability without performing external actions.';
  const workflow=createMissionWorkflow({id:'runtime-role-fixture-'+(++number),task:input,
   model:'fixture',cwd:dataDir,planningMode:'off'});
  const run=engine.startRun({workflow,input});
  await engine.executions.get(run.id);
  const saved=engine.getRun(run.id);
  assert.equal(saved.status,'completed',saved.error);
  return{request:runtime.received.at(-1),saved};
 };
 const first=await invoke();
 assert.match(first.request.prompt,/RUNTIME_ROUTING_IN_PROMPT_418/);
 assert.doesNotMatch(first.request.developerInstructions,/RUNTIME_ROUTING_IN_PROMPT_418/);
 assert.match(first.request.developerInstructions,/RUNTIME_WORKSPACE_IN_DEVELOPER_419/);
 assert.doesNotMatch(first.request.prompt,/RUNTIME_WORKSPACE_IN_DEVELOPER_419/);
 assert.ok(first.saved.nodes.agent.instructionAudit.sections.some(section=>
   section.id==='workspace-tools'&&section.role==='developer'&&section.text==='RUNTIME_WORKSPACE_IN_DEVELOPER_419'));
 const delivered=first.request.dynamicTools.find(item=>item.name==='relay_workspace');
 assert.equal(delivered.description,'OWNER_EDITED_TOOL_DESCRIPTION_421');
 assert.equal(delivered.inputSchema.properties.action.description,'OWNER_EDITED_TOOL_SCHEMA_420');
 assert.notEqual(workspace.inputSchema.properties.action.description,'OWNER_EDITED_TOOL_SCHEMA_420');
 const priorAudit=structuredClone(first.saved.nodes.agent.instructionAudit);
 await tools.save({name:'relay_workspace',action:'disable',expectedRevision:1},native);
 const second=await invoke();
 assert.ok(!second.request.dynamicTools.some(tool=>tool.name==='relay_workspace'),
   'disabling a tool must remove the provider-facing definition');
 assert.deepEqual(first.saved.nodes.agent.instructionAudit,priorAudit,
   'later tool availability edits must not rewrite a saved audit');
});

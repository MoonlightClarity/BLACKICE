import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
import {CONTROL_TOOL,createControlToolHandler} from '../lib/control-tools.mjs';
import {WORKSPACE_TOOL,createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {activeTaskPolicy} from '../lib/active-task-policy.mjs';
import {normalizePlanningOntology,planningOntologyInstructions} from '../public/planning-module-policy.mjs';

class NoNativeProcess extends EventEmitter {
 status(){return {connected:false,authenticated:false,models:[]};}
 async close(){}
 async runAgent(){throw Error('No model or native process may run in this fixture.');}
}
const routes=[['relay_control','describe'],['relay_control','catalog'],['relay_workspace','list']];
for(const type of ['openai','anthropic','compatible'])for(const scenario of ['modular-on','modular-legacy-off','no-policy-off'])for(const [name,action] of routes)
test(type+': '+scenario+' admitted module policy delivered by '+name+' '+action+' through provider tool results',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-policy-wire-')),requests=[];
 const planningMode=scenario==='modular-on'?'on':'off';
 const policy=scenario==='no-policy-off'?null:normalizePlanningOntology({version:2,modules:{time_management:true,anti_overalignment:true,decomposition:false,verification:false}});
 const run={id:'admitted-policy-run',cwd:directory,planningMode,planningOntology:policy,metadata:{}};
 const expected=activeTaskPolicy(run);
 const engine={runtime:{status:()=>({models:[],defaultModel:'fixture'})},listWorkflows:()=>[],
  runtimeSettings:{get:()=>({planningOntology:normalizePlanningOntology({version:2,modules:{time_management:false,anti_overalignment:false,decomposition:true}})})}};
 const control=createControlToolHandler({engine,run,nodeId:'agent'});
 const workspace=createWorkspaceToolHandler({cwd:directory,getTaskPolicy:()=>activeTaskPolicy(run)});
 let calls=0,callbackError;

 const runtime=await new ProviderRuntime({codex:new NoNativeProcess(),dataDir:directory,fetchImpl:async(_url,options)=>{
  if(options.method==='GET')return new Response(JSON.stringify({data:[{id:'fixture'}]}),{headers:{'content-type':'application/json'}});
  requests.push(JSON.parse(options.body));
  const calling=requests.length===1,args={action},callId='policy-read';
  const body=type==='openai'?{id:'policy-response-'+requests.length,status:'completed',output:calling?
   [{type:'function_call',id:'policy-item',call_id:callId,name,arguments:JSON.stringify(args)}]:
   [{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixture policy receipt checked.'}]}]}:
   type==='anthropic'?{id:'policy-message',role:'assistant',type:'message',stop_reason:calling?'tool_use':'end_turn',content:calling?
   [{type:'tool_use',id:callId,name,input:args}]:[{type:'text',text:'Fixture policy receipt checked.'}]}:
   {choices:[{message:calling?{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:
   {role:'assistant',content:'Fixture policy receipt checked.'},finish_reason:calling?'tool_calls':'stop'}]};
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 }}).init();
 t.after(async()=>{await runtime.close();assert.match(path.basename(directory),/^blackice-policy-wire-/);await rm(directory,{recursive:true,force:true});});
 await runtime.saveProvider({id:'policy',type,baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-policy-key',models:['fixture']});
 const developerInstructions='Synthetic fixture. Read the attached tool. No external operations.';
 await runtime.runAgent({cwd:directory,model:'policy::fixture',prompt:'Inspect the admitted task policy.',developerInstructions,
  dynamicTools:[CONTROL_TOOL,WORKSPACE_TOOL],onToolCall:async call=>{
   try{calls++;const result=await (call.name==='relay_control'?control:workspace)(call);
   assert.equal(result.success,true);
   const decoded=JSON.parse(result.contentItems[0].text);
   assert.deepEqual(decoded.activeTaskPolicy,expected);
   if(policy)assert.equal(decoded.activeTaskPolicy.planningOntology.modules.decomposition,false);
   else assert.equal(decoded.activeTaskPolicy.planningOntology,null);
   assert.equal(decoded.activeTaskPolicy.planningMode,planningMode);
   if(policy){
   assert.equal(decoded.activeTaskPolicy.instructions,planningOntologyInstructions(policy));
   assert.match(decoded.activeTaskPolicy.instructions,/IMMEDIATE EFFORT CALIBRATION/);
   assert.match(decoded.activeTaskPolicy.instructions,/MINIMUM-SCOPE BLOCKING/);
   assert.match(decoded.activeTaskPolicy.instructions,/OFF:/);
   }else{
    assert.match(decoded.activeTaskPolicy.instructions,/All Planning method modules are Off/);
    assert.doesNotMatch(decoded.activeTaskPolicy.instructions,/IMMEDIATE EFFORT CALIBRATION|MINIMUM-SCOPE BLOCKING/);
   }
   return result;
   }catch(error){callbackError=error;throw error;}
  }});
 if(callbackError)throw callbackError;
 assert.equal(calls,1);assert.equal(requests.length,2);
 for(const body of requests){
  const definitions=body.tools.map(tool=>type==='compatible'?tool.function:tool);
  assert.deepEqual(definitions.map(tool=>tool.name),[CONTROL_TOOL.name,WORKSPACE_TOOL.name]);
  for(const tool of [CONTROL_TOOL,WORKSPACE_TOOL]){
   const actual=definitions.find(item=>item.name===tool.name);
   assert.equal(actual.description,tool.description);
   assert.deepEqual(type==='anthropic'?actual.input_schema:actual.parameters,tool.inputSchema);
   assert.match(actual.description,/policy/i);
  }
  const instructions=type==='openai'?body.instructions:type==='anthropic'?body.system:body.messages.find(message=>message.role==='system')?.content;
  assert.equal(instructions,developerInstructions);
  assert.doesNotMatch(instructions,/IMMEDIATE EFFORT CALIBRATION|MINIMUM-SCOPE BLOCKING|BLACKICE PLANNING MODULES/);
 }
 const second=requests[1],messages=type==='openai'?second.input:second.messages;
 const receipts=type==='openai'?messages.filter(item=>item.type==='function_call_output').map(item=>item.output):
  type==='anthropic'?messages.flatMap(item=>Array.isArray(item.content)?item.content.filter(block=>block.type==='tool_result').map(block=>block.content):[]):
  messages.filter(item=>item.role==='tool').map(item=>item.content);
 assert.equal(receipts.length,1);
 const serialized=JSON.stringify(receipts);
 assert.ok(serialized.includes('admitted-policy-run'));
 if(policy){
 assert.ok(serialized.includes('IMMEDIATE EFFORT CALIBRATION'));
 assert.ok(serialized.includes('MINIMUM-SCOPE BLOCKING'));
 assert.ok(serialized.includes('OFF:'));
 }else{
  assert.ok(serialized.includes('All Planning method modules are Off'));
  assert.ok(!serialized.includes('IMMEDIATE EFFORT CALIBRATION'));
 }
});

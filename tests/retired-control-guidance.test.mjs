import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTROL_TOOL,PRE_PROFILE_CONTROL_TOOL,createControlToolHandler} from '../lib/control-tools.mjs';
test('current and retained control schemas deny retired cycles without recommending retired modules',async()=>{
 let accessed=0;
 const engine=new Proxy({}, {get(){accessed++;throw Error('Retired actions must not access services');}});
 for(const toolDefinition of [CONTROL_TOOL,PRE_PROFILE_CONTROL_TOOL]){
  const invoke=createControlToolHandler({engine,toolDefinition,run:{id:'retired-control'},nodeId:'agent'});
  for(const action of ['planning_cycle_create','planning_cycle_run','planning_cycle_edit_plan','planning_cycle_continue','planning_cycle_answer']){
   const result=await invoke({name:'relay_control',arguments:{action}});
   assert.equal(result.success,false);
   const error=JSON.parse(result.contentItems[0].text).error;
   assert.match(error,/Planning cycle is retired/);
   assert.match(error,/ordinary tools/);
   assert.doesNotMatch(error,/modular Planning|new graph tools|current Planning controls/i);
  }
 }
 assert.equal(accessed,0);
 assert.ok(CONTROL_TOOL.inputSchema.properties.action.enum.every(action=>!action.startsWith('planning_cycle_')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CONTROL_TOOL,createControlToolHandler} from '../lib/control-tools.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('canonical and historical cycle Plan payloads are rejected without changing the saved contract',async()=>{
 const calls=[],service={editPlan:async(...args)=>{calls.push(args);throw Error('Retired edit must not reach the service.');}};
 const handler=toolDefinition=>createControlToolHandler({engine:{responseCycle:service},run:{id:'run'},nodeId:'agent',toolDefinition});
 const args={action:'planning_cycle_edit_plan',graphRequestId:'graph',cycleId:'cycle',cycle:{expectedRequestRevision:7,expectedCycleRevision:2,expectedPlanRevision:3,expectedPlanResponseId:'response',clientRequestId:'native-plan',plan:{contract:{contractVersion:2,goal:'Retain canonical work',criteria:[],workItems:[],instructions:[]}}}};
 const before=structuredClone(args);
 for(const schema of [CONTROL_TOOL]){
   const rejected=await handler(schema)({name:'relay_control',arguments:args});
   assert.equal(rejected.success,false);assert.match(rejected.contentItems[0].text,/current relay_control schema/i);
   assert.deepEqual(args,before);assert.equal(calls.length,0);
 }
 assert.ok(!CONTROL_TOOL.inputSchema.properties.action.enum.includes('planning_cycle_edit_plan'));
});

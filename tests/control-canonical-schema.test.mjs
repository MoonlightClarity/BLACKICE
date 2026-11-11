import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CONTROL_TOOL,CONTROL_SCHEMA_VERSION,PRE_CANONICAL_CONTROL_TOOL,PRE_CANONICAL_CONTROL_INSTRUCTIONS,createControlToolHandler} from '../lib/control-tools.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('schema12 exposes canonical Plan edits while schema11 bytes remain frozen',()=>{
 assert.equal(CONTROL_SCHEMA_VERSION,12);
 assert.equal(hash(PRE_CANONICAL_CONTROL_TOOL),'0c1934c506ec3b045e08916eff1410a0818edde462d5ad96821c0329a174f13c');
 assert.equal(hash(PRE_CANONICAL_CONTROL_INSTRUCTIONS),'9ba1203e0ef11124b12b86e52e7357518ccfb9398f9da04902e19918ee036497');
 const plan=CONTROL_TOOL.inputSchema.properties.cycle.properties.plan;
 assert.ok(plan.anyOf.find(schema=>schema.properties.contract));
 assert.ok(plan.anyOf.find(schema=>schema.properties.acceptanceCriteria));
 assert.ok(plan.anyOf.every(schema=>schema.additionalProperties===false&&schema.required.includes('userAgency')));
 assert.equal(PRE_CANONICAL_CONTROL_TOOL.inputSchema.properties.cycle.properties.plan.properties.contract,undefined);
});
test('canonical native Plan reaches the same service unchanged and old control refuses it',async()=>{
 const calls=[],service={editPlan:async(...args)=>{calls.push(args);return{id:'graph',revision:8};}};
 const handler=toolDefinition=>createControlToolHandler({engine:{responseCycle:service},run:{id:'run'},nodeId:'agent',toolDefinition});
 const args={action:'planning_cycle_edit_plan',graphRequestId:'graph',cycleId:'cycle',cycle:{expectedRequestRevision:7,expectedCycleRevision:2,expectedPlanRevision:3,expectedPlanResponseId:'response',clientRequestId:'native-plan',plan:{contract:{contractVersion:2,goal:'Retain canonical work',criteria:[],workItems:[],instructions:[]}}}};
 const rejected=await handler(PRE_CANONICAL_CONTROL_TOOL)({name:'relay_control',arguments:args});assert.equal(rejected.success,false);assert.equal(calls.length,0);
 const accepted=await handler(CONTROL_TOOL)({name:'relay_control',arguments:args});assert.equal(accepted.success,true,JSON.stringify(accepted));assert.deepEqual(calls[0].slice(0,3),['graph','cycle',args.cycle]);assert.equal(calls[0][3].actor.type,'agent');
});

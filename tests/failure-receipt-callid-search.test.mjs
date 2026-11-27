import test from 'node:test';
import assert from 'node:assert/strict';
import {retainToolFailureHistory,projectToolFailureHistory} from '../public/next/chat/tool-failure.mjs';
import {searchRunActivity,searchTaskFailures} from '../lib/run-activity-view.mjs';
import {projectTurnReceipts} from '../lib/turn-receipts.mjs';
test('failure search includes a safe call ID and sequence without raw error prose',()=>{
const e={runId:'task-x',nodeId:'agent',at:'2026-11-26T19:00:00.000Z',data:{type:'tool.result',tool:'relay_workspace',action:'read',code:'ENOENT',success:false,callId:'toolcall-1234',message:'PRIVATE SECRET',operationKey:'a'.repeat(64)}};
const h=retainToolFailureHistory(undefined,e),safe=projectToolFailureHistory(h);
assert.equal(safe.receipts[0].callId,'toolcall-1234');assert.ok(!JSON.stringify(safe).includes('PRIVATE'));
const run={id:'task-x',taskId:'task-x',updatedAt:e.at,nodes:{agent:{}},events:[],toolFailureHistory:h};
assert.equal(searchRunActivity(run,{view:'failures',q:'toolcall-1234'}).totalMatches,1);
assert.equal(searchRunActivity(run,{view:'failures',q:'failure:1'}).totalMatches,1);
assert.equal(projectTurnReceipts(run,{view:'failures',q:'toolcall-1234'}).actions.length,1);
assert.equal(searchTaskFailures({rootId:'task-x',runs:[run]},{view:'failures',q:'toolcall-1234',runId:run.id}).totalMatches,1);
assert.equal(searchRunActivity(run,{view:'failures',q:'PRIVATE'}).totalMatches,0);
});

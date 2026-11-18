import test from 'node:test';
import assert from 'node:assert/strict';

import {planningActivityForEvent,mergePlanningActivity,projectPlanningActivity} from '../public/next/chat/planning-timeline.mjs';

test('public timeline persists bounded source-labelled activity without arguments or task-success claims',()=>{
 const event={nodeId:'agent',at:'2026-11-16T00:00:00Z',data:{type:'shadowdancer.step',callId:'phase:call',tool:'relay_workspace',action:'read',event:'action-returned',receiptStatus:'success',arguments:'SECRET'}};
 const rows=planningActivityForEvent('run',event);assert.match(rows[0].text,/task completion is not yet verified/);assert.equal(rows[0].source,'directory-action');
 assert.ok(!JSON.stringify(rows).includes('SECRET'));assert.equal(mergePlanningActivity(rows,rows).length,1);
 assert.equal(projectPlanningActivity({id:'run',planningActivity:rows,events:[]}).length,1);
 const many=Array.from({length:300},(_,n)=>({...rows[0],id:'directory:run:'+n}));assert.equal(mergePlanningActivity([],many).length,160);
});

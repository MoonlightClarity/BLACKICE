import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedExecutionOutputs} from '../lib/recorded-execution-outputs.mjs';
test('recorded outcomes retain exact completed receipts without response-cycle machinery or shared references',()=>{
 const events=[{nodeId:'a',data:{type:'tool.result',text:'actual outcome'}},{nodeId:'a',data:{type:'item',stage:'completed',item:{type:'commandExecution',output:'exact'}}},{nodeId:'a',data:{type:'item',stage:'started',item:{type:'commandExecution'}}},{nodeId:'b',data:{type:'tool.result',text:'other'}}];
 const run={workflow:{nodes:[{id:'input',type:'input'},{id:'a',type:'agent',name:'Agent'}]},nodes:{a:{status:'failed',output:'partial',reused:true}},events};
 const before=structuredClone(run),out=recordedExecutionOutputs(run);
 assert.deepEqual(out,[{nodeId:'a',title:'Agent',status:'failed',output:'partial',reused:true,toolReceipts:events.slice(0,2)}]);
 out[0].toolReceipts[0].data.text='changed';assert.deepEqual(run,before);
});

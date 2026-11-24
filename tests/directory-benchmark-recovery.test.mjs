import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';

const create=()=>new TaskActionDirectory({
 taskId:'task-recovery',objective:'Inspect, fix and verify the code without replaying previous writes.',
});
const scope={runId:'run-recovery',nodeId:'agent-recovery'};
const update=async (directory,args,other={})=>directory.edit({...args,revision:directory.read().revision},{
 authority:'agent',...scope,...other,
});
const execute=async(directory,call,result={success:true})=>directory.execute(call,async()=>result,{...scope});
const plan=async directory=>update(directory,{action:'plan',actions:[
 {id:'inspect',objective:'Inspect the input and failing tests',dependsOn:[]},
 {id:'repair',objective:'Repair the source',dependsOn:['inspect']},
 {id:'verify',objective:'Verify the repaired source',dependsOn:['repair']},
]});

test('an agent cannot close a route as unavailable based only on a claim that the workspace is read-only',async()=>{
 const directory=create();
 await plan(directory);
 await update(directory,{action:'focus',id:'inspect'});
 const before=directory.read();
 await assert.rejects(update(directory,{action:'block',id:'inspect',
    blocker:'no-viable-route',claim:'Workspace is read-only; no edit was attempted.'}),error=>{
   assert.equal(error.code,'DIRECTORY_BLOCKER');
   assert.match(error.message,/No returned failed attempt/);
   return true;
 });
 assert.deepEqual(directory.read(),before,'No unsupported blocker may alter action status or receipt history.');
 const success=await execute(directory,{name:'relay_workspace',arguments:{action:'read',path:'README.md'}});
 await assert.rejects(update(directory,{action:'block',id:'inspect',
    blocker:'no-viable-route',claim:'Still cannot proceed',receipts:[success.receiptId]}),
    {code:'DIRECTORY_BLOCKER'});
 assert.equal(directory.read().actions[0].state,'active');
 const failed=await execute(directory,{name:'relay_workspace',arguments:{action:'read',path:'missing.txt'}},
   {success:false,code:'NOT_FOUND'});
 await update(directory,{action:'block',id:'inspect',
   blocker:'no-viable-route',claim:'The requested source does not exist in this isolated test.',receipts:[failed.receiptId]});
 assert.equal(directory.read().actions[0].state,'blocked');
});

test('a previously completed repair effect can be linked to the repair action after inspect, without retagging or replaying it',async()=>{
 const directory=create();
 await plan(directory);
 await update(directory,{action:'focus',id:'inspect'});
 const inspected=await execute(directory,{name:'relay_workspace',arguments:{action:'read',path:'src/ledger.mjs'}});
 const write=await execute(directory,{name:'relay_workspace',arguments:{
   action:'write',path:'src/ledger.mjs',text:'correct implementation'}});
 await update(directory,{action:'observe',outcome:'objective-met',id:'inspect',claim:'Source inspected.',receipts:[inspected.receiptId]});
 await update(directory,{action:'focus',id:'repair'});
 await update(directory,{action:'observe',outcome:'objective-met',id:'repair',
   claim:'The already-returned write changed the implementation.',receipts:[write.receiptId]});
 const snapshot=directory.read(),receipt=snapshot.receipts.find(row=>row.id===write.receiptId);
 assert.equal(snapshot.actions[1].state,'observed');
 assert.equal(receipt.actionId,'inspect','Immutable original effect attribution is preserved.');
 assert.equal(receipt.linkedByActionId,'repair','Explicit cross-action evidence association survives.');
 const reopened=new TaskActionDirectory({taskId:'task-recovery',objective:'Same task',snapshot});
 assert.equal(reopened.read().receipts.find(row=>row.id===write.receiptId).linkedByActionId,'repair');
 await update(directory,{action:'focus',id:'verify'});
 await assert.rejects(update(directory,{action:'observe',outcome:'objective-met',id:'verify',
    claim:'Reusing old source write as test verification.',receipts:[write.receiptId]}),{code:'DIRECTORY_EVIDENCE'});
 assert.equal(directory.read().actions[2].state,'active');
});

test('a cross-action link requires a successful returned effect, same run and node, and a completed source action',async()=>{
 const directory=create();
 await plan(directory);
 await update(directory,{action:'focus',id:'inspect'});
 const successful=await execute(directory,{name:'relay_workspace',arguments:{action:'write',path:'src/new.mjs',text:'changed'}});
 const failed=await execute(directory,{name:'relay_workspace',arguments:{action:'write',path:'src/no.mjs',text:'failed'}},
   {success:false,code:'WRITE_FAILED'});
 const wrongRun=await directory.execute({name:'relay_workspace',arguments:{action:'write',path:'src/foreign.mjs'}},
   async()=>({success:true}),{runId:'other-run',nodeId:'agent-recovery'});
 const wrongNode=await directory.execute({name:'relay_workspace',arguments:{action:'write',path:'src/othernode.mjs'}},
   async()=>({success:true}),{runId:'run-recovery',nodeId:'other-node'});
 await update(directory,{action:'observe',outcome:'objective-met',id:'inspect',
   claim:'Read the initial input.',receipts:[successful.receiptId]});
 await update(directory,{action:'focus',id:'repair'});
 for(const incorrect of [successful,failed,wrongRun,wrongNode]){
   await assert.rejects(update(directory,{action:'observe',outcome:'objective-met',id:'repair',
     claim:'Reject invalid cross-action evidence.',receipts:[incorrect.receiptId]}),
     {code:'DIRECTORY_EVIDENCE'});
 }
});

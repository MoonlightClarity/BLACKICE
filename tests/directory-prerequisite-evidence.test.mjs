import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';

test('final verification may cite previously observed prerequisite evidence only with fresh own result',async()=>{
 const directory=new TaskActionDirectory({taskId:'cascade-contract',objective:'Repair modules, then check the whole result'});
 const ctx={runId:'luna-run',nodeId:'agent'};
 const edit=(action,id,details={})=>directory.edit({action,id,revision:directory.read().revision,...details},ctx);
 await directory.edit({action:'plan',revision:0,actions:[
  {id:'unrelated',objective:'Check an independent source',dependsOn:[]},
  {id:'audit',objective:'Record diagnostic evidence',dependsOn:[]},
  {id:'repair',objective:'Repair the code',dependsOn:['audit']},
  {id:'verify',objective:'Verify the whole repair',dependsOn:['repair']},
 ]},ctx);
 const run=async(success=true,context=ctx)=>directory.execute({name:'relay_workspace',arguments:{action:'run'}},async()=>({success}),context);
 await edit('focus','unrelated');
 const unrelated=await run();
 await edit('observe','unrelated',{claim:'Unrelated check completed',receipts:[unrelated.receiptId]});
 await edit('focus','audit');
 const audit=await run();
 const failed=await run(false);
 await edit('observe','audit',{claim:'Audit checked',receipts:[audit.receiptId]});
 await edit('focus','repair');
 const repair=await run();
 await edit('observe','repair',{claim:'Source repair checked',receipts:[repair.receiptId]});
 await edit('focus','verify');
 const current=await run();
 const state=directory.read();
 assert.equal(state.focus,'verify');
 const observe=receipts=>edit('observe','verify',{claim:'Final verification includes checked prerequisites and current test result',receipts});
 await assert.rejects(observe([audit.receiptId,repair.receiptId]),{code:'DIRECTORY_EVIDENCE'},
  'Old receipts alone never complete the new verification action');
 assert.deepEqual(directory.read(),state,'A rejected observation must not change state');
 await assert.rejects(observe([current.receiptId,unrelated.receiptId]),{code:'DIRECTORY_EVIDENCE'},
  'Unrelated sibling evidence is not a prerequisite');
 await assert.rejects(edit('note','verify',{claim:'Partial verification',receipts:[current.receiptId,audit.receiptId]}),{code:'DIRECTORY_EVIDENCE'},
  'An incomplete progress note does not borrow an earlier effect');
 await assert.rejects(observe([current.receiptId,audit.receiptId,failed.receiptId]),{code:'DIRECTORY_EVIDENCE'},
  'A failed result cannot supplement final verification');
 await observe([current.receiptId,audit.receiptId,repair.receiptId]);
 const after=directory.read();
 assert.equal(directory.finalStatus().ready,true);
 assert.equal(after.focus,null);
 assert.deepEqual(after.actions.map(x=>x.state),['observed','observed','observed','observed']);
 assert.deepEqual(after.actions.find(x=>x.id==='verify').observation.receipts,[current.receiptId,audit.receiptId,repair.receiptId]);
 assert.equal(after.receipts.find(x=>x.id===audit.receiptId).actionId,'audit');
 assert.equal(after.receipts.find(x=>x.id===repair.receiptId).actionId,'repair');
 assert.equal(after.receipts.find(x=>x.id===current.receiptId).actionId,'verify');
 assert.equal(after.receipts.find(x=>x.id===audit.receiptId).linkedByActionId,undefined);
 const restored=new TaskActionDirectory({taskId:'cascade-contract',objective:'Repair modules, then check the whole result',snapshot:after});
 assert.equal(restored.finalStatus().ready,true,'Original host identity and completion must survive restore');
});

test('prerequisite evidence cannot be imported from a foreign run or node',async()=>{
 const directory=new TaskActionDirectory({taskId:'cascade-foreign',objective:'Check dependencies'});
 const old={runId:'older-run',nodeId:'agent'},now={runId:'current-run',nodeId:'agent'};
 const edit=(args,ctx=now)=>directory.edit({...args,revision:directory.read().revision},ctx);
 await edit({action:'plan',actions:[{id:'pre',objective:'Prerequisite',dependsOn:[]},{id:'verify',objective:'Verify',dependsOn:['pre']}]});
 await edit({action:'focus',id:'pre'},old);
 const earlier=await directory.execute({name:'relay_workspace'},async()=>({success:true}),old);
 await edit({action:'observe',id:'pre',claim:'Earlier run observed source',receipts:[earlier.receiptId]},old);
 await edit({action:'focus',id:'verify'});
 const fresh=await directory.execute({name:'relay_workspace'},async()=>({success:true}),now);
 await assert.rejects(edit({action:'observe',id:'verify',claim:'Import foreign result',receipts:[fresh.receiptId,earlier.receiptId]}),{code:'DIRECTORY_EVIDENCE'});
 assert.equal(directory.read().actions.find(a=>a.id==='verify').state,'active');
 await edit({action:'observe',id:'verify',claim:'Local check completed',receipts:[fresh.receiptId]});
 assert.equal(directory.finalStatus().ready,true);
});

test('a previously observed result from another worker node cannot supplement final verification',async()=>{
 const directory=new TaskActionDirectory({taskId:'cascade-node-scope',objective:'Verify worker handoff'});
 const worker={runId:'shared-run',nodeId:'worker'},reviewer={runId:'shared-run',nodeId:'reviewer'};
 const edit=(payload,ctx=reviewer)=>directory.edit({...payload,revision:directory.read().revision},ctx);
 await edit({action:'plan',actions:[
  {id:'repair',objective:'Repair a module',dependsOn:[]},
  {id:'verify',objective:'Verify repaired module',dependsOn:['repair']},
 ]});
 await edit({action:'focus',id:'repair'},worker);
 const older=await directory.execute({name:'relay_workspace'},async()=>({success:true}),worker);
 await edit({action:'observe',id:'repair',claim:'Worker inspected and repaired source',receipts:[older.receiptId]},worker);
 await edit({action:'focus',id:'verify'});
 const current=await directory.execute({name:'relay_workspace'},async()=>({success:true}),reviewer);
 await assert.rejects(edit({action:'observe',id:'verify',claim:'Ineligible cross-node work',receipts:[current.receiptId,older.receiptId]}),{code:'DIRECTORY_EVIDENCE'});
 assert.equal(directory.read().focus,'verify');
 await edit({action:'observe',id:'verify',claim:'Verified with current worker evidence',receipts:[current.receiptId]});
 assert.equal(directory.finalStatus().ready,true);
});

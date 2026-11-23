import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';

const runId='run-proof',nodeId='agent-proof',taskId='task-proof';
const command='node --test';
const successResult={success:true,contentItems:[{type:'inputText',text:JSON.stringify({
 cwd:'C:\\fixture',command,exitCode:0,timedOut:false,truncated:false,signal:null,shell:'powershell',
})}]};
async function outline(){
 const directory=new TaskActionDirectory({taskId,objective:'Repair and verify a JavaScript module.'});
 const actor={runId,nodeId};
 await handle(directory,{action:'plan',actions:[
  {id:'repair',objective:'Repair code',dependsOn:[]},
  {id:'verify',objective:'Record passing test evidence',dependsOn:['repair']},
  {id:'unrelated',objective:'Inspect a different task',dependsOn:[]},
 ]},actor);
 await handle(directory,{action:'focus',id:'repair'},actor);
 return directory;
}
const handle=(directory,args,actor={runId,nodeId})=>directory.handle(args,{...actor,expectedActionRevision:directory.read().actionRevision});
const run=async(directory,output=successResult,options={})=>directory.execute({
 name:'relay_workspace',arguments:{action:'run',command},callId:'returned-host-test',
},async()=>output,{runId,nodeId,observationOnly:false,...options});

test('a successful host test result remains attributable to its original action and can complete a dependent verification action without replay',async()=>{
 const directory=await outline();
 let attempts=0;
 const returned=await directory.execute({name:'relay_workspace',arguments:{action:'run',command},callId:'original-test'},
  async()=>{attempts++;return successResult;},{runId,nodeId,observationOnly:false});
 const original=directory.read().receipts.find(r=>r.id===returned.receiptId);
 assert.equal(original.actionId,'repair');
 assert.equal(original.tool,'relay_workspace');
 assert.equal(original.verifiedEvidence?.kind,'workspace-test-passed');
 assert.match(original.verifiedEvidence.commandSha256,/^[a-f0-9]{64}$/);
 await handle(directory,{action:'observe',id:'repair',claim:'Source repair and public check completed.',outcome:'objective-met',receipts:[returned.receiptId]},{runId,nodeId});
 await handle(directory,{action:'focus',id:'verify'},{runId,nodeId});
 const before=directory.read().receipts.length;
 const updated=await handle(directory,{action:'observe',id:'verify',claim:'Already-returned public test exits zero.',outcome:'objective-met',receipts:[returned.receiptId]},{runId,nodeId});
 assert.equal(updated.actions.find(x=>x.id==='verify').state,'observed');
 assert.equal(directory.read().receipts.length,before,'The verification uses prior evidence; no tool replay.');
 assert.equal(attempts,1);
 assert.equal(directory.read().receipts[0].actionId,'repair','Original host attribution must never change.');
 assert.equal(directory.finalStatus().reason,'pending-actions','The unrelated task remains pending.');
});

test('a verified test receipt cannot close an unrelated independent action',async()=>{
 const directory=await outline();
 const returned=await run(directory);
 await handle(directory,{action:'observe',id:'repair',claim:'Check returned.',outcome:'objective-met',receipts:[returned.receiptId]},{runId,nodeId});
 await handle(directory,{action:'focus',id:'unrelated'},{runId,nodeId});
 await assert.rejects(handle(directory,{action:'observe',id:'unrelated',claim:'Incorrect evidence for unrelated task.',outcome:'objective-met',receipts:[returned.receiptId]},{runId,nodeId}),e=>e.code==='DIRECTORY_EVIDENCE');
 assert.equal(directory.read().actions.find(x=>x.id==='unrelated').state,'active');
});

test('a dependent action may not cite a test receipt from another run or node',async()=>{
 const directory=await outline();
 const returned=await run(directory);
 await handle(directory,{action:'observe',id:'repair',claim:'Check returned.',outcome:'objective-met',receipts:[returned.receiptId]},{runId,nodeId});
 await handle(directory,{action:'focus',id:'verify'},{runId,nodeId});
 await assert.rejects(handle(directory,{action:'observe',id:'verify',claim:'Incorrect cross-node citation.',outcome:'objective-met',receipts:[returned.receiptId]},{runId:'different-run',nodeId}),e=>e.code==='DIRECTORY_EVIDENCE');
 await assert.rejects(handle(directory,{action:'observe',id:'verify',claim:'Incorrect cross-node citation.',outcome:'objective-met',receipts:[returned.receiptId]},{runId,nodeId:'different-node'}),e=>e.code==='DIRECTORY_EVIDENCE');
 assert.equal(directory.read().actions.find(x=>x.id==='verify').state,'active');
});

test('only a confirmed successful test is reusable; failed commands and source writes are not',async()=>{
 const directory=await outline();
 const failed={success:false,contentItems:[{type:'inputText',text:JSON.stringify({...JSON.parse(successResult.contentItems[0].text),exitCode:1})}]};
 const broken=await run(directory,failed);
 const write=await directory.execute({name:'relay_workspace',arguments:{action:'write',path:'fixture.mjs',text:'changed'}},
  async()=>({success:true,contentItems:[{type:'inputText',text:'saved'}]}),{runId,nodeId,observationOnly:false});
 assert.equal(directory.read().receipts.find(x=>x.id===broken.receiptId).verifiedEvidence,undefined);
 assert.equal(directory.read().receipts.find(x=>x.id===write.receiptId).verifiedEvidence,undefined);
 await handle(directory,{action:'observe',id:'repair',claim:'Checked code and saved file.',outcome:'objective-met',receipts:[broken.receiptId,write.receiptId]},{runId,nodeId});
 await handle(directory,{action:'focus',id:'verify'},{runId,nodeId});
 for(const ref of [broken.receiptId,write.receiptId]){
  await assert.rejects(handle(directory,{action:'observe',id:'verify',claim:'No eligible test evidence.',outcome:'objective-met',receipts:[ref]},{runId,nodeId}),e=>e.code==='DIRECTORY_EVIDENCE');
 }
});

test('durable verification classification survives snapshot reload and rejects tampered attestations',async()=>{
 const directory=await outline();
 const returned=await run(directory);
 const saved=directory.read();
 const resumed=new TaskActionDirectory({taskId,objective:'Repair and verify a JavaScript module.',snapshot:saved});
 await handle(resumed,{action:'observe',id:'repair',claim:'Test returned.',outcome:'objective-met',receipts:[returned.receiptId]},{runId,nodeId});
 await handle(resumed,{action:'focus',id:'verify'},{runId,nodeId});
 await handle(resumed,{action:'observe',id:'verify',claim:'The same test passed.',outcome:'objective-met',receipts:[returned.receiptId]},{runId,nodeId});
 assert.equal(resumed.read().actions.find(x=>x.id==='verify').state,'observed');
 for(const bad of [
  {kind:'workspace-test-passed',commandSha256:'wrong'},
  {kind:'workspace-test-passed',commandSha256:'a'.repeat(64),unexpected:true},
 ]){
  const corrupt=structuredClone(saved);
  corrupt.receipts[0].verifiedEvidence=bad;
  assert.throws(()=>new TaskActionDirectory({taskId,objective:'Repair and verify a JavaScript module.',snapshot:corrupt}),e=>e.code==='DIRECTORY_CORRUPT');
 }
});

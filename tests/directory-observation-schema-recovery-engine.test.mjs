import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';

const graph={name:'Recover malformed optional checklist arguments',
 nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Repair',model:'fixture',
 prompt:'Read the requirements and write the result.'},{id:'o',type:'output'}],
 edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.handle(options);}
}
async function fixture(t,handle){
 const root=await mkdtemp(path.join(os.tmpdir(),'directory-observation-repair-'));
 await writeFile(path.join(root,'README.md'),'Write result.mjs after reading these requirements.\n');
 const runtime=new Runtime();
 runtime.handle=handle;
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 return {root,engine};
}
function observation(id,receipt){
 return {action:'observe',id,claim:'Read the original requirements and understood the requested result.',
   receipts:[receipt],outcome:'objective-met'};
}
const badShape=[{check:'Requirements were read',result:'yes'}];
async function ledgerSetup(objective='Repair the fixture.',checks){
 const d=new TaskActionDirectory({taskId:'task',objective,persist:async()=>{}});
 const call=args=>d.handleModelTool(args,{expectedActionRevision:d.read().actionRevision,runId:'run',nodeId:'a'});
 await call({action:'plan',actions:[{id:'inspect',objective:'Inspect requirements',dependsOn:[],...(checks?{doneChecks:checks}:{})}]});
 await call({action:'focus',id:'inspect'});
 const r=await d.execute({name:'relay_workspace',arguments:{action:'read',path:'C:/fixture/README.md'}},
   async()=>({success:true,contentItems:[{type:'inputText',text:'Read requirement.'}]}),
   {runId:'run',nodeId:'a',expectedActionRevision:d.read().actionRevision,observationOnly:true});
 return {d,call,receipt:r.receiptId};
}
test('an ordinary action with no checklist returns an exact, non-mutating argument-repair suggestion',async()=>{
 const {d,call,receipt}=await ledgerSetup();
 const before=d.read(),minimal=observation('inspect',receipt);
 for(const checkResults of [badShape,[{id:'invented',yes:true}]]){
  const args={...minimal,checkResults};
  await assert.rejects(call(args),error=>{
   assert.ok(['DIRECTORY_TOOL_ARGUMENTS','DIRECTORY_DONE_CHECKLIST'].includes(error.code));
   assert.equal(error.actionDispatched,false);
   assert.match(error.message,/omit checkResults/i);
   assert.match(error.message,/do not create a checklist/i);
   assert.deepEqual(error.directoryRepair.retry,minimal);
   return true;
  });
  assert.deepEqual(d.read(),before,'rejected observations must not change the ledger');
 }
 await call(minimal);
 assert.equal(d.read().actions[0].state,'observed');
});
test('existing required checks and a capped-discovery requirement cannot be bypassed by the optional-field repair',async()=>{
 const configured=await ledgerSetup('Repair the fixture.',[{id:'required',check:'Did the required source read succeed?'}]);
 const capped=await ledgerSetup('Find up to 3 qualifying examples.');
 for(const f of [configured,capped]){
  const before=f.d.read();
  await assert.rejects(f.call({...observation('inspect',f.receipt),checkResults:badShape}),error=>{
   assert.equal(error.directoryRepair,undefined,'no omission suggestion for a required checklist');
   return true;
  });
  assert.deepEqual(f.d.read(),before);
  await assert.rejects(f.call(observation('inspect',f.receipt)),{code:'DIRECTORY_DONE_CHECKLIST'});
 }
});
test('the exact post-install rejection chain recovers without rewriting the plan or repeating the source read',async t=>{
 let root,readCount=0,writeCount=0,callCount=0;
 const f=await fixture(t,async opts=>{
  const call=async(name,args)=>opts.onToolCall({name,arguments:args,callId:'tool-'+(++callCount)});
  const ok=async(name,args)=>{
   const result=await call(name,args);
   assert.equal(result.success,true,JSON.stringify(result).slice(0,500));
   return result;
  };
  const dir=args=>ok('relay_directory_action',args);
  const final=output=>opts.onBeforeFinal({output,signal:opts.signal});
  await dir({action:'plan',actions:[{id:'inspect',objective:'Read requirements',dependsOn:[]},
    {id:'repair',objective:'Write result.mjs',dependsOn:['inspect']}]});
  await dir({action:'focus',id:'inspect'});
  const read=await ok('relay_workspace',{action:'read',path:path.join(root,'README.md')});readCount++;
  const receipt=read.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
  assert.equal((await final('Inspection completed but not recorded yet.'))?.continue,true);
  const minimal=observation('inspect',receipt);
  for(const checkResults of [badShape,[{id:'read_docs',result:'yes'}],[{id:'read_docs',yes:true}]]){
   const rejected=await call('relay_directory_action',{...minimal,checkResults});
   assert.equal(rejected.success,false);
   assert.equal(rejected.actionDispatched,false);
   assert.match(rejected.contentItems[0].text,/omit checkResults/i);
  }
  const badRefine=await call('relay_directory_action',{action:'refine',id:'inspect',claim:'Read requirements.',doneChecks:['Requirements read']});
  assert.equal(badRefine.success,false);
  const recovered=await final('I am trying to record the requirements inspection.');
  assert.equal(recovered?.continue,true,'a repairable argument error must get a usable continuation');
  assert.match(recovered.prompt,/omit checkResults/i);
  assert.match(recovered.prompt,new RegExp(receipt));
  await dir(minimal);
  await dir({action:'focus',id:'repair'});
  const write=await ok('relay_workspace',{action:'write',path:path.join(root,'result.mjs'),text:'export const repaired=true;\n'});writeCount++;
  const writeReceipt=write.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
  await dir({action:'observe',id:'repair',outcome:'objective-met',claim:'Wrote the required fixture result.',receipts:[writeReceipt]});
  assert.equal(await final('Wrote result.mjs.'),undefined);
  return {output:'Wrote result.mjs.'};
 });
 root=f.root;
 const started=f.engine.startRun({workflow:graph,input:{task:'Read the requirements and write result.mjs.',cwd:root,directoryActions:'on'}});
 await f.engine.executions.get(started.id);
 const saved=f.engine.getRun(started.id);
 assert.equal(saved.status,'completed',String(saved.error));
 assert.equal(readCount,1);
 assert.equal(writeCount,1);
 assert.equal(await readFile(path.join(root,'result.mjs'),'utf8'),'export const repaired=true;\n');
});
test('an identical rejected observation cannot keep obtaining final-review recovery indefinitely',async t=>{
 let root,calls=0,completedRecovery=false;
 const f=await fixture(t,async opts=>{
  const call=(name,args)=>opts.onToolCall({name,arguments:args,callId:'repeat-'+(++calls)});
  const dir=args=>call('relay_directory_action',args);
  await dir({action:'plan',actions:[{id:'inspect',objective:'Read requirements',dependsOn:[]}]});
  await dir({action:'focus',id:'inspect'});
  const read=await call('relay_workspace',{action:'read',path:path.join(root,'README.md')});
  const receipt=read.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
  const review=()=>opts.onBeforeFinal({output:'Inspection needs recording.',signal:opts.signal});
  assert.equal((await review()).continue,true);
  const malformed={...observation('inspect',receipt),checkResults:badShape};
  assert.equal((await dir(malformed)).success,false);
  assert.equal((await review()).continue,true);
  completedRecovery=true;
  assert.equal((await dir(malformed)).success,false);
  await assert.rejects(review(),{code:'DIRECTORY_ACTION_UNFINISHED'});
  return {output:'Not finished.'};
 });
 root=f.root;
 const started=f.engine.startRun({workflow:graph,input:{task:'Inspect requirements.',cwd:root,directoryActions:'on'}});
 await f.engine.executions.get(started.id);
 assert.equal(completedRecovery,true);
 assert.equal(f.engine.getRun(started.id).status,'failed');
});

test('new unassigned source evidence after a completed prerequisite enables the ready next action without rereading',async t=>{
 let root,calls=0,reads=0,writes=0;
 const f=await fixture(t,async opts=>{
  const call=async(name,args)=>{
   const result=await opts.onToolCall({name,arguments:args,callId:'evidence-'+(++calls)});
   assert.equal(result.success,true,JSON.stringify(result).slice(0,450));return result;
  };
  const dir=args=>call('relay_directory_action',args);
  const read=async(file)=>{const result=await call('relay_workspace',{action:'read',path:path.join(root,file)});
   reads++;return result.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];};
  const review=()=>opts.onBeforeFinal({output:'The task is still in progress.',signal:opts.signal});
  await dir({action:'plan',actions:[{id:'inspect',objective:'Inspect README',dependsOn:[]},
    {id:'repair',objective:'Read two diagnostic files and write a repair result',dependsOn:['inspect']}]});
  await dir({action:'focus',id:'inspect'});
  const first=await read('README.md');
  await dir(observation('inspect',first));
  assert.equal((await review()).continue,true);
  const evidence=[await read('trace-a.log'),await read('trace-b.log')];
  const continuation=await review();
  assert.equal(continuation?.continue,true,'new successful source reads must not be discarded solely because no action was focused');
  assert.match(continuation.prompt,/unassigned source evidence/i);
  for(const id of evidence)assert.match(continuation.prompt,new RegExp(id));
  await dir({action:'focus',id:'repair'});
  const w=await call('relay_workspace',{action:'write',path:path.join(root,'result.mjs'),text:'export const repaired=true;\n'});writes++;
  const wr=w.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
  await dir({action:'observe',id:'repair',outcome:'objective-met',claim:'Inspected both diagnostic files and wrote the requested result.',receipts:[...evidence,wr]});
  assert.equal(await review(),undefined);
  return {output:'Completed the repair.'};
 });
 root=f.root;
 await writeFile(path.join(root,'trace-a.log'),'Different source A.\n');
 await writeFile(path.join(root,'trace-b.log'),'Different source B.\n');
 const started=f.engine.startRun({workflow:graph,input:{task:'Inspect README and diagnostic files; write the repair result.',cwd:root,directoryActions:'on'}});
 await f.engine.executions.get(started.id);
 const saved=f.engine.getRun(started.id);
 assert.equal(saved.status,'completed',String(saved.error));
 assert.equal(reads,3);
 assert.equal(writes,1);
 assert.match(await readFile(path.join(root,'result.mjs'),'utf8'),/repaired=true/);
});
test('repeating an identical unassigned source read does not manufacture fresh progress',async t=>{
 let root,calls=0,checked=false;
 const f=await fixture(t,async opts=>{
  const call=(name,args)=>opts.onToolCall({name,arguments:args,callId:'duplicate-'+(++calls)});
  const dir=args=>call('relay_directory_action',args);
  const review=()=>opts.onBeforeFinal({output:'The task is incomplete.',signal:opts.signal});
  assert.equal((await dir({action:'plan',actions:[{id:'work',objective:'Inspect source then write result',dependsOn:[]}]})).success,true);
  assert.equal((await review()).continue,true);
  const args={action:'read',path:path.join(root,'README.md')};
  assert.equal((await call('relay_workspace',args)).success,true);
  assert.equal((await review()).continue,true);
  assert.equal((await call('relay_workspace',args)).success,true);
  await assert.rejects(review(),{code:'DIRECTORY_ACTION_UNFINISHED'});
  checked=true;
  return {output:'Incomplete.'};
 });
 root=f.root;
 const started=f.engine.startRun({workflow:graph,input:{task:'Inspect source and write result.',cwd:root,directoryActions:'on'}});
 await f.engine.executions.get(started.id);
 assert.equal(checked,true);
 assert.equal(f.engine.getRun(started.id).status,'failed');
});

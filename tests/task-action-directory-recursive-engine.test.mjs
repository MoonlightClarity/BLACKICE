import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Recursive coding review',nodes:[
 {id:'i',type:'input'},
 {id:'a',type:'agent',name:'Coding agent',model:'fixture-model',prompt:'Repair the source and validate all relevant conditions.'},
 {id:'o',type:'output'},
 ],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}

test('real Engine executes recursive diagnosis, repair, testing and parent synthesis without repeating successful effects',{timeout:60000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-recursive-engine-'));
 const source=path.join(root,'sum.mjs');
 await writeFile(source,'export const sum=(a,b)=>a-b;\n');
 await writeFile(path.join(root,'sum.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {sum} from './sum.mjs';test('sum',()=>assert.equal(sum(2,3),5));\n");
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 let writes=0,testRuns=0,reviewSeen=0;
 runtime.execute=async o=>{
  const tool=o.dynamicTools.find(item=>item.name==='relay_directory_action');
  assert(tool,'Recursive Directory must be available in active tool catalog.');
  assert(tool.inputSchema.properties.action.enum.includes('decompose'));
  assert.match(String(o.prompt)+'\n'+String(o.developerInstructions),/decompose/i);
  let seq=0;
  const call=async(name,args)=>{
   if(name==='relay_workspace'&&args.action==='write')writes++;
   if(name==='relay_workspace'&&args.action==='run')testRuns++;
   return o.onToolCall({name,arguments:args,callId:'recursive-host-'+(++seq)});
  };
  const dir=(action,rest={})=>call('relay_directory_action',{action,...rest});
  assert.equal((await dir('plan',{actions:[{id:'root',objective:'Fix source and prove expected result',dependsOn:[]}]})).success,true);
  assert.equal((await dir('focus',{id:'root'})).success,true);
  const d1=await dir('decompose',{id:'root',claim:'Inspect symptoms, then implement the fix with validation.',actions:[
   {id:'diagnose',objective:'Inspect source before mutation',dependsOn:[]},
   {id:'implement',objective:'Repair and test source',dependsOn:['diagnose']},
  ]});
  assert.equal(d1.success,true,JSON.stringify(d1));
  assert.equal((await dir('focus',{id:'diagnose'})).success,true);
  const sourceRead=await call('relay_workspace',{action:'read',path:source});
  assert.equal(sourceRead.success,true);
  const readReceipt=sourceRead.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  assert(readReceipt);
  assert.equal((await dir('observe',{id:'diagnose',outcome:'objective-met',claim:'Inspected current source.',receipts:[readReceipt]})).success,true);
  assert.equal((await dir('focus',{id:'implement'})).success,true);
  assert.equal((await dir('decompose',{id:'implement',claim:'Code edit and verification are separate evidentiary actions.',actions:[
   {id:'edit_code',objective:'Correct sum implementation',dependsOn:[]},
   {id:'run_checks',objective:'Run the supplied Node.js check',dependsOn:['edit_code']},
  ]})).success,true);
  assert.equal((await dir('focus',{id:'edit_code'})).success,true);
  const mutation=await call('relay_workspace',{action:'write',path:source,text:'export const sum=(a,b)=>a+b;\n'});
  assert.equal(mutation.success,true);
  const editReceipt=mutation.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  assert(editReceipt);
  assert.equal((await dir('observe',{id:'edit_code',outcome:'objective-met',claim:'Source written.',receipts:[editReceipt]})).success,true);
  assert.equal((await dir('focus',{id:'run_checks'})).success,true);
  const tests=await call('relay_workspace',{action:'run',command:'node --test'});
  assert.equal(tests.success,true);
  assert.equal(JSON.parse(tests.contentItems[0].text).exitCode,0);
  const testReceipt=tests.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  assert(testReceipt);
  assert.equal((await dir('observe',{id:'run_checks',outcome:'objective-met',claim:'Test returned successful result.',receipts:[testReceipt]})).success,true);
  const view=await dir('read',{id:'implement'});
  assert.equal(view.success,true);
  const subtree=JSON.parse(view.contentItems[0].text);
  assert.equal(subtree.subtree.id,'implement');
  assert.equal(subtree.actions.length,3);
  assert.equal(subtree.receipts.length,2);
  assert.equal((await dir('focus',{id:'implement'})).success,true);
  assert.equal((await dir('observe',{id:'implement',outcome:'objective-met',claim:'Fix and test complete.',receipts:[editReceipt,testReceipt]})).success,true);
  assert.equal((await dir('focus',{id:'root'})).success,true);
  assert.equal((await dir('observe',{id:'root',outcome:'objective-met',claim:'Diagnosed and repaired verified code.',receipts:[readReceipt,editReceipt,testReceipt]})).success,true);
  const checkpoint=await dir('read');
  assert.equal(checkpoint.success,true);
  const state=JSON.parse(checkpoint.contentItems[0].text);
  assert(state.actions.every(action=>action.state==='observed'));
  assert.equal(state.receipts.length,3);
  assert.equal(state.receipts[1].actionId,'edit_code');
  const firstFinal=await o.onBeforeFinal({output:'The source was repaired and the test passed.',signal:o.signal});
  if(firstFinal?.continue){
   reviewSeen++;
   assert.match(firstFinal.prompt,/CODING VERIFICATION REVIEW/);
   assert.equal(await o.onBeforeFinal({output:'Completed with verified evidence.',signal:o.signal}),undefined);
  }else assert.equal(firstFinal,undefined);
  return{output:'Repaired the source and verified it without repeating tool effects.'};
 };
 const started=engine.startRun({workflow:graph,input:{task:'Fix source and test',directoryActions:'on'}});
 await engine.executions.get(started.id);
 assert.equal(engine.getRun(started.id).status,'completed',engine.getRun(started.id).error);
 assert.equal(await readFile(source,'utf8'),'export const sum=(a,b)=>a+b;\n');
 assert.equal(writes,1);
 assert.equal(testRuns,1);
 assert(reviewSeen<=1);
 const dir=await engine.actionDirectories.get(started.id,'Fix source and test');
 assert.equal(dir.finalStatus().ready,true);
 assert.equal(dir.read().actions.length,5);
});

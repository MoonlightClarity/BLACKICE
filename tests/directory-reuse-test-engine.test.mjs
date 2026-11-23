import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Reuse existing public-test evidence',nodes:[
 {id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Fix code and verify it'},
 {id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('a dependent verification action can use a genuine earlier host test receipt without a second command',{timeout:45000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'directory-reuse-host-test-'));
 const source=path.join(root,'sum.mjs');
 await writeFile(source,'export const sum=(a,b)=>a-b;\n');
 await writeFile(path.join(root,'sum.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {sum} from './sum.mjs';test('sum',()=>assert.equal(sum(2,3),5));\n");
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 let testRuns=0,reviewCount=0;
 runtime.execute=async o=>{
  let seq=0;
  const call=async(name,args)=>{
   if(name==='relay_workspace'&&args.action==='run')testRuns++;
   return o.onToolCall({name,arguments:args,callId:'dependent-proof-'+(++seq)});
  };
  const dir=(action,extras={})=>call('relay_directory_action',{action,...extras});
  assert.equal((await dir('plan',{actions:[
   {id:'repair',objective:'Repair sum and run the provided test',dependsOn:[]},
   {id:'verify',objective:'Record successful test verification',dependsOn:['repair']},
  ]})).success,true);
  assert.equal((await dir('focus',{id:'repair'})).success,true);
  const write=await call('relay_workspace',{action:'write',path:source,text:'export const sum=(a,b)=>a+b;\n'});
  assert.equal(write.success,true);
  const writeReceipt=write.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  const run=await call('relay_workspace',{action:'run',command:'node --test'});
  assert.equal(run.success,true,JSON.stringify(run));
  const testReceipt=run.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  assert(testReceipt&&writeReceipt);
  assert.equal((await dir('observe',{id:'repair',outcome:'objective-met',claim:'Code was saved; supplied test returned success.',receipts:[writeReceipt,testReceipt]})).success,true);
  assert.equal((await dir('focus',{id:'verify'})).success,true);
  const closed=await dir('observe',{id:'verify',outcome:'objective-met',claim:'The existing successful public test receipt verifies the tested behavior.',receipts:[testReceipt]});
  assert.equal(closed.success,true,JSON.stringify(closed));
  const state=JSON.parse((await dir('read')).contentItems[0].text);
  assert(state.actions.every(row=>row.state==='observed'));
  assert.equal(state.receipts.length,2,'Citing an earlier test is not a tool replay.');
  assert.equal(state.receipts[1].actionId,'repair');
  assert.equal(state.receipts[1].verifiedEvidence.kind,'workspace-test-passed');
  const review=await o.onBeforeFinal({output:'Both actions complete.',signal:o.signal});
  reviewCount++;
  assert.equal(review?.continue,true);
  assert.match(review.prompt,/ONE-TIME CODING VERIFICATION REVIEW/);
  assert.equal(await o.onBeforeFinal({output:'The provided test passed; remaining untested requirements are not claimed.',signal:o.signal}),undefined);
  return{output:'Verified code repair and reused the returned test receipt.'};
 };
 const started=engine.startRun({workflow:graph,input:{task:'Repair a module and verify its behavior',directoryActions:'on'}});
 await engine.executions.get(started.id);
 assert.equal(engine.getRun(started.id).status,'completed',engine.getRun(started.id).error);
 assert.equal(testRuns,1);
 assert.equal(reviewCount,1);
 assert.equal(await readFile(source,'utf8'),'export const sum=(a,b)=>a+b;\n');
});

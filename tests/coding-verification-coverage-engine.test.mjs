import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Bounded verification review',nodes:[
 {id:'i',type:'input'},{id:'a',type:'agent',name:'Coding agent',model:'fixture',prompt:'Fix source'},
 {id:'o',type:'output'}],
 edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('a completed code edit with a verified public test triggers one non-mutating coverage review in the real Engine',{timeout:45000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'coding-verification-engine-'));
 const source=path.join(root,'sum.mjs');
 await writeFile(source,'export const sum=(a,b)=>a-b;\n');
 await writeFile(path.join(root,'sum.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {sum} from './sum.mjs';test('sum',()=>assert.equal(sum(2,3),5));\n");
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 let reviewCount=0;
 runtime.execute=async o=>{
  let seq=0;
  const call=(name,args)=>o.onToolCall({name,arguments:args,callId:'code-verify-'+(++seq)});
  const dir=(action,extras={})=>call('relay_directory_action',{action,...extras});
  assert.equal((await dir('plan',{actions:[{id:'repair',objective:'Fix sum and verify the result',dependsOn:[]}]})).success,true);
  assert.equal((await dir('focus',{id:'repair'})).success,true);
  const written=await call('relay_workspace',{action:'write',path:source,text:'export const sum=(a,b)=>a+b;\n'});
  assert.equal(written.success,true);
  const writeReceipt=written.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  const verified=await call('relay_workspace',{action:'run',command:'node --test'});
  assert.equal(verified.success,true,JSON.stringify(verified));
  const testReceipt=verified.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  assert(writeReceipt&&testReceipt);
  assert.equal((await dir('observe',{id:'repair',outcome:'objective-met',claim:'Source saved and supplied test passed',receipts:[writeReceipt,testReceipt]})).success,true);
  const one=await o.onBeforeFinal({output:'The code is fixed.',signal:o.signal});
  reviewCount++;
  assert.equal(one?.continue,true);
  assert.match(one.prompt,/ONE-TIME CODING VERIFICATION REVIEW/);
  assert.match(one.prompt,/explicit requirement/);
  assert.match(one.prompt,/sum\.mjs/);
  assert.match(one.prompt,new RegExp(testReceipt));
  const state=JSON.parse((await dir('read')).contentItems[0].text);
  assert.equal(state.actions[0].state,'observed','The review must not reopen or change a completed action.');
  const two=await o.onBeforeFinal({output:'No further targeted verification performed.',signal:o.signal});
  assert.equal(two,undefined,'The single review cannot create a second gate.');
  return{output:'The original source was fixed and the supplied test passed.'};
 };
 const run=engine.startRun({workflow:graph,input:{task:'Repair the JavaScript module and verify the source',directoryActions:'on'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
 assert.equal(reviewCount,1);
 assert.equal(await readFile(source,'utf8'),'export const sum=(a,b)=>a+b;\n');
});

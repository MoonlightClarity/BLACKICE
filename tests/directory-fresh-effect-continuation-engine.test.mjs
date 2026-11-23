import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';

class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.handle(options);}
}
const graph={
 name:'Multi-file repair',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Repair',model:'fixture',
 prompt:'Write two source files and record results; do not claim completion early.'},{id:'o',type:'output'}],
 edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}
};
async function setup(t,handle){
 const root=await mkdtemp(path.join(os.tmpdir(),'directory-new-effect-final-'));
 const runtime=new Runtime();runtime.handle=handle;
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true})});
 return {engine,root};
}
test('a final-review handback does not stop a multi-file repair after each new returned write',{timeout:30000},async t=>{
 let toolCalls=0,reviewCount=0,first,second,root;
 const fixture=await setup(t,async options=>{
  const call=async(name,args)=>{
   const result=await options.onToolCall({name,arguments:args,callId:'tool-'+(++toolCalls)});
   assert.equal(result.success,true,JSON.stringify(result));
   return result;
  };
  const dir=async(action,args={})=>JSON.parse((await call('relay_directory_action',{action,...args})).contentItems[0].text);
  const review=async()=>{
   const result=await options.onBeforeFinal({output:'I have not finished the two-file repair.',signal:options.signal});
   reviewCount++;return result;
  };
  await dir('plan',{actions:[{id:'repair',objective:'Write both required source files',dependsOn:[]}]});
  await dir('focus',{id:'repair'});
  const initial=await review();
  assert.equal(initial.continue,true);
  assert.match(initial.prompt,/Current active action/);
  const a=await call('relay_workspace',{action:'write',path:path.join(root,'a.mjs'),text:'export const a=1;\n'});
  first=a.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
  const next=await review();
  assert.equal(next.continue,true,'A returned effect is progress, not a reason to end after the first handback.');
  assert.match(next.prompt,/HOST-RETURNED effect/);
  assert.match(next.prompt,new RegExp(first));
  const b=await call('relay_workspace',{action:'write',path:path.join(root,'b.mjs'),text:'export const b=2;\n'});
  second=b.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
  const afterSecond=await review();
  assert.equal(afterSecond.continue,true,'A later new returned effect should also permit continued work.');
  assert.match(afterSecond.prompt,new RegExp(second));
  await dir('observe',{id:'repair',outcome:'objective-met',
   claim:'Both source writes returned successfully.',receipts:[first,second]});
  assert.equal(await review(),undefined,'A now observed action can terminate normally.');
  return {output:'Both files have been written and verified by returned receipts.'};
 });
 root=fixture.root;
 const started=fixture.engine.startRun({workflow:graph,input:{task:'Write the two files',directoryActions:'on',cwd:root}});
 await fixture.engine.executions.get(started.id);
 const run=fixture.engine.getRun(started.id);
 assert.equal(run.status,'completed',run.error);
 assert.equal(await readFile(path.join(root,'a.mjs'),'utf8'),'export const a=1;\n');
 assert.equal(await readFile(path.join(root,'b.mjs'),'utf8'),'export const b=2;\n');
 assert.equal(reviewCount,4);
 assert.notEqual(first,second);
 const state=(await fixture.engine.actionDirectories.get(started.id,'Write the two files')).read();
 assert.equal(state.receipts.length,2);
 assert.equal(state.actions[0].state,'observed');
});
test('a repeated final with no new returned effects still cannot assert completion',{timeout:30000},async t=>{
 const {engine,root}=await setup(t,async options=>{
  const dir=async(action,args={})=>options.onToolCall({name:'relay_directory_action',
   arguments:{action,...args},callId:'directory-'+action});
  assert.equal((await dir('plan',{actions:[{id:'work',objective:'Do and verify source work',dependsOn:[]}]})).success,true);
  assert.equal((await dir('focus',{id:'work'})).success,true);
  const review=()=>options.onBeforeFinal({output:'Not finished.',signal:options.signal});
  assert.equal((await review()).continue,true);
  assert.equal((await review()).continue,true,'The first observed continuation can give actionable guidance.');
  await assert.rejects(review(),{code:'DIRECTORY_ACTION_UNFINISHED'});
  return {output:'Not done.'};
 });
 const start=engine.startRun({workflow:graph,input:{task:'Work must be completed',directoryActions:'on',cwd:root}});
 await engine.executions.get(start.id);
 assert.equal(engine.getRun(start.id).status,'failed');
});

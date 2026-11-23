import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {HarnessEngine} from '../lib/engine.mjs';
class Runtime extends EventEmitter {
 status(){return {connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.handle(options);}
}
const graph={
 name:'Outcome continuation after new focus',
 nodes:[{id:'input',type:'input'},{id:'a',type:'agent',model:'fixture',
 prompt:'Inspect and repair. Source edits must follow the inspection.'},{id:'output',type:'output'}],
 edges:[{source:'input',target:'a'},{source:'a',target:'output'}],
 settings:{maxParallel:1,planningMode:'off'},
};
test('a newly focused dependent action is valid new work, not an exhausted final-review loop',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'directory-focus-correction-'));
 let engine,secondStatus=null,count=0;
 t.after(async()=>{await engine?.close();await rm(root,{recursive:true,force:true});});
 await writeFile(path.join(root,'README.md'),'Inspect first, then repair source.');
 const runtime=new Runtime();
 runtime.handle=async opts=>{
  const call=async(name,args)=>{
   const result=await opts.onToolCall({name,arguments:args,callId:'call-'+(++count)});
   assert.equal(result.success,true,JSON.stringify(result).slice(0,400));
   return result;
  };
  const dir=(action,args={})=>call('relay_directory_action',{action,...args});
  await dir('plan',{actions:[
   {id:'inspect',objective:'Read original requirements',dependsOn:[]},
   {id:'repair',objective:'Edit source after inspection',dependsOn:['inspect']},
  ]});
  await dir('focus',{id:'inspect'});
  const observation=await call('relay_workspace',{action:'read',path:path.join(root,'README.md')});
  const receipt=observation.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
  await dir('observe',{id:'inspect',outcome:'objective-met',
   claim:'Inspected the original requirements.',receipts:[receipt]});
  const before=await opts.onBeforeFinal({output:'Inspection complete, repair remains.',signal:opts.signal});
  assert.equal(before.continue,true);
  await dir('focus',{id:'repair'});
  try{
   const after=await opts.onBeforeFinal({output:'I am about to edit source.',signal:opts.signal});
   secondStatus=after?.continue===true?'continued':'accepted';
  }catch(error){secondStatus=error.code||error.message;}
  assert.equal(secondStatus,'continued','Newly focused ready work should not be treated as an exhausted correction loop');
  return {output:'Still working.'};
 };
 engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 const run=engine.startRun({workflow:graph,input:{task:'Inspect then repair',directoryActions:'on',cwd:root}});
 await engine.executions.get(run.id);
 const saved=engine.getRun(run.id);
 assert.equal(secondStatus,'continued',String(saved.error));
 assert.equal(saved.status,'failed','The unfinished task remains incomplete; this test only checks whether the new work gets a continuation.');
});

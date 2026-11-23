import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph={name:'Directory recovery',nodes:[
 {id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Fix the source'},
 {id:'o',type:'output'}],
 edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('malformed Directory plans receive a minimal correction without dispatch or hidden mutation',{timeout:45000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'directory-recovery-'));
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 runtime.execute=async options=>{
  assert.match(String(options.prompt)+'\n'+String(options.developerInstructions),/WORKSPACE MUTATION CAPABILITY \(HOST-VERIFIED FOR THIS RUN\)/);
  const tool=options.dynamicTools.find(x=>x.name==='relay_directory_action');
  assert.match(tool.description,/minimal valid plan/);
  let seq=0;
  const call=(name,args)=>options.onToolCall({name,arguments:args,callId:'plan-recovery-'+(++seq)});
  const failed=await call('relay_directory_action',{action:'plan',actions:[{id:'repair'}]});
  assert.equal(failed.success,false);
  assert.equal(failed.code,'DIRECTORY_TOOL_ARGUMENTS');
  assert.match(failed.contentItems[0].text,/dependsOn/);
  assert.match(failed.contentItems[0].text,/"objective":"Specific next action to perform"/);
  const initial=await call('relay_directory_action',{action:'read'});
  assert.equal(initial.success,true);
  assert.deepEqual(JSON.parse(initial.contentItems[0].text).actions,[]);
  assert.equal((await call('relay_directory_action',{action:'plan',actions:[{id:'repair',objective:'Save verified arithmetic source',dependsOn:[]}]})).success,true);
  assert.equal((await call('relay_directory_action',{action:'focus',id:'repair'})).success,true);
  const saved=await call('relay_workspace',{action:'write',path:path.join(root,'fixed.txt'),text:'verified arithmetic'});
  assert.equal(saved.success,true);
  const receipt=saved.contentItems.at(-1).text.match(/receipt-\d+/)?.[0];
  assert(receipt);
  assert.equal((await call('relay_directory_action',{action:'observe',id:'repair',outcome:'objective-met',claim:'Verified source was written',receipts:[receipt]})).success,true);
  assert.equal(await options.onBeforeFinal({output:'Saved verified source.',signal:options.signal}),undefined);
  return{output:'Saved verified source.'};
 };
 const run=engine.startRun({workflow:graph,input:{task:'Write a verified local file',directoryActions:'on'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
 assert.equal(await readFile(path.join(root,'fixed.txt'),'utf8'),'verified arithmetic');
});

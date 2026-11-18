import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
const retired={code:'DIRECTORY_RETIRED',status:410};
const workflow={id:'retirement',name:'Retirement',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',prompt:'Do the task',model:'fixture'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
async function fixture(t){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-retirement-effects-'));
 const closers=[];t.after(async()=>{for(const close of closers)await close();await rm(cwd,{recursive:true,force:true});});
 const folder=path.join(cwd,'.blackice/directory/saved/conversation/context');
 await mkdir(folder,{recursive:true});
 const records=[['summary.json','{"userSummary":"PRIVATE_OLD_CONTEXT"}'],['audit.json','broken historical audit'],['unknown-effects.json','{"state":"UNKNOWN","receipt":"keep"}']];
 for(const [name,value]of records)await writeFile(path.join(folder,name),value);
 const verify=async()=>{assert.deepEqual((await readdir(folder)).sort(),records.map(x=>x[0]).sort());for(const [name,value]of records)assert.equal(await readFile(path.join(folder,name),'utf8'),value);};
 return {cwd,folder,verify,closers};
}
test('engine rejects all Directory admissions and historical retry/Off continuation before provider work, including restart',async t=>{
 const f=await fixture(t);
 class Runtime extends EventEmitter{
  calls=[];status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
  async runAgent(options){this.calls.push(options);assert.doesNotMatch(options.prompt,/PRIVATE_OLD_CONTEXT/);return {output:'Ordinary output',threadId:'ordinary'};}
 }
 const runtime=new Runtime();let engine=await new HarnessEngine({runtime,dataDir:path.join(f.cwd,'data'),defaultCwd:f.cwd}).init();
 f.closers.push(()=>engine.close());
 for(const input of [{task:'task',directoryMode:'on'},'/directory task','@directory task','@shadowdancer task',{task:'/directory task',directoryMode:'off'}]){
  assert.throws(()=>engine.startRun({workflow,input}),retired);
 }
 assert.equal(engine.runs.size,0);assert.equal(runtime.calls.length,0);
 const ordinary=engine.startRun({workflow,input:'Ordinary task'}),until=Date.now()+5000;
 while(!engine.getRun(ordinary.id).settled&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
 assert.equal(engine.getRun(ordinary.id).status,'completed');assert.equal(runtime.calls.length,1);
 const saved=engine.runs.get(ordinary.id);saved.executionModes.directoryMode='on';await engine.persist();await engine.close();
 engine=await new HarnessEngine({runtime,dataDir:path.join(f.cwd,'data'),defaultCwd:f.cwd}).init();
 const before=JSON.stringify(engine.runs.get(ordinary.id));
 assert.throws(()=>engine.retryRun(ordinary.id),retired);
 assert.throws(()=>engine.continueRun(ordinary.id,{nodeId:'agent',message:'Continue',directoryMode:'off'}),retired);
 assert.equal(JSON.stringify(engine.runs.get(ordinary.id)),before);assert.equal(runtime.calls.length,1);await f.verify();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const graph=()=>({
  id:'shadowdancer-pilot',name:'Shadowdancer pilot',
  nodes:[{id:'input',type:'input'},
    {id:'agent',type:'agent',name:'BLACKICE',model:'remote::test',prompt:'Help with the request.'},
    {id:'output',type:'output'}],
  edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
  settings:{maxParallel:1,planningMode:'off'}
});
class FakeRuntime extends EventEmitter {
  constructor(replies){ super();this.replies=[...replies];this.calls=[]; }
  status(){return {connected:true,authenticated:true,defaultModel:'remote::test',models:[{model:'remote::test',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};}
  async start(){return this.status();}
  async runAgent(options){
    this.calls.push(options);
    const current=options.prompt.includes('CURRENT_DIRECTORY:\n')?JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1).split('\nREPOSITORY ')[0]):null;
    if(current?.label==='context-page')return {output:JSON.stringify({summary:'Attributed task-state metadata.',refs:[]}),threadId:'provider_fresh_'+this.calls.length};
    if(!this.replies.length)throw new Error('Mock provider ran out of replies');
    const message=this.replies.shift();
    if(current?.label==='integration'&&Array.isArray(message?.used_refs))message.used_refs=[...message.used_refs,...current.payload.required_refs.filter(ref=>ref.startsWith('context:'))];
    return {output: typeof message==='string'?message:JSON.stringify(message),threadId:'provider_fresh_'+this.calls.length};
  }
  async close(){}
}
class NoDesktop extends EventEmitter {
  status(){return {available:false,enabled:false};}
  async setEnabled(){return this.status();}
}
const waitFor=async check=>{
  const limit=Date.now()+10000;
  while(Date.now()<limit){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('BLACKICE run did not settle');
};
async function sandbox(t,answers) {
  const folder=await mkdtemp(path.join(os.tmpdir(),'blackice-dir-integration-'));
  const cwd=path.join(folder,'workspace'),dataDir=path.join(folder,'data');
  const runtime=new FakeRuntime(answers);
  const app=await createHarnessServer({port:0,dataDir,defaultCwd:cwd,runtime,desktop:new NoDesktop(),maxConcurrentRuns:2});
  await app.listen();
  t.after(async()=>{await app.close();await rm(folder,{recursive:true,force:true});});
  return {app,runtime,cwd,folder};
}
const pad=(code,n)=>('The marker code is '+code+'.').padEnd(n,' background ');
const source=pad('ALPHA17',1150)+pad('BETA29',1100);

test('ordinary BLACKICE chats preserve standard runtime rather than directory mode',async t=>{
  const {app,runtime}=await sandbox(t,[{output:'normal'}]);
  // Fake runtime returns a raw object as JSON string; this is the old path.
  const start=app.engine.startRun({workflow:graph(),input:'Ordinary request without directory opt-in'});
  const run=await waitFor(()=>{const value=app.engine.getRun(start.id);return value.settled&&value;});
  assert.equal(run.status,'completed',run.error);
  assert.equal(runtime.calls.length,1);
  assert.ok(runtime.calls[0].dynamicTools);
  assert.equal(run.nodes.agent.shadowdancer,undefined);
});

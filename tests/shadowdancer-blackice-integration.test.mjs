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
const note=(...values)=>({summary:'Marker codes: '+values.join(' '),items:values.map(value=>({value,quote:value}))});
const good=(text,refs)=>({answer:text,used_refs:refs,integrated_findings:refs.map(ref=>({ref,claim:'included'}))});

test('BLACKICE chat /directory uses fresh remote turns and publishes only coverage-gated final',async t=>{
  const {app,runtime,cwd}=await sandbox(t,[note('ALPHA17','BETA29'),good('ALPHA17 and BETA29',['page:1'])]);
  const start=app.engine.startRun({workflow:graph(),input:'/directory List all marker codes\nSOURCE:\n'+source});
  const run=await waitFor(()=>{const value=app.engine.getRun(start.id);return value.settled&&value;});
  assert.equal(run.status,'completed',run.error);
  assert.match(run.output,/ALPHA17/);assert.match(run.output,/BETA29/);
  assert.equal(runtime.calls.filter(call=>!call.prompt.includes('"label":"context-page"')).length,2);
  assert.equal(run.nodes.agent.shadowdancer.mode,'directory');
  assert.equal(run.nodes.agent.shadowdancer.stats.sourceRefs,1);
  assert.ok(run.events.some(e=>e.data?.type==='shadowdancer.step'));
  assert.ok(run.events.some(e=>e.data?.type==='message'&&e.data.shadowdancer===true));
  assert.ok(runtime.calls.every(c=>!('threadId' in c)&&!('continuity' in c)&&c.hostOnlyTools===true));
  assert.ok(runtime.calls.every(c=>!c.prompt.includes('CURRENT AGENT INSTRUCTIONS')));
  assert.ok(runtime.calls.every(c=>!c.prompt.includes('Saved conversation')));
  const summary=JSON.parse(await readFile(path.join(cwd,'.shadowdancer',run.taskId||run.id,'conversation','context','summary.json'),'utf8'));
  assert.equal(summary.integrationStatus,'coverage_checked_not_fact_verified');
});

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

test('BLACKICE refuses a directory final answer missing an extracted source fact',async t=>{
  const {app,runtime}=await sandbox(t,[note('ALPHA17','BETA29'),
    good('ALPHA17',['page:1']),
    good('ALPHA17',['page:1'])]);
  const started=app.engine.startRun({workflow:graph(),input:'/directory List all marker codes\nSOURCE:\n'+source});
  const run=await waitFor(()=>{const value=app.engine.getRun(started.id);return value.settled&&value;});
  assert.equal(run.status,'failed');
  assert.equal(run.errorCode,'DIRECTORY_INTEGRATION_COVERAGE');
  assert.equal(runtime.calls.filter(call=>!call.prompt.includes('"label":"context-page"')).length,3);
  assert.ok(!run.nodes.agent.shadowdancer);
});

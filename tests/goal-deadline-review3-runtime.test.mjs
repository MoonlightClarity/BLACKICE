import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const waitFor=async(fn,label='state')=>{
  const cutoff=Date.now()+6000;
  while(Date.now()<cutoff){let x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,10));}
  assert.fail('Timed out awaiting '+label);
};
const graph=()=>({id:'goal-control-boundary',name:'Goal control boundary fixture',nodes:[
  {id:'input',type:'input',name:'Input'},
  {id:'agent',type:'agent',name:'Agent',model:'fixture-model',prompt:'Use the isolated workspace.'},
  {id:'output',type:'output',name:'Output'}],
  edges:[{id:'to-agent',source:'input',target:'agent'},{id:'to-output',source:'agent',target:'output'}],
  settings:{planningMode:'off',maxParallel:1}});
class Runtime extends EventEmitter {
  constructor(execute){super();this.execute=execute;this.calls=[];this.defaultModel='fixture-model';}
  status(){return {connected:true,authenticated:true,defaultModel:this.defaultModel};}
  async runAgent(options){this.calls.push(options);return this.execute(options,this.calls.length);}
  async savedThreadModel(){return 'fixture-model';}
}
async function setup(t,execute){
  const dir=await mkdtemp(path.join(tmpdir(),'goal-control-resume-native-'));
  const cwd=path.join(dir,'workspace'),dataDir=path.join(dir,'data');await mkdir(cwd);
  const runtime=new Runtime(execute),engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd}).init();
  const conversations=await new ConversationArchive({dataDir,engine}).init();
  const goals=await new ConversationGoals({engine,conversations,continuationDelayMs:10,retryDelayMs:10}).init();
  t.after(async()=>{await goals.close();await engine.close();await conversations.close();await rm(dir,{recursive:true,force:true});});
  return {runtime,engine,conversations,goals,cwd};
}
const inspectWorkspace=async options=>{
  assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'),'fixture must exercise a real host tool entrypoint');
  const outcome=await options.onToolCall({name:'relay_workspace',arguments:{action:'list',path:'.'}},{signal:options.signal});
  assert.equal(outcome.success,true,JSON.stringify(outcome));
  return outcome;
};
test('real engine provider continues an already admitted turn and tool after pause_after_turn, no successor',async t=>{
  const ready=deferred(),finish=deferred();
  const f=await setup(t,async options=>{
    ready.resolve(options);
    await finish.promise;
    options.signal.throwIfAborted();
    await inspectWorkspace(options);
    return {output:'Synthetic turn finished after pause_after_turn',threadId:'fixture-thread'};
  });
  const first=f.engine.startRun({workflow:graph(),input:{task:'Inspect files for a fixture.',goal:{objective:'Inspect files for a fixture.'}}});
  try{
    await ready.promise;
    const paused=await f.goals.control(first.id,{action:'pause_after_turn',requestId:'runtime-pause-after-current'});
    assert.equal(paused.goal.status,'paused');
    assert.equal(paused.goal.running,true);
    finish.resolve();
    await waitFor(()=>f.engine.getRun(first.id).settled,'initial run settlement');
    assert.equal(f.engine.getRun(first.id).status,'completed',JSON.stringify(f.engine.getRun(first.id).error));
    assert.equal(f.runtime.calls.length,1);
    assert.equal((await f.goals.get(first.id)).status,'paused');
    await waitFor(async()=>(await f.goals.get(first.id)).finishCurrentRunId===null,'queued Goal settlement callback');
    assert.equal((await f.goals.get(first.id)).finishCurrentRunId,null);
  }finally{finish.resolve();}
});
test('real engine provider and tool survive ordinary next-turn edit; successor uses updated scope',async t=>{
  const ready=deferred(),finish=deferred();
  const f=await setup(t,async(options,n)=>{
    if(n===1){ready.resolve(options);await finish.promise;options.signal.throwIfAborted();await inspectWorkspace(options);}
    return {output:'Synthetic fixture outcome '+n,threadId:'fixture-thread-'+n};
  });
  const first=f.engine.startRun({workflow:graph(),input:{task:'Inspect original fixture.',goal:{objective:'Inspect original fixture.',maxTurns:2}}});
  try{
    await ready.promise;
    const amended=await f.goals.control(first.id,{action:'update',objective:'Inspect the revised fixture scope.',requestId:'runtime-edit-for-next-turn'});
    assert.equal(amended.goal.status,'active');
    assert.equal(amended.goal.generation,2);
    finish.resolve();
    await waitFor(()=>f.engine.getRun(first.id).settled,'first run after update');
    assert.equal(f.engine.getRun(first.id).status,'completed',JSON.stringify(f.engine.getRun(first.id).error));
    await waitFor(()=>f.runtime.calls.length===2,'one updated successor');
    await waitFor(async()=>(await f.goals.get(first.id))?.status==='budget_exhausted','bounded continuation');
    assert.equal(f.runtime.calls.length,2);
    assert.equal((await f.goals.get(first.id)).objective,'Inspect the revised fixture scope.');
  }finally{finish.resolve();}
});

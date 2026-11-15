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
const until=async(fn,label)=>{const end=Date.now()+8000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out: '+label);};
const phaseOf=options=>{if(!options.prompt.includes('SHADOWDANCER DIRECTORY MODE.'))return null;return JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1).split('\nREPOSITORY ')[0]);};
const phaseResult=phase=>phase.label==='decompose'?{atomic:true}:phase.label==='integration'?{answer:'Synthetic Directory result.',used_refs:phase.payload.required_refs}:{status:'complete',nextAction:'',finding:'A bounded fixture finding.',candidate_answer:'A bounded fixture answer.',uncertainty:''};
const graph=()=>({name:'Deadline Directory continuation fixture',nodes:[
  {id:'input',type:'input'},
  {id:'agent',type:'agent',name:'Directory agent',model:'fixture::remote',prompt:'Respect the saved fixture objective.',sandbox:'danger-full-access'},
  {id:'output',type:'output'}],
  edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}});
class Runtime extends EventEmitter {
  constructor(){super();this.calls=[];this.phases=[];this.firstPhase=deferred();this.release=deferred();this.store={get:()=>({baseUrl:'https://api.example/v1'})};}
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
  async runAgent(options){
    const phase=phaseOf(options);this.calls.push(options);assert.ok(phase,'The test must be in a prepared Directory phase');
    this.phases.push(phase.label);
    if(this.calls.length===1){this.firstPhase.resolve();await this.release.promise;}
    options.signal.throwIfAborted();
    return {output:JSON.stringify(phaseResult(phase)),threadId:'synthetic-directory-'+this.calls.length};
  }
}
test('Directory later phases finish the already admitted turn after pause_after_turn without a new Goal run',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'deadline-directory-paused-turn-'));
  const cwd=path.join(dir,'workspace'),dataDir=path.join(dir,'data');await mkdir(cwd);
  const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd}).init();
  engine.runtimeSettings={get:()=>({subagentsEnabled:false,executionGuardrails:false})};
  const conversations=await new ConversationArchive({dataDir,engine}).init();
  const goals=await new ConversationGoals({engine,conversations,continuationDelayMs:10}).init();
  t.after(async()=>{runtime.release.resolve();await goals.close();await engine.close();await conversations.close();await rm(dir,{recursive:true,force:true});});
  const first=engine.startRun({workflow:graph(),input:{task:'Evaluate an isolated synthetic Directory fixture.',directoryMode:'on',subagentsMode:'off',
    goal:{objective:'Evaluate an isolated synthetic Directory fixture.'}}});
  try{
    await runtime.firstPhase.promise;
    const result=await goals.control(first.id,{action:'pause_after_turn',requestId:'directory-finish-only'});
    assert.equal(result.goal.status,'paused');
    assert.equal(result.goal.running,true);
    runtime.release.resolve();
    const done=await until(()=>engine.getRun(first.id).settled&&engine.getRun(first.id),'Directory run settlement');
    assert.equal(done.status,'completed',JSON.stringify({error:done.error,code:done.errorCode,phases:runtime.phases}));
    assert.ok(runtime.phases.includes('decompose'));
    assert.ok(runtime.phases.includes('work'));
    assert.ok(runtime.phases.includes('integration'));
    await until(async()=>(await goals.get(first.id)).finishCurrentRunId===null,'Goal settlement');
    assert.equal((await goals.get(first.id)).status,'paused');
    assert.equal((await conversations.family(first.id)).runs.length,1);
  }finally{runtime.release.resolve();}
});

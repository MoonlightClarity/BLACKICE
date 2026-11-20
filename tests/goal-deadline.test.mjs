import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {ConversationGoals,validateGoalInput} from '../lib/conversation-goals.mjs';
import {inferGoalDeadline,resolveGoalDeadline,goalDeadlineDue,parseDeadlineInstant} from '../lib/goal-deadline.mjs';

const ms = iso => Date.parse(iso);
const until = async (check,label='condition') => {
  const end=Date.now()+5000;
  while(Date.now()<end) { const x=await check();if(x)return x;await new Promise(r=>setTimeout(r,10)); }
  assert.fail('Timed out: '+label);
};
const graph = () => ({id:'deadline-test',name:'Deadline test',nodes:[
  {id:'input',type:'input',name:'Input'},
  {id:'agent',type:'agent',name:'Agent',model:'test-model',prompt:'Do the task.'},
  {id:'output',type:'output',name:'Output'}],
  edges:[{id:'in',source:'input',target:'agent'},{id:'out',source:'agent',target:'output'}],
  settings:{planningMode:'off',maxParallel:1}});
class Runtime extends EventEmitter {
  constructor(execute){super();this.execute=execute;this.calls=[];this.defaultModel='test-model';}
  status(){return {connected:true,authenticated:true,defaultModel:this.defaultModel};}
  async runAgent(options){this.calls.push(options);return this.execute(options,this.calls.length);}
  async savedThreadModel(){return 'test-model';}
}
async function fixture(t,execute,{clock,goals:goalOptions={}}={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-deadline-'));
  const cwd=path.join(dir,'workspace'),dataDir=path.join(dir,'data');await mkdir(cwd);
  const runtime=new Runtime(execute);
  const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd}).init();
  const conversations=await new ConversationArchive({dataDir,engine}).init();
  const goals=await new ConversationGoals({engine,conversations,now:()=>clock.now,monotonicNow:()=>clock.monotonic,
    deadlinePollMs:50,continuationDelayMs:10,retryDelayMs:10,...goalOptions}).init();
  t.after(async()=>{await goals.close();await engine.close();await conversations.close();await rm(dir,{recursive:true,force:true});});
  return {dir,cwd,dataDir,runtime,engine,conversations,goals};
}
const waitAbort=async ({signal}) => {
  await new Promise(resolve => {if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
  return {output:'Stopped after provider abort.',threadId:'deadline-thread'};
};
test('strict natural-language cutoff resolves 6 AM EST to next calendar day from original activation',()=>{
  const result=inferGoalDeadline('Apply for jobs for me until 6 AM EST.',ms('2026-11-15T00:21:47Z'));
  assert.equal(result.deadlineAt,'2026-11-15T11:00:00.000Z');
  assert.equal(result.deadlineTimeZone,'EST');
  assert.equal(result.deadlineSource,'objective');
  assert.equal(inferGoalDeadline('Apply for jobs with good benefits.',ms('2026-11-15T00:00:00Z')),null);
});
test('Eastern follows daylight saving but EST and EDT remain fixed UTC offsets',()=>{
  const anchor=ms('2026-03-08T00:00:00Z');
  assert.equal(inferGoalDeadline('Work until 6 AM Eastern',anchor).deadlineAt,'2026-03-08T10:00:00.000Z');
  assert.equal(inferGoalDeadline('Work until 6 AM EST',anchor).deadlineAt,'2026-03-08T11:00:00.000Z');
  assert.equal(inferGoalDeadline('Work until 6 AM EDT',anchor).deadlineAt,'2026-03-08T10:00:00.000Z');
  const fall=ms('2026-11-01T00:00:00Z');
  assert.equal(inferGoalDeadline('Work until 6 AM Eastern',fall).deadlineAt,'2026-11-01T11:00:00.000Z');
  assert.equal(inferGoalDeadline('Work until 6 AM EDT',fall).deadlineAt,'2026-11-01T10:00:00.000Z');
});
test('computer-local interpretation and explicit calendar date do not silently roll past a deadline',()=>{
  const anchor=ms('2026-11-15T00:21:47Z');
  assert.equal(inferGoalDeadline('Work until 6 AM',anchor,'America/New_York').deadlineAt,'2026-11-15T11:00:00.000Z');
  assert.equal(inferGoalDeadline('Work until today 6 AM EST',anchor).deadlineAt,'2026-11-14T11:00:00.000Z');
  assert.equal(inferGoalDeadline('Work until 2026-11-15 at 6 AM EST',anchor).deadlineAt,'2026-11-15T11:00:00.000Z');
  assert.throws(()=>inferGoalDeadline('Work until 2026-03-08 at 2:30 AM Eastern',ms('2026-03-07T13:00:00Z')),/does not exist/);
});
test('explicit absolute edit is the only override for a saved deadline, including after rollback',()=>{
  const old=resolveGoalDeadline({objective:'Work until 6 AM EST'},ms('2026-11-15T00:00:00Z'));
  const same=resolveGoalDeadline({objective:'New objective, no time'},ms('2026-11-16T00:00:00Z'),old);
  assert.deepEqual(same,old);
  const changed=resolveGoalDeadline({objective:'New objective',deadlineAt:'2026-11-17T11:00:00Z',deadlineTimeZone:'Eastern'},ms('2026-11-16T00:00:00Z'),old);
  assert.equal(changed.deadlineAt,'2026-11-17T11:00:00.000Z');
  assert.equal(changed.deadlineTimeZone,'America/New_York');
  assert.equal(parseDeadlineInstant('2026-11-17T06:00:00-05:00'),'2026-11-17T11:00:00.000Z');
  assert.throws(()=>parseDeadlineInstant('2026-11-17T06:00:00'),/absolute ISO 8601/);
  assert.equal(goalDeadlineDue({...old,deadlineExpiredAt:'2026-11-15T11:00:00.000Z'},ms('2026-11-15T10:00:00Z')),true);
  assert.deepEqual(validateGoalInput({objective:'Work without cutoff'}),{objective:'Work without cutoff',maxTurns:null,maxMinutes:null});
});
test('active provider is cancelled at the deadline without admitting a successor',async t=>{
  const clock={now:ms('2026-11-15T10:59:59Z'),monotonic:0};
  const {goals,runtime,engine,conversations}=await fixture(t,waitAbort,{clock});
  const run=engine.startRun({workflow:graph(),input:{task:'Apply for jobs until 6 AM EST.',goal:{objective:'Apply for jobs until 6 AM EST.'}}});
  await until(()=>runtime.calls.length===1,'provider admission');
  let goal=await goals.get(run.id);assert.equal(goal.deadlineAt,'2026-11-15T11:00:00.000Z');
  clock.now=ms('2026-11-15T11:00:00Z');clock.monotonic+=1000;
  goal=await until(async()=>{const g=await goals.get(run.id);return g?.status==='paused'&&g?.deadlineExpiredAt&&g?.pauseRequest?.settled&&g;},'deadline pause and cancellation settlement');
  assert.equal(goal.pauseRequest.mode,'deadline-interrupt-and-preserve');
  assert.equal(engine.getRun(run.id).status,'cancelled');
  assert.equal((await conversations.family(run.id)).runs.length,1);
  assert.equal(runtime.calls.length,1);
  clock.now=ms('2026-11-15T10:00:00Z');
  await assert.rejects(goals.control(run.id,{action:'resume',requestId:'resume-after-expiry'}),e=>e.code==='GOAL_DEADLINE_EXPIRED');
  assert.equal((await goals.get(run.id)).status,'paused','clock rollback cannot revive an expired Goal');
});
test('deadline wins while automatic successor waits in async preflight',async t=>{
  const clock={now:ms('2026-11-15T10:59:55Z'),monotonic:0};
  let entered=false,release;
  const preflight=new Promise(resolve=>{release=resolve;});
  const {goals,runtime,engine,conversations}=await fixture(t,async() => ({output:'One stage',threadId:'thread-1'}),{clock,goals:{continuationDelayMs:10}});
  runtime.savedThreadModel=async()=>{entered=true;await preflight;return 'test-model';};
  const run=engine.startRun({workflow:graph(),input:{task:'Until 6 AM EST',goal:{objective:'Work until 6 AM EST.'}}});
  await until(()=>entered,'saved thread preflight');
  assert.equal(runtime.calls.length,1);
  clock.now=ms('2026-11-15T11:00:01Z');clock.monotonic+=6000;release();
  await until(async()=>(await goals.get(run.id))?.status==='paused','preflight stopped by deadline');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(runtime.calls.length,1);
  assert.equal((await conversations.family(run.id)).runs.length,1);
});

test('Goal creation accepts a fully written calendar date with an agreeing UTC equivalent',()=>{
 const objective='Apply for jobs until Friday, November 20, 2026 at 6:00 AM EST (11:00 UTC).';
 const result=resolveGoalDeadline(validateGoalInput({objective}),ms('2026-11-20T00:00:00Z'),'','America/New_York');
 assert.equal(result.deadlineAt,'2026-11-20T11:00:00.000Z');
 assert.equal(result.deadlineTimeZone,'EST');
 assert.equal(result.deadlineExpression,'until Friday, November 20, 2026 at 6:00 AM EST (11:00 UTC)');
 assert.throws(()=>inferGoalDeadline(objective.replace('11:00 UTC','10:00 UTC')),/contradicts/);
 assert.throws(()=>inferGoalDeadline(objective.replace('Friday','Saturday')),/weekday/);
 assert.throws(()=>inferGoalDeadline(objective.replace('November 20','November 31')),/calendar date/);
 assert.equal(inferGoalDeadline('Work until March 9, 2026 at 6 AM Eastern').deadlineAt,'2026-03-09T10:00:00.000Z');
});

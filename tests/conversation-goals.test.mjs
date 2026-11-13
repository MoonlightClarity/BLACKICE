import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, rm, readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {ConversationGoals, validateGoalInput} from '../lib/conversation-goals.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; };
const waitFor = async (fn, message = 'condition') => {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(done => setTimeout(done, 5)); }
  assert.fail('Timed out: ' + message);
};
const graph = () => ({id:'goal-test',name:'Goal test',nodes:[{id:'input',type:'input',name:'Input'},{id:'agent',type:'agent',name:'Agent',model:'test-model',prompt:'Do the task.'},{id:'output',type:'output',name:'Output'}],edges:[{id:'in',source:'input',target:'agent'},{id:'out',source:'agent',target:'output'}],settings:{planningMode:'off',maxParallel:1}});
class Runtime extends EventEmitter {
  constructor(execute) { super(); this.execute = execute; this.calls = []; this.defaultModel = 'test-model'; }
  status() { return {connected:true,authenticated:true,defaultModel:this.defaultModel}; }
  async runAgent(options) { this.calls.push(options); return this.execute(options, this.calls.length); }
  async savedThreadModel() { return 'test-model'; }
}
async function fixture(t, execute, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'blackice-goal-'));
  const cwd = path.join(dir,'workspace'), dataDir = path.join(dir,'data'); await mkdir(cwd);
  const runtime = new Runtime(execute), engine = await new HarnessEngine({runtime, dataDir, defaultCwd:cwd, ...options.engine}).init();
  const conversations = await new ConversationArchive({dataDir,engine}).init();
  const goals = await new ConversationGoals({engine,conversations,continuationDelayMs:10,retryDelayMs:10,...options.goals}).init();
  t.after(async () => { await goals.close(); await engine.close(); await conversations.close(); await rm(dir,{recursive:true,force:true}); });
  return {dir,cwd,dataDir,runtime,engine,conversations,goals};
}
async function report(options, action, fields = {}) {
  const read = await options.onToolCall({name:'relay_goal',arguments:{action:'read'}});
  assert.equal(read.success,true);
  const goal = JSON.parse(read.contentItems[0].text).goal;
  const result = await options.onToolCall({name:'relay_goal',arguments:{action,goalId:goal.id,summary:action === 'complete' ? 'The requested result is complete.' : 'A concrete stage is complete.',evidence:'The fixture verified the requested result using its actual recorded test output.',...fields}});
  return {goal,result};
}
const output = n => ({output:'Fixture progress '+n,threadId:'goal-test-thread'});

test('goals have no implicit budget and reject invalid authored limits', () => {
  assert.deepEqual(validateGoalInput({objective:'Finish the work'}),{objective:'Finish the work',maxTurns:null,maxMinutes:null});
  assert.throws(() => validateGoalInput({objective:'x',maxTurns:0}),/positive/);
  assert.throws(() => validateGoalInput({objective:'x',maxMinutes:-1}),/positive/);
});

test('one goal continues for three turns in the same conversation and finishes with evidence', async t => {
  const {engine,goals,runtime,conversations} = await fixture(t, async (options,n) => {
    assert.ok(options.dynamicTools.some(tool => tool.name === 'relay_goal'));
    assert.ok(options.dynamicTools.every(tool => tool.type === 'function'), 'Native dynamic tool catalog must be consistently canonical, including relay_goal');
    assert.match(options.developerInstructions,/PERSISTENT CONVERSATION GOAL/);
    const {result} = await report(options,n === 3 ? 'complete' : 'progress'); assert.equal(result.success,true);
    return output(n);
  });
  const first = engine.startRun({workflow:graph(),input:{task:'Complete three stages.',goal:{objective:'Complete three stages.'}},requestId:'three-turn-goal'});
  await waitFor(async () => (await goals.get(first.id))?.status === 'completed','goal completion');
  const goal = await goals.get(first.id), family = await conversations.family(first.id);
  assert.equal(runtime.calls.length,3); assert.equal(family.runs.length,3); assert.ok(family.runs.every(run => run.taskId === first.id));
  assert.equal(goal.turns,3); assert.equal(goal.maxTurns,null); assert.equal(goal.running,false); assert.equal(goal.completionEvidence.runId,family.runs[2].id);
  assert.equal(family.runs[2].goal.automatic,true); assert.equal(family.runs[2].priorUserRequests.length,1);
});

test('ordinary final text cannot complete the goal and three empty turns are visible as stalled', async t => {
  const {engine,goals,runtime} = await fixture(t, async (_,n) => ({...output(n),output:'All done!'}));
  const run = engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(async () => (await goals.get(run.id))?.status === 'blocked');
  const goal = await goals.get(run.id); assert.equal(runtime.calls.length,3); assert.equal(goal.completionEvidence,null); assert.match(goal.lastReason,/no tool work or recorded progress/);
});

test('pause keeps an in-flight turn and prevents automatic continuation', async t => {
  const release = deferred();
  const {engine,goals,runtime} = await fixture(t, async (options,n) => { await report(options,'progress'); await release.promise; return output(n); });
  const run = engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(() => runtime.calls.length === 1);
  const paused = await goals.control(run.id,{action:'pause',requestId:'pause-once'}); assert.equal(paused.goal.status,'paused'); assert.equal(paused.goal.running,true);
  release.resolve(); await waitFor(() => engine.getRun(run.id).settled); await new Promise(done => setTimeout(done,60));
  assert.equal(runtime.calls.length,1); assert.equal((await goals.get(run.id)).status,'paused');
});

test('goal limits stop at the requested allowance and resume renews the allowance', async t => {
  const {engine,goals,runtime} = await fixture(t, async (options,n) => { await report(options,'progress'); return output(n); });
  const run = engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work',maxTurns:2}}});
  await waitFor(async () => (await goals.get(run.id))?.status === 'budget_exhausted'); assert.equal(runtime.calls.length,2);
  await goals.control(run.id,{action:'resume',requestId:'budget-resume'});
  await waitFor(async () => (await goals.get(run.id))?.status === 'budget_exhausted' && runtime.calls.length === 4);
  const goal = await goals.get(run.id); assert.equal(goal.turns,2); assert.equal(goal.totalTurns,4);
});

test('replayed control requests do not replace the goal or enqueue another run', async t => {
  const release = deferred();
  const {engine,goals,runtime} = await fixture(t, async (_,n) => { if (n > 1) await release.promise; return output(n); });
  const first = engine.startRun({workflow:graph(),input:'Ordinary first turn'}); await waitFor(() => engine.getRun(first.id).settled);
  const body = {action:'set',objective:'Continue the goal',requestId:'same-set-request'};
  const accepted = await goals.control(first.id,body); await waitFor(() => runtime.calls.length === 2);
  const repeated = await goals.control(first.id,body); assert.equal(repeated.replayed,true); assert.equal(repeated.goal.id,accepted.goal.id); assert.equal(runtime.calls.length,2);
  await assert.rejects(goals.control(first.id,{...body,objective:'Different objective'}),error => error.code === 'GOAL_REQUEST_CONFLICT');
  await goals.control(first.id,{action:'pause'}); release.resolve();
});

test('editing the goal invalidates completion from the old objective', async t => {
  const release = deferred(); let completedFirst;
  const {engine,goals,runtime} = await fixture(t, async (options,n) => {
    const reported = await report(options,'complete'); if (n === 1) {completedFirst = true; await release.promise;}
    assert.equal(reported.result.success,true); return output(n);
  });
  const run = engine.startRun({workflow:graph(),input:{task:'Initial objective',goal:{objective:'Initial objective'}}});
  await waitFor(() => completedFirst);
  await goals.control(run.id,{action:'update',objective:'Expanded objective'}); release.resolve();
  await waitFor(async () => (await goals.get(run.id))?.status === 'completed');
  assert.equal(runtime.calls.length,2); assert.equal((await goals.get(run.id)).objective,'Expanded objective');
});

test('human steering invalidates a completion candidate and is preserved for the next turn', async t => {
  const release = deferred(); let candidate;
  const {engine,goals,runtime} = await fixture(t, async (options,n) => { await report(options,'complete'); if(n===1){candidate=true;await release.promise;} return output(n); });
  const run = engine.startRun({workflow:graph(),input:{task:'Initial objective',goal:{objective:'Initial objective'}}});
  await waitFor(() => candidate);
  const live = engine.runs.get(run.id); engine.notify('agent.event',live,'agent',{type:'steer',accepted:true,text:'Also include the extra requirement.'});
  await waitFor(() => goals.raw(run.id).generation === 2); release.resolve();
  await waitFor(async () => (await goals.get(run.id))?.status === 'completed');
  assert.equal(runtime.calls.length,2); const latest = [...engine.runs.values()].at(-1); assert.ok(latest.priorUserRequests.some(row=>row.text.includes('extra requirement')));
});

test('user pause during an asynchronous continuation lookup wins the dispatch race', async t => {
  const reached = deferred(), releaseLookup = deferred(); let lookup = false;
  const {engine,goals,runtime,conversations} = await fixture(t, async (options,n) => {await report(options,'progress');return output(n);},{goals:{continuationDelayMs:40}});
  const run = engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(() => engine.getRun(run.id).settled);
  const family = conversations.family.bind(conversations);
  conversations.family = async id => { if(!lookup){lookup=true;reached.resolve();await releaseLookup.promise;} return family(id); };
  await reached.promise;
  const paused = goals.control(run.id,{action:'pause'}); await new Promise(done=>setImmediate(done)); releaseLookup.resolve(); await paused;
  await new Promise(done=>setTimeout(done,70)); assert.equal(runtime.calls.length,1); assert.equal((await goals.get(run.id)).status,'paused');
});

test('clear before initial delayed admission cannot resurrect the original goal', async t => {
  const background = deferred();
  const {engine,goals,runtime} = await fixture(t, async (_,n)=>output(n), {engine:{learning:{cancelBackground:()=>background.promise,scheduleAfterRun:async()=>{},getContext:()=>({lessons:[],skills:[],facts:[],truncated:false})}}});
  const run = engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await goals.control(run.id,{action:'clear',requestId:'clear-before-admit'}); background.resolve();
  await waitFor(()=>engine.getRun(run.id).settled); assert.equal(await goals.get(run.id),null); assert.equal(runtime.calls.length,1,JSON.stringify(engine.getRun(run.id).nodes));
});

test('goal completion retains pages until settlement and cleans earlier run owners', async t => {
  const releases=[]; let beforeFinal;
  const {engine,goals} = await fixture(t, async(options,n)=>{await report(options,n===2?'complete':'progress');if(n===2)beforeFinal=goals.retainsResources([...engine.runs.values()].at(-1));return output(n);});
  engine.browser = {releaseOwner:async(context,settings)=>{releases.push({context,settings});return{};},status:()=>({contained:false})};
  const run = engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(async()=>(await goals.get(run.id))?.status==='completed'); await waitFor(()=>releases.some(row=>row.context.runId===run.id&&row.settings.status==='completed'));
  assert.equal(beforeFinal,true); assert.ok(releases.some(row=>row.settings.status==='paused')); assert.ok(releases.filter(row=>row.settings.status==='completed').length>=2);
});

test('initial goal option is bound to the existing run idempotency receipt', async t => {
  const {engine,goals} = await fixture(t,async(options,n)=>{await report(options,'complete');return output(n);});
  const value={workflow:graph(),input:{task:'Same task',goal:{objective:'Objective A'}},requestId:'goal-start-idempotency'};
  const first=engine.startRun(value); assert.equal(engine.startRun(value).id,first.id);
  assert.throws(()=>engine.startRun({...value,input:{task:'Same task',goal:{objective:'Objective B'}}}),/request/i);
  await waitFor(async()=>(await goals.get(first.id))?.status==='completed');
});

test('an incoming user request holds automatic dispatch across body and archive IO', async t => {
  const {engine,goals,runtime} = await fixture(t,async(options,n)=>{await report(options,'progress');return output(n);},{goals:{continuationDelayMs:35}});
  const run=engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(()=>engine.getRun(run.id).settled);
  const release=goals.holdForUserInput(run.id); await new Promise(done=>setTimeout(done,80)); assert.equal(runtime.calls.length,1);
  const next=engine.continueRun(run.id,{nodeId:'agent',message:'A new user request takes priority.'}); release(); release();
  await waitFor(()=>engine.getRun(next.id).settled); await goals.control(run.id,{action:'pause'});
  assert.equal(runtime.calls.length,2); assert.equal(engine.getRun(next.id).input,'A new user request takes priority.');
});

test('goal start can be deferred until server dependencies are ready', async t => {
  const {engine,goals,runtime} = await fixture(t,async(options,n)=>{await report(options,n===2?'complete':'progress');return output(n);},{goals:{autoStart:false}});
  const run=engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(()=>engine.getRun(run.id).settled); await new Promise(done=>setTimeout(done,50)); assert.equal(runtime.calls.length,1);
  goals.start(); await waitFor(async()=>(await goals.get(run.id))?.status==='completed'); assert.equal(runtime.calls.length,2);
});

test('a durable completion candidate is reconciled on restart without another model turn', async t => {
  let fixtureValues;
  fixtureValues=await fixture(t,async(options,n)=>{
    await report(options,'complete'); fixtureValues.engine.off('event',fixtureValues.goals.listener); return output(n);
  });
  const {engine,goals,conversations,dataDir,cwd}=fixtureValues;
  const first=engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(()=>engine.getRun(first.id).settled); assert.equal((await goals.get(first.id)).status,'active');
  await goals.close(); await engine.persist(); await conversations.capture(engine.getRun(first.id)); await engine.close(); await conversations.close();
  const runtime2=new Runtime(async()=>{assert.fail('A completed goal must not start again.');});
  const engine2=await new HarnessEngine({runtime:runtime2,dataDir,defaultCwd:cwd}).init();
  const archive2=await new ConversationArchive({dataDir,engine:engine2}).init();
  const goals2=await new ConversationGoals({engine:engine2,conversations:archive2,continuationDelayMs:10}).init();
  try {assert.equal((await goals2.get(first.id)).status,'completed'); assert.equal(runtime2.calls.length,0);}
  finally {await goals2.close();await engine2.close();await archive2.close();}
});

test('an interrupted goal survives restart without replaying uncertain work', async t => {
  const {engine,goals,conversations,dataDir,cwd,runtime}=await fixture(t,async(options,n)=>{
    await report(options,'progress'); if(!options.signal.aborted)await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true})); return output(n);
  });
  const first=engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(()=>runtime.calls.length===1); await goals.close(); await engine.close(); await conversations.close();
  const runtime2=new Runtime(async()=>{assert.fail('Interrupted work must not replay.');});
  const engine2=await new HarnessEngine({runtime:runtime2,dataDir,defaultCwd:cwd}).init();
  const archive2=await new ConversationArchive({dataDir,engine:engine2}).init();
  const goals2=await new ConversationGoals({engine:engine2,conversations:archive2,continuationDelayMs:10}).init();
  try {assert.equal((await goals2.get(first.id)).status,'interrupted');await new Promise(done=>setTimeout(done,40));assert.equal(runtime2.calls.length,0);}
  finally {await goals2.close();await engine2.close();await archive2.close();}
});

test('dispatch storage errors produce a visible blocked reason instead of an idle active goal', async t => {
  const {engine,goals,conversations}=await fixture(t,async(options,n)=>{await report(options,'progress');return output(n);},{goals:{continuationDelayMs:50}});
  const first=engine.startRun({workflow:graph(),input:{task:'Do work',goal:{objective:'Do work'}}});
  await waitFor(()=>engine.getRun(first.id).settled);
  const original=conversations.family.bind(conversations);conversations.family=async()=>{throw Error('Fixture archive read failed');};
  await waitFor(async()=>(await goals.get(first.id))?.status==='blocked');assert.match((await goals.get(first.id)).lastReason,/archive read failed/);
  conversations.family=original;
});

test('editing a goal during delayed automatic admission resumes the new objective in the same conversation', async t => {
  const admission = deferred(); let backgroundCalls = 0, admissionHeld = false;
  const {engine,goals,runtime,conversations} = await fixture(t, async(options,n) => {
    await report(options,n === 1 ? 'progress' : 'complete'); return output(n);
  }, {engine:{learning:{
    cancelBackground:() => { if (++backgroundCalls === 2) { admissionHeld = true; return admission.promise; } },
    scheduleAfterRun:async()=>{},getContext:()=>({lessons:[],skills:[],facts:[],truncated:false}),
  }}});
  const first = engine.startRun({workflow:graph(),input:{task:'Initial objective',goal:{objective:'Initial objective'}}});
  let rejected;
  try {
    await waitFor(() => admissionHeld,'automatic admission waiting for background work');
    rejected = [...engine.runs.values()].find(run => run.id !== first.id);
    assert.ok(rejected); assert.equal(runtime.calls.length,1);
    await goals.control(first.id,{action:'update',objective:'Expanded objective',requestId:'update-during-admission'});
  } finally { admission.resolve(); }
  await waitFor(() => engine.getRun(rejected.id).settled,'superseded admission settlement');
  assert.equal(engine.getRun(rejected.id).errorCode,'GOAL_DISPATCH_SUPERSEDED');
  await waitFor(async() => (await goals.get(first.id))?.status === 'completed','updated goal completion');
  const family = await conversations.family(first.id), goal = await goals.get(first.id);
  assert.equal(runtime.calls.length,2); assert.equal(family.runs.length,3);
  assert.ok(family.runs.every(run => run.taskId === first.id));
  assert.equal(family.runs.at(-1).goal.objective,'Expanded objective'); assert.equal(goal.totalTurns,2);
});

test('rejected goal waits preserve recorded progress and completion through the real engine', async t => {
  let observed;
  const {engine,goals,runtime} = await fixture(t, async(options,n) => {
    await report(options,'progress');
    const {goal} = await report(options,'complete');
    const live = [...engine.runs.values()].at(-1);
    const before = structuredClone({progress:live.goalProgress,completion:live.goalCompletion});
    const invalid = await options.onToolCall({name:'relay_goal',arguments:{
      action:'wait',goalId:goal.id,summary:'An invalid wait is not progress.',
      evidence:'The requested wait has no valid observed retry time.',waitUntil:'not-a-date',
    }});
    observed = {before,after:structuredClone({progress:live.goalProgress,completion:live.goalCompletion}),accepted:invalid.success};
    return output(n);
  }, {goals:{continuationDelayMs:100}});
  const first = engine.startRun({workflow:graph(),input:{task:'Finish the requested result',goal:{objective:'Finish the requested result'}}});
  await waitFor(() => engine.getRun(first.id).settled);
  assert.equal(observed.accepted,false); assert.deepEqual(observed.after,observed.before);
  await waitFor(async() => (await goals.get(first.id))?.status === 'completed');
  assert.equal(runtime.calls.length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {inferGoalDeadline,parseDeadlineInstant,resolveGoalDeadline} from '../lib/goal-deadline.mjs';

const cutoff='2026-11-15T11:00:00.000Z', ms=value=>Date.parse(value);
const effect=[{id:'unknown-click',signature:'a'.repeat(64),kind:'uncertain_external_effect',resolution:null}];
function harness({now=ms('2026-11-15T10:59:50Z'),status='active',goal=null}={}) {
 const clock={now,mono:0},initial=goal||{
   id:'deadline-goal',objective:'Work until 6 AM EST.',generation:1,revision:1,
   createdAt:'2026-11-15T00:21:47.251Z',activatedAt:'2026-11-15T00:21:47.251Z',
   deadlineAt:cutoff,deadlineTimeZone:'EST',deadlineExpression:'until 6 AM EST',
   deadlineSource:'objective',deadlineExpiredAt:null,status,maxTurns:null,maxMinutes:null,
   turns:1,totalTurns:1,currentRunId:'live',lastSettledRunId:null,dispatch:null
 };
 const states={root:{goal:initial,goalUnresolvedEffects:structuredClone(effect),goalControlReceipts:[]}};
 let stateWrites=0,cancelled=[];
 const run={id:'live',taskId:'root',status:'running',settled:false,goal:{id:'deadline-goal',generation:1},
   finishedAt:null,goalEvidence:[]};
 const engine=new EventEmitter();
 engine.runs=new Map([['live',run]]);engine.closed=false;
 engine.cancelRun=id=>{cancelled.push(id);const r=engine.runs.get(id);if(r){r.status='cancelled';r.finishedAt=new Date(clock.now).toISOString();}};
 engine.persist=async()=>{};
 const conversations={
   states,entries:new Map([['root',{}]]),
   async changeState(id,patch){Object.assign(states[id],patch);stateWrites++;},
   async family(){return {rootId:'root',state:'active',runs:[run]};}
 };
 const goals=new ConversationGoals({engine,conversations,now:()=>clock.now,monotonicNow:()=>clock.mono,autoStart:false,deadlinePollMs:50});
 goals.listener=()=>{}; // Stub intentionally has no live host listener.
 return {clock,run,engine,conversations,states,goals,cancelled,get stateWrites(){return stateWrites;}};
}
test('completed Goal is not rewritten by overdue startup migration or expiry',async()=>{
 const h=harness({now:ms('2026-11-15T11:10:00Z'),status:'completed'});
 const report={summary:'Fully verified before cutoff',evidence:'Durable success result'};
 h.states.root.goal={...h.states.root.goal,status:'completed',completedAt:'2026-11-15T10:58:00Z',completionEvidence:report};
 const frozen=structuredClone(h.states.root.goal);
 await h.goals.init();
 assert.deepEqual(h.states.root.goal,frozen);
 assert.equal(h.stateWrites,0);
 assert.deepEqual(h.cancelled,[]);
 assert.deepEqual(h.states.root.goalUnresolvedEffects,effect);
 await h.goals.close();
});
test('paused/interrupted over deadline retain lifecycle and historical effects on restart',async()=>{
 const h=harness({now:ms('2026-11-15T11:10:00Z'),status:'paused'});
 h.states.root.goal.lastReason='Stopped by user';
 const previous=structuredClone(h.states.root.goal);
 await h.goals.init();
 assert.equal(h.states.root.goal.status,'paused');
 assert.equal(h.states.root.goal.lastReason,'Stopped by user');
 assert.equal(h.states.root.goal.deadlineExpiredAt,'2026-11-15T11:10:00.000Z');
 assert.deepEqual(h.states.root.goalUnresolvedEffects,effect);
 assert.deepEqual(h.cancelled,[]);
 assert.equal(h.states.root.goal.id,previous.id);
 await h.goals.close();
});
test('legacy unsupported cutoff pauses only its affected Goal; terminal completion remains untouched',async()=>{
 const h=harness({now:ms('2026-11-15T11:10:00Z'),status:'active'});
 delete h.states.root.goal.deadlineAt;
 h.states.root.goal.objective='Work until 6 AM PST';
 await h.goals.init();
 assert.equal(h.states.root.goal.status,'paused');
 assert.match(h.states.root.goal.deadlineParseError.message,/ambiguous|unsupported/i);
 assert.deepEqual(h.states.root.goalUnresolvedEffects,effect);
 await h.goals.close();
});
test('strict deadline parser never substitutes a partial timezone or date',()=>{
 const at=ms('2026-11-15T00:21:47Z');
 for(const text of [
   'Work until 6 AM PST','Work until 6 AM on Friday','Work until tomorrow',
   'Work until 6 AM GMT+3','Work until 6 AM EST on November 16',
   'Work until 25:00','Work until 6 AM UTC tomorrow and until 7 AM UTC'
 ])assert.throws(()=>inferGoalDeadline(text,at),/deadline|unsupported|ambiguous|unrecognized|multiple/i,text);
 assert.equal(inferGoalDeadline('Work until 6 AM EST tomorrow',at).deadlineAt,'2026-11-15T11:00:00.000Z');
 assert.equal(inferGoalDeadline('Work until 6 AM tomorrow',at,'America/New_York').deadlineAt,'2026-11-15T11:00:00.000Z');
 assert.equal(inferGoalDeadline('Work until 6 AM EST, then stop',at).deadlineAt,'2026-11-15T11:00:00.000Z');
 assert.equal(inferGoalDeadline('Work until results improve',at),null);
});
test('DST gap and fall fold reject ambiguous local cutoffs; explicit offsets disambiguate',()=>{
 assert.throws(()=>inferGoalDeadline('Work until 2026-11-01 at 1:30 AM Eastern',ms('2026-10-31T15:00:00Z')),/ambiguous/i);
 assert.throws(()=>inferGoalDeadline('Work until 2026-03-08 at 2:30 AM Eastern',ms('2026-03-07T15:00:00Z')),/does not exist/i);
 assert.equal(resolveGoalDeadline({objective:'Work',deadlineAt:'2026-11-01T01:30:00-04:00',deadlineTimeZone:'Eastern'}).deadlineAt,'2026-11-01T05:30:00.000Z');
 assert.equal(resolveGoalDeadline({objective:'Work',deadlineAt:'2026-11-01T01:30:00-05:00',deadlineTimeZone:'Eastern'}).deadlineAt,'2026-11-01T06:30:00.000Z');
 assert.throws(()=>resolveGoalDeadline({objective:'Work',deadlineAt:'2026-03-08T02:30:00-05:00',deadlineTimeZone:'Eastern'}),/contradicts/i);
 assert.throws(()=>parseDeadlineInstant('2026-02-30T06:00:00Z'),/invalid calendar/i);
});
test('explicit null cutoff remains cleared through unrelated objective edits',async()=>{
 const h=harness({goal:{id:'deadline-goal',objective:'Work until 6 AM EST.',generation:1,revision:1,
   status:'paused',deadlineAt:null,deadlineTimeZone:null,deadlineSource:'explicit-clear',
   deadlineExpression:null,deadlineExpiredAt:null,maxTurns:null,maxMinutes:null,turns:0,totalTurns:0}});
 const updated=await h.goals.control('root',{action:'update',objective:'Updated work until 6 AM EST.',requestId:'update-no-deadline-change'});
 assert.equal(updated.goal.deadlineAt,null);
 assert.equal(updated.goal.deadlineSource,'explicit-clear');
 assert.equal(updated.goal.status,'paused');
 await h.goals.close();
});
test('postdeadline relay_goal complete is refused even without outer tool wrapper',async()=>{
 const h=harness({now:ms(cutoff)});
 const call={name:'relay_goal',arguments:{action:'complete',goalId:'deadline-goal',summary:'Done',evidence:'This synthetic fixture completed a fully inspected deliverable.'}};
 let calls=0;const wrapped=h.goals.wrapTools(h.run,'agent',async()=>{calls++;return {success:true}});
 const denied=await wrapped(call,{});
 assert.equal(denied.code,'GOAL_DEADLINE_EXPIRED');
 assert.equal(denied.actionDispatched,false);
 assert.equal(calls,0);
 const direct=await h.goals.handle(h.run,'agent',call);
 assert.equal(direct.code,'GOAL_DEADLINE_EXPIRED');
 await h.goals.close();
 assert.equal(h.states.root.goal.status,'paused');
 assert.equal(h.run.goalCompletion,undefined);
 assert.deepEqual(h.states.root.goalUnresolvedEffects,effect);
});
test('completion persistence crossing deadline retains candidate but cannot mark Goal completed',async()=>{
 const h=harness();
 h.engine.persist=async()=>{h.clock.now=ms('2026-11-15T11:00:00Z');};
 const reply=await h.goals.handle(h.run,'agent',{name:'relay_goal',arguments:{
   action:'complete',goalId:'deadline-goal',summary:'Synthetic completion result',evidence:'Saved a plausible result before the clock crossed into cutoff.'}});
 assert.equal(reply.code,'GOAL_DEADLINE_EXPIRED');
 assert.equal(h.states.root.goal.status,'paused');
 assert.equal(h.states.root.goal.completionEvidence,undefined);
 assert.equal(h.states.root.goal.lateCompletionEvidence.goalId,'deadline-goal');
 assert.deepEqual(h.states.root.goalUnresolvedEffects,effect);
 await h.goals.close();
});
test('late successful run settlement preserves evidence but not a false timely completed status',async()=>{
 const h=harness({now:ms('2026-11-15T11:00:10Z')});
 h.run.status='completed';h.run.settled=true;h.run.finishedAt='2026-11-15T11:00:03Z';
 h.run.goalCompletion={goalId:'deadline-goal',generation:1,at:'2026-11-15T10:59:50Z',summary:'Observed fixture output',evidence:'Fixture evidence to preserve'};
 await h.goals.settled('root',h.run);
 assert.equal(h.states.root.goal.status,'paused');
 assert.equal(h.states.root.goal.completionEvidence,undefined);
 assert.equal(h.states.root.goal.lateCompletionEvidence.runFinishedAt,h.run.finishedAt);
 assert.equal(h.states.root.goal.lastSettledRunId,h.run.id);
 assert.deepEqual(h.states.root.goalUnresolvedEffects,effect);
 await h.goals.close();
});
test('timely finished run may complete even when its saved settlement callback is delayed',async()=>{
 const h=harness({now:ms('2026-11-15T11:00:10Z')});
 h.run.status='completed';h.run.settled=true;h.run.finishedAt='2026-11-15T10:59:55Z';
 h.run.goalCompletion={goalId:'deadline-goal',generation:1,at:'2026-11-15T10:59:50Z',summary:'Verified fixture output',evidence:'Fixture result was verified'};
 await h.goals.settled('root',h.run);
 assert.equal(h.states.root.goal.status,'completed');
 assert.equal(h.states.root.goal.completionEvidence.summary,'Verified fixture output');
 assert.deepEqual(h.states.root.goalUnresolvedEffects,effect);
 await h.goals.close();
});
test('deadline checked again after asynchronous initial Goal admission persistence',async()=>{
 const h=harness({goal:null});
 h.states.root.goal=null;
 const run={id:'first',taskId:'root',status:'queued',settled:false,goalRequest:{objective:'Work until 6 AM EST.'},goalEvidence:[]};
 h.engine.runs.clear();h.engine.runs.set(run.id,run);
 h.goals.prepareRun(run);
 const original=h.conversations.changeState.bind(h.conversations);
 h.conversations.changeState=async(id,patch)=>{await original(id,patch);if(patch.goal?.status==='active')h.clock.now=ms(cutoff);};
 await assert.rejects(h.goals.admitRun(run),e=>e.code==='GOAL_DEADLINE_EXPIRED');
 assert.equal(h.states.root.goal.status,'paused');
 assert.equal(h.states.root.goal.deadlineExpiredAt,cutoff);
 assert.deepEqual(h.cancelled,['first']);
 assert.deepEqual(h.states.root.goalUnresolvedEffects,effect);
 await h.goals.close();
});

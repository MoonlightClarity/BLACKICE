import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ConversationGoals} from '../lib/conversation-goals.mjs';

const ms = value => Date.parse(value);
function stub({now=ms('2026-11-15T10:59:50Z'),mono=0,deadlineAt='2026-11-15T11:00:00.000Z',legacy=false}={}) {
 const clock={now,mono};
 const states={root:{goal:legacy?{
   id:'legacy-goal',generation:1,revision:1,objective:'Apply until 6 AM EST.',
   status:'active',turns:2,totalTurns:2,createdAt:'2026-11-15T00:21:47.251Z',activatedAt:'2026-11-15T00:21:47.251Z',
   currentRunId:null,lastSettledRunId:null,maxTurns:null,maxMinutes:null,dispatch:null
 }:{
   id:'deadline-goal',generation:1,revision:1,objective:'Apply until 6 AM EST.',
   status:'active',turns:2,totalTurns:2,createdAt:'2026-11-15T00:21:47.251Z',
   deadlineAt,deadlineTimeZone:'EST',deadlineSource:'objective',deadlineExpiredAt:null,
   currentRunId:null,lastSettledRunId:null,maxTurns:null,maxMinutes:null,dispatch:null
 }}};
 const effects=[{id:'unknown-effect',signature:'a'.repeat(64),kind:'uncertain_external_effect',resolution:null}];
 states.root.goalUnresolvedEffects=effects;states.root.goalControlReceipts=[];
 const conversations={states,entries:new Map([['root',{}]]),
   async changeState(id,patch){Object.assign(states[id],patch);},
   async family(){return {rootId:'root',runs:[{id:'previous',taskId:'root',status:'completed',settled:true}]};}
 };
 const engine=new EventEmitter();engine.runs=new Map();engine.cancelled=[];engine.cancelRun=id=>engine.cancelled.push(id);engine.closed=false;
 const goals=new ConversationGoals({engine,conversations,now:()=>clock.now,monotonicNow:()=>clock.mono,deadlinePollMs:50});
 goals.listener=()=>{}; // Stub tests which do not invoke init still need a no-op registered listener for close().
 return {clock,states,engine,conversations,goals,effects};
}
test('monotonic clock expiration cannot be pushed backwards by an in-process wall-clock rollback',async()=>{
 const s=stub({now:ms('2026-11-15T10:59:55Z'),mono:100});
 s.goals.armDeadline('root',s.states.root.goal);
 s.clock.now=ms('2026-11-15T10:00:00Z');
 s.clock.mono=5100;
 assert.equal(s.goals.deadlinePassed('root'),true);
 assert.equal(await s.goals.expireIfDue('root'),true);
 assert.equal(s.states.root.goal.status,'paused');
 assert.equal(s.states.root.goal.deadlineExpiredAt!==null,true);
 assert.deepEqual(s.states.root.goalUnresolvedEffects,s.effects);
 await s.goals.close();
});
test('post-deadline tool guard refuses dispatch and leaves historic uncertain effects untouched',async()=>{
 const s=stub();
 const run={id:'live',taskId:'root',goal:{id:'deadline-goal',generation:1},status:'running',settled:false};
 s.engine.runs.set(run.id,run);
 let dispatched=0;
 const guarded=s.goals.wrapTools(run,'agent',async()=>{dispatched++;return {success:true,contentItems:[]};});
 s.clock.now=ms('2026-11-15T11:00:00Z');
 const result=await guarded({name:'relay_browser',arguments:{action:'click',tabId:'example'}},{});
 assert.equal(result.success,false);
 assert.equal(result.code,'GOAL_DEADLINE_EXPIRED');
 assert.equal(result.actionDispatched,false);
 assert.equal(dispatched,0);
 // The asynchronous deadline handler persists before cancelling the owned run.
 for(let i=0;i<40 && s.states.root.goal.status!=='paused';i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(s.states.root.goal.status,'paused');
 assert.deepEqual(s.engine.cancelled,['live']);
 assert.deepEqual(s.states.root.goalUnresolvedEffects,s.effects);
 await s.goals.close();
});
test('startup migration of legacy literal cutoff expires instead of restoring a successor',async()=>{
 const s=stub({legacy:true,now:ms('2026-11-15T11:10:00Z')});
 await s.goals.init();
 assert.equal(s.states.root.goal.deadlineAt,'2026-11-15T11:00:00.000Z');
 assert.equal(s.states.root.goal.deadlineTimeZone,'EST');
 assert.equal(s.states.root.goal.status,'paused');
 assert.ok(s.states.root.goal.deadlineExpiredAt);
 assert.deepEqual(s.states.root.goalUnresolvedEffects,s.effects);
 await s.goals.close();
});
test('persisted expired latch survives restart when the reported computer time rolls backward',async()=>{
 const s=stub({now:ms('2026-11-15T11:10:00Z')});
 await s.goals.expireIfDue('root');
 await s.goals.close();
 s.clock.now=ms('2026-11-15T10:30:00Z');
 const next=new ConversationGoals({engine:s.engine,conversations:s.conversations,now:()=>s.clock.now});
 await next.init();
 assert.equal(s.states.root.goal.status,'paused');
 assert.ok(s.states.root.goal.deadlineExpiredAt);
 await assert.rejects(next.control('root',{action:'resume',requestId:'rollback-resume'}),e=>e.code==='GOAL_DEADLINE_EXPIRED');
 assert.deepEqual(s.states.root.goalUnresolvedEffects,s.effects);
 await next.close();
});

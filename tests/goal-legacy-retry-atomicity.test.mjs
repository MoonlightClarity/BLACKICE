import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {inFlightEffectSignature} from '../lib/goal-recovery-policy.mjs';

const legacySignature=args=>createHash('sha256').update(JSON.stringify(['relay_browser',
  Object.fromEntries(Object.entries(args).sort(([a],[b])=>a.localeCompare(b)))] )).digest('hex');
const old={action:'fill',browser:'relay',tabId:'owned-page',ref:'supported-field',value:'Answer from record'};
const current={...old,text:old.value};
delete current.value;
const oldSignature=legacySignature(old);
const make=({failStore=false,handler}={})=>{
 const row={id:'old-unknown',signature:oldSignature,kind:'uncertain_external_effect',
   at:'2026-11-24T09:05:00.000Z',code:'BROWSER_ACTION_FAILED',
   resolution:{outcome:'unknown',deliberateRetry:true,runId:'authorised-retry',retryUsedAt:null}};
 const conversations={states:{root:{goalUnresolvedEffects:[row]}},writes:0,failStore,
   async changeState(id,delta){
     if(this.failStore)throw Error('SAVE_FAILED');
     this.writes++;
     Object.assign(this.states[id],structuredClone(delta));
   }};
 const goals=new ConversationGoals({engine:{runs:new Map()},conversations,autoStart:false});
 goals.recoveryRunCurrent=()=>true;
 const run={id:'authorised-retry',taskId:'root',goal:{id:'goal'},goalEvidence:[]};
 const dispatches=[];
 const action=handler??(async call=>{dispatches.push(call);return {success:true,contentItems:[]};});
 const invoke=goals.wrapTools(run,'agent',action);
 return {conversations,invoke,dispatches};
};

test('a failed durable permit write blocks action, keeps permit, and a later healthy retry consumes once',async()=>{
 assert.notEqual(oldSignature,inFlightEffectSignature({name:'relay_browser',arguments:current}));
 const fixture=make({failStore:true});
 const call={name:'relay_browser',arguments:current};
 const aborted=await fixture.invoke(call);
 assert.equal(aborted.success,false);
 assert.equal(aborted.actionDispatched,false);
 assert.equal(fixture.dispatches.length,0,'Persistence error cannot allow an external write.');
 assert.equal(fixture.conversations.states.root.goalUnresolvedEffects[0].resolution.retryUsedAt,null);
 fixture.conversations.failStore=false;
 const repaired=await fixture.invoke(call);
 assert.equal(repaired.success,true);
 assert.equal(fixture.dispatches.length,1);
 assert.ok(fixture.conversations.states.root.goalUnresolvedEffects[0].resolution.retryUsedAt);
 assert.equal(fixture.conversations.writes,1);
 const repeated=await fixture.invoke(call);
 assert.equal(repeated.actionDispatched,false);
 assert.equal(fixture.dispatches.length,1);
});

test('equivalent legacy and canonical fill spellings share one in-flight guard during authorized retry',async()=>{
 let start,finish;
 const entered=new Promise(resolve=>{start=resolve;});
 const release=new Promise(resolve=>{finish=resolve;});
 const fixture=make({handler:async call=>{
   fixture.dispatches.push(call);start();
   await release;
   return {success:true,contentItems:[]};
 }});
 const first=fixture.invoke({name:'relay_browser',arguments:current});
 await entered;
 const overlapping=await fixture.invoke({name:'relay_browser',arguments:old});
 assert.equal(overlapping.code,'GOAL_EFFECT_UNRESOLVED',
   'After the permit was durably consumed, the authoritative saved receipt blocks another dispatch even while the first runs.');
 assert.equal(overlapping.actionDispatched,false);
 assert.equal(fixture.dispatches.length,1);
 finish();
 assert.equal((await first).success,true);
 assert.equal(fixture.conversations.writes,1);
 assert.ok(fixture.conversations.states.root.goalUnresolvedEffects[0].resolution.retryUsedAt);
 const later=await fixture.invoke({name:'relay_browser',arguments:old});
 assert.equal(later.actionDispatched,false);
 assert.equal(fixture.dispatches.length,1);
});

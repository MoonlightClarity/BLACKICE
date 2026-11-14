import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {handleConversationGoalsHttp} from '../lib/conversation-goals-http.mjs';
import {observeGoalToolOutcome} from '../lib/goal-recovery-policy.mjs';

test('operator effect outcomes are exact, durable, distinguishable and never replay', async () => {
  const call={name:'relay_browser',arguments:{action:'click',tabId:'fixture',ref:'submit'}};
  const signature = observeGoalToolOutcome(call,{success:false,code:'TIMEOUT'}).signature, row={id:'receipt-1',signature,at:'2026-11-14T20:00:00.000Z',kind:'uncertain_external_effect',tool:'relay_browser',action:'click'};
  let failWrite=false, writes=0, dispatches=0;
  const conversations={states:{root:{goalUnresolvedEffects:[row]}},async changeState(id,delta){writes++;if(failWrite)throw Error('disk failed');Object.assign(this.states[id],structuredClone(delta));}};
  const engine={runs:new Map()};const goals=new ConversationGoals({engine,conversations,autoStart:false});goals.resolve=async()=> 'root';
  const route=async(method,value={},headers={})=>{let output;await handleConversationGoalsHttp({req:{method,headers},res:{},pathname:'/api/conversations/root/goal-effects',goals,body:async()=>value,json:(_res,status,data)=>{output={status,data};}});return output;};
  assert.equal((await route('GET',{}, {'x-blackice-remote':'1'})).status,403);
  assert.equal((await route('GET')).data.receipts[0].id,'receipt-1');
  const input={receiptId:row.id,signature,observedAt:row.at,expectedResolutionCount:0,outcome:'occurred',evidence:'Operator found the destination receipt.'};
  assert.equal((await route('POST',{...input,receiptId:'stale'})).data.code,'GOAL_EFFECT_STALE');
  engine.runs.set('active',{id:'active',taskId:'root',status:'running',settled:false});
  assert.equal((await route('POST',input)).data.code,'GOAL_EFFECT_ACTIVE');
  engine.runs.get('active').status='cancelled';
  assert.equal((await route('POST',input)).data.code,'GOAL_EFFECT_ACTIVE');engine.runs.clear();
  failWrite=true;assert.notEqual((await route('POST',input)).status,200);assert.equal(conversations.states.root.goalUnresolvedEffects[0].resolution,undefined);
  failWrite=false;const response=await route('POST',input);assert.equal(response.status,200);assert.equal(response.data.receipt.resolution.outcome,'occurred');assert.equal(response.data.replayed,false);
  assert.equal(conversations.states.root.goalUnresolvedEffects[0].resolutions[0].evidence,input.evidence);
  const guarded=goals.wrapTools({id:'turn',taskId:'root',goal:{id:'g'},goalEvidence:[]},'agent',async()=>{dispatches++;return {success:true,contentItems:[]};});
  assert.equal((await guarded(call)).code,'GOAL_EFFECT_UNRESOLVED');
  assert.equal((await route('POST',input)).data.code,'GOAL_EFFECT_STALE');assert.equal(dispatches,0);assert.equal(writes,2);
});

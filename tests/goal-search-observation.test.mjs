import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {observeGoalToolOutcome,inFlightEffectSignature,assessGoalProgress,detectUnknownEffectReplay} from '../lib/goal-recovery-policy.mjs';

const session=randomUUID(), cursor=(n,s=session)=>'fs1:'+s+':'+String(n).padStart(8,'0')+'-0000-0000-0000-000000000000';
const search=(input)=>({name:'relay_find_files',arguments:{query:'resume',...(input?{cursor:input}:{})}});
const receipt=(next,count,extra={})=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify({engine:'filesystem',query:'resume',roots:['C:\\fixture'],match:'name',scannedEntries:count,cursor:next,scanComplete:next===null,searchComplete:false,matches:[],...extra})}]});
function fixture() {
 const engine=new EventEmitter();engine.runs=new Map();engine.conversationBusy=()=>false;engine.executionStatus=()=>({availableSlots:1});engine.runtime={};
 const dispatched=[];engine.continueRun=(id,request)=>{dispatched.push(request);return {id:'scheduled-'+dispatched.length};};
 const conversations={states:{root:{}},async changeState(id,patch){this.states[id]={...this.states[id],...structuredClone(patch)};},async family(){return {state:'active',runs:[...engine.runs.values()]};}};
 const goals=new ConversationGoals({engine,conversations,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 conversations.states.root.goal=goals.create({objective:'Find the resume, without claiming that an incomplete search proves absence.'});
 async function turn(call,result) {
  const n=engine.runs.size+1,goal=goals.raw('root');
  const run={id:'run-'+n,taskId:'root',goal:{id:goal.id,generation:goal.generation},status:'running',settled:false,
   workflow:{nodes:[{id:'agent',type:'agent',model:'fixture'}]},nodes:{},goalEvidence:[]};
  engine.runs.set(run.id,run);
  await goals.save('root',{...goal,currentRunId:run.id,turns:n,totalTurns:n});
  await goals.wrapTools(run,'agent',async()=>result)(call);
  run.status='completed';run.settled=true;await goals.settled('root',run);
  return run;
 }
 return {engine,conversations,goals,dispatched,turn};
}
test('named filename discovery is passive on success, failure and in-flight detection; unknown effects remain protected',()=>{
 const call=search(cursor(1));
 assert.equal(inFlightEffectSignature(call),null);
 assert.equal(observeGoalToolOutcome(call,receipt(cursor(2),10)).kind,'observation');
 assert.equal(observeGoalToolOutcome(call,{success:false,code:'TIMEOUT'}).kind,'recoverable_read_friction');
 const effect={name:'other_tool',arguments:{action:'submit',target:'fixture'}};
 const unknown=observeGoalToolOutcome(effect,{success:false,code:'TIMEOUT'});
 assert.equal(unknown.kind,'uncertain_external_effect');
 assert.equal(detectUnknownEffectReplay([unknown],effect).code,'GOAL_EFFECT_UNRESOLVED');
 assert.equal(detectUnknownEffectReplay([unknown],call),null);
});
test('nine advancing cursor turns settle and dispatch beyond seven without claiming completion; user turn budget still stops',async()=>{
 const f=fixture();await f.goals.save('root',{...f.goals.raw('root'),maxTurns:9});
 for(let n=1;n<=9;n++){
  const run=await f.turn(search(n===1?null:cursor(n-1)),receipt(cursor(n),n*100));
  const goal=f.goals.raw('root');
  assert.equal(goal.status,'active');assert.equal(goal.completionEvidence,null);
  assert.equal(goal.noProgressTurns,n===1?1:0);
  assert.equal(goal.lastProgressBasis,n===1?'unverified':'host_observed_search_coverage');
  assert.equal(goal.lastToolEvidence[0].searchCoverage.scannedEntries,n*100);
  assert.deepEqual(goal.lastSettlementAssessment,{runId:run.id,generation:goal.generation,repeated:[]});
  await f.goals.dispatch('root');
  if(n<9){assert.equal(f.dispatched.length,n);assert.doesNotMatch(f.dispatched.at(-1).message,/Do not repeat this unchanged/);}
 }
 assert.equal(f.goals.raw('root').status,'budget_exhausted');assert.equal(f.dispatched.length,8);
 assert.match(f.dispatched.at(-1).message,/intermediate progress only, not completion/);
});
test('same initial search replay remains nonprogress and triggers existing stagnation boundary',async()=>{
 const f=fixture();
 for(let n=1;n<=3;n++)await f.turn(search(null),receipt(cursor(1),100));
 assert.equal(f.goals.raw('root').noProgressTurns,3);assert.equal(f.goals.raw('root').status,'blocked');
 assert.equal(f.goals.raw('root').completionEvidence,null);
});
test('cursor rotation without scanned-count advancement does not reset the existing seven-turn limit',async()=>{
 const f=fixture();
 for(let n=1;n<=7;n++)await f.turn(search(n===1?null:cursor(n-1)),receipt(cursor(n),100));
 assert.equal(f.goals.raw('root').noProgressTurns,7);assert.equal(f.goals.raw('root').status,'blocked');
});
test('coverage reset, replay, scope change and final-cursor reuse do not invent intermediate progress',()=>{
 const row=(input,next,count,extra)=>observeGoalToolOutcome(search(input),receipt(next,count,extra));
 let assessment=assessGoalProgress({}, {goalEvidence:[row(null,cursor(1),100)]});
 assert.equal(assessment.searchAdvanced,false);
 const goal={searchProgress:assessment.searchProgress};
 for(const value of [row(null,cursor(2),200),row(cursor(1),cursor(1),200),row(cursor(7),cursor(8),200),row(cursor(1),cursor(2),200,{roots:['D:\\different']})])
  assert.equal(assessGoalProgress(goal,{goalEvidence:[value]}).searchAdvanced,false);
 assessment=assessGoalProgress(goal,{goalEvidence:[row(cursor(1),null,200)]});
 assert.equal(assessment.searchAdvanced,true);assert.equal(assessment.progressKind,'host_observed_search_coverage');
 assert.equal(assessment.searchProgress[0].nextCursor,null);
 assert.equal(assessGoalProgress({searchProgress:assessment.searchProgress},{goalEvidence:[row(cursor(1),null,200)]}).searchAdvanced,false);
});
test('dispatch uses the persisted prior-vs-current settlement verdict, not current evidence compared to itself',async()=>{
 const f=fixture(),call={name:'fixture_effect',arguments:{action:'write',target:'fixture'}},result={success:true,contentItems:[]};
 const first=await f.turn(call,result);await f.goals.dispatch('root');
 assert.deepEqual(f.goals.raw('root').lastSettlementAssessment.repeated,[]);
 assert.doesNotMatch(f.dispatched.at(-1).message,/Do not repeat this unchanged/);
 const second=await f.turn(call,result);assert.notEqual(first.id,second.id);await f.goals.dispatch('root');
 assert.equal(f.goals.raw('root').lastSettlementAssessment.repeated.length,1);
 assert.match(f.dispatched.at(-1).message,/Do not repeat this unchanged unproductive operation/);
 await f.goals.save('root',{...f.goals.raw('root'),generation:2});
 await f.goals.dispatch('root');
 assert.doesNotMatch(f.dispatched.at(-1).message,/Do not repeat this unchanged/,'stale generation verdict must not be applied');
});
test('successful search observations never reconcile or clear an unknown external effect',async()=>{
 const f=fixture(),effect={name:'fixture_effect',arguments:{action:'submit',target:'fixture'}};
 await f.turn(effect,{success:false,code:'TIMEOUT',contentItems:[]});
 await f.turn(search(null),receipt(cursor(1),100));
 await f.turn(search(cursor(1)),receipt(cursor(2),200));
 assert.equal(f.conversations.states.root.goalUnresolvedEffects.length,1);
 const run=[...f.engine.runs.values()].at(-1);run.status='running';run.settled=false;
 let executed=false;const result=await f.goals.wrapTools(run,'agent',async()=>{executed=true;return {success:true};})(effect);
 assert.equal(result.code,'GOAL_EFFECT_UNRESOLVED');assert.equal(executed,false);
});


test('only explicit successful well-formed host search receipts can establish a coverage baseline',()=>{
 const valid=receipt(cursor(1),100);
 for(const result of [{...valid,success:undefined},{...valid,success:false},receipt('not-a-cursor',100),receipt(cursor(1),-1),receipt(cursor(1),100,{engine:'other'}),receipt(cursor(1),100,{query:'different'})])
  assert.equal(observeGoalToolOutcome(search(null),result).searchCoverage,undefined);
});


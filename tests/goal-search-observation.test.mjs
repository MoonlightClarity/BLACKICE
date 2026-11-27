import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileSearch } from '../lib/workspace-file-search.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {observeGoalToolOutcome,inFlightEffectSignature,assessGoalProgress,detectUnknownEffectReplay} from '../lib/goal-recovery-policy.mjs';

const session=randomUUID(), cursor=(n,s=session)=>'fs1:'+s+':'+String(n).padStart(8,'0')+'-0000-0000-0000-000000000000';
const search=(input)=>({name:'relay_find_files',arguments:{query:'resume',...(input?{cursor:input}:{})}});
const receipt=(next,count,extra={})=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify({engine:'filesystem',query:'resume',roots:['C:\\fixture'],match:'name',scannedEntries:count,cursor:next,scanComplete:next===null,searchComplete:false,matches:[],...extra})}]});
function fixture() {
 const engine=new EventEmitter();engine.runs=new Map();engine.conversationBusy=()=>false;engine.executionStatus=()=>({availableSlots:1});engine.runtime={};
 const dispatched=[];engine.continueRun=(id,request)=>{dispatched.push(request);return {id:'scheduled-'+dispatched.length};};
 const conversations={entries:new Map([['root',{}]]),states:{root:{}},async changeState(id,patch){this.states[id]={...this.states[id],...structuredClone(patch)};},async family(){return {state:'active',runs:[...engine.runs.values()]};}};
 const goals=new ConversationGoals({engine,conversations,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 conversations.states.root.goal=goals.create({objective:'Find the resume, without claiming that an incomplete search proves absence.'});
 async function turn(call,result,{beforeSettle}={}) {
  const n=engine.runs.size+1,goal=goals.raw('root');
  const run={id:'run-'+n,taskId:'root',goal:{id:goal.id,generation:goal.generation},status:'running',settled:false,
   workflow:{nodes:[{id:'agent',type:'agent',model:'fixture'}]},nodes:{},goalEvidence:[]};
  engine.runs.set(run.id,run);
  await goals.save('root',{...goal,currentRunId:run.id,turns:n,totalTurns:n});
  for(const [operation,outcome] of Array.isArray(call)?call:[[call,result]])
   await goals.wrapTools(run,'agent',async()=>typeof outcome === 'function' ? outcome(operation,run) : outcome)(operation);
  await beforeSettle?.(run);
  run.status='completed';run.settled=true;await goals.settled('root',structuredClone(run));
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
  assert.deepEqual(goal.lastSettlementAssessment,{runId:run.id,generation:goal.generation,repeated:[],searchContinuation:{query:'resume',cursor:cursor(n)}});
  await f.goals.dispatch('root');
  if(n<9){assert.equal(f.dispatched.length,n);assert.doesNotMatch(f.dispatched.at(-1).message,/Do not repeat this unchanged|execute a DIFFERENT feasible action/);}
  if(n===1) assert.ok(f.dispatched[0].message.includes(JSON.stringify({query:'resume',cursor:cursor(1)})));
 }
 assert.equal(f.goals.raw('root').status,'budget_exhausted');assert.equal(f.dispatched.length,8);
 assert.match(f.dispatched.at(-1).message,/intermediate progress only, not completion/);
});
test('same initial search replay remains nonprogress without an implicit turn cap',async()=>{
 const f=fixture();
 for(let n=1;n<=8;n++)await f.turn(search(null),receipt(cursor(1),100));
 assert.equal(f.goals.raw('root').noProgressTurns,8);assert.equal(f.goals.raw('root').status,'active');
 assert.equal(f.goals.raw('root').completionEvidence,null);
});
test('cursor rotation without scanned-count advancement remains unverified after seven turns',async()=>{
 const f=fixture();
 for(let n=1;n<=8;n++)await f.turn(search(n===1?null:cursor(n-1)),receipt(cursor(n),100));
 assert.equal(f.goals.raw('root').noProgressTurns,8);assert.equal(f.goals.raw('root').status,'active');
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


test('real filesystem cursor frontier survives a full turn and clipped display journal',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'goal-cursor-fixture-'));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 for(let n=0;n<22;n++) await fs.writeFile(path.join(folder,'resume-'+n+'.txt'),'fixture');
 const discover=createFileSearch({cwd:folder,scope:randomUUID()}), f=fixture(), sequence=[];
 let next=null;
 for(let n=1;n<=20;n++){
  const call=search(next);
  const page=await discover({...call.arguments,...(next?{}:{path:folder}),limit:1,timeoutMs:10000});
  assert.equal(page.matches.length,1); assert.ok(page.cursor);
  sequence.push([call,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(page)}]}]);
  next=page.cursor;
 }
 const run=await f.turn(sequence);
 assert.equal(run.goalEvidence.length,16);
 assert.equal(f.goals.raw('root').searchProgress[0].nextCursor,next);
 assert.equal(f.goals.raw('root').lastProgressBasis,'unverified','only cross-turn continuation earns progress');
 for(let n=0;n<3;n++){
  const call=search(next), page=await discover({...call.arguments,limit:1});
  await f.turn(call,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(page)}]});
  next=page.cursor;
  if(n<2) assert.equal(f.goals.raw('root').noProgressTurns,0);
 }
 assert.equal(next,null);
 assert.equal(f.goals.raw('root').searchProgress[0].scanComplete,true);
 assert.equal(f.goals.raw('root').completionEvidence,null);
});

test('repeating an initial and continuation page in fresh backend sessions never earns credit',async()=>{
 const f=fixture();
 for(let n=1;n<=8;n++){
  const s=randomUUID();
  await f.turn([[search(null),receipt(cursor(1,s),100)],[search(cursor(1,s)),receipt(cursor(2,s),200)]]);
  const goal=f.goals.raw('root');
  assert.equal(goal.noProgressTurns,n);
  assert.equal(goal.lastProgressBasis,'unverified');
  assert.equal(goal.status,'active');
 }
 assert.equal(f.goals.raw('root').status,'active');
});

test('a material objective change clears coverage and a superseded turn cannot restore it',async()=>{
 const f=fixture();
 await f.turn(search(null),receipt(cursor(1),100));
 const initial=f.goals.raw('root');
 assert.equal(initial.searchProgress[0].nextCursor,cursor(1));
 await f.turn(search(cursor(1)),receipt(cursor(2),200),{beforeSettle:()=>f.goals.control('root',{action:'update',objective:'Work on a different objective.'})});
 const changed=f.goals.raw('root');
 assert.equal(changed.generation,initial.generation+1);
 assert.deepEqual(changed.searchProgress,[]);assert.deepEqual(changed.searchWatermarks,[]);
 assert.equal(changed.lastSettlementAssessment.searchContinuation,undefined);
 assert.notEqual(changed.lastProgressBasis,'host_observed_search_coverage');
 await f.goals.dispatch('root');
 assert.doesNotMatch(f.dispatched.at(-1).message,/filename search returned an incomplete page/);
});
test('real attached workspace tool follows its empty first page and finds a file outside cwd',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'goal-workspace-fixture-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cwd=path.join(root,'workspace'), searchRoot=path.join(root,'outside'), explicitCwd=path.join(root,'other-base');
 await fs.mkdir(cwd);await fs.mkdir(searchRoot);await fs.mkdir(explicitCwd);
 const target=path.join(searchRoot,'fixture-resume.txt');await fs.writeFile(target,'fixture');
 const query='fixture-resume', f=fixture();
 const real=(call,run)=>createWorkspaceToolHandler({cwd,runId:run.id,fileSearchScope:'fixture:root'})(call);
 let first, second;
 await f.turn({name:'relay_find_files',arguments:{query,path:searchRoot,cwd:explicitCwd,timeoutMs:100}},async(call,run)=>{
  const now=Date.now, open=fs.opendir;let offset=0;
  Date.now=()=>now()+offset;
  fs.opendir=async(...args)=>{const dir=await open(...args);if(args[0]===searchRoot)offset=500;return dir;};
  try {const result=await real(call,run);assert.equal(result.success,true);first=JSON.parse(result.contentItems[0].text);return result;}
  finally {Date.now=now;fs.opendir=open;}
 });
 assert.deepEqual(first.matches,[]);assert.equal(first.searchComplete,false);assert.ok(first.cursor);
 assert.equal(f.goals.raw('root').lastProgressBasis,'unverified');
 await f.goals.dispatch('root');
 assert.ok(f.dispatched[0].message.includes(JSON.stringify({query,cursor:first.cursor,cwd:explicitCwd})));
 assert.doesNotMatch(f.dispatched[0].message,/execute a DIFFERENT feasible action/);
 await f.turn({name:'relay_find_files',arguments:{...f.goals.raw('root').lastSettlementAssessment.searchContinuation,timeoutMs:10000}},async(call,run)=>{
  const result=await real(call,run);assert.equal(result.success,true);second=JSON.parse(result.contentItems[0].text);return result;
 });
 assert.equal(second.matches[0].path,target);
 assert.equal(f.goals.raw('root').noProgressTurns,0);
 assert.equal(f.goals.raw('root').lastProgressBasis,'host_observed_search_coverage');
 assert.equal(f.goals.raw('root').completionEvidence,null);
});

test('same-scope resets alternating across turns cannot repeatedly credit old coverage',async()=>{
 const f=fixture(),original=randomUUID();
 await f.turn(search(null),receipt(cursor(1,original),100));
 await f.turn(search(cursor(1,original)),receipt(cursor(2,original),200));
 assert.equal(f.goals.raw('root').noProgressTurns,0);
 for(let n=1;n<=5;n++){
  const replacement=randomUUID();
  await f.turn(search(null),receipt(cursor(1,replacement),100));
  assert.equal(f.goals.raw('root').status,'active');
  await f.turn(search(cursor(1,replacement)),receipt(cursor(2,replacement),200));
  assert.equal(f.goals.raw('root').lastProgressBasis,'unverified');
  if(f.goals.raw('root').status==='blocked')break;
 }
 assert.equal(f.goals.raw('root').status,'active');
});

test('candidate discovery retains its frontier without requiring another search',async()=>{
 const f=fixture(),next=cursor(1);
 await f.turn(search(null),receipt(next,100,{matches:[{path:'C:\\fixture\\resume.pdf'}]}));
 let goal=f.goals.raw('root');
 assert.equal(goal.searchProgress[0].nextCursor,next);
 assert.equal(goal.searchProgress[0].hasCandidates,true);
 assert.equal(goal.lastSettlementAssessment.searchContinuation,undefined);
 await f.goals.dispatch('root');
 assert.doesNotMatch(f.dispatched.at(-1).message,/continue with relay_find_files using these saved arguments/);
});
test('subsequent useful work supersedes the pending empty-page suggestion',async()=>{
 const f=fixture(),next=cursor(1);
 await f.turn([[search(null),receipt(next,100)],[{name:'relay_workspace',arguments:{action:'read',path:'C:\\fixture\\known.pdf'}},{success:true,contentItems:[{type:'inputText',text:'known document'}]}]]);
 const goal=f.goals.raw('root');
 assert.equal(goal.searchProgress[0].nextCursor,next);
 assert.equal(goal.lastSettlementAssessment.searchContinuation,undefined);
});
test('short active Goal handoff gets one bounded action correction without a new scheduled turn',async()=>{
 const f=fixture();
 await f.turn(search(null),receipt(cursor(1),100),{beforeSettle:async run=>{
  run.startedAt=new Date().toISOString();
  const candidate={output:'The next step is to read the available source.'};
  const result=f.goals.beforeCheckpoint(run,candidate);
  assert.equal(result?.continue,true);
  assert.match(result.prompt,/Execute the next useful available action/);
  assert.equal(f.goals.beforeCheckpoint(run,candidate),null);
  assert.equal(f.dispatched.length,0);
 }});
});
test('checkpoint correction cannot override explicit budgets, completed work, or stopped Goals',async()=>{
 for(const variant of ['budget','complete','stopped','long','aborted','incomplete']){
  const f=fixture();
  await f.turn(search(null),receipt(cursor(1),100),{beforeSettle:async run=>{
   run.startedAt=new Date(Date.now()-(variant==='long'?121000:0)).toISOString();
   const candidate={output:'The next step is to read the available source.'};
   if(variant==='budget') await f.goals.save('root',{...f.goals.raw('root'),maxTurns:2});
   if(variant==='complete') run.goalCompletion={summary:'Finished'};
   if(variant==='stopped') await f.goals.save('root',{...f.goals.raw('root'),status:'paused'});
   if(variant==='aborted') candidate.signal=AbortSignal.abort();
   if(variant==='incomplete') candidate.incomplete=true;
   assert.equal(f.goals.beforeCheckpoint(run,candidate),null,variant);
  }});
 }
});
test('native confirmed commit receipts count once as intermediate progress, not Goal completion',async()=>{
 const f=fixture(),proof={adapter:'relay_browser',effect:'commit',effectKey:'fixture-submission',operationId:'native:fixture'};
 const op={name:'fixture_observation',arguments:{action:'read'}},result={success:true,contentItems:[]};
 await f.turn(op,result,{beforeSettle:run=>{f.goals.observeConfirmedCommit(run,proof);f.goals.observeConfirmedCommit(run,proof);}});
 let goal=f.goals.raw('root');
 assert.equal(goal.noProgressTurns,0);
 assert.equal(goal.lastProgressBasis,'host_confirmed_commit');
 assert.equal(goal.milestones.length,1);
 assert.equal(goal.completionEvidence,null);
 await f.turn(op,result,{beforeSettle:run=>f.goals.observeConfirmedCommit(run,proof)});
 goal=f.goals.raw('root');
 assert.equal(goal.noProgressTurns,1);assert.equal(goal.milestones.length,1);
 assert.equal(goal.status,'active');
});

test('an explicit admission of unfinished work triggers one bounded Goal continuation even without a recorded nextAction',async()=>{
 const f=fixture();
 await f.turn(search(null),receipt(cursor(1),100),{beforeSettle:async run=>{
   run.startedAt=new Date().toISOString();
   run.goalProgress=undefined;
   run.goalEvidence=[];
   const candidate={output:'No application was submitted. This turn ended before I could reconcile application history, check the resume or find current openings.'};
   const first=f.goals.beforeCheckpoint(run,candidate);
   assert.equal(first?.continue,true);
   assert.match(first.prompt,/Execute the next useful available action/);
   assert.equal(f.goals.beforeCheckpoint(run,candidate),null,'a second corrective admission would loop');
 }});
});

test('new model-authored narratives do not erase consecutive no-progress turns',async()=>{
 const f=fixture();
 for(let n=0;n<3;n++){
   await f.turn(search(null),receipt(cursor(1),100),{beforeSettle:r=>{
     r.goalEvidence=[];
     r.goalProgress={summary:'Different lead '+n,evidence:'New reasoning narrative '+n,nextAction:'Find a viable application'};
   }});
   const goal=f.goals.raw('root');
   assert.equal(goal.lastProgressBasis,'provisional_reasoning');
   assert.equal(goal.noProgressTurns,n+1);
   assert.equal(goal.noVerifiedMilestoneTurns,n+1);
 }
 await f.goals.dispatch('root');
 assert.match(f.dispatched.at(-1).message,/Host-observed outcome milestone has not advanced for 3 turns/);
 assert.match(f.dispatched.at(-1).message,/New agent-authored reasoning is not a verified milestone/);
});
test('an explicit no-submission ending earns one same-turn correction',async()=>{
 const f=fixture();
 await f.turn(search(null),receipt(cursor(1),100),{beforeSettle:async run=>{
   run.startedAt=new Date().toISOString();
   const result=f.goals.beforeCheckpoint(run,{output:'A current job was checked, but no new application was submitted this turn.'});
   assert.equal(result?.continue,true);
   assert.equal(f.goals.beforeCheckpoint(run,{output:'No new application submitted.'}),null);
 }});
});

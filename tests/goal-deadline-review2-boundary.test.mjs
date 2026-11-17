import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {BrowserWorkspace,createBrowserToolHandler} from '../lib/browser.mjs';
import {createSubagentToolHandler,SUBAGENT_TOOL} from '../lib/subagents.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {computerDeadlineInput} from '../public/next/chat/goals.mjs';

const cutoff='2026-11-15T11:00:00.000Z', ms=v=>Date.parse(v), tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
const pauseEvidence=[{id:'may-have-sent',kind:'uncertain_external_effect',signature:'b'.repeat(64),resolution:null}];
function stub(){
 const clock={now:ms('2026-11-15T10:59:50Z'),monotonic:0};
 const goal={id:'g',objective:'Synthetic work until 6 AM EST',status:'active',revision:1,generation:1,
   deadlineAt:cutoff,deadlineTimeZone:'EST',deadlineSource:'objective',deadlineExpiredAt:null,
   currentRunId:'run',lastSettledRunId:null,maxTurns:null,maxMinutes:null,turns:1,totalTurns:1};
 const state={root:{goal,goalUnresolvedEffects:structuredClone(pauseEvidence),goalControlReceipts:[]}};
 const run={id:'run',taskId:'root',goal:{id:'g',generation:1},status:'running',settled:false};
 const engine=new EventEmitter();engine.runs=new Map([['run',run]]);engine.closed=false;
 const controllers=new AbortController(),cancelled=[];
 engine.cancelRun=id=>{cancelled.push(id);controllers.abort();run.status='cancelled';run.finishedAt=new Date(clock.now).toISOString();};
 const conversations={states:state,entries:new Map([['root',{}]]),changeState:async(id,patch)=>Object.assign(state[id],patch),
   family:async()=>({rootId:'root',state:'active',runs:[run]})};
 const goals=new ConversationGoals({engine,conversations,now:()=>clock.now,monotonicNow:()=>clock.monotonic,autoStart:false});
 goals.listener=()=>{};
 return {clock,goals,controllers,cancelled,state,run,engine};
}
test('contained browser serial queue reruns deadline check at actual action dispatch',async t=>{
 const s=stub(),gate=deferred(),driverCalls=[];
 const driver={status:()=>({available:true,contained:true,tabs:[{tabId:'owned-tab'}],activeTab:'owned-tab'}),
   perform:async args=>{driverCalls.push(args);return {tabId:args.tabId,receipt:{observed:true}};}};
 const browser=new BrowserWorkspace({driver});
 t.after(async()=>{gate.resolve();await browser.close();await s.goals.close();});
 const holdEntered=deferred();
 const first=browser.perform({action:'snapshot',browser:'relay',tabId:'owned-tab'},{
   source:'user',beforeDispatch:async()=>{holdEntered.resolve();await gate.promise;}
 });
 await holdEntered.promise;
 const action=createBrowserToolHandler({browser,beforeDispatch:({signal})=>s.goals.assertProviderAdmission(s.run,{signal})});
 const request=action({name:'relay_browser',arguments:{action:'fill',browser:'relay',tabId:'owned-tab',ref:'name-field',text:'synthetic value'}});
 s.clock.now=ms(cutoff);s.clock.monotonic+=10000;
 gate.resolve();await first;
 const denied=await request;
 assert.equal(denied.success,false);
 assert.equal(denied.code,'GOAL_DEADLINE_EXPIRED');
 assert.equal(JSON.parse(denied.contentItems[0].text).actionDispatched,false);
 assert.equal(driverCalls.length,1,'queued fill never reaches actual driver');
 await s.goals.close();
 assert.deepEqual(s.state.root.goalUnresolvedEffects,pauseEvidence);
});
test('child provider final admission rejects a deadline that changed during child preparation',async()=>{
 const s=stub();let calls=0;
 const handler=createSubagentToolHandler({cwd:'C:/fixture',model:'fixture',maxParallel:1,
  allowAutonomousDelegation:true,runtime:{runAgent:async()=>{calls++;return{output:'should not run'};}},
  beforeModel:({signal})=>{s.clock.now=ms(cutoff);s.goals.assertProviderAdmission(s.run,{signal});}
 });
 const result=JSON.parse((await handler({name:SUBAGENT_TOOL.name,arguments:{tasks:[{id:'a',prompt:'Inspect synthetic data.'}]}})).contentItems[0].text);
 assert.equal(result.completed,0);
 assert.equal(calls,0);
 assert.notEqual(result.results[0].status,'completed');
 await s.goals.close();
 assert.deepEqual(s.state.root.goalUnresolvedEffects,pauseEvidence);
});
test('final Goal wall-clock admission after awaited Swarm dispatch hook blocks provider without timer delivery',async()=>{
  const s=stub();let calls=0,admissionChecks=0,durableFences=0;
  try {
    const handler=createSubagentToolHandler({cwd:'C:/fixture',model:'fixture',maxParallel:1,
      allowAutonomousDelegation:true,
      runtime:{runAgent:async()=>{calls++;return{output:'provider was incorrectly invoked'};}},
      beforeModel:({signal})=>{
        admissionChecks++;s.goals.assertProviderAdmission(s.run,{signal});
      },
      onProviderDispatch:async()=>{
        durableFences++;
        // The first Goal admission has already passed. An asynchronous
        // durable Swarm dispatch save crosses the wall-clock deadline while
        // cancellation timer delivery is deliberately not invoked.
        await Promise.resolve();s.clock.now=ms(cutoff);
      }
    });
    const response=await handler({name:SUBAGENT_TOOL.name,
      arguments:{tasks:[{id:'deadline_fenced_worker',prompt:'No provider may start after cutoff.'}]}});
    const result=JSON.parse(response.contentItems[0].text);
    assert.equal(admissionChecks,2,'same real host Goal admission must run before and after awaited durable hook');
    assert.equal(durableFences,1,'the durable attempt hook was invoked once');
    assert.equal(calls,0,'runtime.runAgent must not run after the absolute cutoff');
    assert.equal(result.completed,0);
    assert.equal(result.results[0].status,'failed');
    assert.match(result.results[0].error,/absolute Goal deadline passed before provider admission/);
    assert.equal(result.results[0].hostRunAgentCallAttempted,false,
      'a durable attempt/fence is not evidence of a provider call');
    assert.deepEqual(s.state.root.goalUnresolvedEffects,pauseEvidence);
  } finally { await s.goals.close(); }
});
test('deadline abort propagates to existing child, leaves a queued sibling unstarted, and preserves unknown effects',async()=>{
 const s=stub();let started=0,entered=deferred();
 const handler=createSubagentToolHandler({cwd:'C:/fixture',model:'fixture',maxParallel:1,allowAutonomousDelegation:true,signal:s.controllers.signal,
   runtime:{runAgent:async options=>{started++;entered.resolve();await new Promise((resolve,reject)=>{
     if(options.signal.aborted)return reject(Object.assign(Error('Aborted'),{name:'AbortError'}));
     options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Aborted'),{name:'AbortError'})),{once:true});
   });return{output:'unreachable'};}},
   beforeModel:({signal})=>s.goals.assertProviderAdmission(s.run,{signal})
 });
 const pending=handler({name:SUBAGENT_TOOL.name,arguments:{tasks:[{id:'one',prompt:'Synthetic work one'},{id:'two',prompt:'Synthetic work two'}]}});
 await entered.promise;
 s.clock.now=ms(cutoff);await s.goals.expireIfDue('root');
 const result=JSON.parse((await pending).contentItems[0].text);
 assert.equal(started,1);
 assert.deepEqual(result.results.map(v=>v.status),['cancelled','not-started']);
 assert.deepEqual(s.cancelled,['run']);
 assert.deepEqual(s.state.root.goalUnresolvedEffects,pauseEvidence);
 await s.goals.close();
});
test('frontend refuses nonexistent and repeated DST wall times without inventing an offset',()=>{
 const old=process.env.TZ;
 try{
   process.env.TZ='America/New_York';
   assert.throws(()=>computerDeadlineInput('2026-03-08T02:30:00'),/does not exist/i);
   assert.throws(()=>computerDeadlineInput('2026-11-01T01:30:00'),/ambiguous/i);
   const valid=computerDeadlineInput('2026-11-15T06:00:00');
   assert.equal(valid.deadlineAt,cutoff);
   assert.equal(valid.deadlineTimeZone,'America/New_York');
 }finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});
const graph=()=>({id:'deadline-directory',name:'Deadline Directory',nodes:[
 {id:'input',type:'input'}, {id:'agent',type:'agent',model:'fixture::remote',name:'Chat',prompt:'Do a synthetic task.',sandbox:'read-only'},
 {id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
 settings:{maxParallel:1,planningMode:'off'}});
test('Directory cannot admit a later model phase after the parent cutoff and retains UNKNOWN history',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-deadline-directory-')),cwd=path.join(root,'workspace'),dataDir=path.join(root,'data');await mkdir(cwd);
 const clock={now:ms('2026-11-15T10:59:45Z'),monotonic:0};
 const runtime=new EventEmitter();runtime.calls=[];
 runtime.status=()=>({connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]});
 let conversations;
 runtime.runAgent=async options=>{
   runtime.calls.push(options);
   if(runtime.calls.length!==1)throw Error('A second Directory provider turn passed the deadline gate.');
   // A synthetic uncertain effect is retained as historical evidence, not replayed.
   const parent=[...engine.runs.values()][0];
   await conversations.changeState(parent.id,{goalUnresolvedEffects:structuredClone(pauseEvidence)});
   clock.now=ms(cutoff);clock.monotonic+=15000;
   return {output:JSON.stringify({atomic:true}),threadId:'directory-fixture'};
 };
 const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd}).init();
 conversations=await new ConversationArchive({dataDir,engine}).init();
 const goals=await new ConversationGoals({engine,conversations,now:()=>clock.now,monotonicNow:()=>clock.monotonic,
   continuationDelayMs:10,deadlinePollMs:50}).init();
 t.after(async()=>{await goals.close();await engine.close();await conversations.close();await rm(root,{recursive:true,force:true});});
 const run=engine.startRun({workflow:graph(),input:{task:'Work until 6 AM EST.',directoryMode:'on',subagentsMode:'off',goal:{objective:'Work until 6 AM EST.'}}});
 const admitted=engine.executions.get(run.id);assert.ok(admitted);
 await admitted;
 assert.equal(runtime.calls.length,1,'only the first fake phase entered a provider');
 const saved=await goals.get(run.id);
 assert.equal(saved.status,'paused');
 assert.equal(saved.deadlineExpiredAt,cutoff);
 assert.deepEqual(conversations.states[run.id].goalUnresolvedEffects,pauseEvidence);
 assert.notEqual(engine.getRun(run.id).status,'completed');
});

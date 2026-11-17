import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserWorkspace,createBrowserToolHandler} from '../lib/browser.mjs';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {observeGoalToolOutcome,detectUnknownEffectReplay} from '../lib/goal-recovery-policy.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
const call=(name,args)=>({name,arguments:args});
const parsed=r=>JSON.parse(r.contentItems[0].text);

test('invalid navigation destination is known absent while stale old-document metadata does not block the corrected destination',async t=>{
 let dispatches=0,url='https://fixture.test/start';
 const browser=new BrowserWorkspace({driver:{status:()=>({available:true,contained:true,tabs:[{tabId:'t',url}],activeTab:'t'}),perform:async args=>{dispatches++;url=args.url;return {tabId:'t',url};}}});
 t.after(()=>browser.close());const handler=createBrowserToolHandler({browser});
 const invalid=call('relay_browser',{action:'navigate',browser:'relay',tabId:'t',url:'',expectedUrl:url,expectedDocumentId:'t:1'});
 const rejected=await handler(invalid);assert.equal(rejected.success,false);assert.equal(dispatches,0);
 const observed=observeGoalToolOutcome(invalid,rejected);assert.equal(observed.kind,'recoverable_no_dispatch');assert.equal(observed.actionDispatched,false);assert.equal(detectUnknownEffectReplay([observed],invalid),null);
 const repaired=call('relay_browser',{action:'navigate',browser:'relay',tabId:'t',url:'https://fixture.test/finish',expectedUrl:'https://fixture.test/abandoned',expectedDocumentId:'t:1'});
 assert.equal((await handler(repaired)).success,true);assert.equal(url,'https://fixture.test/finish');assert.equal(dispatches,1);
});

function recoveryFixture() {
 const c=call('relay_browser',{action:'click',tabId:'t',ref:'submit'});
 const row={...observeGoalToolOutcome(c,{success:false,code:'TIMEOUT'}),id:'receipt',at:'2026-11-15T00:00:00Z',resolutions:[],resolution:{outcome:'unknown',deliberateRetry:true,runId:'run',retryReason:'Reversible fixture'}};
 const run={id:'run',taskId:'root',goal:{id:'g',generation:1},status:'running',settled:false};
 const conversations={states:{root:{goal:{id:'g',generation:1,status:'active'},goalUnresolvedEffects:[row]}},changeState:async(id,patch)=>Object.assign(conversations.states[id],structuredClone(patch))};
 const goals=new ConversationGoals({engine:{runs:new Map([['run',run]])},conversations,autoStart:false});goals.resolve=async()=> 'root';
 return {c,row,run,conversations,goals};
}

test('new reconciliation wins over an optimistic retry during delayed persistence',async()=>{
 const {c,row,run,conversations,goals}=recoveryFixture();let release,entered;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const save=conversations.changeState;
 conversations.changeState=async(id,patch)=>{entered();await gate;return save(id,patch);};
 const reconcile=goals.resolveEffect('root',{goalId:'g',receiptId:row.id,signature:row.signature,observedAt:row.at,expectedResolutionCount:0,outcome:'occurred',evidence:'Destination receipt confirms completion.'},run);
 await started;let dispatches=0;const pending=goals.wrapTools(run,'agent',async()=>{dispatches++;return {success:true};})(c);
 release();await reconcile;assert.equal((await pending).code,'GOAL_EFFECT_UNRESOLVED');assert.equal(dispatches,0);
});

for(const change of ['cancel','pause','storage-failure'])test(`deliberate retry cannot dispatch after ${change} during permit persistence`,async()=>{
 const {c,run,conversations,goals}=recoveryFixture();const save=conversations.changeState;
 conversations.changeState=async(id,patch)=>{
  if(change==='storage-failure')throw Error('disk unavailable');
  await save(id,patch);if(change==='cancel')run.status='cancelled';else conversations.states.root.goal={id:'g',generation:2,status:'paused'};
 };
 let dispatches=0;const result=await goals.wrapTools(run,'agent',async()=>{dispatches++;return {success:true};})(c);
 assert.equal(result.success,false);assert.equal(result.actionDispatched,false);assert.equal(dispatches,0);
 assert.equal(conversations.states.root.goalUnresolvedEffects[0].resolution.outcome,'unknown');
});

test('cancelled or replaced runs cannot reconcile and permits do not survive into a new run',async()=>{
 const {c,row,run,conversations,goals}=recoveryFixture();run.status='cancelled';
 const result=await goals.handle(run,'agent',call('relay_goal',{action:'reconcile',goalId:'g',receiptId:row.id,signature:row.signature,observedAt:row.at,expectedResolutionCount:0,outcome:'not_occurred',evidence:'Checked destination.'}));
 assert.equal(result.code,'GOAL_CHANGED');
 const restored=new ConversationGoals({engine:{runs:new Map()},conversations:{states:structuredClone(conversations.states)},autoStart:false});
 let dispatches=0;assert.equal((await restored.wrapTools({...run,id:'after-restart',status:'running'},'agent',async()=>{dispatches++;})(c)).code,'GOAL_EFFECT_UNRESOLVED');assert.equal(dispatches,0);
});

test('concurrent identical admissions consume at most one deliberate attempt',async()=>{
 const {c,run,goals}=recoveryFixture();let release;const gate=new Promise(r=>release=r);let dispatches=0;
 const handler=goals.wrapTools(run,'agent',async()=>{dispatches++;await gate;return {success:true};});
 const first=handler(c),second=handler(c);assert.equal((await second).code,'GOAL_EFFECT_IN_FLIGHT');release();assert.equal((await first).success,true);assert.equal(dispatches,1);
});

test('real archive persists consumption before dispatch and restart cannot renew an unknown receipt',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'recovery-durable-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {c,row,run,goals}=recoveryFixture();
 const archive=new ConversationArchive({dataDir:dir,engine:goals.engine});
 await archive.changeState('root',{goal:{id:'g',generation:1,status:'active'},goalUnresolvedEffects:[row]});goals.conversations=archive;
 let dispatches=0;
 assert.equal((await goals.wrapTools(run,'agent',async()=>{
  const disk=JSON.parse(await readFile(archive.stateFile,'utf8')).root.goalUnresolvedEffects[0];
  assert.ok(disk.resolution.retryUsedAt);assert.equal(disk.retryAttempts.length,1);assert.equal(disk.resolution.outcome,'unknown');dispatches++;return {success:true};
 })(c)).success,true);
 const restored=new ConversationArchive({dataDir:dir,engine:goals.engine});await restored.loadStates();
 const nextRun={...run,id:'new-run'},next=new ConversationGoals({engine:{runs:new Map([['new-run',nextRun]])},conversations:restored,autoStart:false});next.resolve=async()=> 'root';
 assert.equal((await next.wrapTools(nextRun,'agent',async()=>{dispatches++;})(c)).code,'GOAL_EFFECT_UNRESOLVED');
 await assert.rejects(next.resolveEffect('root',{goalId:'g',receiptId:row.id,signature:row.signature,observedAt:row.at,expectedResolutionCount:0,outcome:'unknown',evidence:'The outcome remains unverified.',retryReason:'Try again.'},nextRun),{code:'GOAL_EFFECT_RETRY_USED'});
 assert.equal(dispatches,1);assert.equal(restored.states.root.goalUnresolvedEffects[0].kind,'uncertain_external_effect');
 // New destination evidence may still resolve it; an unknown annotation cannot erase its retry history.
 await next.resolveEffect('root',{goalId:'g',receiptId:row.id,signature:row.signature,observedAt:row.at,expectedResolutionCount:0,outcome:'unknown',evidence:'Still no conclusive destination receipt.'},nextRun);
 await assert.rejects(next.resolveEffect('root',{goalId:'g',receiptId:row.id,signature:row.signature,observedAt:row.at,expectedResolutionCount:1,outcome:'unknown',evidence:'Still unknown.',retryReason:'Renew again.'},nextRun),{code:'GOAL_EFFECT_RETRY_USED'});
});
test('the same error code after driver dispatch remains unknown',async t=>{
 let dispatches=0;const browser=new BrowserWorkspace({driver:{status:()=>({available:true,contained:true,tabs:[{tabId:'t'}]}),perform:async()=>{dispatches++;throw Object.assign(Error('late validation from adapter'),{code:'BROWSER_VALIDATION'});}}});
 t.after(()=>browser.close());const handler=createBrowserToolHandler({browser}),c=call('relay_browser',{action:'click',browser:'relay',tabId:'t',ref:'submit'});
 const row=observeGoalToolOutcome(c,await handler(c));assert.equal(dispatches,1);assert.equal(row.kind,'uncertain_external_effect');assert.equal(row.actionDispatched,null);assert.equal(detectUnknownEffectReplay([row],c).code,'GOAL_EFFECT_UNRESOLVED');
});
test('workspace validation recovers into a real write and independent readback',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'dispatch-recovery-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const handler=createWorkspaceToolHandler({cwd});
 for(const args of [{action:'write',path:'result.txt',text:null},{action:'run',command:''},{action:'run',command:'echo test',timeoutMs:0},{action:'patch',path:'result.txt',oldText:'a',newText:'b'},{action:'write',cwd:'missing',path:'result.txt',text:'ok'}]){
 const c=call('relay_workspace',args),r=await handler(c);assert.equal(r.success,false);assert.equal(observeGoalToolOutcome(c,r).kind,'recoverable_no_dispatch');}
 assert.equal((await handler(call('relay_workspace',{action:'write',path:'result.txt',text:'verified recovery'}))).success,true);
 assert.equal(await readFile(path.join(cwd,'result.txt'),'utf8'),'verified recovery');
 for(const [name,action] of [['relay_workspace','patch_history'],['relay_control','runtime_get'],['relay_control','job_get']])assert.notEqual(observeGoalToolOutcome(call(name,{action}),{success:false}).kind,'uncertain_external_effect');
});
test('agent reconciles its exact receipt during its own turn without replay or a user review',async()=>{
 const c=call('relay_browser',{action:'click',tabId:'t',ref:'submit'}),observed=observeGoalToolOutcome(c,{success:false,code:'TIMEOUT'});
 const row={...observed,id:'r1',at:'2026-11-15T00:00:00Z'};
 const goal={id:'g',generation:1,status:'active'},run={id:'run',taskId:'root',goal:{id:'g',generation:1},status:'running',settled:false};
 const conversations={states:{root:{goal,goalUnresolvedEffects:[row]}},changeState:async(id,patch)=>Object.assign(conversations.states[id],structuredClone(patch))};
 const goals=new ConversationGoals({engine:{runs:new Map([['run',run]])},conversations,autoStart:false});goals.resolve=async()=> 'root';
 const args={action:'reconcile',goalId:'g',receiptId:'r1',signature:row.signature,observedAt:row.at,expectedResolutionCount:0,outcome:'unknown',evidence:'Destination checked; its receipt is unavailable. Absence is not established.'};
 const unknown=await goals.handle(run,'agent',call('relay_goal',args));assert.equal(unknown.success,true);assert.equal(parsed(unknown).replayed,false);
 let dispatches=0;const handler=goals.wrapTools(run,'agent',async()=>{dispatches++;return {success:true,contentItems:[]};});
 assert.equal((await handler(c)).code,'GOAL_EFFECT_UNRESOLVED');assert.equal(dispatches,0);
 const justified=await goals.handle(run,'agent',call('relay_goal',{...args,expectedResolutionCount:1,retryReason:'This disposable fixture operation is reversible; another attempt costs less than deferral and is within the requested test.'}));
 assert.equal(justified.success,true);assert.equal(conversations.states.root.goalUnresolvedEffects[0].resolution.outcome,'unknown');
 assert.equal((await handler(c)).success,true);assert.equal(dispatches,1);
 assert.equal((await handler(c)).code,'GOAL_EFFECT_UNRESOLVED');assert.equal(dispatches,1);
 goals.engine.runs.set('other',{id:'other',taskId:'root',status:'running'});
 assert.equal((await goals.handle(run,'agent',call('relay_goal',{...args,expectedResolutionCount:2,outcome:'not_occurred'}))).code,'GOAL_EFFECT_ACTIVE');
});

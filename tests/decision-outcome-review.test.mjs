import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';
import {DECISION_REVIEW_TOOL,createDecisionReview} from '../lib/decision-outcome-review.mjs';

const reviewArgs={action:'assess',trigger:'before-dependent-action',actionId:'commit',proposal:'Commit only if the exact destination outcome is confirmed.'};
const body=r=>JSON.parse(r.contentItems[0].text);
const outcome=(evidenceRefs,extra={})=>({decision:'respond',summary:'The exact prerequisite supports this decision.',remaining:[],nextAction:'',evidenceRefs,blockers:[],...extra});
test('independent decision review deduplicates same evidence and refuses stale advice without task effects',async()=>{
 let state='first',rev=1,calls=0,release;
 const snapshot=()=>({input:'Complete the user task.',evidenceFingerprint:state,pendingEffects:[],evidence:{records:[]},directoryOutline:{actionRevision:rev,actions:[{id:'commit',state:'pending'}]}});
 const assess=async()=>{calls++;await new Promise(resolve=>release=resolve);return outcome(['user-request']);};
 const review=createDecisionReview({snapshot,assess,admit:signal=>signal?.throwIfAborted()});
 const a=review(reviewArgs),b=review(reviewArgs);
 assert.equal(calls,1);
 release();
 assert.equal(body(await a).status,'supported');assert.equal(body(await b).status,'supported');
 assert.equal(body(await review(reviewArgs)).authority,'none');assert.equal(calls,1);
 const invalid=await review({...reviewArgs,actionId:'missing'});
 assert.equal(invalid.code,'OUTCOME_BOUNDARY_ACTION');assert.equal(calls,1);
 state='new-evidence';
 const c=review(reviewArgs);assert.equal(calls,2);
 rev++;
 release();
 const stale=await c;assert.equal(stale.code,'OUTCOME_BOUNDARY_STALE');assert.equal(stale.actionDispatched,false);
 assert.equal(body(stale).verified,false);
 const signal=AbortSignal.abort(new Error('owner stopped'));
 await assert.rejects(review(reviewArgs,{signal}),/owner stopped/);
});

test('a decision-only review has a scoped reusable review receipt before the effect, not effect evidence',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'decision-review-engine-'));
 let engine,workerCalls=0,reviewCalls=0,finalReviews=0;
 const boundary='\nREVIEW DATA (JSON):\n';
 const seen=o=>JSON.parse(o.prompt.split(boundary).at(-1));
 const target=path.join(cwd,'commit.txt'),src=path.join(cwd,'source.txt');
 const task='Read source.txt and save commit.txt only when the approved exact version is confirmed. Verify the saved marker.';
 class Runtime extends EventEmitter {
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true,contextWindowTokens:128000,maxOutputTokens:4096}]};}
  async runAgent(o){
   if(o.prompt.includes('BLACKICE MATERIAL DECISION REVIEW')){
    reviewCalls++;
    assert.equal(o.sandbox,'read-only');assert.equal(o.hostOnlyTools,true);
    assert.equal(o.dynamicTools?.length||0,0);
    const {snapshot}=seen(o);
    assert.equal(snapshot.request,task);
    assert.equal(snapshot.scope.decisionBoundary.actionId,'commit');
    assert.equal(snapshot.scope.decisionBoundary.trigger,'before-dependent-action');
    assert.equal(snapshot.scope.directoryOutline.actions.find(a=>a.id==='commit').state,'pending');
    assert.equal(snapshot.scope.directoryOutline.actions.find(a=>a.id==='inspect').state,'observed');
    const receipt=snapshot.evidence.records.find(r=>r.tool==='relay_workspace'&&r.action==='read');
    assert.ok(receipt);assert.match(JSON.stringify(receipt.result),/APPROVED v2/);
    assert.equal(snapshot.evidence.records.some(r=>r.tool===DECISION_REVIEW_TOOL.name),false);
    await assert.rejects(readFile(target,'utf8'),{code:'ENOENT'});
    return{output:JSON.stringify(outcome([receipt.citationRef],{verificationMethod:{methods:['chronological-waterfall'],reason:'The exact approved version must precede commit.',triggers:['before-dependent-action']}}))};
   }
   if(o.prompt.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW')){
    finalReviews++;
    const {snapshot}=seen(o);
    assert.equal(snapshot.scope.decisionBoundary,undefined);
    assert.ok(snapshot.scope.directoryOutline.actions.every(a=>a.state==='observed'));
    const assessed=snapshot.evidence.records.filter(r=>r.source==='host-decision-assessment');
    assert.equal(assessed.length,1);assert.equal(assessed[0].result.verified,false);
    assert.ok(snapshot.scope.directoryOutline.receiptLinks.some(l=>l.reviewOnly&&l.evidenceId===assessed[0].id&&l.citationRef===assessed[0].citationRef));
    const result=snapshot.evidence.records.findLast(r=>r.tool==='relay_workspace'&&r.action==='read');
    assert.ok(result);
    return{output:JSON.stringify(outcome([result.citationRef]))};
   }
   assert.ok(o.dynamicTools.some(x=>x.name===DECISION_REVIEW_TOOL.name));
   const call=async(name,args)=>{
    const c={name,arguments:args,callId:'call-'+(++workerCalls)};
    const r=await o.onToolCall(c);await o.onToolResultDelivered?.({call:c,result:r});assert.equal(r.success,true,JSON.stringify(r));return r;
   };
   const dir=args=>call('relay_directory_action',args);
   const id=r=>r.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
   await dir({action:'plan',actions:[{id:'inspect',objective:'Inspect current approved version',dependsOn:[]},{id:'assessment',objective:'Obtain independent assessment before commit',dependsOn:['inspect']},{id:'commit',objective:'Commit only the exact approved version and verify it',dependsOn:['assessment']}]});
   await dir({action:'focus',id:'inspect'});
   const r=await call('relay_workspace',{action:'read',path:src});
   await dir({action:'observe',id:'inspect',outcome:'objective-met',claim:'Read approved v2.',receipts:[id(r)]});
   await dir({action:'focus',id:'assessment'});
   const first=await call(DECISION_REVIEW_TOOL.name,reviewArgs);
   const second=await call(DECISION_REVIEW_TOOL.name,reviewArgs);
   assert.equal(body(first).status,'supported');assert.equal(body(second).status,'supported');assert.equal(body(first).verified,false);assert.equal(reviewCalls,1);
   assert.equal(body(first).receiptId,body(second).receiptId);assert.equal(body(first).reviewOnly,true);
   await dir({action:'observe',id:'assessment',outcome:'objective-met',claim:'Independent assessment supports the current proposed commit.',receipts:[body(first).receiptId]});
   await dir({action:'focus',id:'commit'});
   const w=await call('relay_workspace',{action:'write',path:target,text:'v2\n'});
   const q=await call('relay_workspace',{action:'read',path:target});
   await dir({action:'observe',id:'commit',outcome:'objective-met',claim:'Saved and read exact approved v2.',receipts:[id(w),id(q)]});
   const final={output:'Committed approved v2 and verified saved contents.',signal:o.signal};
   assert.equal((await o.onBeforeFinal(final))?.continue,true);
   assert.equal(await o.onBeforeFinal(final),null);
   return{output:final.output};
  }
 }
 const {writeFile}=await import('node:fs/promises');await writeFile(src,'APPROVED v2\n');
 t.after(async()=>{await engine?.close();await rm(cwd,{recursive:true,force:true});});
 const workflow={id:'mission_chat_boundary_review_fixture',description:'A focused task started from Mission.',name:'Boundary review fixture',
 nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture',prompt:'Perform the current task.'},{id:'o',type:'output'}],
 edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{planningMode:'off',maxParallel:1}};
 engine=await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(cwd,'data'),defaultCwd:cwd}).init();
 const started=engine.startRun({workflow,input:{task,cwd,chatPlanning:'off',directoryActions:'on',directoryDiagnostics:'maximal'}});
 await engine.executions.get(started.id);
 const run=engine.getRun(started.id);assert.equal(run.status,'completed',String(run.error));
 assert.equal(reviewCalls,1);assert.equal(finalReviews,1);
 assert.equal(await readFile(target,'utf8'),'v2\n');
 const d=(await engine.actionDirectories.get(started.id,task)).read();
 const reviewReceipts=d.receipts.filter(r=>r.tool===DECISION_REVIEW_TOOL.name);
 assert.equal(reviewReceipts.length,1);assert.equal(reviewReceipts[0].observationOnly,true);assert.equal(reviewReceipts[0].reviewOnly.status,'supported');assert.equal(reviewReceipts[0].linkedByActionId,'assessment');
 assert.ok(d.actions.every(a=>a.state==='observed'));
 assert.equal(engine.runs.get(started.id).nodes.a.outcomeAssessment.status,'validated');
});

test('a persisted review-only receipt is scoped to the assessed action or its prerequisite and cannot be fabricated by a model call',async()=>{
 const d=new TaskActionDirectory({taskId:'task',objective:'Review a dependent commit and preserve independent work.'});
 const call=args=>d.handleModelTool(args,{runId:'run',nodeId:'a',expectedActionRevision:d.read().actionRevision});
 await call({action:'plan',actions:[{id:'assessment',objective:'Obtain the assessment',dependsOn:[]},{id:'commit',objective:'Commit after assessment',dependsOn:['assessment']},{id:'other',objective:'Unrelated action',dependsOn:[]}]});
 const assessment={assessmentId:'a'.repeat(64),assessedAt:'2026-11-23T21:00:00.000Z',actionRevision:d.read().actionRevision,
   status:'supported',boundary:{trigger:'before-dependent-action',actionId:'commit'}};
 const r=await d.recordDecisionAssessment({runId:'run',nodeId:'a',assessment});
 assert.equal(await d.recordDecisionAssessment({runId:'run',nodeId:'a',assessment}),r);
 assert.equal(d.read().receipts.length,1);
 await assert.rejects(call({action:'recordDecisionAssessment',assessment}),{code:'DIRECTORY_TOOL_ACTION'});
 await call({action:'focus',id:'other'});
 await assert.rejects(call({action:'observe',id:'other',outcome:'objective-met',claim:'Unrelated action done',receipts:[r]}),{code:'DIRECTORY_EVIDENCE'});
 const restored=new TaskActionDirectory({taskId:'task',objective:'Review a dependent commit and preserve independent work.',snapshot:d.read()});
 assert.equal(restored.read().receipts[0].reviewOnly.assessmentId,assessment.assessmentId);
 assert.equal(restored.read().receipts[0].actionId,null);
 await assert.rejects(d.recordDecisionAssessment({runId:'run',nodeId:'a',assessment}),{code:'DIRECTORY_CHANGED'});
});

test('current outline replaces repetitive control snapshots without losing operational or review-only evidence',async()=>{
 const {createChatExecutionReview}=await import('../lib/chat-execution-review.mjs');
 let seen;
 const review=createChatExecutionReview({input:'Complete the recorded task.',directoryCoordinationInOutline:true,assessOutcome:async request=>{seen=request;return{decision:'respond'};}});
 for(let i=0;i<7;i++){
  const call={callId:'directory-'+i,name:'relay_directory_action',arguments:{action:i===6?'focus':'read'}};
  review.started(call);
  review.delivered({call,result:{success:i!==6,code:i===6?'DIRECTORY_NOT_READY':null,contentItems:[{type:'inputText',text:'x'.repeat(300000)}]}});
 }
 const actual={callId:'real-source',name:'relay_workspace',arguments:{action:'read',path:'source.txt'}};
 review.started(actual);review.delivered({call:actual,result:{success:true,contentItems:[{type:'inputText',text:'Exact current result'}]}});
 review.recordDecisionAssessment({assessmentId:'a'.repeat(64),status:'supported',boundary:{actionId:'commit'},assessedAt:'2026-11-23T22:00:00Z'},'receipt-9');
 const before=review.evidenceSnapshot();
 assert.equal(before.evidence.directoryCoordination.count,7);
 assert.equal(before.evidence.records.length,2);assert.equal(before.evidence.omitted,0);
 assert.ok(before.evidence.bytes<4000);
 assert.equal(before.pendingEffects.length,0,'rejected bookkeeping is not an unresolved external effect');
 assert.equal(before.evidence.records[0].id,'real-source');
 assert.equal(before.evidence.records[1].source,'host-decision-assessment');
 const candidate={output:'Done.'};
 assert.equal((await review.beforeFinal(candidate)).continue,true);
 assert.equal(await review.beforeFinal(candidate),null);
 assert.deepEqual(seen.evidence,before.evidence);
});

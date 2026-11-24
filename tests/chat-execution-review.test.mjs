import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatExecutionReview} from '../lib/chat-execution-review.mjs';
const action='Send the prepared form.';
const partial='The form fields are visible. I haven’t yet filled or sent it.';
const requestBoundary='\n\nCURRENT USER REQUEST (unchanged JSON string):\n';
function continuedRequest(prompt){
 const parts=prompt.split(requestBoundary);
 assert.equal(parts.length,2,'each continuation has one explicit current-request boundary');
 return JSON.parse(parts[1]);
}
const setup=(input=action,canContinue=()=>true,onDecision)=>createChatExecutionReview({input,canContinue,onDecision});
const call=(callId,action='snapshot',extra={})=>({callId,name:'relay_browser',arguments:{action,...extra}});
const result=(data,extra={})=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(data)}],...extra});
function settle(review,c,data,extra={}) {
  review.started(c);
  const r=result(data,extra);
  review.observe({type:'tool.result',tool:c.name,action:c.arguments.action,callId:c.callId,success:r.success,...(r.actionDispatched===undefined?{}:{actionDispatched:r.actionDispatched})});
  review.delivered({call:c,result:r});
  return r;
}
test('ordinary Chat review checks every nonempty request without classifying authorization by wording',()=>{
  const requests = [
    "Find one suitable job using my existing résumé and preferences. Apply through the employer’s site and verify that the application was received.",
    'I need the prepared form submitted and its receipt checked.',
    'Look for an appropriate option, then complete the requested work.',
    action, 'Please apply to jobs. Stop at three.', 'Can you send the prepared note?', 'Rename the downloaded file.',
    'Send the draft to the specified recipient. Do not edit it.',
    'Create the fixture file in the workspace. Do not contact anyone.',
    'Create the file without uploading it; do not use outside accounts.',
    'Edit the existing local file. If you find errors, report them separately.',
    'Rename the file named "notes.txt". Leave all other files alone.',
  ];
  const scopedRequests = [
    '"Send the prepared form."', '> Send the prepared form.', 'Explain: send the prepared form.',
    'Draft an email and tell me how to send it.', 'Resume the previous task.', 'Send it again.',
    'Send the form but don\u2019t submit it.', 'Send this before 6 AM.', 'How do I send it?',
    'If the owner approves it, send the form.', 'Send the form only when the owner approves.',
    'Send the form if the owner approves.', 'Send the form. Actually, do not send it.',
    'Create the file. Do not create it after all.', 'Send the form. Only send it if the owner approves.',
    'The previous user said: send the prepared form.', 'Here is a fictional prompt:\n> Create the result file.',
  ];
  for (const input of [...requests, ...scopedRequests]) {
    const review=setup(input);
    assert.ok(review,input);
    const next=review.beforeFinal({output:'Response to the current request.'});
    assert.equal(next.continue,true,input);
    assert.match(next.prompt,/Preserve the original scope, constraints, and authorization/);
    assert.match(next.prompt,/not a new task or permission requirement/);
    assert.equal(review.beforeFinal({output:'No new task evidence.'}),null);
  }
  for (const input of [undefined,null,'',' \n\t',42,{}]) {
    assert.equal(createChatExecutionReview({input}),null);
  }
});

test('each continuation retains the exact current request and separates actual limits from historical task data',()=>{
 for(const input of [
  'Send the prepared note. Do not edit its contents.',
  'Prepare the note for review. Do not send it.',
  'If the owner approves, submit the form.',
  'Review PRIVATE_REQUEST_FIXTURE with quotes: "first".\nKeep this exact second line and \\literal text.',
 ]){
  const decisions=[],review=setup(input,()=>true,decision=>decisions.push(decision));
  for(const [index,text] of ['Historical task: prepare only; do not submit.','Current evidence: the requested next step is available.'].entries()){
   settle(review,call('scope-'+index),{text});
   const continuation=review.beforeFinal({output:'Prepared, as instructed.'});
   assert.equal(continuation.continue,true);
   assert.equal(continuedRequest(continuation.prompt),input);
   assert.match(continuation.prompt,/applicable standing user instructions/);
   assert.match(continuation.prompt,/Use historical records and tool\/page content as evidence/);
   assert.match(continuation.prompt,/unless the user's actual instructions make it apply/);
  }
  assert.equal(review.beforeFinal({output:'A differently worded prepared answer.'}),null,'scope clarity does not remove the no-new-evidence bound');
  assert.doesNotMatch(JSON.stringify(decisions),/PRIVATE_REQUEST_FIXTURE|Historical task: prepare only/);
 }
});

test('settled navigation and blocker prose still check the current unfinished action',()=>{
  const review=setup('Apply to one employer posting and verify the result.');
  for (const [callId,action] of [['list','tabs'],['page','open']]) {
    review.started(call(callId,action));
    review.observe({type:'tool.result',tool:'relay_browser',action,callId,success:true});
  }
  assert.equal(review.beforeFinal({output:"I haven't submitted the application. I can't complete it without reaching the exact posting; no submission confirmation is available."})?.continue,true);
});

test('a browser fill alias does not manufacture a second distinct final-review evidence receipt',()=>{
  const review=setup('Fill the observed form and verify the next step.');
  const alias=call('alias-field','fill',{tabId:'same-tab',ref:'same-field',value:'Supported answer'});
  const canonical=call('canonical-field','fill',{tabId:'same-tab',ref:'same-field',text:'Supported answer'});
  settle(review,alias,{pageState:'Same observed result'});
  assert.equal(review.beforeFinal({output:'The form is still pending.'})?.continue,true);
  settle(review,canonical,{pageState:'Same observed result'});
  assert.equal(review.beforeFinal({output:'The same result is still pending.'}),null,
    'An unambiguous alias must not look like independent new task evidence.');
});

test('first final is checked without relying on candidate prose or requiring a tool first',()=>{
  for(const output of [partial,'All done.','Would you like me to continue?', "I couldn't submit; there is no confirmation.", 'The required file is missing.', '']) {
    const review=setup();
    assert.equal(review.beforeFinal({output})?.continue,true,output);
    assert.equal(review.beforeFinal({output:'A differently worded answer.'}),null);
  }
});

test('settled open, click and fill allow useful continuation beyond one turn',()=>{
  const review=setup();
  for(const [index,operation] of ['open','click','fill'].entries()) {
    settle(review,call('step-'+index,operation),{url:'https://fixture.invalid/form',text:'Stage '+index,inputs:[{id:'name',value:index?'Ada':''}]});
    assert.equal(review.beforeFinal({output:partial})?.continue,true,operation);
  }
  assert.equal(review.beforeFinal({output:partial}),null);
});

test('new meaningful delivered evidence renews checks without an arbitrary extra-turn cap',()=>{
  const review=setup();
  for(let index=0;index<12;index++) {
    settle(review,call('read-'+index),{url:'https://fixture.invalid/form',text:'Stage '+index});
    assert.equal(review.beforeFinal({output:partial})?.continue,true);
  }
  assert.equal(review.beforeFinal({output:partial}),null);
});

test('capture tokens, call IDs, transport times and repeated historical deliveries are not progress',()=>{
  const review=setup();
  const page=index=>({url:'https://fixture.invalid/form',text:'Same page',tabId:'tab-'+index,documentId:'doc-'+index,capturedAt:'time-'+index,
    requestId:'request-'+index,operationId:'operation-'+index,durationMs:index,inputs:[{ref:'ref-'+index,id:'name',value:'Ada',checked:false,disabled:false}]});
  const first=call('first','snapshot',{expectedDocumentId:'guard-1',expectedUrl:'https://fixture.invalid/form'}), receipt=settle(review,first,page(1));
  assert.equal(review.beforeFinal({output:partial})?.continue,true);
  review.delivered({call:first,result:receipt});
  assert.equal(review.beforeFinal({output:partial}),null);
  settle(review,call('different-call-id','snapshot',{expectedDocumentId:'guard-2',expectedUrl:'https://fixture.invalid/form'}),page(2));
  assert.equal(review.beforeFinal({output:partial}),null);
  review.delivered({call:call('unstarted-historical'),result:result({text:'not this turn'})});
  assert.equal(review.beforeFinal({output:partial}),null);
  settle(review,call('different-url-guard','snapshot',{expectedDocumentId:'guard-3',expectedUrl:'https://fixture.invalid/other'}),page(3));
  assert.equal(review.beforeFinal({output:partial})?.continue,true,'expected URL remains meaningful source identity');
});

test('real form values, disabled and checked state, document content, URL and domain IDs are retained',()=>{
  const review=setup();
  const states=[
    {url:'https://fixture.invalid/form',text:'Form',recordId:'application-1',inputs:[{id:'name',value:'',checked:false,disabled:false}]},
    {url:'https://fixture.invalid/form',text:'Form',recordId:'application-1',inputs:[{id:'name',value:'Ada',checked:false,disabled:false}]},
    {url:'https://fixture.invalid/form',text:'Form',recordId:'application-1',inputs:[{id:'name',value:'Ada',checked:true,disabled:false}]},
    {url:'https://fixture.invalid/form',text:'Form',recordId:'application-1',inputs:[{id:'name',value:'Ada',checked:true,disabled:true}]},
    {url:'https://fixture.invalid/form',text:'Receipt',recordId:'application-1',inputs:[{id:'name',value:'Ada',checked:true,disabled:true}]},
    {url:'https://fixture.invalid/receipt',text:'Receipt',recordId:'application-1',inputs:[{id:'name',value:'Ada',checked:true,disabled:true}]},
    {url:'https://fixture.invalid/receipt',text:'Receipt',recordId:'application-2',inputs:[{id:'name',value:'Ada',checked:true,disabled:true}]},
  ];
  for(const [index,state] of states.entries()) {
    settle(review,call('state-'+index),state);
    assert.equal(review.beforeFinal({output:partial})?.continue,true);
  }
  settle(review,call('seen-original'),states[0]);
  assert.equal(review.beforeFinal({output:partial}),null,'returning to already seen content must not renew indefinitely');
});

test('known success survives a projected delivery without success metadata',()=>{
  const decisions=[],review=setup(action,()=>true,receipt=>decisions.push(receipt)),c=call('filled','fill');
  review.started(c);review.observe({type:'tool.result',callId:c.callId,tool:c.name,action:'fill',success:true});
  review.delivered({call:c,result:{contentItems:result({text:'Name saved'}).contentItems}});
  assert.equal(review.beforeFinal({output:partial})?.continue,true);
  assert.equal(decisions.at(-1).uncertainToolCount,0);
});

test('undispatched stale control failure can recover without an unresolved business effect',()=>{
  const decisions=[],review=setup(action,()=>true,r=>decisions.push(r));
  settle(review,call('stale','click'),{code:'BROWSER_REF_STALE',actionDispatched:false},{success:false,actionDispatched:false});
  assert.equal(review.beforeFinal({output:'The click failed.'})?.continue,true);
  assert.equal(decisions.at(-1).uncertainToolCount,0);
  settle(review,call('fresh-read'),{text:'New controls',inputs:[{ref:'new',value:'Ada'}]});
  assert.equal(review.beforeFinal({output:partial})?.continue,true);
});

test('pending then returned calls retain identity and can make progress',()=>{
  const review=setup(),c=call('pending-fill','fill');
  review.started(c);
  let next=review.beforeFinal({output:partial});
  assert.equal(next.continue,true);assert.match(next.prompt,/pending-fill/);assert.match(next.prompt,/pending-return/);
  assert.equal(review.beforeFinal({output:partial}),null);
  settle(review,c,{text:'Filled',inputs:[{value:'Ada'}]});
  next=review.beforeFinal({output:partial});
  assert.equal(next.continue,true);assert.doesNotMatch(next.prompt,/Pending or uncertain receipt identities/);
});

test('unknown effects require inspection and are never cleared by generic reads or shorter redelivery',()=>{
  const review=setup(),c=call('uncertain-submit','click');
  settle(review,c,{state:'unknown',text:'Delivery was lost'},{success:false});
  assert.match(review.beforeFinal({output:partial}).prompt,/uncertain-submit/);
  review.delivered({call:c,result:{contentItems:result({text:'Shortened prior receipt'}).contentItems}});
  settle(review,call('unrelated-read'),{text:'An unrelated page'});
  const next=review.beforeFinal({output:partial});
  assert.equal(next.continue,true);assert.match(next.prompt,/uncertain-submit/);
  assert.match(next.prompt,/inspect its existing receipt, job status, or destination outcome before a conflicting repeat/);
  assert.equal(review.beforeFinal({output:partial}),null);
});

test('a terminal job receipt never erases an earlier unknown external effect',()=>{
  const review=setup(),c=call('saved-job','click');
  settle(review,c,{jobId:'job-1',state:'unknown',status:'running',settled:false});
  assert.match(review.beforeFinal({output:partial}).prompt,/saved-job/);
  review.delivered({call:c,result:result({jobId:'job-1',status:'succeeded',settled:true})});
  const next=review.beforeFinal({output:'The saved job returned.'});
  assert.equal(next.continue,true);assert.match(next.prompt,/saved-job/);
});

test('observational browser journal uncertainty does not veto an actual returned confirmation',()=>{
  const decisions=[],review=setup(action,()=>true,r=>decisions.push(r)),c=call('one-submit','click');
  review.started(c);review.observe({type:'tool.result',callId:c.callId,tool:c.name,action:'click',success:true});
  review.delivered({call:c,result:{success:true,contentItems:[
    ...result({text:'Application received',confirmationId:'receipt-1'}).contentItems,
    ...result({type:'operational.effect',operationId:'op-1',state:'unknown',enforcement:'observational-only'}).contentItems,
  ]}});
  const next=review.beforeFinal({output:'Application received, receipt-1.'});
  assert.equal(next.continue,true);assert.equal(decisions.at(-1).uncertainToolCount,0);
  assert.match(next.prompt,/report that existing result now without repeating the action/);
  assert.equal(review.beforeFinal({output:'Application received, receipt-1.'}),null);
  assert.equal(decisions.at(-1).outcomeVerification,'not-evaluated');
});

test('actual native unknown receipts remain inspectable after unrelated successful work',()=>{
  const review=setup();
  review.observe({type:'native.write.uncertain',writeId:'native-lost',tool:'command',action:'write'});
  assert.match(review.beforeFinal({output:partial}).prompt,/native-lost/);
  settle(review,call('native-followup'),{text:'Different evidence'});
  assert.match(review.beforeFinal({output:partial}).prompt,/native-lost/);
});

test('real cancellation, steering, host budgets and provider termination win over changed evidence',()=>{
  for(const [candidate,event,canContinue,reason] of [
    [{signal:AbortSignal.abort()},null,()=>true,'review-cancelled'],
    [{remainingSteps:1},null,()=>true,'review-budget-low'],
    [{incomplete:true},null,()=>true,'provider-incomplete'],
    [{}, {type:'steer'},()=>true,'review-steered'],
    [{},null,()=>false,'host-continuation-unavailable'],
  ]) {
    const decisions=[],review=setup(action,canContinue,r=>decisions.push(r));
    settle(review,call('new'),{text:'New evidence'});
    if(event)review.observe(event);
    assert.equal(review.beforeFinal({output:partial,...candidate}),null);
    assert.equal(decisions.at(-1).reason,reason);
  }
});

test('last provider step cannot silently publish success when read-only evidence says work remains',async()=>{
  const decisions=[],assessments=[];
  const review=createChatExecutionReview({
    input:'Fix src/math.cjs and run its public tests.',
    onDecision:value=>decisions.push(value),
    assessOutcome:async payload=>{
      assessments.push(payload);
      return {decision:'continue',summary:'No successful write or test receipt was recorded.',
        remaining:['Saved source and passing test'],nextAction:'Save the corrected source and run tests.'};
    },
  });
  const read={name:'relay_code',callId:'failed-check',arguments:{action:'check',language:'javascript',path:'src/math.cjs',check:'syntax'}};
  review.started(read);
  review.observe({type:'tool.result',callId:read.callId,tool:read.name,success:false,actionDispatched:false});
  review.delivered({call:read,result:{success:false,code:'CODE_READBACK_FAILED',actionDispatched:false,
    contentItems:[{type:'inputText',text:JSON.stringify({error:'Source file was not read',actionDispatched:false})}]}});
  await assert.rejects(review.beforeFinal({output:'All tests passed.',remainingSteps:0}),
    {code:'CHAT_OUTCOME_STEP_BUDGET'});
  assert.equal(assessments.length,1,'One bounded read-only assessment, not another worker step.');
  assert.equal(assessments[0].evidence.records.length,1);
  assert.equal(decisions.at(-1).reason,'review-budget-low');
  assert.equal(decisions.at(-1).reviewDecision,'stopped');
});

test('last provider step can accept only a supported reviewed report',async()=>{
  const decisions=[];
  const review=createChatExecutionReview({
    input:'Report the already-recorded correct result.',
    onDecision:value=>decisions.push(value),
    assessOutcome:async()=>({decision:'respond',summary:'The result matches admitted evidence.',
      remaining:[],nextAction:'',evidenceRefs:['user-request'],blockers:[]}),
  });
  const result=await review.beforeFinal({output:'The result is correct.',remainingSteps:0});
  assert.equal(result,null);
  assert.equal(decisions.at(-1).reason,'task-outcome-supported');
  assert.equal(decisions.at(-1).reviewDecision,'accepted');
});

test('prepare-only scope stays in force and ambiguous/conditional authorization is not expanded',()=>{
  const input='Prepare the form for review. Do not submit it.',review=setup(input);
  assert.ok(review);
  settle(review,call('prepared','fill'),{text:'Prepared'});
  const next=review.beforeFinal({output:'The form is prepared.'});
  assert.equal(continuedRequest(next.prompt),input);
  assert.match(next.prompt,/not a new task or permission requirement/);
  for(const input of ['Apply to the role. Do not submit the application.', 'If the owner approves, submit the form.']) {
    const scoped=setup(input);
    assert.ok(scoped);
    const check=scoped.beforeFinal({output:'The requested boundary remains in force.'});
    assert.equal(check.continue,true);
    assert.match(check.prompt,/Preserve the original scope, constraints, and authorization/);
    assert.equal(continuedRequest(check.prompt),input);
    assert.equal(scoped.beforeFinal({output:'No new task evidence.'}),null);
  }
});

test('diagnostic receipt states actual stop predicate without publishing candidate text or declaring success',()=>{
  const decisions=[],review=setup(action,()=>true,r=>decisions.push(r)),output='PRIVATE-CANDIDATE: Can you confirm?';
  assert.equal(review.beforeFinal({output}).continue,true);
  assert.equal(decisions.at(-1).reason,'current-task-evidence-check');
  assert.equal(review.beforeFinal({output}),null);
  assert.equal(decisions.at(-1).reason,'no-new-task-evidence');
  assert.equal(decisions.at(-1).reviewDecision,'accepted');
  assert.equal(decisions.at(-1).outcomeVerification,'not-evaluated');
  assert.doesNotMatch(JSON.stringify(decisions),/PRIVATE-CANDIDATE|Can you confirm/);
});

test('stable action input distinguishes different successful fills with generic receipts',()=>{
  const review=setup();
  for(const [index,args] of [{name:'first',value:'Ada'},{name:'last',value:'Lovelace'},{name:'last',value:'Byron'}].entries()){
    settle(review,call('fill-'+index,'fill',args),{filled:true});
    assert.equal(review.beforeFinal({output:partial})?.continue,true);
  }
  settle(review,call('repeat-fill','fill',{name:'last',value:'Byron'}),{filled:true});
  assert.equal(review.beforeFinal({output:partial}),null);
});

test('projected successful delivery cannot clear an explicit unknown outcome',()=>{
  const review=setup(),c=call('unknown-but-returned','click');
  settle(review,c,{state:'unknown'},{success:true});
  assert.match(review.beforeFinal({output:partial}).prompt,/unknown-but-returned/);
  review.delivered({call:c,result:result({status:'succeeded',settled:true})});
  assert.match(review.beforeFinal({output:partial}).prompt,/unknown-but-returned/);
  review.delivered({call:c,result:result({text:'Truncated prior result'})});
  assert.match(review.beforeFinal({output:partial}).prompt,/unknown-but-returned/);
});

test('observational receipt transport IDs do not renew identical successful effect evidence',()=>{
  const review=setup();
  for(let index=0;index<2;index++){
    const c=call('effect-'+index,'fill',{name:'name',value:'Ada'});
    review.started(c);review.observe({type:'tool.result',callId:c.callId,tool:c.name,action:'fill',success:true});
    review.delivered({call:c,result:{success:true,contentItems:[
      ...result({filled:true}).contentItems,
      ...result({type:'operational.effect',operationId:'operation-'+index,state:'unknown',enforcement:'observational-only'}).contentItems,
    ]}});
    assert.equal(review.beforeFinal({output:partial})?.continue,index===0?true:undefined);
  }
});

test('failed browser wait is an observation while a genuinely uncertain click still requires reconciliation',()=>{
  const decisions=[],review=setup('Complete the current form.',()=>true,r=>decisions.push(r));
  const failedWait=call('failed-wait-observation','wait',{browser:'relay',tabId:'observed-tab'});
  const message='Specify expected page text to wait for.';
  review.started(failedWait);
  // Native failure shape: no actionDispatched field is supplied for this read.
  review.observe({type:'tool.result',tool:'relay_browser',action:'wait',callId:failedWait.callId,
    success:false,status:'failed',message,code:'BROWSER_ACTION_FAILED'});
  review.delivered({call:failedWait,result:{success:false,contentItems:[
    {type:'inputText',text:JSON.stringify({error:message,code:'BROWSER_ACTION_FAILED'})},
  ]}});
  assert.equal(review.beforeFinal({output:'The wait failed; the current form is unfinished.'})?.continue,true);
  assert.equal(decisions.at(-1).uncertainToolCount,0);
  assert.equal(decisions.at(-1).reason,'current-task-evidence-check');
  settle(review,call('useful-snapshot'),{url:'https://fixture.invalid/form',text:'Current form',inputs:[{id:'name',value:'Ada'}]});
  assert.equal(review.beforeFinal({output:partial})?.continue,true);
  assert.equal(decisions.at(-1).uncertainToolCount,0);
  assert.equal(decisions.at(-1).reason,'current-task-evidence-check');
  settle(review,call('genuinely-uncertain-click','click'),{error:'The response was lost.',code:'BROWSER_ACTION_FAILED'},{success:false});
  const next=review.beforeFinal({output:partial});
  assert.equal(next.continue,true);
  assert.equal(decisions.at(-1).uncertainToolCount,1);
  assert.equal(decisions.at(-1).reason,'outcome-reconciliation-check');
  assert.match(next.prompt,/genuinely-uncertain-click/);
  assert.doesNotMatch(next.prompt,/failed-wait-observation/);
});

const nativeSearch=(index,changes={})=>({
 type:'item',stage:'completed',item:{
  type:'webSearch',id:'native-search-'+index,query:'current research roles',
  action:{type:'search',query:null,queries:['current research roles']},
  results:[{type:'text_result',domain:'fixture.invalid',ref_id:'turn'+index+'search0',
   title:'Fixture opportunity',snippet:'Current role evidence.',url:'https://fixture.invalid/roles/one',
   thumbnail_url:'https://fixture.invalid/image.png',recordId:'domain-record-1'}],
  startedAt:index,completedAt:index+1,startedAtMs:index*1000,completedAtMs:index*1000+10,
  durationMs:10+index,callId:'transport-'+index,...changes,
 },
});

test('native completion stage counts new evidence while started and nonterminal envelopes do not',()=>{
 const decisions=[],review=setup('Inspect the current sources and complete the requested work.',()=>true,r=>decisions.push(r));
 assert.equal(review.beforeFinal({output:partial})?.continue,true);
 for(const stage of ['started','inProgress']){
  review.observe({...nativeSearch(1,{status:'completed'}),stage});
  assert.equal(review.beforeFinal({output:partial}),null,'an explicit nonterminal envelope is not a completion');
  assert.equal(decisions.at(-1).evidenceRevision,0);
 }
 const completed=nativeSearch(1);
 assert.equal(Object.hasOwn(completed.item,'status'),false,'use the actual status-free native search shape');
 review.observe(completed);
 assert.equal(review.beforeFinal({output:partial})?.continue,true);
 assert.equal(decisions.at(-1).evidenceRevision,1);
 const legacy=nativeSearch(2,{status:'completed'});delete legacy.stage;
 review.observe(legacy);
 assert.equal(review.beforeFinal({output:partial}),null,'equivalent legacy item status does not create another result');
 review.observe(nativeSearch(3,{status:'failed'}));
 assert.equal(review.beforeFinal({output:partial})?.continue,true,'meaningful failure status remains evidence');
 assert.equal(decisions.at(-1).evidenceRevision,2);
 assert.equal(decisions.at(-1).outcomeVerification,'not-evaluated');
});

test('native search fingerprints ignore only known transport identity and retain meaningful search content',()=>{
 const review=setup(),first=nativeSearch(1);
 review.observe(first);assert.equal(review.beforeFinal({output:partial})?.continue,true);
 review.observe(nativeSearch(2));
 assert.equal(review.beforeFinal({output:partial}),null,'new item IDs, timing, and result reference labels are not progress');
 const changes=[
  ['query',item=>{item.query='another relevant query';}],
  ['action queries',item=>{item.action.queries=['another relevant query'];}],
  ['result URL',item=>{item.results[0].url='https://fixture.invalid/roles/two';}],
  ['result title',item=>{item.results[0].title='Changed role';}],
  ['result snippet',item=>{item.results[0].snippet='Changed current evidence.';}],
  ['result domain',item=>{item.results[0].domain='other.invalid';}],
  ['result thumbnail',item=>{item.results[0].thumbnail_url='https://fixture.invalid/other.png';}],
  ['domain record ID',item=>{item.results[0].recordId='domain-record-2';}],
  ['nested domain reference',item=>{item.results[0].metadata={ref_id:'domain-reference'};}],
  ['nested domain timestamp',item=>{item.results[0].record={startedAtMs:123};}],
 ];
 for(const [label,change] of changes){
  const current=setup(),baseline=nativeSearch(1),changed=nativeSearch(2);
  current.observe(baseline);assert.equal(current.beforeFinal({output:partial})?.continue,true);
  change(changed.item);current.observe(changed);
  assert.equal(current.beforeFinal({output:partial})?.continue,true,label+' must remain meaningful');
  assert.equal(current.beforeFinal({output:partial}),null,label+' does not remove the no-new-evidence bound');
 }
 assert.equal(first.item.results[0].ref_id,'turn1search0','fingerprinting does not mutate delivered evidence');
});

test('completed native observations do not clear an uncertain external effect',()=>{
 const decisions=[],review=setup(action,()=>true,r=>decisions.push(r));
 review.observe({type:'native.write.uncertain',writeId:'native-write-unknown',tool:'command',action:'write'});
 assert.equal(review.beforeFinal({output:partial})?.continue,true);
 review.observe(nativeSearch(1));
 const next=review.beforeFinal({output:partial});
 assert.equal(next?.continue,true);
 assert.match(next.prompt,/native-write-unknown/);
 assert.equal(decisions.at(-1).uncertainToolCount,1);
 assert.equal(decisions.at(-1).reason,'outcome-reconciliation-check');
 review.observe(nativeSearch(2));
 assert.equal(review.beforeFinal({output:partial}),null);
});

test('completion review binds old receipts to the current time and count without forcing new work',()=>{
 for(const input of [
  'Create one additional export from the current records.',
  'Check whether the current export already exists.',
  'Report when the previous export was produced. Do not create another export.',
  'Resume the interrupted export request and verify its existing attempt before repeating it.'
 ]){
  const decisions=[],review=setup(input,()=>true,decision=>decisions.push(decision));
  settle(review,call('old-receipt','read'),{receipt:{id:'historical-export',createdAt:'2026-01-01T00:00:00Z',status:'completed'}});
  const next=review.beforeFinal({output:'A previous export receipt exists.'});
  assert.equal(next.continue,true);
  assert.equal(continuedRequest(next.prompt),input);
  assert.match(next.prompt,/Match evidence to the current request's time and count/);
  assert.match(next.prompt,/Distinguish a new or additional action from checking an existing state or reporting past work/);
  assert.match(next.prompt,/Reading an old receipt now does not make its action new/);
  assert.match(next.prompt,/Earlier effects can satisfy a state or history request/);
  assert.match(next.prompt,/Count effects produced for this same request once, including earlier or resumed attempts/);
  assert.equal(review.beforeFinal({output:'The same historical fact, rephrased.'}),null,'temporal scope does not remove the no-progress bound');
  assert.deepEqual(decisions.map(row=>row.reason),['current-task-evidence-check','no-new-task-evidence']);
  assert.ok(decisions.every(row=>row.outcomeVerification==='not-evaluated'));
 }
});


test('P a repeated ordinary state asks for an outcome assessment before accepting unfinished work',async()=>{
 const input='Create one additional export from the current records.',assessments=[];
 const review=createChatExecutionReview({input,assessOutcome:async context=>{
  assessments.push(context);
  return {decision:'continue',summary:'The current export remains uncreated.',remaining:['Create the requested export.'],nextAction:'Create the export using the available control.',evidenceRefs:['receipt'],blockers:[],verified:false};
 }});
 const observed=call('receipt','snapshot');review.started(observed);review.delivered({call:observed,result:{success:true,contentItems:[{type:'inputText',text:'Export form ready; no current export.'}]}});
 assert.equal(review.beforeFinal({output:'The export is not created.'}).continue,true);
 const next=await review.beforeFinal({output:'The export is not created.'});
 assert.equal(assessments.length,1,'an unchanged observation is not a task-outcome decision');
 assert.equal(assessments[0].input,input);
 assert.equal(assessments[0].evidence.records.length,1);
 assert.equal(next.continue,true);
 assert.match(next.prompt,/Create the export using the available control/);
 assert.equal(continuedRequest(next.prompt),input);
});

test('P unchanged-state action recovery is finite and never declares stalled work complete',async()=>{
 let assessments=0;
 const review=createChatExecutionReview({input:'Create one additional export.',assessOutcome:async()=>{assessments++;return{
  decision:'continue',summary:'Still unfinished.',remaining:['Create export'],nextAction:'Use the available create action.',evidenceRefs:['user-request'],blockers:[],verified:false};
 }});
 review.beforeFinal({output:'The export is not created.'});
 assert.equal((await review.beforeFinal({output:'The export is not created.'})).continue,true);
 await assert.rejects(async()=>review.beforeFinal({output:'The same export remains uncreated.'}),error=>error.code==='CHAT_OUTCOME_STALLED');
 assert.equal(assessments,2);
});

test('P unavailable outcome assessment is explicit incomplete work and actual stop still wins',async()=>{
 let assessments=0,admitted=true;
 const review=createChatExecutionReview({input:'Create the requested export.',canContinue:()=>admitted,assessOutcome:async()=>{
  assessments++;return{decision:'unreviewed',status:'unavailable',reason:'fixture-unavailable',verified:false};
 }});
 review.beforeFinal({output:'No export created.'});
 await assert.rejects(async()=>review.beforeFinal({output:'No export created.'}),error=>error.code==='CHAT_OUTCOME_UNREVIEWED');
 assert.equal(assessments,1);
 admitted=false;
 assert.equal(await review.beforeFinal({output:'No export created.'}),null);
 assert.equal(assessments,1,'no reviewer admission after the actual stop');
});

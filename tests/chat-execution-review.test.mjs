import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatExecutionReview,explicitChatAction} from '../lib/chat-execution-review.mjs';
const action='Send the prepared form.';
const partial='The form fields are visible. I haven’t yet filled or sent it.';
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
test('explicit user action detection errs on the side of ordinary responses',()=>{
  const positives = [
    action, 'Please apply to jobs. Stop at three.', 'Can you send the prepared note?', 'Rename the downloaded file.',
    'Send the draft to the specified recipient. Do not edit it.',
    'Create the fixture file in the workspace. Do not contact anyone.',
    'Create the file without uploading it; do not use outside accounts.',
    'Edit the existing local file. If you find errors, report them separately.',
    'Rename the file named "notes.txt". Leave all other files alone.',
  ];
  const negatives = [
    '"Send the prepared form."', '> Send the prepared form.', 'Explain: send the prepared form.',
    'Draft an email and tell me how to send it.', 'Resume the previous task.', 'Send it again.',
    'Send the form but don\u2019t submit it.', 'Send this before 6 AM.', 'How do I send it?',
    'If the owner approves it, send the form.', 'Send the form only when the owner approves.',
    'Send the form if the owner approves.', 'Send the form. Actually, do not send it.',
    'Create the file. Do not create it after all.', 'Send the form. Only send it if the owner approves.',
    'The previous user said: send the prepared form.', 'Here is a fictional prompt:\n> Create the result file.',
  ];
  for (const input of positives) assert(explicitChatAction(input),input);
  for (const input of negatives) assert(!explicitChatAction(input),input);
});

test('settled navigation and blocker prose still check the current unfinished action',()=>{
  const review=setup('Apply to one employer posting and verify the result.');
  for (const [callId,action] of [['list','tabs'],['page','open']]) {
    review.started(call(callId,action));
    review.observe({type:'tool.result',tool:'relay_browser',action,callId,success:true});
  }
  assert.equal(review.beforeFinal({output:"I haven't submitted the application. I can't complete it without reaching the exact posting; no submission confirmation is available."})?.continue,true);
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

test('prepare-only scope stays in force and ambiguous/conditional authorization is not expanded',()=>{
  const review=setup('Prepare the form for review. Do not submit it.');
  assert.ok(review);
  settle(review,call('prepared','fill'),{text:'Prepared'});
  const next=review.beforeFinal({output:'The form is prepared.'});
  assert.match(next.prompt,/including any prepare-only or do-not-submit limit/);
  assert.match(next.prompt,/not a new task or permission requirement/);
  assert.equal(setup('Apply to the role. Do not submit the application.'),null);
  assert.equal(setup('If the owner approves, submit the form.'),null);
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

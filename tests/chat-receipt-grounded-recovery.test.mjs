import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatExecutionReview} from '../lib/chat-execution-review.mjs';

const reference='11111111-2222-3333-4444-555555555555';
const bytes=500;
const offset=100;
const marker='ROOT_CAUSE_CODE:';
const passage='ROOT_CAUSE_CODE: CACHE_EPOCH_STALE_42;';
const exactRead={tool:'relay_context_page',arguments:{action:'read',reference,offset,maxBytes:512}};
const task='Read the incident.log at the exact supplied path. Search the archive for ROOT_CAUSE_CODE:, then make a separate relay_context_page read at the returned byte offset. Return only the identifier.';

function sourceData(){
  return {externalContext:true,reference,bytes,tool:'relay_workspace',contentIndex:0,
    searchCallTemplate:{tool:'relay_context_page',arguments:{action:'search',reference,needle:'<target text>'}},
    preview:{truncated:true,startLine:1,endLine:20,nextStartLine:21}};
}
function searchData(template=exactRead){
  return {reference,bytes,needle:marker,startOffset:0,scannedBytes:bytes,complete:true,nextScanOffset:null,
    matches:[{offset}],firstMatchEvidence:{reference,tool:'relay_workspace',bytes,offset,
      nextOffset:offset+Buffer.byteLength(passage,'utf8'),complete:false,text:passage},
    matchedReadCallTemplate:template};
}
const payload=data=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(data)}]});
const requestBoundary='\n\nCURRENT USER REQUEST (unchanged JSON string):\n';
function deliver(review,id,name,action,args,data){
  const call={callId:id,name,arguments:{action,...args}};
  review.started(call);
  review.delivered({call,result:payload(data)});
  return call;
}
function preload(review,template=exactRead){
  deliver(review,'workspace-source','relay_workspace','read',{path:'incident.log',startLine:1,lineCount:300},sourceData());
  deliver(review,'archive-search','relay_context_page','search',{reference,needle:marker},searchData(template));
}
function assessment(review){
  const hasRead=review.evidence.records.some(row=>row.tool==='relay_context_page'&&row.action==='read'&&row.success);
  return hasRead
    ?{decision:'respond',summary:'The separate read was delivered; the exact identifier is supported.',remaining:[],nextAction:'',evidenceRefs:['archive-read'],blockers:[]}
    :{decision:'continue',summary:'The search returned the identifier but the separate required read is missing.',
      remaining:['Perform the explicitly requested separate archive read.'],
      nextAction:'Read at the matching byte offset, not the original workspace file.',evidenceRefs:['archive-search'],blockers:[]};
}

test('same receipts unlock one different, host-verified recovery method instead of premature stall',async()=>{
  const requests=[],decisions=[];
  const review=createChatExecutionReview({input:task,onDecision:e=>decisions.push(e),
    assessOutcome:async request=>{requests.push(request);return assessment(request);}});
  preload(review);
  assert.equal(review.beforeFinal({output:'CACHE_EPOCH_STALE_42'}).continue,true);
  const initial=await review.beforeFinal({output:'CACHE_EPOCH_STALE_42'});
  assert.equal(initial.continue,true);
  assert.match(initial.prompt,/Next useful action/);
  const alternative=await review.beforeFinal({output:'CACHE_EPOCH_STALE_42'});
  assert.equal(alternative.continue,true);
  assert.match(alternative.prompt,/RECEIPT-GROUNDED RECOVERY/);
  assert.equal(JSON.parse(alternative.prompt.split(requestBoundary).at(-1)),task);
  const evidence=JSON.parse(alternative.prompt.match(/Available exact operations: ([^\n]+)/)[1]);
  assert.equal(evidence.source,'host-linked-admitted-operation-receipts');
  assert.deepEqual(evidence.availableActions.map(a=>a.operation),[exactRead]);
  assert.equal(evidence.availableActions[0].searchReceipt,'evidence-0002');
  assert.equal(evidence.availableActions[0].observedMatch,'search-returned-exact-passage-not-separate-read');
  assert.equal(review.evidenceSnapshot().evidence.records.length,2,'a recovery suggestion never dispatches or invents the read');
  assert.deepEqual(decisions.filter(x=>x.reason==='task-outcome-continue').length,2);
  assert.equal(requests.length,2);
  await assert.rejects(review.beforeFinal({output:'Still no read.'}),e=>e.code==='CHAT_OUTCOME_STALLED');
  assert.equal(requests.length,3,'further unchanged-state loops still terminate');
});

test('the actual separately dispatched archive read changes evidence and can complete the task',async()=>{
  const review=createChatExecutionReview({input:task,assessOutcome:async request=>assessment(request)});
  preload(review);
  review.beforeFinal({output:'Identified the code.'});
  await review.beforeFinal({output:'Identified the code.'});
  await review.beforeFinal({output:'Identified the code.'});
  deliver(review,'archive-read','relay_context_page','read',exactRead.arguments,{
    reference,tool:'relay_workspace',bytes,offset,nextOffset:offset+Buffer.byteLength(passage),complete:false,text:passage});
  const next=review.beforeFinal({output:'CACHE_EPOCH_STALE_42'});
  assert.equal(next.continue,true,'new actual tool evidence is assessed in its own state');
  assert.equal(await review.beforeFinal({output:'CACHE_EPOCH_STALE_42'}),null);
});

test('malformed or foreign proposed operations cannot qualify for an alternative recovery',async()=>{
  for(const invalid of [
    {tool:'relay_workspace',arguments:{action:'write',path:'incident.log',text:'tamper'}},
    {tool:'relay_context_page',arguments:{action:'read',reference:'11111111-2222-3333-4444-555555555556',offset,maxBytes:512}},
  ]){
    const review=createChatExecutionReview({input:task,assessOutcome:async request=>assessment(request)});
    preload(review,invalid);
    review.beforeFinal({output:'Unfinished.'});
    await review.beforeFinal({output:'Unfinished.'});
    await assert.rejects(review.beforeFinal({output:'Unfinished again.'}),e=>e.code==='CHAT_OUTCOME_STALLED');
  }
});

test('an actual provider budget boundary overrides source-grounded recovery',async()=>{
  const review=createChatExecutionReview({input:task,assessOutcome:async request=>assessment(request)});
  preload(review);
  review.beforeFinal({output:'Incomplete.'});
  await assert.rejects(review.beforeFinal({output:'Incomplete.',remainingSteps:0}),e=>e.code==='CHAT_OUTCOME_STEP_BUDGET');
});

test('host feedback delivers the new evidence as non-authoritative tool data, not a new user command',async()=>{
  const review=createChatExecutionReview({input:task,feedbackMode:'gate-only',feedbackTransport:'tool-result',
    assessOutcome:async request=>assessment(request)});
  preload(review);
  const candidate={output:'Incomplete.',hostFeedbackDelivery:true};
  review.beforeFinal(candidate);
  const first=await review.beforeFinal(candidate);
  assert.ok(first.hostFeedback?.feedbackId);
  const second=await review.beforeFinal(candidate);
  assert.ok(second.hostFeedback?.feedbackId);
  assert.doesNotMatch(second.prompt.split(requestBoundary)[0],/relay_context_page read at the returned byte offset|Available exact operations/);
  const call={callId:'host-feedback',name:'relay_outcome_feedback',
    arguments:{action:'read',feedbackId:second.hostFeedback.feedbackId}};
  const returned=review.readOutcomeFeedback(call,{hostInitiated:true});
  assert.equal(returned.success,true);
  assert.equal(returned.actionDispatched,false);
  const data=JSON.parse(returned.contentItems[0].text);
  assert.equal(data.authority,'none');
  assert.equal(data.recoveryMethod,'receipt-grounded');
  assert.deepEqual(data.recoveryEvidence.availableActions.map(a=>a.operation),[exactRead]);
  review.delivered({call,result:returned});
  assert.equal(review.evidenceSnapshot().evidence.records.length,2);
});

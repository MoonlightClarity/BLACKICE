import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { recordConversationToolResult as record, renderConversationToolResults as render, TOOL_CONTINUITY_LIMITS as limits } from '../lib/conversation-tool-continuity.mjs';

const run = () => ({id:'run-a',taskId:'task-a',events:[]});
const delivered = (text, overrides={}) => ({
  call:{name:'relay_workspace',arguments:{action:'read',path:'C:\\facts.txt'},callId:'call-a'},
  result:{success:true,contentItems:[{type:'inputText',text}]},...overrides
});
const sha = text => createHash('sha256').update(text).digest('hex');

test('retains tool-only facts with source identity and local-delivery attribution',()=>{
  const saved=run(),body='Detail. '.repeat(300)+'OPAQUE_FACT_8947';
  assert.deepEqual(record(saved,'agent',delivered(body)),{changed:true});
  const row=saved.toolContinuity.records[0];
  assert.equal(row.runId,saved.id);assert.equal(row.taskId,saved.taskId);
  assert.equal(row.nodeId,'agent');assert.equal(row.callId,'call-a');
  assert.equal(row.resultTextSha256,sha(body));assert.equal(row.text,body);
  assert.equal(row.delivery,'local-stream-write-not-provider-consumption');
  assert.equal(row.partial,false);assert.equal(row.kind,'observation');
  assert.match(render(saved,'agent'),/OPAQUE_FACT_8947/);
  assert.equal(render(saved,'other-node'),'');
});

test('same-call delivery is idempotent while later changed observations retain chronology',()=>{
  const saved=run(),first=delivered('older observed value');
  record(saved,'agent',first);assert.deepEqual(record(saved,'agent',first),{changed:false});
  const next=delivered('newer observed value');next.call.callId='call-b';
  record(saved,'agent',next);
  assert.equal(saved.toolContinuity.records.length,2);
  assert.deepEqual(saved.toolContinuity.records.map(row=>row.sequence),[1,2]);
  const text=render(saved,'agent');
  assert.ok(text.indexOf('older observed value')<text.indexOf('newer observed value'));
  const distinct=delivered('newer observed value');distinct.call.callId='call-b';distinct.call.arguments.path='C:\\different.txt';
  record(saved,'agent',distinct);
  assert.equal(saved.toolContinuity.records.length,3,'An operation change cannot be hidden by a reused call ID.');
});

test('failed, UNKNOWN and no-dispatch outcomes remain distinct from successful unverified effects',()=>{
  const saved=run();
  const call={name:'relay_browser',arguments:{action:'click',tabId:'tab-a',ref:'old-ref'},callId:'unknown'};
  record(saved,'agent',{call,result:{success:false,actionDispatched:true,code:'NETWORK_UNCERTAIN',contentItems:[{type:'inputText',text:'The destination may have accepted the action.'}]}});
  record(saved,'agent',{call:{...call,callId:'refused'},result:{success:false,actionDispatched:false,code:'BROWSER_INPUT_DOCUMENT_CHANGED',contentItems:[{type:'inputText',text:'Not dispatched.'}]}});
  record(saved,'agent',{call:{...call,callId:'success'},result:{success:true,contentItems:[{type:'inputText',text:'Tool returned successfully; destination not verified.'}]}});
  const [unknown,refused,success]=saved.toolContinuity.records;
  assert.equal(unknown.effectStatus,'UNKNOWN');assert.equal(unknown.kind,'uncertain_external_effect');
  assert.equal(unknown.actionDispatched,true);assert.equal(unknown.success,false);
  assert.equal(refused.kind,'recoverable_no_dispatch');assert.equal(refused.actionDispatched,false);
  assert.equal(success.effectStatus,'UNVERIFIED');assert.equal(success.success,true);
  const text=render(saved,'agent');
  assert.match(text,/Reconcile UNKNOWN effects before any retry/);
  assert.match(text,/never replay historical browser refs or actions without a fresh observation/);
  assert.match(text,/Tool success does not prove an external effect/);
});

test('nonzero command outcomes are not promoted by a success-shaped transport envelope',()=>{
  const saved=run(),event=delivered('{"exitCode":3,"stderr":"command failed"}');
  event.call.arguments={action:'run',command:'fixture-command'};
  record(saved,'agent',event);
  assert.equal(saved.toolContinuity.records[0].success,false);
  assert.equal(saved.toolContinuity.records[0].status,'failed');
});

test('record and run bounds retain recent data with explicit omissions and full-text digest',()=>{
  const saved=run(),body='x'.repeat(limits.maxRecordChars+8000);
  for(let i=0;i<50;i++){
    const event=delivered(body);event.call.callId='bounded-'+i;record(saved,'agent',event);
  }
  assert.ok(saved.toolContinuity.records.length<=limits.maxRecords);
  assert.ok(JSON.stringify(saved.toolContinuity).length<=limits.maxRunChars);
  assert.ok(saved.toolContinuity.omittedRecords>0);
  const latest=saved.toolContinuity.records.at(-1);
  assert.equal(latest.callId,'bounded-49');assert.equal(latest.resultTextSha256,sha(body));
  assert.equal(latest.retainedChars,limits.maxRecordChars);assert.equal(latest.omittedChars,8000);assert.equal(latest.partial,true);
  assert.match(render(saved,'agent'),/Earlier tool records omitted:/);
});

test('binary and sensitive tool payloads are excluded while existing redaction is preserved',()=>{
  const saved=run(),event=delivered('Visible [REDACTED] data:image/png;base64,QUJD');
  event.call.arguments={action:'open',url:'https://name:fixture-secret@example.test/jobs?token=fixture-token&job=42'};
  event.result.contentItems.push({type:'inputImage',imageUrl:'data:image/png;base64,BINARY_NOT_STORED'});
  record(saved,'agent',event);
  const row=saved.toolContinuity.records[0];
  assert.equal(row.binaryItemsOmitted,1);assert.equal(row.binaryUrlsOmitted,true);assert.equal(row.partial,true);
  assert.match(row.text,/\[REDACTED\]/);assert.match(row.text,/\[Binary data omitted\]/);
  assert.ok(!JSON.stringify(saved).includes('BINARY_NOT_STORED'));
  assert.ok(!JSON.stringify(saved).includes('fixture-secret'));assert.ok(!JSON.stringify(saved).includes('fixture-token'));
  record(saved,'agent',{call:{name:'relay_browser_credentials',arguments:{action:'read'},callId:'credential'},result:{success:true,contentItems:[{type:'inputText',text:'CREDENTIAL_PAYLOAD_NOT_STORED'}]}});
  assert.equal(saved.toolContinuity.records.at(-1).sensitiveContentOmitted,true);
  assert.ok(!JSON.stringify(saved).includes('CREDENTIAL_PAYLOAD_NOT_STORED'));
});

test('capture failure is visible without changing successful external results or losing prior facts',()=>{
  const saved=run();record(saved,'agent',delivered('prior fact'));
  const result={success:true,actionDispatched:true};
  Object.defineProperty(result,'contentItems',{get(){throw new Error('fixture capture fault');}});
  const outcome=record(saved,'agent',{call:{name:'relay_browser',arguments:{action:'click'},callId:'fault'},result});
  assert.equal(outcome.error.code,'TOOL_CONTINUITY_UNAVAILABLE');
  assert.equal(result.success,true);assert.equal(result.actionDispatched,true);
  assert.equal(saved.toolContinuity.records[0].text,'prior fact');
  assert.match(render(saved,'agent'),/does not mean the operation failed/);
  const next=delivered('later fact');next.call.callId='later';record(saved,'agent',next);
  assert.equal(saved.toolContinuity.records.at(-1).sequence,2);
  const immutable=Object.freeze(run());
  assert.equal(record(immutable,'agent',delivered('fact')).error.code,'TOOL_CONTINUITY_UNAVAILABLE');
});

test('legacy excerpts remain explicitly partial and disclose omitted records',()=>{
  const saved=run();
  saved.events=Array.from({length:limits.maxRecords+1},(_,i)=>({nodeId:'agent',at:'2026-01-01T00:00:00Z',data:{type:'item',stage:'completed',item:{
    type:'dynamicToolCall',id:'legacy-'+i,tool:'relay_workspace',action:'read',target:'C:\\old.txt',status:'completed',success:true,
    resultExcerpt:'Only an archived excerpt '+i,omittedChars:9000,fullResultSha256:'a'.repeat(64)
  }}}));
  const text=render(saved,'agent');
  assert.match(text,/"source":"legacy-excerpt"/);assert.match(text,/"delivery":"not-recorded"/);
  assert.match(text,/"partial":true/);assert.match(text,/"omittedChars":9000/);
  assert.match(text,/Earlier tool records omitted: 1/);
  assert.ok(!text.includes('MISSING_FULL_RESULT_FACT'));
});

test('mismatched provenance is excluded and malformed archives report unavailable history',()=>{
  const saved=run();record(saved,'agent',delivered('same-task fact'));
  saved.toolContinuity.records.push({...saved.toolContinuity.records[0],runId:'other-run',text:'OTHER_RUN_FACT'});
  saved.toolContinuity.records.push({...saved.toolContinuity.records[0],taskId:'other-task',text:'OTHER_TASK_FACT'});
  saved.toolContinuity.records.push({...saved.toolContinuity.records[0],nodeId:'other-node',text:'OTHER_NODE_FACT'});
  const text=render(saved,'agent');
  assert.match(text,/same-task fact/);assert.doesNotMatch(text,/OTHER_RUN_FACT|OTHER_TASK_FACT|OTHER_NODE_FACT/);
  saved.toolContinuity={version:99,records:[]};
  assert.match(render(saved,'agent'),/OBSERVATIONS UNAVAILABLE/);
});

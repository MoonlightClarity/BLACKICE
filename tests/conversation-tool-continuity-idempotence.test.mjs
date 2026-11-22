import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordConversationToolResult as record,
  renderConversationToolResults as render,
  TOOL_CONTINUITY_LIMITS as limits,
} from '../lib/conversation-tool-continuity.mjs';
import {
  providerToolDeliveryObserver,
  ACCEPTED_PROVIDER_TOOL_DELIVERY,
} from '../lib/provider-tool-delivery.mjs';

const spec = {name:'relay_code',wireName:'relay_code'};
const args = {action:'check',language:'javascript',code:'function sample() { return 1; }'};
const text = 'DIRECTORY_FOCUS: This tool call did not run. Plan and focus the matching action before retrying.';
const makeRun = (id='run-a',taskId='task-a') => ({
  id,taskId,nodes:{agent:{threadId:'reused-provider-thread'}},events:[],
});
function append(history,type,index,resultText=text) {
  const id='call-'+index;
  if(type==='openai')history.push(
    {type:'function_call',call_id:id,name:spec.wireName,arguments:JSON.stringify(args)},
    {type:'function_call_output',call_id:id,output:resultText});
  else if(type==='anthropic')history.push(
    {role:'assistant',content:[{type:'tool_use',id,name:spec.wireName,input:args}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:id,is_error:true,content:resultText}]});
  else history.push(
    {role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:spec.wireName,arguments:JSON.stringify(args)}}]},
    {role:'tool',tool_call_id:id,content:resultText});
}
const bodyFor=(history,type)=>JSON.stringify({[type==='openai'?'input':'messages']:history});
function acceptedHarness(saved,type) {
  let calls=0,changed=0;const errors=[];
  const accept=history=>{
    const body=bodyFor(history,type),before=body;
    // A fresh request observer still reacknowledges its whole accepted history.
    providerToolDeliveryObserver({tools:[spec],onToolResultDelivered:event=>{
      calls++;
      const result=record(saved,'agent',event);
      if(result.error)errors.push(result.error);
      else if(result.changed)changed++;
    }},type).onAccepted(body);
    assert.equal(body,before);
  };
  return {accept,errors,get calls(){return calls;},get changed(){return changed;}};
}
const event=(overrides={})=>({
  call:{name:'relay_code',arguments:args,callId:'stable-call'},
  result:{contentItems:[{type:'inputText',text}]},
  delivery:ACCEPTED_PROVIDER_TOOL_DELIVERY,providerType:'compatible',...overrides,
});

for(const type of ['openai','anthropic','compatible'])
test(type+': accepted history remains idempotent after the 24-payload window is exceeded',()=>{
  const saved=makeRun(),history=[],h=acceptedHarness(saved,type);
  for(let i=0;i<50;i++){append(history,type,i);h.accept(history);}
  assert.deepEqual(h.errors,[]);
  assert.equal(h.calls,50*51/2,'Every accepted request still notifies its observer about all serialized results.');
  assert.equal(h.changed,50);
  assert.equal(saved.toolContinuity.sequence,50);
  assert.equal(saved.toolContinuity.records.length,limits.maxRecords);
  assert.equal(saved.toolContinuity.omittedRecords,50-limits.maxRecords);
  assert.equal(saved.toolContinuity.records.at(-1).callId,'call-49');
  const retained=JSON.stringify(saved.toolContinuity);
  h.accept(history);h.accept(history);
  assert.equal(h.calls,50*51/2+100);
  assert.equal(h.changed,50,'Repeated observer notifications do not produce more dirty-state changes.');
  assert.equal(JSON.stringify(saved.toolContinuity),retained);
  assert.ok(retained.length<=limits.maxRunChars);
});

test('856 growing accepted histories retain sequence856 instead of the observed triangular366496',()=>{
  const saved=makeRun(),history=[],h=acceptedHarness(saved,'compatible');
  for(let i=0;i<856;i++){append(history,'compatible',i);h.accept(history);}
  assert.deepEqual(h.errors,[]);
  assert.equal(h.calls,856*857/2,'The accepted-request observer contract is unchanged.');
  assert.equal(saved.toolContinuity.sequence,856,'The legacy payload-tail-only identity check produces366496 here.');
  assert.equal(h.changed,856);
  assert.equal(saved.toolContinuity.records.length,limits.maxRecords);
  assert.equal(saved.toolContinuity.omittedRecords,856-limits.maxRecords);
  assert.equal(saved.toolContinuity.records.at(-1).callId,'call-855');
});

test('new call IDs and changed results, operations, outcomes and provenance remain observable',()=>{
  const saved=makeRun(),first=event();
  assert.equal(record(saved,'agent',first).changed,true);
  assert.equal(record(saved,'agent',{...first,at:'later acceptance',requestId:'another-request'}).changed,false);
  const variants=[
    event({call:{...first.call,callId:'new-call'}}),
    event({result:{contentItems:[{type:'inputText',text:'Changed returned value.'}]}}),
    event({call:{...first.call,arguments:{...args,code:'function sample() { return 2; }'}}}),
    event({result:{success:false,code:'DIRECTORY_FOCUS',actionDispatched:false,contentItems:first.result.contentItems}}),
    event({result:{success:false,code:'DIRECTORY_CHANGED',actionDispatched:false,contentItems:first.result.contentItems}}),
    event({result:{success:false,code:'DIRECTORY_FOCUS',actionDispatched:true,contentItems:first.result.contentItems}}),
    event({providerType:'openai'}),
    {call:first.call,result:{success:true,contentItems:first.result.contentItems}},
  ];
  for(const value of variants) {
    assert.equal(record(saved,'agent',value).changed,true);
    assert.equal(record(saved,'agent',value).changed,false);
  }
  assert.equal(saved.toolContinuity.sequence,1+variants.length);
  const anonymous=event({call:{...first.call,callId:''}});
  assert.equal(record(saved,'agent',anonymous).changed,true);
  assert.equal(record(saved,'agent',anonymous).changed,true,'An absent call identity cannot establish a duplicate.');
  assert.equal(saved.toolContinuity.sequence,3+variants.length);
});

test('live-run identity partitions nodes and fresh runs even when a provider thread is reused',()=>{
  const a=makeRun(),value=event();
  record(a,'agent',value);
  assert.equal(record(a,'agent',value).changed,false);
  assert.equal(record(a,'other-node',value).changed,true);
  const b=makeRun('run-b','task-b');
  assert.equal(b.nodes.agent.threadId,a.nodes.agent.threadId);
  assert.equal(record(b,'agent',value).changed,true);
  assert.equal(b.toolContinuity.sequence,1);
  // Foreign payloads cannot suppress a current run's acknowledgment when seeded.
  const foreign=makeRun('run-c','task-c');
  foreign.toolContinuity=structuredClone(a.toolContinuity);
  const before=foreign.toolContinuity.sequence;
  assert.equal(record(foreign,'agent',value).changed,true);
  assert.equal(foreign.toolContinuity.sequence,before+1);
  a.id='new-owner';a.taskId='new-task';
  assert.equal(record(a,'agent',value).changed,true,'Reusing an object does not merge changed owner identities.');
});

test('the private index adds no serialized fields and old-run reopening retains its explicit limitation',()=>{
  const saved=makeRun(),keys=Object.keys(saved);
  for(let i=0;i<30;i++)record(saved,'agent',event({call:{...event().call,callId:'persist-'+i}}));
  assert.deepEqual(Object.keys(saved),[...keys,'toolContinuity']);
  assert.deepEqual(Object.keys(saved.toolContinuity).sort(),['omittedRecords','records','sequence','version']);
  const serialized=JSON.stringify(saved),reopened=JSON.parse(serialized);
  assert.doesNotMatch(serialized,/acknowledg|identityIndex|seenDeliver/i);
  const recent=event({call:{...event().call,callId:'persist-29'}});
  assert.equal(record(reopened,'agent',recent).changed,false,'Retained records seed the new live object.');
  const evicted=event({call:{...event().call,callId:'persist-0'}});
  assert.equal(record(saved,'agent',evicted).changed,false,'The original live owner remembers an evicted payload identity.');
  assert.equal(record(reopened,'agent',evicted).changed,true,'A deserialized old run cannot reconstruct omitted acknowledgment identities.');
  assert.match(render(reopened,'agent'),/HISTORICAL TOOL OBSERVATIONS/);
  assert.doesNotMatch(render(reopened,'agent'),/acknowledg|identityIndex|seenDeliver/i);
});

test('failed state assignment is retryable and an observer exception cannot undo a committed acknowledgment',()=>{
  const saved=makeRun(),value=event();let stored,failOnce=true;
  Object.defineProperty(saved,'toolContinuity',{enumerable:true,configurable:true,
    get(){return stored;},set(next){if(failOnce){failOnce=false;throw Error('fixture assignment failed');}stored=next;}});
  const failed=record(saved,'agent',value);
  assert.equal(failed.error?.code,'TOOL_CONTINUITY_UNAVAILABLE');
  assert.equal(saved.toolContinuity.records.length,0);
  assert.equal(record(saved,'agent',value).changed,true);
  assert.equal(saved.toolContinuity.sequence,1);
  assert.equal(record(saved,'agent',value).changed,false);

  const committed=makeRun('committed'),history=[],changes=[];append(history,'compatible',0);
  const observer=providerToolDeliveryObserver({tools:[spec],onToolResultDelivered:delivery=>{
    changes.push(record(committed,'agent',delivery));throw Error('later observer failure');
  }},'compatible');
  assert.doesNotThrow(()=>observer.onAccepted(bodyFor(history,'compatible')));
  assert.doesNotThrow(()=>observer.onAccepted(bodyFor(history,'compatible')));
  assert.deepEqual(changes,[{changed:true},{changed:false}]);
  assert.equal(committed.toolContinuity.sequence,1);
});

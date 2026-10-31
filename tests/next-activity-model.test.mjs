import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityStatus,activityEvidenceStatus,activityKey,activityErrorText,activityTimestamp,activityDuration,
  activityListPath,activityDetailPath,activityEventRelevant,
} from '../public/next/workspaces/activity-model.mjs';

test('historical inProgress receipts are neutral and preserve their exact recorded status',()=>{
  const event={type:'item',status:'inProgress',text:'{"stage":"started","item":{"status":"inProgress"}}'};
  const before=structuredClone(event),state=activityEvidenceStatus(event);
  assert.equal(state.label,'In progress at this event');
  assert.equal(state.tone,'neutral');
  assert.match(state.description,/Recorded receipt status: inProgress/);
  assert.match(state.description,/run status is shown separately/);
  assert.deepEqual(event,before,'Formatting must not rewrite the historical receipt.');
});

test('evidence labels keep completed parent lifecycle and tool counts independent',()=>{
  const parent={status:'completed',settled:true,active:false,toolCounts:{completed:23,failed:2,unresolved:2}};
  const before=structuredClone(parent);
  const historical=activityEvidenceStatus({status:'inProgress'});
  assert.equal(historical.label,'In progress at this event');
  assert.equal(activityStatus(parent).label,'Completed');
  assert.equal(activityStatus(parent).tone,'success');
  assert.deepEqual(parent,before);
  assert.equal(activityStatus({status:'inProgress',settled:true}).label,'Unknown: inProgress',
    'A receipt alias must not silently become a supported current-run lifecycle.');
});

test('retained unresolved and recovered tool issues have explicit evidence labels',()=>{
  for(const [status,label,tone] of [['unresolved','Unresolved','attention'],['recovered','Recovered','neutral']]){
    const event={type:'tool.issue',status},before=structuredClone(event),state=activityEvidenceStatus(event);
    assert.equal(state.label,label);assert.equal(state.tone,tone);
    assert.match(state.description,new RegExp('Recorded receipt status: '+status));
    assert.deepEqual(event,before);
  }
});

test('unfamiliar evidence statuses stay unknown even alongside a success field',()=>{
  const state=activityEvidenceStatus({status:'provider_stalled',success:true});
  assert.equal(state.label,'Unknown: provider_stalled');
  assert.notEqual(state.tone,'success');
  assert.match(state.description,/provider_stalled/);
});

test('evidence success fallback requires an actual boolean and never invents missing status',()=>{
  for(const event of [undefined,null,{}, {status:null},{success:'true'}])assert.equal(activityEvidenceStatus(event),null);
  const failed=activityEvidenceStatus({success:false}),succeeded=activityEvidenceStatus({success:true});
  assert.equal(failed.label,'Failed');assert.equal(failed.tone,'attention');
  assert.equal(succeeded.label,'Succeeded');assert.equal(succeeded.tone,'success');
  assert.match(failed.description,/Recorded receipt success: false/);
  assert.match(succeeded.description,/Recorded receipt success: true/);
});

test('inherited property names remain explicit unknown lifecycle and evidence statuses',()=>{
  for(const raw of ['constructor','__proto__','toString','valueOf','hasOwnProperty','isPrototypeOf']){
    let lifecycle,evidence;
    assert.doesNotThrow(()=>{
      lifecycle=activityStatus({status:raw,settled:true});
      evidence=activityEvidenceStatus({status:raw,success:true});
    });
    for(const state of [lifecycle,evidence]){
      assert.equal(state.label,'Unknown: '+raw);
      assert.equal(state.tone,'neutral');
      assert.equal(state.description.includes(raw),true);
    }
  }
});

test('missing and unfamiliar lifecycle data stay unknown rather than successful',()=>{
  for(const item of [{},undefined,{status:''},{status:null},{status:42}]){
    const state=activityStatus(item);
    assert.equal(state.label,'Unknown');assert.notEqual(state.tone,'success');
    assert.match(state.description,/No lifecycle status/);
  }
  const unknown=activityStatus({status:'provider_stalled',settled:true});
  assert.equal(unknown.label,'Unknown: provider_stalled');
  assert.notEqual(unknown.tone,'success');
});

test('running, queueing and stopping are active states with distinct labels',()=>{
  const examples=[
    [{status:'queued',settled:false},'Queued'],
    [{status:'running',settled:false},'Running'],
    [{status:'starting',settled:false},'Starting'],
    [{status:'cancelling',settled:false},'Stopping'],
  ];
  for(const [item,label] of examples){const state=activityStatus(item);assert.equal(state.label,label);assert.equal(state.tone,'active');}
});

test('waiting for input is attention, not a completed or failed action',()=>{
  for(const status of ['waiting','awaiting_input']){
    const state=activityStatus({status,settled:false});
    assert.equal(state.tone,'attention');
    assert.ok(['Waiting','Needs input'].includes(state.label));
    assert.match(state.description,new RegExp(status));
    assert.doesNotMatch(state.label,/Completed|Succeeded|Failed/);
  }
});

test('failed work still stopping retains failure instead of appearing completed',()=>{
  const state=activityStatus({status:'failed',settled:false});
  assert.equal(state.tone,'attention');
  assert.match(state.label,/Failed.*stopping/);
  assert.match(state.description,/Work has not settled/);
});

test('a cancellation request is not a settled cancellation',()=>{
  const pending=activityStatus({status:'cancelled',settled:false});
  const settled=activityStatus({status:'cancelled',settled:true});
  assert.equal(pending.label,'Cancelling');assert.equal(pending.tone,'active');
  assert.equal(settled.label,'Cancelled');assert.equal(settled.tone,'neutral');
  assert.notEqual(pending.label,settled.label);
});

test('interrupted work remains attention both before and after settlement',()=>{
  const pending=activityStatus({status:'interrupted',settled:false});
  const settled=activityStatus({status:'interrupted',settled:true});
  assert.equal(pending.tone,'attention');assert.match(pending.label,/Interrupted.*stopping/);
  assert.equal(settled.label,'Interrupted');assert.equal(settled.tone,'attention');
});

test('reported success cannot become finished success before settlement',()=>{
  for(const status of ['completed','succeeded']){
    const state=activityStatus({status,settled:false});
    assert.equal(state.label,'Finishing');assert.equal(state.tone,'active');
    assert.match(state.description,/Work has not settled/);
    assert.match(state.description,new RegExp(status));
  }
});

test('settled success retains the backend-specific completed or succeeded status',()=>{
  assert.deepEqual(
    ['completed','succeeded'].map(status=>activityStatus({status,settled:true}).label),
    ['Completed','Succeeded'],
  );
  for(const status of ['completed','succeeded'])assert.equal(activityStatus({status,settled:true}).tone,'success');
});

test('contradictory status and settlement are visibly called out',()=>{
  for(const status of ['queued','running','waiting','awaiting_input','cancelling','starting']){
    const state=activityStatus({status,settled:true});
    assert.equal(state.label,'Status conflict');assert.equal(state.tone,'attention');
    assert.match(state.description,/settled/);assert.match(state.description,new RegExp(status));
  }
  assert.equal(activityStatus({status:'completed',settled:true,statusConflict:true}).tone,'attention');
});

test('recorded outcome with missing settlement preserves that uncertainty',()=>{
  const state=activityStatus({status:'completed'});
  assert.equal(state.label,'Completed');
  assert.match(state.description,/Settlement was not recorded/);
  assert.match(activityStatus({status:'RUNNING'}).description,/Settlement was not recorded/);
  assert.equal(activityStatus({status:'RUNNING'}).label,'Running');
});

test('cancelled, skipped, paused, and blocked cannot acquire a success badge',()=>{
  for(const status of ['cancelled','skipped','paused','blocked']){
    const state=activityStatus({status,settled:true});
    assert.notEqual(state.tone,'success',status);
    assert.notEqual(state.label,'Unknown',status);
  }
});

test('run and tool identities remain distinct even when raw IDs collide',()=>{
  assert.notEqual(activityKey({kind:'runs',id:'same'}),activityKey({kind:'tools',id:'same'}));
  assert.equal(activityKey({kind:'runs',id:'same'}),'runs:same');
  assert.equal(activityKey({kind:'tools',id:'same'}),'tools:same');
  assert.equal(activityKey({kind:'runs',id:'exact:/:id'}),'runs:exact:/:id');
});

test('saved error messages remain exact and unknown error shapes do not crash',()=>{
  assert.equal(activityErrorText('Exact failure: error 503'),'Exact failure: error 503');
  assert.equal(activityErrorText({code:'UNAVAILABLE',message:'Exact failure detail'}),'Exact failure detail');
  assert.equal(activityErrorText({code:'UNAVAILABLE'}),'{"code":"UNAVAILABLE"}');
  assert.equal(activityErrorText(null),'');assert.equal(activityErrorText(undefined),'');
  const circular={};circular.self=circular;
  assert.doesNotThrow(()=>activityErrorText(circular));
  assert.equal(typeof activityErrorText(circular),'string');
});

test('invalid or absent timestamps do not fabricate a date',()=>{
  for(const value of [undefined,null,'','nonsense',0,NaN,{},'2026-30-42']){
    assert.equal(activityTimestamp(value),'Time unavailable');
  }
  assert.notEqual(activityTimestamp('2026-10-30T18:00:00Z'),'Time unavailable');
});

test('duration requires actual start and end times for settled records',()=>{
  const start='2026-10-30T18:00:00Z';
  assert.equal(activityDuration({startedAt:start,settled:true,finishedAt:'2026-10-30T18:00:05Z'}),'5s');
  assert.equal(activityDuration({startedAt:start,settled:true,finishedAt:'2026-10-30T18:01:02Z'}),'1m 2s');
  assert.equal(activityDuration({startedAt:start,settled:true,finishedAt:'2026-10-30T19:02:59Z'}),'1h 2m');
  assert.equal(activityDuration({startedAt:start,settled:true}),'');
  assert.equal(activityDuration({finishedAt:start,settled:true}),'');
  assert.equal(activityDuration({startedAt:'invalid',finishedAt:start,settled:true}),'');
});

test('active duration is measured against now without negative or invalid clocks',()=>{
  const start='2026-10-30T18:00:00Z',now=Date.parse(start)+65000;
  assert.equal(activityDuration({startedAt:start,status:'running',active:true,settled:false},now),'1m 5s');
  assert.equal(activityDuration({startedAt:start,status:'failed',settled:false,finishedAt:start},now),'1m 5s');
  assert.equal(activityDuration({startedAt:start,active:true},Date.parse(start)-1),'');
  assert.equal(activityDuration({startedAt:start,active:true},NaN),'');
  assert.equal(activityDuration({startedAt:start,finishedAt:'2026-10-30T17:00:00Z',settled:true}),'');
});

test('list query encoding preserves user text and bounds only the documented search length',()=>{
  const q='Dylan & tools? #receipt=1 / evidence + café';
  const path=activityListPath({source:'all',status:'attention',q,offset:40,limit:40});
  const parsed=new URL(path,'http://fixture');
  assert.equal(parsed.pathname,'/api/activity');
  assert.equal(parsed.searchParams.get('source'),'all');
  assert.equal(parsed.searchParams.get('status'),'attention');
  assert.equal(parsed.searchParams.get('q'),q);
  assert.equal(parsed.searchParams.get('offset'),'40');
  assert.equal(parsed.searchParams.get('limit'),'40');
  assert.equal([...parsed.searchParams].length,5);
  assert.equal(new URL(activityListPath({q:'x'.repeat(500)}),'http://fixture').searchParams.get('q').length,200);
});

test('detail paths keep exact source, ID and evidence pagination separate',()=>{
  const id='run /?#&+% unicode é';
  const path=activityDetailPath({kind:'runs',id},{offset:50,limit:50});
  const parsed=new URL(path,'http://fixture');
  assert.equal(decodeURIComponent(parsed.pathname.split('/').at(-1)),id);
  assert.equal(parsed.pathname.split('/').length,5);
  assert.equal(parsed.searchParams.get('offset'),'50');
  assert.equal(parsed.searchParams.get('limit'),'50');
  assert.equal(activityDetailPath({kind:'tools',id:'receipt'}),'/api/activity/tools/receipt?offset=0&limit=50');
  for(const item of [undefined,null,{}, {kind:'runs'}, {kind:'other',id:'record'}]){
    assert.throws(()=>activityDetailPath(item),/Select a saved activity record/);
  }
});

test('source event filtering avoids refreshing runs for connector-only events and tools for run events',()=>{
  const runEvents=['run.updated','node.updated','agent.event','execution.updated','conversations.updated','conversations.changed','task.updated'];
  for(const type of runEvents){
    assert.equal(activityEventRelevant({type},'runs'),true,type);
    assert.equal(activityEventRelevant({type},'all'),true,type);
    assert.equal(activityEventRelevant({type},'tools'),false,type);
  }
  assert.equal(activityEventRelevant({type:'chatgpt-connector.updated'},'runs'),false);
  assert.equal(activityEventRelevant({type:'chatgpt-connector.updated'},'all'),true);
  assert.equal(activityEventRelevant({type:'chatgpt-connector.updated'},'tools'),true);
  for(const source of ['runs','tools','all'])assert.equal(activityEventRelevant({type:'runtime.status'},source),true);
  for(const event of [undefined,null,{}, {type:42}, {type:'unrelated.event'}]){
    assert.equal(activityEventRelevant(event,'all'),false);
  }
});

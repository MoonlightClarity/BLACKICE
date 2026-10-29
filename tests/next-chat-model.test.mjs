import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesOfRun, replyTarget, windowedRuns, windowedMessages, messageLimitsAfterRefresh, CHAT_MESSAGE_BATCH, filterSummaries, summaries, runText, conversationIndexWindow, CHAT_INDEX_BATCH } from '../public/next/chat/model.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { submitChat } from '../public/next/chat/send.mjs';

const sampleRun=(id,status='completed',events=[])=>({
  id,taskId:'conversation',status,settled:status==='completed',
  createdAt:'2026-10-24T10:00:00Z',input:'A user question',
  workflow:{nodes:[{id:'agent',type:'agent',name:'BLACKICE agent',model:'default'}]},
  nodes:{agent:{status,threadId:'thread-'+id,turnId:status==='running'?'turn-'+id:undefined,output:'**The final answer**'}},
  events,
});
test('conversation reader strips large tool traces but keeps real messages and directions',()=>{
  const events=[
    {nodeId:'agent',at:'2026-10-24T10:00:01Z',data:{type:'delta',itemId:'m1',delta:'Hello'}},
    {nodeId:'agent',at:'2026-10-24T10:00:02Z',data:{type:'message',itemId:'m1',text:'Hello world',phase:'final_answer'}},
    {nodeId:'agent',at:'2026-10-24T10:00:03Z',data:{type:'steer',text:'Also include sources',accepted:true}},
    {nodeId:'agent',at:'2026-10-24T10:00:04Z',data:{type:'tool.result',payload:'secret trace'.repeat(10000)}},
  ];
  const source=sampleRun('x','completed',events);
  source.nodes.agent.output='Hello world';
  const compact=projectFamily({runs:[source],rootId:'conversation'});
  assert.equal(compact.runs.length,1);
  assert.equal(compact.runs[0].events.length,0);
  assert.equal(compact.runs[0].precomputedMessages.length,2);
  assert.deepEqual(compact.runs[0].precomputedMessages.map(item=>item.text),['Hello world','Also include sources']);
  assert.equal(compact.runs[0].nodes.agent.threadId,'thread-x');
  assert.equal(events.length,4,'source history remains unchanged');
  assert.doesNotMatch(JSON.stringify(compact),/secret trace/);
  assert.ok(JSON.stringify(compact).length<10000);
});
test('windowed transcript bounds DOM work independently of number of saved turns',()=>{
  const runs=Array.from({length:3000},(_,i)=>sampleRun('r'+i));
  const view=windowedRuns(runs,12);
  assert.equal(view.hidden,2988);
  assert.equal(view.shown.length,12);
  assert.equal(view.shown[0].id,'r2988');
  assert.equal(view.shown.at(-1).id,'r2999');
});

test('conversation projection preserves opening phases needed to direct the active agent',()=>{
  for(const phase of ['opening','inquiry-opening','inquiry','main-opening']){
    const source=sampleRun('opening','running');
    delete source.nodes.agent.turnId;
    source.nodes.agent.runtimePhase=phase;
    const family=projectFamily({runs:[source],rootId:'conversation'});
    assert.equal(family.runs[0].nodes.agent.runtimePhase,phase);
    const target=replyTarget(family.runs);
    assert.equal(target.active,true);
    assert.equal(target.nodeId,'agent');
    assert.equal(target.run.id,'opening');
  }
});
test('sidebar windows a 20,000-conversation catalog without losing deep selection or search',()=>{
  const catalog=Array.from({length:20000},(_,i)=>({id:'saved-'+i,title:i===19800?'Needle from archived history':'Conversation '+i}));
  assert.equal(CHAT_INDEX_BATCH,80);
  const window=conversationIndexWindow(catalog);
  assert.equal(window.shown.length,80);
  assert.equal(window.hidden,19920);
  assert.equal(window.pinned,null);
  const selected=conversationIndexWindow(catalog,80,'saved-19800');
  assert.equal(selected.pinned.id,'saved-19800','Older active conversations remain accessible without 20,000 DOM buttons');
  assert.equal(selected.shown.length,80);
  const expanded=conversationIndexWindow(catalog,160,'saved-80');
  assert.equal(expanded.pinned,null,'Selection is not duplicated once its batch becomes visible');
  assert.equal(expanded.hidden,19840);
  const results=filterSummaries(catalog,'needle');
  assert.deepEqual(results.map(row=>row.id),['saved-19800'],'Full metadata remains searchable');
  assert.equal(conversationIndexWindow(results).shown.length,1);
  assert.equal(catalog.length,20000,'Rendering never prunes saved metadata');
});
test('a single saved turn exposes recent messages in bounded batches without losing earlier content',()=>{
  const items=Array.from({length:20000},(_,i)=>({id:'message-'+i,nodeId:'agent',role:'assistant',text:'Message '+i}));
  assert.equal(CHAT_MESSAGE_BATCH,80);
  const first=windowedMessages(items);
  assert.equal(first.shown.length,80);
  assert.equal(first.hidden,19920);
  assert.equal(first.shown[0].id,'message-19920');
  assert.equal(first.shown.at(-1).id,'message-19999');
  const next=windowedMessages(items,160);
  assert.equal(next.shown.length,160);
  assert.equal(next.hidden,19840);
  assert.equal(next.shown[0].id,'message-19840');
  assert.equal(windowedMessages(items,20001).hidden,0);
  assert.equal(windowedMessages(items,NaN).shown.length,80);
  assert.equal(windowedMessages([]).shown.length,0);
  assert.equal(items.length,20000,'Hiding old messages never removes saved content.');
});

test('expanded turn keeps revealed messages through repeated worker refreshes while untouched turns stay bounded',()=>{
  const project=count=>projectFamily({runs:[{
    ...sampleRun('growing','running'),nodes:{agent:{status:'running'}},
    events:Array.from({length:count},(_,i)=>({nodeId:'agent',
      data:{type:'message',itemId:'reply-'+i,text:'Response '+i}})),
  }]}).runs;
  const before=project(200),after=project(280),later=project(360);
  const expanded=new Map([['growing',160]]);
  const refreshed=messageLimitsAfterRefresh(before,after,expanded);
  const view=windowedMessages(after[0].precomputedMessages,refreshed.get('growing'));
  assert.equal(refreshed.get('growing'),240);
  assert.equal(view.shown[0].id,'agent:reply-40');
  assert.equal(view.shown.at(-1).id,'agent:reply-279');
  assert.equal(view.hidden,40);
  assert.equal(expanded.get('growing'),160,'Refreshing must not alter the previous viewport state.');
  const again=messageLimitsAfterRefresh(after,later,refreshed);
  assert.equal(again.get('growing'),320);
  assert.equal(windowedMessages(later[0].precomputedMessages,again.get('growing')).shown[0].id,'agent:reply-40');
  const untouched=messageLimitsAfterRefresh(before,after,new Map());
  assert.equal(untouched.size,0,'Only user-expanded turns may grow with new replies.');
  assert.equal(windowedMessages(after[0].precomputedMessages,untouched.get('growing')).shown.length,80);
  assert.equal(windowedMessages(after[0].precomputedMessages,untouched.get('growing')).shown[0].id,'agent:reply-200');
});

test('refresh retains surviving revealed messages without exposing newly recovered older history',()=>{
  const items=Array.from({length:200},(_,i)=>({id:'message-'+i,text:'Response '+i}));
  const before=[{id:'turn',precomputedMessages:items}];
  const older=Array.from({length:20},(_,i)=>({id:'recovered-'+i,text:'Recovered response '+i}));
  const appended=Array.from({length:80},(_,i)=>({id:'new-'+i,text:'New response '+i}));
  const current=[...older,...items.filter(item=>item.id!=='message-40'),...appended];
  const after=[{id:'turn',precomputedMessages:current}];
  const limits=messageLimitsAfterRefresh(before,after,new Map([['turn',160]]));
  const view=windowedMessages(current,limits.get('turn'));
  assert.equal(view.shown[0].id,'message-41','Use the earliest surviving revealed message if the old boundary is removed.');
  assert.equal(view.shown.at(-1).id,'new-79');
  assert.equal(view.hidden,60,'Newly recovered older history still requires an explicit expansion.');
  assert.deepEqual(view.shown.slice(0,159).map(item=>item.id),items.slice(41).map(item=>item.id));
});

test('missing, empty and replaced transcripts discard stale expansion limits',()=>{
  const items=Array.from({length:200},(_,i)=>({id:'message-'+i,text:'Response '+i}));
  const before=[{id:'turn',precomputedMessages:items}];
  const limits=new Map([['turn',160]]);
  assert.equal(messageLimitsAfterRefresh(before,[],limits).size,0);
  assert.equal(messageLimitsAfterRefresh(before,[{id:'turn',precomputedMessages:[]}],limits).size,0);
  const replacement=items.map(item=>({...item,id:'replacement-'+item.id}));
  const changed=messageLimitsAfterRefresh(before,[{id:'turn',precomputedMessages:replacement}],limits);
  assert.equal(changed.size,0);
  assert.equal(windowedMessages(replacement,changed.get('turn')).shown.length,80);
  assert.equal(replacement.length,200,'Resetting the viewport must preserve the transcript.');
});

test('multi-agent saved output indexing preserves message order without scanning all messages per agent',()=>{
  const count=2400;
  const run={id:'many-agents',workflow:{nodes:Array.from({length:count},(_,i)=>({id:'agent-'+i,type:'agent'}))},
    nodes:Object.fromEntries(Array.from({length:count},(_,i)=>['agent-'+i,{status:'completed',output:'Answer '+i}])),
    events:Array.from({length:count},(_,i)=>({nodeId:'agent-'+i,
      data:{type:'message',itemId:'m-'+i,text:'Answer '+i}}))};
  const started=performance.now();
  const messages=messagesOfRun(run);
  const duration=performance.now()-started;
  assert.equal(messages.length,count,'Saved output already present in messages must not be duplicated.');
  assert.deepEqual(messages.map(m=>m.text),Array.from({length:count},(_,i)=>'Answer '+i));
  assert.equal(messages[0].nodeId,'agent-0');
  assert.equal(messages.at(-1).nodeId,'agent-2399');
  assert.equal(run.events.length,count,'Source receipts must remain untouched.');
  assert.ok(duration<1200,'Large workflow history projection should avoid quadratic message scanning.');
});

test('per-agent output deduplication keeps directions, combined fragments, and unmatched final outputs',()=>{
  const run={
    id:'mixed',
    workflow:{nodes:[{id:'a',type:'agent'},{id:'b',type:'agent'},{id:'c',type:'agent'}]},
    nodes:{a:{status:'completed',output:'Alpha Beta'},b:{status:'completed',output:'Final B'},
      c:{status:'completed',output:'Hidden',reused:true}},
    events:[
      {nodeId:'a',data:{type:'message',itemId:'one',text:'Alpha '}},
      {nodeId:'a',data:{type:'message',itemId:'two',text:'Beta'}},
      {nodeId:'b',data:{type:'message',itemId:'three',text:'Different'}},
      {nodeId:'a',at:'2026-10-25T11:20:00Z',data:{type:'steer',accepted:true,text:'Verify sources'}},
    ],
  };
  const messages=messagesOfRun(run);
  assert.deepEqual(messages.map(m=>m.text),['Alpha ','Beta','Different','Verify sources','Final B']);
  assert.deepEqual(messages.map(m=>m.role),['assistant','assistant','assistant','user','assistant']);
  assert.equal(messages.some(m=>m.text==='Hidden'),false);
  assert.equal(messages.filter(m=>m.nodeId==='a'&&m.role==='assistant').length,2);
});

test('conversation summaries preserve order, archive filters and user content',()=>{
  const list=summaries([{id:'a',title:'A project',updatedAt:'2026-10-20Z'}, {id:'b',title:'Another',updatedAt:'2026-10-22T00:00:00Z'}]);
  assert.equal(list[0].id,'b');
  assert.deepEqual(filterSummaries(list,'project').map(x=>x.id),['a']);
  assert.equal(runText({input:{task:'Hi there'}}),'Hi there');
});
test('a new message starts exactly one workflow and one run through unchanged backend routes',async()=>{
  const calls=[];
  const api=async(path,method,body)=>{
    calls.push({path,method,body});
    if(path==='/api/workflows')return body;
    if(path==='/api/runs')return {id:'new-run',status:'queued'};
    throw Error('Unexpected API');
  };
  const result=await submitChat({api,runs:[],task:'Inspect this project',model:'default',planningMode:'auto',cwd:'C:\\fixture'});
  assert.equal(result.mode,'started');
  assert.deepEqual(calls.map(call=>call.path),['/api/workflows','/api/runs']);
  assert.equal(calls[0].body.nodes.find(node=>node.id==='agent').sandbox,'danger-full-access');
  assert.equal(calls[1].body.input.task,'Inspect this project');
  assert.equal(calls[1].body.requestId,result.requestId);
  assert.equal(calls[1].body.workflow.name,'Inspect this project');
});
test('active agent receives direct direction and is never implicitly restarted',async()=>{
  const run=sampleRun('r','running');
  const calls=[];const api=async(path,method,body)=>{calls.push({path,method,body});return{accepted:true,delivery:'queued'};};
  const result=await submitChat({api,runs:[run],task:'Use the latest evidence',cwd:'C:\\fixture'});
  assert.equal(result.mode,'direction');
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/api/runs/r/steer');
  assert.equal(calls[0].body.nodeId,'agent');
  assert.equal(calls[0].body.message,'Use the latest evidence');
});
test('settled agent continues through its owned thread rather than starting another workflow',async()=>{
  const run=sampleRun('first');
  const api=async(path,method,body)=>{
    assert.equal(path,'/api/runs/first/continue');
    assert.equal(body.nodeId,'agent');assert.equal(body.message,'Follow up');
    assert.ok(body.requestId);
    return{id:'second',taskId:'conversation',status:'running'};
  };
  const result=await submitChat({api,runs:[run],task:'Follow up',cwd:'C:\\fixture'});
  assert.equal(result.mode,'continued');assert.equal(result.run.id,'second');
});


test('file attachments remain associated with the exact submitted task and continuation',async()=>{
  const attachmentIds=['file_fixture_1','file_fixture_2'];
  const calls=[];
  const api=async(path,method,body)=>{
    calls.push({path,method,body});
    if(path==='/api/workflows')return body;
    if(path==='/api/runs')return{id:'file-task',status:'running'};
    return{id:'next-file-run',status:'running'};
  };
  const newTask=await submitChat({api,runs:[],task:'Read attached files',cwd:'C:\\fixture',attachmentIds});
  assert.equal(newTask.mode,'started');
  assert.deepEqual(calls.find(x=>x.path==='/api/runs').body.input.attachmentIds,attachmentIds);
  calls.length=0;
  const previous=sampleRun('file-parent');
  const next=await submitChat({api,runs:[previous],task:'Compare the new file',attachmentIds});
  assert.equal(next.mode,'continued');
  assert.deepEqual(calls[0].body.attachmentIds,attachmentIds);
  assert.equal(calls[0].path,'/api/runs/file-parent/continue');
});
test('live direction cannot silently drop an attached file',async()=>{
  let called=false;
  const api=async()=>{called=true;};
  await assert.rejects(submitChat({api,runs:[sampleRun('active','running')],task:'Review the file',attachmentIds:['file_fixture_1']}),/Files cannot be added to live direction/);
  assert.equal(called,false);
});

test('backend mutation failures are surfaced, never retried',async()=>{
  let count=0;
  const api=async()=>{count++;throw Error('Uncertain delivery');};
  await assert.rejects(submitChat({api,runs:[sampleRun('r','running')],task:'Stop and inspect'}),/Uncertain delivery/);
  assert.equal(count,1);
});

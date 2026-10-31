import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityService, projectActivityItem, activityOptions } from '../lib/activity.mjs';

const when='2026-10-31T02:00:00.000Z';
const directId='direct_'+'a'.repeat(64);
const run=(overrides={})=>({id:'run-one',taskId:'task-one',input:'Inspect useful work',status:'completed',settled:true,createdAt:when,updatedAt:when,
  nodes:{agent:{status:'completed',output:'Recorded answer'}},workflow:{nodes:[{id:'agent',name:'Agent',type:'agent'}]},events:[],...overrides});
const archive=(entries=[])=>({entries:new Map(entries.map(item=>[item.id,item])),states:{},status:()=>({healthy:true})});

test('catalog uses metadata and live maps without hydrating traces or saved payloads',async()=>{
  const entry={id:'archived-one',title:'Saved previous turn',status:'completed',settled:true,createdAt:when};
  const live=run({title:'Live inspection',status:'running',settled:false});
  Object.defineProperty(live,'events',{get(){throw Error('The catalog read a full trace.');}});
  Object.defineProperty(live.nodes.agent,'output',{get(){throw Error('The catalog read model output.');}});
  const conversations=archive([entry]);conversations.get=()=>assert.fail('Catalog must not hydrate a run');
  const engine={runs:new Map([[live.id,live]]),listRuns:()=>assert.fail('Catalog must not snapshot full runs')};
  const service=createActivityService({conversations,engine,directExecution:{jobs:{get:()=>assert.fail('Catalog must not hydrate a tool')}}});
  const result=await service.list();
  assert.equal(result.total,2);assert.equal(result.items[0].id,live.id);
  assert.equal(result.items[0].active,true);assert.equal(result.counts.active,1);
  assert.equal(result.items[1].toolCounts,null);
  assert.equal(JSON.stringify(result).includes('Recorded answer'),false);
});

test('lifecycle preserves raw terminal states while execution still settles',()=>{
  for (const status of ['completed','failed','cancelled']) {
    const item=projectActivityItem('runs',run({status,settled:false}));
    assert.equal(item.status,status);assert.equal(item.active,true);assert.equal(item.finished,false);
  }
  const failed=projectActivityItem('runs',run({status:'failed',settled:true}));
  assert.equal(failed.active,false);assert.equal(failed.finished,true);assert.equal(failed.attention,true);
  const conflict=projectActivityItem('runs',run({status:'running',settled:true}));
  assert.equal(conflict.status,'running');assert.equal(conflict.statusConflict,true);assert.equal(conflict.active,false);assert.equal(conflict.attention,true);
  const unknown=projectActivityItem('runs',run({status:'future-state',settled:true}));
  assert.equal(unknown.status,'future-state');assert.equal(unknown.active,false);assert.equal(unknown.finished,false);assert.equal(unknown.attention,true);
});

test('direct actions keep cancelling, awaiting input and uncertain effects distinct',()=>{
  const base={id:directId,tool:'blackice_run_command',requestId:'request-one',effects:{possible:true,confirmed:false},createdAt:when};
  const cancelling=projectActivityItem('tools',{...base,status:'cancelling'});
  assert.equal(cancelling.status,'cancelling');assert.equal(cancelling.active,true);assert.equal(cancelling.settled,false);
  const cancelled=projectActivityItem('tools',{...base,status:'cancelled'});
  assert.equal(cancelled.active,false);assert.equal(cancelled.finished,true);assert.equal(cancelled.attention,true);
  const waiting=projectActivityItem('tools',{...base,status:'awaiting_input',interaction:{kind:'file_chooser',id:'input-one',message:'Choose the observed file'}});
  assert.equal(waiting.active,true);assert.equal(waiting.attention,true);assert.equal(waiting.interaction.kind,'file_chooser');
  assert.deepEqual(cancelled.effects,{possible:true,confirmed:false});
});

test('search, filters, source facets and pages use one bounded matching snapshot',async()=>{
  const entries=Array.from({length:121},(_,index)=>({id:'run-'+index,title:'Alpha '+index,status:index%2?'failed':'completed',settled:true,createdAt:when,updatedAt:when}));
  const service=createActivityService({conversations:archive(entries),engine:{runs:new Map()},directExecution:{jobs:{snapshot:async()=>[
    {id:directId,status:'running',tool:'blackice_run_command',requestId:'Alpha-command',createdAt:when},
  ]}}});
  const page=await service.list({source:'all',status:'attention',q:'alpha',offset:40,limit:20});
  assert.equal(page.total,60);assert.equal(page.items.length,20);assert.equal(page.nextOffset,null);
  assert.deepEqual(page.counts,{all:122,active:1,attention:60,finished:121});
  assert.equal(page.items.every(item=>item.kind==='runs'&&item.status==='failed'),true);
  const tools=await service.list({source:'tools',q:'ALPHA-COMMAND',limit:1});
  assert.equal(tools.total,1);assert.equal(tools.items[0].requestId,'Alpha-command');
});

test('live run status wins over stale archived metadata and renamed family title is retained',async()=>{
  const old=run({title:'Old title',status:'running',settled:false});
  const conversations=archive([old]);conversations.states['task-one']={state:'archived',title:'Renamed work'};
  const current=run({status:'failed',settled:true,error:'Command stopped'});
  const result=await createActivityService({conversations,engine:{runs:new Map([[current.id,current]])}}).list();
  assert.equal(result.total,1);assert.equal(result.items[0].status,'failed');assert.equal(result.items[0].title,'Renamed work');
  assert.equal(result.items[0].conversationState,'archived');assert.equal(result.items[0].error.message,'Command stopped');
});

test('unknown tool counts stay unknown and unresolved issues flag otherwise completed runs',()=>{
  assert.equal(projectActivityItem('runs',{id:'old',status:'completed',settled:true}).toolCounts,null);
  const item=projectActivityItem('runs',run({nodes:{agent:{status:'completed',toolSummary:{completed:2,failed:3,omittedUnresolved:1,issues:[{resolved:false},{resolved:true}]}}}}));
  assert.deepEqual(item.toolCounts,{completed:2,failed:3,unresolved:2,omittedUnresolved:1});
  assert.equal(item.status,'completed');assert.equal(item.attention,true);
});

test('a failed source preserves the other source and explicitly reports partial data',async()=>{
  const service=createActivityService({conversations:archive([{id:'available',title:'Available',status:'completed',settled:true}]),
    directExecution:{jobs:{snapshot:async()=>{throw Error('Ledger unavailable');}}}});
  const result=await service.list({source:'all'});
  assert.equal(result.total,1);assert.equal(result.partial,true);
  assert.equal(result.sources.runs.available,true);assert.equal(result.sources.tools.available,false);
  assert.equal(result.sources.tools.error,'Ledger unavailable');
  const onlyFailed=await service.list({source:'tools'});
  assert.equal(onlyFailed.total,0);assert.equal(onlyFailed.partial,true);
  assert.equal(onlyFailed.sources.tools.available,false);
});

test('archive health is reported without inventing empty successful history',async()=>{
  const conversations=archive([{id:'saved',title:'Saved',status:'completed',settled:true}]);
  conversations.status=()=>({healthy:false,error:'Archive read failed'});
  const result=await createActivityService({conversations}).list();
  assert.equal(result.items.length,1);assert.equal(result.partial,true);
  assert.equal(result.sources.runs.warning,'Archive read failed');
});

test('run detail shows real tool/error receipts, omits deltas, and pages retained evidence',async()=>{
  const full=run({input:'x'.repeat(16000),events:[
    {type:'agent.event',nodeId:'agent',at:when,data:{type:'delta',delta:'private transient output'}},
    {type:'agent.event',nodeId:'agent',at:when,data:{type:'tool.result',tool:'relay_workspace',action:'read',success:false,status:'failed',message:'File missing',code:'ENOENT'}},
    {type:'agent.event',nodeId:'agent',at:when,data:{type:'item',stage:'completed',item:{type:'commandExecution',status:'completed',command:'inspect',aggregatedOutput:'actual stdout'}}},
  ]});
  let reads=0;const conversations=archive();conversations.get=async id=>{assert.equal(id,full.id);reads++;return full;};
  const service=createActivityService({conversations});
  const detail=await service.detail('runs',full.id,{offset:0,limit:1});
  assert.equal(reads,1);assert.equal(detail.input.truncated,true);assert.equal(detail.input.totalCharacters,16000);
  assert.equal(detail.evidence.total,2);assert.equal(detail.evidence.omittedEvents,1);assert.equal(detail.evidence.nextOffset,1);
  assert.equal(detail.evidence.items[0].text.includes('actual stdout'),true);
  const page=await service.detail('runs',full.id,{offset:1,limit:1});
  assert.equal(page.evidence.items[0].success,false);assert.equal(page.evidence.items[0].nodeId,'agent');
  assert.equal(page.evidence.items[0].text.includes('ENOENT'),true);
  assert.match(detail.notice,/Older saved conversations/);
  assert.equal(JSON.stringify(detail).includes('private transient output'),false);
});

test('direct detail chunks long original receipts without losing their text',async()=>{
  const text='result-'.repeat(6000);
  const record={id:directId,tool:'blackice_run_command',requestId:'evidence',arguments:{command:'inspect existing data'},status:'failed',createdAt:when,
    effects:{possible:true,confirmed:false},result:{success:false,contentItems:[{type:'inputText',text}]}};
  let reads=0;const service=createActivityService({directExecution:{jobs:{get:async id=>{assert.equal(id,directId);reads++;return record;}}}});
  const first=await service.detail('tools',directId,{offset:0,limit:2});
  assert.equal(first.output.truncated,true);assert.equal(first.output.totalCharacters,text.length);
  assert.equal(first.evidence.total,4);assert.equal(first.evidence.nextOffset,2);
  const last=await service.detail('tools',directId,{offset:2,limit:2});
  assert.equal([...first.evidence.items,...last.evidence.items].map(item=>item.text).join(''),text);
  assert.equal(first.item.status,'failed');assert.equal(first.evidence.items[0].success,false);assert.equal(reads,2);
});

test('empty or malformed detail responses are errors rather than successful blank views',async()=>{
  const missingService=createActivityService({conversations:{get:async()=>null}});
  await assert.rejects(()=>missingService.detail('runs','run-one'),error=>error.status===404);
  const malformed=createActivityService({conversations:{get:async()=>({id:'run-one'})}});
  await assert.rejects(()=>malformed.detail('runs','run-one'),/incomplete or unreadable/);
  await assert.rejects(()=>malformed.detail('runs','../x'),error=>error.status===400);
  await assert.rejects(()=>malformed.detail('tools',directId,{limit:101}),error=>error.status===400);
  assert.throws(()=>activityOptions({limit:1000}),error=>error.status===400);
  assert.throws(()=>activityOptions({status:'succeeded'}),error=>error.status===400);
});

test('ten thousand records return bounded pages with no evidence payload copies',async()=>{
  const entries=Array.from({length:10000},(_,index)=>({id:'run-'+index,title:'Saved run '+index,status:'completed',settled:true,createdAt:when}));
  const result=await createActivityService({conversations:archive(entries)}).list({limit:40});
  assert.equal(result.total,10000);assert.equal(result.items.length,40);assert.equal(result.nextOffset,40);
  assert.equal(JSON.stringify(result).length<50000,true);
});

test('off-page evidence is not serialized when inspecting a long run',async()=>{
  const old={type:'tool.result',tool:'relay_workspace',success:true,toJSON(){throw Error('Off-page receipt was serialized');}};
  const newest={type:'tool.result',tool:'relay_workspace',success:false,message:'Most recent failure'};
  const full=run({events:[{type:'agent.event',data:old},{type:'agent.event',data:newest}]});
  const detail=await createActivityService({conversations:{get:async()=>full}}).detail('runs',full.id,{limit:1});
  assert.equal(detail.evidence.total,2);assert.equal(detail.evidence.items[0].text.includes('Most recent failure'),true);
});
test('malformed direct detail cannot look like a successful empty receipt',async()=>{
  const service=createActivityService({directExecution:{jobs:{get:async()=>({id:directId,tool:'tool',status:'succeeded',arguments:{},result:{}})}}});
  await assert.rejects(()=>service.detail('tools',directId),/incomplete or unreadable/);
});

test('legacy continuation roots are resolved once and catalog health avoids full family grouping',async()=>{
  const entries=Array.from({length:5000},(_,index)=>({id:'chain-'+index,parentRunId:index?'chain-'+(index-1):null,
    title:index?'Turn '+index:'Legacy root title',status:'completed',settled:true,createdAt:when})).reverse();
  const conversations=archive(entries);
  Object.assign(conversations,{error:null,stateError:null,stateWriteError:null,writeFailures:new Set(),
    rootIdFor(){assert.fail('Activity must memoize roots without calling the quadratic archive helper');},
    status(){assert.fail('Health inspection must not group all families again');}});
  const result=await createActivityService({conversations}).list({limit:40});
  assert.equal(result.total,5000);assert.equal(result.partial,false);
  assert.equal(result.items.every(item=>item.taskId==='chain-0'&&item.title==='Legacy root title'),true);
  conversations.writeFailures.add('chain-1');
  const unhealthy=await createActivityService({conversations}).list({limit:1});
  assert.equal(unhealthy.items.length,1);assert.equal(unhealthy.partial,true);
  assert.match(unhealthy.sources.runs.warning,/could not be saved/);
});

test('retained issue summaries remain inspectable after raw tool traces have expired',async()=>{
  const full=run({events:[],nodes:{agent:{status:'completed',toolSummary:{completed:4,failed:3,omittedUnresolved:2,
    issues:[{tool:'relay_workspace',action:'read',key:'read:one',code:'ENOENT',message:'Earlier missing file receipt',resolved:false}]}}}});
  const detail=await createActivityService({conversations:{get:async()=>full}}).detail('runs',full.id);
  assert.equal(detail.item.attention,true);assert.equal(detail.item.toolCounts.unresolved,3);
  assert.equal(detail.evidence.total,1,'Missing older receipts are not fabricated from their count.');
  assert.equal(detail.evidence.retainedSummaryRows,1);assert.equal(detail.evidence.items[0].type,'tool.issue');
  assert.equal(detail.evidence.items[0].nodeId,'agent');assert.equal(detail.evidence.items[0].status,'unresolved');
  const raw=JSON.parse(detail.evidence.items[0].text);
  assert.equal(raw.source,'node.toolSummary.issues');assert.equal(raw.message,'Earlier missing file receipt');
});

test('identical retained failure summaries do not duplicate raw receipt rows but recorded recovery remains visible',async()=>{
  const failure={tool:'relay_workspace',action:'read',code:'ENOENT',message:'File missing'};
  const full=run({events:[{type:'agent.event',nodeId:'agent',data:{type:'tool.result',success:false,...failure}}],
    nodes:{agent:{status:'completed',toolSummary:{failed:2,completed:1,issues:[{...failure,resolved:false},{...failure,resolved:true}]}}}});
  const detail=await createActivityService({conversations:{get:async()=>full}}).detail('runs',full.id);
  assert.equal(detail.evidence.total,2);assert.equal(detail.evidence.retainedSummaryRows,1);
  assert.equal(detail.evidence.items[0].type,'tool.result');assert.equal(detail.evidence.items[1].status,'recovered');
});

import test from 'node:test';import assert from 'node:assert/strict';import {TaskActionDirectory} from '../lib/task-action-directory.mjs';
const create=options=>new TaskActionDirectory({taskId:'task',objective:'Find three suitable jobs',...options});
const plan=async ledger=>ledger.edit({action:'plan',revision:ledger.read().revision,actions:[{id:'find',objective:'Find candidate jobs',dependsOn:[]},{id:'check',objective:'Check candidate requirements',dependsOn:['find']}]});
const focus=async(ledger,id='find')=>ledger.edit({action:'focus',revision:ledger.read().revision,id});
test('focus and dependent progress require real host return, not final prose',async()=>{const ledger=create();let calls=0;await assert.rejects(ledger.execute({name:'relay_browser'},async()=>{calls++;},{runId:'run',nodeId:'agent'}),{code:'DIRECTORY_FOCUS',message:/This tool call did not run.*Focus that step/});assert.equal(calls,0);await plan(ledger);await assert.rejects(focus(ledger,'check'),{code:'DIRECTORY_NOT_READY'});await focus(ledger);await assert.rejects(ledger.edit({action:'observe',revision:ledger.read().revision,id:'find',claim:'Finished',receipts:['invented']}),{code:'DIRECTORY_EVIDENCE'});const result=await ledger.execute({name:'relay_browser'},async()=>({success:true}),{runId:'run',nodeId:'agent'});assert.equal(ledger.finalStatus().ready,false);await ledger.edit({action:'observe',revision:ledger.read().revision,id:'find',claim:'Search returned candidates, not yet verified',receipts:[result.receiptId]});assert.deepEqual(ledger.read().ready,['check']);assert.equal(ledger.read().actions[0].observation.authority,'agent');await focus(ledger,'check');});
test('persisted unknown survives restart and blocks replay; foreign task fails closed',async()=>{let saved;const ledger=create({persist:async state=>{saved=state;}});await plan(ledger);await focus(ledger);await assert.rejects(ledger.execute({name:'relay_browser'},async()=>{throw Object.assign(Error('transport'),{code:'LOST'});},{runId:'run',nodeId:'agent'}));assert.equal(saved.receipts[0].state,'unknown');const restarted=create({snapshot:saved});let calls=0;await assert.rejects(restarted.execute({name:'relay_browser'},async()=>{calls++;},{runId:'next',nodeId:'agent'}),{code:'DIRECTORY_UNKNOWN'});assert.equal(calls,0);assert.throws(()=>new TaskActionDirectory({taskId:'other',objective:'Other',snapshot:saved}),{code:'DIRECTORY_SCOPE'});});
test('CAS, cycle and persistence rejection cause no mutation or work',async()=>{const ledger=create();await plan(ledger);const before=ledger.read();await assert.rejects(ledger.edit({action:'focus',revision:0,id:'find'}),{code:'DIRECTORY_CHANGED'});assert.deepEqual(ledger.read(),before);await assert.rejects(ledger.edit({action:'plan',revision:before.revision,actions:[{id:'a',objective:'A',dependsOn:['b']},{id:'b',objective:'B',dependsOn:['a']}]}),{code:'DIRECTORY_CYCLE'});await focus(ledger);ledger.persist=async()=>{throw Error('disk');};let calls=0;await assert.rejects(ledger.execute({name:'relay_browser'},async()=>{calls++;},{runId:'run',nodeId:'agent'}),/disk/);assert.equal(calls,0);assert.equal(ledger.read().receipts.length,0);});
test('cancelled dispatch is not issued; concurrent dispatch does not bypass pending evidence',async()=>{const ledger=create();await plan(ledger);await focus(ledger);const controller=new AbortController();controller.abort();let calls=0;await assert.rejects(ledger.execute({name:'relay_browser'},async()=>{calls++;},{runId:'run',nodeId:'agent',signal:controller.signal}));assert.equal(calls,0);let resolve;const work=ledger.execute({name:'relay_browser'},()=>new Promise(r=>{resolve=r;}),{runId:'run',nodeId:'agent'});while(!resolve)await new Promise(r=>setTimeout(r,1));await assert.rejects(ledger.execute({name:'relay_browser'},async()=>{calls++;},{runId:'run',nodeId:'agent'}),{code:'DIRECTORY_UNKNOWN'});resolve({success:true});await work;assert.equal(calls,0);});
test('replanning preserves attempted scope and direct host receipts contain no payload',async()=>{const ledger=create();await plan(ledger);await focus(ledger);await ledger.execute({name:'relay_browser',arguments:{password:'secret'}},async()=>({success:false,contentItems:[{text:'private'}]}),{runId:'run',nodeId:'agent'});await assert.rejects(ledger.edit({action:'plan',revision:ledger.read().revision,actions:[{id:'find',objective:'Pretend finished',dependsOn:[]}]}),{code:'DIRECTORY_RECORDED_ACTION'});assert.doesNotMatch(JSON.stringify(ledger.read()),/secret|private/);assert.equal(ledger.read().receipts[0].success,false);});
test('unknown permits host-classified observation, not model-authorized replay, and independent blocked work can proceed',async()=>{const ledger=create({admitRecovery:call=>call.name==='relay_observe'});await plan(ledger);await focus(ledger);await assert.rejects(ledger.execute({name:'relay_browser'},async()=>{throw Error('lost');},{runId:'run',nodeId:'agent'}));const unknown=ledger.read().receipts[0].id;await assert.rejects(ledger.execute({name:'relay_browser'},async()=>({success:true}),{runId:'run',nodeId:'agent',recoveryFor:unknown}),{code:'DIRECTORY_UNKNOWN'});const observation=await ledger.execute({name:'relay_observe'},async()=>({success:true}),{runId:'run',nodeId:'agent',recoveryFor:unknown});assert.equal(observation.directory.receipts[0].state,'unknown');await ledger.edit({action:'block',revision:ledger.read().revision,id:'find',claim:'Effect remains uncertain; do not repeat.'});await ledger.edit({action:'plan',revision:ledger.read().revision,actions:[{id:'find',objective:'Find candidate jobs',dependsOn:[]},{id:'check',objective:'Check candidate requirements',dependsOn:['find']},{id:'other',objective:'Inspect independent source',dependsOn:[],reason:'Original effect uncertain',sourceRefs:[unknown]}]});await focus(ledger,'other');await ledger.execute({name:'relay_observe'},async()=>({success:true}),{runId:'run',nodeId:'agent'});assert.equal(ledger.finalStatus().ready,false);});
test('human steering during host work preserves the dispatched receipt and prevents stale observation',async()=>{const ledger=create();await plan(ledger);await focus(ledger);let finish;const work=ledger.execute({name:'relay_browser'},()=>new Promise(r=>{finish=r;}),{runId:'run',nodeId:'agent'});while(!finish)await new Promise(r=>setTimeout(r,1));const stale=ledger.read().revision;await ledger.edit({action:'block',revision:stale,id:'find',claim:'User redirected this action.'},{authority:'human'});finish({success:true});await work;await assert.rejects(ledger.edit({action:'observe',revision:stale,id:'find',claim:'Done',receipts:['receipt-1']}),{code:'DIRECTORY_CHANGED'});assert.equal(ledger.read().actions[0].state,'blocked');assert.equal(ledger.read().actions[0].observation.authority,'human');assert.equal(ledger.read().receipts[0].state,'returned');});

test('a blocked prerequisite settles transitive dead paths without completing them or skipping an independent path', async()=>{
 const ledger=create();
 const actions=[{id:'first',objective:'Primary route',dependsOn:[]},{id:'second',objective:'Downstream action',dependsOn:['first']},{id:'third',objective:'Transitive child',dependsOn:['second']},{id:'independent',objective:'Try alternative',dependsOn:[]}];
 await ledger.edit({action:'plan',revision:0,actions});
 await ledger.edit({action:'block',id:'first',claim:'Primary route unavailable',revision:1});
 const state=ledger.read();
 assert.deepEqual(state.dependencyBlocked,[{id:'second',blockedBy:['first']},{id:'third',blockedBy:['first']}]);
 assert.deepEqual(state.ready,['independent']);
 assert.deepEqual(ledger.finalStatus().pending,['independent']);
 assert.equal(ledger.finalStatus().ready,false);
 await assert.rejects(ledger.edit({action:'focus',id:'second',revision:state.revision}),{code:'DIRECTORY_NOT_READY'});
 await ledger.edit({action:'focus',id:'independent',revision:state.revision});
 const result=await ledger.execute({name:'relay_find_files'},async()=>({success:true}),{runId:'run',nodeId:'agent'});
 await ledger.edit({action:'observe',id:'independent',claim:'Alternative inspected',receipts:[result.receiptId],revision:ledger.read().revision});
 const done=ledger.finalStatus();
 assert.equal(done.ready,true);assert.equal(done.reason,'blocked-paths');assert.deepEqual(done.pending,[]);
 assert.deepEqual(done.blocked,['first']);
 assert.equal(ledger.read().actions.find(a=>a.id==='second').state,'pending');
 assert.equal(ledger.read().actions.find(a=>a.id==='third').observation,undefined);
});

test('blocked dependencies do not erase unknown effects or survive an authorized replan of a pending path',async()=>{
 const ledger=create();
 await plan(ledger);await focus(ledger);
 await assert.rejects(ledger.execute({name:'relay_browser'},async()=>{throw Error('transport lost');},{runId:'run',nodeId:'agent'}));
 await ledger.edit({action:'block',id:'find',claim:'Effect not known',revision:ledger.read().revision});
 assert.equal(ledger.finalStatus().reason,'unknown-effects');
 assert.deepEqual(ledger.finalStatus().dependencyBlocked,[{id:'check',blockedBy:['find']}]);
 const actions=ledger.read().actions.map(a=>({id:a.id,objective:a.objective,dependsOn:[]}));
 await ledger.edit({action:'plan',actions,revision:ledger.read().revision});
 assert.deepEqual(ledger.read().dependencyBlocked,[]);
 assert.deepEqual(ledger.read().ready,['check']);
 assert.equal(ledger.finalStatus().ready,false);
});

test('successful same-turn unassigned reads can be explicitly linked once without rewriting admission attribution',async()=>{
 const ledger=create();const first={runId:'turn',nodeId:'agent',observationOnly:true};
 await ledger.edit({action:'plan',revision:0,actions:[{id:'read',objective:'Find input',dependsOn:[]},{id:'next',objective:'Use input',dependsOn:['read']}]});
 const read=async(options=first,success=true)=>ledger.execute({name:'relay_find_files'},async()=>({success}),options);
 const oldTurn=await read({...first,runId:'other'});
 const oldNode=await read({...first,nodeId:'other'});
 const failed=await read(first,false);
 const stale=await read({...first,expectedActionRevision:0});
 const returned=await read();
 assert.equal(returned.canLinkRead,true); assert.equal(stale.canLinkRead,false);assert.equal(failed.canLinkRead,false);
 await ledger.edit({action:'focus',id:'read',revision:ledger.read().revision});
 const observe=(id,receipts)=>ledger.edit({action:'observe',id,revision:ledger.read().revision,claim:'Observed input',receipts},first);
 for(const invalid of [oldTurn,oldNode,failed,stale])await assert.rejects(observe('read',[returned.receiptId,invalid.receiptId]),{code:'DIRECTORY_EVIDENCE'});
 assert.equal(ledger.read().receipts.at(-1).linkedByActionId,undefined);
 await observe('read',[returned.receiptId]);
 const state=ledger.read();
 const saved=state.receipts.find(r=>r.id===returned.receiptId);
 assert.equal(saved.actionId,null);assert.equal(saved.linkedByActionId,'read');
 const reloaded=create({snapshot:state});assert.equal(reloaded.read().receipts.at(-1).linkedByActionId,'read');
 await ledger.edit({action:'focus',id:'next',revision:ledger.read().revision});
 await assert.rejects(observe('next',[returned.receiptId]),{code:'DIRECTORY_EVIDENCE',message:/Current focus: next.*receipt-5: already used by another action.*eligible receipt IDs: none/});
 assert.equal(ledger.read().actions[1].state,'active');

});

test('wrong-action and absent receipt diagnostics preserve focus and allow immediate same-source recovery',async()=>{
 const ledger=create();const context={runId:'run',nodeId:'agent',observationOnly:true};
 await ledger.edit({action:'plan',revision:0,actions:[{id:'first',objective:'Check first source',dependsOn:[]},{id:'next',objective:'Use second source',dependsOn:['first']}]});
 const edit=(action,id,data={})=>ledger.edit({action,id,revision:ledger.read().revision,...data},context);
 let calls=0;
 const read=()=>ledger.execute({name:'relay_workspace'},async()=>{calls++;return{success:true};},context);
 await edit('focus','first');
 const first=await read();
 await edit('observe','first',{claim:'First checked.',receipts:[first.receiptId]});
 await edit('focus','next');
 const receipts=[];
 for(let i=0;i<9;i++)receipts.push((await read()).receiptId);
 const before=ledger.read();
 for(const action of ['observe','block']){
  await assert.rejects(edit(action,'next',{claim:'Use source.',blocker:'prerequisite-unavailable',receipts:[first.receiptId,'receipt-999','never-echo-this-secret','receipt-998','receipt-997','receipt-996','receipt-995']}),err=>{
   assert.equal(err.code,action==='observe'?'DIRECTORY_EVIDENCE':'DIRECTORY_BLOCKER');
   assert.match(err.message,/Current focus: next.*receipt-1: assigned to another action.*receipt-999: absent/);
   assert.match(err.message,/invalid receipt ID: absent/);
   assert.match(err.message,/1 more rejected/);
   assert.doesNotMatch(err.message,/never-echo-this-secret|receipt-995|receipt-2/);
   assert.match(err.message,/Recent eligible receipt IDs: receipt-3, receipt-4, receipt-5, receipt-6, receipt-7, receipt-8, receipt-9, receipt-10/);
   return true;
  });
 }
 assert.deepEqual(ledger.read(),before);
 await edit('observe','next',{claim:'Second checked.',receipts:[receipts.at(-1)]});
 assert.equal(calls,10,'Correcting a receipt uses an existing observation, not another tool call.');
 assert.equal(ledger.finalStatus().ready,true);
});

test('verification source identity uses the successful returned URL, not requested URL or tracking and hash variants',async()=>{
 const ledger=create(), context={runId:'run',nodeId:'agent',observationOnly:true};
 const qualifying={minQualifyingCount:2,requiredChecks:['user_required']};
 const action={id:'find',objective:'Verify two eligible sources',dependsOn:[],qualifying};
 const dir=(args,scope=context)=>ledger.handle({...args,revision:ledger.read().revision},scope);
 await dir({action:'plan',actions:[action]});
 await dir({action:'focus',id:'find'});
 const active=ledger.read();
 for(const replacement of [undefined,{...qualifying,minQualifyingCount:1}]){
  await assert.rejects(dir({action:'plan',actions:[{...action,qualifying:replacement}]}),{code:'DIRECTORY_RECORDED_ACTION'});
 }
 assert.deepEqual(ledger.read(),active);
 const source=async (url,scope=context,requested='https://public.example/careers?id=unresolved')=>ledger.execute(
  {name:'relay_browser',arguments:{action:'navigate',url:requested}},
  async()=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(url?{url,documentId:'live-document',frames:[{}]}:{status:'opaque result'})}]}),scope);
 const one=await source('https://public.example/careers?utm_source=first&id=1#work');
 const alias=await source('https://public.example/careers?id=1&gclid=tracking#remote',context,'https://other.example/requested');
 const two=await source('https://public.example/careers?id=2&utm_campaign=tracking#remote');
 const noIdentity=await source(null);
 assert.equal(noIdentity.result.success,true,'Unavailable identity cannot change normal handler success.');
 const foreign=await source('https://public.example/careers?id=3',{...context,runId:'other-run'});
 const mark=(first,second)=>dir({action:'observe',outcome:'objective-met',id:'find',claim:'Verified both sources.',receipts:[first.receiptId,second.receiptId],
  candidateRows:[first,second].map((r,i)=>({id:'candidate_'+i,sourceReceipt:r.receiptId,checks:[{id:'user_required',status:'verified'}]}))});
 await assert.rejects(mark(one,alias),{code:'DIRECTORY_QUALIFICATION',message:/repeating the same source/});
 await assert.rejects(mark(one,noIdentity),{code:'DIRECTORY_QUALIFICATION',message:/successful source-read receipt/});
 await assert.rejects(mark(one,foreign),{code:'DIRECTORY_QUALIFICATION',message:/from this run and node/});
 await mark(one,two);
 assert.equal(ledger.read().actions[0].observation.qualification.count,2);
 assert.equal(ledger.finalStatus().ready,true);
 assert.doesNotMatch(JSON.stringify(ledger.read()),/public\.example|tracking|sourceKey|live-document/);
 const reopened=create({snapshot:ledger.read()});assert.equal(reopened.read().actions[0].observation.qualification.count,2);
});

test('plan replaces only pending work and can depend on omitted recorded steps',async()=>{
 const ledger=create();await plan(ledger);await focus(ledger);
 const receipt=await ledger.execute({name:'relay_find_files'},async()=>({success:true}),{runId:'run',nodeId:'agent'});
 await ledger.edit({action:'observe',id:'find',claim:'Input found',receipts:[receipt.receiptId],revision:ledger.read().revision});
 const before=ledger.read();
 const after=await ledger.edit({action:'plan',actions:[{id:'search',objective:'Search actual postings',dependsOn:['find']}],revision:before.revision});
 assert.deepEqual(after.actions[0],before.actions[0]);assert.deepEqual(after.receipts,before.receipts);
 assert.deepEqual(after.actions.map(a=>a.id),['find','search']);assert.deepEqual(after.ready,['search']);assert.equal(ledger.finalStatus().ready,false);
 await assert.rejects(ledger.edit({action:'plan',actions:[{id:'find',objective:'Rewritten history',dependsOn:[]}],revision:after.revision}),{code:'DIRECTORY_RECORDED_ACTION'});
 assert.deepEqual(ledger.read(),after);
});

test('stale code or input-only flags are not whole-action proof and cannot clear uncertainty',async()=>{
 const ledger=create();await plan(ledger);await focus(ledger);
 await assert.rejects(ledger.execute({name:'relay_browser'},async()=>{throw Object.assign(Error('Unclear browser outcome after interaction'),{code:'BROWSER_REF_STALE',inputDispatched:false});},{runId:'run',nodeId:'agent'}),{code:'BROWSER_REF_STALE'});
 assert.equal(ledger.read().receipts[0].actionDispatched,undefined);
 assert.deepEqual(ledger.finalStatus().unknown,['receipt-1']);
 await assert.rejects(ledger.execute({name:'relay_browser'},async()=>assert.fail('must not dispatch'),{runId:'run',nodeId:'agent'}),{code:'DIRECTORY_UNKNOWN'});
});

test('a stale click cannot exhaust a finite browser search',async()=>{
 const ledger=create(),urls=['https://example.com/source-a','https://example.com/source-b'];
 const auth={runId:'run',nodeId:'agent'};
 const edit=(action,fields)=>ledger.handle({action,revision:ledger.read().revision,...fields},auth);
 await edit('plan',{actions:[{id:'find',objective:'Check both sources and report the shortfall if any.',dependsOn:[],searchScope:urls.map(locator=>({tool:'relay_browser',locator}))}]});
 await edit('focus',{id:'find'});
 const read=(url,action='read')=>ledger.execute({name:'relay_browser',arguments:{action}},async()=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify({url,documentId:'document-1',frames:[{}]})}]}),{...auth,observationOnly:true});
 const planned=ledger.read().actions[0];
 await assert.rejects(edit('plan',{actions:[{id:planned.id,objective:planned.objective,dependsOn:[],searchScope:planned.searchScope.slice(0,1)}]}),{code:'DIRECTORY_RECORDED_ACTION'});
 const a=await read(urls[0],'open');
 await assert.rejects(ledger.execute({name:'relay_browser',arguments:{action:'click'}},async()=>{
  throw Object.assign(new Error('Take a fresh snapshot.'),{code:'BROWSER_REF_STALE',actionDispatched:false});
 },auth),{code:'BROWSER_REF_STALE'});
 const stale=ledger.read().receipts.at(-1);
 assert.equal(stale.actionDispatched,false);
 const block=receipts=>edit('block',{id:'find',blocker:'search-limit-reached',claim:'The search limit was reached.',receipts});
 const before=ledger.read();
 await assert.rejects(block([a.receiptId,stale.id]),{code:'DIRECTORY_SEARCH_SCOPE'});
 assert.deepEqual(ledger.read(),before);
 assert.equal(ledger.finalStatus().reason,'pending-actions');
 const b=await read(urls[1]+'?utm_source=ignored','snapshot');
 await block([a.receiptId,b.receiptId]);
 assert.equal(ledger.finalStatus().reason,'blocked-paths');
 assert.equal(ledger.read().actions[0].state,'blocked');
});

test('restart preserves interrupted observations without treating them as unknown effects', async()=>{
 for(const bound of [false,true]){
  for(const legacy of bound?[false]:[false,true]){
   let saved;
   const ledger=create({persist:async state=>{saved=state;}});
   await plan(ledger);
   if(bound)await focus(ledger);
   await assert.rejects(ledger.execute({name:'relay_browser',arguments:{action:'snapshot'}},async()=>{throw Error('Interrupted before snapshot returned');},{runId:'run',nodeId:'agent',observationOnly:true}));
   const snapshot=structuredClone(saved);
   if(legacy)delete snapshot.receipts[0].observationOnly;
   const resumed=create({snapshot});
   assert.equal(resumed.read().receipts[0].state,'unknown');
   assert.notEqual(resumed.finalStatus().reason,'unknown-effects');
   assert.equal(resumed.finalStatus().ready,false,'a lost observation is not success');
   if(!bound)await focus(resumed);
   await assert.rejects(resumed.edit({action:'observe',id:'find',claim:'It was read',receipts:['receipt-1'],revision:resumed.read().revision}),{code:'DIRECTORY_EVIDENCE'});
   const result=await resumed.execute({name:'relay_workspace'},async()=>({success:true}),{runId:'next',nodeId:'agent',observationOnly:true});
   await resumed.edit({action:'observe',id:'find',claim:'Fresh observation returned',receipts:[result.receiptId],revision:resumed.read().revision});
   assert.deepEqual(resumed.read().ready,['check']);
  }
 }
});

const CHOICE_PREFIX = 'Current Directory choices (same task): ';
function choicesIn(message) {
 const rows=message.split('\n').filter(line=>line.startsWith(CHOICE_PREFIX));
 assert.equal(rows.length,1,'One quoted current-task choice projection is returned.');
 return JSON.parse(rows[0].slice(CHOICE_PREFIX.length));
}

test('unknown action IDs receive exact current choices without changing the Directory',async()=>{
 let persisted=0;const ledger=create({persist:async()=>{persisted++;}});await plan(ledger);
 const before=ledger.read(),writes=persisted;
 await assert.rejects(ledger.handleModelTool({action:'focus',id:'host-turn-authORITY'},
  {expectedActionRevision:before.actionRevision,runId:'run',nodeId:'agent'}),error=>{
   assert.equal(error.code,'DIRECTORY_ACTION');assert.equal(error.status,409);
   assert.equal(Object.hasOwn(error,'actionDispatched'),false);
   assert.ok(error.message.startsWith('Choose an existing action.'));
   assert.deepEqual(choicesIn(error.message),{taskId:'task',actionRevision:before.actionRevision,focus:null,ready:['find'],actions:[
    {id:'find',objective:'Find candidate jobs',state:'pending'},
    {id:'check',objective:'Check candidate requirements',state:'pending'}]});
   assert.match(error.message,/exact existing ID whose objective matches the work/);
   assert.match(error.message,/action "plan".*action "read"/);return true;
  });
 assert.deepEqual(ledger.read(),before);assert.equal(persisted,writes);
});

test('missing focus returns choices before any receipt reservation or dispatch',async()=>{
 let persisted=0,calls=0;const ledger=create({persist:async()=>{persisted++;}});await plan(ledger);
 const before=ledger.read(),writes=persisted,trace=[];
 await assert.rejects(ledger.execute({name:'relay_workspace'},async()=>{calls++;return{success:true};},
  {runId:'run',nodeId:'agent',trace:value=>trace.push(value)}),error=>{
   assert.equal(error.code,'DIRECTORY_FOCUS');assert.equal(error.status,409);assert.equal(error.actionDispatched,false);
   assert.ok(error.message.startsWith('This tool call did not run.'));
   assert.match(error.message,/Focus that step with relay_directory_action.*Keep earlier successful reads\./);
   assert.deepEqual(choicesIn(error.message),{taskId:'task',actionRevision:before.actionRevision,focus:null,ready:['find'],actions:[
    {id:'find',objective:'Find candidate jobs',state:'pending'},
    {id:'check',objective:'Check candidate requirements',state:'pending'}]});return true;
  });
 assert.equal(calls,0);assert.equal(persisted,writes);assert.deepEqual(ledger.read(),before);
 assert.equal(trace.length,1);assert.equal(trace[0].phase,'gate');assert.equal(trace[0].decision,'reject');
 assert.equal(trace[0].code,'DIRECTORY_FOCUS');assert.equal(trace[0].receiptId,undefined);
});

test('empty Directory hints preserve the empty outline and ask for model planning',async()=>{
 let persisted=0,calls=0;const ledger=create({persist:async()=>{persisted++;}}),before=ledger.read();
 for(const operation of [
  ()=>ledger.edit({action:'focus',revision:0,id:'invented'}),
  ()=>ledger.execute({name:'relay_workspace'},async()=>{calls++;},{runId:'run',nodeId:'agent'})
 ])await assert.rejects(operation,error=>{
  assert.deepEqual(choicesIn(error.message),{taskId:'task',actionRevision:0,focus:null,ready:[],actions:[]});
  assert.match(error.message,/If matching work is missing.*action "plan"/);return true;
 });
 assert.equal(calls,0);assert.equal(persisted,0);assert.deepEqual(ledger.read(),before);
});

test('choice hints distinguish existing closed and blocked work from ready IDs and active focus',async()=>{
 const ledger=create(),actions=[
  {id:'done',objective:'Read the source',dependsOn:[]},
  {id:'blocked',objective:'Unavailable route',dependsOn:[]},
  {id:'waiting',objective:'Dependent work',dependsOn:['blocked']},
  {id:'ready',objective:'Independent work',dependsOn:[]}];
 await ledger.edit({action:'plan',revision:0,actions});await focus(ledger,'done');
 const result=await ledger.execute({name:'relay_workspace'},async()=>({success:true}),{runId:'run',nodeId:'agent'});
 await ledger.edit({action:'observe',revision:ledger.read().revision,id:'done',outcome:'objective-met',claim:'Source read',receipts:[result.receiptId]});
 await ledger.edit({action:'block',revision:ledger.read().revision,id:'blocked',blocker:'no-viable-route',claim:'Route unavailable'});
 let before=ledger.read();
 await assert.rejects(focus(ledger,'missing'),error=>{
  const choices=choicesIn(error.message);
  assert.deepEqual(choices.actions,[
   {id:'done',objective:'Read the source',state:'observed'},
   {id:'blocked',objective:'Unavailable route',state:'blocked'},
   {id:'waiting',objective:'Dependent work',state:'pending'},
   {id:'ready',objective:'Independent work',state:'pending'}]);
  assert.deepEqual(choices.ready,['ready']);assert.equal(choices.focus,null);return true;
 });
 assert.deepEqual(ledger.read(),before);
 await focus(ledger,'ready');before=ledger.read();
 await assert.rejects(focus(ledger,'missing'),error=>{
  const choices=choicesIn(error.message);
  assert.equal(choices.focus,'ready');assert.deepEqual(choices.ready,[]);
  assert.equal(choices.actions.find(row=>row.id==='ready').state,'active');return true;
 });
 assert.deepEqual(ledger.read(),before);
});

test('replanning refreshes task-local choice hints while stale revisions keep their original rejection',async()=>{
 const left=create({taskId:'left'}),right=create({taskId:'right'});
 await left.edit({action:'plan',revision:0,actions:[{id:'left_old',objective:'Old pending work',dependsOn:[]}]});
 await right.edit({action:'plan',revision:0,actions:[{id:'right_only',objective:'Other task work',dependsOn:[]}]});
 const old=left.read(),rightBefore=right.read();
 await left.edit({action:'plan',revision:old.revision,actions:[{id:'left_new',objective:'Revised work',dependsOn:[]}]});
 const before=left.read();
 await assert.rejects(left.edit({action:'focus',revision:old.revision,id:'missing'}),error=>{
  assert.equal(error.code,'DIRECTORY_CHANGED');assert.equal(error.message,'Read the current Directory revision before editing.');
  assert.doesNotMatch(error.message,/Current Directory choices/);return true;
 });
 const seen=[];
 await Promise.all([left,right].map(ledger=>assert.rejects(focus(ledger,'missing'),error=>{
  seen.push(choicesIn(error.message));return true;
 })));
 assert.deepEqual(seen.find(row=>row.taskId==='left'),{taskId:'left',actionRevision:before.actionRevision,focus:null,
  ready:['left_new'],actions:[{id:'left_new',objective:'Revised work',state:'pending'}]});
 assert.deepEqual(seen.find(row=>row.taskId==='right'),{taskId:'right',actionRevision:rightBefore.actionRevision,focus:null,
  ready:['right_only'],actions:[{id:'right_only',objective:'Other task work',state:'pending'}]});
 assert.deepEqual(left.read(),before);assert.deepEqual(right.read(),rightBefore);
});

test('choice hints preserve all 24 existing objectives with Unicode and quoted newlines',async()=>{
 const ledger=create(),actions=Array.from({length:24},(_,index)=>({id:'stage_'+index,
  objective:'Step '+index+' — résumé 東京 "quoted"\nsecond line '+ 'x'.repeat(1100),dependsOn:[]}));
 await ledger.edit({action:'plan',revision:0,actions});const before=ledger.read();
 await assert.rejects(focus(ledger,'missing'),error=>{
  const choices=choicesIn(error.message);
  assert.equal(choices.actions.length,24);assert.deepEqual(choices.ready,actions.map(row=>row.id));
  assert.deepEqual(choices.actions,actions.map(({id,objective})=>({id,objective,state:'pending'})));
  assert.equal(error.message.split('\n').filter(line=>line.startsWith(CHOICE_PREFIX)).length,1);return true;
 });
 assert.deepEqual(ledger.read(),before);
});

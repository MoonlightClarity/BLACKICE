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

import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';
import {ACTION_DIRECTORY_TOOL} from '../lib/task-action-directory.mjs';
import {ancestorIds,depthOf,synthesisStatus} from '../lib/directory-recursive-actions.mjs';

const actor={runId:'run-recursive',nodeId:'agent-recursive'};
const action=(id,objective,dependsOn=[],extra={})=>({id,objective,dependsOn,...extra});
const created=({snapshot,taskId='task-recursive',persist=async()=>{}}={})=>new TaskActionDirectory({
 taskId,objective:'Investigate and repair a multi-module asynchronous codebase; verify every requirement.',
 ...(snapshot?{snapshot}:{}),persist,
});
const edit=(directory,args)=>directory.handleModelTool(args,{
 expectedActionRevision:directory.read().actionRevision,...actor,
});
const tool=async (directory,{name='relay_workspace',arguments:input={action:'run',command:'node --test'},success=true,observationOnly=false}={})=>
 directory.execute({name,arguments:input},async()=>({success,contentItems:[{type:'inputText',text:JSON.stringify({code:success?0:1,output:'host returned evidence'})}]}),{
  ...actor,observationOnly,expectedActionRevision:directory.read().actionRevision,
 });
const receipt=(dir,id)=>dir.read().receipts.find(r=>r.id===id);

test('recursive planning executes leaves and synthesizes ancestors from exact descendant host receipts',async()=>{
 const writes=[];
 const directory=created({persist:async state=>writes.push(state)});
 await edit(directory,{action:'plan',actions:[action('project','Repair both event modules')]});
 await edit(directory,{action:'focus',id:'project'});
 await edit(directory,{action:'decompose',id:'project',claim:'Separate evidence inspection and code integration.',actions:[
  action('inspect','Read the incident evidence'),
  action('build','Repair modules and verify code',['inspect']),
 ]});
 assert.equal(directory.read().actions.find(a=>a.id==='project').state,'decomposed');
 assert.deepEqual(directory.read().ready,['inspect']);
 assert.equal(directory.finalStatus().ready,false,'A parent does not complete when a plan is authored.');
 await assert.rejects(edit(directory,{action:'focus',id:'project'}),e=>e.code==='DIRECTORY_CHILD_PENDING');
 await edit(directory,{action:'focus',id:'inspect'});
 const a=await tool(directory,{observationOnly:true,input:{action:'read',path:'incident.log'}});
 await edit(directory,{action:'observe',id:'inspect',claim:'Found decisive root causes.',outcome:'objective-met',receipts:[a.receiptId]});
 assert.deepEqual(directory.read().ready,['build']);
 await edit(directory,{action:'focus',id:'build'});
 await edit(directory,{action:'decompose',id:'build',claim:'Separate implementation and verification.',actions:[
  action('ledger','Repair EventLedger'),
  action('processor','Repair StreamProcessor',['ledger']),
  action('verify','Run multi-module tests',['processor']),
 ]});
 assert.equal(depthOf(directory.read().actions,'ledger'),2);
 assert.deepEqual(ancestorIds(directory.read().actions,'verify'),['build','project']);
 assert.deepEqual(directory.read().ready,['ledger']);
 await edit(directory,{action:'focus',id:'ledger'});
 const b=await tool(directory,{input:{action:'write',path:'ledger.mjs',text:'fixed'}});
 await edit(directory,{action:'observe',id:'ledger',claim:'Ledger implementation repaired.',outcome:'objective-met',receipts:[b.receiptId]});
 assert.deepEqual(directory.read().ready,['processor']);
 await edit(directory,{action:'focus',id:'processor'});
 const c=await tool(directory,{input:{action:'write',path:'processor.mjs',text:'fixed'}});
 await edit(directory,{action:'observe',id:'processor',claim:'Processor implementation repaired.',outcome:'objective-met',receipts:[c.receiptId]});
 assert.deepEqual(directory.read().ready,['verify']);
 await edit(directory,{action:'focus',id:'verify'});
 const d=await tool(directory,{input:{action:'run',command:'node --test'}});
 await edit(directory,{action:'observe',id:'verify',claim:'Host returned tests completed.',outcome:'objective-met',receipts:[d.receiptId]});
 assert.deepEqual(directory.read().ready,['build']);
 assert.equal(synthesisStatus(directory.read().actions,'build').objectiveEligible,true);
 await edit(directory,{action:'focus',id:'build'});
 // Parent synthesis cites real descendant results; no handler is dispatched again.
 await edit(directory,{action:'observe',id:'build',claim:'Both modules repaired and tests executed.',outcome:'objective-met',receipts:[b.receiptId,c.receiptId,d.receiptId]});
 assert.deepEqual(directory.read().ready,['project']);
 await edit(directory,{action:'focus',id:'project'});
 await edit(directory,{action:'observe',id:'project',claim:'The requested repair is complete with returned evidence.',outcome:'objective-met',receipts:[a.receiptId,b.receiptId,c.receiptId,d.receiptId]});
 assert.equal(directory.finalStatus().ready,true);
 assert.equal(directory.finalStatus().reason,'ready');
 assert.equal(directory.read().receipts.length,4,'Recursive planning must not replay tool calls to synthesize parent outcomes.');
 assert.equal(receipt(directory,b.receiptId).actionId,'ledger','Host receipt ownership remains immutable.');
 assert.equal(writes.at(-1).actions.find(a=>a.id==='project').state,'observed');
 const branch=directory.readSubtree('build');
 assert.equal(branch.subtree.descendants,3);
 assert.deepEqual(branch.subtree.path,['project','build']);
 assert.equal(branch.actions.length,4);
 assert.equal(branch.receipts.length,3);
});

test('blocked child remains recorded and parent cannot claim success until an observed alternate route replaces it',async()=>{
 const directory=created();
 await edit(directory,{action:'plan',actions:[action('root','Deliver the requested result')]});
 await edit(directory,{action:'focus',id:'root'});
 await edit(directory,{action:'decompose',id:'root',claim:'Investigate primary and alternate routes.',actions:[
  action('primary','Try original implementation'),
  action('audit','Inspect independent evidence'),
 ]});
 await edit(directory,{action:'focus',id:'primary'});
 await edit(directory,{action:'block',id:'primary',blocker:'no-viable-route',claim:'Original approach proved unusable.'});
 await edit(directory,{action:'focus',id:'audit'});
 const evidence=await tool(directory,{input:{action:'read',path:'audit.log'},observationOnly:true});
 await edit(directory,{action:'observe',id:'audit',outcome:'objective-met',claim:'Read corroborating evidence.',receipts:[evidence.receiptId]});
 assert.deepEqual(directory.read().ready,['root']);
 await edit(directory,{action:'focus',id:'root'});
 await assert.rejects(edit(directory,{action:'observe',id:'root',outcome:'objective-met',claim:'Unjustified success.',receipts:[evidence.receiptId]}),
  e=>e.code==='DIRECTORY_CHILD_UNMET');
 await edit(directory,{action:'decompose',id:'root',claim:'Recover by a new independent route.',actions:[
  action('fallback','Implement the alternative path',[],{replaces:['primary']}),
 ]});
 assert.deepEqual(directory.read().ready,['fallback']);
 await edit(directory,{action:'focus',id:'fallback'});
 const repaired=await tool(directory,{input:{action:'write',path:'fallback.mjs',text:'fixed'}});
 await edit(directory,{action:'observe',id:'fallback',outcome:'objective-met',claim:'Replacement path succeeded.',receipts:[repaired.receiptId]});
 assert.equal(synthesisStatus(directory.read().actions,'root').objectiveEligible,true);
 await edit(directory,{action:'focus',id:'root'});
 await edit(directory,{action:'observe',id:'root',outcome:'objective-met',claim:'Observed replacement covers blocked route.',receipts:[evidence.receiptId,repaired.receiptId]});
 assert.equal(directory.finalStatus().ready,true,'A successful replacement should resolve the parent without erasing the failed route.');
 assert.deepEqual(directory.finalStatus().mitigatedBlocked,['primary']);
 assert.deepEqual(directory.finalStatus().blocked,[]);
 assert.equal(directory.read().actions.find(a=>a.id==='primary').state,'blocked');
 assert.equal(directory.read().actions.find(a=>a.id==='fallback').replaces[0],'primary');
});
test('recursive replanning cannot overwrite or silently delete pending descendants or their request checks',async()=>{
 const directory=created();
 await edit(directory,{action:'plan',actions:[action('root','Solve complex goal')]});
 await edit(directory,{action:'focus',id:'root'});
 await edit(directory,{action:'decompose',id:'root',claim:'First decompose.',actions:[
  action('a','Observe A'),action('b','Implement B',['a']),
 ]});
 const before=directory.read();
 await edit(directory,{action:'plan',actions:[action('separate','Independent new top-level work')]});
 assert.equal(directory.read().actions.find(a=>a.id==='a').state,'pending');
 assert.equal(directory.read().actions.find(a=>a.id==='b').parentId,'root');
 await assert.rejects(edit(directory,{action:'plan',actions:[action('a','Hijacked A')]}),e=>e.code==='DIRECTORY_RECORDED_ACTION');
 assert.equal(directory.read().actions.find(a=>a.id==='a').objective,'Observe A');
 assert.equal(before.actions.length+1,directory.read().actions.length);
});

test('recursive parent and descendant ancestry reject absent parents, cycles and blocked replacement aliases on restart',async()=>{
 const directory=created();
 await edit(directory,{action:'plan',actions:[action('root','Do work')]});
 await edit(directory,{action:'focus',id:'root'});
 await edit(directory,{action:'decompose',id:'root',claim:'Split.',actions:[action('child','Inspect')]});
 const before=directory.read();
 for(const change of [
  s=>{s.actions.find(a=>a.id==='child').parentId='missing';},
  s=>{s.actions.find(a=>a.id==='root').parentId='child';},
  s=>{s.actions.find(a=>a.id==='child').dependsOn=['root'];},
  s=>{s.actions.find(a=>a.id==='child').replaces=['root'];},
 ]){
  const corrupt=structuredClone(before);change(corrupt);
  assert.throws(()=>created({snapshot:corrupt}),e=>e.code==='DIRECTORY_CORRUPT');
 }
 assert.deepEqual(directory.read(),before);
});

test('a deep hierarchy has no fixed recursion-depth gate and the provider view remains bounded',()=>{
 const actions=Array.from({length:120},(_,i)=>({
  id:'depth_'+i,objective:'Independent subproblem level '+i,
  dependsOn:[],state:i===119?'pending':'decomposed',authority:'agent',
  ...(i?{parentId:'depth_'+(i-1)}:{}),
 }));
 const state={version:1,taskId:'task-recursive',
  objective:'Investigate and repair a multi-module asynchronous codebase; verify every requirement.',
  revision:3,actionRevision:2,focus:null,actions,receipts:[],nextReceipt:1};
 const directory=created({snapshot:state});
 assert.equal(depthOf(directory.read().actions,'depth_119'),119);
 assert.equal(directory.read().actions.length,120);
 const projection=directory.promptView();
 assert(projection.actions.length<=72);
 assert(projection.deferredActionCount>0);
 assert(projection.actions.some(a=>a.id==='depth_119'),'The executable leaf remains visible.');
 assert.equal(directory.readSubtree('depth_70').actions.length,50);
 assert.equal(directory.readSubtree('depth_70').subtree.path.length,71);
 assert.equal(directory.finalStatus().ready,false);
});

test('an interrupted unknown child effect survives restart and prevents replay or premature parent synthesis',async()=>{
 const directory=created();
 await edit(directory,{action:'plan',actions:[action('root','Do work')]});
 await edit(directory,{action:'focus',id:'root'});
 await edit(directory,{action:'decompose',id:'root',claim:'Split risky effects.',actions:[action('mutate','Perform external write')]});
 await edit(directory,{action:'focus',id:'mutate'});
 let calls=0;
 await assert.rejects(directory.execute({name:'relay_workspace',arguments:{action:'write',path:'data.txt',text:'x'}},async()=>{
  calls++;throw Error('Effect outcome uncertain');
 },{...actor,expectedActionRevision:directory.read().actionRevision}));
 assert.equal(calls,1);
 const before=directory.read();
 assert.equal(before.receipts[0].state,'unknown');
 assert.throws(()=>created({snapshot:{...before,actions:before.actions.filter(a=>a.id!=='mutate')}}),
  e=>e.code==='DIRECTORY_CORRUPT');
 const resumed=created({snapshot:before});
 await assert.rejects(edit(resumed,{action:'decompose',id:'root',claim:'Try again.',actions:[action('retry','Repeat external write')]}),
  e=>e.code==='DIRECTORY_DECOMPOSE'||e.code==='DIRECTORY_UNKNOWN');
 await assert.rejects(resumed.execute({name:'relay_workspace',arguments:{action:'write',path:'data.txt',text:'x'}},
  async()=>{calls++;return{success:true,contentItems:[]};},
  {...actor,expectedActionRevision:resumed.read().actionRevision}),e=>e.code==='DIRECTORY_UNKNOWN');
 assert.equal(calls,1);
 assert.equal(resumed.finalStatus().reason,'unknown-effects');
});

test('parent synthesis after restart reuses a completed descendant receipt without rerunning its effect',async()=>{
 const ledger=created();
 await edit(ledger,{action:'plan',actions:[action('parent','Repair a source')]});
 await edit(ledger,{action:'focus',id:'parent'});
 await edit(ledger,{action:'decompose',id:'parent',claim:'One executable child after diagnosis.',actions:[action('child','Edit the source')]});
 await edit(ledger,{action:'focus',id:'child'});
 let dispatches=0;
 const outcome=await ledger.execute({name:'relay_workspace',arguments:{action:'write',path:'code.mjs',text:'verified'}},
  async()=>{dispatches++;return {success:true,contentItems:[{type:'inputText',text:'saved'}]};},
  {...actor,expectedActionRevision:ledger.read().actionRevision});
 await edit(ledger,{action:'observe',id:'child',outcome:'objective-met',claim:'Saved source verified by the host.',receipts:[outcome.receiptId]});
 const recovered=created({snapshot:ledger.read()});
 const nextActor={runId:'run-after-restart',nodeId:'successor'};
 const later=(args)=>recovered.handleModelTool(args,{expectedActionRevision:recovered.read().actionRevision,...nextActor});
 await later({action:'focus',id:'parent'});
 await later({action:'observe',id:'parent',outcome:'objective-met',claim:'The completed child delivered the required output.',receipts:[outcome.receiptId]});
 assert.equal(dispatches,1);
 assert.equal(recovered.finalStatus().ready,true);
 assert.equal(recovered.read().receipts[0].runId,'run-recursive');
 assert.equal(recovered.read().receipts[0].actionId,'child');
});

test('the parent can accumulate hundreds of child actions in successive decompositions without the old global 24-action cap',async()=>{
 const directory=created();
 await edit(directory,{action:'plan',actions:[action('root','Manage many independently inspected sources')]});
 await edit(directory,{action:'focus',id:'root'});
 for(let batch=0;batch<10;batch++){
  const start=batch*20;
  await edit(directory,{action:'decompose',id:'root',claim:'Add another independent collection of observed source routes.',actions:
   Array.from({length:20},(_,i)=>action('source_'+(start+i),'Inspect source '+(start+i)))});
 }
 const s=directory.read();
 assert.equal(s.actions.length,201);
 assert.equal(s.ready.length,200);
 assert.equal(synthesisStatus(s.actions,'root').childCount,200);
 const projected=directory.promptView();
 assert(projected.actions.length<=72);
 assert(projected.deferredActionCount>=129);
 assert.equal(projected.totalActionCount,201);
 assert.equal(projected.ready.length,32);
 assert.equal(directory.readSubtree('root').actions.length,201);
 assert.equal(directory.finalStatus().reason,'pending-actions');
});

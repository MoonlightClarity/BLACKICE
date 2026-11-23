import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActionDirectory,ACTION_DIRECTORY_MAX_RECEIPTS} from '../lib/task-action-directory.mjs';

const makeSnapshot=(count=300)=>{
 const taskId='ledger-task';
 const receipts=Array.from({length:count},(_,index)=>({
  id:'receipt-'+(index+1),taskId,runId:'run-ledger',nodeId:'agent-ledger',
  actionId:index===0?'repair':null,tool:'relay_workspace',state:index===0?'unknown':'returned',
  ...(index===0?{}:{success:true,observationOnly:true,returnedAt:'2026-11-23T08:00:00.000Z'}),
  at:'2026-11-23T07:59:00.000Z',
 }));
 return {version:1,taskId,objective:'Repair the source and preserve observations.',
  revision:count*2,actionRevision:2,focus:'repair',
  actions:[{id:'repair',objective:'Repair one file',dependsOn:[],state:'active',authority:'agent'}],
  receipts,nextReceipt:count+1};
};

test('host retains over 256 exact receipts and preserves oldest unresolved effects across reload',async()=>{
 assert(ACTION_DIRECTORY_MAX_RECEIPTS>=300);
 const directory=new TaskActionDirectory({taskId:'ledger-task',objective:'Repair one file',snapshot:makeSnapshot()});
 const complete=directory.read();
 assert.equal(complete.receipts.length,300);
 const view=directory.promptView();
 assert.equal(view.deferredReceiptCount,291);
 assert(view.receipts.some(row=>row.id==='receipt-1'&&row.state==='unknown'));
 assert(view.receipts.some(row=>row.id==='receipt-300'));
 let invoked=0;
 const observed=await directory.execute({name:'relay_workspace',arguments:{action:'read',path:'fixture.txt'}},
  async()=>{invoked++;return{success:true,contentItems:[{type:'inputText',text:'observed'}]};},
  {runId:'run-ledger',nodeId:'agent-ledger',observationOnly:true});
 assert.equal(invoked,1);
 assert.equal(observed.receiptId,'receipt-301');
 assert.equal(observed.directory.receipts.length,301);
 assert.equal(directory.finalStatus().reason,'unknown-effects');
 const resumed=new TaskActionDirectory({taskId:'ledger-task',objective:'Repair one file',snapshot:directory.read()});
 assert.equal(resumed.read().receipts.length,301);
 assert.equal(resumed.read().receipts[0].id,'receipt-1');
 assert.equal(resumed.finalStatus().reason,'unknown-effects');
 let externalWriteCalled=false;
 await assert.rejects(resumed.execute({name:'relay_workspace',arguments:{action:'write',path:'fixture.txt',text:'change'}},
  async()=>{externalWriteCalled=true;return{success:true,contentItems:[]};},
  {runId:'run-ledger',nodeId:'agent-ledger',observationOnly:false,expectedActionRevision:resumed.read().actionRevision}),error=>error.code==='DIRECTORY_UNKNOWN');
 assert.equal(externalWriteCalled,false,'An old unresolved effect still blocks unverified replay.');
});

test('corrupt oversized snapshots remain rejected instead of silently shedding receipts',()=>{
 const tooLarge=makeSnapshot(ACTION_DIRECTORY_MAX_RECEIPTS+1);
 assert.throws(()=>new TaskActionDirectory({taskId:'ledger-task',objective:'Repair one file',snapshot:tooLarge}),
  error=>error.code==='DIRECTORY_CORRUPT');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';

const scope={runId:'run-parallel',nodeId:'agent-parallel'};
async function setup(){
 const directory=new TaskActionDirectory({taskId:'task-parallel',objective:'Repair two distinct files.'});
 await directory.edit({action:'plan',revision:0,actions:[{id:'repair',objective:'Repair both files',dependsOn:[]}]});
 await directory.edit({action:'focus',revision:directory.read().revision,id:'repair'});
 return directory;
}
const tool=path=>({name:'relay_workspace',arguments:{action:'write',path,text:'fixed'}});
const nextTick=()=>new Promise(resolve=>setImmediate(resolve));
test('concurrent provider tool calls in one action settle, without a spurious unknown-effect rejection or replay', {timeout:20000},async()=>{
 const dir=await setup(),dispatched=[];
 let releaseFirst;const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
 const first=dir.execute(tool('src/a.mjs'),async()=>{
   dispatched.push('a');await firstGate;
   return {success:true,contentItems:[{type:'inputText',text:'A written'}]};
 },scope);
 const second=dir.execute(tool('src/b.mjs'),async()=>{
   dispatched.push('b');return {success:true,contentItems:[{type:'inputText',text:'B written'}]};
 },scope);
 for(let i=0;i<32&&dispatched.length<2;i++)await nextTick();
 assert.deepEqual(dispatched,['a','b'],'Independent file writes should both dispatch; do not introduce unnecessary serialization.');
 releaseFirst();
 const [a,b]=await Promise.all([first,second]);
 assert.deepEqual(dispatched,['a','b']);
 assert.equal(a.receiptId,'receipt-1');
 assert.equal(b.receiptId,'receipt-2');
 assert.equal(dir.read().receipts.every(row=>row.state==='returned'&&row.success===true),true);
 assert.equal(dir.read().receipts.length,2);
 await dir.edit({action:'observe',revision:dir.read().revision,id:'repair',claim:'Both exact returned writes were admitted.',
   receipts:[a.receiptId,b.receiptId]},scope);
 assert.equal(dir.finalStatus().ready,true);
});
test('same-target overlapping effect is denied and genuinely unresolved history stays blocked',{timeout:20000},async()=>{
 const dir=await setup();let releaseFirst,secondDispatched=0;
 const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
 const first=dir.execute(tool('src/a.mjs'),async()=>{
   await firstGate;throw Object.assign(new Error('post-dispatch transport lost'),{code:'BROKEN_TRANSPORT'});
 },scope);
 const second=dir.execute(tool('src/a.mjs'),async()=>{
   secondDispatched++;return{success:true};
 },scope);
 const results=Promise.allSettled([first,second]);
 await nextTick();releaseFirst();
 const [a,b]=await results;
 assert.equal(a.status,'rejected');
 assert.equal(b.status,'rejected');
 assert.equal(b.reason.code,'DIRECTORY_UNKNOWN');
 assert.equal(secondDispatched,0);
 assert.equal(dir.read().receipts.length,1);
 assert.equal(dir.read().receipts[0].state,'unknown');
 let thirdDispatched=0;
 await assert.rejects(dir.execute(tool('src/b.mjs'),async()=>{thirdDispatched++;return{success:true}},scope),
   {code:'DIRECTORY_UNKNOWN'});
 assert.equal(thirdDispatched,0,'The old unknown result is no longer an active in-flight exception.');
});
test('independent observation-only reads can proceed while a write remains in flight',{timeout:20000},async()=>{
 const dir=await setup();let releaseFirst;
 const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
 const pending=dir.execute(tool('src/a.mjs'),async()=>{await firstGate;return{success:true}},scope);
 const read=await dir.execute({name:'relay_workspace',arguments:{action:'read',path:'README.md'}},
   async()=>({success:true}),{...scope,observationOnly:true});
 assert.equal(read.result.success,true);
 releaseFirst();await pending;
 assert.equal(dir.read().receipts.length,2);
 assert.equal(dir.read().receipts.every(row=>row.state==='returned'),true);
});

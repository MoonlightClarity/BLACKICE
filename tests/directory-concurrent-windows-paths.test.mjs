import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';

const opts={runId:'run-windows',nodeId:'agent-windows'};
const tool=path=>({name:'relay_workspace',arguments:{action:'write',path,text:'fixed'}});
async function fixture(){
 const directory=new TaskActionDirectory({taskId:'task-windows',objective:'Repair two files'});
 await directory.edit({action:'plan',revision:0,actions:[{id:'repair',objective:'Fix source',dependsOn:[]}]});
 await directory.edit({action:'focus',revision:directory.read().revision,id:'repair'});
 return directory;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('simultaneous writes to two absolute Win32 files both dispatch while the first remains active',{timeout:20000},async()=>{
 const dir=await fixture(),seen=[];
 let release;const barrier=new Promise(resolve=>{release=resolve;});
 const first=dir.execute(tool('C:\\work\\src\\ledger.mjs'),async()=>{seen.push('ledger');await barrier;return{success:true}},opts);
 const second=dir.execute(tool('C:\\work\\src\\processor.mjs'),async()=>{seen.push('processor');return{success:true}},opts);
 const settled=Promise.all([first,second]);
 for(let i=0;i<20&&seen.length<2;i++)await tick();
 assert.deepEqual(seen,['ledger','processor'],'Different absolute target files must not be mistaken for duplicates.');
 release();
 const result=await settled;
 assert.deepEqual(result.map(x=>x.receiptId),['receipt-1','receipt-2']);
 assert.equal(dir.read().receipts.every(x=>x.state==='returned'&&x.success===true),true);
});
test('mixed-case and slash aliases of the same Win32 target are not admitted in parallel',{timeout:20000},async()=>{
 const dir=await fixture();let release,dispatched=0;
 const barrier=new Promise(resolve=>{release=resolve;});
 const first=dir.execute(tool('C:\\work\\src\\ledger.mjs'),async()=>{await barrier;return{success:true}},opts);
 const second=dir.execute(tool('c:/WORK/src/LEDGER.mjs'),async()=>{dispatched++;return{success:true}},opts);
 const all=Promise.allSettled([first,second]);
 await tick();release();
 const results=await all;
 assert.equal(results[0].status,'fulfilled');
 assert.equal(results[1].status,'rejected');
 assert.equal(results[1].reason.code,'DIRECTORY_UNKNOWN');
 assert.equal(dispatched,0);
 assert.equal(dir.read().receipts.length,1);
});

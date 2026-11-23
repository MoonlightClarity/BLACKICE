import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TaskExternalContextStore} from '../lib/task-external-context.mjs';

async function setup(t,settings={}){
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-adaptive-context-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 return new TaskExternalContextStore({
  dataDir,taskId:'adaptive-task',thresholdBytes:500,
  visibleResultBudgetBytes:4200,forcePageBytes:6400,...settings,
 });
}
const call={name:'relay_workspace',arguments:{action:'read',path:'sample.txt'}};
const result=text=>({success:true,contentItems:[{type:'inputText',text}]});
const reference=answer=>JSON.parse(answer.contentItems[0].text).reference;

test('adaptive policy preserves modest evidence inline and pages only after cumulative volume',async t=>{
 const store=await setup(t);
 const text='source content '.repeat(110); // 1,650 bytes
 const first=await store.archiveResult(call,result(text));
 const second=await store.archiveResult(call,result(text));
 assert.equal(first.contentItems[0].text,text);
 assert.equal(second.contentItems[0].text,text);
 const third=await store.archiveResult(call,result(text));
 assert(reference(third),'Third observation crosses the visible budget.');
 const fourth=await store.archiveResult(call,result(text));
 assert.equal(reference(fourth),reference(third),'Repeated tool text remains deduplicated.');
 assert.equal((await store.read({reference:reference(third),maxBytes:4096})).text,text);
 assert.equal((await readdir(store.root)).length,2);
 assert(store.exposedBytes>3000);
});
test('very large single tool output pages even with unused visible budget',async t=>{
 const store=await setup(t,{visibleResultBudgetBytes:300000,forcePageBytes:6000});
 const huge='x'.repeat(7000);
 const observed=await store.archiveResult(call,result(huge));
 assert(reference(observed));
 assert(!observed.contentItems[0].text.includes('x'.repeat(1500)));
});
test('small results pass through and count toward pressure without creating artifacts',async t=>{
 const store=await setup(t,{visibleResultBudgetBytes:1200,forcePageBytes:6400});
 const small='s'.repeat(350);
 for(let n=0;n<5;n++)assert.strictEqual(await store.archiveResult(call,result(small)).then(x=>x.contentItems[0].text),small);
 assert.equal(store.exposedBytes,5*small.length);
 const big=await store.archiveResult(call,result('b'.repeat(1600)));
 assert(reference(big),'Short outputs consume capacity but remain intact.');
});
test('archive failure returns complete original and charges its visibility even when an earlier block was reserved',async t=>{
 const store=await setup(t,{visibleResultBudgetBytes:1800,forcePageBytes:6400});
 const before=store.exposedBytes;
 const original=result('a'.repeat(2000));
 store.save=async()=>{throw Error('simulated full disk');};
 const answer=await store.archiveResult(call,original);
 assert.strictEqual(answer,original);
 assert.equal(store.exposedBytes-before,2000);
});
test('concurrent result calls reserve visibility, rather than each consuming the last budget slot',async t=>{
 const store=await setup(t,{visibleResultBudgetBytes:2000,forcePageBytes:6400});
 const text='z'.repeat(1500);
 const answers=await Promise.all(Array.from({length:15},()=>store.archiveResult(call,result(text))));
 const full=answers.filter(x=>x.contentItems[0].text===text);
 const pointers=answers.filter(x=>x.contentItems[0].text!==text);
 assert.equal(full.length,1);
 assert.equal(pointers.length,14);
 assert.equal(new Set(pointers.map(reference)).size,1);
 assert.equal((await readdir(store.root)).length,2);
});
test('resumed store can read an artifact even when its current task budget starts fresh',async t=>{
 const store=await setup(t,{visibleResultBudgetBytes:2000});
 await store.archiveResult(call,result('a'.repeat(1600)));
 const pointer=await store.archiveResult(call,result('b'.repeat(1600)));
 const resumed=new TaskExternalContextStore({dataDir:path.dirname(path.dirname(store.root)),taskId:'adaptive-task',visibleResultBudgetBytes:2000});
 assert.equal((await resumed.read({reference:reference(pointer),maxBytes:4096})).text,'b'.repeat(1600));
});

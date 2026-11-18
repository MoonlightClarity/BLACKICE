import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {UserTodoStore} from '../lib/user-todos.mjs';
const human={source:'human'};
async function fixture(t){
 const dataDir=await fs.mkdtemp(path.join(tmpdir(),'blackice-user-todo-'));
 const store=await new UserTodoStore({dataDir}).init();
 t.after(async()=>{await store.close();assert.match(path.basename(dataDir),/^blackice-user-todo-/);await fs.rm(dataDir,{recursive:true,force:true});});
 return{store,dataDir};
}
const create=(id,parentId=null,extra={})=>({action:'create',id,parentId,title:'Task '+id,...extra});
const apply=async(store,args)=>store.apply({expectedRevision:(await store.snapshot()).revision,...args},human);
test('starts empty without importing legacy orchestration and persists exact nested data',async t=>{
 const {store,dataDir}=await fixture(t);
 await fs.writeFile(path.join(dataDir,'swarm.json'),'legacy data stays untouched');
 assert.deepEqual(await store.snapshot(),{revision:0,items:[]});
 assert.deepEqual((await fs.readdir(dataDir)),['swarm.json']);
 await apply(store,create('parent'));await apply(store,create('child','parent'));
 const saved=await store.snapshot();assert.deepEqual(saved,{revision:2,items:[
  {id:'parent',parentId:null,title:'Task parent',completed:false,position:0},
  {id:'child',parentId:'parent',title:'Task child',completed:false,position:0}]});
 saved.items[0].title='Mutated return';assert.equal((await store.snapshot()).items[0].title,'Task parent');
 const reopened=await new UserTodoStore({dataDir}).init();t.after(()=>reopened.close());
 assert.deepEqual(await reopened.snapshot(),await store.snapshot());
 assert.equal(await fs.readFile(path.join(dataDir,'swarm.json'),'utf8'),'legacy data stays untouched');
});
test('insert and move keep stable contiguous sibling order; removal deletes only subtree',async t=>{
 const {store}=await fixture(t);
 for(const row of [create('a'),create('b'),create('c',null,{position:1}),create('child','a'),create('grandchild','child')])await apply(store,row);
 let s=await store.snapshot();assert.deepEqual(s.items.filter(x=>x.parentId===null).map(x=>x.id),['a','c','b']);
 await apply(store,{action:'move',id:'b',parentId:null,position:0});
 await apply(store,{action:'move',id:'c',parentId:'a',position:0});
 s=await store.snapshot();assert.deepEqual(s.items.map(x=>x.id),['b','a','c','child','grandchild']);
 assert.deepEqual(s.items.filter(x=>x.parentId==='a').map(x=>x.position),[0,1]);
 await apply(store,{action:'update',id:'a',completed:true,title:'Parent complete'});
 assert.equal((await store.snapshot()).items.find(x=>x.id==='child').completed,false,'Completion is not silently propagated.');
 await apply(store,{action:'remove',id:'a'});
 assert.deepEqual((await store.snapshot()).items,[{id:'b',parentId:null,title:'Task b',completed:false,position:0}]);
});
test('unknown fields, wrong actions, invalid types and model mutation are rejected without changing data',async t=>{
 const {store}=await fixture(t);
 await assert.rejects(store.apply({expectedRevision:0,...create('a')}),{code:'USER_TODO_HUMAN_REQUIRED'});
 await assert.rejects(store.apply({expectedRevision:0,...create('a')},{source:'model'}),{code:'USER_TODO_HUMAN_REQUIRED'});
 for(const mutation of [
  {...create('a'),title:''},{...create('a'),title:'x'.repeat(1001)},{...create('a'),title:'😀'.repeat(251)},
  {...create('a'),completed:1},{...create('a'),position:-1},{...create('a'),schedule:'daily'},
  {action:'update',id:'a',parentId:null,title:'x'},{action:'update',id:'a'},
  {action:'remove',id:'a',title:'ignored'},{action:'move',id:'a',parentId:null,completed:true},
  {action:'move',id:'a'},{...create('../bad')},{...create('a'),requestId:''},{action:'execute'},{action:'__proto__'},{action:'constructor'},
 ])await assert.rejects(store.apply({expectedRevision:0,...mutation},human),{code:'USER_TODO_INVALID'});
 assert.deepEqual(await store.snapshot(),{revision:0,items:[]});
});
test('invalid parents, cycles, positions and excessive depth fail atomically',async t=>{
 const {store}=await fixture(t);
 await apply(store,create('a'));await apply(store,create('b','a'));
 const before=await fs.readFile(store.file,'utf8');
 for(const mutation of [{action:'move',id:'a',parentId:'b'},{action:'move',id:'a',parentId:'a'},create('c','missing'),{action:'move',id:'b',parentId:'missing'},{action:'move',id:'a',parentId:null,position:8}]){
  await assert.rejects(apply(store,mutation));assert.equal(await fs.readFile(store.file,'utf8'),before);
 }
 for(let i=2;i<32;i++)await apply(store,create('depth-'+i,i===2?'b':'depth-'+(i-1)));
 await assert.rejects(apply(store,create('too-deep','depth-31')),/32 levels/);
 assert.equal((await store.snapshot()).items.length,32);
});
test('same request replays without writing after intervening edits and restart; changed payload conflicts',async t=>{
 const {store,dataDir}=await fixture(t);
 const request={expectedRevision:0,requestId:'create-receipt',...create('a')};
 await store.apply(request,human);
 await apply(store,{action:'update',id:'a',title:'Edited later',requestId:'edit-receipt'});
 const current=await store.snapshot(),before=await fs.readFile(store.file,'utf8');
 const rename=t.mock.method(fs,'rename',async()=>assert.fail('Replay must not write'));
 assert.deepEqual(await store.apply({...request},human),current);
 const reopened=await new UserTodoStore({dataDir}).init();t.after(()=>reopened.close());
 assert.deepEqual(await reopened.apply(request,human),current);
 await assert.rejects(store.apply({...request,title:'Changed replay'},human),{code:'USER_TODO_CONFLICT'});
 assert.equal(await fs.readFile(store.file,'utf8'),before);rename.mock.restore();
 const removal={expectedRevision:2,requestId:'remove-receipt',action:'remove',id:'a'};
 await store.apply(removal,human);await apply(store,create('b'));
 assert.deepEqual(await store.apply(removal,human),await store.snapshot());
});
test('concurrent stale revisions cannot overwrite each other; receipt replay same call commits once',async t=>{
 const {store}=await fixture(t);
 const results=await Promise.allSettled([store.apply({expectedRevision:0,...create('a')},human),store.apply({expectedRevision:0,...create('b')},human)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.find(x=>x.status==='rejected').reason.code,'USER_TODO_CONFLICT');
 const request={expectedRevision:1,requestId:'same-create',...create('c')};
 const [a,b]=await Promise.all([store.apply(request,human),store.apply(request,human)]);
 assert.deepEqual(a,b);assert.equal(a.revision,2);assert.equal(a.items.length,2);
 await fs.writeFile(store.lockFile,'owned elsewhere');
 await assert.rejects(apply(store,{action:'update',id:'a',completed:true}),{code:'USER_TODO_CONFLICT'});
 assert.equal(await fs.readFile(store.lockFile,'utf8'),'owned elsewhere');await fs.unlink(store.lockFile);
});
test('failed atomic rename preserves original file and permits retry with same request',async t=>{
 const {store}=await fixture(t);await apply(store,create('a'));
 const before=await fs.readFile(store.file,'utf8');
 const rename=t.mock.method(fs,'rename',async()=>{throw Error('Synthetic rename failure');});
 const request={expectedRevision:1,requestId:'retry-rename',action:'update',id:'a',completed:true};
 await assert.rejects(store.apply(request,human),/Synthetic rename failure/);
 assert.equal(await fs.readFile(store.file,'utf8'),before);
 assert.ok(!(await fs.readdir(store.dataDir)).some(x=>x.endsWith('.tmp')||x.endsWith('.lock')));
 rename.mock.restore();assert.equal((await store.apply(request,human)).items[0].completed,true);
});
test('malformed disk state is preserved and fails closed',async t=>{
 const {store}=await fixture(t);
 for(const text of ['{broken',JSON.stringify({version:1,revision:0,items:[{id:'a',parentId:'a',title:'a',completed:false,position:0}],receipts:[]})]){
  await fs.writeFile(store.file,text);await assert.rejects(store.snapshot(),{code:'USER_TODO_LOAD_FAILED'});assert.equal(await fs.readFile(store.file,'utf8'),text);
 }
});
test('item and receipt caps are bounded; evicted old request fails revision check rather than replaying effects',async t=>{
 const {store}=await fixture(t);
 const first={expectedRevision:0,requestId:'first-receipt',...create('a')};await store.apply(first,human);
 for(let i=0;i<101;i++)await apply(store,{action:'update',id:'a',title:'Edit '+i,requestId:'edit-'+i});
 const doc=JSON.parse(await fs.readFile(store.file,'utf8'));assert.equal(doc.receipts.length,100);
 await assert.rejects(store.apply(first,human),{code:'USER_TODO_CONFLICT'});
 doc.items=Array.from({length:1000},(_,i)=>({id:'item-'+i,parentId:null,title:'Todo',completed:false,position:i}));
 await fs.writeFile(store.file,JSON.stringify(doc));
 await assert.rejects(apply(store,create('overflow')),/1000 TODO/);assert.equal((await store.snapshot()).items.length,1000);
 await store.close();await assert.rejects(apply(store,{action:'remove',id:'item-0'}),{code:'USER_TODO_CLOSED'});
});

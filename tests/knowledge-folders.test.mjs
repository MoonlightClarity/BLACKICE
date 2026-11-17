import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '../lib/knowledge.mjs';
async function setup(t) {
  const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-folders-test-'));
  const store=await new KnowledgeStore({dataDir}).init();
  t.after(async()=>{await store.writeChain;assert.match(path.basename(dataDir),/^blackice-folders-test-/);await rm(dataDir,{recursive:true,force:true});});
  return {dataDir,store};
}
const add=(store,title,extra={},provenance={source:'user'})=>store.upsert({kind:'memory',title,content:'Durable content',...extra},provenance);
test('folder lifecycle changes only organization and preserves applicability, provenance, bytes and history',async t=>{
  const {store,dataDir}=await setup(t);
  const first=await add(store,'Decision',{cwd:path.join(dataDir,'project')},{source:'agent',nodeId:'learning-one',reason:'Automatic learning'});
  await store.upsert({id:first.id,kind:'memory',title:'Decision revised',content:'Revised content',expectedRevision:1});
  const before=await readFile(store.file,'utf8'),history=store.history(first.id),context=store.context(first.cwd);
  let folders=await store.folders();assert.equal(folders.revision,1);
  folders=await store.organize({action:'create',name:'Research',expectedRevision:folders.revision});const id=folders.folders[0].id;
  folders=await store.organize({action:'move',entryIds:[first.id],folderId:id,expectedRevision:folders.revision});
  assert.equal(store.list({folderId:id})[0].id,first.id);assert.equal(store.list({folderId:''}).length,0);
  assert.deepEqual(store.context(first.cwd),context);
  folders=await store.organize({action:'rename',folderId:id,name:'Project notes',expectedRevision:folders.revision});
  assert.equal(folders.folders[0].name,'Project notes');
  const reopened=await new KnowledgeStore({dataDir}).init();assert.equal(reopened.list({folderId:id})[0].id,first.id);
  folders=await store.organize({action:'remove',folderId:id,expectedRevision:folders.revision});
  assert.equal(store.list({folderId:''}).length,1);assert.equal(folders.folders.length,0);
  assert.equal(await readFile(store.file,'utf8'),before);assert.deepEqual(store.history(first.id),history);
});
test('source filters separate learned lessons from ordinary agent notes and users',async t=>{
  const {store}=await setup(t);
  const user=await add(store,'Mine');const agent=await add(store,'Agent',{}, {source:'agent',nodeId:'task-one'});const learned=await add(store,'Learned',{}, {source:'agent',nodeId:'learning-one'});
  assert.deepEqual(store.list({source:'user'}).map(x=>x.id),[user.id]);assert.deepEqual(store.list({source:'agent'}).map(x=>x.id),[agent.id]);assert.deepEqual(store.list({source:'learned'}).map(x=>x.id),[learned.id]);
  assert.equal(store.list({source:'all'}).length,3);assert.throws(()=>store.list({source:'unknown'}));
});
test('folder writes reject stale revisions, duplicate names, missing targets and partial moves atomically',async t=>{
  const {store,dataDir}=await setup(t);const entry=await add(store,'Mine');
  let state=await store.organize({action:'create',name:'Work',expectedRevision:1});const folderId=state.folders[0].id;
  const other=await new KnowledgeStore({dataDir}).init();
  await assert.rejects(other.organize({action:'create',name:'Other',expectedRevision:1}),{status:409});
  await assert.rejects(store.organize({action:'create',name:'work',expectedRevision:state.revision}),{status:409});
  await assert.rejects(store.organize({action:'move',entryIds:[entry.id,'missing'],folderId,expectedRevision:state.revision}),{status:409});
  assert.deepEqual((await store.folders()).assignments,{});
  state=await store.organize({action:'move',entryIds:[entry.id],folderId,expectedRevision:state.revision});
  const deleted=await store.remove(entry.id);assert.equal(deleted.deleted,true);
  await assert.rejects(store.organize({action:'move',entryIds:[entry.id],folderId:null,expectedRevision:state.revision}),{status:409});
  assert.equal(store.list().length,0);assert.equal(store.history(entry.id).deleted,true);
});
test('corrupt organization metadata fails closed and keeps original bytes',async t=>{
  const {store,dataDir}=await setup(t);await writeFile(store.organizationFile,'broken');
  await assert.rejects(store.folders());const reopened=await new KnowledgeStore({dataDir}).init();
  assert.deepEqual(reopened.list(),[]);await assert.rejects(reopened.folders());assert.throws(()=>reopened.list({folderId:''}),{status:503});
  assert.equal(await readFile(store.organizationFile,'utf8'),'broken');
});

test('nested folders persist, validate parents and promote children without touching saved content',async t=>{
 const {store,dataDir}=await setup(t);const entry=await add(store,'Nested');const before=await readFile(store.file,'utf8');
 let state=await store.organize({action:'create',name:'Research',expectedRevision:1});const parent=state.folders[0].id;
 state=await store.organize({action:'create',name:'Applications',parentId:parent,expectedRevision:state.revision});const child=state.folders[1].id;
 state=await store.organize({action:'move',entryIds:[entry.id],folderId:child,expectedRevision:state.revision});
 const reopened=await new KnowledgeStore({dataDir}).init();assert.equal((await reopened.folders()).folders[1].parentId,parent);assert.equal(reopened.list({folderId:child})[0].id,entry.id);
 await assert.rejects(store.organize({action:'create',name:'Invalid',parentId:'missing',expectedRevision:state.revision}),{status:404});
 state=await store.organize({action:'remove',folderId:parent,expectedRevision:state.revision});assert.equal(state.folders[0].parentId,null);assert.equal(state.assignments[entry.id],child);assert.equal(await readFile(store.file,'utf8'),before);
 const corrupt={...state,folders:[{...state.folders[0],parentId:child}]};await writeFile(store.organizationFile,JSON.stringify(corrupt));await assert.rejects(store.folders(),/hierarchy/);
});

test('existing folders can move under another folder but never form a cycle',async t=>{
 const {store}=await setup(t);let s=await store.organize({action:'create',name:'One',expectedRevision:1});const one=s.folders[0].id;
 s=await store.organize({action:'create',name:'Two',expectedRevision:s.revision});const two=s.folders[1].id;
 s=await store.organize({action:'reparent',folderId:two,parentId:one,expectedRevision:s.revision});assert.equal(s.folders[1].parentId,one);
 await assert.rejects(store.organize({action:'reparent',folderId:one,parentId:two,expectedRevision:s.revision}),{status:409});
 await assert.rejects(store.organize({action:'reparent',folderId:one,parentId:one,expectedRevision:s.revision}),{status:409});
 s=await store.organize({action:'reparent',folderId:two,parentId:null,expectedRevision:s.revision});assert.equal(s.folders[1].parentId,null);
});

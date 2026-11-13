import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StorageManager, STORAGE_CATEGORIES } from '../lib/storage-management.mjs';

async function setup(t, customWorkspace = false) {
  const root = await mkdtemp(path.join(os.tmpdir(),'blackice-storage-test-'));
  t.after(async()=>await rm(root,{recursive:true,force:true}));
  const profile = path.join(root,'profile'), dataDir = path.join(profile,'data');
  const workspaceDir = customWorkspace ? path.join(root,'user-workspace') : path.join(profile,'workspace');
  await mkdir(dataDir,{recursive:true});
  await mkdir(workspaceDir,{recursive:true});
  return {root,profile,dataDir,workspaceDir,manager:new StorageManager({dataDir,workspaceDir})};
}
const exists = async name => { try { await access(name); return true; } catch { return false; } };

test('storage categories are disjoint and fixed',()=>{
  const targets=new Set();
  for(const category of STORAGE_CATEGORIES)for(const [scope,name] of category.targets){
    const key=scope+':'+name;
    assert.ok(!targets.has(key),'overlapping category target '+key);
    targets.add(key);
    assert.ok(!name.includes('..')&&!path.isAbsolute(name),'untrusted target');
  }
  assert.ok(STORAGE_CATEGORIES.some(c=>c.id==='vm'&&!c.deletable));
});

test('preview, queue, cancel, and startup cleanup delete only selected managed paths',async t=>{
  const {dataDir,profile,workspaceDir,manager}=await setup(t);
  await mkdir(path.join(dataDir,'conversations'));
  await writeFile(path.join(dataDir,'conversations','turn.json'),'history');
  await writeFile(path.join(dataDir,'knowledge.json'),'valuable context');
  await writeFile(path.join(workspaceDir,'user-doc.txt'),'my work');
  await mkdir(path.join(dataDir,'workbench-vm'));
  await writeFile(path.join(dataDir,'workbench-vm','disk.vhdx'),'disk');
  const overview=await manager.overview();
  assert.equal(overview.categories.find(x=>x.id==='conversations').bytes,7);
  assert.equal(overview.categories.find(x=>x.id==='vm').bytes,4);
  await assert.rejects(manager.schedule({categories:['conversations'],confirmation:'yes'}),/DELETE SELECTED DATA/);
  await assert.rejects(manager.schedule({categories:['vm'],confirmation:'DELETE SELECTED DATA'}),/protected/);
  await manager.schedule({categories:['conversations'],confirmation:'DELETE SELECTED DATA'});
  assert.equal((await manager.pending()).categories[0],'conversations');
  assert.ok(await exists(path.join(dataDir,'conversations','turn.json')),'queue is non-destructive');
  assert.deepEqual(await manager.cancel(),{cancelled:true,partial:false});
  assert.ok(await exists(path.join(dataDir,'conversations','turn.json')));
  await manager.schedule({categories:['conversations'],confirmation:'DELETE SELECTED DATA'});
  const fresh=new StorageManager({dataDir,workspaceDir});
  const report=await fresh.applyAtStartup();
  assert.deepEqual(report.categories,['conversations']);
  assert.equal(report.bytesInspected,7);
  assert.equal(await fresh.pending(),null);
  assert.equal(await exists(path.join(dataDir,'conversations','turn.json')),false);
  assert.equal(await readFile(path.join(dataDir,'knowledge.json'),'utf8'),'valuable context');
  assert.equal(await readFile(path.join(workspaceDir,'user-doc.txt'),'utf8'),'my work');
  assert.equal(await readFile(path.join(dataDir,'workbench-vm','disk.vhdx'),'utf8'),'disk');
  assert.equal((await fresh.overview()).lastCleanup.filesInspected,1);
});

test('app-managed workspace can be cleared but custom external workspace is excluded',async t=>{
  const {dataDir,workspaceDir,manager}=await setup(t,true);
  await mkdir(path.join(dataDir,'workspace'),{recursive:true});
  await writeFile(path.join(dataDir,'workspace','scratch.txt'),'internal');
  await writeFile(path.join(workspaceDir,'keep.txt'),'custom');
  await manager.schedule({categories:['workspaceFiles'],confirmation:'DELETE SELECTED DATA'});
  await manager.applyAtStartup();
  assert.equal(await exists(path.join(dataDir,'workspace','scratch.txt')),false);
  assert.equal(await readFile(path.join(workspaceDir,'keep.txt'),'utf8'),'custom');
  assert.equal((await manager.overview()).externalWorkspace,workspaceDir);
});

test('workspace metadata cleanup never removes managed working files',async t=>{
  const {dataDir,workspaceDir,manager}=await setup(t);
  await writeFile(path.join(dataDir,'projects.json'),'[]');
  await writeFile(path.join(workspaceDir,'work.txt'),'preserve work');
  await manager.schedule({categories:['workspaces'],confirmation:'DELETE SELECTED DATA'});
  await manager.applyAtStartup();
  assert.equal(await exists(path.join(dataDir,'projects.json')),false);
  assert.equal(await readFile(path.join(workspaceDir,'work.txt'),'utf8'),'preserve work');
});

test('automatic startup policy clears only temporary data and retains history',async t=>{
  const {dataDir,manager}=await setup(t);
  await mkdir(path.join(dataDir,'frontend-development'));
  await writeFile(path.join(dataDir,'frontend-development','render.log'),'temp');
  await mkdir(path.join(dataDir,'conversations'));
  await writeFile(path.join(dataDir,'conversations','turn.json'),'chat');
  await manager.configurePolicy({autoClearTemporaryOnStartup:true});
  const report=await new StorageManager({dataDir}).applyAtStartup();
  assert.deepEqual(report.categories,['temporary']);
  assert.equal(await exists(path.join(dataDir,'frontend-development','render.log')),false);
  assert.equal(await readFile(path.join(dataDir,'conversations','turn.json'),'utf8'),'chat');
  assert.equal((await manager.policy()).autoClearTemporaryOnStartup,true);
});

test('a live direct-execution owner prevents clearing queued history',async t=>{
  const {dataDir,manager}=await setup(t);
  await mkdir(path.join(dataDir,'direct-execution-jobs'));
  await writeFile(path.join(dataDir,'direct-execution-jobs','executor.lock'),
    JSON.stringify({version:1,pid:process.pid,token:'test'}));
  await mkdir(path.join(dataDir,'conversations'));
  await writeFile(path.join(dataDir,'conversations','turn.json'),'chat');
  await manager.schedule({categories:['conversations'],confirmation:'DELETE SELECTED DATA'});
  await assert.rejects(manager.applyAtStartup(),/Another BLACKICE process/);
  assert.ok(await manager.pending());
  assert.equal(await readFile(path.join(dataDir,'conversations','turn.json'),'utf8'),'chat');
});


test('interrupted cleanup never retries automatically and cancellation admits partial results',async t=>{
  const {dataDir,workspaceDir,manager}=await setup(t);
  await mkdir(path.join(dataDir,'conversations'),{recursive:true});
  await writeFile(path.join(dataDir,'conversations','turn.json'),'keep');
  await manager.schedule({categories:['conversations'],confirmation:'DELETE SELECTED DATA'});
  const pending=JSON.parse(await readFile(manager.pendingFile,'utf8'));
  await writeFile(manager.pendingFile,JSON.stringify({...pending,status:'applying',startedAt:new Date().toISOString()}));
  const restarted=new StorageManager({dataDir,workspaceDir});
  await assert.rejects(restarted.applyAtStartup(),/interrupted/i);
  assert.equal(await readFile(path.join(dataDir,'conversations','turn.json'),'utf8'),'keep');
  assert.equal((await restarted.pending()).status,'applying');
  const cancelled=await restarted.cancel();
  assert.deepEqual(cancelled,{cancelled:true,partial:true});
  assert.equal(await restarted.pending(),null);
  assert.equal(await readFile(path.join(dataDir,'conversations','turn.json'),'utf8'),'keep');
  await restarted.schedule({categories:['conversations'],confirmation:'DELETE SELECTED DATA'});
  await restarted.applyAtStartup();
  assert.equal(await exists(path.join(dataDir,'conversations','turn.json')),false);
});

test('a queued cleanup can be cancelled without implying that data was removed',async t=>{
  const {dataDir,manager}=await setup(t);
  await manager.schedule({categories:['context'],confirmation:'DELETE SELECTED DATA'});
  assert.deepEqual(await manager.cancel(),{cancelled:true,partial:false});
  assert.deepEqual(await manager.cancel(),{cancelled:false,partial:false});
});

test('unsafe filesystem links cannot be queued or cleared',async t=>{
  const {dataDir,root,manager}=await setup(t);
  const outside=path.join(root,'outside.txt');
  await writeFile(outside,'keep');
  await mkdir(path.join(dataDir,'conversations'));
  const link=path.join(dataDir,'conversations','outside-link');
  try{await symlink(outside,link,'file');}
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code))return t.skip('Windows symlinks not enabled');throw error;}
  await assert.rejects(manager.schedule({categories:['conversations'],confirmation:'DELETE SELECTED DATA'}),/link/);
  assert.equal(await readFile(outside,'utf8'),'keep');
});

test('selective workspace cleanup retains siblings and supports names containing x and zero',async t=>{
 const {dataDir,workspaceDir,manager}=await setup(t);
 await writeFile(path.join(workspaceDir,'experiment0.txt'),'remove');
 await writeFile(path.join(workspaceDir,'keep.txt'),'keep');
 const list=await manager.workspaceItems(),item=list.entries.find(x=>x.name==='experiment0.txt');
 assert.equal(item.selectable,true);
 await manager.schedule({workspaceEntries:[item.id],confirmation:'DELETE SELECTED DATA'});
 assert.equal(await exists(path.join(workspaceDir,'experiment0.txt')),true);
 await new StorageManager({dataDir,workspaceDir}).applyAtStartup();
 assert.equal(await exists(path.join(workspaceDir,'experiment0.txt')),false);
 assert.equal(await readFile(path.join(workspaceDir,'keep.txt'),'utf8'),'keep');
});
test('linked folders remain protected while safe nested children can be selected',async t=>{
 const {root,workspaceDir,manager}=await setup(t);
 await mkdir(path.join(workspaceDir,'mixed'));
 await mkdir(path.join(root,'outside'));
 await writeFile(path.join(root,'outside','keep'),'outside');
 await symlink(path.join(root,'outside'),path.join(workspaceDir,'mixed','link'),'junction');
 await writeFile(path.join(workspaceDir,'mixed','safe.txt'),'safe');
 const folder=(await manager.workspaceItems()).entries.find(x=>x.name==='mixed');
 assert.equal(folder.selectable,false); assert.equal(folder.hasChildren,true);
 const nested=await manager.workspaceItems({parent:folder.id});
 assert.equal(nested.entries.find(x=>x.name==='link').selectable,false);
 const safe=nested.entries.find(x=>x.name==='safe.txt');
 await assert.rejects(manager.schedule({workspaceEntries:[folder.id],confirmation:'DELETE SELECTED DATA'}),/link/);
 await manager.schedule({workspaceEntries:[safe.id],confirmation:'DELETE SELECTED DATA'});
 await manager.applyAtStartup();
 assert.equal(await readFile(path.join(root,'outside','keep'),'utf8'),'outside');
 assert.equal(await exists(path.join(workspaceDir,'mixed','safe.txt')),false);
});
test('changed contents revoke saved cleanup rather than deleting unreviewed files',async t=>{
 const {workspaceDir,manager}=await setup(t);
 await mkdir(path.join(workspaceDir,'selected'));
 await writeFile(path.join(workspaceDir,'selected','a'),'a');
 const item=(await manager.workspaceItems()).entries[0];
 await manager.schedule({workspaceEntries:[item.id],confirmation:'DELETE SELECTED DATA'});
 await writeFile(path.join(workspaceDir,'selected','new'),'new');
 await assert.rejects(manager.applyAtStartup(),/changed/);
 assert.equal(await exists(path.join(workspaceDir,'selected','a')),true);
 assert.equal(await exists(path.join(workspaceDir,'selected','new')),true);
});
test('selection rejects forged tokens, overlapping folders, and path traversal',async t=>{
 const {workspaceDir,manager}=await setup(t);
 await mkdir(path.join(workspaceDir,'folder'));await writeFile(path.join(workspaceDir,'folder','child'),'a');
 const folder=(await manager.workspaceItems()).entries[0],child=(await manager.workspaceItems({parent:folder.id})).entries[0];
 await assert.rejects(manager.schedule({workspaceEntries:['../../outside'],confirmation:'DELETE SELECTED DATA'}),/expired/);
 await assert.rejects(manager.schedule({workspaceEntries:[folder.id,child.id],confirmation:'DELETE SELECTED DATA'}),/not both/);
 for(const relative of ['../outside','folder/../child','a\\b','a:b','bad\u0000name']){
   assert.throws(()=>manager.descriptor({rootIndex:1,relative,identity:'a',rootIdentity:'b'}),/Invalid/);
 }
});
test('replaced ancestor junction cannot redirect a queued selection',async t=>{
 const {root,workspaceDir,manager}=await setup(t);
 const folder=path.join(workspaceDir,'folder');await mkdir(folder);await writeFile(path.join(folder,'child'),'a');
 const item=(await manager.workspaceItems()).entries[0],child=(await manager.workspaceItems({parent:item.id})).entries[0];
 await manager.schedule({workspaceEntries:[child.id],confirmation:'DELETE SELECTED DATA'});
 await rm(folder,{recursive:true});await mkdir(path.join(root,'outside'));await writeFile(path.join(root,'outside','child'),'precious');
 await symlink(path.join(root,'outside'),folder,'junction');
 await assert.rejects(manager.applyAtStartup(),/link|changed/);
 assert.equal(await readFile(path.join(root,'outside','child'),'utf8'),'precious');
});
test('external configured workspaces never appear in selective cleanup',async t=>{
 const {workspaceDir,manager}=await setup(t,true);await writeFile(path.join(workspaceDir,'keep'),'precious');
 assert.deepEqual((await manager.workspaceItems()).entries,[]);
});

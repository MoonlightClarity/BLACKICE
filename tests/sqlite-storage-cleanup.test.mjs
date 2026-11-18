import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';import {StorageManager} from '../lib/storage-management.mjs';import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';
test('Storage & Data measures SQLite, preserves active and unselected receipts, and actually clears explicitly selected offline history',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-sqlite-cleanup-')),profile=path.join(root,'profile'),dataDir=path.join(profile,'data');await fs.mkdir(dataDir,{recursive:true});t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new DirectExecutionJobs({dataDir});await store.init();t.after(()=>store.close());const job=(await store.admit({ownerId:'owner',requestId:'uncertain',tool:'tool',arguments:{},requiredScopes:[],client:{id:'owner',scopes:[]},mutating:true})).job;await store.update(job.id,()=>({status:'running',dispatched:true,effects:{possible:true,confirmed:false}}));
 const originalArchive=path.join(dataDir,'direct-execution-jobs','preserved-original.json');await fs.writeFile(originalArchive,'original archive');
 const manager=new StorageManager({dataDir}),overview=await manager.overview(),measured=overview.categories.find(c=>c.id==='actions');
 const main=(await fs.stat(path.join(dataDir,'direct-execution.sqlite'))).size;assert.ok(measured.bytes>=main);assert.ok(measured.bytes>0);
 await manager.schedule({categories:['actions'],confirmation:'DELETE SELECTED DATA'});await assert.rejects(manager.applyAtStartup(),/owns the storage/);assert.equal((await store.get(job.id)).effects.possible,true);assert.equal(await fs.readFile(originalArchive,'utf8'),'original archive');
 await manager.cancel();await store.close();await manager.schedule({categories:['temporary'],confirmation:'DELETE SELECTED DATA'});await manager.applyAtStartup();
 const reopened=new DirectExecutionJobs({dataDir});await reopened.init();t.after(()=>reopened.close());assert.equal((await reopened.get(job.id)).effects.possible,true);await reopened.close();
 // Include crash sidecar paths in the explicit offline category selection.
 await fs.writeFile(path.join(dataDir,'direct-execution.sqlite-wal'),'test retained WAL');await fs.writeFile(path.join(dataDir,'direct-execution.sqlite-shm'),'test retained shared memory');
 await manager.schedule({categories:['actions'],confirmation:'DELETE SELECTED DATA'});const report=await manager.applyAtStartup();assert.ok(report.completedAt);assert.ok(report.bytesInspected>=main);
 for(const name of ['direct-execution.sqlite','direct-execution.sqlite-wal','direct-execution.sqlite-shm','direct-execution-jobs'])await assert.rejects(fs.stat(path.join(dataDir,name)),{code:'ENOENT'});
 const fresh=new DirectExecutionJobs({dataDir});await fresh.init();assert.equal((await fresh.counts()).total,0);await fresh.close();
});

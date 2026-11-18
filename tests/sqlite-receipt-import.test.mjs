import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';import {importReceipts} from '../scripts/import-sqlite-receipts.mjs';
test('offline import preserves source bytes, publishes dedup state, and refuses live or repeated import',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-import-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const seed=path.join(root,'seed'),source=path.join(root,'source');await fs.mkdir(seed);await fs.mkdir(source);const original=new DirectExecutionJobs({dataDir:seed});await original.init();
 const record=(await original.admit({ownerId:'owner',requestId:'once',tool:'tool',arguments:{},requiredScopes:[],client:{id:'owner',scopes:[]},mutating:true})).job;await original.close();
 await fs.mkdir(path.join(source,'direct-execution-jobs'));const file=path.join(source,'direct-execution-jobs',record.id+'.json'),bytes=JSON.stringify(record);await fs.writeFile(file,bytes);
 const report=await importReceipts({dataDir:source,stagingDir:path.join(root,'stage'),publish:true});assert.equal(report.count,1);assert.equal(await fs.readFile(file,'utf8'),bytes);
 const publishedInfo=await fs.stat(path.join(source,'direct-execution.sqlite')),stagedInfo=await fs.stat(path.join(root,'stage','direct-execution.sqlite'));
 assert.notEqual(publishedInfo.ino,stagedInfo.ino,'published database must not alias the retained staging database');
 const live=new DirectExecutionJobs({dataDir:source});t.after(()=>live.close());await live.init();assert.equal((await live.get(record.id)).status,'interrupted');assert.equal((await live.admit({ownerId:'owner',requestId:'once',tool:'tool',arguments:{},requiredScopes:[],client:{id:'owner',scopes:[]},mutating:true})).created,false);
 await assert.rejects(importReceipts({dataDir:source,stagingDir:path.join(root,'locked')}),{code:'DIRECT_JOB_LOCKED'});
 const staged=new DirectExecutionJobs({dataDir:path.join(root,'stage')});t.after(()=>staged.close());await staged.init();
 const input=requestId=>({ownerId:'owner',requestId,tool:'tool',arguments:{},requiredScopes:[],client:{id:'owner',scopes:[]},mutating:false});
 const liveOnly=await live.admit(input('live-only')),stageOnly=await staged.admit(input('stage-only'));
 await assert.rejects(live.get(stageOnly.job.id),{code:'DIRECT_JOB_NOT_FOUND'});await assert.rejects(staged.get(liveOnly.job.id),{code:'DIRECT_JOB_NOT_FOUND'});
 assert.equal((await live.counts()).total,2);assert.equal((await staged.counts()).total,2);
 await staged.close();await live.close();
 await assert.rejects(importReceipts({dataDir:source,stagingDir:path.join(root,'again')}),/already exists/);
});

test('publication refuses a destination appearing during publish and preserves its bytes',async t=>{
 const {publishIndependentDatabase}=await import('../scripts/import-sqlite-receipts.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-publish-race-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'stage');await fs.mkdir(source);const store=new DirectExecutionJobs({dataDir:source});await store.init();await store.close();
 const destinationFile=path.join(root,'destination.sqlite');
 await assert.rejects(publishIndependentDatabase({sourceFile:path.join(source,'direct-execution.sqlite'),destinationFile,expectedRecords:0,assertLease:async()=>{},io:{...fs,link:async(from,to)=>{await fs.writeFile(to,'existing database sentinel',{flag:'wx'});return fs.link(from,to);}}}),{code:'EEXIST'});
 assert.equal(await fs.readFile(destinationFile,'utf8'),'existing database sentinel');assert.equal((await fs.readdir(root)).some(name=>name.includes('.import-')),false);
});

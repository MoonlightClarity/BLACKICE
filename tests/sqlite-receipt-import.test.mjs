import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';import {importReceipts} from '../scripts/import-sqlite-receipts.mjs';
test('offline import preserves source bytes, publishes dedup state, and refuses live or repeated import',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-import-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const seed=path.join(root,'seed'),source=path.join(root,'source');await fs.mkdir(seed);await fs.mkdir(source);const original=new DirectExecutionJobs({dataDir:seed});await original.init();
 const record=(await original.admit({ownerId:'owner',requestId:'once',tool:'tool',arguments:{},requiredScopes:[],client:{id:'owner',scopes:[]},mutating:true})).job;await original.close();
 await fs.mkdir(path.join(source,'direct-execution-jobs'));const file=path.join(source,'direct-execution-jobs',record.id+'.json'),bytes=JSON.stringify(record);await fs.writeFile(file,bytes);
 const report=await importReceipts({dataDir:source,stagingDir:path.join(root,'stage'),publish:true});assert.equal(report.count,1);assert.equal(await fs.readFile(file,'utf8'),bytes);
 const live=new DirectExecutionJobs({dataDir:source});await live.init();assert.equal((await live.get(record.id)).status,'interrupted');assert.equal((await live.admit({ownerId:'owner',requestId:'once',tool:'tool',arguments:{},requiredScopes:[],client:{id:'owner',scopes:[]},mutating:true})).created,false);
 await assert.rejects(importReceipts({dataDir:source,stagingDir:path.join(root,'locked')}),{code:'DIRECT_JOB_LOCKED'});await live.close();
 await assert.rejects(importReceipts({dataDir:source,stagingDir:path.join(root,'again')}),/already exists/);
});

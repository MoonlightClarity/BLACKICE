import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';import {createProfileBackup,restoreProfileBackup} from '../lib/profile-backup.mjs';
test('offline profile backup includes crash WAL and restores committed dedup plus uncertain effects',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-wal-backup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const profileDir=path.join(root,'profile'),dataDir=path.join(profileDir,'data');await fs.mkdir(dataDir,{recursive:true});
 const moduleUrl=new URL('../lib/direct-execution-jobs.mjs',import.meta.url).href;
 const script=`import {DirectExecutionJobs} from ${JSON.stringify(moduleUrl)};import {writeSync} from 'node:fs';const store=new DirectExecutionJobs({dataDir:process.argv[1]});await store.init();const job=(await store.admit({ownerId:'owner',requestId:'committed',tool:'tool',arguments:{},requiredScopes:[],client:{id:'owner',scopes:[]},mutating:true})).job;await store.update(job.id,()=>({status:'running',dispatched:true}));writeSync(1,job.id);process.kill(process.pid,'SIGKILL');`;
 let id;try{await promisify(execFile)(process.execPath,['--input-type=module','-e',script,dataDir]);assert.fail('Child should exit abruptly');}catch(error){id=error.stdout;}
 assert.match(id,/^direct_[a-f0-9]{64}$/);assert.ok((await fs.stat(path.join(dataDir,'direct-execution.sqlite-wal'))).size>0);
 const args={profileDir,backupDir:path.join(root,'backup'),appVersion:'test',getBinding:async()=>({platform:'win32',userIdHash:'a'.repeat(64),machineIdHash:'b'.repeat(64)}),reparseCheck:async()=>{}};
 const backup=await createProfileBackup(args);assert.ok(backup.manifest.entries.some(e=>e.path==='data/direct-execution.sqlite-wal'));
 await restoreProfileBackup(args);const reopened=new DirectExecutionJobs({dataDir});await reopened.init();try{const job=await reopened.get(id);assert.equal(job.status,'interrupted');assert.equal(job.effects.possible,true);assert.equal((await reopened.admit({ownerId:'owner',requestId:'committed',tool:'tool',arguments:{},requiredScopes:[],client:{id:'owner',scopes:[]},mutating:true})).created,false);}finally{await reopened.close();}
});

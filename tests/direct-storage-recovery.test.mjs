import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';
import {DirectExecutionAPI} from '../lib/direct-execution-api.mjs';
const client={id:'recovery-owner',scopes:['read','files:read']};
const input=(requestId='original')=>({ownerId:client.id,requestId,tool:'blackice_workspace_read',arguments:{action:'read',path:'private-fixture-marker.txt'},requiredScopes:['files:read'],client,mutating:false});
async function fixture(t,{pending=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-startup-recovery-')),stores=[];
 const make=options=>{const s=new DirectExecutionJobs({dataDir:root,...options});stores.push(s);return s;};
 t.after(async()=>{for(const s of stores)await s.close().catch(()=>{});assert.ok(path.basename(root).startsWith('blackice-startup-recovery-'));await fs.rm(root,{recursive:true,force:true});});
 const original=make(),job=(await original.admit(input())).job;
 if(!pending)await original.update(job.id,()=>({status:'succeeded',finishedAt:new Date().toISOString(),result:{private:'never log this'}}));
 const bytes=await fs.readFile(original.file(job.id));await original.close();return {root,make,job,bytes,file:original.file(job.id)};
}
const denied=()=>Object.assign(Error('private-fixture-marker and command contents must never leak'),{code:'EACCES'});
test('restored startup read coalesces one rescan, clears both latches and retains original receipt identity without dispatch',async t=>{
 const f=await fixture(t);let blocked=true,scans=0,time=0;
 const jobs=f.make({clock:()=>time,io:{...fs,readdir:async(...a)=>{scans++;return fs.readdir(...a);},readFile:async(file,...a)=>{if(file===f.file&&blocked)throw denied();return fs.readFile(file,...a);}}});
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,jobs});t.after(()=>api.close());
 assert.equal((await api.status(client)).jobs.available,false);assert.equal(scans,1);assert.equal(api.storageFailedAtInit,true);
 assert.ok(api.storageError.message.includes(path.basename(f.file)));assert.ok(api.storageError.message.includes('EACCES'));assert.ok(!api.storageError.message.includes('private-fixture-marker'));
 blocked=false;await Promise.all(Array.from({length:20},()=>api.status(client)));assert.equal(scans,1);
 time=30000;await api.status(client);await jobs.ready;const restored=await Promise.all(Array.from({length:20},()=>api.status(client)));
 assert.ok(restored.every(x=>x.jobs.available));assert.equal(scans,2);assert.equal(api.storageError,null);assert.equal(jobs.storageError,null);assert.equal(api.storageFailedAtInit,false);
 const replay=await api.call('blackice_workspace_read',{requestId:'original',action:'read',path:'private-fixture-marker.txt'},client);
 assert.equal(replay.existing,true);assert.equal(replay.jobId,f.job.id);assert.equal(api.active.size,0);assert.equal(api.queue.length,0);assert.deepEqual(await fs.readFile(f.file),f.bytes);
});
test('permanent access failure is cooldown bounded and stops after three retries',async t=>{
 const f=await fixture(t);let scans=0,time=0;const jobs=f.make({clock:()=>time,io:{...fs,readdir:async(...a)=>{scans++;return fs.readdir(...a);},readFile:async(file,...a)=>{if(file===f.file)throw denied();return fs.readFile(file,...a);}}});
 await assert.rejects(jobs.init(),{code:'DIRECT_JOB_STORAGE'});
 for(let round=0;round<6;round++){time+=30000;await Promise.all(Array.from({length:20},()=>assert.rejects(jobs.init(),{code:'DIRECT_JOB_STORAGE'})));}
 assert.equal(scans,4);assert.equal(jobs.startup.retries,3);assert.equal(jobs.hasLease,false);assert.deepEqual(await fs.readFile(f.file),f.bytes);
});
test('receipt removed after failed enumeration remains required and is never treated as a new request',async t=>{
 const f=await fixture(t);let blocked=true,time=0;const jobs=f.make({clock:()=>time,io:{...fs,readFile:async(file,...a)=>{if(file===f.file&&blocked)throw denied();return fs.readFile(file,...a);}}});
 await assert.rejects(jobs.init());await fs.unlink(f.file);blocked=false;time=30000;
 await assert.rejects(jobs.admit(input()),{code:'DIRECT_JOB_STORAGE'});assert.ok(jobs.startup.names.has(path.basename(f.file)));assert.equal(jobs.records.size,0);
 await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});
test('corrupt startup receipt is not retryable even after bytes are restored',async t=>{
 const f=await fixture(t);let time=0,scans=0;await fs.writeFile(f.file,'{corrupt fixture');
 const jobs=f.make({clock:()=>time,io:{...fs,readdir:async(...a)=>{scans++;return fs.readdir(...a);}}});await assert.rejects(jobs.init());
 await fs.writeFile(f.file,f.bytes);time=999999;await assert.rejects(jobs.init());assert.equal(scans,1);assert.equal(jobs.startup.retryable,false);
});
test('recovered queued work is interrupted, never automatically dispatched or newly admitted',async t=>{
 const f=await fixture(t,{pending:true});let blocked=true,time=0;const jobs=f.make({clock:()=>time,io:{...fs,readFile:async(file,...a)=>{if(file===f.file&&blocked)throw denied();return fs.readFile(file,...a);}}});
 await assert.rejects(jobs.init());blocked=false;time=30000;await jobs.init();const same=await jobs.admit(input());
 assert.equal(same.created,false);assert.equal(same.job.id,f.job.id);assert.equal(same.job.status,'interrupted');assert.equal(same.job.dispatched,false);assert.equal(same.job.effects.possible,false);
});
test('uncertain recovery write never enters the read-retry path',async t=>{
 const f=await fixture(t,{pending:true});let time=0,renames=0;const jobs=f.make({clock:()=>time,io:{...fs,rename:async(...a)=>{renames++;await fs.rename(...a);throw Object.assign(Error('lost acknowledgement'),{code:'EIO'});}}});
 await assert.rejects(jobs.init(),{code:'DIRECT_JOB_STORAGE'});assert.equal(jobs.startup.retryable,false);time=999999;
 await assert.rejects(jobs.init());assert.equal(renames,1);assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).status,'interrupted');
});
test('runtime read failures remain latched rather than being cleared by startup recovery',async t=>{
 const f=await fixture(t);let blocked=false,time=0;const jobs=f.make({clock:()=>time,io:{...fs,readFile:async(file,...a)=>{if(file===f.file&&blocked)throw denied();return fs.readFile(file,...a);}}});
 await jobs.init();blocked=true;await assert.rejects(jobs.get(f.job.id));blocked=false;time=999999;
 await assert.rejects(jobs.admit(input()),{code:'DIRECT_JOB_STORAGE'});assert.equal(jobs.startup.retries,0);assert.deepEqual(await fs.readFile(f.file),f.bytes);
});

test('a validated receipt changed between startup attempts is an integrity failure, never silently reindexed',async t=>{
 const f=await fixture(t);const seed=f.make(),second=(await seed.admit(input('second'))).job;await seed.update(second.id,()=>({status:'succeeded',result:{ok:true}}));await seed.close();
 const secondFile=seed.file(second.id);let blocked=true,time=0;
 const jobs=f.make({clock:()=>time,io:{...fs,readFile:async(file,...a)=>{if(file===secondFile&&blocked){await new Promise(r=>setTimeout(r,10));throw denied();}return fs.readFile(file,...a);}}});
 await assert.rejects(jobs.init());assert.ok(jobs.startup.hashes.has(path.basename(f.file)));
 const changed=JSON.parse(f.bytes);changed.result={different:true};await fs.writeFile(f.file,JSON.stringify(changed));blocked=false;time=30000;
 await assert.rejects(jobs.init(),{code:'DIRECT_JOB_STORAGE'});assert.equal(jobs.startup.retryable,false);assert.equal(jobs.records.size,0);
});
test('concurrent corruption overrides transient access error and disables automatic retries',async t=>{
 const f=await fixture(t);const seed=f.make(),second=(await seed.admit(input('second'))).job;await seed.close();const other=seed.file(second.id);let time=0;
 const jobs=f.make({clock:()=>time,io:{...fs,readFile:async(file,...a)=>{if(file===f.file)throw denied();if(file===other){await new Promise(r=>setTimeout(r,10));return '{invalid';}return fs.readFile(file,...a);}}});
 await assert.rejects(jobs.init());assert.equal(jobs.startup.retryable,false);time=999999;await assert.rejects(jobs.init());assert.equal(jobs.startup.retries,0);
});
test('startup retry cannot steal a new live executor lease',async t=>{
 const f=await fixture(t);let blocked=true,time=0;const recovering=f.make({clock:()=>time,io:{...fs,readFile:async(file,...a)=>{if(file===f.file&&blocked)throw denied();return fs.readFile(file,...a);}}});
 await assert.rejects(recovering.init());blocked=false;const owner=f.make();await owner.init();const lease=await fs.readFile(owner.leaseFile);
 time=30000;await assert.rejects(recovering.init(),{code:'DIRECT_JOB_LOCKED'});assert.deepEqual(await fs.readFile(owner.leaseFile),lease);assert.equal(recovering.startup.retryable,false);assert.equal(owner.hasLease,true);
});

test('status returns recovering before a held full scan completes; concurrent probes never start another scan',async t=>{
 const f=await fixture(t);let blocked=true,time=0,scans=0,release;
 const gate=new Promise(r=>{release=r;});const cleanupTimer=setTimeout(()=>release(),2000);t.after(()=>clearTimeout(cleanupTimer));
 const jobs=f.make({clock:()=>time,io:{...fs,readdir:async(...a)=>{scans++;if(scans===2)await gate;return fs.readdir(...a);},readFile:async(file,...a)=>{if(file===f.file&&blocked)throw denied();return fs.readFile(file,...a);}}});
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,jobs});t.after(()=>api.close());
 await api.status(client);blocked=false;time=30000;
 const probes=await Promise.race([Promise.all(Array.from({length:20},()=>api.call('blackice_direct_status',{},client))),new Promise((_,reject)=>setTimeout(()=>reject(Error('Status waited for full recovery scan')),500))]);
 assert.ok(probes.every(p=>!p.available&&!p.jobs.available&&p.jobs.recovering));
 for(let i=0;i<100&&scans<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(scans,2);
 let settled=false;const request=api.call('blackice_workspace_read',{requestId:'original',action:'read',path:'private-fixture-marker.txt'},client).then(r=>{settled=true;return r;});
 await new Promise(r=>setTimeout(r,10));assert.equal(settled,false);assert.equal(api.active.size,0);
 release();const replay=await request;assert.equal(replay.existing,true);assert.equal((await api.status(client)).jobs.available,true);assert.equal(scans,2);
});
test('background recovery rejection is consumed and status remains honestly unavailable',async t=>{
 const f=await fixture(t);let time=0,scans=0,release;const gate=new Promise(r=>{release=r;});const cleanupTimer=setTimeout(()=>release(),2000);t.after(()=>clearTimeout(cleanupTimer));
 const jobs=f.make({clock:()=>time,io:{...fs,readdir:async(...a)=>{scans++;if(scans===2)await gate;return fs.readdir(...a);},readFile:async(file,...a)=>{if(file===f.file)throw denied();return fs.readFile(file,...a);}}});
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,jobs});t.after(()=>api.close());await api.status(client);time=30000;
 assert.equal((await api.status(client)).jobs.recovering,true);const recovery=api.storageRecovery;release();await recovery;
 const status=await api.status(client);assert.equal(status.available,false);assert.equal(status.jobs.recovering,false);assert.equal(scans,2);assert.equal(api.storageFailedAtInit,true);
});

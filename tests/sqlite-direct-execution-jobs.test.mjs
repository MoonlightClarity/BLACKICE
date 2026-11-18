import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DirectExecutionJobs,directRequestDigest} from '../lib/direct-execution-jobs.mjs';
const input=(id,mutating=true)=>({ownerId:'test-owner',requestId:id,tool:'test-action',arguments:{value:id},requiredScopes:[],client:{id:'test-owner',scopes:[]},mutating});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-sqlite-test-'));const stores=[];t.after(async()=>{for(const store of stores)await store.close();await fs.rm(dir,{recursive:true,force:true});});return {dir,open:async()=>{const s=new DirectExecutionJobs({dataDir:dir});stores.push(s);await s.init();return s;}};}
test('restart recovers only unfinished effects, never replays and does not read completed payloads',async t=>{
 const f=await fixture(t);let s=await f.open();const pending=(await s.admit(input('pending'))).job;const active=(await s.admit(input('active'))).job;await s.update(active.id,()=>({status:'running',dispatched:true}));
 const read=(await s.admit(input('read',false))).job;await s.update(read.id,()=>({status:'running',dispatched:true}));
 const done=(await s.admit(input('done'))).job;await s.update(done.id,()=>({status:'succeeded',result:{success:true}}));
 // Deliberately unreadable terminal JSON proves startup does not hydrate history.
 s.db.prepare('UPDATE payloads SET body=? WHERE id=?').run('not-json',done.id);await s.close();s=await f.open();
 assert.equal((await s.get(pending.id)).effects.possible,false);assert.equal((await s.get(active.id)).effects.possible,true);assert.equal((await s.get(read.id)).effects.possible,false);assert.equal((await s.counts()).unfinished,0);
 assert.equal((await s.get(active.id)).status,'interrupted');assert.equal(s.resourceHistory,undefined);
});
test('dedup survives restart, rejects changed arguments and isolates caller identities',async t=>{
 const f=await fixture(t);let s=await f.open();const a=input('same');const first=await s.admit(a);await s.update(first.job.id,()=>({status:'succeeded',result:{success:true}}));await s.close();s=await f.open();
 const again=await s.admit(a);assert.equal(again.created,false);assert.equal(again.job.id,first.job.id);
 await assert.rejects(s.admit({...a,arguments:{changed:true}}),{code:'DIRECT_REQUEST_CONFLICT'});
 assert.equal((await s.findRequest({ownerId:a.ownerId,requestId:a.requestId,requestDigest:directRequestDigest({tool:a.tool,arguments:a.arguments})})).id,first.job.id);
 await assert.rejects(s.get(first.job.id,{ownerId:'other'}),{code:'DIRECT_JOB_NOT_FOUND'});
 assert.equal((await s.list({ownerId:'other'})).total,0);
});
test('transactions roll back partial updates and prevent concurrent profile executors',async t=>{
 const f=await fixture(t);const s=await f.open();const a=(await s.admit(input('atomic'))).job;
 const second=new DirectExecutionJobs({dataDir:f.dir});await assert.rejects(second.init(),{code:'DIRECT_JOB_LOCKED'});
 assert.throws(()=>s.transaction(()=>{s.db.prepare('DELETE FROM payloads WHERE id=?').run(a.id);throw Error('simulated interruption');}));assert.equal((await s.get(a.id)).id,a.id);
 await assert.rejects(s.update(a.id,()=>({status:'succeeded'}),{expectedRevision:999}),{code:'DIRECT_JOB_CONFLICT'});
});
test('legacy receipts cannot be silently ignored; approval kind is not accepted',async t=>{
 const f=await fixture(t);const s=await f.open();await assert.rejects(s.admit({...input('approval'),interaction:{id:'old',kind:'approval'}}));
 await s.close();await fs.unlink(path.join(f.dir,'direct-execution.sqlite'));await fs.writeFile(path.join(f.dir,'direct-execution-jobs','direct_'+'a'.repeat(64)+'.json'),'{}');
 const newer=new DirectExecutionJobs({dataDir:f.dir});await assert.rejects(newer.init(),{code:'DIRECT_JOB_IMPORT_REQUIRED'});
});

test('explicit receipt hydration rejects altered arguments, and aliased SQLite files cannot open',async t=>{
 const f=await fixture(t);const s=await f.open(),job=(await s.admit(input('unchanged'))).job;
 const altered={...job,arguments:{value:'changed'}};s.db.prepare('UPDATE payloads SET body=? WHERE id=?').run(JSON.stringify(altered),job.id);
 await assert.rejects(s.get(job.id),{code:'DIRECT_JOB_STORAGE'});await s.close();
 const alias=path.join(f.dir,'alias.sqlite');await fs.link(path.join(f.dir,'direct-execution.sqlite'),alias);
 const next=new DirectExecutionJobs({dataDir:f.dir});await assert.rejects(next.init(),{code:'DIRECT_JOB_STORAGE'});
 assert.equal(await fs.readFile(alias,'utf8'),await fs.readFile(path.join(f.dir,'direct-execution.sqlite'),'utf8'));
});

test('lazy hydration rejects internally rehashed request that disagrees with durable dedup index',async t=>{
 const f=await fixture(t),s=await f.open(),job=(await s.admit(input('indexed-request'))).job;
 const changed={...job,arguments:{value:'different'}};changed.requestDigest=changed.storedRequestDigest=directRequestDigest({tool:changed.tool,arguments:changed.arguments});
 s.db.prepare('UPDATE payloads SET body=? WHERE id=?').run(JSON.stringify(changed),job.id);
 await assert.rejects(s.get(job.id),{code:'DIRECT_JOB_STORAGE'});assert.ok(s.storageError);
});

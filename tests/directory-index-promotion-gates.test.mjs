import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {DirectoryActionJournal} from '../lib/directory-action-journal.mjs';
import {DatabaseSync} from 'node:sqlite';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'directory-index-gate-')),j=new DirectoryActionJournal(root);t.after(async()=>{j.index?.close();await rm(root,{recursive:true,force:true});});return {j,root};}
test('unavailable SQLite import leaves a baseline journal writable without a format transition',async t=>{
 const {j,root}=await fixture(t);j._loadIndex=async()=>{throw Object.assign(Error('sqlite unavailable'),{code:'ERR_UNKNOWN_BUILTIN_MODULE'});};
 await assert.rejects(j.enableIndex({exclusiveWritersConfirmed:true}),{code:'ERR_UNKNOWN_BUILTIN_MODULE'});
 await assert.rejects(readFile(path.join(root,'indexed-format.json')),{code:'ENOENT'});
 await j.note('baseline',{actionId:'a'});assert.equal((await j.events()).length,1);
});
test('database open failure leaves baseline writable and retains the failed side file',async t=>{
 const {j,root}=await fixture(t),file=path.join(root,'action-index.sqlite');await writeFile(file,'not a sqlite database');
 await assert.rejects(j.enableIndex({exclusiveWritersConfirmed:true}));
 await assert.rejects(readFile(path.join(root,'indexed-format.json')),{code:'ENOENT'});
 assert.equal(await readFile(file,'utf8'),'not a sqlite database');await j.note('baseline',{actionId:'a'});
 assert.equal((await j.events()).length,1);
});
test('failed reopening never removes an established indexed writer boundary or unknown history',async t=>{
 const {j,root}=await fixture(t),index=await j.enableIndex({exclusiveWritersConfirmed:true});const attempt=await j.begin('unknown',{name:'send'},{});index.close();
 j._loadIndex=async()=>{throw Error('unavailable after transition');};await assert.rejects(j.enableIndex({exclusiveWritersConfirmed:true}),/unavailable/);
 assert.ok(await readFile(path.join(root,'indexed-format.json')));
 await assert.rejects(new DirectoryActionJournal(root).note('legacy',{actionId:'b'}),{code:'DIRECTORY_INDEX_WRITER_REQUIRED'});
 assert.equal((await j.events())[0].digest,attempt.digest);
});
test('omitted rows and corrupt visibility, unknown, edge and head metadata trigger full audit fallback',async t=>{
 const {j}=await fixture(t),index=await j.enableIndex({exclusiveWritersConfirmed:true});
 const attempt=await j.begin('click',{name:'relay_browser',arguments:{action:'click'}},{actionId:'a'}),outcome=await j.outcome(attempt,{success:false,code:'LOST_REPLY'},{receipt:'retained'});
 const first=await j.note('first',{actionId:'a'});await j.note('left',{actionId:'a',parent:first.id});await j.note('right',{actionId:'a',parent:first.id});
 assert.equal((await index.audit()).validatedEvents,5);
 const corruptions=[()=>index.db.prepare('DELETE FROM events WHERE id=?').run(outcome.id),()=>index.db.prepare('UPDATE events SET unknown=0,working=0 WHERE id=?').run(outcome.id),()=>index.db.exec('DELETE FROM edges'),()=>index.db.exec('UPDATE actions SET heads=1')];
 for(const corrupt of corruptions){
  corrupt();await assert.rejects(index.audit(),{code:'DIRECTORY_INDEX_INTEGRITY'});
  const read=await index.readVerified();assert.equal(read.mode,'full-validation-fallback');assert.equal(read.baseline.metadataCounts.unknownOutcomes,1);assert.equal(read.baseline.metadataCounts.conflicts,1);
  assert.equal((await j.events()).find(r=>r.id===outcome.id).digest,outcome.digest);
  await index.rebuild({exclusiveWritersConfirmed:true});assert.equal((await index.audit()).validatedEvents,5);
 }
});
test('lineage walk visits each edge once on long chains and rejects a cycle',async t=>{
 const {j}=await fixture(t),index=await j.enableIndex({exclusiveWritersConfirmed:true});
 const insert=index.db.prepare('INSERT INTO edges VALUES(?,?)');
 for(let i=1;i<4096;i++)insert.run(String(i),String(i-1));
 const result=index.assertAcyclic();assert.equal(result.edges,4095);assert.equal(result.edgesVisited,4095);assert.equal(result.verticesVisited,4096);
 insert.run('0','4095');assert.throws(()=>index.assertAcyclic(),{code:'DIRECTORY_INDEX_LINEAGE'});
});
test('integrity fallback fences writers during original reads and rejects unfinished publication',async t=>{
 const {j,root}=await fixture(t),index=await j.enableIndex({exclusiveWritersConfirmed:true});
 await j.note('first',{actionId:'a'});index.db.exec('DELETE FROM events');
 const other=new DatabaseSync(path.join(root,'action-index.sqlite'));other.exec('PRAGMA busy_timeout=1');
 const read=j.read.bind(j);let fenced=false;
 j.read=async options=>{assert.throws(()=>other.exec('BEGIN IMMEDIATE'),/locked|busy/i);fenced=true;return read(options);};
 try{assert.equal((await index.readVerified()).mode,'full-validation-fallback');assert.equal(fenced,true);}finally{other.close();}
 const audit=index.audit.bind(index);index.audit=async()=>{try{return await audit();}catch(error){await index.mark();throw error;}};
 await assert.rejects(index.readVerified(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
 assert.equal((await j.events()).length,1);
});

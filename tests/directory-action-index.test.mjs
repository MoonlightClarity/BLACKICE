import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DirectoryActionJournal} from '../lib/directory-action-journal.mjs';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'directory-index-'));const j=new DirectoryActionJournal(root);const index=await j.enableIndex({exclusiveWritersConfirmed:true});t.after(async()=>{j.index?.close();index.close();await rm(root,{recursive:true,force:true});});return {j,index,root};}
test('indexed keyset pages validate selected originals and preserve unknown effects and revision forks',async t=>{
 const {j,index}=await fixture(t),root=await j.note('root',{actionId:'a'});
 const [left,right]=await Promise.all([j.note('l',{actionId:'a',parent:root.id}),j.note('r',{actionId:'a',parent:root.id})]);
 const attempt=await j.begin('click',{name:'relay_browser',arguments:{action:'click'}},{actionId:'a'});
 const outcome=await j.outcome(attempt,{success:false,code:'LOST_REPLY'},{receipt:'unknown'});
 let page=await index.read({limit:50});assert.equal(page.events.filter(r=>r.actionHeads===2).length,2);
 assert.equal((await index.read({view:'unknown'})).events[0].id,outcome.id);
 await j.note('merge',{actionId:'a',parent:left.id,reconciles:[right.id]});
 page=await index.read();assert.equal(page.events.filter(r=>r.actionHeads===1).length,1);
 assert.equal((await index.read({view:'unknown'})).events.length,1);assert.equal((await j.events()).length,6);
 assert.ok(index.explain({}).some(r=>/page_working/.test(r.detail)));
 assert.equal(page.cost.historyEnumerations,0);assert.equal(page.cost.selectedRecords,2);
});
test('updated legacy writers cannot append to an indexed journal and pagination rejects generation changes',async t=>{
 const {j,index,root}=await fixture(t);await j.note('one',{actionId:'one'});const first=await index.read({limit:1});
 await assert.rejects(new DirectoryActionJournal(root).note('legacy',{actionId:'other'}),{code:'DIRECTORY_INDEX_WRITER_REQUIRED'});
 await j.note('two',{actionId:'two'});
 await assert.rejects(index.read({generation:first.generation,after:first.events[0].id}),{code:'DIRECTORY_READ_CHANGED'});
 assert.equal((await j.events()).length,2);
});
test('every interrupted publication boundary blocks reads until a source-validating rebuild',async t=>{
 for(const stage of ['marker','original','indexed','committed']){
  const root=await mkdtemp(path.join(os.tmpdir(),'directory-crash-index-')),j=new DirectoryActionJournal(root);
  const index=await j.enableIndex({exclusiveWritersConfirmed:true});
  try{
   const original=await j.note('kept',{actionId:'prior'});
   index.checkpoint=async point=>{if(point===stage)throw Error('simulated crash '+stage);};
   await assert.rejects(j.begin('effect',{name:'send'},{}),/simulated crash/);
   if(stage==='marker')assert.equal((await index.read()).events.length,1);
   else await assert.rejects(index.read(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
   index.close();const reopened=await j.enableIndex({exclusiveWritersConfirmed:true});
   if(stage==='marker')assert.equal((await reopened.read()).events.length,1);
   else await assert.rejects(reopened.read(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
   const rebuilt=await reopened.rebuild({exclusiveWritersConfirmed:true});
   assert.equal(rebuilt.validatedEvents,stage==='marker'?1:2);
   assert.equal((await j.events()).find(r=>r.id===original.id).digest,original.digest);
   const rows=(await reopened.read({view:'events'})).events;
   assert.equal(rows.filter(r=>r.event.kind==='attempt').length,stage==='marker'?0:1);
   assert.equal((await readdir(path.join(root,'index-pending'))).length,0);reopened.close();
  }finally{index.close();await rm(root,{recursive:true,force:true});}
 }
});
test('rebuild retains unpublished claims and never converts missing outcome into absence',async t=>{
 const {j,index,root}=await fixture(t),id='a'.repeat(64);
 await writeFile(path.join(root,id+'.json.claim'),id);
 await index.rebuild({exclusiveWritersConfirmed:true});
 const page=await index.read();assert.equal(page.events[0].event.kind,'unpublished');
 assert.equal(await readFile(path.join(root,id+'.json.claim'),'utf8'),id);
});
test('selected original corruption fails reads and rebuild instead of silently repairing history',async t=>{
 const {j,index,root}=await fixture(t),row=await j.note('one',{actionId:'a'});
 await writeFile(path.join(root,row.id+'.json'),JSON.stringify({...row,digest:'changed'}));
 await assert.rejects(index.read(),{code:'DIRECTORY_INDEX_SOURCE_CORRUPT'});
 await assert.rejects(index.rebuild({exclusiveWritersConfirmed:true}),{code:'DIRECTORY_ACTION_CORRUPT'});
 await assert.rejects(index.read(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
});
test('corrupt derived row is detected against original and rebuilt without changing source',async t=>{
 const {j,index}=await fixture(t),row=await j.note('one',{actionId:'a'});
 index.db.prepare('UPDATE events SET body=? WHERE id=?').run('{}',row.id);
 await assert.rejects(index.read(),{code:'DIRECTORY_INDEX_SOURCE_CHANGED'});
 await index.rebuild({exclusiveWritersConfirmed:true});assert.equal((await index.read()).events[0].digest,row.digest);
});
test('authority lineage retires only explicit same-scope complete host snapshots and retains forks',async t=>{
 const {j,index}=await fixture(t);
 const event=(scope,parent)=>({kind:'phase-authority',authority:'host-supplied',authorityScope:scope,completeSnapshot:true,authorityParent:parent});
 const root=await j.append(['root'],event('request-a'));
 const left=await j.append(['left'],event('request-a',root.id)),right=await j.append(['right'],event('request-a',root.id));
 await j.append(['legacy'],{kind:'phase-authority',authority:'host-supplied'});
 await j.append(['other'],event('request-b'));
 let page=await index.read();assert.equal(page.events.length,4);
 await j.append(['merge'],{...event('request-a',left.id),authorityReconciles:[right.id]});
 page=await index.read();assert.equal(page.events.length,3);assert.equal((await j.events()).length,6);
});

test('a real writer process exit after original publication leaves a blocked index and recoverable attempt',async t=>{
 const {j,index,root}=await fixture(t);index.close();
 const moduleUrl=pathToFileURL(path.resolve('lib/directory-action-journal.mjs')).href;
 const script=`import {DirectoryActionJournal} from ${JSON.stringify(moduleUrl)};const j=new DirectoryActionJournal(${JSON.stringify(root)});await j.enableIndex({exclusiveWritersConfirmed:true,checkpoint:async stage=>{if(stage==='original')process.exit(23);}});await j.begin('one-effect',{name:'send'},{});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000,windowsHide:true});
 assert.equal(child.status,23,child.stderr);
 const reopened=await j.enableIndex({exclusiveWritersConfirmed:true});t.after(()=>reopened.close());
 await assert.rejects(reopened.read(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
 await reopened.rebuild({exclusiveWritersConfirmed:true});
 const rows=await j.events();assert.equal(rows.length,1);assert.equal(rows[0].event.kind,'attempt');
 assert.equal((await reopened.read()).events.length,1);
});

test('interrupted rebuild stages retain history and stay blocked until explicit recovery',async t=>{
 const {j,index}=await fixture(t);const attempt=await j.begin('unknown',{name:'send'},{});
 for(const stage of ['rebuild-marker','rebuild-indexed','rebuild-committed']){
  index.checkpoint=async point=>{if(point===stage)throw Error('rebuild interrupted');};
  await assert.rejects(index.rebuild({exclusiveWritersConfirmed:true}),/rebuild interrupted/);
  await assert.rejects(index.read(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
  index.checkpoint=async()=>{};await index.rebuild({exclusiveWritersConfirmed:true});
  assert.equal((await index.read()).events[0].id,attempt.id);
 }
});

test('invalid authority scope cannot hide another authority and preserves its original for recovery',async t=>{
 const {j,index}=await fixture(t);
 const original=await j.append(['scope-a'],{kind:'phase-authority',authority:'host-supplied',authorityScope:'a',completeSnapshot:true});
 await assert.rejects(j.append(['scope-b'],{kind:'phase-authority',authority:'host-supplied',authorityScope:'b',completeSnapshot:true,authorityParent:original.id}),{code:'DIRECTORY_INDEX_LINEAGE'});
 await assert.rejects(index.read(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
 const rows=await j.events();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.id===original.id).digest,original.digest);
 await assert.rejects(index.rebuild({exclusiveWritersConfirmed:true}),{code:'DIRECTORY_INDEX_LINEAGE'});
});

test('independent processes serialize publication and readers refuse an in-flight marker',async t=>{
 const {j,index,root}=await fixture(t),moduleUrl=pathToFileURL(path.resolve('lib/directory-action-journal.mjs')).href;
 const childSource=`import {DirectoryActionJournal} from ${JSON.stringify(moduleUrl)};const j=new DirectoryActionJournal(${JSON.stringify(root)});const index=await j.enableIndex({exclusiveWritersConfirmed:true,checkpoint:async stage=>{if(stage==='marker'){process.stdout.write('ready');await new Promise(resolve=>process.stdin.once('data',resolve));}}});await j.note('child',{actionId:'a'});index.close();process.stdin.destroy();`;
 const child=spawn(process.execPath,['--input-type=module','-e',childSource],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill();});
 await once(child.stdout,'data');
 await assert.rejects(index.read(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
 await assert.rejects(j.note('competing',{actionId:'b'}),/locked|busy/i);
 child.stdin.write('continue');const [code]=await exited;assert.equal(code,0);
 assert.equal((await j.events()).length,1);assert.equal((await index.read()).events.length,1);
});

test('duplicate and cancelled pre-reservation refusals leave the existing generation usable',async t=>{
 const {j,index}=await fixture(t),attempt=await j.begin('once',{name:'send'},{}),first=await index.read();
 await assert.rejects(j.begin('once',{name:'send'},{}),{code:'DIRECTORY_ATTEMPT_EXISTS'});
 const controller=new AbortController();controller.abort();
 await assert.rejects(j.append(['cancelled'],{kind:'action-state',actionId:'b'},{beforeReservation:()=>controller.signal.throwIfAborted()}),{name:'AbortError'});
 const after=await index.read();assert.equal(after.generation,first.generation);assert.equal(after.events[0].id,attempt.id);
 assert.equal((await j.events()).length,1);
});

test('rebuild refuses to erase a previously indexed missing original',async t=>{
 const {j,index,root}=await fixture(t),attempt=await j.begin('retain',{name:'send'},{});
 const file=path.join(root,attempt.id+'.json');await rm(file);
 await assert.rejects(index.rebuild({exclusiveWritersConfirmed:true}),{code:'DIRECTORY_INDEX_SOURCE_CHANGED'});
 await assert.rejects(index.read(),{code:'DIRECTORY_INDEX_REBUILD_REQUIRED'});
 assert.equal(index.db.prepare('SELECT digest FROM events WHERE id=?').get(attempt.id).digest,attempt.digest);
});

test('grouping linked successful outcomes uses indexed predicates and keeps failed or unknown receipts visible',async t=>{
 const {j,index}=await fixture(t);
 const good=await j.begin('good',{name:'read'},{}),bad=await j.begin('bad',{name:'relay_browser',arguments:{action:'click'}},{});
 await j.outcome(good,{success:true},{receipt:'good'});const unknown=await j.outcome(bad,{success:false,code:'LOST_REPLY'},{receipt:'unknown'});
 await j.note('group',{actionId:'a',evidence:[good.id,bad.id]});
 const page=await index.read();assert.equal(page.events.length,2);assert.ok(page.events.some(row=>row.id===unknown.id));
 const plan=index.db.prepare("EXPLAIN QUERY PLAN UPDATE events SET working=0 WHERE action=? AND kind='outcome' AND working=1 AND unknown=0 AND json_extract(body,'$.result.success')=1").all('a');
 assert.ok(plan.some(row=>/action_heads/.test(row.detail)));assert.ok(plan.every(row=>!/^SCAN events/.test(row.detail)));
});

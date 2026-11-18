import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createPersistenceTrace,sanitizePersistenceDiagnostic} from '../lib/persistence-diagnostics.mjs';
import {renameWithRetry} from '../lib/coalescing-persistence.mjs';
import {DiagnosticsStore} from '../lib/diagnostics.mjs';
import {ConnectionManager} from '../lib/mcp.mjs';
async function directory(t){const dir=await mkdtemp(path.join(tmpdir(),'persistence-diagnostic-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('rename diagnostics preserve attempts, timings and exact original failure without native attribution',async()=>{
 const events=[],trace=createPersistenceTrace(e=>events.push(e),'browser-settings-save');let calls=0;const waits=[];
 const cause=Object.assign(new Error('SECRET C:/private/file'),{code:'EPERM',errno:-4048,syscall:'rename',path:'SECRET',dest:'SECRET'});
 await assert.rejects(renameWithRetry('SECRET','SECRET',{trace,io:{rename:async()=>{calls++;throw cause;}},delays:[1,2],wait:async ms=>waits.push(ms)}),error=>error===cause);
 assert.equal(calls,3);assert.deepEqual(waits,[1,2]);assert.deepEqual(events.filter(e=>e.outcome==='failed').map(e=>e.attempt),[1,2,3]);
 const failure=events.find(e=>e.outcome==='failed');assert.equal(failure.errno,-4048);assert.equal(failure.syscall,'rename');assert.equal(failure.nativeWin32Error,null);assert.equal(failure.errorSource,'node-system-error');assert.equal(failure.commitOutcome,'unknown');assert.ok(Number.isInteger(failure.durationMs));assert.ok(!JSON.stringify(events).includes('SECRET'));assert.equal(cause.path,'SECRET');
});
test('retry success reports only rename completion, not durability or causal attribution',async()=>{
 const events=[],trace=createPersistenceTrace(e=>events.push(e),'browser-settings-save');let calls=0;
 await renameWithRetry('private/source','private/destination',{trace,io:{rename:async()=>{if(!calls++)throw Object.assign(Error('private'),{code:'EBUSY'});}},delays:[0],wait:async()=>{}});
 assert.equal(events.at(-1).commitOutcome,'rename-reported-success');assert.equal(events.at(-1).attempt,2);
});
test('disabled and failing diagnostic sinks cannot change write result or original cause',async()=>{
 let calls=0;const disabled=createPersistenceTrace(null,'browser-settings-save');assert.equal(await disabled.run('write',async()=>++calls),1);
 for(const sink of [()=>{throw Error('diagnostic');},()=>Promise.reject(Error('diagnostic'))]){
  const trace=createPersistenceTrace(sink,'browser-settings-save',{now:()=>{throw Error('clock');}});
  assert.equal(await trace.run('write',async()=>42),42);
  const cause=Object.assign(Error('write failure'),{code:'EIO'});await assert.rejects(trace.run('write',async()=>{throw cause;}),error=>error===cause);
  await renameWithRetry('a','b',{trace,io:{rename:async()=>{}},delays:[]});
 }
 await new Promise(resolve=>setImmediate(resolve));
});
test('diagnostic schema is allowlisted and each operation emits at most64 events',()=>{
 const events=[],trace=createPersistenceTrace(e=>events.push(e),'C:/secret');for(let i=0;i<1000;i++)trace.emit({phase:'write',outcome:'failed',code:'SECRET',syscall:'SECRET',sourceRole:'SECRET',nodeVersion:'SECRET',message:'SECRET',stack:'SECRET',path:'SECRET',nativeWin32Error:5});
 assert.equal(events.length,64);assert.equal(events[0].operation,'unspecified');assert.equal(events[0].sourceRole,'none');assert.equal(events[0].code,'UNKNOWN_ERROR');assert.equal(events[0].nativeWin32Error,null);assert.ok(!JSON.stringify(events).includes('SECRET'));
 assert.equal(sanitizePersistenceDiagnostic({phase:'SECRET',outcome:'failed'}),null);
});
test('real browser persistence emits bounded local diagnostics and restarts with metadata intact',async t=>{
 const dataDir=await directory(t),store=await new DiagnosticsStore({dataDir,version:'2.40.8',maxFileBytes:4096,maxFiles:2,maxEvents:20,maxPending:128}).init();
 const manager=await new ConnectionManager({dataDir,persistenceDiagnostics:e=>store.record(e)}).init();t.after(()=>manager.close());
 await manager.save({id:'browseros-neo',transport:'http',url:'http://127.0.0.1:12345/mcp',name:'PRIVATE USER CONTENT'});
 await store.flush();const snapshot=await store.snapshot();const events=snapshot.events.filter(e=>e.event==='persistence_operation');
 assert.ok(events.some(e=>e.operation==='browser-settings-init'&&e.phase==='sync'));assert.ok(events.some(e=>e.operation==='browser-settings-save'&&e.phase==='rename'&&e.outcome==='succeeded'));
 assert.ok(!JSON.stringify(events).includes('PRIVATE'));assert.ok(!JSON.stringify(events).includes(dataDir));assert.match(events[0].nodeVersion,/^\d+\./);
 assert.equal(JSON.parse(await readFile(manager.file,'utf8')).connections[0].name,'PRIVATE USER CONTENT');
 await store.close();const restored=await new DiagnosticsStore({dataDir,version:'2.40.8',maxFileBytes:4096,maxFiles:2,maxEvents:20}).init();t.after(()=>restored.close());assert.ok((await restored.snapshot()).events.some(e=>e.event==='persistence_operation'));
});
test('diagnostic filesystem failure never blocks actual browser settings save',async t=>{
 const dataDir=await directory(t),store=new DiagnosticsStore({dataDir,version:'2.40.8',io:{mkdir:async()=>{throw Object.assign(Error('disk'),{code:'EIO'});}}});const manager=await new ConnectionManager({dataDir,persistenceDiagnostics:e=>store.record(e)}).init();t.after(()=>manager.close());
 await manager.save({id:'browseros-neo',transport:'http',url:'http://127.0.0.1:12345/mcp'});await store.flush();assert.equal(store.status().healthy,false);assert.equal(JSON.parse(await readFile(manager.file,'utf8')).connections.length,1);
});

test('plain and aggregate failures remain unknown after diagnostic persistence round-trip',async t=>{
 const dataDir=await directory(t),store=await new DiagnosticsStore({dataDir,version:'2.40.8'}).init();
 const trace=createPersistenceTrace(e=>store.record(e),'browser-settings-save'),cause=Error('not a system error');
 await assert.rejects(trace.run('write',async()=>{throw cause;}),e=>e===cause);
 trace.emit({phase:'complete',outcome:'failed',commitOutcome:'unknown'});
 await store.close();
 const restored=await new DiagnosticsStore({dataDir,version:'2.40.8'}).init();t.after(()=>restored.close());
 const failures=(await restored.snapshot()).events.filter(e=>e.outcome==='failed');assert.equal(failures.length,2);
 for(const e of failures){assert.equal(e.errorSource,'unknown');assert.equal(e.nativeWin32Error,null);}
 const partial=sanitizePersistenceDiagnostic({phase:'write',outcome:'failed',code:'EIO'});assert.equal(partial.errorSource,'unknown');
 const full=sanitizePersistenceDiagnostic({phase:'write',outcome:'failed',code:'EIO',errno:-5,syscall:'write'});assert.equal(full.errorSource,'node-system-error');assert.equal(sanitizePersistenceDiagnostic(full).errorSource,'node-system-error');
});
test('expected absent cleanup is informational without swallowing the original error',async()=>{
 const events=[],trace=createPersistenceTrace(e=>events.push(e),'browser-settings-save');
 const cause=Object.assign(Error('gone'),{code:'ENOENT',errno:-2,syscall:'unlink'});
 await assert.rejects(trace.run('cleanup',async()=>{throw cause;},{sourceRole:'temporary',commitOutcome:'rename-reported-success'}),e=>e===cause);
 const e=events.at(-1);assert.equal(e.outcome,'already-absent');assert.equal(e.level,'info');assert.equal(e.commitOutcome,'rename-reported-success');assert.equal(sanitizePersistenceDiagnostic(e).outcome,'already-absent');
 assert.equal(sanitizePersistenceDiagnostic({...e,phase:'write'}),null);
});

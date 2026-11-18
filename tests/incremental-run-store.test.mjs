import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncrementalRunStore } from '../lib/incremental-run-store.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
const setup=async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ice-incremental-'));const engine=new HarnessEngine({runtime:{},dataDir:dir,defaultCwd:dir});t.after(async()=>{clearTimeout(engine.dirtyTimer);await engine.writeChain.catch(()=>{});await engine.runStore.close();await fs.rm(dir,{recursive:true,force:true});});return{dir,engine};};
const run=id=>({id,status:'completed',settled:true,nodes:{},events:[]});
test('only changed run crosses worker and unchanged history remains queryable',async t=>{
 const{engine}=await setup(t);for(let i=0;i<100;i++)engine.runs.set('r'+i,{...run('r'+i),input:'x'.repeat(500000)});
 await engine.persist();let batches=[];const write=engine.runStore.write.bind(engine.runStore);engine.runStore.write=batch=>{batches.push(batch.rows.map(x=>x.id));return write(batch);};
 const active=engine.runs.get('r99');active.status='running';active.settled=false;active.output='new';engine.notify('agent.event',active,null,{type:'delta',delta:'new'});await engine.persist();
 assert.deepEqual(batches,[['r99']]);const stored=await engine.runStore.load();assert.equal(stored.runs.length,100);assert.equal(stored.runs[0].input.length,500000);assert.equal(stored.runs.at(-1).output,'new');
});
test('commit failure preserves last successful record and later revision recovers',async t=>{
 const{engine}=await setup(t);engine.runs.set('r',run('r'));await engine.persist();const value=engine.runs.get('r');value.self=value;engine.markRunDirty('r');await assert.rejects(engine.persist(),/circular/i);delete value.self;value.output='recovered';await engine.persist();assert.equal((await engine.runStore.load()).runs[0].output,'recovered');
});
test('writes arriving during commit retain dirty revision and await latest batch',async t=>{
 const{engine}=await setup(t);engine.runs.set('r',run('r'));await engine.persist();let release;const gate=new Promise(r=>release=r);const write=engine.runStore.write.bind(engine.runStore);let first=true;engine.runStore.write=async batch=>{const result=await write(batch);if(first){first=false;await gate;}return result;};
 const r=engine.runs.get('r');r.output='first';engine.markRunDirty('r');const one=engine.persist();await new Promise(r=>setTimeout(r,20));r.output='second';engine.markRunDirty('r');const two=engine.persist();release();await Promise.all([one,two]);assert.equal((await engine.runStore.load()).runs[0].output,'second');
});
test('deletion and pruning preserve insertion order and reopening',async t=>{
 const{engine,dir}=await setup(t);for(let i=0;i<100;i++)engine.runs.set('r'+i,run('r'+i));await engine.persist();engine.runs.delete('r0');engine.runs.set('r100',run('r100'));await engine.persist();await engine.runStore.close();engine.runStore=new IncrementalRunStore(dir);const saved=await engine.runStore.load();assert.equal(saved.runs.length,100);assert.equal(saved.runs[0].id,'r1');assert.equal(saved.runs.at(-1).id,'r100');
});

test('one-time import preserves original files and restart recovers active state without replay',async t=>{
 const{engine,dir}=await setup(t);const original=JSON.stringify([{...run('active'),status:'running',settled:false,workflow:{nodes:[],edges:[]},input:'preserve',nodes:{node:{status:'running'}},nativeAgentReceipts:[{status:'uncertain',id:'effect'}]}]);
 await fs.writeFile(path.join(dir,'runs.json'),original);await fs.writeFile(path.join(dir,'workflows.json'),'[]');await engine.init();assert.equal(engine.runs.get('active').status,'failed');assert.equal(engine.runs.get('active').nodes.node.status,'cancelled');assert.deepEqual(engine.runs.get('active').nativeAgentReceipts,[{status:'uncertain',id:'effect'}]);assert.equal(await fs.readFile(path.join(dir,'runs.json'),'utf8'),original);
 await engine.runStore.close();await fs.writeFile(path.join(dir,'runs.json'),'not authoritative after import');const next=new HarnessEngine({runtime:{},dataDir:dir,defaultCwd:dir});try{await next.init();assert.equal(next.runs.get('active').input,'preserve');assert.equal(next.runs.get('active').status,'failed');}finally{await next.close();}
});

test('worker disappearance rejects unresolved commit without reporting success',async t=>{
 const{engine}=await setup(t);engine.runs.set('r',run('r'));await engine.persist();const worker=engine.runStore.worker;const pending=engine.runStore.request('write',{rows:[{kind:'run',id:'r',position:0,value:{...run('r'),input:'x'.repeat(30000000)}}],deleted:[]});await worker.terminate();await assert.rejects(pending,/exited|worker/i);
});

test('conversation cleanup measures and removes run database without touching workflows',async t=>{
 const{engine,dir}=await setup(t);engine.runs.set('r',run('r'));await engine.persist();await engine.runStore.close();
 const{StorageManager}=await import('../lib/storage-management.mjs');const manager=new StorageManager({dataDir:dir,workspaceDir:path.join(dir,'workspace')});
 const workflows=await fs.readFile(path.join(dir,'workflows.json'),'utf8');const size=(await fs.stat(path.join(dir,'run-state.sqlite'))).size;
 assert.ok((await manager.overview()).categories.find(x=>x.id==='conversations').bytes>=size);
 await manager.schedule({categories:['conversations'],confirmation:'DELETE SELECTED DATA'});await manager.applyAtStartup();
 await assert.rejects(fs.stat(path.join(dir,'run-state.sqlite')),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(dir,'workflows.json'),'utf8'),workflows);
});

test('corrupt authoritative SQLite fails without silently importing stale JSON',async t=>{
 const{engine,dir}=await setup(t);engine.runs.set('r',run('r'));await engine.persist();await engine.runStore.close();
 await fs.writeFile(path.join(dir,'run-state.sqlite'),'not a sqlite database');await fs.writeFile(path.join(dir,'runs.json'),'[]');
 const next=new HarnessEngine({runtime:{},dataDir:dir,defaultCwd:dir});try{await assert.rejects(next.init(),/database|sqlite/i);assert.equal(await fs.readFile(path.join(dir,'run-state.sqlite'),'utf8'),'not a sqlite database');}finally{await next.runStore.close().catch(()=>{});}
});

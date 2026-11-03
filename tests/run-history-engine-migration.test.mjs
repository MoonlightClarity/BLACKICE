import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HarnessEngine } from '../lib/engine.mjs';

test('engine boot safely migrates an oversized legacy history before parsing, with every run and the full original preserved',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-oom-engine-boot-'));
  t.after(async()=>{await fs.rm(dir,{recursive:true,force:true})});
  const evidence='A'.repeat(680000);
  const state={taskId:'task-legacy',revision:20,steps:[{id:'leaf-1',status:'done',evidence:'Real outcome verified.'}]};
  const events=Array.from({length:100},(_,index)=>({
    type:'agent.event',runId:'run-legacy',nodeId:'agent',at:'2026-11-02T18:01:10Z',
    data:{type:'task.state',state:{...state,revision:index+1,steps:[{id:'leaf-1',status:'done',evidence}]}}
  }));
  events.push({type:'agent.event',runId:'run-legacy',nodeId:'agent',at:'2026-11-02T18:02:10Z',data:{type:'message',text:'Confirmed result must survive restart.'}});
  const original=[{id:'run-legacy',taskId:'task-legacy',input:'Do useful work',status:'completed',settled:true,
    workflow:{id:'workflow',nodes:[],edges:[]},nodes:{},events,taskState:state,
    output:'Confirmed result must survive restart.'}];
  const source=JSON.stringify(original,null,2);
  assert.ok(Buffer.byteLength(source)>64*1024*1024);
  const file=path.join(dir,'runs.json');
  await fs.writeFile(file,source);
  await fs.writeFile(path.join(dir,'workflows.json'),'[]');
  const e=new HarnessEngine({dataDir:dir,defaultCwd:dir,runtime:{status:()=>({isolatedHistory:false})}});
  await e.init();
  const saved=e.getRun('run-legacy');
  assert.equal(saved.status,'completed');
  assert.equal(saved.taskState.steps[0].evidence,'Real outcome verified.');
  assert.equal(saved.events.at(-1).data.text,'Confirmed result must survive restart.');
  assert.ok(saved.events.every(x=>x.data.type!=='task.state'||x.data.state.steps===undefined));
  assert.ok(saved.eventRetention.sourceArchive?.relativePath,'original archive must be linked');
  const archival=path.join(dir,saved.eventRetention.sourceArchive.relativePath);
  assert.equal((await fs.stat(archival)).size,Buffer.byteLength(source));
  assert.equal(createHash('sha256').update(await fs.readFile(archival)).digest('hex'),saved.eventRetention.sourceArchive.sha256);
  const newFile=await fs.readFile(file,'utf8');
  assert.ok(Buffer.byteLength(newFile)<Buffer.byteLength(source)/12);
  const recovered=JSON.parse(newFile)[0];
  assert.equal(recovered.id,'run-legacy');
  assert.equal(recovered.events.at(-1).data.text,'Confirmed result must survive restart.');
  assert.equal(recovered.taskState.revision,20);
  await e.persist({checkpoint:true});
  assert.equal((await fs.stat(archival)).size,Buffer.byteLength(source));
  assert.ok((await fs.stat(file)).size<Buffer.byteLength(source)/12);
  await e.close?.();
});

test('a second startup accepts already-compacted multi-run history just above the legacy migration threshold', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-oom-compact-restart-'));
  t.after(async()=>{await fs.rm(dir,{recursive:true,force:true})});
  const message='Retained conversation evidence: '+'Z'.repeat(480000);
  const runs=Array.from({length:70},(_,i)=>({
    id:'compact-'+i,taskId:'task-'+i,status:'completed',settled:true,
    workflow:{id:'workflow',nodes:[],edges:[]},nodes:{},
    events:[{type:'agent.event',runId:'compact-'+i,nodeId:'agent',data:{type:'message',text:message}}],
    eventRetention:{compacted:true,bytes:Buffer.byteLength(message)+128,omittedEvents:0,omittedBytes:0}
  }));
  const file=path.join(dir,'runs.json'),source=JSON.stringify(runs);
  assert.ok(Buffer.byteLength(source)>32*1024*1024);
  assert.ok(Buffer.byteLength(source)<64*1024*1024);
  await fs.writeFile(file,source);
  await fs.writeFile(path.join(dir,'workflows.json'),'[]');
  const engine=new HarnessEngine({dataDir:dir,defaultCwd:dir,runtime:{status:()=>({isolatedHistory:false})}});
  await engine.init();
  assert.equal(engine.runs.size,70);
  assert.equal(engine.getRun('compact-69').events[0].data.text,message);
  const archiveDir=path.join(dir,'run-event-archives');
  assert.equal(await fs.stat(archiveDir).then(()=>true,()=>false),false,
    'bounded compact history should not be re-archived at every restart');
  await engine.close?.();
});

test('a safe-size already-compacted history above the streaming threshold is not rejected when migration has no savings',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-oom-no-savings-restart-'));
  t.after(async()=>{await fs.rm(dir,{recursive:true,force:true})});
  const message='Verified long conversation: '+'Y'.repeat(480000);
  const runs=Array.from({length:140},(_,i)=>({
    id:'bounded-'+i,taskId:'task-'+i,status:'completed',settled:true,
    workflow:{id:'workflow',nodes:[],edges:[]},nodes:{},
    events:[{type:'agent.event',runId:'bounded-'+i,nodeId:'agent',data:{type:'message',text:message}}],
    eventRetention:{compacted:true,bytes:Buffer.byteLength(message)+128,omittedEvents:0,omittedBytes:0}
  }));
  const original=JSON.stringify(runs),file=path.join(dir,'runs.json');
  assert.ok(Buffer.byteLength(original)>64*1024*1024);
  assert.ok(Buffer.byteLength(original)<128*1024*1024);
  await fs.writeFile(file,original);
  await fs.writeFile(path.join(dir,'workflows.json'),'[]');
  const engine=new HarnessEngine({dataDir:dir,defaultCwd:dir,runtime:{status:()=>({isolatedHistory:false})}});
  await engine.init();
  assert.equal(engine.runs.size,140);
  const last=engine.getRun('bounded-139');
  assert.equal(last.events[0].data.text,message);
  const archive=last.eventRetention.sourceArchive;
  assert.ok(archive?.relativePath);
  const archivedFile=path.join(dir,archive.relativePath);
  assert.equal((await fs.stat(archivedFile)).size,Buffer.byteLength(original));
  assert.equal(createHash('sha256').update(await fs.readFile(archivedFile)).digest('hex'),archive.sha256);
  await engine.close?.();
});

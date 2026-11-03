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
  const evidence='A'.repeat(410000);
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
  assert.ok(Buffer.byteLength(source)>32*1024*1024);
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


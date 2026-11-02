import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {WorkbenchGuestBridge} from '../lib/workbench-guest-bridge.mjs';

async function fixture(t){
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-metadata-'));
  t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  const root=path.join(workspace,'.blackice-workbench');await fs.mkdir(root);
  const clock=()=>Date.parse('2026-11-02T02:45:00Z'),agent={version:1,agentId:'a'.repeat(32),guestName:'GUEST',sessionId:2,interactive:true,heartbeatAt:new Date(clock()).toISOString(),guestRoot:'W:\\',capabilities:['launch','capture']},
    pair={version:1,agentId:agent.agentId,guestSessionId:2,verifiedAt:new Date(clock()).toISOString()},sleeps=[];
  const bridge=new WorkbenchGuestBridge({sharedRoot:workspace,clock,sleep:async ms=>{sleeps.push(ms);}});
  const save=(name,value)=>fs.writeFile(path.join(root,name),JSON.stringify(value));
  return {root,bridge,agent,pair,sleeps,save};
}

test('a transient missing heartbeat or pairing pathname is reread without guest commands',async t=>{
  for(const missing of ['agent-state.json','pairing.json']){
    const f=await fixture(t);
    if(missing!=='agent-state.json')await f.save('agent-state.json',f.agent);
    if(missing!=='pairing.json')await f.save('pairing.json',f.pair);
    f.bridge.sleep=async ms=>{f.sleeps.push(ms);await f.save(missing,missing==='agent-state.json'?f.agent:f.pair);};
    const status=await f.bridge.agentStatus();
    assert.equal(status.online,true);assert.equal(status.paired,true);assert.equal(status.agentId,f.agent.agentId);
    assert.deepEqual(f.sleeps,[25]);
    assert.deepEqual((await fs.readdir(f.root)).sort(),['agent-state.json','pairing.json']);
  }
});

test('missing metadata is bounded and never reuses a previously paired identity',async t=>{
  const f=await fixture(t);await f.save('agent-state.json',f.agent);await f.save('pairing.json',f.pair);
  assert.equal((await f.bridge.agentStatus()).paired,true);
  await fs.unlink(path.join(f.root,'agent-state.json'));await fs.unlink(path.join(f.root,'pairing.json'));
  const status=await f.bridge.agentStatus();
  assert.equal(status.online,false);assert.equal(status.paired,false);assert.equal(status.agentId,null);
  assert.deepEqual(f.sleeps,Array(10).fill(25),'Each missing metadata file gets only five bounded waits.');
  assert.deepEqual(await fs.readdir(f.root),[]);
});

test('changed agent/session, stale heartbeat and malformed records fail immediately without metadata retries',async t=>{
  const f=await fixture(t);await f.save('pairing.json',f.pair);
  for(const changed of [{...f.agent,agentId:'b'.repeat(32)},{...f.agent,sessionId:3},{...f.agent,heartbeatAt:'2026-11-02T02:44:00Z'}]){
    await f.save('agent-state.json',changed);const status=await f.bridge.agentStatus();
    assert.equal(status.paired,false);assert.deepEqual(f.sleeps,[]);
    if(changed.agentId!==f.agent.agentId)assert.equal(status.agentId,changed.agentId);
  }
  await fs.writeFile(path.join(f.root,'agent-state.json'),'{invalid');
  assert.equal((await f.bridge.agentStatus()).online,false);assert.deepEqual(f.sleeps,[]);
  await fs.writeFile(path.join(f.root,'agent-state.json'),'x'.repeat(32001));
  assert.equal((await f.bridge.agentStatus()).online,false);assert.deepEqual(f.sleeps,[]);
});

for(const code of ['EACCES','EPERM','EBUSY'])test('transient '+code+' on identity metadata recovers by rereading only that file',async t=>{
  for(const name of ['agent-state.json','pairing.json'])for(const operation of ['stat','readFile']){
    const f=await fixture(t);await f.save('agent-state.json',f.agent);await f.save('pairing.json',f.pair);
    const target=path.join(f.root,name),original=fs[operation].bind(fs);let reads=0;
    t.mock.method(fs,operation,async(file,...args)=>{
      if(file===target&&++reads<=2)throw Object.assign(Error('Transient metadata sharing error'),{code});
      return original(file,...args);
    });
    try{
      const status=await f.bridge.agentStatus();assert.equal(status.paired,true);assert.equal(status.agentId,f.agent.agentId);
      assert.equal(reads,3);assert.deepEqual(f.sleeps,[25,25]);
      assert.deepEqual((await fs.readdir(f.root)).sort(),['agent-state.json','pairing.json']);
    }finally{t.mock.restoreAll();}
  }
});

test('persistent metadata access failure stops after six reads and retains the real error',async t=>{
  const f=await fixture(t);await f.save('agent-state.json',f.agent);await f.save('pairing.json',f.pair);
  const target=path.join(f.root,'agent-state.json'),original=fs.stat.bind(fs),failure=Object.assign(Error('Persistent metadata access denied'),{code:'EACCES'});let reads=0;
  t.mock.method(fs,'stat',async(file,...args)=>{if(file===target){reads++;throw failure;}return original(file,...args);});
  await assert.rejects(f.bridge.agentStatus(),error=>error===failure);
  assert.equal(reads,6);assert.deepEqual(f.sleeps,Array(5).fill(25));
});

test('a changed identity observed after a sharing error is never replaced by an older paired identity',async t=>{
  const f=await fixture(t);await f.save('agent-state.json',f.agent);await f.save('pairing.json',f.pair);
  const target=path.join(f.root,'agent-state.json'),original=fs.stat.bind(fs);let reads=0;
  t.mock.method(fs,'stat',async(file,...args)=>{if(file===target&&++reads===1)throw Object.assign(Error('Temporarily locked'),{code:'EACCES'});return original(file,...args);});
  f.bridge.sleep=async ms=>{f.sleeps.push(ms);await f.save('agent-state.json',{...f.agent,agentId:'b'.repeat(32)});};
  const status=await f.bridge.agentStatus();assert.equal(status.paired,false);assert.equal(status.agentId,'b'.repeat(32));
  assert.equal(reads,2);assert.deepEqual(f.sleeps,[25]);
});

test('access failures on frame metadata and command receipts are not retried',async t=>{
  for(const name of ['latest-frame.json','responses/'+('c'.repeat(32))+'.json']){
    const f=await fixture(t);await f.bridge.init();await f.save('agent-state.json',f.agent);await f.save('pairing.json',f.pair);
    const target=path.join(f.root,name),original=fs.stat.bind(fs),failure=Object.assign(Error('Nonidentity metadata locked'),{code:'EACCES'});let reads=0;
    t.mock.method(fs,'stat',async(file,...args)=>{if(file===target){reads++;throw failure;}return original(file,...args);});
    try{
      await assert.rejects(name==='latest-frame.json'?f.bridge.agentStatus():f.bridge.readResult('c'.repeat(32)),error=>error===failure);
      assert.equal(reads,1);assert.deepEqual(f.sleeps,[]);
    }finally{t.mock.restoreAll();}
  }
});

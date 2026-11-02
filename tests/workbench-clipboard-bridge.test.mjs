import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkbenchGuestBridge,validateWorkbenchGuestAction} from '../lib/workbench-guest-bridge.mjs';

async function fixture(t,{capabilities=['clipboard_state','clipboard_read','clipboard_write'],respond=true,change={},rawResponse}={}){
  const shared=await fs.mkdtemp(path.join(tmpdir(),'blackice-clipboard-bridge-'));
  t.after(()=>fs.rm(shared,{recursive:true,force:true}));
  const root=path.join(shared,'.blackice-workbench'),agentId='a'.repeat(32),guestSessionId=2;
  let clock=Date.now(),observed;
  const bridge=new WorkbenchGuestBridge({sharedRoot:shared,clock:()=>clock,sleep:async ms=>{
    const files=await fs.readdir(path.join(root,'requests'));
    const name=files.find(file=>file.endsWith('.json'));
    if(name&&!observed){
      observed=JSON.parse(await fs.readFile(path.join(root,'requests',name),'utf8'));
      if(respond){
        if(observed.kind.startsWith('clipboard_')){
          await fs.mkdir(path.join(root,'clipboard-expiry'),{recursive:true});
          await fs.writeFile(path.join(root,'clipboard-expiry',name),JSON.stringify({version:1,requestId:observed.requestId,expiresAt:observed.expiresAt}));
        }
        await fs.writeFile(path.join(root,'responses',name),rawResponse?rawResponse(observed):JSON.stringify({version:1,requestId:observed.requestId,
          kind:observed.kind,status:'completed',agentId,guestSessionId,result:{fixture:true},...change}));
      }
    }
    clock+=ms;
  }});
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'agent-state.json'),JSON.stringify({version:1,agentId,sessionId:guestSessionId,
    interactive:true,heartbeatAt:new Date(clock).toISOString(),capabilities}));
  await fs.writeFile(path.join(root,'pairing.json'),JSON.stringify({version:1,agentId,guestSessionId,verifiedAt:new Date(clock).toISOString()}));
  return {bridge,root,agentId,guestSessionId,get observed(){return observed}};
}

test('clipboard request contract requires bounded Unicode text and an exact guest sequence',()=>{
  assert.deepEqual(validateWorkbenchGuestAction('clipboard_read',{}),{});
  assert.deepEqual(validateWorkbenchGuestAction('clipboard_write',{text:'\u{1f9ca}\ntext',expectedSequence:0xffffffff}),{text:'\u{1f9ca}\ntext',expectedSequence:0xffffffff});
  assert.deepEqual(validateWorkbenchGuestAction('clipboard_write',{text:'initial',expectedSequence:0}),{text:'initial',expectedSequence:0});
  for(const args of [{text:'ok'},{text:'ok',expectedSequence:-1},{text:'ok',expectedSequence:0x100000000},
    {text:'bad\0text',expectedSequence:1},{text:'\ud800',expectedSequence:1},{text:'x'.repeat(65537),expectedSequence:1}])
    assert.throws(()=>validateWorkbenchGuestAction('clipboard_write',args));
  assert.throws(()=>validateWorkbenchGuestAction('clipboard_read',{format:'files'}));
});

test('clipboard bridge binds agent/session and short expiry then removes transient payload files',async t=>{
  const f=await fixture(t),result=await f.bridge.request('clipboard_write',{text:'Fixture secret',expectedSequence:7},{timeoutMs:6000,
    expectedAgent:{agentId:f.agentId,guestSessionId:f.guestSessionId}});
  assert.equal(result.status,'completed');assert.equal(f.observed.expectedAgentId,f.agentId);assert.equal(f.observed.expectedGuestSessionId,2);
  assert.equal(Date.parse(f.observed.expiresAt)-Date.parse(f.observed.issuedAt),6000);
  assert.deepEqual(await fs.readdir(path.join(f.root,'requests')),[]);assert.deepEqual(await fs.readdir(path.join(f.root,'responses')),[]);
  assert.deepEqual(await fs.readdir(path.join(f.root,'clipboard-expiry')),[]);
});

test('missing capabilities, changed pairing or unbounded requests fail before dispatch',async t=>{
  const missing=await fixture(t,{capabilities:['capture','launch']});
  await assert.rejects(missing.bridge.request('clipboard_read',{}),{code:'WORKBENCH_CLIPBOARD_UNAVAILABLE'});
  await assert.rejects(fs.stat(path.join(missing.root,'requests')),{code:'ENOENT'});
  const f=await fixture(t);
  for(const options of [{requirePair:false},{timeoutMs:0},{timeoutMs:11000},{expectedAgent:{agentId:'old',guestSessionId:2}}])
    await assert.rejects(f.bridge.request('clipboard_read',{},options),{code:'WORKBENCH_CLIPBOARD_UNAVAILABLE'});
  assert.equal(f.observed,undefined);
});

test('wrong request kind, agent or session receipts are consumed and rejected',async t=>{
  for(const change of [{kind:'capture'},{agentId:'old'},{guestSessionId:9},{version:2}]){
    const f=await fixture(t,{change});
    await assert.rejects(f.bridge.request('clipboard_read',{}),{code:'WORKBENCH_CLIPBOARD_RESPONSE'});
    assert.deepEqual(await fs.readdir(path.join(f.root,'responses')),[]);
  }
});

test('clipboard timeout cancels the exact queued request without keeping plaintext or replaying it',async t=>{
  const f=await fixture(t,{respond:false});
  const result=await f.bridge.request('clipboard_write',{text:'Transient fixture text',expectedSequence:7},{timeoutMs:1000});
  assert.equal(result.status,'pending');assert.equal(result.requestId,f.observed.requestId);
  const files=await fs.readdir(path.join(f.root,'requests'));assert.deepEqual(files,[result.requestId+'.cancel.json']);
  const cancelled=await fs.readFile(path.join(f.root,'requests',files[0]),'utf8');
  assert.equal(cancelled.includes('Transient fixture text'),false);assert.equal(JSON.parse(cancelled).expectedAgentId,f.agentId);
  assert.deepEqual(await fs.readdir(path.join(f.root,'responses')),[]);
});

test('display extension uses the same exact session/capability fence and bounded physical dimensions',async t=>{
  assert.deepEqual(validateWorkbenchGuestAction('display_info',{guestSessionId:2}),{guestSessionId:2});
  assert.deepEqual(validateWorkbenchGuestAction('display_resize',{width:1920,height:1080,guestSessionId:2}),{width:1920,height:1080,guestSessionId:2});
  for(const args of [{width:0,height:1080,guestSessionId:2},{width:1920,height:5000,guestSessionId:2},{width:1920,height:1080,guestSessionId:0}])
    assert.throws(()=>validateWorkbenchGuestAction('display_resize',args),{code:'WORKBENCH_GUEST_DISPLAY'});
  const f=await fixture(t,{capabilities:['display_info','display_resize']});
  await assert.rejects(f.bridge.request('display_info',{guestSessionId:3}),{code:'WORKBENCH_GUEST_CAPABILITY'});
  assert.equal((await f.bridge.request('display_info',{guestSessionId:2})).status,'completed');
  assert.equal(f.observed.expectedGuestSessionId,2);assert.equal(f.observed.expectedAgentId,f.agentId);
});

test('private clipboard responses support worst-case escaped 65536-character text while generic results stay bounded',async t=>{
  const text='\u0001'.repeat(65536),f=await fixture(t,{change:{result:{text}}});
  const result=await f.bridge.request('clipboard_read',{});assert.equal(result.result.text,text);
  const id='b'.repeat(32);await fs.writeFile(path.join(f.root,'responses',id+'.json'),JSON.stringify({version:1,requestId:id,status:'completed',kind:'clipboard_read',result:{text}}));
  assert.equal((await f.bridge.readResult(id)).status,'pending');
});

test('oversized or malformed-escape private clipboard payloads are rejected and consumed',async t=>{
  for(const rawResponse of [()=>Buffer.alloc(512*1024+1,0x20),request=>`{"version":1,"requestId":"${request.requestId}","kind":"clipboard_read","status":"completed","result":{"text":"\\uQQQQ"}}`]){
    const f=await fixture(t,{rawResponse});
    await assert.rejects(f.bridge.request('clipboard_read',{}),{code:'WORKBENCH_CLIPBOARD_RESPONSE'});
    assert.deepEqual(await fs.readdir(path.join(f.root,'responses')),[]);
  }
});

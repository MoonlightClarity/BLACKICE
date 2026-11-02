import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {WorkbenchGuestBridge,validateWorkbenchGuestAction} from '../lib/workbench-guest-bridge.mjs';

const digest=data=>createHash('sha256').update(data).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wu8wQUAAAAASUVORK5CYII=','base64');
const fixture=async t=>{
  const shared=await fs.mkdtemp(path.join(tmpdir(),'blackice-workbench-bridge-'));
  t.after(()=>fs.rm(shared,{recursive:true,force:true}));
  return {shared,bridge:new WorkbenchGuestBridge({sharedRoot:shared})};
};
test('guest action contract has bounded native app/input requests and does not accept host execution markup',()=>{
  assert.deepEqual(validateWorkbenchGuestAction('launch',{appPath:'C:\\Windows\\System32\\notepad.exe',arguments:['file.txt']}),{
    appPath:'C:\\Windows\\System32\\notepad.exe',arguments:['file.txt']});
  const batch={runId:'1'.repeat(32),snapshotId:'2'.repeat(32),manifestSha256:'a'.repeat(64)};
  assert.deepEqual(validateWorkbenchGuestAction('batch_install',batch),batch);
  assert.throws(()=>validateWorkbenchGuestAction('batch_install',{...batch,manifestSha256:'x'}),{code:'WORKBENCH_GUEST_BATCH'});
  for(const [kind,args] of [
    ['launch',{appPath:'notepad.exe'}],['launch',{appPath:'C:\\foo.exe',shell:'powershell'}],
    ['launch',{appPath:'C:\\bad.exe',arguments:['x'.repeat(1001)]}],['click',{x:-1,y:0}],
    ['click',{x:1,y:30000}],['type',{text:'x'.repeat(10001)}],['key',{key:'DELETE-FILES'}],
    ['reset',{script:'rm -rf /'}],['probe',{nonce:'guessable'}]
  ])assert.throws(()=>validateWorkbenchGuestAction(kind,args),{code:/^WORKBENCH_GUEST_/});
});
test('observing guest status does not create files, fake an interactive desktop or start a host app',async t=>{
  const {shared,bridge}=await fixture(t);
  assert.equal((await bridge.agentStatus()).online,false);
  assert.equal((await fs.readdir(shared)).length,0);
  await assert.rejects(bridge.request('launch',{appPath:'C:\\Windows\\notepad.exe'}),{code:'WORKBENCH_GUEST_NOT_PAIRED'});
  assert.equal((await fs.readdir(shared)).length,0);
});
test('prepared bootstrap targets only a different Windows guest; host-visible scripts are original text',async t=>{
  const {shared,bridge}=await fixture(t);
  const info=await bridge.prepare({hostName:'DESKTOP-HOST',
    agentScript:'WIN_GUEST_AGENT\n'+'a'.repeat(500),setupScript:'WIN_GUEST_SETUP\n'+'b'.repeat(500)});
  assert.equal(info.prepared,true);
  assert.equal(info.hostName,'DESKTOP-HOST');
  const dir=path.join(shared,'.blackice-workbench');
  const recorded=JSON.parse(await fs.readFile(path.join(dir,'host-info.json'),'utf8'));
  assert.equal(recorded.hostName,'DESKTOP-HOST');
  assert.match(await fs.readFile(path.join(dir,'guest-agent.ps1'),'utf8'),/WIN_GUEST_AGENT/);
  assert.deepEqual((await fs.readdir(path.join(dir,'requests'))),[]);
});

test('exact host-to-guest request/response proof enables pair, capture and independent guest-only actions',async t=>{
  const {shared,bridge}=await fixture(t);
  const root=path.join(shared,'.blackice-workbench');
  await bridge.init();
  const agentId=randomBytes(16).toString('hex'),guestSessionId=2;
  const heartbeat=(time=new Date())=>{
    const value={version:1,agentId,guestName:'WORKBENCH-GUEST',sessionId:guestSessionId,
      interactive:true,heartbeatAt:time.toISOString(),
      guestRoot:'W:\\',capabilities:['probe','capture','launch','click','windows']};
    return fs.writeFile(path.join(root,'agent-state.json'),JSON.stringify(value));
  };
  await heartbeat();
  let settled=false,seen=[],polling=null;
  const processRequests=async()=>{
    const files=await fs.readdir(path.join(root,'requests'));
    for(const file of files){
      if(!file.endsWith('.json'))continue;
      const id=file.slice(0,-5);
      if(seen.includes(id))continue;
      const r=JSON.parse(await fs.readFile(path.join(root,'requests',file),'utf8'));
      seen.push(id);
      const response={version:1,requestId:id,kind:r.kind,status:'completed',agentId,
        guestSessionId,result:r.kind==='probe'?{nonce:r.args.nonce,readHostFile:true}:
          r.kind==='capture'?{sha256:digest(png),width:1,height:1}:{windows:[]},
        finishedAt:new Date().toISOString()};
      if(r.kind==='capture')await fs.writeFile(path.join(root,'frames',id+'.png'),png);
      await fs.writeFile(path.join(root,'responses',id+'.json'),JSON.stringify(response));
    }
  };
  const poll=()=>{
    if(settled||polling)return;
    // A slow filesystem must not make two simulated agents read the same
    // request before either has recorded it in seen.
    polling=processRequests().finally(()=>{polling=null});
    void polling.catch(()=>{});
  };
  const task=setInterval(poll,12);
  t.after(async()=>{settled=true;clearInterval(task);await polling?.catch(()=>{})});
  const paired=await bridge.pair({timeoutMs:2000});
  assert.equal(paired.status,'paired');
  assert.equal((await bridge.agentStatus()).paired,true);
  assert.equal((await bridge.agentStatus()).sharedReadWriteVerified,true);
  const queried=await bridge.request('windows',{},{timeoutMs:2000});
  assert.equal(queried.status,'completed');
  assert.deepEqual(queried.result.windows,[]);
  const captured=await bridge.request('capture',{},{timeoutMs:2000});
  assert.equal(captured.status,'completed');
  const frame=await bridge.frame(captured.requestId);
  assert.deepEqual(frame.bytes,png);
  const state=await bridge.agentStatus();
  assert.equal(state.displayReady,true);
  assert.equal(state.lastFrameId,captured.requestId);
  // Verified capture capability persists after the thumbnail ages out.
  const sixMinutesLater=Date.now()+6*60_000;
  bridge.clock=()=>sixMinutesLater;
  await heartbeat(new Date(sixMinutesLater));
  const aged=await bridge.agentStatus();
  assert.equal(aged.paired,true);
  assert.equal(aged.displayReady,true);
  assert.equal(aged.lastFrameId,null);
  const requestFiles=await fs.readdir(path.join(root,'requests'));
  const requests=await Promise.all(requestFiles.map(file=>fs.readFile(path.join(root,'requests',file),'utf8').then(JSON.parse)));
  assert.deepEqual(requests.map(request=>request.kind).sort(),['capture','probe','windows']);
  assert.deepEqual([...seen].sort(),requests.map(request=>request.requestId).sort());
  const duplicate=await bridge.readResult(queried.requestId);
  assert.equal(duplicate.status,'completed');
  settled=true;
});

test('stale, unpaired or unverified response evidence never becomes a new guest desktop',async t=>{
  const {shared,bridge}=await fixture(t);
  await bridge.init();
  const root=path.join(shared,'.blackice-workbench');
  const id=randomBytes(16).toString('hex');
  await fs.writeFile(path.join(root,'agent-state.json'),JSON.stringify({
    version:1,agentId:id,guestName:'GUEST',sessionId:9,interactive:true,
    heartbeatAt:new Date(Date.now()-300000).toISOString(),capabilities:['launch']}));
  await fs.writeFile(path.join(root,'pairing.json'),JSON.stringify({
    version:1,agentId:id,guestSessionId:9,verifiedAt:new Date().toISOString()}));
  assert.equal((await bridge.agentStatus()).paired,false);
  await assert.rejects(bridge.pair(),{code:'WORKBENCH_GUEST_OFFLINE'});
  await assert.rejects(bridge.frame(id),{code:'WORKBENCH_GUEST_FRAME_MISSING'});
});

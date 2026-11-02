import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {WorkbenchAgentJobs,createWorkbenchAgentToolHandler,workbenchFramePng} from '../lib/workbench-agent-tools.mjs';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

function bmp(){
  const bytes=Buffer.alloc(58);bytes.write('BM');bytes.writeUInt32LE(bytes.length,2);bytes.writeUInt32LE(54,10);
  bytes.writeUInt32LE(40,14);bytes.writeInt32LE(1,18);bytes.writeInt32LE(-1,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);
  Buffer.from([17,43,89,0]).copy(bytes,54);return {bytes,contentType:'image/bmp',width:1,height:1,sequence:9};
}
function fixture(verificationCallbacks={}){
  const root=path.join(os.tmpdir(),'blackice-read-only-capture-fixture'),agent={online:true,paired:true,sharedReadWriteVerified:true,
    agentId:'a'.repeat(32),guestSessionId:2,expectedGuestRoot:'W:\\',guestName:'GUEST',capabilities:['launch','capture']};
  const calls={status:0,bridge:0,agent:0,request:0,frame:0,native:0},events=[];
  const state={backend:'hyper-v',vmName:'BLACKICE-Workbench',guest:{running:true},canRunNativeApps:true,capability:{hostName:'HOST'},
    config:{folders:[{id:'workspace',hostPath:root,readWrite:true,guestMountVerified:true,hostSharePrepared:true}]}};
  const png=workbenchFramePng(bmp());
  const bridge={workspace:root,agentStatus:async()=>{calls.agent++;return {...agent}},
    request:async(kind,args,options)=>{calls.request++;assert.equal(kind,'capture');assert.deepEqual(args,{});assert.equal(options.requirePair,true);
      return {status:'completed',requestId:'b'.repeat(32),agentId:agent.agentId,guestSessionId:agent.guestSessionId}},
    frame:async requestId=>{calls.frame++;assert.equal(requestId,'b'.repeat(32));return {bytes:png,width:1,height:1}}};
  const workbench={consoleControl:new WorkbenchConsoleControl(),status:async()=>{calls.status++;return state},bridge:()=>{calls.bridge++;return bridge},
    guestNativeConsoleFrame:WindowsWorkbench.prototype.guestNativeConsoleFrame,
    nativeConsoleAdapter:{frame:async()=>{calls.native++;return bmp()}}};
  const jobs=new WorkbenchAgentJobs({workbench,hostName:()=> 'HOST'}),handler=createWorkbenchAgentToolHandler({workbench,jobs,scope:'capture-fixture',onEvent:event=>events.push(event),...verificationCallbacks});
  return {agent,state,bridge,workbench,calls,events,handler,capture:()=>handler({name:'relay_workbench',arguments:{action:'capture'}})};
}
test('native image delivery supplies visual evidence without minting criterion effect receipts',async()=>{
  const f=fixture({recordVerifiedEffects:async()=>assert.fail('Capture is not a guest effect verifier.'),recordVerifiedControlEffects:async()=>assert.fail('Capture is not a host-control verifier.')});
  const result=await f.capture();assert.equal(result.success,true);assert.ok(result.contentItems.some(item=>item.type==='inputImage'));
  const value=metadata(result);assert.equal(value.basis,'native-decoded-surface');
  for(const field of ['verification','effectVerified','criterionIds','receipts'])assert.equal(Object.hasOwn(value,field),false);
  await f.handler.close();
});
const metadata=result=>JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);
function decodedPng(result){
  const bytes=Buffer.from(result.contentItems.find(item=>item.type==='inputImage').imageUrl.split(',')[1],'base64'),chunks=[];
  assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  for(let offset=8;offset<bytes.length;){const length=bytes.readUInt32BE(offset);if(bytes.toString('ascii',offset+4,offset+8)==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+length));offset+=length+12}
  return inflateSync(Buffer.concat(chunks));
}

for(const mode of ['throws','offline'])test(`USER can inspect the actual native VM frame while the bridge ${mode} and the shared mount is unverified`,async()=>{
  const f=fixture();await f.workbench.consoleControl.take();const owner=f.workbench.consoleControl.status();
  f.state.config.folders[0].guestMountVerified=false;f.state.canRunNativeApps=false;f.agent.online=false;f.agent.paired=false;
  if(mode==='throws')f.bridge.agentStatus=async()=>{throw Error('The shared-folder agent is unreachable.')};
  const result=await f.capture();assert.equal(result.success,true);assert.deepEqual(decodedPng(result),Buffer.from([0,89,43,17]));
  const m=metadata(result),png=Buffer.from(result.contentItems.find(i=>i.type==='inputImage').imageUrl.split(',')[1],'base64');
  assert.deepEqual({...m,pixelHealth:undefined,pngSha256:undefined,pngBytes:undefined,frameAgeMs:undefined},{basis:'native-decoded-surface',vmScope:'configured-vm',pairing:'not-inspected',width:1,height:1,sequence:9,pixelHealth:undefined,pngSha256:undefined,pngBytes:undefined,frameAgeMs:undefined});
  assert.equal(m.pngSha256,createHash('sha256').update(png).digest('hex'));assert.equal(m.pngBytes,png.length);assert.equal(m.frameAgeMs,null);
  assert.equal(m.pixelHealth.allBlack,false);assert.equal(m.pixelHealth.nonblackPixels,1);assert.equal(m.pixelHealth.blackPixels,0);assert.equal(m.pixelHealth.totalPixels,1);
  for(const key of ['guestName','guestSessionId','agentId','paired'])assert.equal(Object.hasOwn(metadata(result),key),false);
  assert.equal(f.calls.native,1);assert.equal(f.calls.status,0);assert.equal(f.calls.bridge,0);assert.equal(f.calls.request,0);
  assert.deepEqual(f.workbench.consoleControl.status(),owner);assert.doesNotMatch(JSON.stringify(f.events),/base64|imageUrl|data:image/);
});

test('only native unavailability selects the paired capture fallback and verifies its current identity',async()=>{
  const f=fixture();f.workbench.nativeConsoleAdapter=null;await f.workbench.consoleControl.take();const owner=f.workbench.consoleControl.status();
  const result=await f.capture();assert.equal(result.success,true);assert.deepEqual(decodedPng(result),Buffer.from([0,89,43,17]));
  assert.equal(metadata(result).basis,'paired-guest-desktop');assert.equal(metadata(result).vmName,'BLACKICE-Workbench');assert.equal(metadata(result).guestName,'GUEST');
  assert.equal(f.calls.request,1);assert.equal(f.calls.frame,1);assert.equal(f.calls.agent,3);assert.deepEqual(f.workbench.consoleControl.status(),owner);
});

for(const mismatch of ['offline','unpaired','mount','capability'])test(`paired fallback rejects ${mismatch} before requesting pixels`,async()=>{
  const f=fixture();f.workbench.nativeConsoleAdapter=null;
  if(mismatch==='offline')f.agent.online=false;
  if(mismatch==='unpaired')f.agent.paired=false;
  if(mismatch==='mount')f.agent.sharedReadWriteVerified=false;
  if(mismatch==='capability')f.agent.capabilities=[];
  const result=await f.capture();assert.equal(result.success,false);assert.equal(result.code,'WORKBENCH_AGENT_UNAVAILABLE');
  assert.equal(f.calls.request,0);assert.equal(f.calls.frame,0);assert.equal(result.contentItems.some(item=>item.type==='inputImage'),false);
});

test('paired fallback cannot publish pixels after a guest-session identity change',async()=>{
  const f=fixture();f.workbench.nativeConsoleAdapter=null;
  const read=f.bridge.frame;f.bridge.frame=async requestId=>{const result=await read(requestId);f.agent.guestSessionId=3;return result};
  const result=await f.capture();assert.equal(result.success,false);assert.equal(result.code,'WORKBENCH_AGENT_CHANGED');
  assert.equal(result.contentItems.some(item=>item.type==='inputImage'),false);
});

test('malformed native BMP never silently substitutes a paired or host image',async()=>{
  const f=fixture();f.workbench.nativeConsoleAdapter.frame=async()=>{const frame=bmp();frame.bytes.writeUInt16LE(24,28);return frame};
  const result=await f.capture();assert.equal(result.success,false);assert.equal(result.code,'WORKBENCH_NATIVE_FRAME_INVALID');
  assert.equal(f.calls.status,0);assert.equal(f.calls.bridge,0);assert.equal(f.calls.request,0);assert.equal(result.contentItems.some(item=>item.type==='inputImage'),false);
});

test('a malformed frame returned by a custom native adapter fails conversion without fallback',async()=>{
  const f=fixture();f.workbench.guestNativeConsoleFrame=async()=>({...bmp(),bytes:Buffer.from('not a BMP')});
  const result=await f.capture();assert.equal(result.success,false);assert.equal(result.code,'WORKBENCH_AGENT_FRAME');
  assert.equal(f.calls.status,0);assert.equal(f.calls.bridge,0);assert.equal(f.calls.request,0);
});

test('unexpected native errors do not trigger capture on another path',async()=>{
  const f=fixture();f.workbench.guestNativeConsoleFrame=async()=>{throw Object.assign(Error('Native receipt was uncertain.'),{code:'WORKBENCH_NATIVE_UNCERTAIN'})};
  const result=await f.capture();assert.equal(result.success,false);assert.equal(result.code,'WORKBENCH_NATIVE_UNCERTAIN');assert.equal(f.calls.request,0);assert.equal(f.calls.bridge,0);
});

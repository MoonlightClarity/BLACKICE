import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import {inspectWorkbenchPng,retainWorkbenchCapture,boundWorkbenchNativeHealth} from '../lib/workbench-capture.mjs';
import {workbenchFramePng,WorkbenchAgentJobs,createWorkbenchAgentToolHandler} from '../lib/workbench-agent-tools.mjs';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
function bmp(rgb=[0,0,0],sequence=7){const bytes=Buffer.alloc(58);bytes.write('BM');bytes.writeUInt32LE(58,2);bytes.writeUInt32LE(54,10);bytes.writeUInt32LE(40,14);bytes.writeInt32LE(1,18);bytes.writeInt32LE(-1,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);Buffer.from([rgb[2],rgb[1],rgb[0],0]).copy(bytes,54);return {bytes,width:1,height:1,sequence};}
const health=(sequence=7)=>({available:true,sequence,dark:true,classification:'dark',sampledPixels:256,blackFraction:1,distinctColors:1,frameAgeMs:123,meaning:'decoded-display-sample-not-vm-power-state'});
const meta=r=>JSON.parse(r.contentItems.find(i=>i.type==='inputText').text);
const pixels=r=>Buffer.from(r.contentItems.find(i=>i.type==='inputImage').imageUrl.split(',')[1],'base64');
async function directory(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-capture-retain-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
function handler(root,{scope='task-one',offline=false}={}){
  const agent={online:true,paired:true,sharedReadWriteVerified:true,agentId:'a'.repeat(32),guestSessionId:2,expectedGuestRoot:'W:\\',guestName:'GUEST',capabilities:['launch','capture'],privileges:{administratorToken:false,basis:'interactive-guest-agent-token'}};
  const state={backend:'hyper-v',vmName:'BLACKICE-Workbench',guest:{running:true},capability:{hostName:'HOST',canManageVM:true,processElevated:true},config:{folders:[{id:'workspace',hostPath:root,readWrite:true,hostSharePrepared:true}]}};
  const counts={native:0,agent:0,request:0};
  const bridge={workspace:root,agentStatus:async()=>{counts.agent++;if(offline)throw Error('offline');return agent;},request:async()=>{counts.request++;throw Error('Unexpected guest action')}};
  const workbench={consoleControl:new WorkbenchConsoleControl(),config:state.config,status:async()=>state,bridge:()=>bridge,guestNativeConsoleFrame:async()=>{counts.native++;return {...bmp([12,34,56],counts.native),nativeHealth:health(counts.native)}}};
  const jobs=new WorkbenchAgentJobs({workbench,hostName:()=> 'HOST'}),tool=createWorkbenchAgentToolHandler({workbench,jobs,scope});
  return {workbench,bridge,agent,state,counts,tool,jobs,call:(args,callId,context={})=>tool({name:'relay_workbench',arguments:args,...(callId?{callId}:{})},context)};
}

test('exact PNG health distinguishes black pixels, color, alpha and checksum damage',()=>{
  const black=workbenchFramePng(bmp()),colored=workbenchFramePng(bmp([12,34,56]));
  const a=inspectWorkbenchPng(black),b=inspectWorkbenchPng(colored);
  assert.equal(a.pngSha256,hash(black));assert.equal(a.pngBytes,black.length);assert.equal(a.pixelHealth.classification,'black');assert.equal(a.pixelHealth.blackPixels,1);
  assert.equal(b.pixelHealth.classification,'nonblack');assert.equal(b.pixelHealth.nonblackPixels,1);assert.equal(b.pixelHealth.totalPixels,1);assert.equal(b.pixelHealth.transparentPixels,0);
  const damaged=Buffer.from(colored);damaged[45]^=1;assert.throws(()=>inspectWorkbenchPng(damaged),{code:'WORKBENCH_CAPTURE_INVALID'});
  assert.throws(()=>inspectWorkbenchPng(colored,{width:2,height:1}),{code:'WORKBENCH_CAPTURE_INVALID'});
});

test('PNG health decodes Sub, Up, Average and Paeth rows with an independent zlib CRC oracle',()=>{
  const chunk=(type,bytes)=>{const name=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([name,bytes])));return Buffer.concat([size,name,bytes,crc])};
  const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
  const rows=[Buffer.from([0,0,0,255,12,34,56,0]),Buffer.from([6,8,10,255,0,0,0,255])];
  const p=(a,b,c)=>{const x=a+b-c,dist=[a,b,c].map(v=>Math.abs(x-v));return [a,b,c][dist.indexOf(Math.min(...dist))]};
  for(const filter of [1,2,3,4]){
    const filtered=Buffer.alloc(18);
    for(let y=0;y<2;y++){filtered[y*9]=filter;for(let x=0;x<8;x++){const left=x<4?0:rows[y][x-4],up=y?rows[y-1][x]:0,corner=y&&x>=4?rows[y-1][x-4]:0,predict=filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):p(left,up,corner);filtered[y*9+1+x]=(rows[y][x]-predict+256)%256;}}
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(filtered)),chunk('IEND',Buffer.alloc(0))]),info=inspectWorkbenchPng(png);
    assert.equal(info.pixelHealth.blackPixels,2,'filter '+filter);assert.equal(info.pixelHealth.nonblackPixels,2);assert.equal(info.pixelHealth.transparentPixels,1);assert.equal(info.pixelHealth.nonOpaquePixels,1);
  }
});

test('native health age is omitted for another sequence or malformed metadata',()=>{
  assert.equal(boundWorkbenchNativeHealth({...bmp(),nativeHealth:health(8)}),null);
  assert.equal(boundWorkbenchNativeHealth({...bmp(),nativeHealth:{...health(),frameAgeMs:-1}}),null);
  assert.equal(boundWorkbenchNativeHealth({...bmp(),nativeHealth:{...health(),meaning:'VM is off'}}),null);
  assert.deepEqual(boundWorkbenchNativeHealth({...bmp(),nativeHealth:health()}),health());
});

test('explicit content-addressed retention is exact, concurrent-safe and never rewrites an existing capture',async t=>{
  const root=await directory(t),bytes=workbenchFramePng(bmp([12,34,56])),info=inspectWorkbenchPng(bytes),args={workspace:root,scope:'task-one',bytes,info};
  const [a,b]=await Promise.all([retainWorkbenchCapture(args),retainWorkbenchCapture(args)]);assert.deepEqual(a,b);assert.equal(a.readBackVerified,true);assert.equal(a.sha256,hash(bytes));assert.equal(a.width,1);assert.equal(a.bytes,bytes.length);assert.match(a.guestRelativePath,/^\.blackice-workbench\\agent-captures\\[a-f0-9]{64}\\[a-f0-9]{64}\.png$/);assert.deepEqual(await fs.readFile(a.hostPath),bytes);
  const old=new Date('2000-01-01T00:00:00Z');await fs.utimes(a.hostPath,old,old);const before=(await fs.stat(a.hostPath)).mtimeMs;
  assert.deepEqual(await retainWorkbenchCapture(args),a);assert.equal((await fs.stat(a.hostPath)).mtimeMs,before);
});

test('wrong task scope manifest and altered existing PNG fail without overwriting bytes',async t=>{
  const root=await directory(t),bytes=workbenchFramePng(bmp([12,34,56])),info=inspectWorkbenchPng(bytes),args={workspace:root,scope:'task-one',bytes,info};
  const a=await retainWorkbenchCapture(args);await fs.writeFile(a.hostPath,'do not overwrite');
  await assert.rejects(retainWorkbenchCapture(args),{code:'WORKBENCH_CAPTURE_ARTIFACT'});assert.equal(await fs.readFile(a.hostPath,'utf8'),'do not overwrite');
  const other=path.join(root,'.blackice-workbench','agent-captures',hash('task-two'));await fs.mkdir(other);const marker=path.join(other,'scope.json');await fs.writeFile(marker,JSON.stringify({version:1,scopeHash:'x',kind:'workbench-capture'}));
  await assert.rejects(retainWorkbenchCapture({...args,scope:'task-two'}),{code:'WORKBENCH_CAPTURE_SCOPE'});assert.deepEqual(await fs.readdir(other),['scope.json']);
});

test('junction or symbolic directory cannot redirect retained images outside the workspace',async t=>{
  const parent=await directory(t),root=path.join(parent,'workspace'),outside=path.join(parent,'outside');await fs.mkdir(root);await fs.mkdir(outside);await fs.mkdir(path.join(root,'.blackice-workbench'));await fs.symlink(outside,path.join(root,'.blackice-workbench','agent-captures'),process.platform==='win32'?'junction':'dir');
  const bytes=workbenchFramePng(bmp());await assert.rejects(retainWorkbenchCapture({workspace:root,scope:'task',bytes,info:inspectWorkbenchPng(bytes)}),{code:'WORKBENCH_CAPTURE_PATH'});assert.deepEqual(await fs.readdir(outside),[]);
});

test('retained-file growth during readback is bounded before allocation and rejected',async t=>{
  const root=await directory(t),bytes=workbenchFramePng(bmp([12,34,56])),args={workspace:root,scope:'bounded-read',bytes,info:inspectWorkbenchPng(bytes)},first=await retainWorkbenchCapture(args);
  const original=fs.open;let grew=false,maxRead=0,unboundedRead=false;
  fs.open=async function(file,flags,...rest){const handle=await original.call(this,file,flags,...rest);
    if(file!==first.hostPath||typeof flags!=='number'||flags&(constants.O_WRONLY|constants.O_RDWR))return handle;
    return {stat:()=>handle.stat(),close:()=>handle.close(),readFile:()=>{unboundedRead=true;throw Error('Unbounded read prohibited')},read:async(...a)=>{maxRead=Math.max(maxRead,a[2]);if(!grew){grew=true;await fs.appendFile(first.hostPath,Buffer.alloc(1024*1024))}return handle.read(...a)}};
  };
  try{await assert.rejects(retainWorkbenchCapture(args),{code:'WORKBENCH_CAPTURE_ARTIFACT'});}finally{fs.open=original;}
  assert.equal(grew,true);assert.equal(unboundedRead,false);assert.equal(maxRead,4097);
});

test('USER read-only capture defaults to no retention; explicit retained outer-call replay keeps the same actual PNG',async t=>{
  const root=await directory(t),f=handler(root,{offline:true});t.after(()=>f.tool.close());await f.workbench.consoleControl.take();const owner=f.workbench.consoleControl.status();
  const plain=await f.call({action:'capture'});assert.equal(plain.success,true);assert.equal(meta(plain).artifact,undefined);await assert.rejects(fs.stat(path.join(root,'.blackice-workbench')),{code:'ENOENT'});
  const a=await f.call({action:'capture',retain:true},'capture-one'),b=await f.call({action:'capture',retain:true},'capture-one');assert.equal(a.success,true);assert.deepEqual(a,b);assert.equal(f.counts.native,2);assert.equal(f.counts.agent,0);assert.equal(f.counts.request,0);assert.deepEqual(await fs.readFile(meta(a).artifact.hostPath),pixels(a));assert.deepEqual(f.workbench.consoleControl.status(),owner);
  assert.equal((await f.call({action:'capture',retain:false},'capture-one')).code,'WORKBENCH_CAPTURE_CONFLICT');
  await fs.writeFile(meta(a).artifact.hostPath,'changed');assert.equal((await f.call({action:'capture',retain:true},'capture-one')).code,'WORKBENCH_CAPTURE_ARTIFACT');assert.equal(f.counts.native,2);
});

test('retention rejects changed configuration and status distinguishes host rights from the guest token',async t=>{
  const root=await directory(t),f=handler(root);t.after(()=>f.tool.close());
  const status=await f.call({action:'status'});assert.equal(status.success,true);const s=meta(status);assert.equal(s.hostRights.processElevated,true);assert.equal(s.guestPrivileges.administratorToken,false);assert.equal(s.guestPrivileges.known,true);assert.equal(s.scriptOutputMaximumBytes,16384);assert.equal(s.display.frameAgeMs,123);assert.equal(s.display.sequence,1);
  delete f.agent.privileges;assert.deepEqual(meta(await f.call({action:'status'})).guestPrivileges,{known:false,basis:'not-reported'});
  f.bridge.workspace=path.join(root,'other');assert.equal((await f.call({action:'capture',retain:true})).code,'WORKBENCH_CAPTURE_PATH');await assert.rejects(fs.stat(path.join(root,'.blackice-workbench')),{code:'ENOENT'});
});

test('capture metadata binds age to the same sequence and black never means the running VM is off',async t=>{
  const root=await directory(t),f=handler(root);t.after(()=>f.tool.close());
  f.workbench.guestNativeConsoleFrame=async()=>({...bmp(),nativeHealth:health(8)});
  const wrong=meta(await f.call({action:'capture'}));assert.equal(wrong.frameAgeMs,null);assert.equal(wrong.nativeHealth,undefined);assert.equal(wrong.pixelHealth.allBlack,true);
  f.workbench.guestNativeConsoleFrame=async()=>({...bmp(),nativeHealth:health()});
  const same=meta(await f.call({action:'capture'}));assert.equal(same.frameAgeMs,123);assert.equal(same.nativeHealth.meaning,'decoded-display-sample-not-vm-power-state');
  const status=meta(await f.call({action:'status'}));assert.equal(status.running,true);assert.equal(status.display.pixelHealth.classification,'black');assert.equal(status.display.nativeHealth.dark,true);
});

test('parallel duplicate capture call IDs read the original frame only once',async t=>{
  const root=await directory(t),f=handler(root);t.after(()=>f.tool.close());let release,entered;
  const pending=new Promise(r=>{release=r}),began=new Promise(r=>{entered=r});
  f.workbench.guestNativeConsoleFrame=async()=>{f.counts.native++;entered();await pending;return bmp([12,34,56])};
  const first=f.call({action:'capture'},'same-call');await began;const second=f.call({action:'capture'},'same-call');release();
  const [a,b]=await Promise.all([first,second]);assert.equal(a.success,true);assert.deepEqual(a,b);assert.equal(f.counts.native,1);
});

test('post-wake fresh black frames remain black observations, not proof of an awake desktop',async t=>{
  const root=await directory(t),f=handler(root);t.after(()=>f.tool.close());let sequence=7;
  f.workbench.guestNativeConsoleWake=()=>f.workbench.consoleControl.run(async check=>{check();return {surface:{sequence:7},wake:{requested:true,queued:true,desktopAwakeConfirmed:false}}});
  f.workbench.nativeConsoleAdapter={surface:async()=>({width:2,height:2}),input:async(_,check)=>{check();return {accepted:true}}};
  f.workbench.guestNativeConsoleFrame=async()=>bmp([0,0,0],++sequence);
  const owner=f.workbench.consoleControl.status(),result=await f.call({action:'wake_display'}),v=meta(result);
  assert.equal(result.success,true);assert.equal(v.movesRequested,2);assert.equal(v.desktopAwakeConfirmed,false);assert.equal(v.postWakeObservation.available,true);assert.equal(v.postWakeObservation.freshSequenceObserved,true);assert.equal(v.postWakeObservation.pixelHealth.allBlack,true);assert.deepEqual(f.workbench.consoleControl.status(),owner);
});

for(const change of ['abort','owner-epoch'])test(`wake preflight ${change} cannot dispatch into a later operation`,async t=>{
  const root=await directory(t),f=handler(root);t.after(()=>f.tool.close());const controller=new AbortController();let release,entered,wakes=0;
  const held=new Promise(r=>{release=r}),began=new Promise(r=>{entered=r}),context=f.jobs.context.bind(f.jobs);
  f.jobs.context=async(...args)=>{entered();await held;return context(...args)};
  f.workbench.guestNativeConsoleWake=async()=>{wakes++;return {requested:true}};
  const pending=f.call({action:'wake_display'},undefined,{signal:controller.signal});await began;
  if(change==='abort')controller.abort();else{const user=await f.workbench.consoleControl.take();await f.workbench.consoleControl.cede(user.controlToken);}
  release();const result=await pending;assert.equal(result.success,false);assert.equal(wakes,0);assert.equal(result.code,change==='abort'?'ABORT_ERR':'WORKBENCH_CONSOLE_CONTROL_CONFLICT');
});

test('native wake rechecks the original caller after waiting in the server ownership queue',async t=>{
  const root=await directory(t),f=handler(root);t.after(()=>f.tool.close());let release,entered,wakes=0;
  const held=new Promise(r=>{release=r}),began=new Promise(r=>{entered=r}),controller=new AbortController();
  f.workbench.nativeConsoleAdapter={wake:async(_,check)=>{check();wakes++;return {requested:true}}};
  f.workbench.guestNativeConsoleWake=WindowsWorkbench.prototype.guestNativeConsoleWake;
  const blocking=f.workbench.consoleControl.run(async()=>{entered();await held});await began;
  const pending=f.call({action:'wake_display'},undefined,{signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();release();await blocking;
  const result=await pending;assert.equal(result.success,false);assert.equal(wakes,0);assert.equal(result.code,'ABORT_ERR');
});

test('cancelling an issued first nudge waits its receipt and prevents the return nudge',async t=>{
  const root=await directory(t),f=handler(root);t.after(()=>f.tool.close());let release,entered,inputs=0;
  const held=new Promise(r=>{release=r}),began=new Promise(r=>{entered=r}),controller=new AbortController();
  f.workbench.guestNativeConsoleWake=async(_,check)=>{check();return {requested:true}};
  f.workbench.nativeConsoleAdapter={surface:async()=>({width:2,height:2}),input:async(_,check)=>{check();inputs++;entered();await held;return {accepted:true}}};
  let settled=false;const pending=f.call({action:'wake_display'},undefined,{signal:controller.signal}).then(r=>{settled=true;return r});await began;controller.abort();await new Promise(r=>setImmediate(r));assert.equal(settled,false);release();
  const result=await pending;assert.equal(result.success,false);assert.equal(result.code,'ABORT_ERR');assert.equal(inputs,1);
});

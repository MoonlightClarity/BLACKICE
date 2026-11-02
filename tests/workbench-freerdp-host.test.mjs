import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {WorkbenchFreeRDPHost} from '../desktop/workbench-freerdp-host.mjs';

const bytes=Buffer.from('verified fixture helper'),hash=createHash('sha256').update(bytes).digest('hex');
const vmId='11111111-2222-4333-8444-555555555555',certificateSha256='a'.repeat(64);
const nativeResult=request=>({prepared:true,connected:true,certificateVerified:true,selectedProtocol:2,decodedFrames:1,
  inputOwner:request.action==='input'&&request.enabled?'user':'agent',surface:{width:1024,height:768}});
function fixture(reply,options={}){
  const calls=[],spawns=[];
  const spawnImpl=(exe,args,options)=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};
    child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.killed=false;
    child.stdin.write=line=>{
      const request=JSON.parse(line);calls.push(request);
      const result=reply?.(request)??nativeResult(request);
      if(result==='timeout')return;
      setImmediate(()=>child.stdout.emit('data',JSON.stringify({requestId:request.requestId,ok:true,result})+'\n'));
    };
    child.stdin.end=()=>{};child.kill=()=>{child.killed=true;child.emit('exit',0)};
    spawns.push({exe,args,options,child});return child;
  };
  const host=new WorkbenchFreeRDPHost({helperPath:path.resolve('fixture-native.exe'),helperSha256:hash,
    runtimeDirectory:path.resolve('fixture-runtime'),readFileImpl:async()=>bytes,spawnImpl,timeoutMs:40,...options});
  const handle=Buffer.alloc(8);handle.writeBigUInt64LE(123n);
  const window={getNativeWindowHandle:()=>handle,isDestroyed:()=>false,getContentSize:()=>[1000,800]};
  return {host,window,calls,spawns};
}
test('an acknowledged native failure retains only bounded connection diagnostics and actual exit receipt',async()=>{
  const f=fixture(request=>request.action==='connect'?'timeout':nativeResult(request));
  await f.host.prepare(bounds,f.window);
  const connection=f.host.connect({vmId,certificateSha256}),rejected=assert.rejects(connection,error=>{
    assert.equal(error.code,'CONNECT_FAILED');assert.equal(error.nativeAcknowledged,true);
    assert.deepEqual(error.nativeDiagnostics,{connected:false,digestReady:true,certificateVerified:true,coreError:131077,decodedFrames:0,
      connectionProgress:{state:'CONNECTION_STATE_NLA',tlsFinished:true,readBytes:321},surface:{sequence:0,width:800,height:600}});
    assert.equal(JSON.stringify(error.nativeDiagnostics).includes('private'),false);return true;
  });
  await new Promise(resolve=>setImmediate(resolve));
  const request=f.calls.at(-1);f.spawns[0].child.stdout.emit('data',JSON.stringify({requestId:request.requestId,ok:false,code:'CONNECT_FAILED',error:'Session ended.',result:{
    connected:false,digestReady:true,certificateVerified:true,coreError:131077,decodedFrames:0,authenticationServer:'private-host',password:'private-token',pixels:['private'],
    connectionProgress:{state:'CONNECTION_STATE_NLA',tlsFinished:true,readBytes:321,path:'C:/private'},surface:{sequence:0,width:800,height:600,bytes:'private'}}})+'\n');
  await rejected;assert.equal(f.calls.filter(c=>c.action==='connect').length,1);
  const closed=await f.host.close();assert.equal(closed.cleanup.confirmed,true);assert.equal(closed.cleanup.exited,true);assert.equal(closed.cleanup.exitCode,0);
});
test('a kill request is not exit proof; later actual exit updates cleanup without respawning',async()=>{
  const f=fixture(undefined,{closeTimeoutMs:20});await f.host.prepare(bounds,f.window);
  const child=f.spawns[0].child;child.kill=()=>{child.killed=true;return true;};
  const closed=await f.host.close();assert.equal(closed.cleanup.confirmed,false);assert.equal(closed.cleanup.exited,false);assert.equal(closed.uncertain,true);
  await assert.rejects(f.host.prepare(bounds,f.window),/closed/);assert.equal(f.spawns.length,1);
  child.emit('exit',7,'SIGTERM');const status=await f.host.status();assert.equal(status.cleanup.confirmed,true);assert.equal(status.cleanup.exitCode,7);assert.equal(status.cleanup.signal,'SIGTERM');assert.equal(status.uncertain,false);
});
test('an unexpected helper exit keeps uncertain delivery and publishes the observed exit code',async()=>{
  const f=fixture();await f.host.prepare(bounds,f.window);f.spawns[0].child.emit('exit',9,null);
  const status=await f.host.status();assert.equal(status.uncertain,true);assert.equal(status.cleanup.confirmed,true);assert.equal(status.cleanup.exitCode,9);assert.equal(status.displayReady,false);assert.equal(f.spawns.length,1);await f.host.close();
});
test('a missing acknowledgement flag is uncertain and cannot masquerade as an acknowledged connect failure',async()=>{
  const f=fixture(request=>request.action==='connect'?'timeout':nativeResult(request));await f.host.prepare(bounds,f.window);
  const connecting=f.host.connect({vmId,certificateSha256}),rejected=assert.rejects(connecting,error=>{assert.equal(error.code,'WORKBENCH_NATIVE_UNCERTAIN');assert.equal(error.nativeAcknowledged,undefined);return true;});
  await new Promise(resolve=>setImmediate(resolve));const request=f.calls.at(-1);f.spawns[0].child.stdout.emit('data',JSON.stringify({requestId:request.requestId,code:'CONNECT_FAILED',result:{coreError:1}})+'\n');
  await rejected;assert.equal(f.host.uncertain,true);await f.host.close();
});
test('cleanup confirmation follows a real isolated child exit event, without running native or network code',async t=>{
  let child;
  const script="require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:r.action==='prepare'?{prepared:true}:{closed:true}})+'\\n',()=>{if(r.action==='close')process.exit(7)});});";
  const host=new WorkbenchFreeRDPHost({helperPath:path.resolve('isolated-fixture-only'),helperSha256:hash,runtimeDirectory:path.resolve('.'),readFileImpl:async()=>bytes,closeTimeoutMs:1000,
    spawnImpl:()=>child=spawn(process.execPath,['-e',script],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']})});
  t.after(()=>host.close());
  const handle=Buffer.alloc(8);handle.writeBigUInt64LE(123n);const window={getNativeWindowHandle:()=>handle,isDestroyed:()=>false,getContentSize:()=>[1000,800]};
  await host.prepare(bounds,window);assert.ok(child.pid>0);const closed=await host.close();assert.equal(closed.cleanup.confirmed,true);assert.equal(closed.cleanup.exited,true);assert.equal(closed.cleanup.started,true);
  assert.ok(Number.isSafeInteger(closed.cleanup.exitCode)||closed.cleanup.signal!==null,'Actual OS exit or termination signal must be observed.');
});
const bounds={x:5,y:40,width:800,height:600};
test('verified helper creates child before connecting, serializes lifecycle, and reports real decoded readiness',async()=>{
  const f=fixture();
  await assert.rejects(f.host.connect({vmId,certificateSha256}),/Prepare/);
  assert.equal(f.spawns.length,0);
  assert.equal((await f.host.prepare(bounds,f.window)).displayReady,false);
  const connection=await f.host.connect({vmId,certificateSha256});
  assert.equal(connection.displayReady,true);
  await Promise.all([f.host.visible(true),f.host.inputOwner('user'),f.host.inputOwner('agent')]);
  assert.deepEqual(f.calls.map(c=>c.action),['prepare','connect','visible','input','input']);
  assert.equal(f.calls[0].parent,'123');
  assert.equal(f.calls[1].host,'127.0.0.1');assert.equal(f.calls[1].port,2179);
  assert.equal(f.spawns.length,1);assert.equal(f.spawns[0].options.shell,false);
  assert.equal(f.spawns[0].options.windowsHide,true);
  assert.equal(f.spawns[0].options.env.WINPR_NATIVE_SSPI,'1');
  assert.equal(f.calls[3].enabled,true);assert.equal(f.calls[4].enabled,false);
  await f.host.inputOwner('user');
  await assert.rejects(f.host.agentInput({kind:'key',scanCode:30,flags:0}),/agent must own/i);
  await f.host.inputOwner('agent');
  await assert.rejects(f.host.agentInput({kind:'mouse',x:2000,y:0,flags:0x800}),/outside/);
  await f.host.agentInput({kind:'key',scanCode:30,flags:0x8000});
  await Promise.all([f.host.close(),f.host.close()]);await f.host.close();
  assert.equal(f.calls.filter(c=>c.action==='close').length,1);
  assert.equal(f.spawns[0].child.killed,true);
});
test('authentication without guest pixels never becomes display ready',async()=>{
  const f=fixture(r=>r.action==='prepare'?{prepared:true}:{connected:true,certificateVerified:true,selectedProtocol:2,decodedFrames:0});
  await f.host.prepare(bounds,f.window);
  assert.equal((await f.host.connect({vmId,certificateSha256})).displayReady,false);
  assert.equal((await f.host.status()).displayReady,false);
  await f.host.close();
});

test('a fresh disconnected status is certain while cached or timed-out status cannot authorize reconnect',async()=>{
  let timeout=false;
  const f=fixture(r=>r.action==='status'?(timeout?'timeout':{connected:false,decodedFrames:0}):{prepared:true});
  await f.host.prepare(bounds,f.window);
  const disconnected=await f.host.status();
  assert.equal(disconnected.connected,false);assert.equal(disconnected.uncertain,false);assert.notEqual(disconnected.cached,true);
  timeout=true;await assert.rejects(f.host.status(),{code:'WORKBENCH_NATIVE_UNCERTAIN'});
  const cached=await f.host.status();assert.equal(cached.uncertain,true);assert.equal(cached.cached,true);assert.equal(cached.displayReady,false);
  await f.host.close();
});
test('unverified binary, invalid certificate, and out-of-parent bounds cannot launch or connect',async()=>{
  const f=fixture();
  await assert.rejects(f.host.prepare({...bounds,width:2000},f.window),/exceeds/);
  assert.equal(f.spawns.length,0);
  f.host.helperSha256='b'.repeat(64);
  await assert.rejects(f.host.prepare(bounds,f.window),/bytes differ/);
  assert.equal(f.spawns.length,0);
  f.host.helperSha256=hash;
  await f.host.prepare(bounds,f.window);
  await assert.rejects(f.host.connect({vmId,certificateSha256:'ignore'}),/trusted host certificate/);
  assert.equal(f.calls.length,1);
  await f.host.close();
});
test('uncertain delivery and malformed receipts never relaunch or automatically retry the helper',async()=>{
  const f=fixture(r=>r.action==='status'?'timeout':{prepared:true});
  await f.host.prepare(bounds,f.window);
  await assert.rejects(f.host.status(),e=>e.code==='WORKBENCH_NATIVE_UNCERTAIN');
  const cached=await f.host.status();
  assert.equal(cached.uncertain,true);assert.equal(cached.displayReady,false);assert.equal(cached.cached,true);
  await assert.rejects(f.host.visible(true),/Inspect/);
  assert.equal(f.calls.filter(c=>c.action==='status').length,1);
  assert.equal(f.spawns.length,1);
  await f.host.close();
  assert.equal(f.spawns[0].child.killed,true);
  const g=fixture(r=>r.action==='status'?'timeout':{prepared:true});
  await g.host.prepare(bounds,g.window);
  const pending=g.host.status();
  await new Promise(resolve=>setImmediate(resolve));
  g.spawns[0].child.stdout.emit('data','not-json\n');
  await assert.rejects(pending,/Malformed/);
  assert.equal(g.spawns[0].child.killed,true);
  assert.equal((await g.host.status()).uncertain,true);
  await g.host.close();
});

test('native ownership mismatches and malformed acknowledgements close before rejecting the transfer',async()=>{
  for(const [owner,result] of [['user',{inputOwner:'agent'}],['agent',{inputOwner:'user'}],['user',{}],['agent',[]],['user','malformed']]){
    const f=fixture(request=>request.action==='input'?result:undefined);
    await f.host.prepare(bounds,f.window);await f.host.connect({vmId,certificateSha256});
    assert.equal(f.host.last.displayReady,true);
    await assert.rejects(f.host.inputOwner(owner),{code:'WORKBENCH_NATIVE_OWNERSHIP'});
    assert.equal(f.host.closed,true);assert.equal(f.spawns[0].child.killed,true);
    assert.equal(f.host.last.displayReady,false);assert.equal((await f.host.status()).displayReady,false);
    assert.equal(f.calls.filter(request=>request.action==='input').length,1);
    const count=f.calls.length;
    await assert.rejects(f.host.agentInput({kind:'key',scanCode:30,flags:0}),/agent must own/i);
    assert.equal(f.calls.length,count);assert.equal(f.spawns.length,1);
  }
});

test('native pixel sampling validates dimensions, coordinates and actual RGB receipts',async()=>{
  const expected={sequence:9,frameAtMonotonicMs:1234,width:1024,height:768,
    points:[{x:0,y:0,r:0,g:128,b:255},{x:1023,y:767,r:17,g:18,b:19}]};
  const f=fixture(request=>request.action==='sample'?structuredClone(expected):undefined);
  await f.host.prepare(bounds,f.window);await f.host.connect({vmId,certificateSha256});
  const points=[{x:0,y:0},{x:1023,y:767}];
  assert.deepEqual(await f.host.sample(points),expected);
  assert.deepEqual(f.calls.at(-1).points,points);
  const before=f.calls.length;
  for(const invalid of [[{x:1024,y:0}],[{x:0,y:768}],[{x:-1,y:0}],[{x:0.5,y:0}],[]])await assert.rejects(f.host.sample(invalid),/Sample up to/);
  for(const surface of [undefined,{}, {width:0,height:768},{width:1024,height:NaN},{width:4097,height:768},{width:1024.5,height:768}]){
    f.host.last.surface=surface;
    await assert.rejects(f.host.sample([{x:0,y:0}]),/Sample up to/);
  }
  assert.equal(f.calls.length,before);await f.host.close();
});

test('native sampling rejects mismatched dimensions, reordered coordinates and invalid colour/time fields',async()=>{
  const valid={sequence:9,frameAtMonotonicMs:1234,width:1024,height:768,points:[{x:2,y:3,r:1,g:2,b:3}]};
  for(const changed of [
    {width:800},{height:0},{sequence:0},{sequence:1.5},{frameAtMonotonicMs:-1},
    {frameAtMonotonicMs:1.5},{points:[]},{points:[{x:3,y:2,r:1,g:2,b:3}]},
    {points:[{x:2,y:3,r:256,g:2,b:3}]},{points:[{x:2,y:3,r:1,g:2,b:'3'}]},
    {points:[{x:2,y:3,r:1,g:2}]},
  ]){
    const f=fixture(request=>request.action==='sample'?{...valid,...changed}:undefined);
    await f.host.prepare(bounds,f.window);await f.host.connect({vmId,certificateSha256});
    await assert.rejects(f.host.sample([{x:2,y:3}]),/pixel sample did not match/);
    await f.host.close();
  }
});

test('native viewport validates DIP bounds before rounding the configured physical scale',async()=>{
  const scales=[];
  const f=fixture(undefined,{scaleFactor:host=>{scales.push(host);return 1.5}});
  await f.host.prepare(bounds,f.window);
  assert.deepEqual(Object.fromEntries(['x','y','width','height'].map(key=>[key,f.calls[0][key]])),{x:8,y:60,width:1200,height:900});
  await f.host.position({x:1,y:1,width:200,height:160},f.window);
  assert.deepEqual(Object.fromEntries(['x','y','width','height'].map(key=>[key,f.calls[1][key]])),{x:2,y:2,width:300,height:240});
  assert.deepEqual(scales,[f.window,f.window]);await f.host.close();
  const outside=fixture(undefined,{scaleFactor:()=>0.5});
  await assert.rejects(outside.host.prepare({...bounds,width:1200},outside.window),/exceeds/);
  assert.equal(outside.spawns.length,0);
  for(const factor of [NaN,Infinity,0,0.24,16.1,'2',null]){
    const invalid=fixture(undefined,{scaleFactor:()=>factor});
    await assert.rejects(invalid.host.prepare(bounds,invalid.window),/scale/);
    assert.equal(invalid.spawns.length,0);
  }
  const tooLarge=fixture(undefined,{scaleFactor:()=>6});
  await assert.rejects(tooLarge.host.prepare(bounds,tooLarge.window),/physical guest viewport/);
  assert.equal(tooLarge.spawns.length,0);
});
test('closing during build verification cannot leave a helper running after close',async()=>{
  const f=fixture();let finishRead;
  f.host.readFileImpl=()=>new Promise(resolve=>{finishRead=resolve});
  const preparing=f.host.prepare(bounds,f.window);
  await new Promise(resolve=>setImmediate(resolve));
  await f.host.close();finishRead(bytes);
  await assert.rejects(preparing,/closed while/);
  assert.equal(f.spawns.length,0);
  assert.equal(f.host.closed,true);
});
test('zoom-out CSS viewport may exceed DIP dimensions while physical native pixels stay bounded',async()=>{
  const f=fixture(undefined,{contentScaleFactor:()=>0.5,scaleFactor:()=>2.5*0.5});
  await f.host.prepare({x:10,y:20,width:1600,height:1200},f.window);
  assert.deepEqual(Object.fromEntries(['x','y','width','height'].map(key=>[key,f.calls[0][key]])),{x:13,y:25,width:2000,height:1500});
  const before=f.calls.length;
  await assert.rejects(f.host.position({x:500,y:0,width:1600,height:1200},f.window),/exceeds/);
  assert.equal(f.calls.length,before);await f.host.close();
  const zoomIn=fixture(undefined,{contentScaleFactor:()=>2,scaleFactor:()=>2.5*2});
  await assert.rejects(zoomIn.host.prepare(bounds,zoomIn.window),/exceeds/);
  assert.equal(zoomIn.spawns.length,0);
  await zoomIn.host.prepare({x:10,y:20,width:300,height:200},zoomIn.window);
  assert.deepEqual(Object.fromEntries(['x','y','width','height'].map(key=>[key,zoomIn.calls[0][key]])),{x:50,y:100,width:1500,height:1000});
  await zoomIn.host.close();
  for(const contentScaleFactor of [()=>NaN,()=>0,()=>17,()=>{throw Error('no zoom')}]){
    const invalid=fixture(undefined,{contentScaleFactor});
    await assert.rejects(invalid.host.prepare(bounds,invalid.window),/content viewport scale/);
    assert.equal(invalid.spawns.length,0);
  }
});
test('close bounds an in-flight native operation and retires its worker without waiting for the request deadline',async()=>{
  const f=fixture(request=>request.action==='status'?'timeout':undefined,{timeoutMs:5000,closeTimeoutMs:30});
  await f.host.prepare(bounds,f.window);
  const status=f.host.status(),rejected=assert.rejects(status,/closed/);
  await new Promise(resolve=>setImmediate(resolve));
  const started=performance.now();await f.host.close();await rejected;
  assert.ok(performance.now()-started<500,'close waited for an unrelated 5-second operation');
  assert.equal(f.host.closed,true);assert.equal(f.spawns[0].child.killed,true);
  assert.equal((await f.host.status()).displayReady,false);
});
test('explicit display wake preserves the acknowledged owner and never claims that pixels are awake',async()=>{
  const f=fixture(request=>request.action==='wake'?{...nativeResult(request),inputOwner:request.expectedOwner,
    wake:{requested:true,queued:true,desktopAwakeConfirmed:false}}:undefined);
  await assert.rejects(f.host.wakeDisplay('agent'),{code:'WORKBENCH_NATIVE_WAKE_REJECTED'});assert.equal(f.spawns.length,0);
  await f.host.prepare(bounds,f.window);await f.host.connect({vmId,certificateSha256});
  await assert.rejects(f.host.wakeDisplay('user'),{code:'WORKBENCH_NATIVE_WAKE_REJECTED'});
  const agent=await f.host.wakeDisplay('agent');assert.equal(agent.inputOwner,'agent');assert.equal(agent.wake.desktopAwakeConfirmed,false);
  await f.host.inputOwner('user');const count=f.calls.filter(request=>request.action==='input').length;
  const user=await f.host.wakeDisplay('user');assert.equal(user.inputOwner,'user');
  assert.equal(f.calls.filter(request=>request.action==='input').length,count);
  assert.deepEqual(f.calls.filter(request=>request.action==='wake').map(({expectedOwner})=>expectedOwner),['agent','user']);
  await f.host.close();
});
test('a malformed wake acknowledgement becomes uncertain without retrying or changing input ownership',async()=>{
  const f=fixture(request=>request.action==='wake'?{...nativeResult(request),inputOwner:'agent',wake:{requested:true,queued:true,desktopAwakeConfirmed:true}}:undefined);
  await f.host.prepare(bounds,f.window);await f.host.connect({vmId,certificateSha256});
  await assert.rejects(f.host.wakeDisplay('agent'),{code:'WORKBENCH_NATIVE_WAKE_UNCERTAIN'});
  assert.equal(f.calls.filter(request=>request.action==='wake').length,1);assert.equal(f.calls.filter(request=>request.action==='input').length,0);
  assert.equal((await f.host.status()).uncertain,true);await f.host.close();
});
test('detached host creates its own window and never uses launcher layout to move or resize it',async()=>{
  const f=fixture(request=>({...nativeResult(request),detached:true,workbenchWindowHwnd:'456',windowCloseRevision:2,windowVisible:request.visible===true}),
    {detachedWindow:true,scaleFactor:()=>assert.fail('Detached layout must not use launcher scale'),contentScaleFactor:()=>assert.fail('Detached layout must not use launcher zoom')});
  f.window.getContentSize=()=>assert.fail('Detached layout must not inspect launcher dimensions');
  await f.host.prepare(undefined,f.window);assert.deepEqual(f.spawns[0].args,['--stream-detached']);
  assert.deepEqual(Object.keys(f.calls[0]).sort(),['action','parent','requestId']);
  await f.host.connect({vmId,certificateSha256});
  const positioned=await f.host.position({unrelated:true},null);assert.equal(positioned.boundsIgnored,true);
  assert.equal(f.calls.some(request=>request.action==='bounds'),false);
  await f.host.visible(true,{expectedWindowCloseRevision:2});assert.equal(f.calls.at(-1).expectedWindowCloseRevision,2);
  await f.host.visible(false);assert.equal(f.host.closed,false);
  await f.host.close();
});
const controlConfig={enabled:true,busy:false,message:'Agent control',clipboardEnabled:false,fitEnabled:true,powerState:'running'};
const controlEvent=(sequence=1,extra={})=>({event:'nativeControl',sequence,action:'take',windowHwnd:'456',inputOwner:'agent',...extra});
test('native toolbar events validate exact shape, drop replay and never block pending NDJSON replies',async()=>{
  const received=[];let release;const held=new Promise(resolve=>{release=resolve});
  const f=fixture(undefined,{onControl:event=>{received.push(event);return held}});
  await f.host.prepare(bounds,f.window);const child=f.spawns[0].child;
  const emit=event=>child.stdout.emit('data',JSON.stringify(event)+'\n');
  emit(controlEvent());emit(controlEvent());emit(controlEvent(2,{extra:true}));emit(controlEvent(2,{enabled:true}));
  emit(controlEvent(2,{action:'clipboard'}));emit(controlEvent(2,{action:'fit',enabled:true}));
  emit(controlEvent(3,{windowHwnd:'0'}));emit(controlEvent(3,{action:'unknown'}));emit(controlEvent(3,{inputOwner:'none'}));
  await f.host.status();assert.deepEqual(received.map(event=>[event.sequence,event.action]),[[1,'take'],[2,'fit']]);
  release();await f.host.close();emit(controlEvent(4));await new Promise(resolve=>setImmediate(resolve));assert.equal(received.length,2);
});
test('native toolbar configuration verifies every acknowledgement and supports a prepared disconnected helper',async()=>{
  const f=fixture(request=>({...nativeResult(request),connected:false,decodedFrames:0,
    ...(request.action==='controls'?{controls:{available:true,eventSequence:0,...controlConfig}}:{})}));
  await assert.rejects(f.host.configureControls(controlConfig));assert.equal(f.spawns.length,0);
  await f.host.prepare(bounds,f.window);const configured=await f.host.configureControls(controlConfig);
  assert.equal(configured.displayReady,false);assert.equal(configured.controls.available,true);
  assert.deepEqual(Object.fromEntries(Object.keys(controlConfig).map(key=>[key,f.calls.at(-1)[key]])),controlConfig);
  const count=f.calls.length;
  for(const invalid of [{...controlConfig,extra:true},{...controlConfig,message:'x'.repeat(161)},{...controlConfig,busy:'false'},
    {...controlConfig,powerState:'stopped'},{...controlConfig,message:'bad\0message'},{}])await assert.rejects(f.host.configureControls(invalid));
  assert.equal(f.calls.length,count);await f.host.close();
  for(const changed of [{available:false},{enabled:false},{eventSequence:-1},{extra:true}]){
    const g=fixture(request=>request.action==='controls'?{controls:{available:true,eventSequence:0,...controlConfig,...changed}}:undefined);
    await g.host.prepare(bounds,g.window);await assert.rejects(g.host.configureControls(controlConfig),{code:'WORKBENCH_NATIVE_CONTROLS'});
    assert.equal(g.host.uncertain,true);await g.host.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

export function nativeFixtureFrame(width=1024,height=768){
  const bytes=Buffer.alloc(54+width*height*4);bytes.write('BM');bytes.writeUInt32LE(bytes.length,2);bytes.writeUInt32LE(54,10);
  bytes.writeUInt32LE(40,14);bytes.writeInt32LE(width,18);bytes.writeInt32LE(-height,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);
  return {bytes,contentType:'image/bmp',width,height,sequence:1};
}
const bench=()=>new WindowsWorkbench({dataDir:path.resolve('fixture-native-adapter'),probe:async()=>{throw Error('No Hyper-V probe is allowed.');},consoleController:{frame:()=>assert.fail('Native capture must not fall back to legacy thumbnail.')}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};

test('native frame uses explicit BMP contract and fresh native dimensions without legacy fallback',async()=>{
  const vm=bench(),frame=nativeFixtureFrame();let captures=0,surface={width:1024,height:768};const inputs=[];
  await assert.rejects(vm.guestNativeConsoleFrame(),{code:'WORKBENCH_NATIVE_UNAVAILABLE'});
  await vm.setGuestNativeConsoleAdapter({frame:async()=>{captures++;return frame;},surface:async()=>surface,input:async(value,assertCurrent)=>{assertCurrent();inputs.push(value);return {queued:true};}});
  assert.equal((await vm.guestNativeConsoleFrame()).bytes,frame.bytes);
  assert.equal((await vm.guestNativeConsoleInput({kind:'mouse',x:1023,y:767,flags:0x0800})).queued,true);
  assert.equal(captures,1,'Fresh surface metadata avoids capturing a full BMP for every input.');
  surface={width:800,height:600};
  await assert.rejects(vm.guestNativeConsoleInput({kind:'mouse',x:800,y:599,flags:0x0800}),{code:'WORKBENCH_NATIVE_INPUT_INVALID'});
  assert.equal(inputs.length,1);
  await vm.setGuestNativeConsoleAdapter(null);
  await assert.rejects(vm.guestNativeConsoleFrame(),{code:'WORKBENCH_NATIVE_UNAVAILABLE'});
});

test('native agent input shares Take/Cede fence and a valid user token cannot authorize that path',async()=>{
  const vm=bench(),gate=deferred(),frame=nativeFixtureFrame(),inputs=[];
  await vm.setGuestNativeConsoleAdapter({frame:async()=>frame,surface:async()=>{await gate.promise;return frame;},input:async(value,assertCurrent)=>{assertCurrent();inputs.push(value);return {queued:true};}});
  const pending=vm.guestNativeConsoleInput({kind:'key',scanCode:30,flags:0});await tick();
  const take=vm.takeGuestConsoleControl();gate.resolve();
  await assert.rejects(pending,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const receipt=await take;assert.equal(inputs.length,0);
  await assert.rejects(vm.guestNativeConsoleInput({kind:'key',scanCode:30,flags:0},receipt.controlToken),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  assert.equal((await vm.guestNativeConsoleFrame()).width,1024,'Native inspection remains available during user control.');
  await vm.cedeGuestConsoleControl(receipt.controlToken);
  assert.equal((await vm.guestNativeConsoleInput({kind:'key',scanCode:30,flags:0x8100})).queued,true);
  await vm.consoleControl.failClosed(Error('fixture native failure'),[]).catch(()=>{});
  await assert.rejects(vm.guestNativeConsoleInput({kind:'key',scanCode:30,flags:0}),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
});

test('native input rejects unknown fields, host coordinates, invalid scan codes and unsupported flags before dispatch',async()=>{
  const vm=bench();let called=0;
  await vm.setGuestNativeConsoleAdapter({frame:async()=>{called++;return nativeFixtureFrame();},input:async()=>{called++;}});
  for(const value of [
    {kind:'mouse',x:0,y:0,flags:0x0800,controlToken:'user'},
    {kind:'mouse',x:4096,y:0,flags:0x0800}, {kind:'mouse',x:-1,y:0,flags:0x0800},
    {kind:'key',scanCode:256,flags:0}, {kind:'key',scanCode:30,flags:1},
    {kind:'key',scanCode:30,flags:0,text:'host'}, {kind:'key',scanCode:30},
  ])assert.throws(()=>vm.guestNativeConsoleInput(value),{code:'WORKBENCH_NATIVE_INPUT_INVALID'});
  assert.equal(called,0);
});

test('native capture rejects mismatched BMP receipts and stale adapters',async()=>{
  const vm=bench(),frame=nativeFixtureFrame();
  await vm.setGuestNativeConsoleAdapter({frame:async()=>({...frame,width:800}),input:async()=>{}});
  await assert.rejects(vm.guestNativeConsoleFrame(),{code:'WORKBENCH_NATIVE_FRAME_INVALID'});
  await vm.setGuestNativeConsoleAdapter({frame:async()=>({...frame,contentType:'image/jpeg'}),input:async()=>{}});
  await assert.rejects(vm.guestNativeConsoleFrame(),{code:'WORKBENCH_NATIVE_FRAME_INVALID'});
  const gate=deferred();await vm.setGuestNativeConsoleAdapter({frame:async()=>{await gate.promise;return frame;},input:async()=>{}});
  const pending=vm.guestNativeConsoleFrame();await tick();await vm.setGuestNativeConsoleAdapter(null);gate.resolve();
  await assert.rejects(pending,{code:'WORKBENCH_NATIVE_UNAVAILABLE'});
});

test('explicit native wake preserves the current owner and requires the user receipt',async()=>{
  const vm=bench(),frame=nativeFixtureFrame(),wakes=[];
  await assert.rejects(vm.guestNativeConsoleWake(),{code:'WORKBENCH_NATIVE_UNAVAILABLE'});
  await vm.setGuestNativeConsoleAdapter({frame:async()=>frame,input:async()=>{}});
  await assert.rejects(vm.guestNativeConsoleWake(),{code:'WORKBENCH_NATIVE_UNAVAILABLE'});
  assert.throws(()=>vm.setGuestNativeConsoleAdapter({frame:async()=>frame,input:async()=>{},wake:true}),{code:'WORKBENCH_NATIVE_ADAPTER_INVALID'});
  await vm.setGuestNativeConsoleAdapter({frame:async()=>frame,input:async()=>assert.fail('Wake is a separate bounded callback.'),wake:async(value,assertCurrent)=>{assertCurrent();wakes.push(value);return {queued:true};}});
  assert.deepEqual(await vm.guestNativeConsoleWake(),{queued:true,consoleControl:{owner:'agent',revision:0}});
  const receipt=await vm.takeGuestConsoleControl();
  await assert.rejects(vm.guestNativeConsoleWake(),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  await assert.rejects(vm.guestNativeConsoleWake('wrong-token'),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  assert.deepEqual(await vm.guestNativeConsoleWake(receipt.controlToken),{queued:true,consoleControl:{owner:'user',revision:receipt.revision}});
  assert.deepEqual(wakes,[{owner:'agent'},{owner:'user'}]);
  assert.equal(vm.consoleControl.token,receipt.controlToken);
  await vm.cedeGuestConsoleControl(receipt.controlToken);
  await assert.rejects(vm.guestNativeConsoleWake(receipt.controlToken),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  await vm.consoleControl.failClosed(Error('fixture'),[]).catch(()=>{});
  await assert.rejects(vm.guestNativeConsoleWake(),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  assert.equal(wakes.length,2);
});

test('wake rechecks the owner revision and adapter and does not alter ownership on dispatch failure',async()=>{
  const vm=bench(),frame=nativeFixtureFrame(),gate=deferred();let dispatched=0;
  const adapter={frame:async()=>frame,input:async()=>{},wake:async(value,assertCurrent)=>{await gate.promise;assertCurrent();dispatched++;return {queued:true};}};
  await vm.setGuestNativeConsoleAdapter(adapter);
  const pending=vm.guestNativeConsoleWake();await tick();
  const take=vm.takeGuestConsoleControl();gate.resolve();
  await assert.rejects(pending,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const receipt=await take;assert.equal(dispatched,0);
  adapter.wake=async()=>{throw Object.assign(Error('Native wake rejected'),{code:'INPUT_REJECTED'});};
  await assert.rejects(vm.guestNativeConsoleWake(receipt.controlToken),{code:'INPUT_REJECTED'});
  assert.deepEqual(vm.consoleControl.status(),{owner:'user',revision:receipt.revision});
  assert.equal(vm.consoleControl.token,receipt.controlToken);
  adapter.wake=async()=>{vm.nativeConsoleAdapter=null;return {queued:true};};
  await assert.rejects(vm.guestNativeConsoleWake(receipt.controlToken),{code:'WORKBENCH_NATIVE_UNAVAILABLE'});
});

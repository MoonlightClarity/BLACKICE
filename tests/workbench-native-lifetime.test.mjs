import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbenchLauncherCloseHandler} from '../desktop/workbench-native-lifetime.mjs';
import {DesktopLifecycle} from '../desktop/lifecycle.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
test('main-window close coalesces into background while detached session and owner remain intact',async()=>{
  const held=deferred();let prevented=0,backgrounds=0,ordinary=0,guestInputs=0;
  const session={owner:'user',connected:true};
  const close=createWorkbenchLauncherCloseHandler({shouldRetain:()=>session.connected,
    background:async()=>{backgrounds++;await held.promise},ordinary:()=>{ordinary++;guestInputs++}});
  const first=close({preventDefault:()=>prevented++}),second=close({preventDefault:()=>prevented++});
  await Promise.resolve();assert.equal(backgrounds,1);assert.equal(prevented,2);assert.equal(ordinary,0);
  held.resolve();await Promise.all([first,second]);assert.deepEqual(session,{owner:'user',connected:true});assert.equal(guestInputs,0);
});
test('background failure keeps the close prevented and allows an explicit retry without destroying the session',async()=>{
  let attempts=0,errors=0,ordinary=0,prevented=0;
  const close=createWorkbenchLauncherCloseHandler({shouldRetain:()=>true,background:async()=>{attempts++;if(attempts===1)throw Error('save failed')},
    ordinary:()=>ordinary++,onError:()=>errors++});
  await close({preventDefault:()=>prevented++});await close({preventDefault:()=>prevented++});
  assert.equal(attempts,2);assert.equal(errors,1);assert.equal(prevented,2);assert.equal(ordinary,0);
});
test('ordinary close and explicit app quit bypass detached retention',async()=>{
  let active=false,quitting=false,ordinary=0,backgrounds=0;
  const close=createWorkbenchLauncherCloseHandler({shouldRetain:()=>active&&!quitting,background:async()=>backgrounds++,ordinary:()=>ordinary++});
  const event={preventDefault:()=>assert.fail('Normal close must be allowed')};
  close(event);active=true;quitting=true;close(event);
  assert.equal(ordinary,2);assert.equal(backgrounds,0);
});
test('a retained launcher enters lifecycle background, so closing its window does not request app quit',async()=>{
  let hidden=0,quit=0;
  const lifecycle=new DesktopLifecycle({getWindow:()=>({isDestroyed:()=>false,hide:()=>hidden++}),quit:()=>quit++});
  const close=createWorkbenchLauncherCloseHandler({shouldRetain:()=>true,background:()=>lifecycle.background(),ordinary:()=>assert.fail('Detached session must retain runtime')});
  await close({preventDefault:()=>{}});lifecycle.windowClosed();
  assert.equal(lifecycle.mode,'background');assert.equal(hidden,1);assert.equal(quit,0);
});

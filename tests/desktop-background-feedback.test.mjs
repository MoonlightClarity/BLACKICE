import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopToolHandler} from '../lib/desktop-tools.mjs';

test('observed foreground change during a mutation reports unverified background execution and possible completed effects', async () => {
  const calls=[],events=[];
  const desktop={status:()=>({enabled:true}),perform:async args=>{
    calls.push(args);
    return {ok:true,mode:'background_uia',physicalInput:false,observedInput:{foregroundChanged:true,cursorMoved:true},mechanism:'fixture-provider',ref:args.ref};
  }};
  const handler=createDesktopToolHandler({desktop,onEvent:event=>events.push(event)});
  for(const action of ['invoke','set_value','select']){
    const result=await handler({name:'relay_desktop',arguments:{action,ref:'uia_fixture'}});
    const value=JSON.parse(result.contentItems[0].text);
    assert.equal(result.success,false);assert.equal(result.code,'DESKTOP_BACKGROUND_UNVERIFIED');
    assert.equal(value.actionDispatched,true);assert.equal(value.backgroundVerified,false);
    assert.deepEqual(value.observedInput,{foregroundChanged:true,cursorMoved:true});
    assert.match(value.error,/may already have completed/);assert.match(value.error,/concurrent user/);assert.match(value.error,/Do not repeat/);
  }
  assert.deepEqual(calls.map(call=>call.action),['invoke','set_value','select'],'No replay, focus restoration, or GUI fallback is attempted.');
  assert.equal(events.filter(event=>event.status==='failed').length,3);
  assert.equal(events.some(event=>event.status==='completed'),false,'Interference must not emit successful background completion.');
});

test('passive concurrent activity and verified unchanged mutations keep their actual successful results', async () => {
  const desktop={status:()=>({enabled:true}),perform:async args=>({observedInput:{foregroundChanged:args.action==='inspect',cursorMoved:true},text:'observed'})};
  const handler=createDesktopToolHandler({desktop});
  assert.equal((await handler({name:'relay_desktop',arguments:{action:'inspect',windowId:'42'}})).success,true);
  assert.equal((await handler({name:'relay_desktop',arguments:{action:'set_value',ref:'uia_fixture',value:'data'}})).success,true);
});

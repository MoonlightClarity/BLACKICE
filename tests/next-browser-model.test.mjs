import test from 'node:test';
import assert from 'node:assert/strict';
import {browserFrame,pagePoint,browserInputGuard,wheelPixels,pendingDialog} from '../public/next/workspaces/browser-model.mjs';

const screenshot=()=>({
  tabId:'tab-1',url:'https://fixture.example/path',documentId:'tab-1:42',
  width:1280,height:900,imageUrl:'data:image/png;base64,aGVsbG8=',
});
test('only an actual observed contained-browser document can receive input',()=>{
  const accepted=browserFrame(screenshot(),'tab-1');
  assert.equal(accepted.documentId,'tab-1:42');
  assert.deepEqual(browserInputGuard(accepted,'tab-1'),{
    tabId:'tab-1',expectedUrl:'https://fixture.example/path',expectedDocumentId:'tab-1:42',
  });
  assert.throws(()=>browserInputGuard(accepted,'other-tab'),/Refresh the exact/);
  assert.throws(()=>browserInputGuard(null,'tab-1'),/Refresh the exact/);
  assert.equal(browserFrame({...screenshot(),imageUrl:'javascript:alert(1)'},'tab-1'),null);
  assert.equal(browserFrame({...screenshot(),documentId:''},'tab-1'),null);
  assert.equal(browserFrame(screenshot(),'different'),null);
});

test('actual pointer location scales with the contained screenshot rather than screen geometry',()=>{
  const frame=browserFrame(screenshot(),'tab-1');
  const bounds={left:100,top:75,width:640,height:450};
  assert.deepEqual(pagePoint(frame,{clientX:420,clientY:300},bounds),{x:640,y:450});
  assert.deepEqual(pagePoint(frame,{clientX:101,clientY:76},bounds),{x:2,y:2});
  assert.equal(pagePoint(frame,{clientX:740,clientY:300},bounds),null);
  assert.equal(pagePoint(frame,{clientX:0,clientY:75},bounds),null);
});

test('wheel motion is bounded and does not treat ctrl-zoom as a page scroll',()=>{
  const frame=browserFrame(screenshot(),'tab-1');
  assert.deepEqual(wheelPixels({deltaX:0,deltaY:12,deltaMode:1},frame),{deltaX:0,deltaY:192});
  assert.deepEqual(wheelPixels({deltaX:1,deltaY:0,deltaMode:2},frame),{deltaX:1280,deltaY:0});
  assert.equal(wheelPixels({deltaX:0,deltaY:100000,deltaMode:0},frame),null);
  assert.equal(wheelPixels({deltaX:0,deltaY:0,deltaMode:0},frame),null);
});
test('hostile dialog messages remain bounded, untrusted text, and tied to the exact tab',()=>{
  const dialog=pendingDialog({kind:'javascript_dialog',tabId:'tab-1',id:'browser_input_test',
    status:'pending',url:'https://fixture.example/path',documentId:'tab-1:42',
    dialogType:'prompt',message:'<script>bad()</script>'.repeat(500),defaultPrompt:'default'},'tab-1');
  assert.equal(dialog.message.length,4096);
  assert.match(dialog.message,/<script>/);
  assert.equal(dialog.defaultPrompt,'default');
  assert.equal(pendingDialog({...dialog,tabId:'other'},'tab-1'),null);
  assert.equal(pendingDialog({...dialog,status:'unexpected'},'tab-1'),null);
});

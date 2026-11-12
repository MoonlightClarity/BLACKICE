import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';

test('synthetic native dialog opens, closes once, preserves return value and can reopen',async t=>{
  const {document}=planningDOM(t),dialog=document.createElement('dialog');
  document.body.append(dialog);
  let closed=0;dialog.addEventListener('close',()=>{closed++;});
  assert.equal(dialog.open,false);
  dialog.close();assert.equal(closed,0,'Closing an already-closed native dialog is a no-op.');
  dialog.showModal();assert.equal(dialog.open,true);assert.equal(dialog.hasAttribute('open'),true);
  dialog.close('done');assert.equal(dialog.open,false);assert.equal(dialog.hasAttribute('open'),false);
  assert.equal(dialog.returnValue,'done');assert.equal(closed,1);
  dialog.close('ignored');assert.equal(closed,1);assert.equal(dialog.returnValue,'done');
  dialog.showModal();dialog.close();assert.equal(closed,2);assert.equal(dialog.returnValue,'done');
  dialog.remove();assert.equal(dialog.isConnected,false);
});

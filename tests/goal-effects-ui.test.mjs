import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createGoalEffects} from '../public/next/chat/goal-effects.mjs';

test('operator chooses exact observed receipt and records an outcome without replay',async t=>{
  const dom=planningDOM(t),calls=[];
  const row={id:'id-1',signature:'a'.repeat(64),at:'2026-11-14T00:00:00Z',tool:'relay_browser',action:'click',target:'<target>',runId:'run-1'};
  const ui=createGoalEffects({mount:dom.mount,api:async(route,method,body)=>{calls.push({route,method,body});return method==='GET'?{receipts:[row]}:{receipt:{...row,resolution:body}};}});
  t.after(()=>ui.destroy());ui.update('conversation-1');
  const buttons=dom.mount.querySelectorAll('button'),selects=dom.mount.querySelectorAll('select'),evidence=dom.mount.querySelector('textarea');
  assert.equal(buttons[1].disabled,true);await buttons[0].dispatch('click',{},true);
  selects[0].value='0';await selects[0].dispatch('change',{},true);assert.match(dom.mount.textContent,/<target>/);
  assert.equal(buttons[1].disabled,true);selects[1].value='not_occurred';evidence.value='Checked destination receipt';await evidence.dispatch('input',{},true);
  assert.equal(buttons[1].disabled,false);await buttons[1].dispatch('click',{},true);
  assert.deepEqual(calls[1].body,{receiptId:'id-1',signature:row.signature,observedAt:row.at,expectedResolutionCount:0,outcome:'not_occurred',evidence:'Checked destination receipt'});
  assert.equal(calls.length,2);assert.match(dom.mount.textContent,/No action was repeated/);assert.equal(buttons[1].disabled,true);
});

test('late receipts and read-only view cannot authorize a resolution',async t=>{
  const dom=planningDOM(t);let release;const pending=new Promise(resolve=>release=resolve);let posts=0;
  const ui=createGoalEffects({mount:dom.mount,api:async(_route,method)=>{if(method==='POST'){posts++;return {};}return pending;}});t.after(()=>ui.destroy());
  const row={id:'old',signature:'a'.repeat(64),at:'time',tool:'relay_browser',action:'click'};
  ui.update('old');const buttons=dom.mount.querySelectorAll('button');const read=buttons[0].dispatch('click',{},true);
  ui.update('new',{readonly:true});release({receipts:[row]});await read;
  assert.equal(buttons[1].disabled,true);assert.doesNotMatch(dom.mount.textContent,/old.*relay_browser/);
  await buttons[1].dispatch('click',{},true);assert.equal(posts,0);
});

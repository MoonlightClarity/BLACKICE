import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createSubscriptionModelSettings} from '../public/next/workspaces/settings-subscriptions.mjs';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('Codex controls are grouped with account rather than duplicated in API connections',async t=>{
 const dom=planningDOM(t);let clicks=0;
 const panel=createSubscriptionModelSettings({mount:dom.mount,api:async()=>({codex:{connected:true,authenticated:true}})},({mount})=>{
  const controls=dom.element('details');controls.id='next-provider-codex';
  const action=dom.element('button');action.id='fixture-codex-control';action.addEventListener('click',()=>clicks++);
  controls.append(action);mount.append(controls);return{enter(){},leave(){},destroy(){}};
 });
 t.after(()=>panel.destroy());panel.enter();await settle();
 assert.equal(dom.mount.querySelector('#next-mistral-vibe'),null);
 assert.equal(dom.mount.querySelectorAll('#next-provider-codex').length,1);
 assert.equal(dom.$('#next-connect-another-endpoint').contains(dom.$('#next-provider-codex')),false);
 assert.match(dom.$('#next-provider-codex').parentElement.textContent,/Codex models & account/);
 await dom.click('#fixture-codex-control');assert.equal(clicks,1);
 panel.leave();panel.enter();await settle();assert.equal(dom.mount.querySelectorAll('#next-provider-codex').length,1);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {browserIconButton,browserUsageMarkup,createBrowserUsageControls} from '../public/next/workspaces/browser-usage-ui.mjs';
test('browser SVG icons retain accessible control labels and never interpolate page text into markup',t=>{
 const f=planningDOM(t),button=f.element('button');f.mount.append(button);
 browserIconButton(button,'move','Move <img src=x onerror=evil()> to folder');
 assert.equal(button.getAttribute('aria-label'),'Move <img src=x onerror=evil()> to folder');assert.equal(button.title,button.getAttribute('aria-label'));
 assert.ok(button.querySelector('svg'));assert.equal(button.querySelector('svg').getAttribute('aria-hidden'),'true');assert.equal(button.querySelector('img'),null);
 const svg=button.querySelector('svg');browserIconButton(button,'move','Move updated title');assert.equal(button.querySelector('svg'),svg,'Status refresh preserves existing SVG node');assert.throws(()=>browserIconButton(button,'unknown','label'),/Unknown browser icon/);
});
test('in-use icon expresses exact pressed state and release label without losing click behavior',async t=>{
 const f=planningDOM(t);f.mount.innerHTML=browserUsageMarkup();let tab={tabId:'one',inUse:false};const calls=[];
 const ui=createBrowserUsageControls({mount:f.mount,getTab:()=>tab,api:async(...args)=>{calls.push(args);return{tabs:[{tabId:'one',inUse:true}]};},onMoveStatus:result=>{tab=result.tabs[0];}});
 ui.render();const button=f.$('#next-browser-in-use');assert.equal(button.dataset.browserIcon,'pin');assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(button.getAttribute('aria-label'),'Mark in use');
 await f.click('#next-browser-in-use');assert.equal(calls.length,1);assert.equal(calls[0][2].inUse,true);assert.equal(button.dataset.browserIcon,'unpin');assert.equal(button.getAttribute('aria-pressed'),'true');assert.equal(button.getAttribute('aria-label'),'Release in-use mark');assert.match(button.title,/can then be cleaned up/);ui.destroy();
});

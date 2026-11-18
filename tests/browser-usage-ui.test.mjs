import test from 'node:test';import assert from 'node:assert/strict';import{planningDOM}from'./fixture-planning-dom.mjs';import{browserUsageMarkup,createBrowserUsageControls}from'../public/next/workspaces/browser-usage-ui.mjs';
test('all tabs remain visible regardless of conversation; selected tab mark is explicit',async t=>{
 const f=planningDOM(t);f.mount.innerHTML=browserUsageMarkup();const tabs=[{tabId:'a',owner:null},{tabId:'b',owner:{taskId:'other'},conversationId:'other'}],calls=[];let selected=tabs[1];
 const c=createBrowserUsageControls({mount:f.mount,getTab:()=>selected,api:async(_p,_m,args)=>{calls.push(args);return {tabs:tabs.map(x=>x.tabId===args.tabId?{...x,inUse:args.inUse}:x)};},onMoveStatus:d=>{selected=d.tabs[1];}});
 assert.deepEqual(c.visible(tabs),tabs);c.render();await f.click('#next-browser-in-use');
 assert.deepEqual(calls,[{browser:'relay',action:'tab_mark',tabId:'b',inUse:true}]);assert.equal(f.$('#next-browser-in-use').getAttribute('aria-label'),'Release in-use mark');
 await f.click('#next-browser-in-use');assert.equal(calls[1].inUse,false);assert.equal(f.$('#next-browser-in-use').getAttribute('aria-pressed'),'false');
});

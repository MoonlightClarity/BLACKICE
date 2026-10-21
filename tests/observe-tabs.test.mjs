import test from 'node:test';
import assert from 'node:assert/strict';
import { initObserveBrowser } from '../public/observe-ui.mjs';
import { observeBrowserNeighbor } from '../public/observe-model.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const page = (tabId, values = {}) => ({ tabId, browser: 'relay', visible: false, title: 'Page ' + tabId, url: 'https://' + tabId + '.example.test/', ...values });
const controls = tabId => ({ tabId, frames: [{ text: 'Observed text for ' + tabId, elements: [{ ref: 'field-' + tabId, role: 'textbox', type: 'text', name: 'Message for ' + tabId }] }] });
async function fixture(t, { tabs = [page('one'), page('two'), page('three')], folders, capacity, persistence, protection = false, hook, width = 1440, enterOptions } = {}) {
  let ui; t.after(() => ui?.destroy()); const f = planningDOM(t, { width }), calls = [];
  let clock = 0, currentHook = hook, global = { available: true, enabled: true, ready: true, engine: 'Ghostery', filterCount: 1000, updatedAt: '2026-10-19T12:00:00Z', exemptOrigins: [], tabs: [] };
  const data = { status: { available: true, acceptingActions: true, browsers: { relay: { available: true } }, activeTab: tabs[0]?.tabId || null, tabs: structuredClone(tabs), ...(folders?{folders:structuredClone(folders)}:{}),...(capacity?{capacity:structuredClone(capacity)}:{}),...(persistence?{persistence:structuredClone(persistence)}:{}) } };
  const withProtection = () => { if (!protection) return; global.tabs = data.status.tabs.map(tab => { let origin; try { origin = new URL(tab.url).origin; } catch {} if (origin === 'null') origin = null; const siteExempt = global.exemptOrigins.includes(origin); return { tabId: tab.tabId, available: true, origin, enabled: global.enabled && global.ready && !siteExempt, siteExempt, blockedRequests: 4 }; }); data.status.protection = structuredClone(global); for (const tab of data.status.tabs) tab.protection = global.tabs.find(item => item.tabId === tab.tabId); };
  withProtection();
  const api = async (route, options = {}) => {
    const call = { route, ...options }; calls.push(call); const override = await currentHook?.(call, data); if (override !== undefined) return override;
    if (route === '/api/browser/status') { withProtection(); return structuredClone(data.status); }
    if (route === '/api/browser/protection') {
      assert.equal(options.method, 'POST'); const body = options.body;
      if (body.action === 'site') {
        const tab = data.status.tabs.find(item => item.tabId === body.tabId); assert.ok(tab); if (new URL(tab.url).origin !== body.origin) throw Object.assign(Error('The page changed. Refresh before changing protection for this site.'), { status: 409 });
        global.exemptOrigins = global.exemptOrigins.filter(origin => origin !== body.origin); if (!body.enabled) global.exemptOrigins.push(body.origin);
      } else if (body.action === 'global') global.enabled = body.enabled;
      else if (body.action === 'refresh') global.filterCount++;
      else assert.fail('Unexpected protection mutation'); withProtection(); return structuredClone(global);
    }
    assert.equal(route, '/api/browser/action'); assert.equal(options.method, 'POST'); const body = options.body; assert.equal(body.browser, 'relay');
    if (body.action === 'screenshot') {const tab=data.status.tabs.find(tab=>tab.tabId===body.tabId);if(tab)tab.suspended=false;return { tabId: body.tabId, width: 1280, height: 900, imageUrl: image, url: tab?.url };}
    if (body.action === 'open') { const tab = page('created-' + calls.length, { url: body.url }); data.status.tabs.push(tab); data.status.activeTab = tab.tabId; return controls(tab.tabId); }
    if (body.action === 'close') { data.status.tabs = data.status.tabs.filter(tab => tab.tabId !== body.tabId); data.status.activeTab = data.status.tabs[0]?.tabId || null; return { closed: true, tabId: body.tabId }; }
    if (body.action === 'suspend') {const tab=data.status.tabs.find(tab=>tab.tabId===body.tabId);assert.ok(tab);tab.suspended=true;return{...structuredClone(data.status),receipt:{tabId:body.tabId,suspended:true}};}
    if (body.action === 'navigate') data.status.tabs.find(tab => tab.tabId === body.tabId).url = body.url;
    return controls(body.tabId);
  };
  ui = initObserveBrowser({ mount: f.mount, api, now: () => clock }); await ui.enter(enterOptions);
  const button = (action, id) => [...f.mount.querySelectorAll('[data-observe-browser]')].find(node => node.dataset.observeBrowser === action && (!id || node.dataset.tabId === id));
  return { ...f, ui, calls, data, button, get selected() { return f.$('[role="tab"][aria-selected="true"]')?.dataset.tabId || null; }, async click(action, id) { const node = button(action, id); assert.ok(node, `Missing ${action} ${id || ''}`); return f.click(node); }, async key(key) { return f.key(button('tab', this.selected), key); }, async poll() { clock += 5001; ui.update(); await tick(); await tick(); }, hook(next) { currentHook = next; }, global: () => global };
}

test('the visible tab strip contains actual hidden pages, readable titles and one reachable selected tab', async t => {
  const f = await fixture(t, { tabs: [page('one', { title: 'A <script>title</script>', loading: true }), page('two'), page('visible', { visible: true }), page('outside', { browser: 'neo' })] });
  const tabs = f.mount.querySelectorAll('[role="tab"]'); assert.deepEqual(tabs.map(tab => tab.dataset.tabId), ['one', 'two']); assert.equal(f.$('#observe-browser-tabs').getAttribute('role'), 'tablist'); assert.equal(f.selected, 'one'); assert.deepEqual(tabs.map(tab => tab.getAttribute('tabindex')), ['0', '-1']); assert.match(tabs[0].getAttribute('aria-label'), /Loading/); assert.match(tabs[0].textContent, /<script>title/); assert.equal(f.mount.querySelectorAll('script').length, 0); assert.equal(f.$('#observe-browser-tab'), null); assert.equal(f.$('#observe-browser-page').getAttribute('aria-labelledby'), tabs[0].id);
});

test('choosing a tab pins its preview until Follow active page is explicitly enabled', async t => {
  const f = await fixture(t); await f.click('tab', 'two'); assert.equal(f.selected, 'two'); assert.equal(f.$('#observe-browser-follow').getAttribute('aria-pressed'), 'false'); f.data.status.activeTab = 'three'; await f.poll(); assert.equal(f.selected, 'two'); assert.equal(f.calls.at(-1).body.tabId, 'two');
  await f.click('follow'); assert.equal(f.selected, 'three'); assert.equal(f.$('#observe-browser-follow').getAttribute('aria-pressed'), 'true'); f.data.status.activeTab = 'one'; await f.poll(); assert.equal(f.selected, 'one'); assert.equal(f.calls.some(call => call.body?.action === 'activate'), false);
});

test('keyboard arrows, Home and End select tabs and Delete closes to a surviving neighbour', async t => {
  const f = await fixture(t); await f.key('ArrowRight'); assert.equal(f.selected, 'two'); assert.equal(document.activeElement.dataset.tabId, 'two'); await f.key('End'); assert.equal(f.selected, 'three'); await f.key('ArrowRight'); assert.equal(f.selected, 'one'); await f.key('Home'); assert.equal(f.selected, 'one'); await f.key('ArrowLeft'); assert.equal(f.selected, 'three');
  await f.key('Delete'); assert.equal(f.selected, 'two'); assert.equal(document.activeElement.dataset.tabId, 'two'); assert.deepEqual(f.calls.filter(call => call.body?.action === 'close').map(call => call.body.tabId), ['three']);
  await f.click('tab', 'one'); await f.key('Delete'); assert.equal(f.selected, 'two'); assert.equal(document.activeElement.dataset.tabId, 'two');
});

test('closing the current middle tab chooses its right neighbour even when the backend active page is elsewhere', async t => {
  const f = await fixture(t); await f.click('tab', 'two'); await f.click('close', 'two'); assert.equal(f.selected, 'three'); assert.equal(f.data.status.activeTab, 'one'); await f.poll(); assert.equal(f.selected, 'three');
  assert.equal(observeBrowserNeighbor([page('one'), page('two'), page('three')], [page('one')], 'two'), 'one');
});

test('closing another tab preserves the selected page, address draft and field draft', async t => {
  const f = await fixture(t); await f.click('tab', 'two'); await f.click('inspect'); await f.input('#observe-browser-url', 'https://draft.example.test/unfinished'); await f.input('#observe-browser-text', 'Keep my unsent field'); await f.click('close', 'one');
  assert.equal(f.selected, 'two'); assert.equal(f.$('#observe-browser-url').value, 'https://draft.example.test/unfinished'); assert.equal(f.$('#observe-browser-text').value, 'Keep my unsent field'); assert.equal(f.calls.filter(call => call.body?.action === 'close').at(-1).body.tabId, 'one'); assert.equal(f.calls.at(-1).body.tabId, 'two');
});

test('per-tab drafts survive selection and readonly polling preserves the actual address node, focus and reading positions', async t => {
  const f = await fixture(t, { width: 390 }); await f.click('tab', 'one'); await f.click('inspect'); await f.input('#observe-browser-url', 'https://one.draft.test/'); await f.input('#observe-browser-text', 'First page draft'); f.$('.observe-browser-page-text').scrollTop = 48;
  await f.click('tab', 'two'); await f.input('#observe-browser-url', 'https://two.draft.test/'); await f.click('tab', 'one'); assert.equal(f.$('#observe-browser-url').value, 'https://one.draft.test/'); assert.equal(f.$('#observe-browser-text').value, 'First page draft'); assert.equal(f.button('fill').disabled, true, 'switching back requires current observed controls before a retained field can be submitted');
  await f.click('inspect'); assert.equal(f.$('#observe-browser-text').value, 'First page draft'); const address = f.$('#observe-browser-url'); address.focus(); address.setSelectionRange(8, 12, 'backward'); f.$('#observe-browser-tabs').scrollLeft = 120; f.$('.observe-browser-page-text').scrollTop = 70; f.mount.scrollTop = 200; await f.poll();
  assert.equal(f.$('#observe-browser-url'), address); assert.equal(document.activeElement, address); assert.deepEqual([address.selectionStart, address.selectionEnd, address.selectionDirection], [8, 12, 'backward']); assert.equal(f.$('#observe-browser-tabs').scrollLeft, 120); assert.equal(f.$('.observe-browser-page-text').scrollTop, 70); assert.equal(f.mount.scrollTop, 200); await f.click('tab', 'two'); assert.equal(f.$('#observe-browser-url').value, 'https://two.draft.test/');
});

test('a late cancelled read cannot overwrite the newly selected page or capture the old tab', async t => {
  const f = await fixture(t), gate = deferred(); let hold = true; f.hook(call => hold && call.route === '/api/browser/status' ? gate.promise : undefined); const pending = f.click('refresh'); await tick(); const old = f.calls.at(-1); hold = false; await f.click('tab', 'two'); const count = f.calls.length; assert.equal(old.signal.aborted, true); gate.resolve({ ...f.data.status, activeTab: 'three' }); await pending;
  assert.equal(f.selected, 'two'); assert.equal(f.calls.length, count); assert.equal(f.calls.at(-1).body.tabId, 'two'); assert.equal(f.$('#observe-browser-url').value, 'https://two.example.test/');
});

test('a page disappearing before input is never replaced by a mutation against the fallback tab', async t => {
  const f = await fixture(t); await f.click('tab', 'two'); f.data.status.tabs = f.data.status.tabs.filter(tab => tab.tabId !== 'two'); await f.button('point').dispatch('click', {clientX:80,clientY:25}, true); assert.equal(f.selected, 'three'); assert.equal(f.calls.filter(call => call.body?.action === 'click').length, 0);
});

test('New tab opens the authored address once and keeps existing tabs intact', async t => {
  const f = await fixture(t); await f.input('#observe-browser-url', 'https://new.example.test/report'); await f.click('new'); assert.equal(f.data.status.tabs.length, 4); assert.ok(f.selected.startsWith('created-')); assert.equal(f.$('#observe-browser-url').value, 'https://new.example.test/report'); assert.deepEqual(f.calls.filter(call => call.body?.action === 'open').map(call => call.body), [{ action: 'open', browser: 'relay', url: 'https://new.example.test/report' }]); assert.equal(f.$('#observe-browser-follow').getAttribute('aria-pressed'), 'false');
});

test('site protection uses the exact observed origin and leaves other tabs and their drafts unchanged', async t => {
  const f = await fixture(t, { protection: true }); await f.click('tab', 'two'); await f.input('#observe-browser-url', 'https://draft.test/'); await f.click('protection-site'); const call = f.calls.find(call => call.route === '/api/browser/protection'); assert.deepEqual(call.body, { action: 'site', tabId: 'two', origin: 'https://two.example.test', enabled: false }); assert.equal(f.selected, 'two'); assert.equal(f.$('#observe-browser-url').value, 'https://draft.test/'); assert.match(f.$('#observe-browser-protection-status').textContent, /Off for this site/); assert.equal(f.button('protection-site').textContent, 'Block on this site'); assert.equal(f.data.status.tabs.find(tab => tab.tabId === 'one').protection.enabled, true);
  await f.click('protection-site'); assert.equal(f.calls.filter(call => call.route === '/api/browser/protection').at(-1).body.enabled, true); assert.match(f.$('#observe-browser-protection-status').textContent, /Blocking/);
});

test('global protection and filter refresh are explicit requests with truthful disabled site controls', async t => {
  const f = await fixture(t, { protection: true }); await f.click('protection-global'); assert.equal(f.global().enabled, false); assert.equal(f.button('protection-site').disabled, true); assert.match(f.$('#observe-browser-protection-status').textContent, /Off/); await f.click('protection-global'); await f.click('protection-refresh'); assert.deepEqual(f.calls.filter(call => call.route === '/api/browser/protection').map(call => call.body), [{ action: 'global', enabled: false }, { action: 'global', enabled: true }, { action: 'refresh' }]); assert.equal(f.global().filterCount, 1001);
});

test('a stale-origin rejection keeps the draft and original protection status without replaying the change', async t => {
  const f = await fixture(t, { protection: true }); await f.input('#observe-browser-url', 'https://draft.test/'); f.data.status.tabs[0].url = 'https://changed.example.test/'; await f.click('protection-site'); assert.match(f.$('.observe-browser-protection-message').textContent, /page changed/); assert.equal(f.global().exemptOrigins.length, 0); assert.equal(f.$('#observe-browser-url').value, 'https://draft.test/'); await f.poll(); assert.equal(f.calls.filter(call => call.route === '/api/browser/protection').length, 1); assert.match(f.$('#observe-browser-protection-status').textContent, /Blocking/);
});

test('a delayed site receipt cannot steal another selected tab or its address draft and control focus', async t => {
  const f = await fixture(t, { protection: true }), gate = deferred(); f.hook(call => call.route === '/api/browser/protection' ? gate.promise : undefined); f.button('protection-site').focus(); const pending = f.click('protection-site'); await tick(); await f.click('tab', 'two'); await f.input('#observe-browser-url', 'https://newer-draft.test/'); const address = f.$('#observe-browser-url'); address.focus(); address.setSelectionRange(1, 6);
  gate.resolve({ ...f.global(), tabs: f.global().tabs.map(tab => tab.tabId === 'one' ? { ...tab, enabled: false, siteExempt: true } : tab) }); await pending; assert.equal(f.selected, 'two'); assert.equal(f.$('#observe-browser-url'), address); assert.equal(address.value, 'https://newer-draft.test/'); assert.equal(document.activeElement, address); assert.deepEqual([address.selectionStart, address.selectionEnd], [1, 6]); assert.match(f.$('#observe-browser-protection-status').textContent, /Blocking/);
});

test('site exceptions stay disabled for non-web pages and unavailable blocker metadata', async t => {
  const f = await fixture(t, { protection: true, tabs: [page('one', { url: 'about:blank' })] }); assert.equal(f.button('protection-site').disabled, true); await f.click('protection-site'); assert.equal(f.calls.filter(call => call.route === '/api/browser/protection').length, 0);
});

test('an exact setup-tab handoff observes only that owned tab and does not follow another active page', async t => {
  const f = await fixture(t, { enterOptions: { tabId: 'two' } });
  assert.equal(f.selected, 'two'); assert.equal(f.$('#observe-browser-follow').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(f.calls.filter(call => call.body?.action === 'screenshot').map(call => call.body.tabId), ['two']);
  f.data.status.activeTab = 'three'; await f.poll(); assert.equal(f.selected, 'two'); assert.equal(f.calls.at(-1).body.tabId, 'two');
});

test('a missing requested setup tab shows an error without reading or capturing a fallback tab', async t => {
  const f = await fixture(t, { enterOptions: { tabId: 'closed-chat-mode' } });
  assert.match(f.mount.textContent, /requested contained tab is no longer available/); assert.equal(f.calls.filter(call => call.route === '/api/browser/action').length, 0);
  await f.poll(); assert.equal(f.calls.filter(call => call.route === '/api/browser/action').length, 0);
});

test('leaving during an exact-tab status read prevents late capture and selection changes', async t => {
  const f = await fixture(t), gate = deferred(); f.ui.leave(); f.hook(call => call.route === '/api/browser/status' ? gate.promise : undefined);
  const pending = f.ui.enter({ tabId: 'two' }); await tick(); const call = f.calls.at(-1), count = f.calls.length; f.ui.leave(); assert.equal(call.signal.aborted, true);
  gate.resolve(f.data.status); await pending; assert.equal(f.calls.length, count); assert.equal(f.mount.innerHTML, '');
});

test('task folders and page branches survive preview polling with selection, scroll and drafts intact',async t=>{
 const folders=[{id:'personal',name:'Personal',kind:'user'},{id:'research',name:'Release research',kind:'task',taskId:'task-a'}];
 const tabs=[page('one',{folderId:'personal',parentTabId:null}),page('two',{folderId:'research',parentTabId:null}),page('three',{folderId:'research',parentTabId:'two',suspended:true})];
 const f=await fixture(t,{folders,tabs,capacity:{live:2,maxLive:32,saved:3,maxSaved:256}});
 assert.match(f.$('#observe-browser-tree').textContent,/Folders & pages/);
 assert.equal(f.$('[data-observe-folder="personal"]').open,true);
 f.$('[data-observe-folder="personal"]').open=false;f.$('[data-observe-folder="research"]').open=true;
 const pageButton=f.button('tree-tab','three');pageButton.focus();await f.click('tree-tab','three');
 assert.equal(f.selected,'three');assert.equal(f.button('tree-tab','three').getAttribute('aria-current'),'page');
 assert.equal(document.activeElement.dataset.observeBrowser,'tree-tab');assert.equal(document.activeElement.dataset.tabId,'three');
 await f.input('#observe-browser-url','https://unsent-draft.test/');
 const address=f.$('#observe-browser-url');address.focus();address.setSelectionRange(3,8);
 f.$('.observe-browser-tree-content').scrollTop=125;await f.poll();
 assert.equal(f.$('[data-observe-folder="personal"]').open,false);assert.equal(f.$('[data-observe-folder="research"]').open,true);
 assert.equal(f.$('.observe-browser-tree-content').scrollTop,125);assert.equal(f.$('#observe-browser-url'),address);assert.equal(address.value,'https://unsent-draft.test/');assert.equal(document.activeElement,address);
 assert.deepEqual([address.selectionStart,address.selectionEnd],[3,8]);
 assert.equal(f.calls.filter(call=>call.body?.action==='screenshot').at(-1).body.tabId,'three');
 await f.click('tree-close','two');assert.deepEqual(f.data.status.tabs.map(tab=>tab.tabId),['one','three']);assert.equal(f.selected,'three');
 assert.equal(f.calls.filter(call=>call.body?.action==='close').at(-1).body.tabId,'two');
});

test('suspending the selected page pauses preview, retains its folder and restores it only on explicit read',async t=>{
 const folders=[{id:'personal',name:'Personal',kind:'user'}],tabs=[page('one',{folderId:'personal'}),page('two',{folderId:'personal'})];
 const f=await fixture(t,{folders,tabs});await f.input('#observe-browser-url','https://draft.test/');const captures=f.calls.filter(call=>call.body?.action==='screenshot').length;
 f.button('tree-suspend','one').focus();await f.click('tree-suspend','one');
 assert.deepEqual(f.calls.filter(call=>call.body?.action==='suspend').map(call=>call.body),[{action:'suspend',browser:'relay',tabId:'one'}]);
 assert.deepEqual(f.data.status.tabs.map(tab=>tab.tabId),['one','two']);assert.equal(f.data.status.tabs[0].suspended,true);assert.equal(f.selected,'one');
 assert.equal(f.$('#observe-browser-url').value,'https://draft.test/');assert.match(f.$('#observe-browser-status').textContent,/Page suspended.*Preview paused/);assert.match(f.$('.observe-browser-placeholder').textContent,/Page is suspended/);
 assert.equal(f.button('watch').textContent,'Resume preview');assert.equal(document.activeElement.dataset.observeBrowser,'tree-tab');assert.equal(document.activeElement.dataset.tabId,'one');
 await f.poll();assert.equal(f.calls.filter(call=>call.body?.action==='screenshot').length,captures,'polling must not immediately wake the suspended page');
 await f.click('refresh');assert.equal(f.data.status.tabs[0].suspended,false);assert.ok(f.button('tree-suspend','one'));assert.equal(f.calls.filter(call=>call.body?.action==='screenshot').length,captures+1);
});

test('suspending another page preserves selected drafts and a pending interaction returns its real retained receipt',async t=>{
 const folders=[{id:'personal',name:'Personal',kind:'user'}],tabs=[page('one',{folderId:'personal'}),page('two',{folderId:'personal'})];
 const f=await fixture(t,{folders,tabs});await f.input('#observe-browser-url','https://unsent.test/');
 f.hook((call,data)=>call.body?.action==='suspend'?{...structuredClone(data.status),receipt:{tabId:call.body.tabId,suspended:false,reason:'A website interaction still requires inspection.'}}:undefined);
 await f.click('tree-suspend','two');assert.equal(f.selected,'one');assert.equal(f.$('#observe-browser-url').value,'https://unsent.test/');assert.match(f.$('#observe-browser-status').textContent,/Page stayed live\. A website interaction still requires inspection\./);
 assert.equal(f.button('watch').textContent,'Pause preview');assert.ok(f.button('tree-suspend','two'));assert.equal(f.calls.filter(call=>call.body?.action==='suspend').length,1);
 f.hook();await f.click('tree-suspend','two');assert.equal(f.data.status.tabs[1].suspended,true);assert.equal(f.selected,'one');assert.equal(f.button('watch').textContent,'Pause preview');await f.poll();assert.equal(f.data.status.tabs[1].suspended,true);assert.equal(f.calls.filter(call=>call.body?.action==='screenshot').at(-1).body.tabId,'one');
});

test('an uncertain suspension refreshes persistence health without waking the possibly suspended page',async t=>{
 const folders=[{id:'personal',name:'Personal',kind:'user'}],tabs=[page('one',{folderId:'personal'})];
 const f=await fixture(t,{folders,tabs,persistence:{healthy:true}}),captures=f.calls.filter(call=>call.body?.action==='screenshot').length;
 f.hook((call,data)=>{if(call.body?.action==='suspend'){data.status.tabs[0].suspended=true;data.status.persistence={healthy:false,error:'Browser folders and pages could not be saved.'};throw Error('The browser changed in memory, but its folder and page state could not be saved.');}});
 await f.click('tree-suspend','one');assert.match(f.$('.observe-browser-save-error').textContent,/could not be saved.*Changes may not survive a restart/);assert.equal(f.button('watch').textContent,'Resume preview');
 assert.match(f.$('#observe-browser-status').textContent,/could not be saved/);await f.poll();assert.equal(f.calls.filter(call=>call.body?.action==='screenshot').length,captures);assert.equal(f.calls.filter(call=>call.body?.action==='suspend').length,1);
});

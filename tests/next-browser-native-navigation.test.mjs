import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNativeBrowserWorkspace } from '../public/next/workspaces/browser-native.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

async function until(read) {
  for (let attempt = 0; attempt < 200; attempt++) { if (read()) return; await sleep(5); }
  throw Error('Native browser workspace did not settle.');
}

async function fixture(t,{closeReceipt}={}) {
  const dom = planningDOM(t), win = globalThis.window, subscribers = new Set(), surfaceCalls = [];
  dom.document.defaultView = win;
  Object.assign(win, {
    innerWidth: 1000, innerHeight: 800,
    setTimeout, clearTimeout,
    requestAnimationFrame: callback => setTimeout(callback, 0),
    cancelAnimationFrame: id => clearTimeout(id),
    relayDesktop: { async browserSurface(request) {
      surfaceCalls.push(request);
      return { attached: request.action === 'attach' || request.action === 'bounds', tabId: request.tabId || 'search' };
    } },
  });
  const prototype = Object.getPrototypeOf(dom.mount), type = Object.getOwnPropertyDescriptor(prototype, 'type');
  Object.defineProperty(prototype, 'type', { get: type.get, set(value) { this.setAttribute('type', value); } });
  prototype.replaceChildren = function(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.rawText = ''; this.markup = ''; this.append(...children);
  };
  const state = { tabs: [
    { tabId: 'search', browser: 'relay', contained: true, visible: true, url: 'https://www.google.com/search?q=mistral', title: 'Search results' },
    { tabId: 'other', browser: 'relay', contained: true, visible: false, url: 'https://chat.mistral.ai/work', title: 'Vibe Work' },
  ], activeTab: 'search' };
  let reads = 0,closes=0;const notifications=[];
  const workspace = createNativeBrowserWorkspace({ mount: dom.mount, notify(message) {notifications.push(message);},
    events: { subscribe(handler) { subscribers.add(handler); return () => subscribers.delete(handler); } },
    api: async (route, method = 'GET', body) => {
      if (route.startsWith('/api/browser/status')) { reads++; return structuredClone(state); }
      if(route==='/api/browser/close-all'&&closeReceipt){
        assert.equal(method,'POST');assert.deepEqual(body,{});
        closes++;state.tabs=state.tabs.filter(tab=>closeReceipt.remainingTabIds.includes(tab.tabId));state.activeTab=state.tabs[0]?.tabId||null;
        return closeReceipt;
      }
      assert.equal(route, '/api/browser/action'); assert.equal(method, 'POST');
      const tab = state.tabs.find(value => value.tabId === body.tabId); assert.ok(tab);
      if (body.action === 'navigate') { tab.url = body.url; tab.title = 'Navigated page'; }
      return structuredClone(tab);
    },
  });
  t.after(() => workspace.destroy()); workspace.enter();
  await until(() => dom.$('#next-browser-url').value === state.tabs[0].url && surfaceCalls.some(call => call.action === 'attach'));
  return { ...dom, state, workspace,surfaceCalls,notifications,get closes(){return closes;},
    async refresh() {
      const previous = reads;
      for (const handler of subscribers) handler({ type: 'browser.status' });
      await until(() => reads > previous); await sleep(0);
    },
  };
}

test('native bulk close is a visible text control outside collapsed Tools and uses one confirmed request',async t=>{
 const receipt={closed:2,failedTabs:[],skippedInUseIds:[],remainingTabIds:[]};
 const f=await fixture(t,{closeReceipt:receipt}),button=f.$('#next-browser-close-all');
 assert.equal(f.$('#next-browser-tools').hidden,true,'Tools starts collapsed.');
 assert.equal(f.mount.querySelectorAll('#next-browser-close-all').length,1);
 assert.equal(button.textContent.trim(),'Close all unused tabs');
 assert.equal(button.getAttribute('aria-label')??button.textContent.trim(),'Close all unused tabs');
 assert.ok(button.closest('.next-browser-navigation'),'Bulk close stays in visible browser navigation.');
 assert.equal(button.closest('#next-browser-tools'),null,'Bulk close never requires opening Tools.');
 for(let ancestor=button;ancestor;ancestor=ancestor.parentElement)assert.equal(ancestor.hidden,false,'Bulk close has no hidden ancestor.');
 window.confirm=()=>false;await f.click(button);await sleep(0);assert.equal(f.closes,0);
 window.confirm=()=>true;await f.click(button);
 await until(()=>f.closes===1&&f.notifications.length>0);
 assert.equal(f.closes,1);assert.deepEqual(f.state.tabs,[]);
});

test('native bulk close warns about eligible leftovers even if no close operation failed',async t=>{
 const receipt={closed:1,failedTabs:[],skippedInUseIds:[],remainingTabIds:['other']};
 const f=await fixture(t,{closeReceipt:receipt});
 window.confirm=()=>true;
 await f.click('#next-browser-close-all');
 await until(()=>f.$('#next-browser-status').textContent.includes('Some unused tabs remain'));
 assert.equal(f.closes,1);assert.equal(f.$('#next-browser-status').dataset.error,'true');
 assert.match(f.notifications[0],/Some unused tabs remain/);
});
test('native bulk close reports marked tabs staying open without an incomplete warning',async t=>{
 const receipt={closed:1,failedTabs:[],skippedInUseIds:['other'],remainingTabIds:['other']};
 const f=await fixture(t,{closeReceipt:receipt});
 f.state.tabs[1].inUse=true;await f.refresh();
 window.confirm=()=>true;await f.click('#next-browser-close-all');
 await until(()=>f.notifications.some(message=>message.includes('Tabs marked in use stayed open')));
 assert.equal(f.closes,1);assert.equal(f.$('#next-browser-status').dataset.error,'false');
});
test('native page navigation updates the URL even when shell focus remains on the address input', async t => {
  const f = await fixture(t), address = f.$('#next-browser-url');
  address.focus();
  assert.equal(f.document.activeElement, address);
  f.state.tabs[0].url = 'https://mistral.ai/products/vibe/';
  f.state.tabs[0].title = 'Mistral Vibe';
  await f.refresh();
  assert.equal(f.document.activeElement, address, 'Native page focus need not clear the shell document activeElement.');
  assert.equal(address.value, f.state.tabs[0].url, 'The address must follow the observed page after a link or redirect.');
  f.state.tabs[0].url += '#features';
  await f.refresh();
  assert.equal(address.value, f.state.tabs[0].url, 'Same-document navigation also updates the visible address.');
});

test('native status refresh preserves an unsent address draft and leaves an unchanged selected value alone', async t => {
  const f = await fixture(t), address = f.$('#next-browser-url');
  address.focus(); address.setSelectionRange(8, 18);
  const value = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(address), 'value');
  let writes = 0;
  Object.defineProperty(address, 'value', {
    get() { return value.get.call(this); },
    set(next) { writes++; value.set.call(this, next); this.setSelectionRange(0, 0); },
  });
  await f.refresh();
  assert.equal(writes, 0, 'An unchanged URL must not reset selection or caret.');
  assert.deepEqual([address.selectionStart, address.selectionEnd], [8, 18]);
  await f.input('#next-browser-url', 'An address still being typed');
  address.setSelectionRange(3, 11);
  const draftWrites = writes;
  f.state.tabs[0].url = 'https://mistral.ai/products/vibe/';
  await f.refresh();
  assert.equal(address.value, 'An address still being typed');
  assert.equal(writes, draftWrites, 'Refreshing a draft must not replace its unchanged input value.');
  assert.deepEqual([address.selectionStart, address.selectionEnd], [3, 11]);
  await f.$('#next-browser-form').dispatch('submit');
  await until(() => !f.$('#next-browser-go').disabled);
  assert.equal(address.value, 'An address still being typed', 'An invalid submission retains the draft.');
});

test('Move tab modal hides native page until dismissal and restores selected page without navigation',async t=>{
 const f=await fixture(t),before=f.surfaceCalls.length;await f.click('.next-browser-tab-move');
 assert.equal(f.$('.next-browser-move-dialog').open,true);assert.ok(f.surfaceCalls.slice(before).some(call=>call.action==='hide'));
 const hiddenAt=f.surfaceCalls.length;await f.refresh();await sleep(20);
 assert.equal(f.surfaceCalls.slice(hiddenAt).some(call=>call.action==='attach'),false);
 await f.$('.next-browser-folder-editor').dispatch('keydown',{key:'Escape'});
 await until(()=>f.surfaceCalls.slice(hiddenAt).some(call=>call.action==='attach'&&call.tabId==='search'));
 assert.equal(f.$('.next-browser-move-dialog'),null);
});

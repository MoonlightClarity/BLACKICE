import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createBrowserWorkspace} from '../public/next/workspaces/browser.mjs';
import {browserOwnershipTabs, browserConversationCatalog, browserOwnershipRequest} from '../public/next/workspaces/browser-ownership-ui.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const tab = (tabId, conversationId = null, extra = {}) => ({tabId, browser:'relay', contained:true, visible:false,
  url:'https://fixture.example/' + tabId, title:tabId, documentId:tabId + ':7',
  ownershipKind:conversationId ? 'ai' : 'user', conversationId,
  conversationTitle:conversationId ? 'Conversation ' + conversationId.toUpperCase() : null,
  owner:conversationId ? {taskId:conversationId, nodeId:'agent', runId:conversationId} : null, ...extra});
const ids = tabs => tabs.map(item => item.tabId);
async function until(read) {
  for (let count = 0; count < 300; count++) { if (read()) return; await sleep(5); }
  throw Error('Browser ownership UI did not settle.');
}

test('ownership filtering keeps Personal outside every conversation and includes legacy AI only in its own scope', () => {
  const tabs = [tab('personal', null, {conversationId:'a'}), tab('a-tab','a'), tab('b-tab','b'),
    tab('legacy',null,{ownershipKind:undefined,owner:{taskId:'connector'}})];
  assert.deepEqual(ids(browserOwnershipTabs(tabs,{kind:'user'})), ['personal']);
  assert.deepEqual(ids(browserOwnershipTabs(tabs,{kind:'ai',filter:'all'})), ['a-tab','b-tab','legacy']);
  assert.deepEqual(ids(browserOwnershipTabs(tabs,{kind:'ai',filter:'conversation:a'})), ['a-tab']);
  assert.deepEqual(ids(browserOwnershipTabs(tabs,{kind:'ai',filter:'unassigned'})), ['legacy']);
  const catalog = browserConversationCatalog({tabs,conversations:[{id:'a',title:'A'},{id:'b',title:'B'},{id:'empty',title:'No tabs yet'}]});
  assert.deepEqual(catalog.map(item => [item.id,item.tabCount]), [['a',1],['b',1],['empty',0]]);
  assert.deepEqual(browserOwnershipRequest(tabs[1],'conversation:empty',catalog), {
    tabId:'a-tab',expectedUrl:tabs[1].url,expectedDocumentId:'a-tab:7',destination:'conversation',conversationId:'empty',
  });
  assert.throws(() => browserOwnershipRequest(tabs[1],'conversation:unknown',catalog), /no longer available/);
  const deleted = tab('orphan','deleted');
  const saved = browserConversationCatalog({tabs:[deleted],conversations:[{id:'deleted',title:'Deleted conversation',state:'deleted'}]});
  assert.deepEqual(saved,[], 'A surviving tab cannot recreate a deleted move destination.');
  assert.throws(() => browserOwnershipRequest(deleted,'conversation:deleted',saved),/no longer available/);
  assert.equal(browserConversationCatalog({tabs:[deleted]}).length,1,'Legacy snapshots without a catalog still expose their known tab conversations.');
});

async function fixture(t, {native, currentConversation = 'a', extraTabs = false} = {}) {
  const dom = planningDOM(t), win = globalThis.window, calls = [], surfaces = [], subscribers = new Set();
  const storage = new Map(currentConversation ? [['blackice.next.selected',currentConversation]] : []);
  dom.document.defaultView = win;
  dom.document.createDocumentFragment = () => dom.element('fragment');
  Object.assign(win, {innerWidth:1100,innerHeight:800,setTimeout,clearTimeout,
    requestAnimationFrame:callback => setTimeout(callback,0),cancelAnimationFrame:clearTimeout,
    localStorage:{getItem:key => storage.get(key) || null,setItem:(key,value) => storage.set(key,String(value))}});
  const prototype = Object.getPrototypeOf(dom.mount), type = Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value) { this.setAttribute('type',value); }});
  const append = prototype.append;
  prototype.append = function(...children) {
    return append.call(this,...children.flatMap(child=>child.tagName==='FRAGMENT'?[...child.children]:[child]));
  };
  prototype.replaceChildren = function(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.rawText = ''; this.markup = ''; this.append(...children);
  };
  let attached = null;
  if (native) win.relayDesktop = {async browserSurface(request) {
    surfaces.push(structuredClone(request));
    if (request.action === 'hide') attached = null;
    if (request.action === 'attach') attached = request.tabId;
    return {attached:Boolean(attached),tabId:attached};
  }};
  const state = {tabs:[tab('personal'),tab('a-tab','a'),tab('b-tab','b'),
    tab('unassigned',null,{ownershipKind:'ai',owner:{taskId:'connector',nodeId:'bridge'}})],
    activeTab:'b-tab',conversations:[{id:'a',title:'Conversation A',taskId:'task-a',latestRunId:'run-a'},{id:'b',title:'Conversation B'},{id:'empty',title:'Empty conversation'}]};
  if(extraTabs)state.tabs.push(tab('personal-second'),tab('a-second','a'),tab('b-second','b'));
  let failed = false, next = 0, nextScreenshotGate = null, nextActionGate = null;
  const snapshot = () => structuredClone(state);
  const workspace = createBrowserWorkspace({mount:dom.mount,notify(){},
    events:{subscribe(handler){subscribers.add(handler);return () => subscribers.delete(handler);}},
    api:async (route,method='GET',body) => {
      calls.push({route,method,body:structuredClone(body)});
      if (route.startsWith('/api/browser/status')) return snapshot();
      if (route === '/api/browser/ownership') {
        if (failed) throw Error('The page changed before the move.');
        const chosen = state.tabs.find(item => item.tabId === body.tabId); assert.ok(chosen);
        assert.equal(body.expectedUrl,chosen.url); assert.equal(body.expectedDocumentId,chosen.documentId);
        chosen.ownershipKind = body.destination === 'user' ? 'user' : 'ai';
        chosen.conversationId = body.conversationId || null;
        chosen.conversationTitle = state.conversations.find(item => item.id === chosen.conversationId)?.title || null;
        chosen.owner = body.destination === 'user' ? null : {taskId:body.conversationId,nodeId:'agent'};
        return {...snapshot(),ownershipReceipt:{movedTabIds:[chosen.tabId]}};
      }
      if (route === '/api/browser/cleanup-preview') {
        assert.deepEqual(body,{kind:'conversation',conversationId:'a'});
        const scoped=state.tabs.filter(item=>item.conversationId==='a');
        return {scope:body,previewId:'c'.repeat(64),total:scoped.length,
          eligible:0,protected:scoped.length,
          rows:scoped.map(item=>({tabId:item.tabId,title:item.title,
            url:item.url,documentId:item.documentId,eligible:false,reason:'Protected fixture'}))};
      }
      assert.equal(route,'/api/browser/action');
      if (nextActionGate?.action === body.action) {
        const gate=nextActionGate.gate;nextActionGate=null;
        await gate.promise;
      }
      if (body.action === 'open') {
        const opened = tab('opened-' + (++next),null,{url:body.url});state.tabs.push(opened);state.activeTab=opened.tabId;return structuredClone(opened);
      }
      const chosen = state.tabs.find(item => item.tabId === body.tabId);assert.ok(chosen);
      if (body.action === 'screenshot') {
        // Hold an actual Browser screenshot response without blocking status or
        // the cleanup controller; this is the observed delayed-busy boundary.
        if (nextScreenshotGate) {
          const gate = nextScreenshotGate; nextScreenshotGate = null;
          await gate.promise;
        }
        return {...structuredClone(chosen),width:1000,height:700,imageUrl:'data:image/png;base64,aGVsbG8='};
      }
      if (body.action === 'tab_select') state.activeTab=chosen.tabId;
      return structuredClone(chosen);
    }});
  t.after(() => workspace.destroy());workspace.enter();
  const selected = () => dom.$('.next-browser-tab[aria-selected="true"]')?.dataset.tabId || null;
  await until(() => selected() === 'a-tab' && !dom.$('#next-browser-move').disabled);
  const visible = () => dom.mount.querySelectorAll('.next-browser-tab').map(item => item.dataset.tabId);
  const change = async (selector,value) => {const select=dom.$(selector);select.value=value;await select.dispatch('change');await sleep(0);};
  return {...dom,state,calls,surfaces,workspace,storage,selected,visible,change,
    setFailure(value){failed=value;},
    holdNextScreenshot(gate){nextScreenshotGate=gate;},
    holdNextAction(action,gate){nextActionGate={action,gate};},
    async refresh(){const before=calls.filter(call=>call.method==='GET').length;for(const handler of subscribers)handler({type:'browser.status'});await until(()=>calls.filter(call=>call.method==='GET').length>before);await sleep(10);},
    async idle(){await until(()=>!dom.$('#next-browser-personal').disabled);},
    transfers:() => calls.filter(call=>call.route==='/api/browser/ownership'),
    navigations:() => calls.filter(call=>['navigate','open','reload','close'].includes(call.body?.action)),
  };
}

for (const native of [true,false]) {
  const mode = native ? 'native' : 'captured';
  test(mode + ' browser defaults to the current conversation, keeps other owners separate, and never follows a foreign active tab', async t => {
    const f = await fixture(t,{native,currentConversation:'run-a'});
    assert.deepEqual(f.visible(),['a-tab']);
    assert.equal(f.$('#next-browser-conversation').value,'conversation:a');
    assert.equal(f.$('#next-browser-personal').textContent,'Personal (1)');
    assert.equal(f.$('#next-browser-ai').textContent,'AI tabs (3)');
    await f.refresh();assert.equal(f.selected(),'a-tab');
    f.state.tabs.push(tab('orphan','deleted'));await f.refresh();
    assert.equal(f.$('#next-browser-move').querySelectorAll('option').some(option=>option.value==='conversation:deleted'),false,
      'A tab in a deleted conversation must not add that conversation to Move to.');
    await f.change('#next-browser-conversation','all');await f.idle();
    assert.deepEqual(f.visible(),['a-tab','b-tab','unassigned','orphan']);
    await f.click('#next-browser-personal');await f.idle();
    assert.deepEqual(f.visible(),['personal']);assert.equal(f.$('#next-browser-conversation-label').hidden,true);
    assert.equal(f.transfers().length,0,'Filtering alone never changes ownership.');
    assert.equal(f.navigations().length,0,'Filtering never opens, navigates, reloads or closes a page.');
    f.workspace.leave();f.storage.set('blackice.next.selected','b');f.workspace.enter();
    await until(()=>f.selected()==='b-tab');assert.deepEqual(f.visible(),['b-tab']);
  });

  test(mode + ' browser moves the same selected page to an empty conversation and back to Personal with no page reload', async t => {
    const f = await fixture(t,{native});await sleep(20);
    const before = structuredClone(f.state.tabs[1]);
    const captures = f.calls.filter(call=>call.body?.action==='screenshot').length;
    const attaches = f.surfaces.filter(call=>call.action==='attach').length;
    await f.change('#next-browser-move','conversation:empty');await f.idle();
    assert.equal(f.selected(),'a-tab');assert.deepEqual(f.visible(),['a-tab']);
    assert.equal(f.$('#next-browser-conversation').value,'conversation:empty');
    assert.equal(f.state.tabs[1].conversationId,'empty');
    assert.equal(f.state.tabs[1].documentId,before.documentId);assert.equal(f.state.tabs[1].url,before.url);
    assert.equal(f.state.tabs.length,4,'A move never duplicates the tab.');
    assert.deepEqual(f.transfers()[0].body,{tabId:'a-tab',expectedUrl:before.url,expectedDocumentId:before.documentId,destination:'conversation',conversationId:'empty'});
    await f.change('#next-browser-move','user');await f.idle();
    assert.equal(f.selected(),'a-tab');assert.deepEqual(f.visible(),['personal','a-tab']);
    assert.equal(f.state.tabs[1].ownershipKind,'user');assert.equal(f.state.tabs[1].conversationId,null);
    assert.equal(f.$('#next-browser-personal').getAttribute('aria-pressed'),'true');
    assert.equal(f.transfers().length,2);assert.equal(f.navigations().length,0);
    assert.equal(f.calls.filter(call=>call.body?.action==='screenshot').length,captures,'The existing captured page remains valid across a move.');
    await sleep(20);
    assert.equal(f.surfaces.filter(call=>call.action==='attach').length,attaches,'The live native page stays attached across a move.');
  });

  test(mode + ' browser remembers a selected tab and its address draft independently in each ownership scope', async t => {
    const f=await fixture(t,{native,extraTabs:true});
    const choose=async id=>{await f.click('[data-tab-id="'+id+'"]');await f.idle();};
    await choose('a-second');await f.input('#next-browser-url','Unsent A address');
    await f.click('#next-browser-personal');await f.idle();await choose('personal-second');await f.input('#next-browser-url','Unsent Personal address');
    await f.click('#next-browser-ai');await f.idle();assert.equal(f.selected(),'a-second');assert.equal(f.$('#next-browser-url').value,'Unsent A address');
    await f.change('#next-browser-conversation','conversation:b');await f.idle();await choose('b-second');await f.input('#next-browser-url','Unsent B address');
    await f.click('#next-browser-personal');await f.idle();assert.equal(f.selected(),'personal-second');assert.equal(f.$('#next-browser-url').value,'Unsent Personal address');
    await f.click('#next-browser-ai');await f.idle();assert.equal(f.selected(),'b-second');assert.equal(f.$('#next-browser-url').value,'Unsent B address');
    await f.change('#next-browser-conversation','conversation:a');await f.idle();assert.equal(f.selected(),'a-second');assert.equal(f.$('#next-browser-url').value,'Unsent A address');
    await f.change('#next-browser-conversation','all');await f.idle();await choose('b-tab');
    await f.change('#next-browser-conversation','conversation:a');await f.idle();assert.equal(f.selected(),'a-second');
    await f.change('#next-browser-conversation','all');await f.idle();assert.equal(f.selected(),'b-tab','All AI remembers its own selection.');
    await f.change('#next-browser-conversation','conversation:a');await f.idle();
    await f.change('#next-browser-move','conversation:b');await f.idle();
    assert.equal(f.selected(),'a-second','A moved tab overrides the destination’s previous selection.');assert.equal(f.$('#next-browser-url').value,'Unsent A address');
    f.state.tabs=f.state.tabs.filter(item=>item.tabId!=='a-second');f.state.activeTab='personal';await f.refresh();await f.idle();
    assert.equal(f.selected(),'b-tab','A removed remembered tab falls back to the first visible page.');
    await f.change('#next-browser-conversation','conversation:a');await f.idle();assert.equal(f.selected(),'a-tab');
    await f.click('#next-browser-personal');await f.idle();assert.equal(f.selected(),'personal-second');assert.equal(f.$('#next-browser-url').value,'Unsent Personal address');
  });

  test(mode + ' browser keeps a rejected move in its source conversation and creates manual new tabs as Personal', async t => {
    const f = await fixture(t,{native});f.setFailure(true);
    await f.change('#next-browser-move','conversation:b');await f.idle();
    assert.equal(f.selected(),'a-tab');assert.equal(f.$('#next-browser-conversation').value,'conversation:a');
    assert.match(f.$('#next-browser-status').textContent,/page changed/);
    assert.equal(f.transfers().length,1,'The failed transfer is not replayed.');
    f.setFailure(false);
    await f.change('#next-browser-conversation','conversation:empty');await f.idle();
    assert.equal(f.selected(),null);assert.equal(f.$('#next-browser-move').disabled,true);
    assert.match(f.$('#next-browser-tabs').textContent,/No tabs in this conversation/);
    assert.equal(f.navigations().length,0,'An empty conversation never implicitly opens a tab.');
    await f.click('#next-browser-new');await until(()=>f.selected()==='opened-1');await f.idle();
    assert.equal(f.state.tabs.at(-1).ownershipKind,'user');assert.equal(f.state.tabs.at(-1).conversationId,null);
    assert.equal(f.$('#next-browser-personal').getAttribute('aria-pressed'),'true');
    assert.deepEqual(f.navigations().map(call=>call.body),[{action:'open',browser:'relay',url:'about:blank'}]);
  });
}

test('captured Browser restores scoped Preview after a delayed screenshot settles without selection change',async t=>{
  const f=await fixture(t,{native:false});await f.idle();
  await f.click('#next-browser-cleanup-open');
  await f.change('#next-browser-cleanup-conversation','a');
  const button=f.$('#next-browser-cleanup-preview');
  const conversation=f.$('#next-browser-cleanup-conversation');
  const originalConversation=conversation.value;
  assert.equal(originalConversation,'a');
  assert.equal(button.disabled,false,'Exact conversation scope enables Preview when idle');
  const beforeCaptures=f.calls.filter(call=>call.body?.action==='screenshot').length;
  let release;
  const gate={promise:new Promise(resolve=>{release=resolve;})};
  f.holdNextScreenshot(gate);
  try {
    await f.click('#next-browser-shot');
    await until(()=>f.calls.filter(call=>call.body?.action==='screenshot').length>beforeCaptures);
    assert.equal(f.$('#next-browser-shot').disabled,true,'Screenshot is genuinely in flight');
    assert.equal(button.disabled,true,'Cleanup Preview must remain disabled during the delayed screenshot');
    await f.click('#next-browser-cleanup-preview');
    assert.equal(f.calls.filter(call=>call.route==='/api/browser/cleanup-preview').length,0,
      'Busy screenshot must never dispatch a cleanup preview');
  } finally {release();}
  await until(()=>!f.$('#next-browser-shot').disabled);
  assert.equal(button.disabled,false,
    'Screenshot completion must re-enable Preview without conversation-selection events or another status read');
  assert.equal(conversation.value,originalConversation,'A busy transition must not rebuild or change the scope');
  await f.click('#next-browser-cleanup-preview');
  await until(()=>f.calls.filter(call=>call.route==='/api/browser/cleanup-preview').length===1);
  assert.match(f.$('#next-browser-cleanup-summary').textContent,/protected/);
  assert.equal(f.$('#next-browser-cleanup-execute').disabled,true,
    'Read-only preview never authorizes closure of protected pages');
  assert.equal(f.calls.filter(call=>call.route==='/api/browser/cleanup').length,0);
});

test('native Browser restores scoped Preview after a delayed action without changing its selection',async t=>{
  const f=await fixture(t,{native:true});await f.idle();
  await f.click('#next-browser-cleanup-open');
  await f.change('#next-browser-cleanup-conversation','a');
  const button=f.$('#next-browser-cleanup-preview');
  const conversation=f.$('#next-browser-cleanup-conversation');
  assert.equal(conversation.value,'a');
  assert.equal(button.disabled,false);
  const beforeReloads=f.calls.filter(call=>call.body?.action==='reload').length;
  let release;
  const gate={promise:new Promise(resolve=>{release=resolve;})};
  f.holdNextAction('reload',gate);
  try {
    await f.click('#next-browser-reload');
    await until(()=>f.calls.filter(call=>call.body?.action==='reload').length>beforeReloads);
    assert.equal(f.$('#next-browser-reload').disabled,true,'Native Browser operation is actually awaiting the API');
    assert.equal(button.disabled,true,'Scoped Preview stays disabled during the native in-flight action');
    await f.click('#next-browser-cleanup-preview');
    assert.equal(f.calls.filter(call=>call.route==='/api/browser/cleanup-preview').length,0);
  } finally {release();}
  await until(()=>!f.$('#next-browser-reload').disabled);
  assert.equal(button.disabled,false,'Native render must release the Preview busy gate without another selection event');
  assert.equal(conversation.value,'a','The exact conversation selector is retained after busy settles');
  await f.click('#next-browser-cleanup-preview');
  await until(()=>f.calls.filter(call=>call.route==='/api/browser/cleanup-preview').length===1);
  assert.equal(f.$('#next-browser-cleanup-execute').disabled,true,'The preview still protects all pages');
  assert.equal(f.calls.filter(call=>call.route==='/api/browser/cleanup').length,0);
});

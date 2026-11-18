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
      if(body.action==='tab_mark'){if(failed)throw Error('Mark rejected');chosen.inUse=body.inUse;return snapshot();}
      if (body.action === 'tab_select') state.activeTab=chosen.tabId;
      return structuredClone(chosen);
    }});
  t.after(() => workspace.destroy());workspace.enter();
  const selected = () => dom.$('.next-browser-tab[aria-selected="true"]')?.dataset.tabId || null;
  await until(() => selected() === 'b-tab' && !dom.$('#next-browser-in-use').disabled);
  const visible = () => dom.mount.querySelectorAll('.next-browser-tab').map(item => item.dataset.tabId);
  const change = async (selector,value) => {const select=dom.$(selector);select.value=value;await select.dispatch('change');await sleep(0);};
  return {...dom,state,calls,surfaces,workspace,storage,selected,visible,change,
    setFailure(value){failed=value;},
    holdNextScreenshot(gate){nextScreenshotGate=gate;},
    holdNextAction(action,gate){nextActionGate={action,gate};},
    async refresh(){const before=calls.filter(call=>call.method==='GET').length;for(const handler of subscribers)handler({type:'browser.status'});await until(()=>calls.filter(call=>call.method==='GET').length>before);await sleep(10);},
    async idle(){await until(()=>!dom.$('#next-browser-in-use').disabled);},
    transfers:() => calls.filter(call=>call.route==='/api/browser/ownership'),
    navigations:() => calls.filter(call=>['navigate','open','reload','close'].includes(call.body?.action)),
  };
}


for(const native of [true,false]){
 const mode=native?'native':'captured';
 test(mode+' lists all conversations together without transferring page ownership',async t=>{
  const f=await fixture(t,{native});assert.deepEqual(new Set(f.visible()),new Set(['personal','a-tab','b-tab','unassigned']));
  assert.equal(f.$('#next-browser-personal'),null);assert.equal(f.$('#next-browser-move'),null);
  const owners=structuredClone(f.state.tabs.map(t=>t.owner));f.workspace.openConversationId('a');await f.refresh();
  assert.equal(f.selected(),'b-tab');assert.deepEqual(f.state.tabs.map(t=>t.owner),owners);assert.equal(f.transfers().length,0);
 });
 test(mode+' explicit mark/release preserves page selection, address draft and ownership',async t=>{
  const f=await fixture(t,{native});const owner=structuredClone(f.state.tabs.find(t=>t.tabId==='b-tab').owner);
  await f.input('#next-browser-url','https://unsent.test/');await f.click('#next-browser-in-use');
  assert.equal(f.state.tabs.find(t=>t.tabId==='b-tab').inUse,true);assert.equal(f.selected(),'b-tab');
  assert.equal(f.$('#next-browser-url').value,'https://unsent.test/');assert.deepEqual(f.state.tabs.find(t=>t.tabId==='b-tab').owner,owner);
  await f.click('#next-browser-in-use');assert.equal(f.state.tabs.find(t=>t.tabId==='b-tab').inUse,false);assert.equal(f.transfers().length,0);assert.equal(f.navigations().length,0);
 });
 test(mode+' rejected mark leaves current page and draft unchanged',async t=>{
  const f=await fixture(t,{native});f.setFailure(true);await f.input('#next-browser-url','draft');await f.click('#next-browser-in-use');
  assert.equal(f.selected(),'b-tab');assert.equal(f.state.tabs.find(t=>t.tabId==='b-tab').inUse,undefined);assert.equal(f.$('#next-browser-url').value,'draft');assert.equal(f.$('#next-browser-in-use').disabled,false);
 });
 test(mode+' pending mark disables repeated mutation and restores controls when settled',async t=>{
  const f=await fixture(t,{native});let release;const promise=new Promise(r=>release=r);f.holdNextAction('tab_mark',{promise});
  const pending=f.click('#next-browser-in-use');await until(()=>f.$('#next-browser-in-use').disabled);release();await pending;await f.idle();
  assert.equal(f.calls.filter(c=>c.body?.action==='tab_mark').length,1);assert.equal(f.selected(),'b-tab');
 });
}

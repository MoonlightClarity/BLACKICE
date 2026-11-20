import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { ownershipChange } from '../lib/browser-ownership.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

class Runtime extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { assert.fail('Organizing browser tabs must not start a model.'); }
}

class Desktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}

function savedTurn(id, { taskId = id, parentRunId = null, title = id, index = 0 } = {}) {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return { id, taskId, parentRunId, createdAt: at, updatedAt: at, input: title,
    workflow: createMissionWorkflow({ id: 'browser-conversation-fixture', task: title }),
    status: 'completed', settled: true, nodes: { agent: { status: 'completed', output: 'Saved response' } },
    output: 'Saved response', events: [] };
}

// The real BrowserWorkspace and HTTP route own admission and context binding.
// This driver replaces only Chromium so the fixture cannot open user pages.
class BrowserDriver {
  constructor() {
    this.tabs = [
      { tabId: 'page', url: 'https://fixture.invalid/form', documentId: 'page:7', title: 'Draft form', folderId: 'personal', parentTabId: null, owner: null },
      { tabId: 'popup', url: 'https://fixture.invalid/popup', documentId: 'popup:2', title: 'Related popup', folderId: 'personal', parentTabId: 'page', owner: null },
      { tabId: 'other', url: 'https://fixture.invalid/other', documentId: 'other:1', title: 'Separate personal page', folderId: 'personal', parentTabId: null, owner: null },
    ];
    this.pages = new Map(this.tabs.map(tab => [tab.tabId, { webContents: {}, form: 'Unsubmitted draft', history: [tab.url], tab }]));
    this.calls = [];
    this.effects = 0;
    this.cleanupStates = new Map();
  }
  async cleanupInspection(tabId) { return { state: this.cleanupStates.get(tabId) || 'clear' }; }
  status() {
    const owners = new Map(this.tabs.filter(tab => tab.owner).map(tab => [tab.owner.taskId, tab.owner]));
    return { available: true, contained: true, canShow: false, activeTab: 'page', persistence: { healthy: true },
      tabs: structuredClone(this.tabs), downloads: [], activeDownloads: 0,
      folders: [{ id: 'personal', name: 'Personal', kind: 'user' }, ...[...owners].map(([taskId, owner]) =>
        ({ id: 'conversation-' + taskId, kind: 'task', taskId, name: owner.label || taskId }))] };
  }
  async perform(args, context = {}) {
    this.calls.push({ args: structuredClone(args), source: context.source,
      owner: structuredClone(context.owner), destinationOwner: structuredClone(context.destinationOwner) });
    if (args.action === 'open') {
      await this.beforeOpen?.();
      const tab = { tabId: 'new-' + this.tabs.length, url: args.url, documentId: 'new:1', title: 'New page',
        folderId: 'personal', parentTabId: null, owner: context.owner || null };
      this.tabs.push(tab);
      this.pages.set(tab.tabId, { webContents: {}, form: '', history: [tab.url], tab });
      this.effects++;
      return { ...this.status(), tabId: tab.tabId };
    }
    if (args.action === 'close') {
      const index = this.tabs.findIndex(tab => tab.tabId === args.tabId);
      if (index < 0) throw Error('Tab already closed.');
      this.tabs.splice(index, 1); this.pages.delete(args.tabId); this.effects++;
      return { ...this.status(), tabId: args.tabId };
    }
    assert.equal(args.action, 'transfer_ownership', 'Moving ownership must not navigate, reload, or create another page.');
    const change = ownershipChange(args, this.status(), context.owner, context.source, context.destinationOwner);
    const moved = new Set([args.tabId]);
    if (args.includeChildren) {
      for (let previous = -1; previous !== moved.size;) {
        previous = moved.size;
        for (const tab of this.tabs) if (moved.has(tab.parentTabId)) moved.add(tab.tabId);
      }
    }
    for (const tab of this.tabs) if (moved.has(tab.tabId)) {
      tab.owner = structuredClone(change.owner);
      tab.folderId = change.owner ? 'conversation-' + change.owner.taskId : 'personal';
    }
    this.effects++;
    return { ...this.status(), ownershipReceipt: { action: args.action, tabId: args.tabId,
      documentId: change.tab.documentId, owner: structuredClone(change.owner), movedTabIds: [...moved] } };
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-conversation-browser-http-'));
  const driver = new BrowserDriver(), browser = new BrowserWorkspace({ driver });
  const app = await createHarnessServer({ port: 0, dataDir: path.join(root, 'data'), defaultCwd: path.join(root, 'work'),
    runtime: new Runtime(), desktop: new Desktop(), browser, autoAttachDesktop: false, remoteAccess: false,
    browserProfiles: { discover: async () => ({ sources: [], imports: [] }), close: async () => {} },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const url = await app.listen(), initial = await fetch(url), cookie = initial.headers.get('set-cookie').split(';')[0];
  await initial.text();
  const request = async (route, value, headers = {}) => {
    const response = await fetch(url + route, { method: value === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...headers, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, data: await response.json() };
  };
  for (const turn of [
    savedTurn('conversation-a', { title: 'Research A' }),
    savedTurn('conversation-b', { title: 'Research B', index: 1 }),
    savedTurn('b-followup', { taskId: 'conversation-b', parentRunId: 'conversation-b', title: 'Another turn', index: 2 }),
    savedTurn('archived', { title: 'Archived research', index: 3 }),
    savedTurn('deleted', { title: 'Discarded research', index: 4 }),
  ]) await app.conversations.capture(turn);
  await app.conversations.rename('conversation-b', 'Named Research B');
  await app.conversations.setState('archived', 'archived');
  await app.conversations.setState('deleted', 'deleted');
  const status = async () => {
    const result = await request('/api/browser/status?view=contained');
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const move = (destination, conversationId, extra = {}) => request('/api/browser/ownership', {
    tabId: 'page', expectedUrl: 'https://fixture.invalid/form', expectedDocumentId: 'page:7', destination,
    ...(conversationId === undefined ? {} : { conversationId }), ...extra,
  });
  return { app, browser, driver, request, status, move };
}

test('browser HTTP status lists saved empty and archived conversations, names families, and separates Personal tabs', async t => {
  const f = await fixture(t);
  const initial = await f.status();
  assert.deepEqual(new Set(initial.conversations.map(item => item.id)), new Set(['conversation-a', 'conversation-b', 'archived']));
  // Automatic labels omit leading task verbs; explicit names bypass formatting.
  assert.equal(initial.conversations.find(item => item.id === 'conversation-a').title, 'A');
  assert.equal((await f.app.conversations.family('conversation-a')).runs[0].input, 'Research A', 'Formatting must not alter the authored conversation.');
  const destination = initial.conversations.find(item => item.id === 'conversation-b');
  assert.equal(destination.title, 'Named Research B');
  assert.equal(destination.latestRunId, 'b-followup');
  assert.equal(destination.tabCount, 0, 'A conversation must be a destination before it has a browser tab.');
  assert.equal(initial.conversations.find(item => item.id === 'archived').state, 'archived');
  assert.ok(initial.tabs.every(tab => tab.ownershipKind === 'user' && tab.conversationId === null));

  // Previously saved per-turn owners still appear under their conversation.
  f.driver.tabs[2].owner = { taskId: 'b-followup', runId: 'b-followup', nodeId: 'agent' };
  const legacy = await f.status(), tab = legacy.tabs.find(item => item.tabId === 'other');
  assert.equal(tab.ownershipKind, 'ai');
  assert.equal(tab.conversationId, 'conversation-b');
  assert.equal(tab.conversationTitle, 'Named Research B');
  assert.equal(legacy.conversations.find(item => item.id === 'conversation-b').tabCount, 1);
});

test('browser HTTP moves a live tab branch from Personal to an empty conversation, to another conversation, and back', async t => {
  const f = await fixture(t), page = f.driver.pages.get('page'), popup = f.driver.pages.get('popup');
  for (const [destination, conversationId, title, runId] of [
    ['conversation', 'conversation-a', 'A', 'conversation-a'],
    ['conversation', 'conversation-b', 'Named Research B', 'b-followup'],
    ['user', undefined, null, null],
  ]) {
    const result = await f.move(destination, conversationId);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.deepEqual(new Set(result.data.ownershipReceipt.movedTabIds), new Set(['page', 'popup']));
    const transferred = result.data.tabs.filter(tab => ['page', 'popup'].includes(tab.tabId));
    assert.equal(transferred.length, 2);
    for (const tab of transferred) {
      assert.equal(tab.ownershipKind, conversationId ? 'ai' : 'user');
      assert.equal(tab.conversationId, conversationId || null);
      assert.equal(tab.conversationTitle, title);
      if (conversationId) {
        assert.equal(tab.owner.taskId, conversationId);
        assert.equal(tab.owner.runId, runId);
      } else assert.equal(tab.owner, null);
    }
    const untouched = result.data.tabs.find(tab => tab.tabId === 'other');
    assert.equal(untouched.ownershipKind, 'user');
    assert.equal(untouched.conversationId, null);
    for (const conversation of result.data.conversations) assert.equal(conversation.tabCount, conversation.id === conversationId ? 2 : 0);
    const observed = await f.status();
    assert.deepEqual(observed.tabs, result.data.tabs, 'The next status read must agree with the move receipt.');
    assert.equal(f.driver.pages.get('page'), page);
    assert.equal(f.driver.pages.get('popup'), popup);
    assert.equal(page.form, 'Unsubmitted draft');
    assert.deepEqual(page.history, ['https://fixture.invalid/form']);
    assert.equal(page.tab.documentId, 'page:7');
    assert.equal(popup.tab.parentTabId, 'page');
  }
  assert.equal(f.driver.effects, 3);
  assert.ok(f.driver.calls.every(call => call.source === 'user' && call.args.includeChildren === true));
});

test('browser HTTP rejects stale pages and unavailable conversations without changing tab ownership', async t => {
  const f = await fixture(t), original = await f.status();
  for (const extra of [
    { expectedDocumentId: 'page:stale' },
    { expectedUrl: 'https://fixture.invalid/previous' },
  ]) {
    const result = await f.move('conversation', 'conversation-a', extra);
    assert.notEqual(result.status, 200);
    assert.match(result.data.error, /page changed|identity/i);
    assert.equal(f.driver.effects, 0);
    assert.deepEqual((await f.status()).tabs, original.tabs);
  }
  for (const conversationId of ['missing-conversation', 'deleted']) {
    const attempts = f.driver.calls.length;
    const result = await f.move('conversation', conversationId);
    assert.equal(result.status, 404, JSON.stringify(result.data));
    assert.equal(f.driver.calls.length, attempts, 'Unavailable conversation must be rejected before driver dispatch.');
    assert.equal(f.driver.effects, 0);
  }
  assert.deepEqual((await f.status()).tabs, original.tabs);
});

test('a manual new browser tab stays Personal while another conversation owns tabs', async t => {
  const f = await fixture(t);
  assert.equal((await f.move('conversation', 'conversation-a')).status, 200);
  const opened = await f.request('/api/browser/action', { action: 'open', browser: 'relay', url: 'https://fixture.invalid/manual' });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const status = await f.status(), tab = status.tabs.find(item => item.url === 'https://fixture.invalid/manual');
  assert.ok(tab);
  assert.equal(tab.owner, null);
  assert.equal(tab.ownershipKind, 'user');
  assert.equal(tab.conversationId, null);
  assert.equal(status.conversations.find(item => item.id === 'conversation-a').tabCount, 2);
  const open = f.driver.calls.at(-1);
  assert.equal(open.source, 'user');
  assert.equal(open.owner, undefined);
});

test('Close All Tabs closes personal and conversation tabs but not the reserved calling-chat tab', async t => {
  const f = await fixture(t);
  assert.equal((await f.move('conversation', 'conversation-a')).status, 200);
  f.driver.tabs.push({ tabId: 'reserved', url: 'https://fixture.invalid/chat', documentId: 'reserved:1',
    title: 'Calling chat', folderId: 'personal', parentTabId: null, owner: null, purpose: 'chat-mode' });
  const result = await f.request('/api/browser/close-all', {});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(new Set(result.data.closedTabIds), new Set(['page', 'popup', 'other']));
  assert.deepEqual(f.driver.tabs.map(tab => tab.tabId), ['reserved']);
  const repeated = await f.request('/api/browser/close-all', {});
  assert.equal(repeated.data.closed, 0, 'Closing all tabs again should be an idempotent no-op');
});

test('Close All reports an eligible remainder when newly spawned pages reach its drain limit',async t=>{
  const f=await fixture(t), driver=f.driver, original=driver.perform.bind(driver);
  driver.tabs=driver.tabs.filter(tab=>tab.tabId!=='other');driver.tabs.find(tab=>tab.tabId==='popup').inUse=true;
  let opened=0;
  driver.perform=async(args,context)=>{
    const result=await original(args,context);
    if(args.action==='close')driver.tabs.push({tabId:'late-'+(++opened),url:'https://fixture.invalid/late',folderId:'personal',owner:null});
    return result;
  };
  const result=await f.request('/api/browser/close-all',{});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.closed,4);
  assert.deepEqual(result.data.failedTabs,[]);
  assert.deepEqual(result.data.skippedInUseIds,['popup']);
  assert.deepEqual(result.data.remainingTabIds,['popup','late-4']);
});

for (const action of ['archive', 'delete']) {
  test(action + ' closes only the archived/trashed conversation tabs, including legacy turn owners', async t => {
    const f = await fixture(t);
    assert.equal((await f.move('conversation', 'conversation-a')).status, 200);
    f.driver.tabs[2].owner = { taskId: 'b-followup', runId: 'b-followup', nodeId: 'agent' };
    const response = await f.request('/api/conversations/conversation-a/' + action, {});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.state, action === 'archive' ? 'archived' : 'deleted');
    assert.deepEqual(new Set(response.data.tabCleanup.closedTabIds), new Set(['page', 'popup']));
    assert.deepEqual(f.driver.tabs.map(tab => tab.tabId), ['other']);
    const status = await f.status();
    assert.equal(status.tabs[0].conversationId, 'conversation-b', 'Another conversation must survive');
    assert.equal(status.tabs[0].ownershipKind, 'ai');
    const old = await f.request('/api/conversations?state=' + (action === 'archive' ? 'archived' : 'deleted'));
    assert.equal(old.status, 200);
  });
}

test('a failed tab close does not roll back a saved archive and returns the failure', async t => {
  const f = await fixture(t);
  await f.move('conversation', 'conversation-a');
  const original = f.driver.perform.bind(f.driver);
  f.driver.perform = (args, context) => args.action === 'close' ? Promise.reject(Error('Close failed')) : original(args, context);
  const result = await f.request('/api/conversations/conversation-a/archive', {});
  assert.equal(result.status, 200);
  assert.equal(result.data.state, 'archived');
  assert.equal(result.data.tabCleanup.failedTabs.length, 2);
  assert.equal(result.data.tabCleanup.closed, 0);
  assert.equal(f.driver.tabs.length, 3, 'Unclosed pages must not be reported as closed');
});

test('browser ownership HTTP endpoint uses the local user path rather than a remote connection header', async t => {
  const f = await fixture(t), before = await f.status();
  const result = await f.request('/api/browser/ownership', {
    tabId: 'page', expectedUrl: 'https://fixture.invalid/form', expectedDocumentId: 'page:7',
    destination: 'conversation', conversationId: 'conversation-a',
  }, { 'x-blackice-remote': '1' });
  assert.equal(result.status, 403, JSON.stringify(result.data));
  assert.equal(f.driver.calls.length, 0);
  assert.deepEqual((await f.status()).tabs, before.tabs);
});

test('a conversation moved to Trash while its ownership transfer is queued is not assigned the tab', async t => {
  const f = await fixture(t);
  let releaseOpen, enteredOpen, receivedTransfer;
  const openStarted = new Promise(resolve => { enteredOpen = resolve; });
  const openGate = new Promise(resolve => { releaseOpen = resolve; });
  const transferQueued = new Promise(resolve => { receivedTransfer = resolve; });
  f.driver.beforeOpen = async () => { enteredOpen(); await openGate; };
  const originalPerform = f.browser.perform.bind(f.browser);
  f.browser.perform = (args, context) => {
    const result = originalPerform(args, context);
    if (args.action === 'transfer_ownership') receivedTransfer();
    return result;
  };
  const opening = f.request('/api/browser/action', { action: 'open', browser: 'relay', url: 'https://fixture.invalid/queued' });
  let moving;
  try {
    await openStarted;
    moving = f.move('conversation', 'conversation-a');
    await transferQueued;
    await f.app.conversations.setState('conversation-a', 'deleted');
    releaseOpen();
    assert.equal((await opening).status, 200);
    const result = await moving;
    assert.equal(result.status, 404, JSON.stringify(result.data));
    const observed = await f.status();
    assert.equal(observed.tabs.find(tab => tab.tabId === 'page').owner, null);
    assert.equal(observed.tabs.find(tab => tab.tabId === 'popup').owner, null);
    assert.ok(observed.conversations.every(conversation => conversation.id !== 'conversation-a'));
    assert.ok(f.driver.calls.every(call => call.args.action !== 'transfer_ownership'), 'The queued move must fail before driver dispatch.');
  } finally {
    releaseOpen();
    await Promise.allSettled([opening, moving]);
  }
});

for (const lifecycle of [{status:'running',settled:false},{status:'cancelled',settled:false}]) {
  test('archive rejects '+lifecycle.status+' unsettled work without closing tabs', async t => {
    const f=await fixture(t); await f.move('conversation','conversation-a');
    const get=f.app.conversations.engine.getRun.bind(f.app.conversations.engine);
    f.app.conversations.engine.getRun=id=>id==='conversation-a'?{...savedTurn(id),...lifecycle}:get(id);
    const response=await f.request('/api/conversations/conversation-a/archive',{});
    assert.equal(response.status,409);
    assert.equal(f.app.conversations.states['conversation-a']?.state||'active','active');
    assert.equal(f.driver.calls.filter(call=>call.args.action==='close').length,0);
    assert.equal(f.driver.tabs.length,3);
  });
}

test('queued owned open is rejected after archive and restore permits a later open',async t=>{
  const f=await fixture(t); await f.move('conversation','conversation-a');
  let release; const held=f.browser.enqueue(()=>new Promise(resolve=>{release=resolve;}),{action:'fixture'});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const owner={taskId:'conversation-a',conversationId:'conversation-a',runId:'conversation-a',nodeId:'conversation'};
  const pending=f.browser.perform({action:'open',browser:'relay',url:'https://fixture.invalid/late'},{owner});
  const rejected=assert.rejects(pending,{code:'BROWSER_CONVERSATION_RETIRED'});
  const changed=new Promise(resolve=>f.app.conversations.once('metadata.updated',resolve));
  const retiring=f.request('/api/conversations/conversation-a/archive',{});
  await changed; release(); await held; await rejected;
  const result=await retiring; assert.equal(result.status,200);
  assert.deepEqual(result.data.tabCleanup.remainingTabIds,[]);
  assert.ok(!f.driver.calls.some(call=>call.args.action==='open'));
  await f.request('/api/conversations/conversation-a/restore',{});
  await f.browser.perform({action:'open',browser:'relay',url:'https://fixture.invalid/restored'},{owner});
  assert.ok(f.driver.tabs.some(tab=>tab.url.endsWith('/restored')));
});

test('cleanup drains a late owned popup but preserves a transferred Personal page',async t=>{
  const f=await fixture(t); await f.move('conversation','conversation-a');
  const perform=f.driver.perform.bind(f.driver); let spawned=false;
  f.driver.perform=async(args,context)=>{
    const parent=f.driver.tabs.find(tab=>tab.tabId===args.tabId);
    const result=await perform(args,context);
    if(args.action==='close'&&!spawned){
      spawned=true;
      f.driver.tabs.push({...parent,tabId:'late-popup',parentTabId:null});
      f.driver.tabs.find(tab=>tab.tabId==='popup').owner=null;
    }
    return result;
  };
  const response=await f.request('/api/conversations/conversation-a/archive',{});
  assert.deepEqual(new Set(response.data.tabCleanup.closedTabIds),new Set(['page','late-popup']));
  assert.deepEqual(response.data.tabCleanup.remainingTabIds,[]);
  assert.deepEqual(new Set(f.driver.tabs.map(tab=>tab.tabId)),new Set(['popup','other']));
});

test('cleanup bounds a continuously spawning adapter and reports remaining tabs',async t=>{
  const f=await fixture(t); await f.move('conversation','conversation-a');
  const perform=f.driver.perform.bind(f.driver); let count=0;
  f.driver.perform=async(args,context)=>{
    const parent=f.driver.tabs.find(tab=>tab.tabId===args.tabId);
    const result=await perform(args,context);
    if(args.action==='close')f.driver.tabs.push({...parent,tabId:'late-'+(++count),parentTabId:null});
    return result;
  };
  const response=await f.request('/api/conversations/conversation-a/archive',{});
  assert.equal(response.status,200);
  assert.equal(response.data.tabCleanup.closed,8);
  assert.equal(response.data.tabCleanup.remainingTabIds.length,2);
  assert.equal(count,8,'No infinite cleanup loop');
});


for(const action of ['archive','delete']) test(action+' refuses a follow-up admitted before the final retirement check',async t=>{
  const f=await fixture(t);await f.move('conversation','conversation-a');
  const archive=f.app.conversations,engine=archive.engine,change=archive.changeState.bind(archive),execute=engine.execute;
  const followUp={...savedTurn('racing-turn',{taskId:'conversation-a',parentRunId:'conversation-a'}),status:'queued',settled:false};
  let release,execution;
  const gate=new Promise(resolve=>{release=resolve;});
  engine.execute=async run=>{await gate;run.status='completed';};
  archive.changeState=(id,value)=>{
    const retirement=change(id,value);
    // The preliminary family read has finished but the serialized state
    // operation has not run yet. Admit through the real engine synchronously.
    engine.dispatchRun(followUp);
    execution=engine.executions.get(followUp.id);
    return retirement;
  };
  try{
    const before=archive.metadataRevision;
    const response=await f.request('/api/conversations/conversation-a/'+action,{});
    assert.ok(execution,'the racing work must actually be admitted');
    assert.equal(engine.runs.get(followUp.id).settled,false);
    assert.equal(response.status,409,'retirement must not commit once work was admitted');
    assert.equal(archive.metadataRevision,before);
    assert.equal(archive.states['conversation-a']?.state||'active','active');
    assert.equal(archive.retiredReceiptIds.has('conversation-a'),false);
    assert.equal(f.driver.calls.filter(call=>call.args.action==='close').length,0);
    assert.equal(f.driver.tabs.length,3);
  }finally{archive.changeState=change;engine.execute=execute;release();await execution;}
});

test('restoring while retirement cleanup is queued preserves the restored conversation tabs',async t=>{
  const f=await fixture(t);await f.move('conversation','conversation-a');
  const original=f.browser.closeTabs.bind(f.browser);let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  f.browser.closeTabs=async args=>{entered();await gate;return original(args);};
  const retiring=f.request('/api/conversations/conversation-a/archive',{});
  try{
    await started;
    assert.equal((await f.request('/api/conversations/conversation-a/restore',{})).status,200);
    release();await retiring;
    assert.ok(f.driver.tabs.some(tab=>tab.tabId==='page'),'restored work must keep its tab');
  }finally{release();await retiring;}
});

test('partial close failure reports the failed tab and closes the other matching tab',async t=>{
  const f=await fixture(t);await f.move('conversation','conversation-a');
  const perform=f.driver.perform.bind(f.driver);
  f.driver.perform=(args,context)=>args.action==='close'&&args.tabId==='page'?Promise.reject(Error('fixture close failure')):perform(args,context);
  const result=await f.request('/api/conversations/conversation-a/delete',{});
  assert.equal(result.status,200);assert.equal(result.data.state,'deleted');
  assert.deepEqual(result.data.tabCleanup.closedTabIds,['popup']);
  assert.deepEqual(result.data.tabCleanup.failedTabs.map(x=>x.tabId),['page']);
  assert.deepEqual(result.data.tabCleanup.remainingTabIds,['page']);
  assert.deepEqual(new Set(f.driver.tabs.map(x=>x.tabId)),new Set(['page','other']));
});

test('Trash rejects active work without closing tabs',async t=>{
  const f=await fixture(t);await f.move('conversation','conversation-a');
  const get=f.app.conversations.engine.getRun.bind(f.app.conversations.engine);
  f.app.conversations.engine.getRun=id=>id==='conversation-a'?{...savedTurn(id),status:'running',settled:false}:get(id);
  const result=await f.request('/api/conversations/conversation-a/delete',{});
  assert.equal(result.status,409);assert.equal(f.driver.tabs.length,3);
});
for(const action of ['archive','delete']) test(action+' reserves engine admission throughout asynchronous metadata persistence',async t=>{
  const f=await fixture(t);await f.move('conversation','conversation-a');
  const archive=f.app.conversations,io=archive.io;let release,entered;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  archive.io={...io,open:async(...args)=>{if(String(args[0]).includes('conversation-state.json.bak')){entered();await gate;}return io.open(...args);}};
  const retiring=f.request('/api/conversations/conversation-a/'+action,{});
  try{
    const checkpoint=await Promise.race([started.then(()=>true),retiring.then(()=>false)]);
    assert.equal(checkpoint,true,'retirement must reach the held metadata write');
    assert.throws(()=>archive.engine.dispatchRun(savedTurn('new-turn',{taskId:'conversation-a',parentRunId:'conversation-a'})),{code:'CONVERSATION_TRANSITION'});
    assert.equal(archive.engine.runs.has('new-turn'),false);
    assert.equal(f.driver.calls.filter(call=>call.args.action==='close').length,0);
    release();assert.equal((await retiring).status,200);
    assert.throws(()=>archive.engine.dispatchRun(savedTurn('new-turn',{taskId:'conversation-a'})),{code:'CONVERSATION_TRANSITION'});
    await f.request('/api/conversations/conversation-a/restore',{});
    assert.doesNotThrow(()=>archive.assertRunAdmission(savedTurn('new-turn',{taskId:'conversation-a'})));
  }finally{release();archive.io=io;await retiring;}
});
test('restore during a close batch prevents further closes',async t=>{
  const f=await fixture(t);await f.move('conversation','conversation-a');
  const perform=f.driver.perform.bind(f.driver);let first=true;
  f.driver.perform=async(args,context)=>{
    const result=await perform(args,context);
    if(args.action==='close'&&first){first=false;await f.app.conversations.setState('conversation-a','active');}
    return result;
  };
  const response=await f.request('/api/conversations/conversation-a/archive',{});
  assert.deepEqual(response.data.tabCleanup.closedTabIds,['page']);
  assert.ok(f.driver.tabs.some(tab=>tab.tabId==='popup'));
});

test('standalone HTTP cleanup previews exact conversation and selected tabs without changing archived state', async t => {
  const f = await fixture(t);
  assert.equal((await f.move('conversation', 'conversation-a')).status, 200);
  f.driver.cleanupStates.set('popup', 'interactive');
  const preview = await f.request('/api/browser/cleanup-preview', { kind:'conversation', conversationId:'conversation-a' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.total, 2);
  assert.equal(preview.data.eligible, 1);
  assert.deepEqual(preview.data.rows.filter(tab => tab.eligible).map(tab => tab.tabId), ['page']);
  const blocked = await f.request('/api/browser/cleanup', {
    scope: preview.data.scope, previewId: preview.data.previewId, selectedTabIds:['popup'],
  });
  assert.equal(blocked.status, 409);
  assert.equal(f.driver.tabs.length, 3);
  const result = await f.request('/api/browser/cleanup', {
    scope: preview.data.scope, previewId: preview.data.previewId, selectedTabIds:['page'],
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.closedTabIds, ['page']);
  assert.deepEqual(result.data.remainingTabIds, ['popup']);
  assert.equal(result.data.persistenceVerified, true);
  assert.equal(f.driver.tabs.length, 2);
  const catalogue = await f.status();
  assert.equal(catalogue.conversations.find(c => c.id === 'conversation-a').state, 'active');
  assert.ok(catalogue.tabs.some(tab => tab.tabId === 'other' && tab.ownershipKind === 'user'));
  assert.ok(catalogue.tabs.some(tab => tab.tabId === 'popup' && tab.conversationId === 'conversation-a'));
});


test('HTTP limited-inspection candidate requires exact per-tab review before a scoped close', async t => {
  const f = await fixture(t);
  assert.equal((await f.move('conversation','conversation-a')).status, 200);
  f.driver.cleanupStates.set('page','limited');
  const preview = await f.request('/api/browser/cleanup-preview',
    { kind:'conversation', conversationId:'conversation-a' });
  assert.equal(preview.status,200,JSON.stringify(preview.data));
  assert.equal(preview.data.reviewRequired,1);
  assert.equal(preview.data.rows.find(row => row.tabId === 'page').manualReviewRequired,true);
  const proposal = {
    scope:preview.data.scope, previewId:preview.data.previewId, selectedTabIds:['page'],
  };
  const notReviewed = await f.request('/api/browser/cleanup', proposal);
  assert.equal(notReviewed.status,409,'HTTP route must not silently treat limited DOM coverage as verified safe.');
  assert.match(notReviewed.data.error,/review/i);
  assert.ok(f.driver.tabs.find(tab => tab.tabId === 'page'),'Unreviewed page remains open.');
  const wrongReview = await f.request('/api/browser/cleanup',
    {...proposal, reviewedTabIds:['other']});
  assert.equal(wrongReview.status,400,'Review identity cannot be supplied for a different tab.');
  const reviewed = await f.request('/api/browser/cleanup',
    {...proposal, reviewedTabIds:['page']});
  assert.equal(reviewed.status,200,JSON.stringify(reviewed.data));
  assert.deepEqual(reviewed.data.closedTabIds,['page']);
  assert.deepEqual(new Set(f.driver.tabs.map(tab=>tab.tabId)),new Set(['popup','other']));
});

test('HTTP cleanup rejects stale preview and remote/connector-wide scope without touching tabs', async t => {
  const f = await fixture(t);
  assert.equal((await f.move('conversation', 'conversation-a')).status, 200);
  const preview = await f.request('/api/browser/cleanup-preview', { kind:'task',
    conversationId:'conversation-a', taskId:'conversation-a', nodeId:'conversation' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  f.driver.tabs.find(tab => tab.tabId === 'page').documentId = 'page:2';
  const stale = await f.request('/api/browser/cleanup', {
    scope: preview.data.scope, previewId: preview.data.previewId, selectedTabIds:['page'],
  });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /Preview again before closing/);
  for (const route of ['/api/browser/cleanup-preview', '/api/browser/cleanup']) {
    const remote = await f.request(route, {}, { 'x-blackice-remote': '1' });
    assert.equal(remote.status, 403);
  }
  const global = await f.request('/api/browser/cleanup-preview', { kind:'all', conversationId:'conversation-a' });
  assert.equal(global.status, 400);
  assert.deepEqual(new Set(f.driver.tabs.map(t => t.tabId)), new Set(['page', 'popup', 'other']));
});

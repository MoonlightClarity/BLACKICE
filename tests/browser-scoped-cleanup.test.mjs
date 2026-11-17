import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { BrowserRouter } from '../desktop/browser-router.mjs';
import { browserConversationStatus } from '../lib/browser-conversations.mjs';
import { browserCleanupScope, browserCleanupPreview, browserCleanupTaskGroups } from '../lib/browser-scoped-cleanup.mjs';

const owner = (conversation, node = 'research') => ({ taskId: conversation, nodeId: node,
  runId: conversation + '-run', conversationId: conversation, label: node });
const tab = (id, conversation, extra = {}) => ({ tabId: id, url: 'https://fixture.invalid/' + id,
  documentId: id + ':1', title: id, ...(conversation ? { owner: owner(conversation) } : { owner: null }),
  suspended: false, loading: false, ...extra });
const conversations = { list: () => [
  { id: 'a', title: 'Research A', state: 'active', latestRunId: 'a-run' },
  { id: 'b', title: 'Coordination B', state: 'active', latestRunId: 'b-run' },
] };

class FixtureDriver extends EventEmitter {
  constructor(tabs) { super(); this.tabs = structuredClone(tabs); this.downloads = [];
    this.forms = new Map(); this.effects = []; this.fail = new Set(); this.late = null; }
  status() { return { contained: true, tabs: structuredClone(this.tabs), downloads: structuredClone(this.downloads),
    persistence: { healthy: true }, folders: [] }; }
  async cleanupInspection(id) { return { state: this.forms.get(id) || 'clear' }; }
  async perform(args, context) {
    assert.equal(args.action, 'close');
    assert.equal(context.source, 'host-cleanup');
    const current = this.tabs.find(t => t.tabId === args.tabId);
    if (!current) throw Error('Already absent');
    if (current.url !== args.expectedUrl || current.documentId !== args.expectedDocumentId)
      throw Error('Stale document');
    if (typeof context.cleanupGuard === 'function') context.cleanupGuard();
    if (this.fail.has(args.tabId)) throw Error('Injected close failure');
    this.effects.push(args.tabId);
    this.tabs = this.tabs.filter(t => t.tabId !== args.tabId);
    if (this.late && args.tabId === this.late.after) this.tabs.push(this.late.page);
    return this.status();
  }
}
const fixture = entries => {
  const driver = new FixtureDriver(entries), browser = new BrowserWorkspace({ driver });
  return { driver, browser, options: { conversations, activeRunIds: () => new Set() } };
};

test('scope demands a real conversation and exact worker, not connector-wide ownership', () => {
  assert.throws(() => browserCleanupScope({ kind: 'task', conversationId: 'a', taskId: 'shared' }), /exact saved task/);
  assert.throws(() => browserCleanupScope({ kind: 'conversation', conversationId: 'a', nodeId: 'research' }), /cannot silently/);
  assert.throws(() => browserCleanupScope({ kind: 'all', conversationId: 'a' }), /Choose one/);
  const s = browserConversationStatus({ tabs: [
    tab('a1', 'a'), tab('a2', 'a', { owner: owner('a', 'review') }),
    tab('b1', 'b'), tab('personal', null), tab('direct', null, { owner: { taskId: 'connector', runId: 'shared', nodeId: 'direct' } }),
  ] }, conversations);
  assert.equal(browserCleanupPreview(s, { kind: 'conversation', conversationId: 'a' },
    { inspections: new Map([['a1', { state: 'clear' }], ['a2', { state: 'clear' }]]) }).total, 2);
  const groups = browserCleanupTaskGroups(s, 'a');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.nodeId).sort(), ['research', 'review']);
  assert.equal(s.tabs.find(t => t.tabId === 'direct').conversationId, null);
});

test('limited DOM inspection is a manually reviewable candidate, not verified completion', async () => {
  const f = fixture([tab('ordinary', 'a'), tab('coordination', 'b')]);
  f.driver.forms.set('ordinary', 'limited');
  const preview = await f.browser.previewScopedCleanup({ kind: 'conversation', conversationId: 'a' }, f.options);
  assert.equal(preview.eligible, 1, 'An ordinary page must not become a blanket blocker.');
  assert.equal(preview.reviewRequired, 1);
  assert.equal(preview.rows[0].manualReviewRequired, true);
  assert.match(preview.rows[0].inspectionWarning, /closed shadow/i);
  await assert.rejects(f.browser.executeScopedCleanup({
    scope: preview.scope, previewId: preview.previewId, selectedTabIds: ['ordinary'] }, f.options),
    { code: 'BROWSER_CLEANUP_REVIEW_REQUIRED' });
  assert.deepEqual(f.driver.effects, [], 'No close before explicit per-tab manual review.');
  const done = await f.browser.executeScopedCleanup({
    scope: preview.scope, previewId: preview.previewId, selectedTabIds: ['ordinary'],
    reviewedTabIds: ['ordinary'] }, f.options);
  assert.deepEqual(done.closedTabIds, ['ordinary']);
  assert.deepEqual(f.driver.tabs.map(t => t.tabId), ['coordination']);
});

test('preview protects active, transferred, forms, suspended, download and unknown effects', async () => {
  const f = fixture([
    tab('ok', 'a'), tab('person-touched', 'a', { userPinned: true }), tab('form', 'a'),
    tab('suspended', 'a', { suspended: true }), tab('dialog', 'a', { pendingInteraction: { status: 'pending' } }),
    tab('download', 'a'), tab('uncertain', 'a', { uncertainEffects: true }),
    tab('coordination', 'b'), tab('human', null), tab('chat', 'b', { purpose: 'chat-mode' }),
  ]);
  f.driver.forms.set('form', 'interactive');
  f.driver.forms.set('suspended', 'suspended');
  f.driver.downloads = [{ tabId: 'download', status: 'downloading' }];
  const preview = await f.browser.previewScopedCleanup({ kind: 'conversation', conversationId: 'a' }, f.options);
  assert.equal(preview.total, 7); assert.equal(preview.eligible, 1); assert.equal(preview.protected, 6);
  assert.deepEqual(preview.rows.filter(row => row.eligible).map(row => row.tabId), ['ok']);
  await assert.rejects(f.browser.executeScopedCleanup({
    scope: preview.scope, previewId: preview.previewId, selectedTabIds: ['person-touched'] }, f.options),
  { code: 'BROWSER_CLEANUP_PROTECTED' });
  assert.deepEqual(f.driver.effects, []);
});

test('exact preview closes selected owner pages only, reports a late popup without adopting it', async () => {
  const f = fixture([tab('a1', 'a'), tab('a2', 'a'), tab('other', 'b'), tab('personal', null)]);
  f.driver.late = { after: 'a1', page: tab('late-popup', 'a', { parentTabId: 'a2' }) };
  const preview = await f.browser.previewScopedCleanup({ kind: 'conversation', conversationId: 'a' }, f.options);
  const result = await f.browser.executeScopedCleanup({
    scope: preview.scope, previewId: preview.previewId, selectedTabIds: ['a1', 'a2'] }, f.options);
  assert.equal(result.closed, 2);
  assert.deepEqual(result.closedTabIds, ['a1', 'a2']);
  assert.deepEqual(result.lateTabIds, ['late-popup']);
  assert.deepEqual(result.remainingTabIds, ['late-popup']);
  assert.deepEqual(f.driver.tabs.map(t => t.tabId).sort(), ['late-popup', 'other', 'personal']);
});

test('stale document, transfer, and active-work races reject before any close', async () => {
  for (const change of [
    f => { f.driver.tabs[0].documentId = 'a1:2'; },
    f => { f.driver.tabs[0].owner = null; },
    (f, active) => { active.add('a-run'); },
  ]) {
    const f = fixture([tab('a1', 'a'), tab('other', 'b')]), active = new Set();
    const options = { ...f.options, activeRunIds: () => active };
    const preview = await f.browser.previewScopedCleanup({ kind: 'conversation', conversationId: 'a' }, options);
    change(f, active);
    await assert.rejects(f.browser.executeScopedCleanup({
      scope: preview.scope, previewId: preview.previewId, selectedTabIds: ['a1'] }, options),
    { code: 'BROWSER_CLEANUP_STALE_PREVIEW' });
    assert.equal(f.driver.effects.length, 0);
  }
});

test('partial failure preserves failed pages, reports exact remaining count and never retries', async () => {
  const f = fixture([tab('a1', 'a'), tab('a2', 'a'), tab('other', 'b')]);
  f.driver.fail.add('a2');
  const preview = await f.browser.previewScopedCleanup({ kind: 'task', conversationId: 'a',
    taskId: 'a', nodeId: 'research' }, f.options);
  const result = await f.browser.executeScopedCleanup({
    scope: preview.scope, previewId: preview.previewId, selectedTabIds: ['a1', 'a2'] }, f.options);
  assert.deepEqual(result.closedTabIds, ['a1']);
  assert.equal(result.failedTabs.length, 1); assert.equal(result.failedTabs[0].tabId, 'a2');
  assert.deepEqual(result.remainingTabIds, ['a2']); assert.deepEqual(f.driver.effects, ['a1']);
  assert.ok(f.driver.tabs.some(t => t.tabId === 'other'));
});

test('the real browser router forwards inspection and a guarded close to the contained driver', async () => {
  const driver = new FixtureDriver([tab('page', 'a'), tab('coordination', 'b')]);
  const browser = new BrowserWorkspace({ driver: new BrowserRouter({ independent: driver }) });
  const options = { conversations, activeRunIds: () => new Set() };
  const preview = await browser.previewScopedCleanup({ kind:'conversation', conversationId:'a' }, options);
  assert.equal(preview.eligible, 1, 'The router must not silently mark all native tabs as unknown.');
  const receipt = await browser.executeScopedCleanup({
    scope: preview.scope, previewId: preview.previewId, selectedTabIds:['page'] }, options);
  assert.deepEqual(receipt.closedTabIds, ['page']);
  assert.equal(driver.tabs.length, 1);
  assert.equal(driver.tabs[0].tabId, 'coordination');
});

test('task resuming after the last DOM probe is blocked by the native last-moment guard', async () => {
  const f = fixture([tab('draft', 'a')]), active = new Set();
  const options = { ...f.options, activeRunIds: () => active };
  const preview = await f.browser.previewScopedCleanup({ kind:'conversation',conversationId:'a' }, options);
  const original = f.driver.perform.bind(f.driver);
  f.driver.perform = (args,context) => {
    active.add('a-run'); // Simulated engine admission while the browser close is pending.
    return original(args,context);
  };
  const receipt = await f.browser.executeScopedCleanup({
    scope:preview.scope, previewId:preview.previewId, selectedTabIds:['draft'] }, options);
  assert.equal(receipt.closed,0);
  assert.deepEqual(receipt.remainingTabIds,['draft']);
  assert.equal(receipt.failedTabs.length,1);
  assert.match(receipt.failedTabs[0].reason,/resumed/);
  assert.deepEqual(f.driver.effects,[]);
});

test('page becoming person-owned mid-batch is retained, never closed', async () => {
  const f = fixture([tab('first', 'a'), tab('second', 'a')]);
  const original = f.driver.perform.bind(f.driver);
  f.driver.perform = async (args, context) => {
    const result = await original(args, context);
    if (args.tabId === 'first') f.driver.tabs.find(item => item.tabId === 'second').userPinned = true;
    return result;
  };
  const preview = await f.browser.previewScopedCleanup({ kind:'conversation', conversationId:'a' }, f.options);
  const receipt = await f.browser.executeScopedCleanup({
    scope:preview.scope, previewId:preview.previewId, selectedTabIds:['first','second'] }, f.options);
  assert.deepEqual(receipt.closedTabIds,['first']);
  assert.deepEqual(receipt.remainingTabIds,['second']);
  assert.equal(receipt.failedTabs.length,1);
  assert.match(receipt.failedTabs[0].reason, /person|interacted/i);
});

test('unhealthy browser persistence rejects cleanup even when a read-only page looks finished', async () => {
  const f = fixture([tab('draft', 'a')]);
  const status = f.driver.status.bind(f.driver);
  f.driver.status = () => ({...status(), persistence:{healthy:false}});
  const preview = await f.browser.previewScopedCleanup({kind:'conversation',conversationId:'a'},f.options);
  assert.equal(preview.eligible,0);
  assert.match(preview.rows[0].reason,/storage/);
  assert.deepEqual(f.driver.effects,[]);
});

test('reloaded saved ownership still matches the same exact conversation without attributing shared grant tabs', async () => {
  const saved = JSON.parse(JSON.stringify([tab('saved', 'a'), tab('unassigned', null,
    { owner: { taskId: 'connector-grant', nodeId: 'direct', runId: 'shared' } })]));
  const f = fixture(saved);
  const p = await f.browser.previewScopedCleanup({ kind: 'conversation', conversationId: 'a' }, f.options);
  assert.equal(p.total, 1); assert.equal(p.rows[0].tabId, 'saved');
});

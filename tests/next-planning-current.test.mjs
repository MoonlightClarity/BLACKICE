import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDOM } from './fixture-planning-dom.mjs';
import { createPlanningWorkspace } from '../public/next/workspaces/planning-current.mjs';

const waitFor = async (read, message = 'Current Planning did not settle') => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise(resolve => setTimeout(resolve, 4));
  }
  throw Error(message);
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const copy = value => structuredClone(value);
const conversations = () => [
  { id: 'conversation-a', rootId: 'conversation-a', conversationId: 'conversation-a', latestRunId: 'run-a', runId: 'run-a', title: 'Current Directory task', state: 'active', status: 'completed', settled: true, updatedAt: '2026-11-13T12:00:00Z' },
  { id: 'conversation-b', rootId: 'conversation-b', conversationId: 'conversation-b', latestRunId: 'run-b', runId: 'run-b', title: 'Second Directory task', state: 'active', status: 'running', settled: false, updatedAt: '2026-11-13T11:59:00Z' },
  { id: 'conversation-old', rootId: 'conversation-old', conversationId: 'conversation-old', latestRunId: 'run-old', runId: 'run-old', title: 'Archived task', state: 'archived', status: 'failed', settled: true, updatedAt: '2026-11-12T12:00:00Z' }
];
function directory(runId, conversationId, name) {
  const moduleFile = 'runs/' + runId + '/modules/1/1.1/module.json';
  const resultFile = 'runs/' + runId + '/modules/1/1.1/result.json';
  const files = new Map([
    ['conversation/context/turns.json', [{ id: runId + '-t0001', runId, label: 'work', module: 'modules/1/1.1', at: '2026-11-13T12:00:00Z', sourceFiles: [resultFile], excerpt: name + ' model phase' }]],
    [moduleFile, { id: '1.1', objective: name + ' work item', depth: 2, status: 'worked_unverified', doneWhen: name + ' observable check', dependsOn: [], requirementIds: [] }],
    [resultFile, { finding: name + ' finding', candidate_answer: name + ' observed output', uncertainty: '', workStatus: 'complete', nextAction: '', status: 'worked_unverified', verified: false, hostEvidence: [] }]
  ]);
  return {
    listing: { conversationId, summary: { currentRun: runId, request: name + ' request', directoryStatus: 'completed', outcomeAssessment: { decision: 'respond', summary: name + ' review', reason: name + ' review' }, plannedWorkItems: 1, planningCalls: 1, modelCalls: 3, userSummary: name + ' notes', pinnedConstraints: [] }, files: [...files].map(([file, value]) => ({ file, kind: file.endsWith('module.json') ? 'module' : file.endsWith('result.json') ? 'module-result' : 'turn-index', bytes: JSON.stringify(value).length })) },
    files
  };
}
async function fixture(t, { hook, rows = conversations(), activate = true } = {}) {
  const dom = planningDOM(t);
  const prototype = Object.getPrototypeOf(dom.mount), type = Object.getOwnPropertyDescriptor(prototype, 'type');
  Object.defineProperty(prototype, 'type', { get: type.get, set(value) { this.setAttribute('type', value); } });
  const scopes = new Map([
    ['run-a', directory('run-a', 'conversation-a', 'Alpha')],
    ['run-b', directory('run-b', 'conversation-b', 'Beta')],
    ['run-old', directory('run-old', 'conversation-old', 'Archived')]
  ]);
  const goals = new Map(rows.map(row => [row.rootId, { id: 'goal-' + row.rootId, revision: 7, status: 'active', objective: row.rootId === 'conversation-a' ? 'Finish the Alpha objective' : row.rootId === 'conversation-b' ? 'Finish the Beta objective' : 'Archived objective', turns: 2, maxTurns: null, running: row.status === 'running' && row.settled !== true }]));
  const calls = [], events = new Set(), navigation = [], historical = [], errors = [];
  let currentHook = hook, lazyLoads = 0;
  const respond = call => {
    const url = new URL(call.route, 'http://fixture');
    if (url.pathname === '/api/conversations') return { conversations: copy(rows) };
    const goalMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/goal$/);
    if (goalMatch) return { goal: copy(goals.get(decodeURIComponent(goalMatch[1])) || null) };
    const runId = url.searchParams.get('runId');
    const scope = scopes.get(runId);
    assert.ok(scope, 'Context reads must use an observed latest run: ' + call.route);
    if (url.pathname === '/api/shadowdancer/context/conversations') return { currentConversationId: scope.listing.conversationId, conversations: rows.map(row => ({ conversationId: row.rootId, runId: row.latestRunId, title: row.title, state: row.state, current: row.latestRunId === runId })) };
    if (url.pathname === '/api/shadowdancer/context') return copy(scope.listing);
    if (url.pathname === '/api/shadowdancer/context/file') {
      const file = url.searchParams.get('file');
      assert.ok(scope.files.has(file), 'Only listed context files are read: ' + file);
      return { file, value: copy(scope.files.get(file)), hash: 'fixture-hash', editableFields: [], managedEditId: null };
    }
    throw Error('Unexpected fixture route: ' + call.route);
  };
  const api = async (route, method = 'GET', body, options) => {
    const call = { route, method, body: copy(body), signal: options?.signal };
    calls.push(call);
    assert.equal(method, 'GET', 'Viewing Planning must not schedule or mutate work');
    const value = currentHook?.(call, { scopes, goals, rows, respond });
    return value === undefined ? respond(call) : await value;
  };
  const workspace = createPlanningWorkspace({
    mount: dom.mount, api,
    events: { subscribe(callback) { events.add(callback); return () => events.delete(callback); } },
    notify: (...args) => errors.push(args), onNavigate: (...args) => navigation.push(args), getStatus: () => ({ connected: true }),
    loadHistoryWorkspace: async () => {
      lazyLoads++;
      return ({ mount }) => {
        const heading = mount.ownerDocument.createElement('h2'); heading.textContent = 'Historical graph fixture'; mount.append(heading);
        return {
          enter() { historical.push(['enter']); }, leave() { historical.push(['leave']); },
          activate() { historical.push(['enter']); }, deactivate() { historical.push(['leave']); },
          openConversationId(id) { historical.push(['conversation', id]); },
          openRequestId(id, options) { historical.push(['request', id, options]); },
          updateStatus() {}, destroy() { historical.push(['destroy']); }
        };
      };
    }
  });
  t.after(() => workspace.destroy());
  if (activate) {
    workspace.activate();
    await waitFor(() => calls.some(call => call.route === '/api/conversations?state=all'));
  }
  return { ...dom, workspace, calls, scopes, goals, rows, events, navigation, historical, errors,
    hook(fn) { currentHook = fn; }, lazyLoads: () => lazyLoads,
    async open(id) { workspace.openConversationId(id); await waitFor(() => calls.some(call => call.route.includes('/' + id + '/goal'))); },
    async settleAlpha() { workspace.openConversationId('conversation-a'); await waitFor(() => dom.$('.pc-work-items')?.textContent.includes('Alpha work item')); }
  };
}

test('current Planning presents the actual Directory work and goal without creating a graph request', async t => {
  const f = await fixture(t); await f.settleAlpha();
  assert.ok(f.$('.planning-current'));
  assert.match(f.$('.pc-goal').textContent, /Finish the Alpha objective/);
  assert.match(f.$('.pc-work-items').textContent, /Alpha work item/);
  assert.match(f.$('.pc-work-items').textContent, /Reported complete/i);
  assert.match(f.$('.pc-model-phases').textContent, /Execute work/i);
  assert.match(f.$('.pc-outcome').textContent, /Alpha review/);
  assert.doesNotMatch(f.$('.pc-detail').textContent, /0 graph requests|Create planning request/);
  assert.equal(f.calls.some(call => call.route.includes('/api/planning-browser')), false);
  assert.equal(f.lazyLoads(), 0);
  assert.ok(f.calls.some(call => call.route === '/api/conversations/conversation-a/goal'));
  assert.ok(f.calls.some(call => call.route === '/api/shadowdancer/context?runId=run-a'));
  assert.equal(f.calls.some(call => call.route.includes('/run-a/goal')), false, 'The goal is owned by the canonical conversation, not a run');
});

test('historical plans are loaded only on request and preserve exact request deep links', async t => {
  const f = await fixture(t); await f.settleAlpha();
  assert.equal(f.lazyLoads(), 0);
  await f.click('[data-planning-view="history"]');
  await waitFor(() => f.lazyLoads() === 1 && f.historical.some(row => row[0] === 'enter'));
  f.workspace.openRequestId('saved-request', { nodeId: 'saved-module' });
  await waitFor(() => f.historical.some(row => row[0] === 'request'));
  assert.deepEqual(f.historical.filter(row => row[0] === 'request').at(-1), ['request', 'saved-request', { nodeId: 'saved-module' }]);
  await f.click('[data-planning-view="current"]');
  await waitFor(() => f.$('.pc-work-items')?.textContent.includes('Alpha work item'));
  assert.equal(f.lazyLoads(), 1, 'Returning to history reuses its workspace');
  assert.equal(f.calls.every(call => call.method === 'GET'), true);
});

test('a late context result cannot overwrite the newly selected conversation', async t => {
  const f = await fixture(t); await f.settleAlpha();
  const hold = deferred(); t.after(() => hold.resolve(copy(f.scopes.get('run-b').listing)));
  f.hook(call => call.route === '/api/shadowdancer/context?runId=run-b' ? hold.promise : undefined);
  f.workspace.openConversationId('conversation-b');
  await waitFor(() => f.calls.some(call => call.route === '/api/shadowdancer/context?runId=run-b'));
  f.workspace.openConversationId('conversation-a');
  await waitFor(() => f.$('.pc-goal')?.textContent.includes('Finish the Alpha objective'));
  hold.resolve(copy(f.scopes.get('run-b').listing));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(f.$('.pc-goal').textContent, /Finish the Alpha objective/);
  assert.match(f.$('.pc-work-items').textContent, /Alpha work item/);
  assert.doesNotMatch(f.$('.pc-detail').textContent, /Beta work item|Finish the Beta objective/);
});

test('a stale context failure is ignored after switching to another conversation', async t => {
  const f = await fixture(t); await f.settleAlpha();
  const hold = deferred(); t.after(() => hold.resolve(copy(f.scopes.get('run-b').listing)));
  f.hook(call => call.route === '/api/shadowdancer/context?runId=run-b' ? hold.promise : undefined);
  f.workspace.openConversationId('conversation-b');
  await waitFor(() => f.calls.some(call => call.route === '/api/shadowdancer/context?runId=run-b'));
  f.workspace.openConversationId('conversation-a');
  await waitFor(() => f.$('.pc-work-items')?.textContent.includes('Alpha work item'));
  hold.reject(Error('Stale Beta read failed'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.doesNotMatch(f.$('.pc-detail').textContent + (f.$('.pc-notice')?.textContent || ''), /Stale Beta read failed/);
  assert.match(f.$('.pc-goal').textContent, /Finish the Alpha objective/);
});

test('a current context failure preserves the goal and exposes a recoverable read error', async t => {
  const f = await fixture(t, { hook: call => call.route === '/api/shadowdancer/context?runId=run-a' ? Promise.reject(Error('Directory fixture unavailable')) : undefined });
  await f.open('conversation-a');
  await waitFor(() => (f.$('.pc-detail')?.textContent + (f.$('.pc-notice')?.textContent || '')).includes('Directory fixture unavailable'));
  assert.match(f.$('.pc-goal').textContent, /Finish the Alpha objective/);
  assert.equal(f.calls.some(call => call.route.includes('/api/planning-browser')), false, 'Read failure must not fall back to creating legacy planning');
  f.hook(undefined);
  await f.workspace.refresh();
  await waitFor(() => f.$('.pc-work-items')?.textContent.includes('Alpha work item'));
  assert.doesNotMatch(f.$('.pc-notice')?.textContent || '', /Directory fixture unavailable/);
});

test('Running now filters by live execution rather than saved or failed work', async t => {
  const f = await fixture(t); await f.settleAlpha();
  const view = f.$('#pc-conversation-view'); view.value = 'running'; await view.dispatch('change');
  await waitFor(() => f.$('[data-conversation-id="conversation-b"]'));
  assert.equal(f.$('[data-conversation-id="conversation-a"]'), null);
  assert.equal(f.$('[data-conversation-id="conversation-old"]'), null);
  view.value = 'archived'; await view.dispatch('change');
  await waitFor(() => f.$('[data-conversation-id="conversation-old"]'));
  assert.equal(f.$('[data-conversation-id="conversation-b"]'), null);
});

test('absent Directory records keep a saved goal available without starting planning', async t => {
  const f = await fixture(t, { hook: call => call.route === '/api/shadowdancer/context?runId=run-a' ? { conversationId: 'conversation-a', summary: null, files: [] } : undefined });
  await f.open('conversation-a');
  await waitFor(() => f.$('.pc-goal')?.textContent.includes('Finish the Alpha objective'));
  assert.doesNotMatch(f.$('.pc-detail').textContent, /Create planning request|0 graph requests/);
  assert.equal(f.lazyLoads(), 0);
  assert.equal(f.calls.every(call => call.method === 'GET'), true);
});

test('deactivation and destruction ignore pending context reads and release subscriptions', async t => {
  const f = await fixture(t); await f.settleAlpha();
  const hold = deferred(); t.after(() => hold.resolve(copy(f.scopes.get('run-b').listing)));
  f.hook(call => call.route === '/api/shadowdancer/context?runId=run-b' ? hold.promise : undefined);
  f.workspace.openConversationId('conversation-b');
  await waitFor(() => f.calls.some(call => call.route === '/api/shadowdancer/context?runId=run-b'));
  f.workspace.deactivate();
  const before = f.mount.textContent;
  hold.resolve(copy(f.scopes.get('run-b').listing));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.mount.textContent, before, 'Leaving the workspace prevents stale background paints');
  f.workspace.destroy();
  assert.equal(f.events.size, 0);
});

test('work-item inspection opens its exact saved record and ordinary context reopening stays on Overview', async t => {
  const f = await fixture(t); await f.settleAlpha();
  const openWork = f.$('.pc-work-body button');
  assert.ok(openWork);
  await f.click(openWork);
  const moduleFile = 'runs/run-a/modules/1/1.1/module.json';
  await waitFor(() => f.$('.next-directory-file-label')?.textContent === moduleFile);
  assert.equal(f.$('.next-directory-inspector').open, true);
  assert.match(f.$('.next-directory-contents').value, /Alpha work item/);
  assert.equal(f.$('[data-context-tab="files"]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.$('.next-directory-conversation').value, 'run-a');
  await f.click('.next-directory-close');
  const openContext = f.$('.pc-detail-header').querySelectorAll('button').find(button => button.textContent === 'Context & evidence');
  await f.click(openContext);
  await waitFor(() => f.$('.next-directory-file-label')?.textContent === 'Conversation context');
  assert.equal(f.$('[data-context-tab="overview"]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.calls.every(call => call.method === 'GET'), true);
});

test('an authoritative goal run replaces a stale catalog run before showing the current outcome', async t => {
  const f = await fixture(t); await f.settleAlpha();
  const newer = directory('run-a-new', 'conversation-a', 'New run');
  newer.listing.summary.directoryStatus = 'running';
  newer.listing.summary.outcomeAssessment = null;
  f.scopes.set('run-a-new', newer);
  f.goals.set('conversation-a', { ...f.goals.get('conversation-a'), running: true, runStatus: 'running', currentRunId: 'run-a-new' });
  const hold = deferred(); t.after(() => hold.resolve(copy(newer.listing)));
  f.hook(call => call.route === '/api/shadowdancer/context?runId=run-a-new' ? hold.promise : undefined);
  const updating = f.workspace.refresh();
  await waitFor(() => f.calls.some(call => call.route === '/api/shadowdancer/context?runId=run-a-new'));
  assert.doesNotMatch(f.$('.pc-outcome')?.textContent || '', /Alpha review/, 'The old completed review is cleared while the actual active run loads');
  hold.resolve(copy(newer.listing)); await updating;
  await waitFor(() => f.$('.pc-work-items')?.textContent.includes('New run work item'));
  assert.match(f.$('.pc-detail-header').textContent, /Running/);
  assert.doesNotMatch(f.$('.pc-outcome').textContent, /Alpha review/);
  assert.doesNotMatch(f.$('.pc-work-items').textContent, /Alpha work item/);
  assert.ok(f.calls.some(call => call.route.includes('runId=run-a-new') && call.route.includes('%2Fmodule.json')));
});

test('a failed phase index stays visible when the work-item records load successfully', async t => {
  const f = await fixture(t, { hook: call => {
    const url = new URL(call.route, 'http://fixture');
    if (url.pathname === '/api/shadowdancer/context/file' && url.searchParams.get('runId') === 'run-a' && url.searchParams.get('file') === 'conversation/context/turns.json')
      return Promise.reject(Error('Model phase index unavailable'));
  } });
  await f.settleAlpha();
  assert.match(f.$('.pc-work-items').textContent, /Alpha work item/);
  assert.match(f.$('.pc-detail').textContent, /Model phase index unavailable/);
  assert.equal(f.calls.every(call => call.method === 'GET'), true);
});

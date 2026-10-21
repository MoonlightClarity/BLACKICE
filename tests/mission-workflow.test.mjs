import test from 'node:test';
import assert from 'node:assert/strict';
import { initMissionUI } from '../public/mission-ui.mjs';
import { createApiClient } from '../public/api-client.mjs';
import { conversationMenuActions, conversationMenuPosition, initConversationMenu } from '../public/conversation-menu.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
function missionFixture(t, saved = { modelPreferenceVersion: 2, cwd: 'C:\\fixture', conversationDrafts: { new: { task: 'Keep this for later', attachmentIds: [], model: 'cloud::chosen' } } }, sharedStorage) {
  const old = Object.fromEntries(['document', 'window', 'localStorage'].map(name => [name, { present: Object.hasOwn(globalThis, name), value: globalThis[name] }]));
  const elements = new Map(), cleanups = [], storage = sharedStorage || new Map([['relay.mission.draft', JSON.stringify(saved)]]);
  const element = selector => {
    if (elements.has(selector)) return elements.get(selector);
    const listeners = new Map(), local = new Map(), attributes = new Map(), classes = new Set(), node = {
      id: selector.startsWith('#') ? selector.slice(1) : '', innerHTML: '', textContent: '', title: '', value: '', hidden: false, disabled: false, readOnly: false, open: false,
      tagName: selector === '#mission-task' ? 'TEXTAREA' : 'DIV', dataset: {}, style: {}, children: [], scrollHeight: 54, scrollTop: 0, clientHeight: 54, isConnected: true,
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle(value, force) { const next = force === undefined ? !classes.has(value) : force; if (next) classes.add(value); else classes.delete(value); return next; } },
      setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key), hasAttribute: key => attributes.has(key), removeAttribute: key => attributes.delete(key), focus() { globalThis.document.activeElement = this; }, select() {},
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }, insertAdjacentHTML() {}, scrollTo() {}, getBoundingClientRect: () => ({ left: 20, top: 80, bottom: 114, width: 174, height: 88 }),
      append(...children) { for (const child of children) { child.remove(); child.parent = this; child.isConnected = true; this.children.push(child); } },
      insertBefore(child, reference) { child.remove(); child.parent = this; const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, child); },
      querySelector(query) { if (query.startsWith('#') || selector === '#mount' || selector === '#mission-attachments') return element(query); if (!local.has(query)) local.set(query, element(`${selector} ${query}`)); return local.get(query); }, querySelectorAll(query) { return query === '[role="menuitem"]' ? this.children.filter(child => child.getAttribute('role') === 'menuitem') : []; }, contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false; },
      closest(query) { if (query === '[data-mission-action]' && this.dataset.missionAction || query === '[data-plan-action]' && this.dataset.planAction || query === '[data-plan-node]' && this.dataset.planNode || query === '[data-conversation-id]' && this.dataset.conversationId || query === '[data-chat-action]' && this.dataset.chatAction || query === '[data-chat-more]' && this.dataset.chatMore) return this; if (query === 'form') return element('#mission-form'); return this.parent?.closest(query) || null; },
      addEventListener(type, listener) { const entries = listeners.get(type) || []; entries.push(listener); listeners.set(type, entries); },
      removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter(entry => entry !== listener)); },
      dispatch(type, event) { return Promise.all((listeners.get(type) || []).map(listener => listener(event))); },
    };
    let markup = '';
    Object.defineProperty(node, 'innerHTML', { get: () => markup, set(value) { markup = value; for (const child of node.children) child.isConnected = false; node.children = []; local.clear(); if (node.className === 'conversation-row-menu') for (const match of value.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) { const button = element(`menu-item-${elements.size}`); button.tagName = 'BUTTON'; button.dataset.chatAction = match[1].match(/data-chat-action="([^"]+)"/)[1]; button.disabled = / disabled/.test(match[1]); button.textContent = match[2]; button.setAttribute('role', 'menuitem'); node.append(button); } } });
    elements.set(selector, node); return node;
  };
  const mount = element('#mount'), form = element('#mission-form'); let submissions = 0;
  form.requestSubmit = () => { submissions++; form.lastSubmission = mount.dispatch('submit', { target: form, preventDefault() {} }); };
  element('#mission-capture-button').dataset.missionAction = 'capture';
  element('#conversation-stop').dataset.missionAction = 'stop';
  element('#conversation-sidebar-retry').dataset.missionAction = 'retry-chats';
  const documentEvents = element('#document-events'), windowEvents = element('#window-events');
  globalThis.document = { hasFocus: () => true, getElementById: () => null, createElement: () => element(`created-${elements.size}`), head: { append() {} }, activeElement: null, addEventListener: documentEvents.addEventListener, removeEventListener: documentEvents.removeEventListener };
  globalThis.window = { getSelection: () => null, innerWidth: 1000, innerHeight: 700, addEventListener: windowEvents.addEventListener, removeEventListener: windowEvents.removeEventListener };
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  t.after(() => { for (const cleanup of cleanups) cleanup(); for (const [name, previous] of Object.entries(old)) if (previous.present) globalThis[name] = previous.value; else delete globalThis[name]; });
  return { mount, form, element, storage, documentEvents, windowEvents, cleanup: callback => cleanups.push(callback), menu: () => mount.children.find(child => child.className === 'conversation-row-menu'), submissions: () => submissions };
}

const statusSnapshot = (runs = []) => ({ statusLoaded: true, status: { cwd: 'C:\\fixture', connected: true, authenticated: true, defaultModel: 'cloud::default', defaultModelAvailable: true, models: [{ id: 'cloud::default', available: true }, { id: 'cloud::chosen', available: true }, { id: 'cloud::other', available: true }] }, runs, currentRun: runs[0] || null, desktop: {}, streamState: 'live' });
const fixtureRun = (id, status = 'running') => ({ id, taskId: id, status, settled: status === 'completed', createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', cwd: 'C:\\fixture', input: `Task ${id}`, workflow: { nodes: [{ id: 'agent', type: 'agent', name: 'Agent', model: 'cloud::default' }] }, nodes: { agent: { status, threadId: `thread-${id}`, turnId: `turn-${id}`, resolvedModel: 'cloud::default' } }, events: [], attachmentIds: [] });
const savedDrafts = (task = 'Queue this next', model) => ({ modelPreferenceVersion: 2, cwd: 'C:\\fixture', conversationDrafts: { new: { task, attachmentIds: [], ...(model ? { model } : {}) } } });
function mountMission(f, snapshot, callbacks = {}) {
  const starts = [], queued = [], captures = [], opened = [], stopped = [], inbox = [], mutations = [], connections = [], timeLimits = [], errors = [];
  const ui = initMissionUI({ mount: f.mount, getSnapshot: () => snapshot,
    onStart: async config => { starts.push(config); return callbacks.start?.(config); },
    onQueue: async config => { queued.push(config); return callbacks.queue ? callbacks.queue(config) : { id: 'queued-item', status: 'queued' }; },
    onCapture: async config => { captures.push(config); return callbacks.capture?.(config); },
    onContinue: async config => { mutations.push({ continue: config }); return callbacks.continue?.(config); },
    onOpenRun: async id => { opened.push(id); await callbacks.open?.(id); const run = snapshot.runs.find(run => run.id === id); if (run) snapshot.currentRun = run; },
    onStop: async (id, options) => { stopped.push(id); return callbacks.stop?.(id, options); },
    onInbox: value => inbox.push(value), pickFolder: callbacks.pickFolder, onOpenBrowserOS: callbacks.openBrowserOS, onObserve: callbacks.observe, onConnections: () => connections.push(true), onChatGPTBridge: callbacks.chatgptBridge, onSchedule: callbacks.schedule, onSwarm: callbacks.swarm, onRunLimits: () => timeLimits.push(true), onPrompts: callbacks.prompts, onSavePrompt: callbacks.savePrompt, onRepeatTask: callbacks.repeatTask, onOpenMethods: callbacks.openMethods, onOpenMethod: callbacks.openMethod, onSaveTaskMethod: callbacks.saveTaskMethod,
    api: async (url, method, body) => { if (method) mutations.push({ url, body }); if (callbacks.api) { const value = await callbacks.api(url, method, body); if (value !== undefined) return value; } return url === '/api/attachments' ? [] : url.startsWith('/api/conversations/') ? { runs: snapshot.runs.filter(run => url.endsWith(run.id)) } : { conversations: [] }; },
    escape: value => String(value ?? ''), icon: () => '', toast: (message, error) => errors.push({ message, error }),
  });
  return { ui, starts, queued, captures, opened, stopped, inbox, mutations, connections, timeLimits, errors,
    async submit() { ui.submitFocused(); await f.form.lastSubmission; await turn(); },
    async text(value) { f.element('#mission-task').value = value; await f.mount.dispatch('input', { target: f.element('#mission-task') }); },
    async model(value) { f.element('#mission-model').value = value; await f.mount.dispatch('change', { target: f.element('#mission-model') }); },
    async effort(value) { f.element('#mission-effort').value = value; await f.mount.dispatch('change', { target: f.element('#mission-effort') }); },
    async planningMode(value) { f.element('#mission-planning-mode').value = value; await f.mount.dispatch('change', { target: f.element('#mission-planning-mode') }); },
    async planAction(action, data = {}) { const button = f.element(`plan-action-${action}`); button.dataset = { planAction: action, ...data }; f.element('#mission-plan').append(button); await f.element('#mission-plan').dispatch('click', menuEvent(button)); },
    async action(action, data = {}) { const button = f.element(`action-${action}`); button.dataset = { missionAction: action, ...data }; await f.mount.dispatch('click', { target: button }); },
    persisted() { return JSON.parse(f.storage.get('relay.mission.draft')); },
  };
}

const menuEvent = (target, extra = {}) => ({ target, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });

const plannedRun = (id, status = 'running') => {
  const run = fixtureRun(id, status);
  run.planDetail = 'balanced'; run.nodes.agent.planning = { status: 'recorded', schemaVersion: 1, detail: 'balanced' };
  run.taskState = { taskId: id, revision: 1, goal: `Deliver ${id}`, planVersion: 1, plan: { origin: 'agent', layout: 'sequence', detail: 'balanced', taskType: 'general', focusStepId: 'build', method: { id: 'software-change', name: 'Software change', revision: 2 } }, steps: [
    { id: 'deliver', parentId: null, kind: 'sequence', status: 'active', title: 'Deliver a checked change', dependsOn: [] },
    { id: 'inspect', parentId: 'deliver', kind: 'action', status: 'done', title: 'Inspect the current behavior', doneWhen: 'The cause is understood', evidence: 'Reproduced the original issue', dependsOn: [] },
    { id: 'build', parentId: 'deliver', kind: 'action', status: 'active', title: 'Implement the change', doneWhen: 'The revised behavior works', dependsOn: ['inspect'] },
    { id: 'verify', parentId: 'deliver', kind: 'action', status: 'pending', title: 'Verify the result', doneWhen: 'The meaningful checks pass', dependsOn: ['build'] },
  ], progress: { total: 3, done: 1, skipped: 0, complete: false, current: { id: 'build', title: 'Implement the change' }, active: ['build'], eligible: ['inspect', 'build', 'verify'], ready: ['inspect', 'build'], unresolvedBranches: 0 }, artifacts: [] };
  return run;
};

async function openRowMenu(f, id, runId = id, keyboard) {
  const row = f.element(`row-${id}`); row.dataset = { conversationId: id, id: runId, missionAction: 'open-run' }; f.mount.append(row);
  const event = menuEvent(row, keyboard ? { key: keyboard, shiftKey: keyboard === 'F10' } : { clientX: 910, clientY: 675 });
  await f.mount.dispatch(keyboard ? 'keydown' : 'contextmenu', event); return { row, event, menu: f.menu() };
}


function renameControls(f) {
  const form = f.element('#conversation-rename'), input = f.element('#conversation-name');
  input.tagName = 'INPUT'; form.append(input, f.element('#conversation-rename-save'), f.element('#conversation-rename-cancel'));
  return { form, input, submit: () => f.mount.dispatch('submit', menuEvent(form)) };
}

test('renaming another sidebar chat from New chat persists its name without opening it or replacing the draft', async t => {
  const run = fixtureRun('rename-other', 'completed'), f = missionFixture(t, savedDrafts('My unfinished new question')), snapshot = statusSnapshot([run]); let title = 'Original chat';
  const h = mountMission(f, snapshot, { api: async (url, method, body) => {
    if (method === 'POST' && url.endsWith('/rename')) { title = body.title; return { title }; }
    if (url.includes('/api/conversations?state=')) return { conversations: url.endsWith('active') ? [{ taskId: run.id, runId: run.id, title, state: 'active' }] : [] };
  } }); await turn();
  const before = h.ui.getSelection(), draft = h.ui.getDraft(), opened = [...h.opened], controls = renameControls(f), { menu } = await openRowMenu(f, run.id);
  await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'rename')));
  assert.equal(controls.form.hidden, false); assert.equal(controls.input.value, 'Original chat'); assert.equal(document.activeElement, controls.input);
  h.ui.update(); assert.equal(controls.form.hidden, false, 'background rendering keeps the row editor open in New chat');
  controls.input.value = '  Product ideas  '; await controls.submit();
  assert.equal(title, 'Product ideas'); assert.equal(controls.form.hidden, true); assert.match(f.element('#conversation-list').innerHTML, /Product ideas/);
  assert.deepEqual(h.ui.getSelection(), before); assert.deepEqual(h.ui.getDraft(), draft); assert.deepEqual(h.opened, opened); assert.equal(h.starts.length, 0);
  assert.deepEqual(h.mutations, [{ url: '/api/conversations/rename-other/rename', body: { title: 'Product ideas' } }]);
});

test('the title opens Rename, Escape returns focus, and a failed save keeps its name for a coalesced retry', async t => {
  const run = fixtureRun('rename-header', 'completed'), f = missionFixture(t, savedDrafts('')); let attempts = 0, release;
  const h = mountMission(f, statusSnapshot([run]), { api: async (url, method) => {
    if (method === 'POST' && url.endsWith('/rename')) { attempts++; if (attempts === 1) return new Promise((resolve, reject) => { release = () => reject(new Error('Name could not be saved.')); }); return { title: 'A useful name' }; }
  } }); await turn(); await h.ui.openConversation(run.id); await h.text('Reply stays here');
  const controls = renameControls(f), titleButton = f.element('#conversation-rename-title'); titleButton.dataset.missionAction = 'rename-conversation';
  await f.mount.dispatch('click', menuEvent(titleButton)); assert.equal(controls.form.hidden, false); assert.equal(document.activeElement, controls.input);
  await f.mount.dispatch('keydown', menuEvent(controls.input, { key: 'Escape' })); assert.equal(controls.form.hidden, true); assert.equal(document.activeElement, titleButton);
  await f.mount.dispatch('click', menuEvent(titleButton)); controls.input.value = 'A useful name'; const pending = controls.submit(); await turn(); await controls.submit();
  assert.equal(attempts, 1); assert.equal(controls.input.readOnly, true); assert.equal(f.element('#conversation-rename-save').disabled, true); release(); await pending;
  assert.equal(controls.form.hidden, false); assert.equal(controls.input.readOnly, false); assert.equal(controls.input.value, 'A useful name'); assert.equal(f.element('#conversation-rename-error').hidden, false); assert.match(f.element('#conversation-rename-error').textContent, /could not be saved/);
  await controls.submit(); assert.equal(attempts, 2); assert.equal(controls.form.hidden, true); assert.equal(h.ui.getDraft().task, 'Reply stays here'); assert.equal(h.starts.length, 0);
});

test('a pending rename keeps its original target and does not reclaim focus after switching chats', async t => {
  const a = fixtureRun('rename-origin', 'completed'), b = fixtureRun('rename-next', 'completed'), f = missionFixture(t, savedDrafts('')); let release;
  const h = mountMission(f, statusSnapshot([a, b]), { api: async (url, method) => method === 'POST' && url.endsWith('/rename') ? new Promise(resolve => { release = resolve; }) : undefined }); await turn(); await h.ui.openConversation(a.id);
  const controls = renameControls(f); await h.action('rename-conversation'); controls.input.value = 'Origin renamed'; const pending = controls.submit(); await turn();
  await h.ui.openConversation(b.id); await h.text('The next chat draft'); f.element('#mission-task').focus(); const selection = h.ui.getSelection(); release({ title: 'Origin renamed' }); await pending;
  assert.deepEqual(h.mutations, [{ url: '/api/conversations/rename-origin/rename', body: { title: 'Origin renamed' } }]); assert.deepEqual(h.ui.getSelection(), selection); assert.equal(h.ui.getDraft().task, 'The next chat draft'); assert.equal(document.activeElement, f.element('#mission-task')); assert.equal(controls.form.hidden, true);
});

test('a chat in Trash keeps its header title visible without offering Rename', async t => {
  const run = fixtureRun('trashed-title', 'completed'), f = missionFixture(t, savedDrafts(''));
  const h = mountMission(f, statusSnapshot([run]), { api: async url => url.includes('/api/conversations?state=') ? { conversations: url.endsWith('deleted') ? [{ taskId: run.id, runId: run.id, title: 'Saved name in Trash', state: 'deleted' }] : [] } : undefined }); await turn(); await h.ui.openConversation(run.id);
  const controls = renameControls(f), title = f.element('#conversation-rename-title'); controls.form.hidden = true;
  assert.equal(title.hidden, false); assert.equal(title.disabled, true); assert.equal(f.element('#conversation-title').textContent, 'Saved name in Trash'); assert.match(title.getAttribute('aria-label'), /Saved name in Trash/);
  await h.action('rename-conversation'); assert.equal(controls.form.hidden, true); assert.equal(h.mutations.length, 0);
});

test('a completed search opens its matching turn while a delayed search respects a newer Plan choice', async t => {
  const run = plannedRun('search-open', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]); let release, delay = false;
  const h = mountMission(f, snapshot, { open: () => delay ? new Promise(resolve => { release = resolve; }) : undefined }); await turn();
  const result = { match: { runId: run.id, kind: 'message', text: 'a saved answer' } };
  assert.equal(await h.ui.openSearchResult(result, 'saved answer'), true); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(f.element('#conversation-match-notice').hidden, false); assert.equal(document.activeElement.dataset.runId, run.id);
  f.element('#conversation-match-notice').hidden = true; delay = true; const pending = h.ui.openSearchResult(result, 'saved answer'); await turn(); await h.action('plan-view', { view: 'plan' }); release();
  assert.equal(await pending, false); assert.equal(h.ui.getWorkbench().view, 'plan'); assert.equal(document.activeElement, f.element('#conversation-plan-tab')); assert.equal(f.element('#conversation-match-notice').hidden, true);
});

test('a delayed search leaves a newer editor focus and pointer interaction in control', async t => {
  const run = fixtureRun('search-focus', 'completed'), f = missionFixture(t, savedDrafts('')); let release;
  const h = mountMission(f, statusSnapshot([run]), { open: () => new Promise(resolve => { release = resolve; }) }); await turn();
  const result = { match: { runId: run.id, kind: 'message', text: 'a saved answer' } }, search = f.element('#conversation-search'); search.tagName = 'INPUT';
  f.element('#mission-task').focus(); let pending = h.ui.openSearchResult(result); await turn(); search.focus(); release(); assert.equal(await pending, false); assert.equal(document.activeElement, search);
  pending = h.ui.openSearchResult(result); await turn(); await f.documentEvents.dispatch('pointerdown', menuEvent(search)); release(); assert.equal(await pending, false); assert.equal(document.activeElement, search);
  const restored = f.element('#mission-task'); restored.focus(); h.ui.destroy(); await f.documentEvents.dispatch('pointerdown', menuEvent(search)); assert.equal(document.activeElement, restored);
});

test('search from a connected Activity control still jumps when navigation hides its former workspace', async t => {
  const run = fixtureRun('search-activity', 'completed'), f = missionFixture(t, savedDrafts('')), origin = f.element('#observe-run'); let visible = true;
  origin.getClientRects = () => visible ? [{}] : []; document.body = f.element('body');
  const h = mountMission(f, statusSnapshot([run]), { open: async () => { await turn(); visible = false; document.body.focus(); } }); await turn(); origin.focus();
  assert.equal(await h.ui.openSearchResult({ match: { runId: run.id, kind: 'message', text: 'answer' } }), true);
  assert.equal(origin.isConnected, true); assert.equal(document.activeElement.dataset.runId, run.id); assert.equal(f.element('#conversation-match-notice').hidden, false);
});

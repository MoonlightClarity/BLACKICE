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
    onInbox: value => inbox.push(value), pickFolder: callbacks.pickFolder, onOpenBrowserOS: callbacks.openBrowserOS, onObserve: callbacks.observe, onConnections: () => connections.push(true), onChatModeSetup: callbacks.chatModeSetup, onChatModeRefresh: callbacks.chatModeRefresh, onSchedule: callbacks.schedule, onSwarm: callbacks.swarm, onRunLimits: () => timeLimits.push(true), onPrompts: callbacks.prompts, onSavePrompt: callbacks.savePrompt, onRepeatTask: callbacks.repeatTask, onOpenPlanning: callbacks.openPlanning,
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

test('structured tasks default to Conversation and explicit Plan keeps hidden responses unread', async t => {
  const run = plannedRun('default-plan'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]), h = mountMission(f, snapshot); await turn();
  assert.equal(h.ui.getWorkbench().visible, true); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(h.ui.getWorkbench().selection.selectedId, 'build');
  assert.equal(f.element('#conversation-plan-tabs').hidden, false); assert.equal(f.element('#mission-plan').hidden, true); assert.equal(f.element('#conversation-dialogue').hidden, false); assert.equal(f.element('#conversation-dialogue').inert, false); assert.equal(f.element('#mission-plan').getAttribute('role'), 'tabpanel');
  await h.action('plan-view', { view: 'plan' });
  assert.equal(f.element('#mission-plan').hidden, false); assert.equal(f.element('#conversation-dialogue').inert, true);
  assert.equal(f.element('#conversation-timeline').children[0].querySelector('.conversation-work-slot').hidden, true, 'the old flat work panel is not repeated');
  run.status = 'completed'; run.settled = true; h.ui.update();
  assert.match(f.element('#conversation-list').innerHTML, /New response/); assert.equal(f.element('#conversation-tab-attention').hidden, false);
  await h.planAction('select', { stepId: 'inspect' }); assert.match(f.element('#conversation-list').innerHTML, /New response/);
  const key = menuEvent(f.element('#conversation-plan-tab'), { key: 'ArrowRight' }); await f.mount.dispatch('keydown', key);
  assert.equal(key.prevented, true); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(f.element('#conversation-dialogue-tab').getAttribute('aria-selected'), 'true'); assert.equal(globalThis.document.activeElement, f.element('#conversation-dialogue-tab'));
  assert.equal(f.element('#conversation-dialogue').hidden, false); assert.equal(f.element('#mission-plan').inert, true); assert.doesNotMatch(f.element('#conversation-list').innerHTML, /New response/); assert.equal(f.element('#conversation-tab-attention').hidden, true);
  assert.equal(h.starts.length, 0); assert.equal(h.mutations.length, 0);
});

test('Plan and Conversation retain per-task view, reading position, selected step and draft through updates', async t => {
  const a = plannedRun('plan-position-a'), b = plannedRun('plan-position-b'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(a.id);
  await h.planAction('select', { stepId: 'inspect' }); await h.action('plan-view', { view: 'conversation' }); await h.text('Keep this partial direction');
  const scroll = f.element('#conversation-scroll'); scroll.scrollHeight = 2400; scroll.clientHeight = 500; scroll.scrollTop = 380; await scroll.dispatch('scroll', {});
  await h.ui.openConversation(b.id); assert.equal(h.ui.getWorkbench().view, 'conversation'); h.ui.showPlan(); await h.planAction('select', { stepId: 'verify' });
  await h.ui.openConversation(a.id); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(h.ui.getWorkbench().selection.selectedId, 'inspect'); assert.equal(h.ui.getDraft().task, 'Keep this partial direction'); assert.equal(scroll.scrollTop, 380);
  h.ui.showPlan(); scroll.scrollTop = 0; await scroll.dispatch('scroll', {}); a.nodes.agent.output = 'Another streamed line'; h.ui.update();
  await h.action('plan-view', { view: 'conversation' }); assert.equal(scroll.scrollTop, 380, 'hidden scroll events cannot overwrite the reading position');
  await h.ui.openConversation(b.id); assert.equal(h.ui.getWorkbench().selection.selectedId, 'verify'); assert.equal(h.ui.getWorkbench().view, 'plan');
});

test('an explicitly expanded desktop plan stays available and resizing moves focus out of a hidden pane', async t => {
  const f = missionFixture(t, savedDrafts('')); f.storage.set('relay.ui.plan.collapsed', 'false'); globalThis.window.innerWidth = 1440;
  const h = mountMission(f, statusSnapshot([plannedRun('responsive-plan')])); await turn();
  assert.equal(f.element('#conversation-plan-tabs').hidden, true); assert.equal(f.element('#mission-plan').hidden, false); assert.equal(f.element('#conversation-dialogue').hidden, false); assert.equal(f.element('#mission-plan').getAttribute('role'), undefined);
  h.ui.showPlan();
  f.element('#conversation-dialogue').append(f.element('#mission-task')); f.element('#mission-task').focus();
  globalThis.window.innerWidth = 390; await f.windowEvents.dispatch('resize', {});
  assert.equal(f.element('#conversation-dialogue').inert, true); assert.equal(globalThis.document.activeElement, f.element('#conversation-plan-tab'));
  h.ui.focus(); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(globalThis.document.activeElement, f.element('#mission-task')); assert.equal(f.element('#conversation-dialogue').inert, false);
});

test('an enlarged desktop plan keeps the hidden conversation unread and preserves its draft and reading position', async t => {
  const f = missionFixture(t, savedDrafts('')); globalThis.window.innerWidth = 1440;
  const run = plannedRun('enlarged-plan'), snapshot = statusSnapshot([run]), h = mountMission(f, snapshot); await turn();
  h.ui.focus(); assert.equal(h.ui.getWorkbench().view, 'conversation');
  await h.text('Keep my unfinished message'); await h.model('cloud::chosen'); const composer = f.element('#mission-task'), draft = h.ui.getDraft(), scroll = f.element('#conversation-scroll');
  scroll.scrollHeight = 2400; scroll.clientHeight = 500; scroll.scrollTop = 380; await scroll.dispatch('scroll', {});
  await h.planAction('select', { stepId: 'verify' }); await h.planAction('enlarge');
  assert.equal(h.ui.getWorkbench().selection.enlarged, true); assert.equal(f.element('#conversation-task-layout').dataset.planEnlarged, 'true');
  assert.equal(f.element('#conversation-dialogue').hidden, true); assert.equal(f.element('#conversation-dialogue').inert, true);
  globalThis.window.innerWidth = 390; await f.windowEvents.dispatch('resize', {});
  assert.equal(f.element('#conversation-task-layout').dataset.planView, 'plan'); assert.equal(f.element('#mission-plan').hidden, false); assert.equal(f.element('#conversation-plan-tab').getAttribute('aria-selected'), 'true');
  await h.planAction('enlarge');
  assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(f.element('#mission-plan').hidden, true); assert.equal(f.element('#conversation-dialogue').hidden, false);
  globalThis.window.innerWidth = 1440; await f.windowEvents.dispatch('resize', {});
  await h.planAction('enlarge');
  scroll.scrollTop = 0; await scroll.dispatch('scroll', {}); run.status = 'completed'; run.nodes.agent.status = 'completed'; run.settled = true; h.ui.update();
  assert.match(f.element('#conversation-list').innerHTML, /New response/); assert.equal(f.element('#conversation-dialogue').hidden, true);
  assert.equal(f.element('#mission-task'), composer); assert.deepEqual(h.ui.getDraft(), draft); assert.equal(h.ui.getWorkbench().selection.selectedId, 'verify');
  h.ui.focus();
  assert.equal(h.ui.getWorkbench().selection.enlarged, false); assert.equal(f.element('#conversation-dialogue').hidden, false); assert.equal(f.element('#conversation-dialogue').inert, false);
  assert.equal(scroll.scrollTop, 380); assert.equal(document.activeElement, composer); assert.deepEqual(h.ui.getDraft(), draft);
  assert.equal(h.starts.length, 0); assert.equal(h.mutations.length, 0); h.ui.destroy();
});

test('Guide appends the selected step to an owned draft and reveals it without sending or changing settings', async t => {
  const f = missionFixture(t, savedDrafts('')), run = plannedRun('guide-step'), snapshot = statusSnapshot([run]), h = mountMission(f, snapshot, { prompts() {} }); await turn();
  await h.text('Keep my original context'); await h.model('cloud::chosen'); await h.effort('ultra'); h.ui.setContext({ preset: '900k' }); await h.planningMode('maximal');
  h.ui.showPlan(); await h.planAction('select', { stepId: 'verify' }); const before = h.ui.getDraft();
  await h.planAction('enlarge'); assert.equal(h.ui.getWorkbench().selection.enlarged, true);
  await h.planAction('guide'); assert.match(h.ui.getDraft().task, /^Keep my original context\n\nAbout step “Verify the result” \(verify\)/); assert.match(h.ui.getDraft().task, /Done when: The meaningful checks pass/);
  assert.deepEqual({ ...h.ui.getDraft(), task: before.task }, before); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(h.ui.getWorkbench().selection.enlarged, false); assert.equal(globalThis.document.activeElement, f.element('#mission-task')); assert.equal(h.starts.length, 0); assert.equal(h.queued.length, 0); assert.equal(h.mutations.length, 0);
  await h.action('undo-prompt'); assert.equal(h.ui.getDraft().task, before.task);
});

test('Guide cannot replace a newer same-chat draft from another window', async t => {
  const f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([plannedRun('guide-shared')])); await turn(); await h.text('Original direction'); h.ui.showPlan();
  const remote = h.persisted(); remote.conversationDrafts['guide-shared'].task = 'Another window is writing here'; f.storage.set('relay.mission.draft', JSON.stringify(remote));
  await h.planAction('guide'); assert.equal(h.ui.getDraft().task, 'Original direction'); assert.equal(h.persisted().conversationDrafts['guide-shared'].task, 'Another window is writing here'); assert.match(h.errors.at(-1).message, /another BLACKICE window/); assert.equal(h.ui.getWorkbench().view, 'plan');
});

test('opening Planning passes the latest saved task while retaining the chat draft and run', async t => {
  const calls = [], run = plannedRun('plan-editor'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]), h = mountMission(f, snapshot, { openPlanning: value => calls.push(value) }); await turn();
  await h.text('Keep my next direction'); const before = h.ui.getDraft(); run.taskState.revision = 2; run.taskState.steps[2].note = 'Latest revision'; h.ui.update(); await h.planAction('planning');
  assert.equal(calls.length, 1); assert.equal(calls[0].taskId, run.taskId); assert.equal(calls[0].runId, run.id); assert.equal(calls[0].taskState.revision, 2); assert.equal(calls[0].taskState.steps[2].note, 'Latest revision');
  assert.deepEqual(h.ui.getDraft(), before); assert.equal(h.starts.length, 0); assert.equal(h.queued.length, 0); assert.equal(h.mutations.length, 0);
  assert.doesNotMatch(f.element('#mission-plan').innerHTML, /data-plan-action="(?:method|methods|save-method)"/);
});

test('runtime scaffold and unsupported or missing plans remain explicit without fabricated steps', async t => {
  const run = plannedRun('plan-preparing'), f = missionFixture(t, savedDrafts('')); run.taskState.plan.origin = 'runtime'; run.taskState.steps = []; run.taskState.progress = { total: 0, done: 0, skipped: 0, complete: false }; run.nodes.agent.planning.status = 'preparing';
  const snapshot = statusSnapshot([run]), h = mountMission(f, snapshot); await turn(); const empty = f.element('#mission-plan').querySelector('[data-plan-region="empty"]');
  assert.equal(h.ui.getWorkbench().visible, true); assert.equal(h.ui.getWorkbench().selection.selectedId, null); assert.match(empty.innerHTML, /First, a clear approach/);
  run.status = 'completed'; run.settled = true; run.taskState.revision++; run.nodes.agent.planning = { status: 'missing', message: 'The agent returned without an outline.' }; h.ui.update(); assert.match(empty.innerHTML, /The plan was not recorded/); assert.match(empty.innerHTML, /The agent returned without an outline/);
  run.nodes.agent.planning = { status: 'unavailable', message: 'This model has no planning tools.' }; h.ui.update(); assert.match(empty.innerHTML, /This model has no planning tools/); assert.equal(h.ui.getWorkbench().selection.visibleIds.length, 0);
});

for (const planningStatus of ['unavailable', 'missing']) test(`an empty ${planningStatus} plan opens its conversation and preserves a deliberate Plan choice`, async t => {
  const run = plannedRun(`empty-${planningStatus}`, planningStatus === 'missing' ? 'failed' : 'completed'), f = missionFixture(t, savedDrafts(''));
  globalThis.window.innerWidth = 390; run.settled = true; run.canRetry = planningStatus === 'missing';
  run.taskState.steps = []; run.taskState.plan.origin = 'runtime'; run.taskState.progress = { total: 0, done: 0, complete: false };
  run.nodes.agent.planning = { status: planningStatus, message: planningStatus === 'missing' ? 'The agent did not record its plan.' : 'This model cannot use the task tool.' };
  if (planningStatus === 'unavailable') run.nodes.agent.output = 'A useful reply from this model.';
  const snapshot = statusSnapshot([run]), h = mountMission(f, snapshot); f.cleanup(() => h.ui.destroy()); await turn();
  assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(f.element('#conversation-dialogue').hidden, false); assert.equal(f.element('#conversation-dialogue').inert, false);
  assert.equal(f.element('#mission-plan').hidden, true); assert.equal(f.element('#mission-plan').inert, true); assert.equal(f.element('#conversation-plan-tabs').hidden, false);
  const section = f.element('#conversation-timeline').children[0];
  if (planningStatus === 'missing') assert.match(section.querySelector('.conversation-turn-controls').innerHTML, /data-mission-action="retry"/);
  else assert.ok(section.querySelector('.conversation-responses').children.some(message => message.innerHTML.includes('A useful reply from this model')));
  h.ui.showPlan(); assert.equal(h.ui.getWorkbench().view, 'plan'); assert.equal(f.element('#mission-plan').hidden, false);
  h.ui.update(); await f.windowEvents.dispatch('resize', {}); assert.equal(h.ui.getWorkbench().view, 'plan', 'streaming and layout changes preserve the explicit choice');
  await h.action('new-task'); await h.ui.openConversation(run.id); assert.equal(h.ui.getWorkbench().view, 'plan', 'the explicit choice belongs to this task');
  await h.action('plan-view', { view: 'conversation' }); run.nodes.agent.planning.status = 'preparing'; h.ui.update();
  assert.equal(h.ui.getWorkbench().view, 'conversation', 'a new planning state cannot override the chosen pane');
});

test('preparing plans, saved steps and saved notes stay reachable without replacing the conversation', async t => {
  const preparing = plannedRun('preparing-default'), steps = plannedRun('saved-step-default', 'completed'), notes = plannedRun('saved-note-default', 'completed');
  preparing.taskState.steps = []; preparing.taskState.plan.origin = 'runtime'; preparing.nodes.agent.planning.status = 'preparing';
  steps.nodes.agent.planning.status = 'missing'; notes.taskState.steps = []; notes.nodes.agent.planning.status = 'unavailable'; notes.taskState.checkpoint = { nextAction: 'Inspect the saved notes before continuing.' };
  const f = missionFixture(t, savedDrafts('')); globalThis.window.innerWidth = 390;
  const h = mountMission(f, statusSnapshot([preparing, steps, notes])); f.cleanup(() => h.ui.destroy()); await turn();
  for (const run of [preparing, steps, notes]) { await h.ui.openConversation(run.id); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(f.element('#mission-plan').hidden, true); h.ui.showPlan(); assert.equal(h.ui.getWorkbench().view, 'plan'); assert.equal(f.element('#mission-plan').hidden, false); }
  assert.match(f.element('#mission-plan').querySelector('[data-plan-region="empty"]').innerHTML, /Inspect the saved notes before continuing/);
});

test('legacy and structured chats keep Conversation primary while saved Plan remains reachable', async t => {
  const legacy = fixtureRun('old-conversation', 'completed'), next = plannedRun('new-plan'), f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([legacy, next])); await turn(); await h.ui.openConversation(legacy.id);
  assert.equal(h.ui.getWorkbench().visible, false); assert.equal(f.element('#conversation-plan-tabs').hidden, true); assert.equal(f.element('#conversation-dialogue').hidden, false);
  await h.ui.openConversation(next.id); assert.equal(h.ui.getWorkbench().visible, true); assert.equal(h.ui.getWorkbench().view, 'conversation');
  h.ui.showPlan(); assert.equal(h.ui.getWorkbench().view, 'plan');
});

test('structured next-action and repeat controls honor complete rather than the chosen-path fraction', async t => {
  const run = plannedRun('branch-closing', 'completed'), repeats = [], f = missionFixture(t, savedDrafts(''));
  run.taskState.progress = { total: 1, done: 1, skipped: 0, complete: false, unresolvedBranches: 1 }; run.taskState.steps = [{ id: 'chosen', parentId: null, kind: 'action', title: 'Chosen path result', status: 'done', dependsOn: [] }]; delete run.taskState.plan.focusStepId;
  const snapshot = statusSnapshot([run]), h = mountMission(f, snapshot, { repeatTask: seed => repeats.push(seed) }); await turn(); await h.planAction('repeat'); assert.equal(repeats.length, 0);
  await h.planAction('continue'); assert.match(h.ui.getDraft().task, /record why unused paths are skipped/); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(h.mutations.length, 0);
  await h.text('Keep this separate follow-up'); const kept = h.ui.getDraft().task; h.ui.showPlan(); await h.planAction('continue'); assert.equal(h.ui.getDraft().task, kept);
  run.taskState.progress.complete = true; run.taskState.progress.unresolvedBranches = 0; run.taskState.revision++; h.ui.update(); await h.planAction('repeat'); assert.equal(repeats.length, 1); assert.equal(repeats[0].runId, run.id); assert.equal(h.ui.getDraft().task, kept);
});

test('Planning mode is independent of reasoning, follows each draft, and restores after reload', async t => {
  const a = plannedRun('detail-a', 'completed'), b = plannedRun('detail-b', 'completed'), saved = savedDrafts(''), storage = new Map([['relay.mission.draft', JSON.stringify(saved)]]), f = missionFixture(t, saved, storage), h = mountMission(f, statusSnapshot([a, b])); await turn();
  await h.ui.openConversation(a.id); await h.planningMode('maximal'); await h.effort('ultra'); assert.equal(h.ui.getDraft().planningMode, 'maximal'); assert.equal(h.ui.getDraft().effort, 'ultra');
  await h.ui.openConversation(b.id); assert.equal(h.ui.getDraft().planningMode, 'auto'); await h.planningMode('off'); assert.equal(h.ui.getDraft().effort, 'default');
  await h.ui.openConversation(a.id); assert.equal(h.ui.getDraft().planningMode, 'maximal'); assert.equal(f.element('#mission-planning-mode').value, 'maximal'); h.ui.destroy();
  const reload = missionFixture(t, {}, storage), resumed = mountMission(reload, statusSnapshot([a, b])); await turn(); await resumed.ui.openConversation(b.id); assert.equal(resumed.ui.getDraft().planningMode, 'off'); await resumed.ui.openConversation(a.id); assert.equal(resumed.ui.getDraft().planningMode, 'maximal');
});

test('Planning mode is part of an exact recoverable start receipt and changing it creates a fresh request', async t => {
  const f = missionFixture(t, savedDrafts('Plan this task')), h = mountMission(f, statusSnapshot(), { start: () => { throw new Error('Response lost after submission'); } }); await turn();
  await h.planningMode('maximal'); await h.effort('max'); await h.submit(); const original = h.starts[0]; await h.submit(); assert.deepEqual(h.starts[1], original); assert.equal(original.planningMode, 'maximal'); assert.equal(original.effort, 'max');
  await h.planningMode('off'); assert.equal(h.persisted().conversationDrafts.new.pendingSend, undefined); await h.submit(); assert.notEqual(h.starts[2].requestId, original.requestId); assert.equal(h.starts[2].planningMode, 'off'); assert.equal(h.starts[2].effort, 'max');
});

test('Planning mode travels with a continuation and with a captured new task', async t => {
  const run = plannedRun('detail-continuation', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]), h = mountMission(f, snapshot, { capture: () => ({ id: 'captured-plan' }) }); await turn();
  await h.text('Continue with a deeper plan'); await h.planningMode('on'); await h.submit(); assert.equal(h.mutations.find(item => item.continue).continue.planningMode, 'on');
  await h.action('new-task'); await h.text('Keep this for tomorrow'); await h.planningMode('off'); await h.action('capture'); assert.equal(h.captures[0].planningMode, 'off'); assert.equal(h.persisted().conversationDrafts.new.planningMode, undefined); assert.equal(h.ui.getDraft().planningMode, 'auto');
});

test('Auto is the visible default and new requests leave depth selection to the agent', async t => {
  const f = missionFixture(t, savedDrafts('A short task')), h = mountMission(f, statusSnapshot()); await turn();
  assert.equal(f.element('#mission-planning-mode').value, 'auto'); assert.equal(h.ui.getDraft().planningMode, 'auto');
  assert.match(f.mount.innerHTML, /Planning[\s\S]*value="maximal"[\s\S]*value="on"[\s\S]*value="auto" selected[\s\S]*value="off"/);
  assert.doesNotMatch(f.mount.innerHTML, /mission-plan-detail/); await h.submit();
  assert.equal(h.starts[0].planningMode, 'auto'); assert.equal(Object.hasOwn(h.starts[0], 'planDetail'), false);
});

test('legacy depth preferences remain usable without a second planning control', async t => {
  const saved = savedDrafts('Keep the explicit older preference'); saved.conversationDrafts.new.planDetail = 'compact';
  const f = missionFixture(t, saved), h = mountMission(f, statusSnapshot(), { start: () => { throw new Error('Keep receipt for retry'); } }); await turn();
  await h.submit(); assert.equal(h.starts[0].planDetail, 'compact'); assert.equal(h.starts[0].planningMode, 'auto');
  h.ui.setPlanDetail('detailed'); await h.submit(); assert.equal(h.starts[1].planDetail, 'detailed'); assert.notEqual(h.starts[0].requestId, h.starts[1].requestId);
});

test('Off uses Conversation on a narrow screen and preserves previously recorded steps for inspection', async t => {
  const run = plannedRun('off-with-notes'); run.planningMode = 'off'; run.nodes.agent.planning = { mode: 'off', status: 'off' };
  const before = structuredClone(run.taskState), f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([run])); await turn();
  assert.equal(h.ui.getWorkbench().visible, true); assert.equal(h.ui.getWorkbench().view, 'conversation'); assert.equal(f.element('#conversation-dialogue').hidden, false);
  h.ui.showPlan(); assert.equal(h.ui.getWorkbench().view, 'plan'); assert.deepEqual(h.ui.getWorkbench().selection.visibleIds, ['deliver', 'inspect', 'build', 'verify']);
  const header = f.element('#mission-plan').querySelector('[data-plan-region="header"]'); assert.match(header.innerHTML, /Planning off · saved notes/); assert.doesNotMatch(header.innerHTML, /Preparing the plan/); assert.deepEqual(run.taskState, before);
});

test('Off never shows an empty automatic plan pane or a preparing placeholder', async t => {
  const run = plannedRun('off-empty'); run.planningMode = 'off'; run.nodes.agent.planning = { mode: 'off', status: 'off' }; run.taskState.steps = [];
  const f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([run])); await turn();
  assert.equal(h.ui.getWorkbench().visible, false); assert.equal(f.element('#mission-plan').hidden, true); assert.equal(f.element('#conversation-dialogue').hidden, false);
  assert.equal(h.ui.getDraft().planningMode, 'off'); assert.doesNotMatch(f.element('#mission-plan').querySelector('[data-plan-region="empty"]').innerHTML, /First, a clear approach|breaking the task/);
});

test('checkpoint-only notes stay reachable in Off without becoming invented plan steps', async t => {
  const run = plannedRun('off-checkpoint', 'completed'); run.planningMode = 'off'; run.nodes.agent.planning = { mode: 'off', status: 'off' }; run.taskState.steps = [];
  run.taskState.checkpoint = { decisions: ['Use the provided specification.'], completed: [], nextAction: 'Check the original source.', nextSteps: ['Compare the result.'], openQuestions: ['Which format is required?'] };
  const before = structuredClone(run.taskState), f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([run])); await turn();
  assert.equal(h.ui.getWorkbench().visible, true); assert.equal(h.ui.getWorkbench().view, 'conversation'); h.ui.showPlan();
  const empty = f.element('#mission-plan').querySelector('[data-plan-region="empty"]'); assert.match(empty.innerHTML, /Saved task notes/); assert.match(empty.innerHTML, /Use the provided specification/); assert.match(empty.innerHTML, /Check the original source/); assert.match(empty.innerHTML, /Which format is required/);
  assert.deepEqual(h.ui.getWorkbench().selection.visibleIds, []); assert.deepEqual(run.taskState, before);
});

test('Maximal previews the selected model’s highest supported effort without submitting an inherited default as explicit', async t => {
  const f = missionFixture(t, savedDrafts('Plan this carefully')), snapshot = statusSnapshot(); snapshot.status.runtimeSettings = { defaultEffort: 'medium' };
  snapshot.status.models[0].supportedReasoningEfforts = ['medium', 'high', 'ultra']; snapshot.status.models[2].supportedReasoningEfforts = ['low', 'high'];
  const h = mountMission(f, snapshot); await turn(); assert.equal(h.ui.getDraft().effort, 'medium'); assert.equal(Object.hasOwn(h.ui.getRequestDraft(), 'effort'), false);
  await h.planningMode('maximal'); assert.equal(h.ui.getDraft().effort, 'ultra'); assert.match(f.element('#mission-effort-note').textContent, /Maximal selects Ultra/); assert.match(f.element('#mission-effort').innerHTML, /Automatic · Ultra \(Maximal\)/);
  await h.model('cloud::other'); assert.equal(h.ui.getDraft().effort, 'high'); assert.equal(f.element('#mission-start-button').disabled, false); assert.equal(Object.hasOwn(h.ui.getRequestDraft(), 'planDetail'), false);
  await h.submit(); assert.equal(h.starts[0].planningMode, 'maximal'); assert.equal(h.starts[0].model, 'cloud::other'); assert.equal(Object.hasOwn(h.starts[0], 'effort'), false);
});

test('an explicit effort override remains exact under Maximal and selecting Model default enables its catalog choice', async t => {
  const f = missionFixture(t, savedDrafts('Use my exact level')), snapshot = statusSnapshot(); snapshot.status.models[0].supportedReasoningEfforts = ['low', 'high', 'ultra'];
  const h = mountMission(f, snapshot, { start: () => { throw new Error('Keep submitted receipt'); } }); await turn(); await h.planningMode('maximal'); await h.effort('low');
  assert.equal(h.ui.getDraft().effort, 'low'); await h.submit(); assert.equal(h.starts[0].effort, 'low');
  await h.effort('default'); assert.equal(h.ui.getDraft().effort, 'ultra'); await h.submit(); assert.equal(h.starts[1].effort, 'default'); assert.notEqual(h.starts[1].requestId, h.starts[0].requestId);
});

test('continuing from Maximal to Off restores underlying effort intent while preserving saved notes and receipt ownership', async t => {
  const run = plannedRun('maximal-to-off', 'completed'); run.planningMode = 'maximal'; run.workflow.nodes[0].effort = 'ultra'; run.nodes.agent.effortSelection = { effort: 'ultra', source: 'maximal-model-catalog', requestedEffort: null };
  const before = structuredClone(run.taskState), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]); snapshot.status.runtimeSettings = { defaultEffort: 'medium' }; snapshot.status.models[0].supportedReasoningEfforts = ['medium', 'ultra'];
  const h = mountMission(f, snapshot, { continue: () => { throw new Error('Response lost after acceptance'); } }); await turn(); await h.planningMode('off'); await h.text('Answer using the saved notes.');
  assert.equal(h.ui.getDraft().effort, 'medium'); await h.submit(); const original = h.mutations.find(item => item.continue).continue;
  assert.equal(original.planningMode, 'off'); assert.equal(Object.hasOwn(original, 'effort'), false); snapshot.status.runtimeSettings.defaultEffort = 'ultra'; h.ui.update(); await h.submit();
  assert.deepEqual(h.mutations.filter(item => item.continue)[1].continue, original); assert.deepEqual(run.taskState, before);
});

test('queued Maximal keeps mode and absent effort in the exact pending receipt', async t => {
  const working = fixtureRun('busy'), f = missionFixture(t, savedDrafts('Queue this larger task')), snapshot = statusSnapshot([working]); snapshot.status.runtimeSettings = { defaultEffort: 'medium' }; snapshot.status.models[0].supportedReasoningEfforts = ['medium', 'ultra'];
  const h = mountMission(f, snapshot, { queue: () => { throw new Error('Queue receipt lost'); } }); await turn(); await h.planningMode('maximal'); await h.submit(); const original = h.queued[0];
  assert.equal(original.planningMode, 'maximal'); assert.equal(Object.hasOwn(original, 'effort'), false); assert.equal(Object.hasOwn(original, 'planDetail'), false);
  working.status = 'completed'; working.settled = true; h.ui.update(); await h.submit(); assert.deepEqual(h.queued[1], original); assert.deepEqual(h.starts, []);
});

for (const [source, requestedEffort, effective, expected] of [['request', 'low', 'low', 'low'], ['request', 'default', 'default', 'default'], ['application-default', null, 'medium', undefined], ['maximal-model-catalog', null, 'ultra', undefined], ['maximal-model-catalog', 'default', 'ultra', 'default']]) test(`new Capture/Schedule recipes preserve ${source} reasoning intent (${String(requestedEffort)})`, async t => {
  const run = plannedRun(`recipe-${source}-${requestedEffort}`, 'completed'); run.planningMode = source === 'maximal-model-catalog' ? 'maximal' : 'auto'; run.workflow.nodes[0].effort = effective; run.nodes.agent.effortSelection = { effort: effective, source, requestedEffort };
  const f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([run]), { capture: () => ({ id: 'captured-intent' }) }); await turn(); await h.text('Save this as a separate recipe.');
  assert.equal(h.ui.getRequestDraft().effort, expected); assert.equal(Object.hasOwn(h.ui.getRequestDraft(), 'effort'), expected !== undefined);
  await h.action('capture'); assert.equal(h.captures[0].effort, expected); assert.equal(Object.hasOwn(h.captures[0], 'effort'), expected !== undefined); assert.equal(h.captures[0].planningMode, run.planningMode);
});

test('legacy authored workflow effort survives a new recipe while continuing still relies on engine inheritance', async t => {
  const run = plannedRun('legacy-explicit-recipe', 'completed'); run.workflow.nodes[0].effort = 'low'; const f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([run])); await turn();
  await h.text('Continue this work.'); assert.equal(h.ui.getRequestDraft().effort, 'low'); await h.submit(); assert.equal(Object.hasOwn(h.mutations.find(item => item.continue).continue, 'effort'), false);
});

test('a saved native routing slug remains selected and sends through its matching hidden catalog row', async t => {
  const f = missionFixture(t, savedDrafts('Use this exact saved model', 'actual-slug')), snapshot = statusSnapshot();
  snapshot.status = { ...snapshot.status, defaultModel: 'visible-model', codex: { connected: true, authenticated: true }, models: [{ id: 'visible-model', available: true }, { id: 'picker-alias', model: 'actual-slug', displayName: 'Friendly model', available: true, hidden: true }] };
  const h = mountMission(f, snapshot, { start: () => fixtureRun('native-alias-result', 'completed') }); await turn();
  assert.equal(h.ui.getDraft().model, 'actual-slug');
  assert.match(f.element('#mission-model').innerHTML, /value="actual-slug" selected/); assert.doesNotMatch(f.element('#mission-model').innerHTML, /actual-slug · not connected/); assert.match(f.element('#mission-model').innerHTML, /Friendly model · Hidden by Codex/);
  assert.equal(f.element('#mission-start-button').disabled, false); await h.submit();
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].model, 'actual-slug'); assert.equal(h.starts[0].task, 'Use this exact saved model'); assert.deepEqual(h.connections, []);
});

async function openRowMenu(f, id, runId = id, keyboard) {
  const row = f.element(`row-${id}`); row.dataset = { conversationId: id, id: runId, missionAction: 'open-run' }; f.mount.append(row);
  const event = menuEvent(row, keyboard ? { key: keyboard, shiftKey: keyboard === 'F10' } : { clientX: 910, clientY: 675 });
  await f.mount.dispatch(keyboard ? 'keydown' : 'contextmenu', event); return { row, event, menu: f.menu() };
}

test('visible More actions target another chat without selecting it and toggle closed through their own pointer interaction', async t => {
  const a = fixtureRun('more-selected', 'completed'), b = fixtureRun('more-target', 'completed'), f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([a, b])); await turn();
  await h.ui.openConversation(a.id); await h.text('Keep this unsent message'); const selected = h.ui.getSelection(), more = f.element('more-button'); more.dataset = { chatMore: 'true', conversationId: b.id, id: b.id }; f.mount.append(more);
  const svg = f.element('more-svg'); more.append(svg); const click = menuEvent(svg); await f.mount.dispatch('click', click); const menu = f.menu();
  assert.equal(menu.hidden, false); assert.equal(click.prevented, true); assert.equal(more.getAttribute('aria-expanded'), 'true'); assert.deepEqual(h.ui.getSelection(), selected); assert.equal(h.ui.getDraft().task, 'Keep this unsent message');
  await f.documentEvents.dispatch('pointerdown', menuEvent(svg)); assert.equal(menu.hidden, false, 'the trigger handles its own toggle after pointerdown'); await f.mount.dispatch('click', menuEvent(svg)); assert.equal(menu.hidden, true); assert.equal(globalThis.document.activeElement, more);
  await f.mount.dispatch('click', menuEvent(more)); await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'archive'))); assert.equal(h.mutations.at(-1).url, '/api/conversations/more-target/archive'); assert.deepEqual(h.ui.getSelection(), selected); assert.equal(h.ui.getDraft().task, 'Keep this unsent message');
});

test('outline application produces an editable unsent draft and one guarded Undo without changing files or model choices', async t => {
  const saved = savedDrafts('Build a chess game', 'cloud::chosen'); saved.conversationDrafts.new.attachmentIds = ['keep-file']; saved.conversationDrafts.new.context = { preset: '900k' }; saved.conversationDrafts.new.effort = 'ultra';
  const f = missionFixture(t, saved), h = mountMission(f, statusSnapshot(), { prompts() {} }); await turn(); const before = h.ui.getDraft(), capture = h.ui.capturePromptDraft();
  const text = '## Goal\n\nBuild a chess game\n\n## Deliverable\n\nSVG pieces', result = h.ui.applyPromptDraft(capture, text);
  assert.equal(result.applied, true); assert.equal(h.ui.getDraft().task, text); assert.equal(f.element('#mission-task').value, text); assert.equal(h.starts.length, 0); assert.equal(h.queued.length, 0); assert.equal(h.mutations.length, 0); assert.equal(f.element('#mission-outline-undo').hidden, false);
  assert.deepEqual({ ...h.ui.getDraft(), task: before.task }, before);
  assert.deepEqual(h.ui.undoPromptDraft(result.undo), { undone: true }); assert.deepEqual(h.ui.getDraft(), before); assert.equal(f.element('#mission-outline-undo').hidden, true); assert.equal(h.ui.undoPromptDraft(result.undo).undone, false);
});

test('outline capture cannot overwrite a different chat or a draft edited and then changed back', async t => {
  const a = fixtureRun('outline-a', 'completed'), b = fixtureRun('outline-b', 'completed'), f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([a, b])); await turn();
  await h.ui.openConversation(a.id); await h.text('Original A'); const capture = h.ui.capturePromptDraft(); await h.text('Changed A'); await h.text('Original A');
  assert.equal(h.ui.applyPromptDraft(capture, 'Compiled A').applied, false); assert.equal(h.ui.getDraft().task, 'Original A');
  const second = h.ui.capturePromptDraft(); await h.ui.openConversation(b.id); await h.text('Original B'); assert.equal(h.ui.applyPromptDraft(second, 'Compiled A').applied, false); assert.equal(h.ui.getDraft().task, 'Original B');
});

test('outline Apply and Undo preserve newer same-chat work from another window', async t => {
  const f = missionFixture(t, savedDrafts('First window')), h = mountMission(f, statusSnapshot()); await turn(); const capture = h.ui.capturePromptDraft(), remote = h.persisted(); remote.conversationDrafts.new.task = 'Second window'; f.storage.set('relay.mission.draft', JSON.stringify(remote));
  const rejected = h.ui.applyPromptDraft(capture, 'Outlined'); assert.equal(rejected.applied, false); assert.match(rejected.error, /another BLACKICE window/); assert.equal(h.persisted().conversationDrafts.new.task, 'Second window'); assert.equal(h.ui.getDraft().task, 'First window');
  await h.text('Fresh local draft'); const applied = h.ui.applyPromptDraft(h.ui.capturePromptDraft(), 'Outlined fresh'); assert.equal(applied.applied, true);
  const latest = h.persisted(); latest.conversationDrafts.new.task = 'Remote after outline'; latest.conversationDrafts.other = { task: 'Other chat', attachmentIds: ['other-file'] }; f.storage.set('relay.mission.draft', JSON.stringify(latest));
  assert.equal(h.ui.undoPromptDraft(applied.undo).undone, false); assert.deepEqual(h.persisted(), latest);
});

test('opening outline actions leaves a draft untouched and applying exact preview still requires normal Send', async t => {
  const calls = [], f = missionFixture(t, savedDrafts('Original task')), h = mountMission(f, statusSnapshot(), { prompts: () => calls.push('open'), savePrompt: () => calls.push('save'), start: () => ({ ...fixtureRun('outlined-run'), input: 'user-edited exact preview' }) }); await turn();
  const before = h.persisted(); await h.action('prompts'); await h.action('save-prompt'); assert.deepEqual(calls, ['open', 'save']); assert.deepEqual(h.persisted(), before); assert.equal(h.starts.length, 0);
  assert.equal(h.ui.applyPromptDraft(h.ui.capturePromptDraft(), 'user-edited exact preview').applied, true); assert.equal(h.starts.length, 0); await h.submit(); assert.equal(h.starts.length, 1); assert.equal(h.starts[0].task, 'user-edited exact preview');
});

test('outline changes cannot apply while a send is in progress and later freeform edits retire Undo', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; }); const f = missionFixture(t, savedDrafts('Original')), h = mountMission(f, statusSnapshot(), { prompts() {}, start: () => pending }); await turn();
  const capture = h.ui.capturePromptDraft(); h.ui.submitFocused(); await turn(); assert.equal(h.ui.applyPromptDraft(capture, 'Should not replace a submitting message').applied, false); release(fixtureRun('submitted')); await f.form.lastSubmission; await turn();
  await h.text('New draft'); const applied = h.ui.applyPromptDraft(h.ui.capturePromptDraft(), 'Outline draft'); await h.text('Freeform edit'); assert.equal(f.element('#mission-outline-undo').hidden, true); assert.equal(h.ui.undoPromptDraft(applied.undo).undone, false); assert.equal(h.ui.getDraft().task, 'Freeform edit');
});

test('the immediate Mission header uses the authored outline goal and preserves saved custom chat titles', async t => {
  const run = { ...fixtureRun('structured-title', 'completed'), input: '## Build\n\nA chess game with SVG pieces\n\n## Requirements\n\nLegal moves and undo' }; let renamed = false;
  const f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([run]), { api: url => url.includes('/api/conversations?state=') ? { conversations: renamed && url.endsWith('active') ? [{ taskId: run.id, runId: run.id, title: 'My custom chess chat', state: 'active' }] : [] } : undefined }); await turn(); await h.ui.openConversation(run.id);
  assert.equal(f.element('#conversation-title').textContent, 'A chess game with SVG pieces'); assert.equal(f.element('#conversation-title').title, 'A chess game with SVG pieces'); assert.equal(run.input.startsWith('## Build'), true);
  renamed = true; await h.ui.refreshHistory({ immediate: true }); assert.equal(f.element('#conversation-title').textContent, 'My custom chess chat'); assert.equal(f.element('#conversation-title').title, 'My custom chess chat');
});

test('streaming timestamp updates do not rebuild unchanged sidebar groups or dismiss an open menu', async t => {
  const today = new Date(); today.setHours(12, 0, 0, 0); const a = { ...fixtureRun('stable-row', 'completed'), createdAt: today.toISOString(), updatedAt: today.toISOString() }, f = missionFixture(t), h = mountMission(f, statusSnapshot([a])); await turn();
  const { menu } = await openRowMenu(f, a.id), list = f.element('#conversation-list'), before = list.innerHTML; list.scrollTop = 87;
  today.setSeconds(1); a.updatedAt = today.toISOString(); h.ui.update(); assert.equal(list.innerHTML, before); assert.equal(menu.hidden, false); assert.equal(list.scrollTop, 87);
  a.status = 'failed'; h.ui.update(); assert.equal(menu.hidden, true); assert.match(list.innerHTML, /Needs attention/); assert.equal(list.scrollTop, 87);
});

test('right-click Archive targets an unselected completed chat while a different chat works, preserving its draft and model', async t => {
  const a = fixtureRun('selected-working'), b = fixtureRun('other-chat', 'completed'), next = { ...fixtureRun('other-followup', 'completed'), taskId: b.id, parentRunId: b.id, createdAt: '2026-10-16T10:01:00Z' };
  const f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b, next]); let bucket = 'active';
  const h = mountMission(f, snapshot, { api: async (url, method) => {
    if (method === 'POST') { assert.equal(url, '/api/conversations/other-followup/archive'); bucket = 'archived'; return {}; }
    if (url.includes('?state=')) return { conversations: url.endsWith(bucket) ? [{ taskId: b.id, runId: next.id, title: 'Other completed chat', state: bucket }] : [] };
  } }); await turn(); await h.ui.openConversation(a.id); await h.text('Keep writing in the working chat'); await h.model('cloud::chosen');
  const before = h.ui.getSelection(), opened = [...h.opened], draft = h.ui.getDraft(), stored = h.persisted(), { menu, event } = await openRowMenu(f, b.id, next.id);
  assert.equal(event.prevented, true); assert.equal(menu.hidden, false); assert.deepEqual(menu.children.map(button => button.textContent), ['Rename', 'Archive', 'Delete']);
  assert.deepEqual(h.ui.getSelection(), before, 'opening the menu must not open its target chat');
  await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'archive')));
  assert.equal(h.mutations.length, 1); assert.deepEqual(h.ui.getSelection(), before); assert.deepEqual(h.opened, opened); assert.deepEqual(h.ui.getDraft(), draft); assert.deepEqual(h.persisted(), stored);
  assert.doesNotMatch(f.element('#conversation-list').innerHTML, /Other completed chat/); assert.match(h.errors.at(-1).message, /archived/); assert.equal(menu.hidden, true);
});

test('chat selection and New chat preserve the desktop sidebar and dismiss only the narrow overlay at its CSS breakpoint', async t => {
  const a = fixtureRun('sidebar-a', 'completed'), b = fixtureRun('sidebar-b', 'completed'), f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([a, b])); await turn();
  for (const width of [1280, 980, 979, 761, 760, 600]) {
    globalThis.window.innerWidth = width; f.mount.classList.add('sidebar-open'); await h.ui.openConversation(a.id);
    assert.equal(f.mount.classList.contains('sidebar-open'), width >= 980, `chat selection at ${width}px`);
    f.mount.classList.add('sidebar-open'); await h.action('new-task');
    assert.equal(f.mount.classList.contains('sidebar-open'), width >= 980, `New chat at ${width}px`);
  }
  globalThis.window.innerWidth = 1280; f.mount.classList.remove('sidebar-open'); await h.ui.openConversation(b.id);
  assert.equal(f.mount.classList.contains('sidebar-open'), false, 'desktop selection preserves an intentionally closed pane too');
});

test('narrow sidebar Escape and scrim dismissal preserve the desktop preference, draft, and accessible expanded state', async t => {
  const f = missionFixture(t, savedDrafts('Keep this draft'));
  f.storage.set('relay.ui.sidebar.collapsed', 'true');
  const h = mountMission(f, statusSnapshot()); await turn();
  const toggle = f.element('#conversation-sidebar-toggle'), scrim = f.element('#conversation-sidebar-scrim');
  f.element('#conversation-rename').hidden = true;
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(f.element('#conversation-sidebar').inert, true);
  globalThis.window.innerWidth = 900;
  await f.windowEvents.dispatch('resize', {});
  await h.action('sidebar');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(scrim.hidden, false);
  assert.equal(f.element('#conversation-sidebar').inert, false);
  assert.equal(globalThis.document.activeElement, f.element('#conversation-search'));
  const escape = menuEvent(f.element('#conversation-search'), { key: 'Escape' });
  await f.mount.dispatch('keydown', escape);
  assert.equal(escape.prevented, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(scrim.hidden, true);
  assert.equal(globalThis.document.activeElement, toggle);
  await h.action('sidebar');
  await h.action('close-sidebar');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(f.storage.get('relay.ui.sidebar.collapsed'), 'true');
  assert.equal(h.ui.getDraft().task, 'Keep this draft');
  globalThis.window.innerWidth = 1100;
  await f.windowEvents.dispatch('resize', {});
  assert.equal(f.mount.classList.contains('sidebar-collapsed'), true);
  await h.action('sidebar');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.storage.get('relay.ui.sidebar.collapsed'), 'false');
  assert.equal(scrim.hidden, true, 'a desktop pane never has an overlay scrim');
  h.ui.destroy();
  globalThis.window.innerWidth = 600;
  await f.windowEvents.dispatch('resize', {});
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'destroy removes the resize listener');
});

test('welcome and labeled send use the selected model without replacing a focused draft or submitting setup', async t => {
  const f = missionFixture(t, savedDrafts('A task I am still writing', 'cloud::chosen')), snapshot = statusSnapshot();
  snapshot.status.models.find(model => model.id === 'cloud::chosen').available = false;
  const h = mountMission(f, snapshot); await turn();
  const textarea = f.element('#mission-task'), send = f.element('#mission-start-button'); textarea.focus();
  assert.equal(f.element('#conversation-welcome-status').dataset.state, 'setup', 'a connected default cannot hide the selected model’s problem');
  assert.equal(f.element('#conversation-welcome-action').dataset.missionAction, 'connections');
  assert.equal(send.type, 'button');
  assert.match(send.innerHTML, /Connect model/);
  await f.mount.dispatch('click', menuEvent(send));
  assert.deepEqual(h.connections, [true]);
  assert.equal(h.starts.length, 0);
  assert.equal(h.ui.getDraft().task, 'A task I am still writing');
  await h.model('cloud::other');
  assert.equal(f.element('#conversation-welcome-status').dataset.state, 'ready');
  assert.match(f.element('#conversation-welcome-detail').textContent, /cloud::other/);
  assert.equal(send.type, 'submit');
  assert.match(send.innerHTML, />Send</);
  assert.equal(send.dataset.missionAction, undefined);
  snapshot.streamState = 'reconnecting'; h.ui.update();
  assert.equal(f.element('#conversation-welcome-status').dataset.state, 'reconnecting');
  assert.equal(f.element('#mission-task'), textarea);
  assert.equal(globalThis.document.activeElement, textarea);
  assert.equal(h.ui.getDraft().task, 'A task I am still writing');
});

test('secondary task actions preserve drafts and retired bridge controls cannot invoke a callback', async t => {
  const calls = [], f = missionFixture(t, savedDrafts('Preserve this message', 'cloud::chosen'));
  const h = mountMission(f, statusSnapshot(), { chatgptBridge: () => calls.push('bridge'), schedule: () => calls.push('schedule'), swarm: () => calls.push('swarm') }); await turn();
  const before = h.ui.getDraft();
  for (const action of ['schedule-task', 'create-swarm']) {
    await h.action(action);
    assert.doesNotMatch(f.mount.innerHTML, /id="mission-options"/);
    assert.deepEqual(h.ui.getDraft(), before);
  }
  await h.action('chatgpt-bridge');
  assert.deepEqual(calls, ['schedule', 'swarm']);
  assert.deepEqual(h.ui.getDraft(), before);
  assert.doesNotMatch(f.mount.innerHTML, /data-mission-action="chatgpt-bridge"/);
  assert.equal(h.starts.length, 0);
  assert.equal(h.mutations.length, 0);
});

test('Delete moves the whole target chat to Trash; archived and trashed rows expose the appropriate Restore action', async t => {
  const a = fixtureRun('keep-selected', 'completed'), b = fixtureRun('delete-target', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]); let bucket = 'archived';
  const h = mountMission(f, snapshot, { api: async (url, method) => {
    if (method === 'POST') { bucket = url.endsWith('/delete') ? 'deleted' : 'active'; return {}; }
    if (url.includes('?state=')) return { conversations: url.endsWith(bucket) ? [{ taskId: b.id, runId: b.id, title: 'Target chat', state: bucket }] : [] };
  } }); await turn(); await h.ui.openConversation(a.id); await h.text('Unsaved selected draft'); const selected = h.ui.getSelection();
  f.element('#conversation-history-state').value = 'archived'; await f.mount.dispatch('change', menuEvent(f.element('#conversation-history-state'))); await turn();
  let { menu } = await openRowMenu(f, b.id); assert.deepEqual(menu.children.map(button => button.textContent), ['Rename', 'Restore', 'Delete']);
  await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'delete'))); assert.equal(h.mutations.at(-1).url, '/api/conversations/delete-target/delete'); assert.equal(f.element('#conversation-history-state').value, 'archived');
  f.element('#conversation-history-state').value = 'deleted'; await f.mount.dispatch('change', menuEvent(f.element('#conversation-history-state'))); await turn();
  ({ menu } = await openRowMenu(f, b.id)); assert.deepEqual(menu.children.map(button => button.textContent), ['Restore']); await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'restore')));
  assert.equal(h.mutations.at(-1).url, '/api/conversations/delete-target/restore'); assert.equal(f.element('#conversation-history-state').value, 'deleted', 'restoring another chat must keep the current history filter'); assert.deepEqual(h.ui.getSelection(), selected); assert.equal(h.ui.getDraft().task, 'Unsaved selected draft');
  assert.match(h.errors.find(item => /Trash/.test(item.message)).message, /restore/);
});

test('working families can be archived and restored while Delete stays disabled across sidebar and header actions', async t => {
  const completed = fixtureRun('busy-root', 'completed'), child = { ...fixtureRun('busy-child', 'queued'), taskId: completed.id, parentRunId: completed.id, createdAt: '2026-10-16T10:01:00Z' }, f = missionFixture(t, savedDrafts('')); let bucket = 'active';
  const h = mountMission(f, statusSnapshot([completed, child]), { api: async (url, method) => {
    if (method === 'POST') { bucket = url.endsWith('/archive') ? 'archived' : 'active'; return {}; }
    if (url.includes('?state=')) return { conversations: url.endsWith(bucket) ? [{ taskId: completed.id, runId: child.id, state: bucket }] : [] };
  } }); await turn(); await h.ui.openConversation(completed.id);
  const header = () => f.element('#conversation-action-list').innerHTML;
  assert.match(header(), /data-mission-action="archive-conversation">Archive/); assert.match(header(), /data-mission-action="delete-conversation" disabled title="Stop this chat before deleting it\."/);
  const { menu } = await openRowMenu(f, completed.id, child.id); assert.equal(menu.hidden, false); assert.equal(menu.children[0].disabled, false); assert.equal(menu.children.find(button => button.dataset.chatAction === 'delete').disabled, true); assert.match(menu.innerHTML, /Stop this chat to delete it/); assert.equal(globalThis.document.activeElement, menu.children[0]);
  await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'delete'))); assert.equal(h.mutations.length, 0);
  menu.children.find(button => button.dataset.chatAction === 'delete').disabled = false; await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'delete'))); assert.equal(h.mutations.length, 0, 'the disabled policy is checked independently of the button attribute');
  await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'archive'))); assert.equal(h.mutations.at(-1).url, '/api/conversations/busy-child/archive'); assert.equal(h.stopped.length, 0, 'archiving does not stop the actual work'); assert.match(header(), /data-mission-action="restore-conversation">Restore/);
  await h.action('restore-conversation'); assert.equal(h.mutations.at(-1).url, '/api/conversations/busy-child/restore'); assert.equal(child.status, 'queued'); assert.match(header(), /data-mission-action="archive-conversation">Archive/);
  await h.action('delete-conversation'); assert.equal(h.mutations.length, 2, 'programmatic header activation still checks a working descendant'); assert.match(h.errors.at(-1).message, /Stop this chat before deleting/);
});

test('a changed history bucket dismisses the captured menu, and stale or unknown row IDs cannot issue a mutation', async t => {
  const b = fixtureRun('externally-changed', 'completed'), f = missionFixture(t), snapshot = statusSnapshot([b]); let bucket = 'active';
  const h = mountMission(f, snapshot, { api: async url => url.includes('?state=') ? { conversations: url.endsWith(bucket) ? [{ taskId: b.id, runId: b.id, title: 'Changing chat', state: bucket }] : [] } : undefined }); await turn();
  const { menu } = await openRowMenu(f, b.id), oldButton = menu.children.find(button => button.dataset.chatAction === 'archive'); bucket = 'deleted'; await h.ui.refreshHistory(); assert.equal(menu.hidden, true); await menu.dispatch('click', menuEvent(oldButton)); assert.equal(h.mutations.length, 0);
  await openRowMenu(f, b.id, 'stale-run-id'); assert.equal(menu.hidden, true); await openRowMenu(f, 'missing-chat'); assert.equal(menu.hidden, true); assert.equal(h.mutations.length, 0);
});

test('menu actions are single flight and an error leaves the selected draft and target chat intact', async t => {
  const a = fixtureRun('failure-selected', 'completed'), b = fixtureRun('failure-target', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]); let reject;
  const h = mountMission(f, snapshot, { api: async (_url, method) => method ? new Promise((_resolve, failed) => { reject = failed; }) : undefined }); await turn(); await h.ui.openConversation(a.id); await h.text('Draft survives deletion failure'); const selected = h.ui.getSelection();
  const { menu } = await openRowMenu(f, b.id), button = menu.children.find(button => button.dataset.chatAction === 'delete'), first = menu.dispatch('click', menuEvent(button)); await turn(); await menu.dispatch('click', menuEvent(button));
  assert.equal(h.mutations.length, 1); assert.equal(menu.children.every(item => item.disabled), true); assert.equal(globalThis.document.activeElement, menu); reject(new Error('The disk is unavailable.')); await first;
  assert.equal(h.errors.at(-1).message, 'The disk is unavailable.'); assert.equal(h.errors.at(-1).error, true); assert.equal(menu.hidden, true); assert.deepEqual(h.ui.getSelection(), selected); assert.equal(h.ui.getDraft().task, 'Draft survives deletion failure'); assert.match(f.element('#conversation-list').innerHTML, /failure-target/);
});

test('archiving and restoring the selected chat preserves its unsent reply and returns only its own filter to Chats', async t => {
  const a = fixtureRun('selected-target', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]); let bucket = 'active';
  const h = mountMission(f, snapshot, { api: async (url, method) => {
    if (method === 'POST') { bucket = url.endsWith('/archive') ? 'archived' : 'active'; return {}; }
    if (url.includes('?state=')) return { conversations: url.endsWith(bucket) ? [{ taskId: a.id, runId: a.id, title: 'Selected chat', state: bucket }] : [] };
  } }); await turn(); await h.ui.openConversation(a.id); await h.text('Keep this reply for when I restore'); const selected = h.ui.getSelection(), draft = h.ui.getDraft();
  let { menu } = await openRowMenu(f, a.id); await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'archive'))); assert.equal(f.element('#mission-start-button').disabled, true); assert.deepEqual(h.ui.getDraft(), draft);
  f.element('#conversation-history-state').value = 'archived'; await f.mount.dispatch('change', menuEvent(f.element('#conversation-history-state'))); await turn(); ({ menu } = await openRowMenu(f, a.id)); await menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'restore')));
  assert.equal(f.element('#conversation-history-state').value, 'active'); assert.equal(f.element('#mission-start-button').disabled, false); assert.deepEqual(h.ui.getSelection(), selected); assert.deepEqual(h.ui.getDraft(), draft);
});


test('bulk archive changes only selected visible chats without consuming an unsent reply', async t => {
  const a=fixtureRun('bulk-selected','completed'),b=fixtureRun('bulk-target','completed'),c=fixtureRun('bulk-not-selected','completed');
  const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a,b,c]),states=new Map([[a.id,'active'],[b.id,'active'],[c.id,'active']]);
  const h=mountMission(f,snapshot,{api:async(url,method)=>{
    const match=/^\/api\/conversations\/([^/]+)\/(archive|restore|delete)$/.exec(url);
    if(method==='POST'&&match){states.set(match[1],match[2]==='archive'?'archived':match[2]==='restore'?'active':'deleted');return{};}
    if(url.includes('?state=')){const state=url.split('state=').at(-1);return{conversations:[...states].filter(([,bucket])=>bucket===state).map(([id,bucket])=>({taskId:id,runId:id,title:id,state:bucket}))};}
  }});await turn();await h.ui.openConversation(a.id);await h.text('Do not lose this reply');const before=h.ui.getDraft();
  await h.action('bulk-start');
  assert.match(f.element('#conversation-list').innerHTML,/data-mission-action="bulk-toggle"/);
  assert.doesNotMatch(f.element('#conversation-list').innerHTML,/data-chat-more="true"/);
  await h.action('bulk-toggle',{conversationId:b.id});
  assert.equal(f.element('#conversation-bulk-count').textContent,'1 selected');
  await h.action('bulk-archive');
  assert.deepEqual(h.mutations.filter(item=>item.url?.endsWith('/archive')).map(item=>item.url),['/api/conversations/bulk-target/archive']);
  assert.equal(states.get(b.id),'archived');assert.equal(states.get(c.id),'active');
  assert.equal(f.element('#conversation-bulk-toolbar').hidden,true);
  assert.deepEqual(h.ui.getDraft(),before);
  assert.equal(h.starts.length,0);
});

test('bulk Trash requires confirmation and rejects a live selected conversation',async t=>{
  const a=fixtureRun('bulk-trash-ready','completed'),b=fixtureRun('bulk-trash-busy','running');
  const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a,b]),states=new Map([[a.id,'active'],[b.id,'active']]);
  const h=mountMission(f,snapshot,{api:async(url,method)=>{
    const match=/^\/api\/conversations\/([^/]+)\/(archive|restore|delete)$/.exec(url);
    if(method==='POST'&&match){states.set(match[1],match[2]==='delete'?'deleted':match[2]==='archive'?'archived':'active');return{};}
    if(url.includes('?state=')){const state=url.split('state=').at(-1);return{conversations:[...states].filter(([,bucket])=>bucket===state).map(([id,bucket])=>({taskId:id,runId:id,title:id,state:bucket}))};}
  }});await turn();await h.action('bulk-start');await h.action('bulk-all');
  assert.equal(f.element('#conversation-bulk-count').textContent,'2 selected');
  assert.equal(f.element('#conversation-bulk-delete').disabled,true);
  await h.action('bulk-delete');
  assert.match(f.element('#conversation-bulk-error').textContent,/Stop working conversations/);
  assert.equal(h.mutations.filter(item=>item.url?.endsWith('/delete')).length,0);
  b.status='completed';b.settled=true;b.nodes.agent.status='completed';h.ui.update();
  assert.equal(f.element('#conversation-bulk-delete').disabled,false);
  await h.action('bulk-delete');
  assert.equal(f.element('#conversation-bulk-confirm').hidden,false);
  assert.equal(h.mutations.filter(item=>item.url?.endsWith('/delete')).length,0);
  await h.action('bulk-confirm-no');
  assert.equal(f.element('#conversation-bulk-confirm').hidden,true);
  await h.action('bulk-delete');await h.action('bulk-confirm-yes');
  assert.deepEqual(h.mutations.filter(item=>item.url?.endsWith('/delete')).map(item=>item.url).sort(),['/api/conversations/bulk-trash-busy/delete','/api/conversations/bulk-trash-ready/delete']);
  assert.equal(states.get(a.id),'deleted');assert.equal(states.get(b.id),'deleted');assert.equal(f.element('#conversation-bulk-toolbar').hidden,true);
});

test('bulk partial failure keeps only the failed chat selected for explicit retry',async t=>{
  const a=fixtureRun('bulk-good','completed'),b=fixtureRun('bulk-failed','completed');
  const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a,b]),states=new Map([[a.id,'active'],[b.id,'active']]);
  let failedOnce=false;
  const h=mountMission(f,snapshot,{api:async(url,method)=>{
    const match=/^\/api\/conversations\/([^/]+)\/(archive|restore|delete)$/.exec(url);
    if(method==='POST'&&match){if(match[1]===b.id&&!failedOnce){failedOnce=true;throw Error('Storage temporarily unavailable.');}states.set(match[1],match[2]==='archive'?'archived':match[2]==='restore'?'active':'deleted');return{};}
    if(url.includes('?state=')){const state=url.split('state=').at(-1);return{conversations:[...states].filter(([,bucket])=>bucket===state).map(([id,bucket])=>({taskId:id,runId:id,title:id,state:bucket}))};}
  }});await turn();await h.action('bulk-start');await h.action('bulk-all');await h.action('bulk-archive');
  assert.equal(states.get(a.id),'archived');assert.equal(states.get(b.id),'active');
  assert.equal(f.element('#conversation-bulk-count').textContent,'1 selected');
  assert.match(f.element('#conversation-bulk-error').textContent,/Storage temporarily unavailable/);
  await h.action('bulk-archive');
  assert.equal(states.get(b.id),'archived');
  assert.equal(h.mutations.filter(item=>item.url==='/api/conversations/bulk-good/archive').length,1);
  await h.action('bulk-start');await h.action('bulk-all');
  f.element('#conversation-history-state').value='archived';
  await f.mount.dispatch('change',menuEvent(f.element('#conversation-history-state')));
  assert.equal(f.element('#conversation-bulk-toolbar').hidden,true,'changing the filter discards hidden bulk selections');
});


test('bulk actions admit only one network mutation while the selection is busy',async t=>{
  const a=fixtureRun('bulk-single-flight','completed'),f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a]);
  let release,posts=0,bucket='active';
  const h=mountMission(f,snapshot,{api:async(url,method)=>{
    if(method==='POST'&&url.endsWith('/archive')){posts++;return new Promise(resolve=>{release=()=>{bucket='archived';resolve({});};});}
    if(url.includes('?state='))return{conversations:url.endsWith(bucket)?[{taskId:a.id,runId:a.id,title:a.id,state:bucket}]:[]};
  }});await turn();await h.action('bulk-start');await h.action('bulk-toggle',{conversationId:a.id});
  const pending=h.action('bulk-archive');await turn();
  assert.equal(posts,1);assert.equal(f.element('#conversation-bulk-archive').disabled,true);
  assert.equal(f.element('#conversation-history-state').disabled,true);
  await h.action('bulk-archive');await h.action('bulk-cancel');
  assert.equal(posts,1,'duplicate clicks cannot admit another change');
  assert.equal(f.element('#conversation-bulk-toolbar').hidden,false);
  release();await pending;
  assert.equal(posts,1);assert.equal(bucket,'archived');
  assert.equal(f.element('#conversation-bulk-toolbar').hidden,true);
  assert.equal(f.element('#conversation-history-state').disabled,false);
});

test('Trash multi-select offers Restore without exposing meaningless Archive or Trash actions',async t=>{
  const a=fixtureRun('bulk-in-trash','completed'),f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a]);
  let bucket='deleted';
  const h=mountMission(f,snapshot,{api:async(url,method)=>{
    if(method==='POST'&&url.endsWith('/restore')){bucket='active';return{};}
    if(url.includes('?state='))return{conversations:url.endsWith(bucket)?[{taskId:a.id,runId:a.id,title:'Recoverable chat',state:bucket}]:[]};
  }});await turn();
  f.element('#conversation-history-state').value='deleted';
  await f.mount.dispatch('change',menuEvent(f.element('#conversation-history-state')));await turn();
  await h.action('bulk-start');await h.action('bulk-toggle',{conversationId:a.id});
  assert.equal(f.element('#conversation-bulk-restore').hidden,false);
  assert.equal(f.element('#conversation-bulk-archive').hidden,true);
  assert.equal(f.element('#conversation-bulk-delete').hidden,true);
  await h.action('bulk-restore');
  assert.deepEqual(h.mutations.filter(v=>v.url?.endsWith('/restore')).map(v=>v.url),['/api/conversations/bulk-in-trash/restore']);
  assert.equal(bucket,'active');
});

test('changing the sidebar search dismisses the menu, and destroying a pending action prevents late UI updates', async t => {
  const a = fixtureRun('dispose-target', 'completed'), f = missionFixture(t), snapshot = statusSnapshot([a]); let release;
  const h = mountMission(f, snapshot, { api: async (_url, method) => method ? new Promise(resolve => { release = resolve; }) : undefined }); await turn();
  let { menu } = await openRowMenu(f, a.id); f.element('#conversation-search').value = 'nothing matches'; await f.mount.dispatch('input', menuEvent(f.element('#conversation-search'))); assert.equal(menu.hidden, true);
  f.element('#conversation-search').value = ''; await f.mount.dispatch('input', menuEvent(f.element('#conversation-search'))); ({ menu } = await openRowMenu(f, a.id)); const pending = menu.dispatch('click', menuEvent(menu.children.find(button => button.dataset.chatAction === 'delete'))); await turn();
  const markup = f.element('#conversation-list').innerHTML, errors = [...h.errors]; h.ui.destroy(); release({}); await pending; assert.equal(menu.isConnected, false); assert.equal(f.element('#conversation-list').innerHTML, markup); assert.deepEqual(h.errors, errors);
});

test('menu placement stays inside the viewport, including bottom-right and keyboard anchors', () => {
  assert.deepEqual(conversationMenuPosition({ x: 997, y: 698, width: 174, height: 88, viewportWidth: 1000, viewportHeight: 700 }), { left: 818, top: 604 });
  assert.deepEqual(conversationMenuPosition({ x: -30, y: -2, width: 174, height: 88, viewportWidth: 1000, viewportHeight: 700 }), { left: 8, top: 8 });
  assert.deepEqual(conversationMenuActions({ state: 'deleted' }).map(item => item.action), ['restore']);
});

test('keyboard menus navigate, dismiss with focus return, close on outside/scroll/resize, and detach on destroy', async t => {
  const f = missionFixture(t), fallback = f.element('fallback'), actions = [], ui = initConversationMenu({ mount: f.mount, resolveTarget: id => ({ id, runId: id, state: 'active', title: 'A chat' }), onAction: (...args) => actions.push(args), fallbackFocus: () => fallback });
  const { menu, row, event } = await openRowMenu(f, 'keyboard-chat', 'keyboard-chat', 'F10'); assert.equal(event.prevented, true); assert.equal(globalThis.document.activeElement, menu.children[0]); assert.equal(menu.style.top, '114px');
  await menu.dispatch('keydown', menuEvent(menu.children[0], { key: 'ArrowDown' })); assert.equal(globalThis.document.activeElement, menu.children[1]);
  await menu.dispatch('keydown', menuEvent(menu.children[1], { key: 'Home' })); assert.equal(globalThis.document.activeElement, menu.children[0]);
  await menu.dispatch('keydown', menuEvent(menu.children[0], { key: 'End' })); assert.equal(globalThis.document.activeElement, menu.children[2]);
  await menu.dispatch('keydown', menuEvent(menu.children[2], { key: 'Escape' })); assert.equal(menu.hidden, true); assert.equal(globalThis.document.activeElement, row); assert.equal(row.getAttribute('aria-expanded'), undefined);
  await openRowMenu(f, 'keyboard-chat', 'keyboard-chat', 'ContextMenu'); const outside = f.element('outside'); outside.focus(); await f.documentEvents.dispatch('pointerdown', menuEvent(outside)); assert.equal(menu.hidden, true); assert.equal(globalThis.document.activeElement, outside, 'outside pointer interaction keeps its own focus');
  await openRowMenu(f, 'keyboard-chat'); outside.focus(); await f.documentEvents.dispatch('keydown', menuEvent(outside, { key: 'Escape' })); assert.equal(menu.hidden, true); assert.equal(globalThis.document.activeElement, outside, 'Escape also dismisses a menu after focus moves programmatically');
  await openRowMenu(f, 'keyboard-chat'); await f.documentEvents.dispatch('scroll', menuEvent(f.mount)); assert.equal(menu.hidden, true); assert.equal(globalThis.document.activeElement, row);
  await openRowMenu(f, 'keyboard-chat'); row.isConnected = false; await f.windowEvents.dispatch('resize', {}); assert.equal(menu.hidden, true); assert.equal(globalThis.document.activeElement, fallback);
  await openRowMenu(f, 'keyboard-chat'); ui.destroy(); assert.equal(menu.isConnected, false); await f.mount.dispatch('contextmenu', menuEvent(row, { clientX: 25, clientY: 30 })); assert.equal(menu.hidden, true); assert.equal(actions.length, 0);
});

test('conversation export links follow the selected chat and its newest turn without following background chats',async t=>{
  const a=fixtureRun('export-a','completed'),b=fixtureRun('export-b','completed'),f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a,b]),h=mountMission(f,snapshot);await turn();
  const links=()=>f.element('#conversation-action-list').innerHTML;
  await h.ui.openConversation(a.id);assert.match(links(),/href="\/api\/conversations\/export-a\/export\?format=markdown"/);assert.match(links(),/href="\/api\/conversations\/export-a\/export\?format=json"/);
  await h.ui.openConversation(b.id);assert.match(links(),/href="\/api\/conversations\/export-b\/export\?format=markdown"/);assert.doesNotMatch(links(),/\/export-a\/export/,'equally settled chats must not reuse the previous selected chat menu');
  const next={...fixtureRun('export-a-followup','completed'),taskId:a.taskId,parentRunId:a.id,createdAt:'2026-10-16T10:01:00Z'};snapshot.runs.unshift(next);snapshot.currentRun=next;h.ui.update();assert.match(links(),/\/export-b\/export\?format=json/,'a background follow-up must not retarget downloads');
  await h.ui.openConversation(a.id);assert.match(links(),/\/export-a-followup\/export\?format=markdown/,'an old turn opens its actual current conversation family');assert.doesNotMatch(links(),/\/export-b\/export/);
});

test('parallel windows preserve independent unsent chat drafts and settings across writes and restart',async t=>{
  const a=fixtureRun('window-a','completed'),b=fixtureRun('window-b','completed'),saved=savedDrafts(''),storage=new Map([['relay.mission.draft',JSON.stringify(saved)]]);
  const first=missionFixture(t,saved,storage),left=mountMission(first,statusSnapshot([a,b]));await turn();await left.ui.openConversation(a.id);
  const second=missionFixture(t,saved,storage),right=mountMission(second,statusSnapshot([a,b]));await turn();await right.ui.openConversation(b.id);
  await left.text('Unsent work in A');await left.model('cloud::chosen');left.ui.setContext({preset:'900k'});await left.effort('ultra');
  await right.text('Unsent work in B');await right.model('cloud::other');right.ui.setContext({preset:'custom',windowTokens:256000});await right.effort('max');
  const persisted=JSON.parse(storage.get('relay.mission.draft')).conversationDrafts;
  assert.equal(persisted[a.id].task,'Unsent work in A');assert.equal(persisted[a.id].model,'cloud::chosen');assert.deepEqual(persisted[a.id].context,{preset:'900k'});assert.equal(persisted[a.id].effort,'ultra');
  assert.equal(persisted[b.id].task,'Unsent work in B');assert.equal(persisted[b.id].effort,'max');assert.deepEqual(persisted[b.id].context,{preset:'custom',windowTokens:256000});
  const restartedFixture=missionFixture(t,{},storage),restarted=mountMission(restartedFixture,statusSnapshot([a,b]));await turn();await restarted.ui.openConversation(a.id);assert.equal(restarted.ui.getDraft().task,'Unsent work in A');assert.equal(restarted.ui.getDraft().effort,'ultra');await restarted.ui.openConversation(b.id);assert.equal(restarted.ui.getDraft().task,'Unsent work in B');assert.equal(restarted.ui.getDraft().model,'cloud::other');assert.deepEqual(restarted.ui.getDraft().context,{preset:'custom',windowTokens:256000});
});

test('a fresh window with unloaded history cannot copy another chat’s draft into an empty New chat', async t => {
  const a = fixtureRun('startup-draft', 'completed'), saved = { modelPreferenceVersion: 2, cwd: 'C:\\fixture', conversationDrafts: {} }, storage = new Map([['relay.mission.draft', JSON.stringify(saved)]]);
  const first = missionFixture(t, saved, storage), left = mountMission(first, statusSnapshot([a])); await turn(); await left.ui.openConversation(a.id); await left.text('Keep this unsent thought.'); await left.model('cloud::chosen');
  const persisted = JSON.parse(storage.get('relay.mission.draft')); assert.equal(persisted.task, 'Keep this unsent thought.'); assert.equal(persisted.conversationDrafts.new, undefined, 'an unchanged empty New draft legitimately has no stored entry');
  const second = missionFixture(t, saved, storage), loading = { ...statusSnapshot([]), statusLoaded: false }, right = mountMission(second, loading); await turn();
  assert.equal(right.ui.getDraft().task, ''); assert.deepEqual(right.ui.getDraft().attachmentIds, []); assert.equal(right.ui.getSelection().forceNew, false);
  loading.runs = [a]; loading.currentRun = a; loading.statusLoaded = true; right.ui.update(); await turn();
  assert.equal(right.ui.getSelection().runId, a.id); assert.equal(right.ui.getDraft().task, 'Keep this unsent thought.'); assert.equal(right.ui.getDraft().model, 'cloud::chosen');
  await right.action('new-task'); assert.equal(right.ui.getSelection().forceNew, true); assert.equal(right.ui.getDraft().task, ''); assert.deepEqual(right.ui.getDraft().attachmentIds, []);
  await right.ui.openConversation(a.id); assert.equal(right.ui.getDraft().task, 'Keep this unsent thought.');
});

test('one window editing model settings cannot overwrite another window’s message in the same chat',async t=>{
  const a=fixtureRun('shared-draft','completed'),saved=savedDrafts(''),storage=new Map([['relay.mission.draft',JSON.stringify(saved)]]),first=missionFixture(t,saved,storage),left=mountMission(first,statusSnapshot([a]));await turn();await left.ui.openConversation(a.id);
  const second=missionFixture(t,saved,storage),right=mountMission(second,statusSnapshot([a]));await turn();await right.ui.openConversation(a.id);
  await left.text('New text typed in the first window');await right.model('cloud::chosen');right.ui.setContext({preset:'900k'});await right.effort('ultra');
  let stored=JSON.parse(storage.get('relay.mission.draft')).conversationDrafts[a.id];assert.equal(stored.task,'New text typed in the first window');assert.equal(stored.model,'cloud::chosen');assert.equal(stored.effort,'ultra');
  await left.text('A further edit from the first window');stored=JSON.parse(storage.get('relay.mission.draft')).conversationDrafts[a.id];assert.equal(stored.model,'cloud::chosen');assert.deepEqual(stored.context,{preset:'900k'});
  await right.action('new-task');await right.ui.openConversation(a.id);assert.equal(right.ui.getDraft().task,'A further edit from the first window');assert.equal(right.ui.getDraft().model,'cloud::chosen');assert.equal(right.ui.getDraft().effort,'ultra');
});

test('finishing a send cannot clear a newer message another window started while the receipt was pending',async t=>{
  const saved=savedDrafts('Send this original task','cloud::chosen'),storage=new Map([['relay.mission.draft',JSON.stringify(saved)]]),first=missionFixture(t,saved,storage);let release;
  const left=mountMission(first,statusSnapshot([]),{start:()=>new Promise(resolve=>{release=resolve;})});await turn();left.ui.submitFocused();const sending=first.form.lastSubmission;await turn();assert.equal(left.starts.length,1);
  const second=missionFixture(t,{},storage),right=mountMission(second,statusSnapshot([]));await turn();await right.text('A new task drafted while the first task was sending');await right.model('cloud::other');right.ui.setContext({preset:'900k'});await right.effort('max');
  release(fixtureRun('accepted-original'));await sending;await turn();const stored=JSON.parse(storage.get('relay.mission.draft')).conversationDrafts.new;
  assert.equal(stored.task,'A new task drafted while the first task was sending');assert.equal(stored.model,'cloud::other');assert.equal(stored.effort,'max');assert.deepEqual(stored.context,{preset:'900k'});assert.equal(stored.pendingSend,undefined);assert.equal(right.ui.getDraft().task,stored.task);
});

test('a failed disk write keeps the local draft through chat switches and retries without erasing another chat',async t=>{
  const a=fixtureRun('storage-a','completed'),b=fixtureRun('storage-b','completed'),saved=savedDrafts(''),storage=new Map([['relay.mission.draft',JSON.stringify(saved)]]),f=missionFixture(t,saved,storage),h=mountMission(f,statusSnapshot([a,b]));await turn();await h.ui.openConversation(a.id);const set=globalThis.localStorage.setItem;let fail=true;globalThis.localStorage.setItem=(key,value)=>{if(fail&&key==='relay.mission.draft')throw new Error('Quota exceeded');set(key,value);};
  await h.text('Only in memory until storage recovers');h.ui.setContext({preset:'900k'});await h.effort('ultra');assert.match(f.element('#mission-draft-state').textContent,/kept in this window/);
  const other=JSON.parse(storage.get('relay.mission.draft'));other.conversationDrafts[b.id]={task:'Another window’s persisted draft',attachmentIds:[],effort:'max'};storage.set('relay.mission.draft',JSON.stringify(other));
  await h.ui.openConversation(b.id);assert.equal(h.ui.getDraft().task,'Another window’s persisted draft');await h.ui.openConversation(a.id);assert.equal(h.ui.getDraft().task,'Only in memory until storage recovers');assert.equal(h.ui.getDraft().effort,'ultra');fail=false;await h.model('cloud::chosen');
  const stored=JSON.parse(storage.get('relay.mission.draft')).conversationDrafts;assert.equal(stored[a.id].task,'Only in memory until storage recovers');assert.equal(stored[a.id].effort,'ultra');assert.equal(stored[b.id].task,'Another window’s persisted draft');assert.equal(f.element('#mission-draft-state').textContent,'');
});

test('another client can rename, archive, trash and restore the selected chat without disturbing its draft or reading position', async t => {
  const a = fixtureRun('metadata-a', 'completed'), b = fixtureRun('metadata-b', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a,b]);
  let bucket = 'active', title = 'Original title';
  const h = mountMission(f, snapshot, { api: async url => url.includes('?state=') ? { conversations: url.endsWith(bucket) ? [{ taskId:a.id,runId:a.id,title,state:bucket }] : [] } : undefined }); await turn();
  await h.ui.openConversation(a.id); await h.text('Unsent thought stays here'); await h.model('cloud::chosen');
  f.element('#mission-task').focus(); const scroll = f.element('#conversation-scroll'); scroll.scrollTop=41; scroll.scrollHeight=600; await scroll.dispatch('scroll', {});
  const before = f.element('#conversation-timeline').children[0], opened = [...h.opened];
  title = 'Renamed from another window'; await h.ui.refreshHistory();
  assert.equal(f.element('#conversation-title').textContent,title); assert.equal(f.element('#conversation-timeline').children[0],before);
  for (const next of ['archived','deleted','active']) { bucket=next; await h.ui.refreshHistory(); assert.equal(f.element('#conversation-state-banner').hidden,next==='active'); assert.equal(f.element('#mission-start-button').disabled,next!=='active'); }
  assert.equal(h.ui.getDraft().task,'Unsent thought stays here'); assert.equal(h.ui.getDraft().model,'cloud::chosen'); assert.equal(globalThis.document.activeElement,f.element('#mission-task')); assert.equal(scroll.scrollTop,41); assert.deepEqual(h.opened,opened); assert.equal(h.ui.getSelection().runId,a.id);
});

test('parallel completions leave compact unread receipts without changing the selected draft, model or chat', async t => {
  const a = fixtureRun('reading-a'), b = fixtureRun('background-b'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(a.id);
  await h.text('An unfinished thought'); await h.model('cloud::chosen');
  b.status = 'completed'; b.settled = true; h.ui.update();
  const list = f.element('#conversation-list'); assert.match(list.innerHTML, /Task background-b · New response/); assert.equal(h.ui.getSelection().runId, a.id); assert.equal(h.ui.getDraft().task, 'An unfinished thought'); assert.equal(h.ui.getDraft().model, 'cloud::chosen');
  f.element('#conversation-history-state').value = 'unread'; await f.mount.dispatch('change', menuEvent(f.element('#conversation-history-state'))); await turn();
  assert.match(list.innerHTML, /background-b/); assert.doesNotMatch(list.innerHTML, /data-conversation-id="reading-a"/);
  await h.ui.openConversation(b.id); assert.doesNotMatch(list.innerHTML, /New response/); assert.match(list.innerHTML, /caught up/);
  await h.ui.openConversation(a.id); assert.equal(h.ui.getDraft().task, 'An unfinished thought'); assert.equal(h.ui.getDraft().model, 'cloud::chosen');
});

test('a hidden or scrolled-up conversation stays unread until its settled response is visibly reached', async t => {
  const a = fixtureRun('visible-response'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(a.id);
  globalThis.document.visibilityState = 'hidden'; a.status = 'completed'; a.settled = true; h.ui.update(); assert.match(f.element('#conversation-list').innerHTML, /New response/);
  const view = f.element('#conversation-scroll'); view.scrollHeight = 2000; view.clientHeight = 500; view.scrollTop = 200; await view.dispatch('scroll', {});
  globalThis.document.visibilityState = 'visible'; await f.documentEvents.dispatch('visibilitychange', {}); assert.match(f.element('#conversation-list').innerHTML, /New response/);
  await h.action('latest'); assert.doesNotMatch(f.element('#conversation-list').innerHTML, /New response/);
  a.updatedAt = '2026-10-19T10:00:00Z'; h.ui.update(); assert.doesNotMatch(f.element('#conversation-list').innerHTML, /New response/, 'bookkeeping timestamp updates do not make the same reply unread again');
});

test('a visible background window keeps the selected response unread until the window regains focus', async t => {
  const a = fixtureRun('unfocused-response'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(a.id);
  await h.text('Keep this unsent thought'); await h.model('cloud::chosen'); const composer = f.element('#mission-task'); composer.focus();
  let focused = false; globalThis.document.visibilityState = 'visible'; globalThis.document.hasFocus = () => focused;
  a.status = 'completed'; a.settled = true; h.ui.update();
  for (const event of ['visibilitychange', 'focusin']) await f.documentEvents.dispatch(event, {}); await f.windowEvents.dispatch('storage', {});
  assert.match(f.element('#conversation-list').innerHTML, /New response/, 'visible background windows must not issue read receipts');
  const scroll = f.element('#conversation-scroll').scrollTop, selection = h.ui.getSelection(); focused = true; await f.windowEvents.dispatch('focus', {});
  assert.doesNotMatch(f.element('#conversation-list').innerHTML, /New response/); assert.deepEqual(h.ui.getSelection(), selection); assert.equal(h.ui.getDraft().task, 'Keep this unsent thought'); assert.equal(h.ui.getDraft().model, 'cloud::chosen'); assert.equal(f.element('#conversation-scroll').scrollTop, scroll); assert.equal(globalThis.document.activeElement, composer);
});

test('returning window focus does not read a response above the viewport or behind a modal', async t => {
  const a = fixtureRun('refocus-scrolled'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(a.id);
  let focused = false, covered = false; globalThis.document.hasFocus = () => focused; globalThis.document.getElementById = id => id === 'modal-root' ? { childElementCount: covered ? 1 : 0 } : null;
  const view = f.element('#conversation-scroll'); view.scrollHeight = 2000; view.clientHeight = 500; view.scrollTop = 200; await view.dispatch('scroll', {});
  a.status = 'completed'; a.settled = true; h.ui.update(); focused = true; await f.windowEvents.dispatch('focus', {}); assert.match(f.element('#conversation-list').innerHTML, /New response/); assert.equal(view.scrollTop, 200);
  covered = true; await h.action('latest'); await f.windowEvents.dispatch('focus', {}); assert.match(f.element('#conversation-list').innerHTML, /New response/);
  covered = false; await f.windowEvents.dispatch('focus', {}); assert.doesNotMatch(f.element('#conversation-list').innerHTML, /New response/);
});

test('destroyed chat views detach the window-focus attention listener', async t => {
  const a = fixtureRun('disposed-focus'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(a.id);
  globalThis.document.hasFocus = () => false; a.status = 'completed'; a.settled = true; h.ui.update(); assert.match(f.element('#conversation-list').innerHTML, /New response/);
  const catalog = f.element('#conversation-list').innerHTML; h.ui.destroy(); globalThis.document.hasFocus = () => true; await f.windowEvents.dispatch('focus', {}); assert.equal(f.element('#conversation-list').innerHTML, catalog);
});

test('a modal covering the selected response keeps it unread until the conversation is visible again', async t => {
  const a = fixtureRun('modal-response'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(a.id);
  let covered = true; globalThis.document.getElementById = id => id === 'modal-root' ? { childElementCount: covered ? 1 : 0 } : null;
  a.status = 'completed'; a.settled = true; h.ui.update(); assert.match(f.element('#conversation-list').innerHTML, /New response/);
  covered = false; await f.documentEvents.dispatch('focusin', {}); assert.doesNotMatch(f.element('#conversation-list').innerHTML, /New response/);
});

test('opening an unread summary whose history cannot load does not mark its response as read', async t => {
  const a = fixtureRun('open-a'), b = fixtureRun('unavailable-b'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]);
  const h = mountMission(f, snapshot, { api: async url => { if (url === '/api/conversations/unavailable-b') throw new Error('Saved history is unavailable.'); } }); await turn(); await h.ui.openConversation(a.id);
  b.status = 'failed'; b.settled = true; h.ui.update(); assert.match(f.element('#conversation-list').innerHTML, /Unseen error/);
  await h.ui.openConversation(b.id); assert.match(f.element('#conversation-history-notice').innerHTML, /Saved history is unavailable/); assert.match(f.element('#conversation-list').innerHTML, /Unseen error/);
});

test('chat switching restores independent reading positions while Latest explicitly resumes following', async t => {
  const a = fixtureRun('scroll-a', 'completed'), b = fixtureRun('scroll-b', 'completed'), f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([a, b])); await turn(); await h.ui.openConversation(a.id);
  const view = f.element('#conversation-scroll'); view.scrollHeight = 2400; view.clientHeight = 500; view.scrollTop = 380; await view.dispatch('scroll', {});
  await h.ui.openConversation(b.id); view.scrollTop = 920; await view.dispatch('scroll', {});
  await h.ui.openConversation(a.id); assert.equal(view.scrollTop, 380); assert.equal(f.element('#conversation-jump').hidden, false);
  await h.ui.openConversation(b.id); assert.equal(view.scrollTop, 920);
  await h.action('latest'); assert.equal(view.scrollTop, 2400); await h.ui.openConversation(a.id); assert.equal(view.scrollTop, 380);
  await h.ui.openConversation(b.id); assert.equal(view.scrollTop, 2400); assert.equal(f.element('#conversation-jump').hidden, true);
});

test('file deliverables and saved milestones remain directly visible and shared older snapshots do not duplicate them', async t => {
  const a = fixtureRun('files-a', 'completed'), b = { ...fixtureRun('files-b', 'completed'), taskId: a.id, parentRunId: a.id, createdAt: '2026-10-16T11:00:00Z' };
  const taskState = { taskId: a.id, revision: 1, artifacts: [{ id: 'svg-file', title: 'Chess board', fileName: 'board.svg', path: 'C:\\fixture\\board.svg', kind: 'image', size: 2048 }], steps: [{ id: 'step-1', title: 'Make the board', status: 'done' }] };
  a.taskState = taskState; b.taskState = taskState;
  const f = missionFixture(t, savedDrafts('')), h = mountMission(f, statusSnapshot([a, b])); await turn(); await h.ui.openConversation(b.id);
  const sections = f.element('#conversation-timeline').children; assert.equal(sections.length, 2);
  assert.equal(sections[0].querySelector('.conversation-files-slot').hidden, true); assert.equal(sections[1].querySelector('.conversation-files-slot').hidden, false);
  assert.match(sections[1].querySelector('.conversation-files-slot').innerHTML, /board.svg/);
  assert.match(sections[1].querySelector('.conversation-work-slot').innerHTML, /aria-label="Saved milestones"/);
  assert.doesNotMatch(sections[1].querySelector('.conversation-work-slot').innerHTML, /<details class="conversation-work"/);
  assert.doesNotMatch(sections[1].querySelector('.conversation-work-slot').innerHTML, /board.svg|Plan &amp; files|Plan & files/);
});

test('Draft next action keeps unfinished milestones on a finished response and uses the normal durable continuation path', async t => {
  const run = fixtureRun('milestone-next', 'completed'); run.taskState = { taskId: run.id, revision: 1, steps: [{ id: 'build', title: 'Build the result', status: 'done' }, { id: 'verify', title: 'Verify keyboard controls', status: 'pending', doneWhen: 'Every control works with a keyboard.' }], checkpoint: { nextSteps: ['Old broader instruction'] } };
  const saved = savedDrafts(''); saved.conversationDrafts[run.id] = { task: '', model: 'cloud::chosen', effort: 'ultra', context: { preset: '900k' }, attachmentIds: ['kept-file'] };
  const f = missionFixture(t, saved), h = mountMission(f, statusSnapshot([run])); await turn(); await h.ui.openConversation(run.id); const before = h.ui.getDraft(), work = f.element('#conversation-timeline').children[0].querySelector('.conversation-work-slot');
  assert.match(work.innerHTML, /Draft next action/); assert.doesNotMatch(work.innerHTML, /Make repeatable/); assert.match(work.innerHTML, /Next<\/span><strong>Verify keyboard controls/); assert.match(work.innerHTML, /1<span> \/ 2 done/);
  await h.action('continue-milestone', { id: run.id }); assert.match(h.ui.getDraft().task, /Next action: Verify keyboard controls/); assert.doesNotMatch(h.ui.getDraft().task, /Old broader instruction/); assert.match(h.ui.getDraft().task, /Done when: Every control works/);
  assert.deepEqual({ ...h.ui.getDraft(), task: before.task }, before); assert.equal(h.mutations.length, 0); assert.equal(h.starts.length, 0); assert.equal(h.queued.length, 0);
  await h.submit(); const sent = h.mutations.find(item => item.continue).continue; assert.equal(sent.runId, run.id); assert.match(sent.message, /Next action: Verify keyboard controls/); assert.equal(sent.model, 'cloud::chosen'); assert.equal(sent.effort, 'ultra'); assert.deepEqual(sent.context, { preset: '900k' }); assert.deepEqual(sent.attachmentIds, ['kept-file']); assert.equal(run.taskState.steps[1].status, 'pending');
});

test('Draft next action preserves existing local and newer cross-window drafts and ignores superseded or active runs', async t => {
  const first = fixtureRun('milestone-old', 'completed'), run = { ...fixtureRun('milestone-current', 'completed'), taskId: first.id, parentRunId: first.id, createdAt: '2026-10-16T11:00:00Z' };
  first.taskState = { taskId: first.id, revision: 1, steps: [{ id: 'step', title: 'Old step', status: 'active' }] }; run.taskState = { taskId: first.id, revision: 2, steps: [{ id: 'step', title: 'Current step', status: 'active' }] };
  const f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([first, run]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(run.id);
  await h.text('My unsent message'); await h.action('continue-milestone', { id: run.id }); assert.equal(h.ui.getDraft().task, 'My unsent message'); assert.match(h.errors.at(-1).message, /draft is kept/);
  await h.text(''); const remote = h.persisted(); remote.conversationDrafts[first.id].task = 'Newer remote draft'; f.storage.set('relay.mission.draft', JSON.stringify(remote)); await h.action('continue-milestone', { id: run.id }); assert.equal(h.ui.getDraft().task, ''); assert.equal(h.persisted().conversationDrafts[first.id].task, 'Newer remote draft'); assert.match(h.errors.at(-1).message, /another BLACKICE window/);
  await h.action('continue-milestone', { id: first.id }); assert.equal(h.ui.getDraft().task, ''); run.status = 'running'; run.settled = false; h.ui.update(); await h.action('continue-milestone', { id: run.id }); assert.equal(h.ui.getDraft().task, ''); assert.equal(h.mutations.length, 0);
});

test('Make repeatable opens a setup seed only for completed saved milestones, without changing the run or draft', async t => {
  const run = fixtureRun('repeatable-task', 'completed'); run.taskState = { taskId: run.id, revision: 1, steps: [{ id: 'deliver', title: 'Deliver the result', status: 'done', evidence: 'Checked the actual result.' }] };
  const repeats = [], f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]), h = mountMission(f, snapshot, { repeatTask: seed => repeats.push(seed) }); await turn(); await h.ui.openConversation(run.id); await h.text('Keep my follow-up'); const before = structuredClone(run), draft = h.ui.getDraft();
  assert.match(f.element('#conversation-timeline').children[0].querySelector('.conversation-work-slot').innerHTML, /Make repeatable/); await h.action('repeat-task', { id: run.id });
  assert.equal(repeats.length, 1); assert.equal(repeats[0].runId, run.id); assert.equal(repeats[0].taskId, run.id); assert.equal(repeats[0].task, run.input); assert.equal(repeats[0].cwd, run.cwd); assert.deepEqual(run, before); assert.deepEqual(h.ui.getDraft(), draft); assert.equal(h.mutations.length, 0); assert.equal(h.starts.length, 0);
  run.taskState = { ...run.taskState, revision: 2, steps: [{ id: 'deliver', title: 'Deliver the result', status: 'pending' }] }; h.ui.update(); assert.doesNotMatch(f.element('#conversation-timeline').children[0].querySelector('.conversation-work-slot').innerHTML, /Make repeatable/); await h.action('repeat-task', { id: run.id }); assert.equal(repeats.length, 1);
});

test('a selected milestone stays readable during updates and refreshes when the selection ends without moving the reader', async t => {
  const run = fixtureRun('selected-milestone', 'completed'); run.taskState = { taskId: run.id, revision: 1, steps: [{ id: 'check', title: 'Initial saved step', status: 'active' }] };
  const f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]), h = mountMission(f, snapshot); await turn(); await h.ui.openConversation(run.id);
  const work = f.element('#conversation-timeline').children[0].querySelector('.conversation-work-slot'), view = f.element('#conversation-scroll'); view.scrollHeight = 1800; view.clientHeight = 500; view.scrollTop = 320; await view.dispatch('scroll', {});
  let selecting = true; globalThis.window.getSelection = () => ({ isCollapsed: !selecting, containsNode: target => selecting && target === work }); run.taskState = { ...run.taskState, revision: 2, steps: [{ id: 'check', title: 'Newer saved step', status: 'blocked', blockedReason: 'Target is unavailable.' }] }; h.ui.update();
  assert.match(work.innerHTML, /Initial saved step/); assert.doesNotMatch(work.innerHTML, /Newer saved step/); assert.equal(view.scrollTop, 320);
  selecting = false; await f.documentEvents.dispatch('selectionchange', {}); assert.match(work.innerHTML, /Newer saved step/); assert.doesNotMatch(work.innerHTML, /Initial saved step/); assert.equal(view.scrollTop, 320);
  h.ui.destroy(); run.taskState = { ...run.taskState, revision: 3, steps: [] }; await f.documentEvents.dispatch('selectionchange', {}); assert.match(work.innerHTML, /Newer saved step/);
});

test('history event bursts coalesce and an invalidated catalog response cannot resurrect archived or trashed metadata', async t => {
  const a=fixtureRun('stale-catalog','completed'),f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a]); let phase='initial',calls=0; const held=[];
  const h=mountMission(f,snapshot,{api:async url=>{if(!url.includes('?state='))return;calls++;const bucket=url.split('=').at(-1);if(phase==='held')return new Promise(resolve=>held.push(()=>resolve({conversations:bucket==='active'?[{taskId:a.id,runId:a.id,title:'Stale active title'}]:[]})));return{conversations:bucket===(phase==='latest'?'deleted':'active')?[{taskId:a.id,runId:a.id,title:phase==='latest'?'Latest trash title':'Initial title'}]:[]};}});await turn();await h.ui.openConversation(a.id);
  phase='held'; const stale=h.ui.refreshHistory({immediate:true}); await turn(); assert.equal(held.length,3); const before=calls;
  const burst=Array.from({length:40},()=>h.ui.refreshHistory()); phase='latest'; held.forEach(release=>release()); await turn();
  assert.notEqual(f.element('#conversation-title').textContent,'Stale active title','a newer event invalidates all older buckets before they render');
  await Promise.all([stale,...burst]); assert.equal(calls,before+3,'forty updates require one replacement catalog batch');
  assert.equal(f.element('#conversation-title').textContent,'Latest trash title'); assert.match(f.element('#conversation-state-banner').innerHTML,/In Trash/); assert.equal(f.element('#mission-start-button').disabled,true);
});

test('a partial catalog refresh preserves the last consistent metadata instead of mixing archive states', async t=>{
  const a=fixtureRun('atomic-catalog','completed'),f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a]);let failed=false;
  const h=mountMission(f,snapshot,{api:async url=>{if(!url.includes('?state='))return;if(failed&&url.endsWith('deleted'))throw new Error('History is temporarily offline.');return{conversations:url.endsWith(failed?'active':'archived')?[{taskId:a.id,runId:a.id,title:failed?'Uncommitted active':'Saved archive'}]:[]};}});await turn();await h.ui.openConversation(a.id);assert.equal(f.element('#conversation-title').textContent,'Saved archive');
  failed=true;assert.equal(await h.ui.refreshHistory(),false);assert.equal(f.element('#conversation-title').textContent,'Saved archive');assert.match(f.element('#conversation-state-banner').innerHTML,/Archived/);assert.equal(f.element('#mission-start-button').disabled,true);assert.match(f.element('#conversation-sidebar-error-text').textContent,/temporarily offline/);
});

test('chat-list Retry keeps the cached list and focused control while loading, and preserves the current draft and filter', async t => {
  const a = fixtureRun('catalog-retry', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]), reads = [], pending = []; let phase = 'initial';
  const result = (bucket, title = 'Cached conversation') => ({ conversations: bucket === 'active' ? [{ taskId: a.id, runId: a.id, title }] : [] });
  const h = mountMission(f, snapshot, { api: async url => { if (!url.includes('?state=')) return; const bucket = url.split('=').at(-1); reads.push(url); if (phase === 'failed') throw new Error('Cannot load chats right now.'); if (phase === 'held') return new Promise(resolve => pending.push(() => resolve(result(bucket, 'Cached conversation refreshed')))); return result(bucket); } }); await turn(); await h.ui.openConversation(a.id); await h.text('Keep my catalog-retry draft'); await h.model('cloud::chosen');
  const search = f.element('#conversation-search'); search.value = 'Cached'; await f.mount.dispatch('input', { target: search }); const cached = f.element('#conversation-list').innerHTML, selection = h.ui.getSelection();
  phase = 'failed'; assert.equal(await h.ui.refreshHistory({ immediate: true }), false); assert.equal(f.element('#conversation-sidebar-error').hidden, false); assert.match(f.element('#conversation-sidebar-error-text').textContent, /Cannot load chats/);
  phase = 'held'; const button = f.element('#conversation-sidebar-retry'); button.focus(); const retrying = f.mount.dispatch('click', { target: button }); await turn(); const count = reads.length;
  assert.equal(pending.length, 3); assert.equal(button.getAttribute('aria-disabled'), 'true'); assert.equal(button.textContent, 'Retrying…'); assert.equal(globalThis.document.activeElement, button); assert.equal(f.element('#conversation-list').innerHTML, cached);
  await h.action('retry-chats'); await h.action('retry-chats'); assert.equal(reads.length, count, 'repeated Retry clicks must share the existing batch'); pending.forEach(resolve => resolve()); await retrying;
  assert.equal(f.element('#conversation-sidebar-error').hidden, true); assert.equal(button.getAttribute('aria-disabled'), 'false'); assert.equal(globalThis.document.activeElement, search, 'a disappearing Retry returns focus to chat search'); assert.match(f.element('#conversation-list').innerHTML, /Cached conversation refreshed/);
  assert.equal(search.value, 'Cached'); assert.equal(f.element('#conversation-history-state').value, 'active'); assert.deepEqual(h.ui.getSelection(), selection); assert.equal(h.ui.getDraft().task, 'Keep my catalog-retry draft'); assert.equal(h.ui.getDraft().model, 'cloud::chosen'); assert.deepEqual(h.mutations, []);
});

test('chat-list Retry joins a background refresh, remains recoverable after failure, and does not pull focus back', async t => {
  const a = fixtureRun('retry-join', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]), pending = []; let phase = 'initial', reads = 0;
  const h = mountMission(f, snapshot, { api: async url => { if (!url.includes('?state=')) return; reads++; const bucket = url.split('=').at(-1); if (phase === 'failed') throw new Error('Catalog unavailable.'); if (phase === 'held') return new Promise((resolve, reject) => pending.push({ resolve, reject, bucket })); return { conversations: bucket === 'active' ? [{ taskId: a.id, runId: a.id, title: 'Existing conversation' }] : [] }; } }); await turn(); await h.ui.openConversation(a.id); await h.text('Another retained draft'); const cached = f.element('#conversation-list').innerHTML;
  phase = 'failed'; await h.ui.refreshHistory({ immediate: true }); phase = 'held'; const automatic = h.ui.refreshHistory({ immediate: true }); await turn(); const count = reads, button = f.element('#conversation-sidebar-retry'); button.focus(); const retrying = f.mount.dispatch('click', { target: button }); await turn(); assert.equal(reads, count, 'Retry joins an already running catalog refresh');
  for (const request of pending) request.reject(new Error('Still unavailable.')); await Promise.all([automatic, retrying]); assert.equal(reads, count); assert.equal(globalThis.document.activeElement, button); assert.equal(button.getAttribute('aria-disabled'), 'false'); assert.equal(button.textContent, 'Retry'); assert.equal(f.element('#conversation-sidebar-error').hidden, false); assert.match(f.element('#conversation-sidebar-error-text').textContent, /Still unavailable/); assert.equal(f.element('#conversation-list').innerHTML, cached);
  pending.length = 0; const recovering = f.mount.dispatch('click', { target: button }); await turn(); const composer = f.element('#mission-task'); composer.focus(); for (const request of pending) request.resolve({ conversations: request.bucket === 'active' ? [{ taskId: a.id, runId: a.id, title: 'Existing conversation' }] : [] }); await recovering;
  assert.equal(f.element('#conversation-sidebar-error').hidden, true); assert.equal(globalThis.document.activeElement, composer, 'a late success must respect where the user moved focus'); assert.equal(h.ui.getDraft().task, 'Another retained draft'); assert.deepEqual(h.mutations, []);
});

test('destroying a chat view prevents a late history response from changing its metadata',async t=>{
  const a=fixtureRun('disposed','completed'),f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a]);let hold=false;const releases=[];
  const h=mountMission(f,snapshot,{api:async url=>{if(!url.includes('?state='))return;if(hold)return new Promise(resolve=>releases.push(()=>resolve({conversations:[{taskId:a.id,runId:a.id,title:'Late replacement'}]})));return{conversations:[]};}});await turn();await h.ui.openConversation(a.id);hold=true;const pending=h.ui.refreshHistory({immediate:true});await turn();const title=f.element('#conversation-title').textContent;h.ui.destroy();assert.equal(await pending,false);releases.forEach(release=>release());await turn();assert.equal(f.element('#conversation-title').textContent,title);
});

test('context and reasoning are optional per-chat choices that continue the selected conversation exactly',async t=>{
  const a=fixtureRun('context-a','completed'),b=fixtureRun('context-b','completed');a.workflow.settings={context:{preset:'900k'}};a.workflow.nodes[0].effort='medium';b.workflow.nodes[0].context={preset:'custom',windowTokens:64000};b.workflow.nodes[0].effort='high';
  const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a,b]),h=mountMission(f,snapshot);await turn();await h.action('new-task');assert.equal(h.ui.getDraft().effort,'default');assert.equal(h.ui.getDraft().context,undefined);
  await h.ui.openConversation(a.id);assert.deepEqual(h.ui.getDraft().context,{preset:'900k'});assert.equal(h.ui.getDraft().effort,'medium');h.ui.setContext({preset:'custom',windowTokens:128000});await h.effort('ultra');await h.text('Continue A with my exact settings');
  await h.ui.openConversation(b.id);assert.deepEqual(h.ui.getDraft().context,{preset:'custom',windowTokens:64000});assert.equal(h.ui.getDraft().effort,'high');h.ui.setContext({preset:'model'});await h.effort('max');
  await h.ui.openConversation(a.id);assert.deepEqual(h.ui.getDraft().context,{preset:'custom',windowTokens:128000});assert.equal(h.ui.getDraft().effort,'ultra');await h.submit();
  const sent=h.mutations.find(item=>item.continue).continue;assert.equal(sent.runId,a.id);assert.equal(sent.effort,'ultra');assert.deepEqual(sent.context,{preset:'custom',windowTokens:128000});assert.equal(b.workflow.nodes[0].effort,'high');
  await h.action('new-task');assert.equal(h.ui.getDraft().effort,'default');assert.equal(h.ui.getDraft().context,undefined);assert.deepEqual(h.persisted().conversationDrafts[a.id].context,{preset:'custom',windowTokens:128000});
});

test('collapsed Reasoning shows the selected chat settings compactly and resets without replacing focused controls',async t=>{
  const a=fixtureRun('summary-a','completed'),b=fixtureRun('summary-b','completed');a.workflow.settings={context:{preset:'900k'}};a.workflow.nodes[0].effort='default';b.workflow.nodes[0].effort='max';
  const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([a,b]),h=mountMission(f,snapshot);await turn();const summary=()=>f.element('#mission-context').querySelector('summary'), summaryValue=()=>summary().innerHTML.match(/class="conversation-setting-value">([^<]*)</)?.[1];
  await h.action('new-task');assert.equal(summaryValue(),'Default');await h.effort('ultra');assert.equal(summaryValue(),'Ultra');h.ui.setContext({preset:'900k'});assert.equal(summaryValue(),'Ultra · 900k');assert.match(summary().getAttribute('aria-label'),/Reasoning settings: Ultra · 900k/);assert.match(summary().title,/900,000 tokens requested/);
  const effort=f.element('#mission-effort'),fields=f.element('#mission-context-fields');f.element('#mission-context').open=true;effort.focus();const choices=effort.innerHTML,markup=fields.innerHTML;h.ui.update();assert.equal(f.element('#mission-effort'),effort);assert.equal(effort.innerHTML,choices);assert.equal(fields.innerHTML,markup);assert.equal(globalThis.document.activeElement,effort);assert.equal(f.element('#mission-context').open,true);
  h.ui.setContext({preset:'custom',windowTokens:256000});assert.equal(summaryValue(),'Ultra · 256k');await h.effort('default');assert.equal(summaryValue(),'256k');await h.action('reset-context');assert.equal(summaryValue(),'Default');
  await h.ui.openConversation(a.id);assert.equal(summaryValue(),'900k');await h.effort('ultra');assert.equal(summaryValue(),'Ultra · 900k');h.ui.setContext({preset:'custom',windowTokens:128000});assert.equal(summaryValue(),'Ultra · 128k');await h.action('reset-context');assert.equal(summaryValue(),'Ultra · 900k','reset restores this chat’s saved context while retaining its chosen reasoning');
  await h.ui.openConversation(b.id);assert.equal(summaryValue(),'Max');await h.ui.openConversation(a.id);assert.equal(summaryValue(),'Ultra · 900k');await h.action('new-task');assert.equal(summaryValue(),'Default','a new-chat default is independent of the saved chat settings');
});

test('model changes keep an unavailable reasoning override visible and block sending until the user chooses a supported level',async t=>{
  const f=missionFixture(t,savedDrafts('Use maximum reasoning')),snapshot=statusSnapshot([]);snapshot.status.models[1].supportedReasoningEfforts=[{reasoningEffort:'medium'},{reasoningEffort:'max'},{reasoningEffort:'ultra'}];snapshot.status.models[2].supportedReasoningEfforts=['low','high'];
  const h=mountMission(f,snapshot);await turn();await h.model('cloud::chosen');await h.effort('ultra');assert.match(f.element('#mission-effort').innerHTML,/value="max"/);assert.match(f.element('#mission-effort').innerHTML,/value="ultra" selected/);assert.equal(f.element('#mission-start-button').disabled,false);
  await h.model('cloud::other');assert.equal(h.ui.getDraft().effort,'ultra');assert.match(f.element('#mission-effort').innerHTML,/Ultra · unavailable/);assert.equal(f.element('#mission-start-button').disabled,true);assert.match(f.element('#mission-reasoning-warning').textContent,/does not offer Ultra/);await h.submit();assert.equal(h.starts.length,0);assert.equal(f.element('#mission-context').open,true);
  await h.effort('default');assert.equal(f.element('#mission-start-button').disabled,false);await h.submit();assert.equal(h.starts.length,1);assert.equal(h.starts[0].effort,'default');
});

test('unverified reasoning and context survive ambiguous submissions and changes create a fresh request',async t=>{
  const f=missionFixture(t,savedDrafts('Try exact provider settings')),snapshot=statusSnapshot([]);let attempts=0;
  const h=mountMission(f,snapshot,{start:async()=>{if(++attempts<3)throw new Error('Response lost.');}});await turn();h.ui.setContext({preset:'900k'});await h.effort('max');await h.submit();const request=h.starts[0];assert.equal(request.effort,'max');assert.deepEqual(request.context,{preset:'900k'});assert.match(f.element('#mission-effort-note').textContent,/unverified/);
  await h.submit();assert.equal(h.starts[1].requestId,request.requestId);assert.equal(h.starts[1].effort,'max');assert.deepEqual(h.persisted().conversationDrafts.new.pendingSend.config.context,{preset:'900k'});
  await h.effort('ultra');assert.equal(h.persisted().conversationDrafts.new.pendingSend,undefined);await h.submit();assert.notEqual(h.starts[2].requestId,request.requestId);assert.equal(h.starts[2].effort,'ultra');assert.equal(h.ui.getDraft().effort,'default');assert.equal(h.ui.getDraft().context,undefined,'one-off new-chat settings do not become application defaults');
});

test('context editor validates before sending and keeps focused fields intact during live metadata updates',async t=>{
  const f=missionFixture(t,savedDrafts('Send after fixing context')),snapshot=statusSnapshot([]),h=mountMission(f,snapshot);await turn();
  const container=f.element('#mission-context-fields'),field=f.element('context-input'),fields=f.element('context-fields');field.dataset={contextOption:'windowTokens'};field.type='number';field.value='100';field.checkValidity=()=>true;field.closest=query=>query==='[data-context-fields]'?fields:null;fields.dataset.contextFields='mission-chat-context';fields.querySelectorAll=query=>query==='[data-context-option]'?[{dataset:{contextOption:'preset'},type:'select-one',value:'custom'},field]:[field];container.querySelectorAll=query=>query==='[data-context-fields]'?[fields]:[];container.contains=value=>value===field;field.focus();
  const markup=container.innerHTML;await f.mount.dispatch('input',{target:field});assert.equal(f.element('#mission-start-button').disabled,true);assert.match(f.element('#mission-context-error').textContent,/4,096/);await h.submit();assert.equal(h.starts.length,0);
  await h.ui.refreshHistory();assert.equal(container.innerHTML,markup);assert.equal(globalThis.document.activeElement,field);
  field.value='96000';await f.mount.dispatch('input',{target:field});assert.equal(f.element('#mission-start-button').disabled,false);await h.submit();assert.deepEqual(h.starts[0].context,{preset:'custom',windowTokens:96000});
});

test('Save for later cannot also start work through Enter, Ctrl+Enter or a direct form submission', async t => {
  const f = missionFixture(t), starts = [], captures = [], directions = []; let release;
  const held = new Promise(resolve => { release = resolve; });
  const snapshot = { statusLoaded: true, status: { cwd: 'C:\\fixture', connected: true, authenticated: true, defaultModel: 'cloud::default', models: [{ id: 'cloud::default', available: true }, { id: 'cloud::chosen', available: true }] }, runs: [], currentRun: null, desktop: {}, streamState: 'live' };
  const ui = initMissionUI({ mount: f.mount, getSnapshot: () => snapshot,
    onStart: async config => { starts.push(config); }, onCapture: async config => { captures.push(config); return held; }, onInbox() {},
    api: async (url, method, body) => { if (method) directions.push({ url, body }); return url === '/api/attachments' ? [] : { conversations: [] }; },
    escape: value => String(value ?? ''), icon: () => '', toast() {},
  });
  await turn();
  const capturing = f.mount.dispatch('click', { target: f.element('#mission-capture-button') }); await turn();
  assert.equal(captures.length, 1); assert.equal(captures[0].model, 'cloud::chosen'); assert.equal(f.element('#mission-task').readOnly, true); assert.equal(f.element('#mission-start-button').disabled, true);
  const keyboard = ctrlKey => ({ target: f.element('#mission-task'), key: 'Enter', ctrlKey, preventDefault() {}, stopPropagation() {} });
  await f.mount.dispatch('keydown', keyboard(false)); await f.mount.dispatch('keydown', keyboard(true));
  assert.equal(f.submissions(), 0, 'readonly textarea shortcuts must not request form submission');
  ui.submitFocused(); await f.form.lastSubmission;
  await f.mount.dispatch('submit', { target: f.form, preventDefault() {} });
  assert.deepEqual(starts, []); assert.deepEqual(directions, []); assert.equal(captures.length, 1);
  release({ id: 'fixture-inbox' }); await capturing; await turn();
  assert.equal(ui.getDraft().task, ''); assert.equal(ui.getDraft().model, 'default', 'a consumed new-chat model does not become the next chat default');
  assert.equal(f.element('#mission-task').readOnly, false);
  f.element('#mission-task').value = 'Now start a different task'; await f.mount.dispatch('input', { target: f.element('#mission-task') });
  ui.submitFocused(); await f.form.lastSubmission;
  assert.equal(starts.length, 1, 'ordinary sending still works after capture finishes'); assert.equal(starts[0].task, 'Now start a different task'); assert.equal(starts[0].model, 'default');
});

test('a new message explicitly queues behind another working chat with its concrete model and does not navigate away', async t => {
  const f = missionFixture(t, savedDrafts()), snapshot = statusSnapshot([fixtureRun('working')]), h = mountMission(f, snapshot); await turn();
  assert.equal(f.element('#mission-start-button').disabled, false, 'a waiting new task must remain actionable');
  assert.match(f.element('#mission-start-button').title, /queue/i);
  await h.submit();
  assert.equal(h.queued.length, 1); assert.equal(h.queued[0].task, 'Queue this next'); assert.equal(h.queued[0].model, 'cloud::default'); assert.equal(h.queued[0].cwd, 'C:\\fixture');
  assert.equal(typeof h.queued[0].enqueueKey, 'string'); assert.ok(h.queued[0].enqueueKey.length >= 16);
  assert.deepEqual(h.starts, []); assert.deepEqual(h.captures, []); assert.deepEqual(h.inbox, []); assert.deepEqual(h.opened, []);
  assert.equal(f.element('#conversation-title').textContent, '', 'an Inbox receipt must not become the selected conversation');
  assert.equal(h.ui.getDraft().task, ''); assert.equal(h.ui.getDraft().model, 'default'); assert.equal(h.persisted().conversationDrafts.new.pendingSend, undefined);
  assert.equal(f.element('#conversation-queue-receipt').hidden, false); assert.match(f.element('#conversation-queue-receipt').innerHTML, /Open task/);
  await h.text('An unsent draft I am working on');
  const scheduled = fixtureRun('queued-execution'); snapshot.runs.unshift(scheduled); snapshot.currentRun = scheduled; h.ui.update();
  assert.equal(f.element('#conversation-title').textContent, '', 'a background queue launch cannot steal the new-chat view'); assert.equal(h.ui.getDraft().task, 'An unsent draft I am working on');
});

test('queueing is reserved for new chats: live replies steer, and another saved chat cannot enqueue a continuation', async t => {
  const working = fixtureRun('working'), completed = fixtureRun('saved', 'completed'), f = missionFixture(t, savedDrafts()), snapshot = statusSnapshot([working, completed]);
  const h = mountMission(f, snapshot, { api: async url => url.endsWith('/steer') ? { accepted: true, delivery: 'queued' } : undefined }); await turn();
  await h.ui.openConversation(working.id); await turn(); await h.text('Keep the focus on the first task'); await h.submit();
  assert.equal(h.queued.length, 0); assert.equal(h.mutations.filter(call => call.url?.endsWith('/steer')).length, 1); assert.equal(h.mutations[0].body.message, 'Keep the focus on the first task');
  await h.ui.openConversation(completed.id); await turn(); await h.text('Continue the saved task');
  assert.equal(f.element('#mission-start-button').disabled, true, 'continuing a different saved chat should remain blocked by the working run');
  await h.submit(); assert.equal(h.queued.length, 0); assert.equal(h.starts.length, 0); assert.equal(h.mutations.filter(call => call.continue).length, 0);
});

test('an ambiguous queue response keeps a durable enqueue key and retries that receipt even after the active run finishes', async t => {
  const f = missionFixture(t, savedDrafts()), working = fixtureRun('working'), snapshot = statusSnapshot([working]); let attempts = 0;
  const h = mountMission(f, snapshot, { queue: async () => { if (++attempts === 1) throw new Error('Connection lost after request was sent. Try again to check the same task.'); return { id: 'accepted-original', status: 'queued' }; } }); await turn();
  await h.submit(); assert.equal(h.queued.length, 1); assert.equal(h.ui.getDraft().task, 'Queue this next');
  const pending = h.persisted().conversationDrafts.new.pendingSend;
  assert.equal(pending.mode, 'queue'); assert.equal(pending.config.task, 'Queue this next'); assert.equal(pending.config.model, 'cloud::default');
  assert.match(f.element('#mission-error').textContent, /Connection lost/);
  working.status = 'completed'; working.settled = true; snapshot.status.defaultModel = 'cloud::other'; h.ui.update();
  await h.submit(); assert.equal(h.queued.length, 2); assert.equal(h.queued[1].enqueueKey, h.queued[0].enqueueKey); assert.equal(h.queued[1].model, 'cloud::default', 'a retry must keep the already submitted model snapshot');
  assert.equal(h.starts.length, 0, 'receipt recovery cannot become a separate immediate task'); assert.equal(h.ui.getDraft().task, ''); assert.equal(h.persisted().conversationDrafts.new.pendingSend, undefined);
});

test('an interrupted queue receipt survives a window reload without creating an immediate duplicate', async t => {
  let persisted, enqueueKey;
  await t.test('persist the unresolved request', async child => {
    const f = missionFixture(child, savedDrafts('Persist this task', 'cloud::chosen')), snapshot = statusSnapshot([fixtureRun('working')]);
    const h = mountMission(f, snapshot, { queue: async () => { throw new Error('The connection was interrupted.'); } }); await turn(); await h.submit();
    assert.equal(h.queued.length, 1); enqueueKey = h.queued[0].enqueueKey; persisted = h.persisted(); assert.equal(persisted.conversationDrafts.new.pendingSend.mode, 'queue');
  });
  await t.test('recover the same request after reload', async child => {
    const f = missionFixture(child, persisted), snapshot = statusSnapshot([fixtureRun('working', 'completed')]), h = mountMission(f, snapshot); await turn(); await h.submit();
    assert.equal(h.queued.length, 1); assert.equal(h.queued[0].enqueueKey, enqueueKey); assert.equal(h.queued[0].task, 'Persist this task'); assert.equal(h.queued[0].model, 'cloud::chosen');
    assert.equal(h.starts.length, 0); assert.equal(h.persisted().conversationDrafts.new.pendingSend, undefined);
  });
});

test('an unresolved queue receipt can be recovered when its saved model is now offline', async t => {
  const f = missionFixture(t, savedDrafts('Recover the task already submitted', 'cloud::chosen')), working = fixtureRun('working'), snapshot = statusSnapshot([working]); let attempts = 0;
  const h = mountMission(f, snapshot, { queue: async () => { if (++attempts === 1) throw new Error('Response lost after submission.'); return { id: 'original-accepted-task', status: 'queued' }; } }); await turn(); await h.submit();
  const key = h.queued[0].enqueueKey;
  working.status = 'completed'; working.settled = true; snapshot.status.models = snapshot.status.models.map(model => ({ ...model, available: false })); snapshot.status.defaultModelAvailable = false; h.ui.update();
  await h.submit();
  assert.equal(h.queued.length, 2); assert.equal(h.queued[1].enqueueKey, key); assert.equal(h.queued[1].model, 'cloud::chosen');
  assert.deepEqual(h.connections, [], 'receipt recovery must not send the user to provider setup'); assert.deepEqual(h.starts, []); assert.equal(h.ui.getDraft().task, '');
});

test('an unresolved start receipt can be recovered after its provider goes offline without changing the original request',async t=>{
  const f=missionFixture(t,savedDrafts('Recover my already submitted task','cloud::chosen')),snapshot=statusSnapshot([]);let attempts=0;
  const h=mountMission(f,snapshot,{start:async()=>{if(++attempts===1)throw new Error('Response lost after admission.');return fixtureRun('accepted-start','completed');}});await turn();await h.submit();const original=h.starts[0];snapshot.status.models=snapshot.status.models.map(model=>({...model,available:false}));snapshot.status.defaultModelAvailable=false;h.ui.update();assert.equal(f.element('#mission-start-button').disabled,false);assert.match(f.element('#mission-start-button').title,/Recover submitted message/);await h.submit();assert.equal(h.starts.length,2);assert.equal(h.starts[1].requestId,original.requestId);assert.equal(h.starts[1].model,'cloud::chosen');assert.deepEqual(h.connections,[]);assert.equal(h.ui.getDraft().task,'');
});

test('an unresolved continuation receipt is recoverable when capacity fills and its saved model is offline',async t=>{
  const saved=fixtureRun('saved-receipt','completed'),f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([saved]);snapshot.status.execution={capacity:1,activeCount:0};let attempts=0;
  const h=mountMission(f,snapshot,{continue:async()=>{if(++attempts===1)throw new Error('Continuation accepted; response lost.');return{...fixtureRun('accepted-continuation','completed'),taskId:saved.taskId,parentRunId:saved.id};}});await turn();await h.ui.openConversation(saved.id);await h.text('Continue this exact accepted request');await h.model('cloud::chosen');await h.effort('ultra');h.ui.setContext({preset:'900k'});await h.submit();const original=h.mutations.find(value=>value.continue).continue;
  snapshot.runs.push(fixtureRun('other-active'));snapshot.status.execution={capacity:1,activeCount:1,availableSlots:0};snapshot.status.models=snapshot.status.models.map(model=>({...model,available:false,supportedReasoningEfforts:['low']}));h.ui.update();assert.equal(f.element('#mission-start-button').disabled,false);await h.submit();const receipts=h.mutations.filter(value=>value.continue).map(value=>value.continue);assert.equal(receipts.length,2);assert.deepEqual(receipts[1],original);assert.deepEqual(h.connections,[]);assert.deepEqual(h.queued,[]);assert.equal(h.ui.getDraft().task,'');
});

for (const edit of ['text', 'model']) test(`editing ${edit} invalidates an unresolved queue request and creates a new task key`, async t => {
  const f = missionFixture(t, savedDrafts()), snapshot = statusSnapshot([fixtureRun('working')]); let attempts = 0;
  const h = mountMission(f, snapshot, { queue: async () => { if (++attempts === 1) throw new Error('The response was interrupted.'); return { id: 'new-task', status: 'queued' }; } }); await turn();
  await h.submit(); const originalKey = h.queued[0].enqueueKey; assert.ok(h.persisted().conversationDrafts.new.pendingSend);
  if (edit === 'text') await h.text('An intentionally different task'); else await h.model('cloud::chosen');
  assert.equal(h.persisted().conversationDrafts.new.pendingSend, undefined);
  assert.equal(f.element('#mission-start-button').dataset.mode, 'queue', 'editing retires the recovery action immediately');
  assert.doesNotMatch(f.element('#conversation-composer-status').textContent, /Recover send/);
  await h.submit(); assert.equal(h.queued.length, 2); assert.notEqual(h.queued[1].enqueueKey, originalKey);
  assert.equal(h.queued[1].task, edit === 'text' ? 'An intentionally different task' : 'Queue this next'); assert.equal(h.queued[1].model, edit === 'model' ? 'cloud::chosen' : 'cloud::default');
});

test('a successfully queued one-off model does not become the default for the next ordinary message', async t => {
  const f = missionFixture(t, savedDrafts('Use the chosen model once', 'cloud::chosen')), working = fixtureRun('working'), snapshot = statusSnapshot([working]), h = mountMission(f, snapshot); await turn();
  await h.submit(); assert.equal(h.queued[0].model, 'cloud::chosen'); assert.equal(h.ui.getDraft().model, 'default');
  working.status = 'completed'; working.settled = true; h.ui.update(); await h.text('Start another task now'); await h.submit();
  assert.equal(h.queued.length, 1); assert.equal(h.starts.length, 1); assert.equal(h.starts[0].task, 'Start another task now'); assert.equal(h.starts[0].model, 'default');
});

test('queue work is exclusive while saving and rejected responses preserve the user draft', async t => {
  let reject;
  const f = missionFixture(t, savedDrafts()), snapshot = statusSnapshot([fixtureRun('working')]);
  const h = mountMission(f, snapshot, { queue: () => new Promise((resolve, no) => { reject = no; }) }); await turn();
  h.ui.submitFocused(); const pending = f.form.lastSubmission; await turn();
  assert.equal(h.queued.length, 1); assert.equal(f.element('#mission-task').readOnly, true); assert.equal(f.element('#mission-start-button').disabled, true);
  await f.mount.dispatch('submit', { target: f.form, preventDefault() {} }); await h.action('capture'); assert.equal(h.queued.length, 1); assert.deepEqual(h.captures, []);
  reject(new Error('Queue storage is unavailable.')); await pending;
  assert.equal(h.ui.getDraft().task, 'Queue this next'); assert.equal(f.element('#mission-task').readOnly, false); assert.match(f.element('#mission-error').textContent, /Queue storage is unavailable/);
});

test('pasted attachment results stay with the original conversation after a chat switch', async t => {
  const f = missionFixture(t, savedDrafts()), working = fixtureRun('working'), snapshot = statusSnapshot([working]); let release;
  const h = mountMission(f, snapshot, { api: async (url, method) => url.endsWith('/upload') && method ? new Promise(resolve => { release = resolve; }) : undefined }); await turn();
  const pasted = { name: 'screen.png', type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  await f.form.dispatch('paste', { target: f.element('#mission-task'), clipboardData: { files: [pasted], getData: () => '' }, preventDefault() {} }); await turn();
  assert.equal(typeof release, 'function'); assert.equal(f.element('#mission-start-button').disabled, true);
  await h.ui.openConversation(working.id); release({ id: 'file-origin', name: 'screen.png', kind: 'image', mime: 'image/png', size: 3, width: 1, height: 1 });
  for (let index = 0; index < 4; index++) await turn();
  assert.deepEqual(h.persisted().conversationDrafts.new.attachmentIds, ['file-origin']); assert.deepEqual(h.ui.getDraft().attachmentIds, []);
  await h.action('new-task'); assert.deepEqual(h.ui.getDraft().attachmentIds, ['file-origin']);
});

test('another conversation starts immediately when a parallel execution slot is available', async t => {
  const first = fixtureRun('first'), f = missionFixture(t, savedDrafts('Start an independent second conversation', 'cloud::chosen')), snapshot = statusSnapshot([first]);
  snapshot.status.execution = { capacity: 4, availableSlots: 3 };
  const h = mountMission(f, snapshot, { start: async config => { const next = fixtureRun('second'); next.input = config.task; next.workflow.nodes[0].model = config.model; next.nodes.agent.resolvedModel = config.model; snapshot.runs.push(next); snapshot.currentRun = next; return next; } }); await turn();
  assert.equal(f.element('#mission-start-button').disabled, false); assert.doesNotMatch(f.element('#mission-start-button').title, /queue/i);
  await h.submit();
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].model, 'cloud::chosen'); assert.equal(h.starts[0].task, 'Start an independent second conversation'); assert.deepEqual(h.queued, []);
  assert.equal(first.status, 'running'); assert.equal(snapshot.runs.filter(run => run.status === 'running').length, 2); assert.equal(f.element('#conversation-title').textContent, 'Start an independent second conversation');
  assert.deepEqual(h.opened, []); assert.deepEqual(h.stopped, []); assert.equal(h.ui.getDraft().model, 'cloud::chosen', 'the new conversation keeps its chosen running model');
});

test('saved conversation followups can run beside an unrelated working chat when slots remain', async t => {
  const busy = fixtureRun('busy'), saved = fixtureRun('saved', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([busy, saved]);
  snapshot.status.execution = { capacity: 4, availableSlots: 3 }; const h = mountMission(f, snapshot); await turn();
  await h.ui.openConversation(saved.id); await h.text('Continue this independent saved conversation'); await h.model('cloud::other');
  assert.equal(f.element('#mission-start-button').disabled, false); await h.submit();
  const continuations = h.mutations.filter(call => call.continue).map(call => call.continue);
  assert.equal(continuations.length, 1); assert.equal(continuations[0].runId, saved.id); assert.equal(continuations[0].message, 'Continue this independent saved conversation'); assert.equal(continuations[0].model, 'cloud::other');
  assert.deepEqual(h.queued, []); assert.deepEqual(h.starts, []); assert.equal(busy.status, 'running');
});

test('new work queues only when every parallel slot is occupied, using fresh active-run counts', async t => {
  const f = missionFixture(t, savedDrafts()), snapshot = statusSnapshot([fixtureRun('first'), fixtureRun('second')]);
  snapshot.status.execution = { capacity: 2, availableSlots: 2 }; // An earlier status frame must not hide newer run events.
  const h = mountMission(f, snapshot); await turn();
  assert.match(f.element('#mission-start-button').title, /queue/i); await h.submit(); assert.equal(h.queued.length, 1); assert.equal(h.starts.length, 0);
});

test('parallel chats keep separate drafts, model choices, attachments, streamed responses and reading focus', async t => {
  const a = fixtureRun('chat-a'), b = fixtureRun('chat-b'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]); let releaseA;
  snapshot.status.execution = { capacity: 4, availableSlots: 2 };
  const h = mountMission(f, snapshot, { api: async (url, method, body) => url.endsWith('/upload') && method ? body.name === 'a.png' ? new Promise(resolve => { releaseA = resolve; }) : { id: 'file-b', name: 'b.png', kind: 'image', mime: 'image/png', size: 3, width: 1, height: 1 } : undefined }); await turn();
  const paste = async name => { await f.form.dispatch('paste', { target: f.element('#mission-task'), clipboardData: { files: [{ name, type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }], getData: () => '' }, preventDefault() {} }); await turn(); };
  await h.ui.openConversation(a.id); await h.text('Unsent direction for A'); await h.model('cloud::chosen'); await paste('a.png');
  await h.ui.openConversation(b.id); await h.text('Unsent direction for B'); await h.model('cloud::other'); await paste('b.png');
  releaseA({ id: 'file-a', name: 'a.png', kind: 'image', mime: 'image/png', size: 3, width: 1, height: 1 }); for (let index = 0; index < 5; index++) await turn();
  a.events.push({ nodeId: 'agent', at: '2026-10-16T10:01:00Z', data: { type: 'message', itemId: 'a-output', text: 'A is checking the first source.' } });
  b.events.push({ nodeId: 'agent', at: '2026-10-16T10:01:01Z', data: { type: 'message', itemId: 'b-output', text: 'B is drawing the second result.' } });
  snapshot.currentRun = a; h.ui.update();
  assert.equal(f.element('#conversation-title').textContent, 'Task chat-b', 'a background SSE event must not change the chat being read');
  assert.equal(h.ui.getDraft().task, 'Unsent direction for B'); assert.equal(h.ui.getDraft().model, 'cloud::other'); assert.deepEqual(h.ui.getDraft().attachmentIds, ['file-b']);
  const visibleB = f.element('#conversation-timeline').children;
  assert.deepEqual(visibleB.map(section => section.dataset.runId), [b.id]);
  const bMessages = visibleB.flatMap(section => section.querySelector('.conversation-responses').children.map(article => article.innerHTML)).join('');
  assert.match(bMessages, /B is drawing the second result/); assert.doesNotMatch(bMessages, /A is checking/);
  await h.ui.openConversation(a.id);
  assert.equal(h.ui.getDraft().task, 'Unsent direction for A'); assert.equal(h.ui.getDraft().model, 'cloud::chosen'); assert.deepEqual(h.ui.getDraft().attachmentIds, ['file-a']);
  const aMessages = f.element('#conversation-timeline').children.flatMap(section => section.querySelector('.conversation-responses').children.map(article => article.innerHTML)).join('');
  assert.match(aMessages, /A is checking the first source/); assert.doesNotMatch(aMessages, /B is drawing/);
  assert.deepEqual(h.queued, []); assert.deepEqual(h.starts, []); assert.deepEqual(h.stopped, []);
});

test('Stop targets the selected conversation even when another parallel run becomes the global current run', async t => {
  const a = fixtureRun('chat-a'), b = fixtureRun('chat-b'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]);
  snapshot.status.execution = { capacity: 4, availableSlots: 2 }; const h = mountMission(f, snapshot); await turn();
  await h.ui.openConversation(b.id); const opensBeforeStop = [...h.opened]; snapshot.currentRun = a; h.ui.update();
  await h.action('stop');
  assert.deepEqual(h.stopped, [b.id]); assert.deepEqual(h.opened, opensBeforeStop, 'stopping a selected chat must not navigate or depend on an asynchronous global selection');
  assert.equal(a.status, 'running');
});

test('a stalled direction never disables Stop, and its late receipt cannot reopen a requested stop', async t => {
  const run = plannedRun('stalled-direction'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]);
  let deliver; const pendingDirection = new Promise(resolve => { deliver = resolve; });
  const h = mountMission(f, snapshot, { api: (url, method) => method === 'POST' && url.endsWith('/steer') ? pendingDirection : undefined });
  f.cleanup(() => { deliver({ accepted: true, delivery: 'queued' }); h.ui.destroy(); });
  await turn(); await h.text('Use the smaller result.');
  const sending = h.submit(); await turn();
  const stop = f.element('#conversation-stop');
  assert.equal(f.element('#mission-start-button').disabled, true);
  assert.equal(stop.hidden, false); assert.equal(stop.disabled, false, 'Stop must not share the direction request lock');
  await f.mount.dispatch('click', { target: stop });
  assert.deepEqual(h.stopped, [run.id]); assert.equal(stop.disabled, true);
  assert.match(f.element('#conversation-composer-status').textContent, /Stop requested/);
  assert.doesNotMatch(f.element('#conversation-timeline').children[0].querySelector('.conversation-turn-status').innerHTML, />Stopped</);
  await f.mount.dispatch('click', { target: stop }); assert.equal(h.stopped.length, 1, 'an accepted stop cannot be sent twice while awaiting status');
  deliver({ accepted: true, delivery: 'queued' }); await sending;
  assert.equal(f.element('#mission-start-button').disabled, true, 'the late direction receipt cannot make the cancelling run steerable again');
  assert.match(f.element('#conversation-composer-status').textContent, /Stop requested/); assert.equal(run.status, 'running', 'request state is never fabricated execution state');
});

test('a timed-out Stop keeps its draft and plan, offers a retry, and waits for settlement before saying Stopped', async t => {
  const run = plannedRun('stop-timeout'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]);
  snapshot.status.execution = { capacity: 1, activeCount: 1 };
  let requests = 0;
  const cancelApi = createApiClient({ timeoutMs: 20, fetcher: async () => {
    requests++;
    return { ok: true, json: requests === 1 ? () => new Promise(() => {}) : async () => ({ ...run, status: 'cancelled', settled: false, nodes: { agent: { ...run.nodes.agent, status: 'cancelled' } } }) };
  } });
  const h = mountMission(f, snapshot, { stop: async (id, options) => { assert.equal(options.throwOnError, true); const receipt = await cancelApi(`/api/runs/${id}/cancel`, 'POST'); Object.assign(run, receipt); return run; } });
  f.cleanup(() => h.ui.destroy()); await turn(); await h.text('Keep this follow-up.');
  const draft = h.ui.getDraft(), plan = structuredClone(run.taskState), stop = f.element('#conversation-stop');
  await f.mount.dispatch('click', { target: stop });
  assert.equal(requests, 1, 'the client must not replay the mutation automatically');
  assert.equal(run.status, 'running'); assert.equal(stop.disabled, false); assert.match(stop.innerHTML, /Retry stop/);
  assert.match(f.element('#conversation-composer-status').textContent, /Stop was not confirmed.*may still be running.*Try Stop again/);
  assert.match(f.element('#mission-error').textContent, /too long|timed out/i);
  assert.deepEqual(h.ui.getDraft(), draft); assert.deepEqual(run.taskState, plan);
  snapshot.streamState = 'reconnecting'; h.ui.update();
  assert.match(f.element('#conversation-composer-status').textContent, /Reconnecting.*Stop was not confirmed/);
  await f.mount.dispatch('click', { target: stop });
  assert.equal(requests, 2); assert.equal(run.status, 'cancelled'); assert.equal(stop.disabled, true); assert.equal(stop.hidden, false);
  assert.match(f.element('#conversation-composer-status').textContent, /Stopping.*Waiting for active work/);
  const section = f.element('#conversation-timeline').children[0];
  assert.match(section.querySelector('.conversation-turn-status').innerHTML, /Stopping/); assert.doesNotMatch(section.querySelector('.conversation-turn-status').innerHTML, />Stopped</);
  assert.match(section.querySelector('.conversation-turn-controls').innerHTML, /data-mission-action="retry"[^>]* disabled/);
  assert.equal(f.element('#mission-start-button').disabled, true); assert.equal(f.element('#mission-error').textContent, '');
  assert.equal(f.element('#conversation-active-button').hidden, false); assert.match(f.element('#conversation-active-button').innerHTML, /1 stopping/);
  await h.action('working-chats'); assert.match(f.element('#conversation-list').innerHTML, /Stopping/); assert.match(f.element('#conversation-list').innerHTML, /stop-timeout/);
  assert.deepEqual(h.ui.getDraft(), draft); assert.deepEqual(run.taskState, plan);
  run.settled = true; snapshot.streamState = 'live'; snapshot.status.execution.activeCount = 0; h.ui.update();
  assert.match(section.querySelector('.conversation-turn-status').innerHTML, />Stopped</);
  assert.doesNotMatch(section.querySelector('.conversation-turn-controls').innerHTML, /data-mission-action="retry"[^>]* disabled/);
  assert.equal(stop.hidden, true); assert.equal(f.element('#mission-start-button').disabled, false); assert.equal(f.element('#conversation-active-button').hidden, true);
  assert.deepEqual(h.ui.getDraft(), draft); assert.deepEqual(run.taskState, plan);
});

test('a pending Stop and its late error stay with their own conversation', async t => {
  const a = fixtureRun('stop-a'), b = fixtureRun('stop-b'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]);
  snapshot.status.execution = { capacity: 4, activeCount: 2 };
  let rejectA; const pendingA = new Promise((resolve, reject) => { rejectA = reject; });
  const h = mountMission(f, snapshot, { stop: id => id === a.id ? pendingA : undefined });
  f.cleanup(() => h.ui.destroy()); await turn(); await h.text('Unsent direction for A');
  const stoppingA = f.mount.dispatch('click', { target: f.element('#conversation-stop') }); await turn();
  assert.equal(f.element('#conversation-stop').disabled, true); assert.match(f.element('#conversation-composer-status').textContent, /Requesting Stop/);
  await h.ui.openConversation(b.id); await h.text('Unsent direction for B');
  assert.equal(f.element('#conversation-stop').disabled, false, 'A pending Stop must not lock another conversation');
  rejectA(new Error('The Stop request for A lost its connection.')); await stoppingA;
  assert.equal(h.ui.getSelection().runId, b.id); assert.equal(h.ui.getDraft().task, 'Unsent direction for B'); assert.equal(f.element('#mission-error').textContent, '');
  assert.doesNotMatch(f.element('#conversation-composer-status').textContent, /Stop was not confirmed/);
  await f.mount.dispatch('click', { target: f.element('#conversation-stop') }); assert.deepEqual(h.stopped, [a.id, b.id]);
  await h.ui.openConversation(a.id);
  assert.equal(h.ui.getDraft().task, 'Unsent direction for A'); assert.match(f.element('#mission-error').textContent, /request for A/); assert.match(f.element('#conversation-stop').innerHTML, /Retry stop/); assert.equal(f.element('#conversation-stop').disabled, false);
});

test('a stop transport error arriving after confirmed settlement cannot replace Stopped with a retry', async t => {
  const run = fixtureRun('settled-before-stop-response'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]);
  let rejectStop; const pending = new Promise((resolve, reject) => { rejectStop = reject; });
  const h = mountMission(f, snapshot, { stop: () => pending }); f.cleanup(() => h.ui.destroy()); await turn();
  const request = f.mount.dispatch('click', { target: f.element('#conversation-stop') }); await turn();
  run.status = 'cancelled'; run.settled = true; h.ui.update();
  rejectStop(new Error('The transport response was lost.')); await request;
  assert.match(f.element('#conversation-timeline').children[0].querySelector('.conversation-turn-status').innerHTML, />Stopped</);
  assert.equal(f.element('#mission-error').textContent, ''); assert.equal(f.element('#conversation-stop').hidden, true);
});

test('failed and completed runs retain a clear finishing state until their lease is released', async t => {
  const run = plannedRun('finishing-error'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]);
  snapshot.status.execution = { capacity: 1, activeCount: 1 };
  const h = mountMission(f, snapshot); f.cleanup(() => h.ui.destroy()); await turn(); await h.text('Keep this next request.');
  run.status = 'failed'; run.nodes.agent.status = 'failed'; run.error = 'The provider lost its connection.'; h.ui.update();
  const status = f.element('#conversation-timeline').children[0].querySelector('.conversation-turn-status');
  assert.match(status.innerHTML, /provider lost its connection.*Waiting for active work/);
  assert.match(f.element('#conversation-composer-status').textContent, /Waiting for active work.*retry/);
  assert.equal(f.element('#conversation-stop').hidden, true); assert.equal(f.element('#mission-start-button').disabled, true); assert.match(f.element('#conversation-active-button').innerHTML, /1 finishing/);
  run.status = 'completed'; run.nodes.agent.status = 'completed'; delete run.error; h.ui.update();
  assert.match(status.innerHTML, /Finishing/); assert.match(f.element('#conversation-composer-status').textContent, /before you can reply/); assert.equal(f.element('#mission-start-button').disabled, true);
  run.settled = true; snapshot.status.execution.activeCount = 0; h.ui.update();
  assert.equal(status.innerHTML, ''); assert.equal(f.element('#mission-start-button').disabled, false); assert.equal(h.ui.getDraft().task, 'Keep this next request.');
});

for(const execution of [{capacity:null,unlimited:true,availableSlots:null},{capacity:null,activeCount:40},{unlimited:true,activeCount:40},{capacity:128,activeCount:40,availableSlots:88}])test(`new chats can start beside forty active chats with ${JSON.stringify(execution)}`,async t=>{
  const active=Array.from({length:40},(_,index)=>fixtureRun(`working-${index}`)),f=missionFixture(t,savedDrafts('Start another independent task')),snapshot=statusSnapshot(active);snapshot.status.execution=execution;
  const h=mountMission(f,snapshot);await turn();assert.equal(f.element('#mission-start-button').disabled,false);assert.doesNotMatch(f.element('#mission-start-button').title,/queue/i);await h.submit();
  assert.equal(h.starts.length,1);assert.equal(h.starts[0].task,'Start another independent task');assert.equal(h.queued.length,0);assert.match(f.element('#conversation-active-button').innerHTML,/40 working/);
});

test('live limit changes affect only new admissions, and removing the limit restores sending without stopping active chats',async t=>{
  const active=Array.from({length:5},(_,index)=>fixtureRun(`working-${index}`)),f=missionFixture(t,savedDrafts('Task under the selected limit')),snapshot=statusSnapshot(active);snapshot.status.execution={capacity:null,unlimited:true,activeCount:5};
  const h=mountMission(f,snapshot);await turn();assert.doesNotMatch(f.element('#mission-start-button').title,/queue/i);
  snapshot.status.execution={capacity:2,unlimited:false,activeCount:5,availableSlots:0};h.ui.update();assert.match(f.element('#mission-start-button').title,/queue/i);await h.submit();assert.equal(h.queued.length,1);assert.equal(h.starts.length,0);assert.deepEqual(h.stopped,[]);assert.ok(active.every(run=>run.status==='running'));
  await h.text('Start now with no app limit');snapshot.status.execution={capacity:null,unlimited:true,activeCount:5,availableSlots:null};h.ui.update();assert.doesNotMatch(f.element('#mission-start-button').title,/queue/i);await h.submit();assert.equal(h.starts.length,1);assert.equal(h.starts[0].task,'Start now with no app limit');assert.deepEqual(h.stopped,[]);
});

test('a completed chat can resume beside forty active chats when the user removes the limit',async t=>{
  const active=Array.from({length:40},(_,index)=>fixtureRun(`working-${index}`)),completed=fixtureRun('saved','completed'),f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([...active,completed]);snapshot.status.execution={capacity:4,activeCount:40,availableSlots:0};
  const h=mountMission(f,snapshot);await turn();await h.ui.openConversation(completed.id);await h.text('Continue this specific conversation');assert.equal(f.element('#mission-start-button').disabled,true);
  snapshot.status.execution={capacity:null,unlimited:true,activeCount:40,availableSlots:null};h.ui.update();assert.equal(f.element('#mission-start-button').disabled,false);await h.submit();assert.equal(h.mutations.filter(call=>call.continue).length,1);assert.equal(h.queued.length,0);assert.deepEqual(h.stopped,[]);
});

test('time-limit recovery opens its settings without sending, retrying or changing the chat draft',async t=>{
  const failed={...fixtureRun('idle-failure','failed'),settled:true,errorCode:'PROVIDER_IDLE_TIMEOUT',error:'The API stopped sending data.'},f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([failed]),h=mountMission(f,snapshot);
  await turn();await h.ui.openConversation(failed.id);await h.text('Keep this reply while I adjust the timeout.');const before=h.ui.getDraft();
  await h.action('run-limits');assert.deepEqual(h.timeLimits,[true]);assert.deepEqual(h.ui.getDraft(),before);assert.equal(h.starts.length,0);assert.equal(h.mutations.filter(item=>item.continue).length,0);assert.equal(h.errors.length,0);
});

test('new chat starters prepare editable drafts without sending, overwriting a draft, or changing saved files', async t => {
  const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([]),h=mountMission(f,snapshot);
  await turn();
  await h.action('starter',{starter:'review-files'});
  assert.match(h.ui.getDraft().task,/Inspect the files in my selected working folder/);
  assert.equal(h.starts.length,0);
  assert.equal(h.mutations.length,0);
  assert.equal(f.element('#conversation-timeline .conversation-starters').hidden,true,'starter choices disappear while the resulting draft is being edited');
  assert.equal(globalThis.document.activeElement,f.element('#mission-task'));
  const preserved=h.ui.getDraft().task;
  await h.action('starter',{starter:'research'});
  assert.equal(h.ui.getDraft().task,preserved);
  assert.match(h.errors.at(-1).message,/draft is still here/);
  await h.text('');
  assert.equal(f.element('#conversation-timeline .conversation-starters').hidden,false,'clearing the draft restores quick starters');
  await h.action('starter',{starter:'research'});
  assert.match(h.ui.getDraft().task,/research a question/);
  assert.equal(h.starts.length,0);
  await h.action('starter',{starter:'does-not-exist'});
  assert.match(h.ui.getDraft().task,/research a question/);
});

test('composer folder indicator makes the active workspace visible and preserves saved conversation folder',async t=>{
  const existing=fixtureRun('existing-project','completed');existing.cwd='C:\\Project-From-History';
  const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([existing]);
  const chooser=async()=> 'D:\\New Project';
  const h=mountMission(f,snapshot,{pickFolder:chooser});await turn();
  await h.action('new-task');
  assert.equal(f.element('#conversation-folder-chip').textContent,'fixture');
  assert.match(f.element('#conversation-folder-chip').title,/C:\\fixture/);
  await h.action('pick-folder');
  assert.equal(h.ui.getDraft().cwd,'D:\\New Project');
  assert.equal(f.element('#conversation-folder-chip').textContent,'New Project');
  assert.equal(h.starts.length,0);
  await h.ui.openConversation(existing.id);
  assert.equal(f.element('#conversation-folder-chip').textContent,'Project-From-History');
  assert.equal(f.element('#conversation-folder-chip').disabled,true);
  await h.action('pick-folder');
  assert.equal(h.ui.getDraft().cwd,'D:\\New Project','saved conversation cannot change global folder');
});

test('a delayed folder picker cannot apply its result to a different chat',async t=>{
  const existing=fixtureRun('switch-during-dialog','completed');
  let release;
  const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([existing]);
  const h=mountMission(f,snapshot,{pickFolder:()=>new Promise(resolve=>{release=resolve;})});await turn();
  await h.action('new-task');
  const pending=h.action('pick-folder');await turn();
  assert.equal(typeof release,'function');
  await h.ui.openConversation(existing.id);
  release('D:\\Late Result');await pending;
  assert.equal(h.ui.getDraft().cwd,'C:\\fixture');
  await h.action('new-task');
  assert.equal(f.element('#conversation-folder-chip').textContent,'fixture');
});

test('sign-in blocker is quiet, saved with the chat, and opens Neo only after a user click', async t => {
 const run=fixtureRun('browser-login-required','completed');
 run.browserSignIn={origin:'https://www.linkedin.com',hostname:'www.linkedin.com',reason:'sign-in',evidence:'login-redirect',status:'awaiting-user',reportedAt:'2026-10-17T15:00:00Z',nodeId:'agent'};
 let opened=0;
 const f=missionFixture(t,savedDrafts('')),snapshot=statusSnapshot([run]),h=mountMission(f,snapshot,{openBrowserOS:async()=>{opened++;return{shown:true,focused:true,started:false};}});
 await turn();
 const card=f.element('#conversation-browser-signin');
 assert.equal(card.hidden,false);
 assert.match(card.innerHTML,/Sign-in required/);
 assert.match(card.innerHTML,/www.linkedin.com/);
 assert.match(card.innerHTML,/stays in the background until you choose/);
 assert.match(card.innerHTML,/data-mission-action="browser-signin-open"/);
 assert.equal(opened,0,'merely rendering a blocker must never activate the desktop');
 assert.equal(h.starts.length,0);
 await h.action('browser-signin-open');
 assert.equal(opened,1,'an explicit click, not an agent event, opens the window');
 assert.equal(h.starts.length,0);
 await h.action('browser-signin-resume');
 assert.match(h.ui.getDraft().task,/I have handled the sign-in/);
 assert.match(h.ui.getDraft().task,/check whether any intended public action already happened/);
 assert.equal(h.starts.length,0,'preparing a retry does not send or publish');
 await h.action('browser-signin-resume');
 assert.equal(opened,1);
 assert.equal(h.starts.length,0);
 const stored=h.persisted();assert.match(stored.conversationDrafts[run.id].task,/Reinspect the website/);
 await h.action('new-task');
 assert.equal(card.hidden,true,'other chats do not inherit the sign-in blocker');
});
test('sign-in notice does not touch drafts or auto-open when user resumes unrelated work', async t => {
 const run=fixtureRun('blocked-with-draft','completed');
 run.browserSignIn={origin:'https://example.com',hostname:'example.com',reason:'verification',evidence:'verification-page',status:'awaiting-user'};
 const f=missionFixture(t,savedDrafts('')),h=mountMission(f,statusSnapshot([run]));
 await turn();await h.text('Keep a custom unsent draft');
 await h.action('browser-signin-resume');
 assert.equal(h.ui.getDraft().task,'Keep a custom unsent draft');
 assert.match(h.errors.at(-1).message,/unsent message is preserved/);
 assert.equal(h.starts.length,0);
 assert.match(f.element('#conversation-browser-signin').innerHTML,/Verification required/);
});

test('contained sign-in uses Observe only and prepares an unsent follow-up without opening Neo',async t=>{
 const run=fixtureRun('contained-login-required','completed');run.browserSignIn={origin:'https://linkedin.com',hostname:'linkedin.com',reason:'sign-in',evidence:'login-form',status:'awaiting-user',browser:'relay'};
 const observed=[];let nativeOpened=0;const f=missionFixture(t,savedDrafts('')),h=mountMission(f,statusSnapshot([run]),{observe:async id=>observed.push(id),openBrowserOS:async()=>{nativeOpened++;return{shown:true};}});await turn();const card=f.element('#conversation-browser-signin');
 assert.equal(card.hidden,false);assert.match(card.innerHTML,/Sign in inside Observe/);assert.match(card.innerHTML,/data-mission-action="browser-signin-observe"/);assert.doesNotMatch(card.innerHTML,/Open BrowserOS|data-mission-action="browser-signin-open"/);assert.deepEqual(observed,[]);assert.equal(nativeOpened,0);
 await h.action('browser-signin-observe');assert.deepEqual(observed,[run.id]);assert.equal(nativeOpened,0);assert.equal(h.starts.length,0);assert.equal(h.mutations.length,0);
 await h.action('browser-signin-open');assert.deepEqual(observed,[run.id,run.id]);assert.equal(nativeOpened,0,'even a stale legacy action cannot reveal Neo for a contained blocker');
 await h.action('browser-signin-resume');assert.match(h.ui.getDraft().task,/contained BLACKICE browser in Observe/);assert.doesNotMatch(h.ui.getDraft().task,/BrowserOS|Neo/);assert.match(h.ui.getDraft().task,/check whether any intended public action already happened/);assert.equal(h.starts.length,0);assert.equal(h.queued.length,0);assert.equal(h.mutations.length,0);assert.equal(nativeOpened,0);
});

test('contained sign-in cannot fall back to native Neo when Observe is unavailable',async t=>{
 const run=fixtureRun('contained-login-without-route','completed');run.browserSignIn={origin:'https://example.com',hostname:'example.com',reason:'verification',evidence:'verification-page',status:'awaiting-user',browser:'relay'};let nativeOpened=0;
 const f=missionFixture(t,savedDrafts('')),h=mountMission(f,statusSnapshot([run]),{openBrowserOS:async()=>{nativeOpened++;return{shown:true};}});await turn();await h.action('browser-signin-observe');await h.action('browser-signin-open');assert.equal(nativeOpened,0);assert.match(h.errors.at(-1).message,/Open Observe/);assert.equal(h.starts.length,0);assert.equal(h.mutations.length,0);
});

test('a same-site blocker changing from legacy Neo to contained mode refreshes its route and label',async t=>{
 const run=fixtureRun('changed-browser-login','completed');run.browserSignIn={origin:'https://example.com',hostname:'example.com',reason:'sign-in',evidence:'login-form',status:'awaiting-user'};let nativeOpened=0;const observed=[];
 const f=missionFixture(t,savedDrafts('')),h=mountMission(f,statusSnapshot([run]),{observe:async id=>observed.push(id),openBrowserOS:async()=>{nativeOpened++;return{shown:true};}});await turn();const card=f.element('#conversation-browser-signin');assert.match(card.innerHTML,/Open BrowserOS/);
 run.browserSignIn.browser='relay';h.ui.update();assert.match(card.innerHTML,/Sign in inside Observe/);assert.doesNotMatch(card.innerHTML,/Open BrowserOS/);await h.action('browser-signin-observe');assert.deepEqual(observed,[run.id]);assert.equal(nativeOpened,0);
});

test('a held direction allows chat and New navigation, keeps its own composer locked, and returns its error only to its origin', async t => {
  const a = fixtureRun('direction-owner'), b = fixtureRun('direction-reader'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]);
  snapshot.status.execution = { capacity: 4, activeCount: 2 };
  let rejectDirection, attempts = 0;
  const held = new Promise((resolve, reject) => { rejectDirection = reject; });
  const h = mountMission(f, snapshot, { api: url => url === `/api/runs/${a.id}/steer` ? ++attempts === 1 ? held : { accepted: true, delivery: 'delivered' } : undefined });
  await turn(); await h.text('A direction that must remain with A.'); h.ui.submitFocused(); const sending = f.form.lastSubmission; await turn();
  try {
    assert.equal(f.element('#mission-task').readOnly, true); assert.equal(f.element('#mission-start-button').dataset.mode, 'sending'); assert.equal(f.element('#conversation-stop').disabled, false);
    await h.ui.openConversation(b.id); assert.equal(h.ui.getSelection().key, b.id); assert.equal(f.element('#mission-task').readOnly, false);
    await h.text('An unrelated B draft.'); await h.model('cloud::chosen'); const bDraft = h.ui.getDraft();
    await h.action('new-task'); assert.equal(h.ui.getSelection().forceNew, true); assert.equal(f.element('#mission-task').readOnly, false); await h.text('An independent new task.');
    await h.ui.openConversation(a.id); assert.equal(h.ui.getDraft().task, 'A direction that must remain with A.'); assert.equal(f.element('#mission-task').readOnly, true); assert.equal(f.element('#conversation-stop').disabled, false);
    await h.submit(); assert.equal(attempts, 1, 'returning to the pending origin cannot send it twice');
    await h.ui.openConversation(b.id); rejectDirection(new Error('A-specific direction connection failure.')); await sending; await turn();
    assert.equal(h.ui.getSelection().runId, b.id); assert.deepEqual(h.ui.getDraft(), bDraft); assert.equal(f.element('#mission-error').textContent, ''); assert.equal(f.element('#mission-task').readOnly, false);
    await h.action('new-task'); assert.equal(h.ui.getDraft().task, 'An independent new task.'); assert.equal(f.element('#mission-error').textContent, '');
    await h.ui.openConversation(a.id); assert.match(f.element('#mission-error').textContent, /A-specific direction connection failure/); assert.equal(h.ui.getDraft().task, 'A direction that must remain with A.'); assert.equal(f.element('#mission-task').readOnly, false);
    await h.submit(); assert.equal(attempts, 2); assert.equal(h.ui.getDraft().task, ''); assert.equal(f.element('#mission-error').textContent, '');
  } finally { rejectDirection(new Error('Fixture cleanup.')); await sending; h.ui.destroy(); }
});

test('a late continuation success preserves another chat’s selection, draft, settings, focus and reading position', async t => {
  const a = fixtureRun('continue-owner', 'completed'), b = fixtureRun('continue-reader', 'completed'), next = { ...fixtureRun('continue-next'), taskId: a.taskId, parentRunId: a.id, createdAt: '2026-10-16T10:01:00Z' };
  const f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]); snapshot.status.execution = { capacity: 4, activeCount: 0 };
  let release; const held = new Promise(resolve => { release = resolve; }), h = mountMission(f, snapshot, { continue: () => held });
  await turn(); await h.text('Continue A with this exact input.'); h.ui.submitFocused(); const sending = f.form.lastSubmission; await turn();
  try {
    await h.ui.openConversation(b.id); await h.text('B is still being written.'); await h.model('cloud::chosen'); await h.effort('max'); h.ui.setContext({ preset: '900k' }); const bDraft = h.ui.getDraft();
    const scroll = f.element('#conversation-scroll'); scroll.scrollHeight = 2000; scroll.clientHeight = 500; scroll.scrollTop = 325; await scroll.dispatch('scroll', {}); f.element('#mission-task').focus();
    release(next); await sending; await turn();
    assert.equal(h.ui.getSelection().runId, b.id); assert.deepEqual(h.ui.getDraft(), bDraft); assert.equal(f.element('#mission-task').value, bDraft.task);
    assert.equal(scroll.scrollTop, 325); assert.equal(globalThis.document.activeElement, f.element('#mission-task')); assert.equal(f.element('#mission-error').textContent, '');
    const stored = h.persisted().conversationDrafts; assert.equal(stored[a.id].task, ''); assert.equal(stored[a.id].pendingSend, undefined); assert.equal(stored[b.id].task, bDraft.task);
    await h.ui.openConversation(a.id); assert.equal(h.ui.getSelection().key, a.id); assert.equal(h.ui.getDraft().task, ''); assert.equal(f.element('#mission-start-button').dataset.mode, 'steer');
    assert.ok(f.element('#conversation-timeline').children.some(section => section.dataset.runId === next.id), 'the returned run is retained in its own conversation');
  } finally { release(next); await sending; h.ui.destroy(); }
});

test('a continuation receipt cannot win while navigation to a different conversation is awaiting its run', async t => {
  const a = fixtureRun('navigation-owner', 'completed'), b = fixtureRun('navigation-target', 'completed'), next = { ...fixtureRun('navigation-next'), taskId: a.taskId, parentRunId: a.id };
  const f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]);
  let releaseSend, releaseOpen; const heldSend = new Promise(resolve => { releaseSend = resolve; }), heldOpen = new Promise(resolve => { releaseOpen = resolve; });
  const h = mountMission(f, snapshot, { continue: () => heldSend, open: id => id === b.id ? heldOpen : undefined });
  await turn(); await h.text('A continuation.'); h.ui.submitFocused(); const sending = f.form.lastSubmission; await turn(); const opening = h.ui.openConversation(b.id); await turn();
  try {
    assert.equal(h.ui.getSelection().runId, b.id); assert.equal(h.ui.getSelection().key, a.id, 'the old draft still owns the view while the next run is loading');
    releaseSend(next); await sending; releaseOpen(); await opening; await turn();
    assert.equal(h.ui.getSelection().runId, b.id); assert.equal(h.ui.getSelection().key, b.id); assert.equal(f.element('#mission-task').readOnly, false);
  } finally { releaseSend(next); releaseOpen(); await Promise.all([sending, opening]); h.ui.destroy(); }
});

test('a late continuation result leaves New chat selected and keeps the new draft intact', async t => {
  const a = fixtureRun('new-chat-owner', 'completed'), next = { ...fixtureRun('new-chat-next'), taskId: a.taskId, parentRunId: a.id }, f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a]);
  let release; const held = new Promise(resolve => { release = resolve; }), h = mountMission(f, snapshot, { continue: () => held });
  await turn(); await h.text('Finish A.'); h.ui.submitFocused(); const sending = f.form.lastSubmission; await turn();
  try {
    await h.action('new-task'); await h.text('Keep this separate new task.'); await h.model('cloud::other'); const newer = h.ui.getDraft();
    release(next); await sending; await turn();
    assert.deepEqual(h.ui.getSelection(), { key: 'new', runId: null, forceNew: true }); assert.deepEqual(h.ui.getDraft(), newer); assert.equal(f.element('#mission-task').value, newer.task);
    assert.equal(h.persisted().conversationDrafts[a.id].pendingSend, undefined); assert.equal(h.persisted().conversationDrafts.new.task, newer.task);
  } finally { release(next); await sending; h.ui.destroy(); }
});

test('a failed start receipt follows New chat across navigation and recovers the exact submitted request', async t => {
  const other = fixtureRun('start-reader', 'completed'), accepted = fixtureRun('start-accepted'), f = missionFixture(t, savedDrafts('The original new task.', 'cloud::chosen')), snapshot = statusSnapshot([other]);
  let rejectStart, attempts = 0; const held = new Promise((resolve, reject) => { rejectStart = reject; });
  const h = mountMission(f, snapshot, { start: () => ++attempts === 1 ? held : accepted });
  await turn(); h.ui.submitFocused(); const sending = f.form.lastSubmission; await turn();
  try {
    const original = h.starts[0]; await h.ui.openConversation(other.id); await h.text('The reader draft stays here.');
    rejectStart(new Error('The start response was lost after admission.')); await sending; await turn();
    assert.equal(h.ui.getSelection().runId, other.id); assert.equal(h.ui.getDraft().task, 'The reader draft stays here.'); assert.equal(f.element('#mission-error').textContent, '');
    await h.action('new-task'); assert.equal(f.element('#mission-start-button').dataset.mode, 'recover'); assert.match(f.element('#mission-error').textContent, /response was lost after admission/); assert.equal(h.ui.getDraft().task, original.task);
    await h.submit(); assert.deepEqual(JSON.parse(JSON.stringify(h.starts[1])), JSON.parse(JSON.stringify(original)), 'receipt recovery preserves the exact serialized request'); assert.equal(h.ui.getSelection().runId, accepted.id); assert.equal(h.persisted().conversationDrafts.new.pendingSend, undefined);
    await h.ui.openConversation(other.id); assert.equal(h.ui.getDraft().task, 'The reader draft stays here.'); assert.equal(f.element('#mission-error').textContent, '');
  } finally { rejectStart(new Error('Fixture cleanup.')); await sending; h.ui.destroy(); }
});

test('finishing one chat’s direction cannot unlock another chat’s in-flight request', async t => {
  const a = fixtureRun('parallel-owner-a'), b = fixtureRun('parallel-owner-b'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]); snapshot.status.execution = { capacity: 4, activeCount: 2 };
  let releaseA, releaseB; const heldA = new Promise(resolve => { releaseA = resolve; }), heldB = new Promise(resolve => { releaseB = resolve; });
  const h = mountMission(f, snapshot, { api: url => url === `/api/runs/${a.id}/steer` ? heldA : url === `/api/runs/${b.id}/steer` ? heldB : undefined });
  await turn(); await h.text('Direction A.'); h.ui.submitFocused(); const sendingA = f.form.lastSubmission; await turn(); let sendingB;
  try {
    await h.ui.openConversation(b.id); await h.text('Direction B.'); h.ui.submitFocused(); sendingB = f.form.lastSubmission; await turn();
    assert.equal(h.mutations.filter(value => value.url?.endsWith('/steer')).length, 2);
    releaseA({ accepted: true }); await sendingA; assert.equal(h.ui.getSelection().key, b.id); assert.equal(f.element('#mission-task').readOnly, true); assert.equal(f.element('#mission-start-button').disabled, true); assert.equal(f.element('#conversation-stop').disabled, false);
    releaseB({ accepted: true }); await sendingB; assert.equal(f.element('#mission-task').readOnly, false); assert.equal(h.ui.getDraft().task, '');
  } finally { releaseA({ accepted: true }); releaseB({ accepted: true }); await Promise.all([sendingA, sendingB]); h.ui.destroy(); }
});

test('a background queue receipt stays with its New draft and does not replace another chat’s controls', async t => {
  const working = fixtureRun('queue-reader'), f = missionFixture(t, savedDrafts('Queue this independent task.')), snapshot = statusSnapshot([working]);
  let release; const held = new Promise(resolve => { release = resolve; }), h = mountMission(f, snapshot, { queue: () => held });
  await turn(); h.ui.submitFocused(); const sending = f.form.lastSubmission; await turn();
  try {
    await h.ui.openConversation(working.id); await h.text('A direction for the current run.'); release({ id: 'owned-queue-receipt', status: 'queued' }); await sending; await turn();
    assert.equal(h.ui.getSelection().key, working.id); assert.equal(h.ui.getDraft().task, 'A direction for the current run.'); assert.equal(f.element('#conversation-queue-receipt').hidden, true);
    await h.action('new-task'); assert.equal(h.ui.getDraft().task, ''); assert.equal(f.element('#conversation-queue-receipt').hidden, false); assert.match(f.element('#conversation-queue-receipt').innerHTML, /owned-queue-receipt/);
    await h.action('dismiss-queued'); assert.equal(f.element('#conversation-queue-receipt').hidden, true);
  } finally { release({ id: 'owned-queue-receipt', status: 'queued' }); await sending; h.ui.destroy(); }
});

test('Save for later completes only its originating draft after the user opens another chat', async t => {
  const a = fixtureRun('capture-owner', 'completed'), b = fixtureRun('capture-reader', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([a, b]);
  let release; const held = new Promise(resolve => { release = resolve; }), h = mountMission(f, snapshot, { capture: () => held });
  await turn(); await h.text('Save A for later.'); const saving = h.action('capture'); await turn();
  try {
    assert.equal(f.element('#mission-task').readOnly, true); await h.ui.openConversation(b.id); assert.equal(h.ui.getSelection().key, b.id); assert.equal(f.element('#mission-task').readOnly, false); await h.text('Keep working on B.');
    release({ id: 'captured-a' }); await saving; await turn();
    assert.equal(h.ui.getSelection().key, b.id); assert.equal(h.ui.getDraft().task, 'Keep working on B.'); assert.deepEqual(h.inbox, [], 'a late save must not open Inbox over another chat');
    await h.ui.openConversation(a.id); assert.equal(h.ui.getDraft().task, ''); assert.equal(f.element('#mission-task').readOnly, false);
  } finally { release({ id: 'captured-a' }); await saving; h.ui.destroy(); }
});

test('desktop plan visibility preserves the draft and selection across updates and responsive views', async t => {
  const run = plannedRun('roomy-plan'), f = missionFixture(t, savedDrafts(''));
  globalThis.window.innerWidth = 1440;
  const snapshot = statusSnapshot([run]), h = mountMission(f, snapshot); await turn();
  assert.equal(h.ui.getWorkbench().collapsed, true, 'fresh desktop chats keep Plan available on demand');
  h.ui.showPlan();
  await h.text('Keep this direction while I read');
  await h.planAction('select', { stepId: 'verify' });
  const before = structuredClone(run.taskState), selected = h.ui.getWorkbench().selection.selectedId;
  await h.action('toggle-plan');
  assert.equal(h.ui.getWorkbench().collapsed, true);
  assert.equal(f.element('#mission-plan').hidden, true);
  assert.equal(f.element('#mission-plan').inert, true);
  assert.equal(f.element('#conversation-dialogue').hidden, false);
  assert.equal(f.element('#conversation-plan-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(f.storage.get('relay.ui.plan.collapsed'), 'true');
  h.ui.update(); await f.windowEvents.dispatch('resize', {});
  assert.equal(h.ui.getWorkbench().collapsed, true, 'updates do not reopen the hidden plan');
  assert.equal(h.ui.getDraft().task, 'Keep this direction while I read');
  assert.equal(h.ui.getWorkbench().selection.selectedId, selected);
  globalThis.window.innerWidth = 390; await f.windowEvents.dispatch('resize', {});
  assert.equal(f.element('#conversation-plan-toggle').hidden, true);
  h.ui.showPlan();
  assert.equal(f.element('#mission-plan').hidden, false, 'mobile Plan remains reachable');
  assert.equal(f.storage.get('relay.ui.plan.collapsed'), 'true', 'mobile choice does not overwrite desktop preference');
  globalThis.window.innerWidth = 1440; await f.windowEvents.dispatch('resize', {});
  assert.equal(h.ui.getWorkbench().collapsed, true);
  h.ui.showPlan();
  assert.equal(h.ui.getWorkbench().collapsed, false, 'an explicit Show Plan opens the desktop pane');
  assert.equal(f.element('#mission-plan').inert, false);
  assert.equal(f.storage.get('relay.ui.plan.collapsed'), 'false');
  assert.deepEqual(run.taskState, before);
  assert.equal(h.ui.getDraft().task, 'Keep this direction while I read');
  assert.equal(h.starts.length + h.queued.length + h.mutations.length, 0);
});

test('desktop plan preference is restored without hiding the conversation or changing task data', async t => {
  const f = missionFixture(t, savedDrafts('')); f.storage.set('relay.ui.plan.collapsed', 'true');
  globalThis.window.innerWidth = 1440;
  const run = plannedRun('restore-plan'), before = structuredClone(run), h = mountMission(f, statusSnapshot([run])); await turn();
  assert.equal(h.ui.getWorkbench().collapsed, true);
  assert.equal(f.element('#mission-plan').hidden, true);
  assert.equal(f.element('#conversation-dialogue').hidden, false);
  assert.equal(f.element('#conversation-plan-toggle').hidden, false);
  assert.deepEqual(run, before);
});

test('Escape returns focus to the response setting that was closed', async t => {
  const f = missionFixture(t, savedDrafts('Draft stays here')), h = mountMission(f, statusSnapshot()); await turn();
  for (const [panelId, inputId] of [['mission-context', 'mission-effort'], ['conversation-actions', 'conversation-actions']]) {
    const panel = f.element('#' + panelId), input = f.element('#' + inputId);
    f.element('#conversation-rename').hidden = true; panel.open = true; input.focus();
    const event = menuEvent(input, { key: 'Escape' });
    await f.mount.dispatch('keydown', event);
    assert.equal(panel.open, false); assert.equal(event.prevented, true);
    assert.equal(globalThis.document.activeElement, panel.querySelector('summary'));
    assert.equal(h.ui.getDraft().task, 'Draft stays here');
  }
});

test('ready welcome stays quiet while setup problems remain actionable', async t => {
  const f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot(), h = mountMission(f, snapshot); await turn();
  await h.action('new-task');
  assert.equal(f.element('#conversation-welcome-status').hidden, true);
  snapshot.status.models = snapshot.status.models.map(model => ({ ...model, available: false }));
  snapshot.status.defaultModelAvailable = false; h.ui.update();
  assert.equal(f.element('#conversation-welcome-status').hidden, false);
  assert.equal(f.element('#conversation-welcome-action').hidden, false);
  assert.equal(f.element('#mission-start-button').dataset.mode, 'connect');
});

test('routine live activity is not repeated above the composer and recovery remains visible', async t => {
  const run = fixtureRun('single-status'), f = missionFixture(t, savedDrafts('')), snapshot = statusSnapshot([run]), h = mountMission(f, snapshot); await turn();
  assert.equal(f.element('#conversation-compose-status').hidden, true);
  assert.equal(f.element('#conversation-stop').hidden, false);
  snapshot.streamState = 'reconnecting'; h.ui.update();
  assert.equal(f.element('#conversation-compose-status').hidden, false);
  assert.match(f.element('#conversation-composer-status').textContent, /Reconnecting/);
  assert.equal(f.element('#conversation-stop').hidden, false);
});


function withChatMode(snapshot, available = false) {
  snapshot.status.chatMode = { available: true, ready: available, state: available ? 'ready' : 'schema-unverified', message: 'The response schema is unverified.' };
  snapshot.status.models.push({ id: 'chatgpt::chat-mode', providerId: 'chatgpt', displayName: 'ChatGPT Chat Mode', available, experimental: true, supportsTools: false, supportsReasoningSelection: false, routeState: snapshot.status.chatMode.state, availabilityReason: snapshot.status.chatMode.message });
  return snapshot;
}

test('a retired route cannot run even through a stale ready catalog and keeps authored reasoning for supported models', async t => {
  const f = missionFixture(t, savedDrafts('Keep my route draft', 'cloud::chosen')), snapshot = withChatMode(statusSnapshot(), true), h = mountMission(f, snapshot); await turn();
  assert.doesNotMatch(f.element('#mission-model').innerHTML, /chatgpt::chat-mode/);
  await h.effort('high'); await h.model('chatgpt::chat-mode');
  assert.equal(f.element('#mission-effort').disabled, true); assert.match(f.element('#mission-effort-note').textContent, /does not expose reasoning/);
  assert.equal(h.persisted().conversationDrafts.new.effort, 'high'); assert.equal(h.ui.getDraft().task, 'Keep my route draft');
  await h.submit(); assert.equal(h.starts.length, 0); assert.equal(h.connections.length, 1);
  await h.model('cloud::chosen'); assert.equal(f.element('#mission-effort').disabled, false); assert.equal(h.ui.getDraft().effort, 'high');
});

test('saved retired routes preserve the exact draft and lead to supported model settings', async t => {
  const f = missionFixture(t, savedDrafts('Do not consume this unsent message', 'chatgpt::chat-mode')), snapshot = withChatMode(statusSnapshot()), setups = [], h = mountMission(f, snapshot, { chatModeSetup: () => setups.push(true) }); await turn();
  assert.equal(h.ui.getDraft().model, 'chatgpt::chat-mode'); assert.equal(f.element('#mission-start-button').dataset.missionAction, 'connections');
  assert.match(f.element('#mission-start-button').textContent || f.element('#mission-start-button').innerHTML, /Choose model/);
  await h.submit(); assert.equal(setups.length, 0); assert.equal(h.starts.length, 0); assert.equal(h.connections.length, 1);
  assert.equal(h.ui.getDraft().task, 'Do not consume this unsent message'); assert.equal(h.persisted().conversationDrafts.new.model, 'chatgpt::chat-mode');
  snapshot.status.models = snapshot.status.models.filter(model => model.id !== 'chatgpt::chat-mode'); h.ui.update();
  assert.equal(h.ui.getDraft().model, 'chatgpt::chat-mode'); assert.equal(h.starts.length, 0);
});

test('a response route tag follows the recorded worker receipt, never the next-reply choice or live catalog', async t => {
  const run = fixtureRun('actual-route', 'completed'), f = missionFixture(t, savedDrafts('')), snapshot = withChatMode(statusSnapshot([run])), h = mountMission(f, snapshot); await turn();
  const slot = () => f.element('#conversation-timeline').children[0].querySelector('.conversation-route-slot');
  assert.equal(slot().hidden, true); await h.model('chatgpt::chat-mode'); assert.equal(slot().hidden, true, 'the picker cannot rewrite a completed response’s route');
  run.nodes.agent.resolvedModel = 'chatgpt::chat-mode'; h.ui.update(); assert.equal(slot().hidden, false); assert.match(slot().innerHTML, /ChatGPT Chat Mode/); assert.match(slot().innerHTML, /Retired/);
  await h.model('cloud::other'); snapshot.status.models = []; h.ui.update(); assert.match(slot().innerHTML, /data-response-route="chatgpt::chat-mode"/);
  run.nodes.agent.resolvedModel = 'cloud::default'; h.ui.update(); assert.equal(slot().hidden, true);
});

for (const savedChoice of [null, 'true', 'false']) test('Chat quiet defaults restore explicit pane choices: ' + (savedChoice ?? 'fresh'), async t => {
  const storage = new Map([['relay.mission.draft', JSON.stringify(savedDrafts(''))]]);
  if (savedChoice !== null) { storage.set('relay.ui.sidebar.collapsed', savedChoice); storage.set('relay.ui.plan.collapsed', savedChoice); }
  const f = missionFixture(t, {}, storage); globalThis.window.innerWidth = 1440;
  const run = plannedRun('quiet-pane-choice'), before = structuredClone(run), h = mountMission(f, statusSnapshot([run])); f.cleanup(() => h.ui.destroy()); await turn();
  const collapsed = savedChoice !== 'false';
  assert.equal(f.mount.classList.contains('sidebar-collapsed'), collapsed);
  assert.equal(h.ui.getWorkbench().collapsed, collapsed);
  assert.equal(f.element('#mission-plan').hidden, collapsed);
  assert.equal(f.element('#conversation-dialogue').hidden, false);
  assert.equal(f.element('#conversation-plan-toggle').hidden, false);
  await h.action('sidebar'); await h.action('toggle-plan'); h.ui.update();
  assert.equal(f.mount.classList.contains('sidebar-collapsed'), !collapsed);
  assert.equal(h.ui.getWorkbench().collapsed, !collapsed);
  assert.equal(storage.get('relay.ui.sidebar.collapsed'), String(!collapsed));
  assert.equal(storage.get('relay.ui.plan.collapsed'), String(!collapsed));
  await h.text('Keep this through a reload'); h.ui.destroy();
  const restored = missionFixture(t, {}, storage); globalThis.window.innerWidth = 1440;
  const resumed = mountMission(restored, statusSnapshot([run])); restored.cleanup(() => resumed.ui.destroy()); await turn();
  assert.equal(restored.mount.classList.contains('sidebar-collapsed'), !collapsed);
  assert.equal(resumed.ui.getWorkbench().collapsed, !collapsed);
  assert.equal(restored.element('#conversation-dialogue').hidden, false);
  assert.equal(resumed.ui.getDraft().task, 'Keep this through a reload');
  assert.deepEqual(run, before);
  assert.equal(h.starts.length + h.queued.length + h.mutations.length + resumed.starts.length + resumed.queued.length + resumed.mutations.length, 0);
});

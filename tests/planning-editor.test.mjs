import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createPlanningWorkspaceController, planningEditOperations } from '../public/planning-workspace-model.mjs';
import { initPlanningWorkspaceUI } from '../public/planning-workspace-ui.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';
import { taskPlanView } from '../public/task-plan-model.mjs';
import { createSwarmWorkflow, swarmAssignments, swarmWorkflowPlan } from '../public/swarm-model.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const action = (id, title = id) => ({ id, title, kind: 'action', status: 'pending', parentId: null, dependsOn: [], doneWhen: `${title} has an observable checked result.` });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture(t, { empty = false, width = 1440, ui = false, normalizeMarkup = false, readOnly = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-editor-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(), metas = new Map(), calls = [], timers = new Map(), saved = []; let timerId = 0, hook;
  for (const id of ['task-a', 'task-b']) {
    const state = await store.ensure({ taskId: id, runId: `run-${id}`, cwd, goal: `Objective for ${id}`, defaultPlan: true });
    if (!empty) await store.setPlan(id, { plan: { layout: 'parallel' }, steps: [action('read', 'Inspect inputs'), action('write', 'Build result')] }, { expectedRevision: state.revision, runId: `run-${id}`, nodeId: 'agent', schemaVersion: 4 });
    metas.set(id, { taskId: id, runId: `run-${id}`, runStatus: 'running', bucket: 'active', editable: !readOnly });
  }
  const api = async (url, options = 'GET', body) => {
    const method = typeof options === 'object' ? options.method || 'GET' : options; calls.push({ url, method, body });
    if (hook) { const result = await hook(url, method, body, options); if (result !== undefined) return result; }
    if (url.startsWith('/api/planning?')) {
      const params = new URL(url, 'http://fixture').searchParams, bucket = params.get('state'), query = params.get('query').toLowerCase(), all = [];
      for (const [id, meta] of metas) { const state = await store.get(id); if ((bucket === 'all' ? meta.bucket !== 'deleted' : bucket === meta.bucket) && state.goal.toLowerCase().includes(query)) all.push({ ...meta, goal: state.goal, revision: state.revision, progress: state.progress }); }
      return { plans: all, total: all.length, offset: 0, limit: 40, nextOffset: null, hasMore: false, healthy: true };
    }
    const match = url.match(/^\/api\/tasks\/([^/]+)(\/plan\/edit)?$/); assert.ok(match, url);
    if (method === 'GET') return store.get(match[1]);
    assert.equal(method, 'POST'); assert.equal(match[2], '/plan/edit');
    if (!metas.get(match[1])?.editable) throw Object.assign(new Error('Restore this chat before editing.'), { status: 409, code: 'PLANNING_CHAT_READ_ONLY' });
    return store.editPlan(match[1], { operations: body.operations }, { expectedRevision: body.expectedRevision, source: 'human' });
  };
  const controllerOptions = { pollMs: 0, awarenessEnabled: false, setTimer: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id), createId: () => 'new-action' };
  let workspace, controller;
  t.after(async () => { workspace ? workspace.destroy() : controller?.destroy(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const dom = ui ? planningDOM(t, { width, normalizeMarkup }) : null;
  workspace = ui ? initPlanningWorkspaceUI({ mount: dom.mount, api, controllerOptions, onSaved: value => saved.push(value), onNewChat() {} }) : null;
  controller = workspace?.controller || createPlanningWorkspaceController({ api, ...controllerOptions, onSaved: value => saved.push(value) });
  await controller.enter({ taskId: 'task-a' });
  return { store, controller, workspace, dom, calls, metas, saved, timers, hook(value) { hook = value; }, async event(state) { controller.handleEvent({ type: 'agent.event', data: { type: 'task.state', taskId: state.taskId, state } }); }, async flushTimer() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) await callback(); await turn(); } };
}

test('a human creates the first real action in an empty runtime plan with an observable criterion', async t => {
  const f = await fixture(t, { empty: true, ui: true });
  await f.dom.click('[data-planning-action="add"]');
  await f.dom.input('[data-planning-field="title"]', 'Inspect the actual input');
  await f.dom.input('[data-planning-field="doneWhen"]', 'The supplied input is read and its constraints are recorded.');
  assert.equal(f.dom.$('#planning-save').disabled, false);
  assert.equal(await f.controller.save(), true);
  const state = await f.store.get('task-a'); assert.equal(state.steps.length, 1); assert.equal(state.steps[0].title, 'Inspect the actual input'); assert.equal(state.steps[0].status, 'pending'); assert.equal(state.provenance.source, 'human'); assert.deepEqual(state.availableWork.ready, ['new-action']);
  assert.match(f.dom.$('#planning-editor-messages').textContent, /Saved revision/);
});

test('native blur and an unchanged poll keep the pressed Save control attached and submit exactly one saved action', async t => {
  const f = await fixture(t, { empty: true, ui: true, normalizeMarkup: true });
  await f.dom.click('[data-planning-action="add"]');
  await f.dom.input('[data-planning-field="title"]', 'Keep the first submitted action');
  const criterion = await f.dom.input('[data-planning-field="doneWhen"]', 'The real saved document contains the requested action exactly once.');
  criterion.focus();
  const pressed = f.dom.$('#planning-save');
  // Native pointer focus emits change on the edited field before completing
  // its click. Browser serialization also removes insignificant tag spacing.
  await criterion.dispatch('change', {}, true);
  assert.ok(f.dom.$('#planning-save') === pressed, 'Blur must not replace the pointer target.');
  await f.controller.refresh();
  assert.ok(f.dom.$('#planning-save') === pressed, 'An unchanged poll must preserve the pending pointer target.');
  assert.equal(pressed.isConnected, true);
  await f.dom.click(pressed);
  await f.dom.$('#planning-editor-form').dispatch('submit', { submitter: pressed }, true);
  const deadline = Date.now() + 2000;
  while (!f.saved.length && Date.now() < deadline) await turn();
  assert.equal(f.saved.length, 1);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  const state = await f.store.get('task-a');
  assert.equal(state.steps.length, 1);
  assert.equal(state.steps[0].title, 'Keep the first submitted action');
  assert.equal(f.controller.draft().dirty, false);
});

test('Objective and Add step remain the same controls through a coalesced update and open the intended editor', async t => {
  const f = await fixture(t, { ui: true, normalizeMarkup: true });
  f.controller.selectEditor('write');
  const objective = f.dom.$('#planning-task-bar [data-planning-action="objective"]');
  await f.controller.refresh();
  assert.ok(f.dom.$('#planning-task-bar [data-planning-action="objective"]') === objective, 'An unchanged update must preserve the Objective pointer target.');
  await f.dom.click(objective);
  assert.equal(f.controller.draft().mode, 'goal');
  const goal = f.dom.$('[data-planning-field="goal"]');
  assert.ok(goal);
  const add = f.dom.$('#planning-task-bar [data-planning-action="add"]');
  await goal.dispatch('change', {}, true);
  await f.controller.refresh();
  assert.ok(f.dom.$('#planning-task-bar [data-planning-action="add"]') === add, 'Blur and polling must preserve the Add step pointer target.');
  await f.dom.click(add);
  assert.equal(f.controller.draft().mode, 'add');
  assert.ok(f.dom.$('[data-planning-field="title"]'));
  assert.equal(f.dom.$('[data-planning-field="goal"]'), null);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal((await f.store.get('task-a')).steps.length, 2);
});

test('a refreshed catalog keeps the pressed plan row and its children while metadata changes, then selects that saved task', async t => {
  const f = await fixture(t, { ui: true, normalizeMarkup: true }), pending = deferred();
  const before = await f.store.get('task-b');
  const updated = await f.store.editPlan('task-b', { operations: [{ type: 'metadata', patch: { goal: 'The newly saved shared swarm objective' } }] }, { expectedRevision: before.revision, source: 'human' });
  f.hook(url => url.startsWith('/api/planning?') ? pending.promise : undefined);
  const reopening = f.controller.enter({ taskId: 'task-a' }); await turn();
  const pressed = f.dom.$('#planning-catalog-list [data-planning-task="task-b"]'), title = pressed.querySelector('strong'); pressed.focus();
  const plans = await Promise.all([...f.metas].map(async ([taskId, meta]) => ({ ...meta, ...(await f.store.get(taskId)) })));
  pending.resolve({ plans, total: plans.length, offset: 0, limit: 40, nextOffset: null, hasMore: false, healthy: true });
  await reopening;
  assert.ok(f.dom.$('#planning-catalog-list [data-planning-task="task-b"]') === pressed, 'An incoming catalog response must retain the pressed task button.');
  assert.ok(pressed.querySelector('strong') === title, 'Updating a title must retain the actual pointer target inside the task button.');
  assert.equal(title.textContent, updated.goal);
  assert.equal(pressed.isConnected, true); assert.equal(document.activeElement, pressed);
  await f.dom.click(title);
  assert.equal(f.controller.state.taskId, 'task-b');
  assert.equal(f.dom.$('#planning-plan-mount').dataset.planTask, 'task-b');
  assert.equal(f.dom.$('[data-planning-field="goal"]').value, updated.goal);
  assert.equal(pressed.getAttribute('aria-current'), 'true');
  assert.equal(f.dom.$('#planning-catalog-list [data-planning-task="task-a"]').getAttribute('aria-current'), 'false');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('an unchanged task update keeps the saved-plan pagination pointer target and loads the next page once', async t => {
  const f = await fixture(t, { ui: true, normalizeMarkup: true });
  const plans = await Promise.all([...f.metas].map(async ([taskId, meta]) => ({ ...meta, ...(await f.store.get(taskId)) })));
  f.hook(url => {
    if (!url.startsWith('/api/planning?')) return;
    const offset = Number(new URL(url, 'http://fixture').searchParams.get('offset'));
    return { plans: plans.slice(offset, offset + 1), total: plans.length, offset, limit: 1, nextOffset: offset === 0 ? 1 : null, hasMore: offset === 0, healthy: true };
  });
  await f.controller.loadCatalog();
  const pressed = f.dom.$('#planning-catalog-footer [data-planning-action="more"]');
  assert.ok(pressed); pressed.focus();
  await f.event(await f.store.get('task-a'));
  assert.ok(f.dom.$('#planning-catalog-footer [data-planning-action="more"]') === pressed, 'An unchanged task update must keep the pagination pointer target.');
  assert.equal(pressed.isConnected, true);
  assert.equal(document.activeElement, pressed);
  await f.dom.click(pressed);
  assert.deepEqual(f.controller.state.plans.map(plan => plan.taskId), ['task-a', 'task-b']);
  assert.equal(f.calls.filter(call => call.url.startsWith('/api/planning?') && new URL(call.url, 'http://fixture').searchParams.get('offset') === '1').length, 1);
  assert.equal(f.dom.$('#planning-catalog-footer [data-planning-action="more"]'), null);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('an open draft switcher retains its focused pointer target through an unchanged poll and opens the saved local draft', async t => {
  const f = await fixture(t, { ui: true, normalizeMarkup: true });
  f.controller.selectEditor('write');
  await f.dom.input('[data-planning-field="title"]', 'My unfinished result detail');
  f.controller.selectEditor();
  const disclosure = f.dom.$('#planning-draft-switcher details'); disclosure.open = true;
  const pressed = f.dom.$('#planning-draft-switcher [data-planning-draft="write"]'); pressed.focus();
  await f.controller.refresh();
  assert.ok(f.dom.$('#planning-draft-switcher [data-planning-draft="write"]') === pressed, 'Opening a native disclosure must not make an unchanged render replace the draft pointer target.');
  assert.equal(disclosure.open, true);
  assert.equal(pressed.isConnected, true);
  assert.equal(document.activeElement, pressed);
  await f.dom.click(pressed);
  assert.equal(f.controller.draft().stepId, 'write');
  assert.equal(f.dom.$('[data-planning-field="title"]').value, 'My unfinished result detail');
  assert.equal(f.controller.draft().dirty, true);
  assert.equal((await f.store.get('task-a')).steps.find(step => step.id === 'write').title, 'Build result');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('objective edits update the same saved task without replacing steps, evidence or execution receipts', async t => {
  const f = await fixture(t, { ui: true }), before = await f.store.get('task-a');
  await f.dom.input('[data-planning-field="goal"]', 'Refine the outcome with an explicit user requirement.');
  assert.equal(await f.controller.save(), true);
  const state = await f.store.get('task-a'), request = f.calls.find(call => call.method === 'POST');
  assert.equal(state.goal, 'Refine the outcome with an explicit user requirement.'); assert.deepEqual(state.steps, before.steps);
  assert.deepEqual(request.body.operations, [{ type: 'metadata', patch: { goal: state.goal } }]); assert.equal(request.body.expectedRevision, before.revision);
});

test('atomic branch creation, path choice and dependencies use the validated graph instead of fabricated progress', async t => {
  const f = await fixture(t); f.controller.startAdd(); f.controller.edit('title', 'Choose an approach'); f.controller.edit('kind', 'choice');
  f.controller.edit('children', [{ title: 'Repair', doneWhen: 'The existing path passes the actual check.', condition: 'The existing path supports the requirement.' }, { title: 'Replace', doneWhen: 'The replacement passes the actual check.', condition: 'Repair cannot meet the requirement.' }]);
  assert.equal(await f.controller.save(), true);
  let state = await f.store.get('task-a'); assert.equal(state.steps.length, 5); assert.equal(state.availableWork.byId['new-action-1'].state, 'awaiting-choice'); assert.equal(state.progress.done, 0);
  f.controller.edit('selectedChildId', 'new-action-1'); assert.equal(await f.controller.save(), true);
  state = await f.store.get('task-a'); assert.equal(state.availableWork.byId['new-action-1'].state, 'ready'); assert.equal(state.availableWork.byId['new-action-2'].state, 'unselected'); assert.equal(state.steps.find(step => step.id === 'new-action-2').status, 'pending');
  f.controller.selectEditor('write'); f.controller.edit('dependsOn', ['read']); assert.equal(await f.controller.save(), true);
  state = await f.store.get('task-a'); assert.equal(state.availableWork.byId.write.state, 'waiting'); assert.equal(state.availableWork.byId.write.prerequisites[0].id, 'read');
});

test('Enlarge keeps one pane visible and deliberate editing restores the same unsaved fields', async t => {
  const f = await fixture(t, { ui: true }); f.controller.selectEditor('write'); f.controller.setPane('edit');
  const input = await f.dom.input('[data-planning-field="title"]', 'My unfinished title'); input.focus(); input.setSelectionRange(3, 10, 'backward');
  const editor = f.dom.$('#planning-editor-panel'), catalog = f.dom.$('#planning-saved-panel'), control = f.dom.$('[data-plan-action="enlarge"]'), draft = structuredClone(f.controller.draft()); editor.scrollTop = 177;
  await f.dom.click('[data-planning-pane="plan"]');
  await f.dom.click(control);
  assert.equal(f.dom.mount.dataset.planEnlarged, 'true'); assert.equal(editor.hidden, true); assert.equal(editor.inert, true); assert.equal(catalog.hidden, true);
  f.workspace.update();
  assert.equal(f.dom.$('[data-planning-field="title"]'), input); assert.equal(f.dom.$('[data-plan-action="enlarge"]'), control); assert.equal(document.activeElement, control);
  assert.equal(input.value, 'My unfinished title'); assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 10); assert.equal(input.selectionDirection, 'backward');
  await f.dom.key(control, 'Escape');
  assert.equal(editor.hidden, true); assert.equal(editor.inert, true); assert.equal(catalog.hidden, true); assert.equal(f.dom.$('#planning-board-panel').hidden, false); assert.equal(editor.scrollTop, 177);
  assert.equal(f.dom.$('[data-planning-field="title"]'), input); assert.deepEqual(f.controller.draft(), draft); assert.equal(document.activeElement, control);
  await f.dom.click(control); const node = f.dom.$('[data-plan-node="write"]'); node.focus(); await f.dom.key(node, 'Enter');
  assert.equal(f.dom.mount.dataset.planEnlarged, 'false'); assert.equal(editor.hidden, false); assert.equal(document.activeElement, input);
  assert.equal(input.value, 'My unfinished title'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('live agent plan updates preserve the actual editor input, selection, scroll and dirty revision', async t => {
  const f = await fixture(t, { ui: true }); f.controller.selectEditor('write'); f.controller.setPane('edit');
  const input = await f.dom.input('[data-planning-field="title"]', 'My unfinished title'); input.focus(); input.setSelectionRange(3, 10, 'backward'); f.dom.$('#planning-editor-panel').scrollTop = 177;
  const prior = f.controller.draft().revision, saved = await f.store.setStep('task-a', 'read', { status: 'done', evidence: 'Read the actual supplied file and checked its constraints.' }, { expectedRevision: prior, runId: 'run-task-a', nodeId: 'agent', schemaVersion: 4 });
  await f.event(saved);
  assert.equal(f.dom.$('[data-planning-field="title"]'), input); assert.equal(document.activeElement, input); assert.equal(input.value, 'My unfinished title'); assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 10); assert.equal(input.selectionDirection, 'backward'); assert.equal(f.dom.$('#planning-editor-panel').scrollTop, 177);
  assert.equal(f.controller.draft().revision, prior); assert.equal(f.controller.entry().task.revision, saved.revision); assert.equal(f.dom.$('#planning-save').disabled, true); assert.match(f.dom.$('#planning-editor-messages').textContent, /Your draft/);
  assert.equal(f.dom.$('[data-plan-node="read"]').dataset.status, 'done');
});

test('a save racing an agent revision preserves the draft and requires explicit review before a narrow retry', async t => {
  const f = await fixture(t); f.controller.selectEditor('write'); f.controller.edit('title', 'Human title'); const revision = f.controller.draft().revision;
  await f.store.editPlan('task-a', { operations: [{ type: 'update', stepId: 'write', patch: { note: 'New agent observation' } }] }, { expectedRevision: revision, source: 'agent' });
  assert.equal(await f.controller.save(), false); assert.equal(f.controller.draft().conflict, true); assert.equal(f.controller.draft().values.title, 'Human title'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  await f.controller.reviewLatest(); assert.equal(f.controller.draft().values.note, ''); assert.equal(f.controller.applyReviewedDraft(), true); assert.equal(f.controller.draft().values.note, 'New agent observation');
  assert.equal(await f.controller.save(), true);
  const saved = await f.store.get('task-a'), request = f.calls.filter(call => call.method === 'POST').at(-1); assert.equal(saved.steps[1].title, 'Human title'); assert.equal(saved.steps[1].note, 'New agent observation'); assert.deepEqual(request.body.operations, [{ type: 'update', stepId: 'write', patch: { title: 'Human title' } }]);
});

test('a removed step cannot be recreated implicitly by stale conflict recovery', async t => {
  const f = await fixture(t); f.controller.selectEditor('write'); f.controller.edit('title', 'Keep this draft text');
  const state = await f.store.editPlan('task-a', { operations: [{ type: 'remove', stepId: 'write' }] }, { expectedRevision: f.controller.draft().revision, source: 'agent' }); await f.event(state);
  await f.controller.reviewLatest(); assert.equal(f.controller.applyReviewedDraft(), false); assert.match(f.controller.draft().error, /removed/); assert.equal(f.controller.draft().values.title, 'Keep this draft text'); assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('switching plans keeps separate drafts and a delayed save retains its receipt without touching the newer editor', async t => {
  const f = await fixture(t), pending = deferred(); let pendingWrite;
  f.controller.edit('goal', 'Saved after leaving this view'); f.hook((url, method, body) => { if (method === 'POST') { pendingWrite = { url, body }; return pending.promise; } });
  const saving = f.controller.save(); await turn(); await f.controller.selectTask('task-b'); f.controller.edit('goal', 'Task B current draft'); const bDraft = f.controller.draft(); f.controller.leave();
  const result = await f.store.editPlan('task-a', { operations: pendingWrite.body.operations }, { expectedRevision: pendingWrite.body.expectedRevision, source: 'human' }); pending.resolve(result); assert.equal(await saving, true);
  assert.equal(f.controller.state.taskId, 'task-b'); assert.equal(f.controller.draft(), bDraft); assert.equal(bDraft.values.goal, 'Task B current draft'); assert.equal(f.saved[0].taskId, 'task-a'); assert.equal(f.controller.entries.get('task-a').task.goal, 'Saved after leaving this view');
});

test('an abandoned plan read cannot replace a newer selected task', async t => {
  const f = await fixture(t), pending = deferred(); f.hook((url, method) => url === '/api/tasks/task-a' && method === 'GET' ? pending.promise : undefined);
  const reading = f.controller.selectTask('task-a'); await turn(); await f.controller.selectTask('task-b'); f.controller.edit('goal', 'B owns this editor'); pending.resolve(await f.store.get('task-a')); await reading;
  assert.equal(f.controller.state.taskId, 'task-b'); assert.equal(f.controller.draft().values.goal, 'B owns this editor'); assert.equal(f.controller.state.taskLoading, false);
});

test('an uncertain save is read back and never automatically replayed', async t => {
  const f = await fixture(t); f.controller.edit('goal', 'Actually saved, response lost');
  f.hook(async (url, method, body) => { if (method !== 'POST') return; await f.store.editPlan('task-a', { operations: body.operations }, { expectedRevision: body.expectedRevision, source: 'human' }); throw Object.assign(new Error('Response lost.'), { uncertain: true }); });
  assert.equal(await f.controller.save(), false); assert.equal(f.controller.draft().uncertain, true); assert.equal(f.controller.entry().task.goal, 'Actually saved, response lost');
  await f.controller.reviewLatest(); f.controller.applyReviewedDraft(); assert.equal(f.controller.draft().dirty, false); assert.equal(await f.controller.save(), false); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('archived plans remain editable while Trash plans expose a read-only form and cannot submit', async t => {
  const f = await fixture(t, { ui: true }); f.metas.get('task-a').bucket = 'archived'; await f.controller.refresh(); assert.equal(f.controller.editable(), true);
  f.metas.get('task-a').bucket = 'deleted'; f.metas.get('task-a').editable = false; f.controller.setFilter({ bucket: 'deleted' }); await f.controller.loadCatalog();
  assert.equal(f.controller.editable(), false); assert.equal(f.dom.$('.planning-edit-fields').disabled, true); assert.equal(f.controller.edit('goal', 'Forbidden replacement'), false); assert.equal(await f.controller.save(), false); assert.equal(f.calls.some(call => call.method === 'POST'), false); assert.match(f.dom.$('#planning-editor-messages').textContent, /Restore its chat/);
});

test('invalid dependency cycles fail atomically while preserving authored fields for correction', async t => {
  const f = await fixture(t); f.controller.selectEditor('read'); f.controller.edit('dependsOn', ['write']); assert.equal(await f.controller.save(), true); f.controller.selectEditor('write'); f.controller.edit('dependsOn', ['read']);
  const revision = f.controller.entry().task.revision; assert.equal(await f.controller.save(), false); assert.match(f.controller.draft().error, /cycle/); assert.deepEqual(f.controller.draft().values.dependsOn, ['read']); assert.equal((await f.store.get('task-a')).revision, revision); assert.deepEqual((await f.store.get('task-a')).steps.find(step => step.id === 'write').dependsOn, []);
});

test('stream deltas do not poll plans and bursts of real task events coalesce into one refresh', async t => {
  const f = await fixture(t), before = f.calls.length;
  for (let index = 0; index < 60; index++) f.controller.handleEvent({ type: 'agent.event', data: { type: 'item.agentMessage.delta', delta: 'text' } });
  assert.equal(f.timers.size, 0); assert.equal(f.calls.length, before);
  for (let index = 0; index < 15; index++) f.controller.handleEvent({ type: 'agent.event', data: { type: 'task.state', taskId: 'task-a' } });
  assert.equal(f.timers.size, 1); await f.flushTimer(); assert.equal(f.calls.filter(call => call.url === '/api/tasks/task-a').length, 2);
});

test('the visible outline tree row opens the same saved step in the external Planning editor after switching from the map', async t => {
  const f = await fixture(t, { ui: true }), before = await f.store.get('task-a');
  await f.dom.click('#planning-plan-mount [data-plan-action="view-map"]');
  assert.equal(f.dom.$('#planning-plan-mount').dataset.planPresentation, 'map');
  await f.dom.click('#planning-plan-mount [data-plan-action="view-outline"]');
  assert.equal(f.dom.$('#planning-plan-mount').dataset.planPresentation, 'outline');
  const row = f.dom.$('#planning-plan-mount [role="treeitem"][data-plan-node="read"]');
  assert.ok(row); assert.equal(row.closest('[role="tree"]').hidden, false);
  await f.dom.click(row);
  assert.equal(f.controller.draft().stepId, 'read');
  assert.equal(f.dom.$('[data-planning-field="title"]').value, 'Inspect inputs');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal((await f.store.get('task-a')).revision, before.revision);
});

test('mobile tree keyboard editing and resize keep focus on a visible pane and retain the draft', async t => {
  const f = await fixture(t, { ui: true, width: 390 }), node = f.dom.$('[data-plan-node="write"]'); node.focus(); await f.dom.key(node, 'Enter');
  assert.equal(f.controller.state.pane, 'edit'); assert.equal(f.dom.$('#planning-editor-panel').hidden, false); const input = f.dom.$('[data-planning-field="title"]'); assert.equal(document.activeElement, input);
  await f.dom.input('[data-planning-field="title"]', 'Mobile draft'); input.setSelectionRange(2, 7); await f.dom.resize(1440); await f.dom.resize(320);
  assert.equal(f.controller.state.pane, 'edit'); assert.equal(f.dom.$('#planning-editor-panel').hidden, false); assert.equal(document.activeElement, input); assert.equal(input.value, 'Mobile draft'); assert.equal(input.selectionEnd, 7);
});

test('authoritative readiness, owners, external actor names and execution are shown as data without asserting completion', async t => {
  const f = await fixture(t, { ui: true }), state = await f.store.get('task-a');
  state.provenance.actor = { type: 'external-agent', id: 'outside-agent', name: '<script>outside</script>' };
  state.availableWork.byId.write = { state: 'waiting', reason: 'Waiting for the actual required input.', prerequisites: [], owner: { nodeId: 'worker', label: 'Implementation owner', scopeStepId: 'write' }, execution: { status: 'pending', runId: 'run-task-a', nodeId: 'worker' } };
  await f.event(state); f.controller.selectEditor('write');
  const view = taskPlanView(state), runtime = f.dom.$('#planning-editor-runtime'); assert.equal(view.byId.get('write').statusLabel, 'Waiting'); assert.equal(view.byId.get('write').status, 'pending'); assert.match(runtime.textContent, /Implementation owner/); assert.match(runtime.textContent, /Execution · pending/); assert.match(f.dom.$('#planning-editor-messages').innerHTML, /&lt;script&gt;outside&lt;\/script&gt;/); assert.doesNotMatch(f.dom.$('#planning-editor-messages').innerHTML, /<script>/);
});

test('delivery swarms start an implementation owner and support explicit disjoint writer assignments', () => {
  const workflow = createSwarmWorkflow({ id: 'delivery-team', members: 3, pattern: 'delivery' }), workers = workflow.nodes.filter(node => node.type === 'agent' && node.id !== 'coordinator');
  assert.equal(workflow.planning.shared, true); assert.equal(workers[0].assignment.canWrite, true); assert.equal(workers[0].sandbox, 'danger-full-access'); assert.ok(workers.slice(1).every(node => node.assignment.canWrite === false && node.sandbox === 'read-only')); assert.ok(workers.every(node => !workflow.edges.some(edge => edge.target === node.id && edge.source === 'coordinator')));
  const assignments = swarmAssignments({ members: 3, pattern: 'delivery' }); assignments[1].canWrite = true; assert.throws(() => createSwarmWorkflow({ assignments, members: 3, pattern: 'delivery' }), /disjoint file boundaries/); assignments[0].scope = 'Implement only public/new-view.mjs and its UI tests.'; assignments[1].scope = 'Implement only lib/new-reader.mjs and its backend tests.';
  const scoped = createSwarmWorkflow({ assignments, members: 3, pattern: 'delivery' }); assert.equal(scoped.nodes.find(node => node.id === 'specialist-2').assignment.scope, assignments[1].scope); assert.equal(scoped.nodes.find(node => node.id === 'specialist-2').sandbox, 'danger-full-access');
  const preview = swarmWorkflowPlan(workflow), view = taskPlanView(preview); assert.equal(view.roots.length, 4); assert.deepEqual(view.byId.get('agent-coordinator').dependsOn, workers.map(node => `agent-${node.id}`)); assert.equal(view.progress.done, 0); assert.equal(preview.execution, undefined);
  assert.throws(() => createSwarmWorkflow({ members: 100 }), /99 specialists/); assert.equal(createSwarmWorkflow({ members: 48 }).settings.maxParallel, 48);
});

for(const width of [400,1440])test('Planning reveals one working pane and retains draft correction context at '+width+'px',async t=>{
  const f=await fixture(t,{ui:true,width}),visible=()=>['#planning-board-panel','#planning-editor-panel','#planning-saved-panel'].filter(selector=>!f.dom.$(selector).hidden);
  assert.deepEqual(visible(),['#planning-board-panel']);await f.dom.click('[data-planning-pane="saved"]');assert.deepEqual(visible(),['#planning-saved-panel']);f.controller.selectEditor('write');await f.dom.click('[data-planning-pane="edit"]');assert.deepEqual(visible(),['#planning-editor-panel']);
  const input=await f.dom.input('[data-planning-field="title"]','An exact unfinished correction');input.focus();input.setSelectionRange(3,12,'backward');f.dom.$('#planning-editor-panel').scrollTop=123;
  await f.dom.click('[data-planning-pane="plan"]');assert.deepEqual(visible(),['#planning-board-panel']);assert.equal(f.dom.$('#planning-editor-panel').inert,true);
  const revision=f.controller.draft().revision,saved=await f.store.setStep('task-a','read',{status:'done',evidence:'Verified the actual fixture input.'},{expectedRevision:revision,runId:'run-task-a',nodeId:'agent',schemaVersion:4});await f.event(saved);
  assert.equal(f.dom.$('#planning-draft-alert').hidden,false);assert.match(f.dom.$('#planning-draft-alert').textContent,/Review/);await f.dom.click('[data-planning-action="review-draft"]');
  assert.deepEqual(visible(),['#planning-editor-panel']);assert.equal(f.dom.$('[data-planning-field="title"]'),input);assert.equal(document.activeElement,input);assert.equal(input.value,'An exact unfinished correction');assert.equal(input.selectionStart,3);assert.equal(input.selectionEnd,12);assert.equal(f.dom.$('#planning-editor-panel').scrollTop,123);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});

for(const width of [400,1440])for(const readOnly of [false,true])test('selecting an empty '+(readOnly?'read-only':'editable')+' saved plan puts focus on visible work at '+width+'px',async t=>{
  const f=await fixture(t,{empty:true,ui:true,width,readOnly});await f.dom.click('[data-planning-pane="saved"]');const row=f.dom.$('#planning-catalog-list [data-planning-task="task-b"]');row.focus();await f.dom.click(row);
  const board=f.dom.$('#planning-board-panel'),saved=f.dom.$('#planning-saved-panel'),more=f.dom.$('[data-planning-disclosure="plan-actions"]'),target=readOnly?board:f.dom.$('[data-planning-action="add"]');
  assert.equal(f.controller.state.taskId,'task-b');assert.equal(f.controller.state.pane,'plan');assert.equal(board.hidden,false);assert.equal(board.inert,false);assert.equal(saved.hidden,true);assert.equal(saved.inert,true);assert.equal(f.dom.$('#planning-plan-mount [data-plan-node]'),null);assert.equal(more.open,false);assert.equal(document.activeElement,target);assert.deepEqual(target.focusOptions,{preventScroll:true});if(readOnly)assert.equal(board.getAttribute('tabindex'),'-1');
  for(let node=target;node;node=node.parentElement){assert.equal(node.hidden,false,'focus cannot remain in a hidden pane');assert.equal(node.inert,false,'focus cannot remain in an inert pane');if(node.tagName==='DETAILS')assert.equal(node.open,true,'focus cannot remain inside a closed action menu');}
  if(!readOnly){await f.dom.click(target);assert.equal(f.dom.$('#planning-editor-panel').hidden,false);assert.equal(f.controller.draft().mode,'add');}
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0,'selecting an empty saved plan must not create steps or dispatch work');
});

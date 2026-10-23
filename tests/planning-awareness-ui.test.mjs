import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanningAwarenessController, normalizePlanningAwareness, planningAwarenessView } from '../public/planning-awareness.mjs';
import { initPlanningWorkspaceUI, renderPlanningAwareness } from '../public/planning-workspace-ui.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const turn = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const step = (id, parentId = null, kind = 'action') => ({ id, title: `Step ${id}`, kind, parentId, status: 'pending', dependsOn: [], doneWhen: 'An actual result is checked.' });
const task = id => ({ taskId: id, revision: 5, goal: 'Shared objective', plan: { layout: 'parallel', detail: 'balanced' }, steps: [step('group-a', null, 'parallel'), step('a', 'group-a'), step('b')], progress: { total: 2, done: 0 }, availableWork: { ready: ['a', 'b'], active: [], byId: {} } });
const worker = (id, overrides = {}) => ({ id, runId: 'run-a', nodeId: id, label: `Agent ${id}`, scopeStepId: null, lastReadRevision: 5, lastReadAt: '2026-10-20T00:00:00Z', pendingRevision: null, state: 'current', status: 'running', ...overrides });
function clock() {
  let current = Date.parse('2026-10-20T00:00:00Z'), count = 0; const timers = new Map();
  return { now: () => current, setTimer(fn, ms) { const id = ++count; timers.set(id, { fn, due: current + ms }); return id; }, clearTimer: id => timers.delete(id), timers,
    async advance(ms) { const end = current + ms; for (let guard = 0; guard < 1000; guard++) { const next = [...timers.entries()].filter(([, item]) => item.due <= end).sort((a, b) => a[1].due - b[1].due)[0]; if (!next) { current = end; await turn(); return; } current = next[1].due; timers.delete(next[0]); await next[1].fn(); await turn(); } throw new Error('Timer loop did not settle.'); },
  };
}
function fixture(t, { withUI = false, width = 1440 } = {}) {
  let workspace, awareness;
  t.after(async () => { workspace ? workspace.destroy() : awareness?.destroy(); await turn(); });
  const time = clock(), documents = new Map(['task-a', 'task-b'].map(id => [id, task(id)])), presence = new Map(), calls = [], workers = [worker('author', { scopeStepId: 'group-a' }), worker('reviewer', { scopeStepId: 'b', lastReadRevision: 3, pendingRevision: 5, state: 'needs-review' })]; let hook, count = 0;
  const snapshot = id => ({ taskId: id, revision: documents.get(id).revision, presence: [...presence.values()].filter(item => item.taskId === id).map(({ taskId, ...item }) => item), workers: structuredClone(workers) });
  const api = async (url, options = 'GET', body) => {
    const method = typeof options === 'object' ? options.method || 'GET' : options; calls.push({ url, method, body: structuredClone(body), at: time.now() });
    if (hook) { const result = await hook(url, method, body, options); if (result !== undefined) return result; }
    if (url.startsWith('/api/planning?')) return { plans: [...documents.values()].map(value => ({ taskId: value.taskId, goal: value.goal, revision: value.revision, runId: `run-${value.taskId}`, runStatus: 'running', editable: true, bucket: 'active', progress: value.progress })), total: 2, hasMore: false, healthy: true };
    const match = url.match(/^\/api\/tasks\/(task-[ab])(?:\/plan\/(awareness|presence|edit))?$/); assert.ok(match, url); const [, id, operation] = match;
    if (!operation) return structuredClone(documents.get(id));
    if (operation === 'awareness') return snapshot(id);
    if (operation === 'presence') {
      if (method === 'POST') presence.set(body.editorId, { taskId: id, editorId: body.editorId, stepId: body.stepId, label: 'This browser', expiresAt: new Date(time.now() + 20000).toISOString() });
      else if (method === 'DELETE') presence.delete(body.editorId);
      else assert.fail(`Unexpected presence method ${method}`);
      return snapshot(id);
    }
    const value = documents.get(id); assert.equal(body.expectedRevision, value.revision); value.revision++;
    for (const edit of body.operations) if (edit.type === 'metadata') Object.assign(value, edit.patch); else if (edit.type === 'update') Object.assign(value.steps.find(item => item.id === edit.stepId), edit.patch);
    return structuredClone(value);
  };
  const options = { setTimer: time.setTimer, clearTimer: time.clearTimer, now: time.now, createEditorId: () => `editor-${++count}` };
  const dom = withUI ? planningDOM(t, { width, normalizeMarkup: true }) : null;
  workspace = withUI ? initPlanningWorkspaceUI({ mount: dom.mount, api, controllerOptions: { pollMs: 0, setTimer: time.setTimer, clearTimer: time.clearTimer, awarenessOptions: options } }) : null;
  awareness = workspace?.controller.awareness || createPlanningAwarenessController({ api, ...options });
  return { time, api, calls, snapshot, documents, presence, workers, awareness, workspace, dom, hook(value) { hook = value; }, async enter(id = 'task-a') { if (workspace) await workspace.enter({ taskId: id }); else { awareness.enter(id); await awareness.refresh(); } await turn(); } };
}

test('presence sends only lease and saved step identifiers, renews during activity, and ends after idle', async t => {
  const f = fixture(t); await f.enter();
  assert.equal(f.calls.some(call => call.method === 'POST'), false, 'Reading a plan is not editing it.');
  f.awareness.edit('a'); await turn();
  for (let index = 0; index < 5; index++) { await f.time.advance(3000); f.awareness.edit('a'); await turn(); }
  const posts = f.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[1].at - posts[0].at, 8000);
  assert.deepEqual(posts[0].body, { editorId: 'editor-1', stepId: 'a' });
  assert.equal(f.awareness.state.advertised, true);
  await f.time.advance(16000);
  assert.equal(f.awareness.state.editing, false); assert.equal(f.presence.size, 0);
  assert.deepEqual(f.calls.find(call => call.method === 'DELETE').body, { editorId: 'editor-1' });
});

test('a delayed lease response is released after navigation and cannot clear a new lease', async t => {
  const f = fixture(t), pending = deferred(); await f.enter();
  f.hook(async (url, method, body) => { if (method !== 'POST' || body.editorId !== 'editor-1') return; await pending.promise; f.presence.set(body.editorId, { taskId: 'task-a', editorId: body.editorId, stepId: body.stepId, label: 'Old editor', expiresAt: new Date(f.time.now() + 20000).toISOString() }); return f.snapshot('task-a'); });
  f.awareness.edit('a'); await turn();
  f.awareness.enter('task-b'); await f.awareness.refresh(); f.awareness.edit('b'); await turn();
  assert.equal(f.awareness.state.editorId, 'editor-2');
  pending.resolve(); await turn();
  assert.equal(f.presence.has('editor-1'), false); assert.equal(f.presence.has('editor-2'), true);
  assert.equal(f.awareness.state.taskId, 'task-b'); assert.equal(f.awareness.state.editorId, 'editor-2');
  assert.equal(f.awareness.state.snapshot.taskId, 'task-b');
});

test('late awareness reads cannot replace another task or turn an expired editor into current presence', async t => {
  const f = fixture(t), pending = deferred(); await f.enter();
  f.hook((url, method) => url.includes('task-a/plan/awareness') ? pending.promise : undefined);
  const reading = f.awareness.refresh(); f.awareness.enter('task-b'); await f.awareness.refresh();
  pending.resolve(f.snapshot('task-a')); await reading;
  assert.equal(f.awareness.state.snapshot.taskId, 'task-b');
  const value = normalizePlanningAwareness({ ...f.snapshot('task-b'), presence: [{ editorId: 'other', stepId: 'b', label: 'Another editor', expiresAt: new Date(f.time.now() + 1).toISOString() }] }, 'task-b');
  assert.equal(planningAwarenessView(value, { task: task('task-b'), stepId: 'b', now: f.time.now() }).presence.length, 1);
  assert.equal(planningAwarenessView(value, { task: task('task-b'), stepId: 'b', now: f.time.now() + 2 }).presence.length, 0);
});

test('read receipts are scoped to selected work and never infer a read from a new saved revision', async t => {
  const f = fixture(t); await f.enter();
  const value = { ...f.snapshot('task-a'), revision: 9, presence: [{ editorId: 'other', stepId: 'b', label: 'Other editor', expiresAt: new Date(f.time.now() + 20000).toISOString() }] };
  const a = planningAwarenessView(value, { task: task('task-a'), stepId: 'a', now: f.time.now() });
  assert.deepEqual(a.workers.map(item => item.id), ['author']); assert.equal(a.pending.length, 0); assert.equal(a.presence.length, 0); assert.equal(a.workers[0].lastReadRevision, 5);
  const b = planningAwarenessView(value, { task: task('task-a'), stepId: 'b', now: f.time.now() });
  assert.equal(b.pending.length, 1); assert.equal(b.workers[0].lastReadRevision, 3); assert.equal(b.presence.length, 1);
  const html = renderPlanningAwareness(task('task-a'), { stepId: 'b', mode: 'step' }, { snapshot: value }, { now: f.time.now() });
  assert.match(html, /Needs revision 5/); assert.match(html, /Read revision 3/); assert.doesNotMatch(html, /Read revision 9/); assert.match(html, /action already underway can finish/);
});

test('untrusted presence names are escaped and no editing or read assertion is fabricated when unavailable', async t => {
  const f = fixture(t); await f.enter();
  const value = normalizePlanningAwareness({ ...f.snapshot('task-a'), presence: [{ editorId: 'other', stepId: null, label: '<img src=x onerror=alert(1)>', expiresAt: new Date(f.time.now() + 20000).toISOString() }], workers: [worker('unread', { lastReadRevision: null, lastReadAt: null, state: 'unread', label: '<script>unsafe</script>' })] }, 'task-a');
  const html = renderPlanningAwareness(task('task-a'), { stepId: null, mode: 'goal' }, { snapshot: value }, { now: f.time.now() });
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;img/); assert.match(html, /No plan read recorded/);
  f.hook(() => { throw new Error('Network unavailable'); });
  f.awareness.edit('a'); await turn();
  assert.equal(f.awareness.state.advertised, false); assert.match(f.awareness.state.error, /could not be shared/);
});

test('awareness updates preserve focused input, local drafts, pressed controls, and open read receipt details', async t => {
  const f = fixture(t, { withUI: true }); await f.enter(); const c = f.workspace.controller;
  c.selectEditor('b'); c.setPane('edit');
  const input = f.dom.$('[data-planning-field="title"]'); input.focus(); input.setSelectionRange(2, 7, 'backward');
  await f.dom.input('[data-planning-field="title"]', 'My unsaved correction'); await turn();
  assert.equal(f.dom.$('[data-planning-field="title"]'), input, 'First presence update must keep the input node.');
  const save = f.dom.$('#planning-save'), disclosure = f.dom.$('[data-planning-disclosure="awareness"]'); disclosure.open = true;
  f.dom.$('#planning-editor-panel').scrollTop = 128;
  f.workers[1].lastReadRevision = 5; f.workers[1].pendingRevision = null; f.workers[1].state = 'current';
  await f.workspace.handleEvent({ type: 'planning.awareness', data: { taskId: 'task-a' } }); await f.time.advance(350);
  assert.equal(f.dom.$('[data-planning-field="title"]'), input); assert.equal(document.activeElement, input); assert.equal(input.value, 'My unsaved correction'); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7); assert.equal(input.selectionDirection, 'backward');
  assert.equal(f.dom.$('#planning-save'), save); assert.equal(f.dom.$('#planning-editor-panel').scrollTop, 128); assert.equal(f.dom.$('[data-planning-disclosure="awareness"]').open, true);
  assert.equal(c.draft().revision, 5); assert.equal(c.draft().dirty, true); assert.equal(f.documents.get('task-a').steps.find(item => item.id === 'b').title, 'Step b');
  assert.match(f.dom.$('#planning-editor-awareness').textContent, /Read revision 5/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/plan/edit')).length, 0);
});

test('successful save releases its own lease and saved worker awareness remains separate from the draft receipt', async t => {
  const f = fixture(t, { withUI: true }); await f.enter(); const c = f.workspace.controller; c.selectEditor('b'); c.setPane('edit');
  await f.dom.input('[data-planning-field="title"]', 'Saved human correction'); await turn();
  assert.equal(f.presence.size, 1); assert.equal(await c.save(), true); await turn();
  assert.equal(f.presence.size, 0); assert.equal(c.awareness.state.editing, false); assert.equal(c.draft().revision, 6);
  assert.match(f.dom.$('#planning-editor-messages').textContent, /Saved revision 6/);
  assert.match(f.dom.$('#planning-editor-awareness').textContent, /Read revision 3/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/plan/edit')).length, 1);
});

test('discard, editor selection, compact pane navigation and leaving stop presence without discarding other drafts', async t => {
  const f = fixture(t, { withUI: true, width: 320 }); await f.enter(); const c = f.workspace.controller;
  c.selectEditor('a'); c.setPane('edit'); await f.dom.input('[data-planning-field="title"]', 'Draft A'); await turn(); assert.equal(f.presence.size, 1);
  c.selectEditor('b'); await turn(); assert.equal(f.presence.size, 0); assert.equal(c.entry().drafts.get('a').values.title, 'Draft A');
  await f.dom.input('[data-planning-field="title"]', 'Draft B'); await turn(); c.discard(); await turn(); assert.equal(f.presence.size, 0);
  await f.dom.input('[data-planning-field="title"]', 'Keep B'); await turn(); c.setPane('plan'); await turn(); assert.equal(f.presence.size, 0); assert.equal(c.draft().values.title, 'Keep B');
  c.setPane('edit'); assert.equal(f.presence.size, 0, 'Showing an existing draft is not fresh editing activity.');
  await f.dom.input('[data-planning-field="title"]', 'Keep B longer'); await turn(); c.leave(); await turn(); assert.equal(f.presence.size, 0); assert.equal(c.draft().values.title, 'Keep B longer');
});

test('a save that finishes after another step starts editing never releases the newer lease', async t => {
  const f = fixture(t, { withUI: true }), pending = deferred(); await f.enter(); const c = f.workspace.controller;
  c.selectEditor('a'); c.setPane('edit'); await f.dom.input('[data-planning-field="title"]', 'Save A later'); await turn();
  f.hook(async (url, method, body) => { if (!url.endsWith('/plan/edit')) return; await pending.promise; const value = f.documents.get('task-a'); value.revision++; value.steps.find(item => item.id === 'a').title = body.operations[0].patch.title; return structuredClone(value); });
  const saving = c.save(); await turn(); c.selectEditor('b'); await f.dom.input('[data-planning-field="title"]', 'Keep B while A saves'); await turn();
  const id = c.awareness.state.editorId; pending.resolve(); assert.equal(await saving, true); await turn();
  assert.equal(c.awareness.state.editorId, id); assert.equal(f.presence.has(id), true); assert.equal(c.draft().values.title, 'Keep B while A saves');
});

test('document hiding and page departure release presence, and showing a kept draft does not advertise editing', async t => {
  const f = fixture(t, { withUI: true }); await f.enter(); const c = f.workspace.controller; c.selectEditor('a'); c.setPane('edit');
  await f.dom.input('[data-planning-field="title"]', 'Keep this text while hidden'); await turn(); assert.equal(f.presence.size, 1);
  await f.dom.visibility('hidden'); await turn(); assert.equal(f.presence.size, 0);
  await f.dom.visibility('visible'); await turn(); assert.equal(f.presence.size, 0); assert.equal(c.draft().values.title, 'Keep this text while hidden');
  await f.dom.input('[data-planning-field="title"]', 'Resume deliberate editing'); await turn(); assert.equal(f.presence.size, 1);
  await f.dom.page('pagehide'); await turn(); assert.equal(f.presence.size, 0);
  await f.dom.page('pageshow'); await turn(); assert.equal(f.presence.size, 0); assert.equal(c.draft().values.title, 'Resume deliberate editing');
});

test('a burst of worker receipt events coalesces into one awareness read without reloading task fields', async t => {
  const f = fixture(t, { withUI: true }); await f.enter();
  f.workspace.controller.setPane('edit');
  const before = f.calls.length, field = f.dom.$('[data-planning-field="goal"]'); field.focus();
  for (let index = 0; index < 48; index++) f.workspace.handleEvent({ type: 'planning.awareness', data: { taskId: 'task-a' } });
  await f.time.advance(350);
  assert.deepEqual(f.calls.slice(before).map(call => call.url), ['/api/tasks/task-a/plan/awareness']);
  assert.equal(f.dom.$('[data-planning-field="goal"]'), field); assert.equal(document.activeElement, field);
});

test('a rejected saved edit keeps its local draft and makes no automatic plan retry', async t => {
  const f = fixture(t, { withUI: true }); await f.enter(); const c = f.workspace.controller; c.selectEditor('a'); c.setPane('edit');
  await f.dom.input('[data-planning-field="title"]', 'Keep rejected draft'); await turn();
  f.hook((url, method) => { if (url.endsWith('/plan/edit')) throw Object.assign(new Error('Another editor saved a newer revision.'), { status: 409 }); });
  assert.equal(await c.save(), false); await turn();
  assert.equal(c.draft().values.title, 'Keep rejected draft'); assert.equal(c.draft().conflict, true); assert.equal(f.dom.$('#planning-save').disabled, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/plan/edit')).length, 1);
  assert.equal(c.awareness.state.editing, true, 'The failed save has not published or discarded the draft.');
  c.discard(); await turn(); assert.equal(f.presence.size, 0);
});

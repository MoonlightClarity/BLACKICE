import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const recovery = await readFile(new URL('../public/gui-resilience.js', import.meta.url), 'utf8');
function recoveryFixture() {
  const listeners = new Map(), timers = new Map(); let reloads = 0;
  const elements = Object.fromEntries(['gui-recovery','gui-recovery-title','gui-recovery-detail','gui-reload','gui-dismiss'].map(id => [id, { hidden: false, textContent: '', addEventListener(name, handler) { this[name] = handler; } }]));
  const window = { addEventListener(name, handler) { listeners.set(name, handler); } };
  const context = vm.createContext({ document: { getElementById: id => elements[id] }, window, location: { reload() { reloads++; } }, setTimeout(fn) { timers.set(1, fn); return 1; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(recovery, context);
  return { ui: context.blackiceUIResilience, elements, listeners, timers, window, reloads: () => reloads };
}
test('a failed import or missing startup script leaves a usable recovery notice without replay', () => {
  for (const failure of ['unhandledrejection', 'error']) {
    const f = recoveryFixture();
    f.listeners.get(failure)({ target: { tagName: 'SCRIPT' }, reason: new Error('private task detail') });
    assert.equal(f.elements['gui-recovery'].hidden, false);
    assert.match(f.elements['gui-recovery-title'].textContent, /could not open/);
    assert.doesNotMatch(f.elements['gui-recovery-detail'].textContent, /private task/);
    assert.equal(f.elements['gui-reload'].hidden, false);
    assert.equal(f.elements['gui-dismiss'].hidden, true);
    assert.equal(f.reloads(), 0);
    f.elements['gui-reload'].click(); assert.equal(f.reloads(), 1);
  }
});
test('runtime errors preserve the current interface and can be dismissed; images do not fail boot', () => {
  const f = recoveryFixture(); f.ui.ready();
  assert.equal(f.timers.size, 0); assert.equal(f.elements['gui-recovery'].hidden, true);
  f.listeners.get('error')({ target: { tagName: 'IMG' } }); assert.equal(f.elements['gui-recovery'].hidden, true);
  f.listeners.get('error')({ target: f.window });
  assert.match(f.elements['gui-recovery-title'].textContent, /could not update/);
  assert.equal(f.elements['gui-dismiss'].hidden, false); assert.equal(f.reloads(), 0);
  f.elements['gui-dismiss'].click(); f.ui.report(); assert.equal(f.elements['gui-recovery'].hidden, true);
});
test('a stalled startup offers manual recovery without automatically reloading', () => {
  const f = recoveryFixture(); f.timers.get(1)();
  assert.equal(f.elements['gui-reload'].hidden, false); assert.equal(f.reloads(), 0);
});

function eventFixture() {
  const frames = [], reports = [], calls = [];
  const old = { id: 'run-1', status: 'running' }, state = { screen: 'mission', currentRun: old, runs: [old], workflows: [], workflow: { id: 'workflow-1' }, status: {}, desktop: {} };
  const context = vm.createContext({ state, runEventGenerations: new Map(), requestAnimationFrame: fn => frames.push(fn),
    blackiceUIResilience: { report: error => reports.push(error) },
    missionUI: { update() { calls.push('mission'); throw Error('broken mission'); } },
    observeUI: { handleEvent() { calls.push('observe-event'); throw Error('broken observe'); }, update() { calls.push('observe-update'); } },
    planningUI: { handleEvent() { calls.push('planning-event'); } },
    ...Object.fromEntries(['renderHeader','renderGraph','renderExecution','renderInspector','renderStreamState','renderDesktop'].map(name => [name, () => { calls.push(name); throw Error('broken render'); }])),
    toast() {}, errorText: value => value, scheduleRunRefresh() {},
  });
  const chunk = source.slice(source.indexOf('  // Widget failures'), source.indexOf('  function renderStreamState()'));
  vm.runInContext(chunk + '\nglobalThis.eventApi={handleEvent,scheduleLiveViews};', context);
  return { ...context.eventApi, frames, reports, calls, state, context };
}
test('a throwing widget cannot block the saved run update or another event consumer', () => {
  const f = eventFixture(), updated = { id: 'run-1', status: 'running', nodes: { agent: { output: 'still updating' } } };
  assert.doesNotThrow(() => f.handleEvent({ data: JSON.stringify({ type: 'run.updated', runId: updated.id, data: updated }) }));
  assert.equal(f.state.currentRun.nodes.agent.output, 'still updating');
  assert.equal(f.state.runs[0].nodes.agent.output, 'still updating');
  assert.ok(f.calls.includes('planning-event'));
  f.frames.shift()(); assert.ok(f.reports.length >= 2);
  assert.ok(f.calls.includes('mission')); assert.ok(!f.calls.includes('observe-update'));
  f.state.screen = 'observe'; f.scheduleLiveViews(); f.frames.shift()();
  assert.ok(f.calls.includes('observe-update'));
});
test('bursts coalesce chat redraws and a failed redraw does not prevent the next update', () => {
  const f = eventFixture();
  for (let index = 0; index < 50; index++) f.handleEvent({ data: JSON.stringify({ type: 'runtime.status', data: { sequence: index } }) });
  assert.equal(f.frames.length, 1); assert.equal(f.state.status.sequence, 49);
  f.frames.shift()(); assert.equal(f.calls.filter(value => value === 'mission').length, 1);
  assert.equal(f.calls.filter(value => value === 'observe-update').length, 0, 'hidden workspace does no DOM work');
  f.scheduleLiveViews(); assert.equal(f.frames.length, 1); assert.doesNotThrow(() => f.frames.shift()());
});
test('malformed live events are ignored before reaching consumers', () => {
  const f = eventFixture();
  for (const value of ['{', 'null', '[]', '42', '{}', '{"type":"run.updated","runId":{}}']) assert.doesNotThrow(() => f.handleEvent({ data: value }));
  assert.equal(f.frames.length, 0); assert.equal(f.calls.length, 0);
  assert.doesNotThrow(() => f.handleEvent({ data: '{"type":"workflows.updated","data":null}' }));
});

test('import save failure retains the dialog and reports the original error', async () => {
  let listener, closed = false;
  const target = { textContent: '' }, input = { value: JSON.stringify({ name: 'Import', nodes: [{ id: 'agent', type: 'agent' }], edges: [] }) };
  const form = { id: 'import-form', isConnected: true };
  const context = vm.createContext({ document: { addEventListener(_name, fn) { listener = fn; } }, $: selector => selector === '#import-json' ? input : selector === '#import-form' ? form : target,
    state: { status: {} }, uid: () => 'new-id', loadWorkflow: async () => { throw Error('Save your Studio changes first.'); }, closeModal: () => { closed = true; }, toast() {}, markDirty() {},
  });
  const start = source.indexOf("    document.addEventListener('submit',async event=>{"), end = source.indexOf("    $('#canvas').addEventListener('pointerdown'", start);
  vm.runInContext(source.slice(start, end), context);
  await listener({ target: form, preventDefault() {} });
  assert.equal(closed, false); assert.match(target.textContent, /Save your Studio changes first/);
});
test('an import abandoned during autosave cannot replace the workflow or close a newer dialog', async () => {
  let release, owned = true, rendered = 0;
  const original = { id: 'original' }, state = { dirty: true, workflow: original, saveError: false };
  const context = vm.createContext({ state, captureViewOwnership: () => 1, beginViewOperation: () => 1, ownsView: () => true,
    saveWorkflow: () => new Promise(done => { release = done; }), normalizeWorkflow: value => value,
    renderAll: () => { rendered++; }, editHistory: { reset() {} }, requestAnimationFrame() {}, localStorage: { setItem() {} }, ensureWorkflowView() {},
  });
  const start = source.indexOf('  async function loadWorkflow('), end = source.indexOf('\n', start);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.load=loadWorkflow;', context);
  const pending = context.load({ id: 'imported', nodes: [] }, { isCurrent: () => owned });
  owned = false; release(); assert.equal(await pending, false);
  assert.equal(state.workflow, original); assert.equal(rendered, 0);
});
test('failed and stale asynchronous file reads do not crash or overwrite a newer dialog', async () => {
  let listener, resolve, message;
  const input = { value: 'new text', isConnected: true }, element = { id: 'import-file', dataset: {}, files: [{ text: () => new Promise(done => { resolve = done; }) }] };
  const context = vm.createContext({ document: { addEventListener(_name, fn) { listener = fn; } }, $: () => input, toast: value => { message = value; } });
  const start = source.indexOf("    document.addEventListener('change',async event=>{"), end = source.indexOf("    document.addEventListener('submit'", start);
  vm.runInContext(source.slice(start, end), context);
  const pending = listener({ target: element }); input.isConnected = false; resolve('old text'); await pending;
  assert.equal(input.value, 'new text');
  element.files = [{ text: async () => { throw Error('Unreadable file'); } }];
  await listener({ target: element }); assert.equal(message, 'Unreadable file');
});

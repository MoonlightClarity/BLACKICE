import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { reduceRunCollection } from '../public/run-state-model.mjs';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

function fixture({ screen = 'workflow', failExecution = false } = {}) {
  const frames = [], rendered = {}, errors = [];
  const run = { id: 'run-1', status: 'running', settled: false, events: [],
    workflowId: 'workflow-1', workflow: { nodes: [{ id: 'writer', type: 'agent' }], edges: [] },
    nodes: { writer: { status: 'running', output: '' } } };
  const state = { screen, runs: [run], currentRun: run, status: {}, workflow: { id: 'workflow-1' },
    desktopActions: [], desktop: {}, inspectorTab: 'activity' };
  const count = name => () => { rendered[name] = (rendered[name] || 0) + 1; };
  const context = vm.createContext({ state, rendered, requestAnimationFrame: callback => frames.push(callback),
    reduceRunCollection, runEventGenerations: new Map(),
    missionUI: { update: count('mission') }, observeUI: { update: count('observe'), handleEvent() {} },
    planningUI: { handleEvent() {} }, configureUI: { update() {} },
    renderHeader: count('header'), renderDesktop: count('desktop'), renderGraph: count('graph'),
    renderExecution: () => { count('execution')(); if (failExecution) throw new Error('failed panel'); },
    renderInspector: count('inspector'), renderStreamState: count('stream'),
    scheduleRunRefresh() {}, rememberTask() {}, toast() {}, errorText: value => String(value),
    enterWorkspace: value => { state.screen = value; }, ensureWorkflowView() {},
    protectUI: callback => { try { callback(); } catch (error) { errors.push(error); } },
  });
  const start = source.indexOf('  let liveViewFrame = false;');
  const end = source.indexOf('  function renderStreamState()', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const show = source.match(/  function showWorkflow\(\)\{[^\n]+/)[0];
  vm.runInContext(show, context);
  return { state, rendered, errors, context, frames,
    emit: payload => context.handleEvent({ data: JSON.stringify(payload) }),
    flush: () => { const queued = frames.splice(0); for (const callback of queued) callback(); },
  };
}

const delta = index => ({ type: 'agent.event', runId: 'run-1', nodeId: 'writer',
  data: { type: 'delta', delta: String(index % 10) }, at: `2026-10-21T12:00:${String(index % 60).padStart(2, '0')}.000Z` });

test('a burst retains every receipt while rendering the workflow once per frame', () => {
  const f = fixture();
  for (let index = 0; index < 1000; index++) f.emit(delta(index));
  assert.equal(f.state.currentRun.nodes.writer.output, '0123456789'.repeat(100));
  assert.equal(f.state.currentRun.events.length, 1000);
  assert.equal(f.frames.length, 1);
  assert.equal(f.rendered.execution, undefined);
  f.flush();
  assert.equal(f.rendered.execution, 1);
  assert.equal(f.rendered.inspector, 1);
  assert.equal(f.rendered.mission, undefined);
  assert.equal(f.rendered.observe, undefined);
  f.emit(delta(0)); f.flush();
  assert.equal(f.rendered.execution, 2);
});

test('hidden workflow panels do no event rendering and reopen with current state', () => {
  const f = fixture({ screen: 'mission' });
  for (let index = 0; index < 250; index++) f.emit(delta(index));
  f.flush();
  assert.equal(f.rendered.execution, undefined);
  assert.equal(f.rendered.inspector, undefined);
  assert.equal(f.rendered.graph, undefined);
  assert.equal(f.rendered.mission, 1);
  assert.equal(f.state.currentRun.nodes.writer.output.length, 250);
  f.context.showWorkflow();
  assert.equal(f.state.screen, 'workflow');
  assert.equal(f.rendered.execution, 1);
  assert.equal(f.rendered.inspector, 1);
  assert.equal(f.rendered.graph, 1);
});

test('visibility is checked when rendering rather than when the receipt arrived', () => {
  const f = fixture({ screen: 'mission' });
  f.emit(delta(0));
  f.state.screen = 'observe';
  f.flush();
  assert.equal(f.rendered.mission, undefined);
  assert.equal(f.rendered.observe, 1);
  assert.equal(f.rendered.execution, undefined);
});

test('a failed panel does not discard state or prevent other panels from rendering', () => {
  const f = fixture({ failExecution: true });
  f.emit(delta(7)); f.flush();
  assert.equal(f.state.currentRun.nodes.writer.output, '7');
  assert.equal(f.errors.length, 1);
  assert.equal(f.rendered.inspector, 1);
  f.emit(delta(8)); f.flush();
  assert.equal(f.state.currentRun.nodes.writer.output, '78');
  assert.equal(f.rendered.execution, 2);
});

test('terminal receipts settle synchronously before the deferred frame', () => {
  const f = fixture();
  f.emit(delta(0));
  f.emit({ type: 'run.updated', runId: 'run-1', data: { ...f.state.currentRun, status: 'completed', settled: true } });
  assert.equal(f.state.currentRun.status, 'completed');
  assert.equal(f.state.currentRun.settled, true);
  assert.equal(f.state.currentRun.nodes.writer.output, '0');
  assert.equal(f.rendered.execution, undefined);
  f.flush();
  assert.equal(f.rendered.execution, 1);
  assert.equal(f.rendered.header, 1);
});

test('invalid stream messages do not schedule work', () => {
  const f = fixture();
  f.context.handleEvent({ data: '{' });
  f.emit(null); f.emit({ type: 'agent.event', runId: 42 });
  assert.equal(f.frames.length, 0);
  assert.equal(f.state.currentRun.events.length, 0);
});

test('a collapsed execution panel preserves its rendered view until expansion', () => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { dataset: {}, classList: { toggle() {} },
      setAttribute() {}, innerHTML: '', scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    return elements.get(selector);
  };
  const body = element('#execution-body');
  body.dataset.viewKey = 'previous-run:trace'; body.innerHTML = 'previous trace'; body.scrollTop = 250;
  const state = { panelCollapsed: true, executionTab: 'trace',
    currentRun: { id: 'next-run', status: 'running', nodes: {} }, workflow: { nodes: [] } };
  const context = vm.createContext({ state, $: element, $$: () => [], scheduleLiveViews() {},
    busy: () => true, icon: () => '', escape: String, duration: () => '',
    runMetrics: () => ({ completed: 0, total: 0, durationMs: 0 }),
    continuationAgents: () => [], traceRows: () => [] });
  const start = source.indexOf('  function renderExecution(){');
  const end = source.indexOf('  function runOutput(', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  context.renderExecution();
  assert.equal(body.dataset.viewKey, 'previous-run:trace');
  assert.equal(body.innerHTML, 'previous trace');
  assert.equal(body.scrollTop, 250);
  state.panelCollapsed = false;
  context.renderExecution();
  assert.equal(body.dataset.viewKey, 'next-run:trace');
  assert.match(body.innerHTML, /Waiting for this step/);
  assert.equal(body.scrollTop, body.scrollHeight);
});

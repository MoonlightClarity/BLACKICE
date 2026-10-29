import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPlanView, visiblePlanNodes } from '../public/task-plan-model.mjs';
import { initTaskPlanUI, renderPlanInspector } from '../public/task-plan-ui.mjs';
import { taskPlanMap, renderTaskPlanMapSVG } from '../public/task-plan-map.mjs';
import { renderTaskState } from '../public/task-state-ui.mjs';
import { createPlanningWorkspace } from '../public/next/workspaces/planning.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';
import { outlineTree, outlineNumbers, reorderedOutlineTree, reorderedOutlineNumbers } from './fixtures/planning-outline-tree.mjs';

const numbers = nodes => Object.fromEntries(nodes.map(node => [node.id, node.number]));
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('saved hierarchy determines every group and leaf number before any disclosure or branch focus', () => {
  const state = outlineTree(), before = structuredClone(state), view = taskPlanView(state);
  assert.deepEqual(numbers(view.nodes), outlineNumbers);
  assert.equal(view.byId.get('format').depth, 3);
  assert.equal(view.byId.get('fresh').branch, 'not-selected');
  const visible = visiblePlanNodes(view, new Set(['inspect']));
  assert.ok(!visible.some(node => node.id === 'format'));
  assert.equal(numbers(visible).route, '1.3', 'hiding preceding descendants never renumbers a sibling');
  assert.deepEqual(numbers(taskPlanMap(view, { focusId: 'inspect' }).nodes), { inspect: '1.2', format: '1.2.1', limits: '1.2.2' });
  assert.equal(numbers(taskPlanMap(view, { collapsed: new Set(['prepare']) }).nodes).verify, '3');
  assert.deepEqual(state, before, 'presentation cannot write invented parent relationships');
});

test('saved sibling reordering updates all affected descendants while unrelated branch labels remain intact', () => {
  const view = taskPlanView(reorderedOutlineTree());
  assert.deepEqual(numbers(view.nodes), reorderedOutlineNumbers);
  assert.equal(taskPlanMap(view, { focusId: 'inspect' }).byId.get('format').number, '1.1.1');
  assert.match(renderPlanInspector(view, { selectedId: 'format' }), /Step 1\.1\.1/);
  assert.match(renderTaskPlanMapSVG(view, { mapFocusId: 'inspect' }), /aria-label="Step 1\.1\.1\. Check the format/);
});

test('the milestone fallback retains structural parents, unused alternatives and nested list semantics', t => {
  const dom = planningDOM(t), state = outlineTree(), before = structuredClone(state);
  dom.mount.innerHTML = renderTaskState(state, { expanded: true, runStatus: 'running' });
  const rows = dom.mount.querySelectorAll('.task-plan-step');
  assert.equal(rows.length, state.steps.length, 'a leaf progress count must not erase group or alternative rows');
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.dataset.taskStep, row.querySelector('.task-step-number').textContent])), outlineNumbers);
  const leaf = dom.$('[data-task-step="format"]');
  assert.equal(leaf.parentElement.tagName, 'OL');
  assert.equal(leaf.parentElement.closest('[data-task-step]').dataset.taskStep, 'inspect');
  assert.equal(leaf.parentElement.closest('[data-task-step]').parentElement.closest('[data-task-step]').dataset.taskStep, 'prepare');
  assert.equal(leaf.getAttribute('aria-label'), 'Step 1.2.1: Check the format');
  assert.equal(dom.$('[data-task-step="fresh"]').querySelector('.task-step-label').textContent, 'Not chosen');
  assert.match(dom.$('.task-plan').textContent, /1 of 6 done/, 'structural and unselected rows never inflate action progress');
  assert.deepEqual(state, before);
  dom.mount.innerHTML = renderTaskState(reorderedOutlineTree(), { expanded: true });
  assert.deepEqual(Object.fromEntries(dom.mount.querySelectorAll('[data-task-step]').map(row => [row.dataset.taskStep, row.querySelector('.task-step-number').textContent])), reorderedOutlineNumbers);
  const skipped = structuredClone(state); skipped.steps.find(step => step.id === 'fresh').status = 'skipped';
  dom.mount.innerHTML = renderTaskState(skipped, { expanded: true });
  assert.equal(dom.$('[data-task-step="fresh"]').querySelector('.task-step-label').textContent, 'Skipped');
  assert.equal(dom.$('[data-task-step="fresh"]').querySelector('.task-step-number').textContent, '1.3.2');
  assert.match(dom.$('.task-plan').textContent, /1 of 6 done/);
});

test('a genuinely flat saved plan remains a flat sequence in the fallback and model', t => {
  const dom = planningDOM(t), state = outlineTree();
  state.steps = [{ id: 'read', title: 'Read', status: 'done' }, { id: 'write', title: 'Write', status: 'pending', dependsOn: ['read'] }];
  assert.deepEqual(numbers(taskPlanView(state).nodes), { read: '1', write: '2' });
  dom.mount.innerHTML = renderTaskState(state);
  assert.deepEqual(dom.mount.querySelectorAll('.task-step-number').map(node => node.textContent), ['1', '2']);
  assert.equal(dom.mount.querySelectorAll('.task-milestone-children').length, 0, 'dependencies must not masquerade as parent-child nesting');
});

test('unselected root alternatives stay visible even before any executable path enters the progress count', t => {
  const dom = planningDOM(t), state = outlineTree();
  state.plan = { layout: 'choice' };
  state.steps = [{ id: 'local', title: 'Use the local source', status: 'pending' }, { id: 'remote', title: 'Read the remote source', status: 'pending' }];
  assert.equal(taskPlanView(state).progress.total, 0);
  dom.mount.innerHTML = renderTaskState(state, { expanded: true });
  assert.deepEqual(dom.mount.querySelectorAll('.task-step-number').map(node => node.textContent), ['1', '2']);
  assert.deepEqual(dom.mount.querySelectorAll('.task-step-label').map(node => node.textContent), ['Option', 'Option']);
  assert.match(dom.mount.textContent, /2 saved steps/);
  assert.doesNotMatch(dom.mount.textContent, /0 of 0 done/);
});

test('the main outline retains hierarchical numbers and accessible depth through collapse and live sibling moves', async t => {
  let ui; t.after(() => ui?.destroy());
  const dom = planningDOM(t); ui = initTaskPlanUI({ mount: dom.mount });
  const update = state => ui.update({ taskState: state, runStatus: 'running', runId: 'outline-run' });
  const row = id => dom.$('[data-plan-node="' + id + '"]');
  update(outlineTree());
  assert.equal(row('format').getAttribute('aria-level'), '3');
  assert.equal(row('format').querySelector('.task-plan-step-number').textContent, '1.2.1');
  ui.selectStep('inspect'); await dom.key(row('inspect'), 'ArrowLeft');
  assert.equal(row('inspect').getAttribute('aria-expanded'), 'false');
  assert.equal(row('route').querySelector('.task-plan-step-number').textContent, '1.3');
  assert.ok(!ui.getSelection().visibleIds.includes('format'));
  update(reorderedOutlineTree());
  assert.equal(row('format').querySelector('.task-plan-step-number').textContent, '1.1.1');
  assert.equal(row('verify').querySelector('.task-plan-step-number').textContent, '2');
  assert.equal(row('inspect').getAttribute('aria-expanded'), 'false', 'live reorder preserves disclosure');
});

test('the current Planning outline, inspector and focused map agree on hierarchy before and after collapse', async t => {
  const dom = planningDOM(t), state = outlineTree(), calls = [];
  const prototype = Object.getPrototypeOf(dom.mount);
  Object.defineProperty(prototype, 'type', { get() { return this.getAttribute('type') || this.tagName.toLowerCase(); }, set(value) { this.setAttribute('type', value); }, configurable: true });
  prototype.replaceChildren = function (...nodes) { for (const child of [...this.children]) child.remove(); this.rawText = ''; this.append(...nodes); };
  const matches = prototype.matches; prototype.matches = function (selector) { return matches.call(this, selector.replace(/\[([^=\]]+)=([^\]"']+)\]/g, '[$1="$2"]')); };
  const api = async (route, method = 'GET') => {
    calls.push({ route, method });
    if (route.startsWith('/api/planning?')) return { plans: [{ taskId: state.taskId, revision: state.revision, goal: state.goal, bucket: 'active', editable: true, status: 'running' }], nextOffset: null };
    if (route === '/api/tasks/outline-tree') return structuredClone(state);
    throw Error('Unexpected ' + method + ' ' + route);
  };
  const ui = createPlanningWorkspace({ mount: dom.mount, api, events: { subscribe: () => () => {} } }); t.after(() => ui.destroy());
  dom.$('#next-planning-type').value = 'conversation'; ui.enter(); await settle();
  await dom.click('#next-plan-outline-view');
  const row = id => dom.$('[data-plan-outline-step="' + id + '"]');
  const outlineLabels = () => Object.fromEntries(dom.mount.querySelectorAll('[data-plan-outline-step]').map(row => [row.dataset.planOutlineStep, row.querySelector('.next-plan-outline-number').textContent]));
  assert.deepEqual(outlineLabels(), outlineNumbers);
  assert.equal(row('format').getAttribute('aria-level'), '3');
  assert.equal(row('format').getAttribute('aria-posinset'), '1');
  assert.equal(row('format').getAttribute('aria-setsize'), '2');
  assert.equal(row('format').style['--next-plan-depth'], '2');
  assert.match(row('format').getAttribute('aria-label'), /^Step 1\.2\.1\. Check the format/);
  await dom.click(row('format'));
  assert.match(dom.$('#next-planning-inspector').textContent, /Step 1\.2\.1/);
  await dom.click(row('inspect')); await dom.key(row('inspect'), 'ArrowLeft');
  assert.equal(row('format'), null);
  assert.equal(outlineLabels().route, '1.3');
  assert.equal(row('route').getAttribute('aria-posinset'), '3', 'visibility never rewrites sibling position');
  await dom.key(row('inspect'), 'ArrowRight');
  assert.deepEqual(outlineLabels(), outlineNumbers);
  await dom.click('#next-plan-map-view'); await dom.click('#next-plan-focus');
  assert.equal(dom.$('[data-plan-map-node="format"]').querySelector('.task-plan-map-number').textContent, '1.2.1');
  assert.ok(calls.every(call => call.method === 'GET'), 'outline interaction must remain read-only');
});

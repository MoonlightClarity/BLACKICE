import test from 'node:test';
import assert from 'node:assert/strict';
import { initTaskPlanUI } from '../public/task-plan-ui.mjs';

// Small DOM fixture for identity, focus, event, and ownership behavior. Browser
// acceptance separately checks layout and actual rendering.
function planDOM(t, { width = 1440 } = {}) {
  const old = new Map(['document', 'window'].map(key => [key, { present: Object.hasOwn(globalThis, key), value: globalThis[key] }]));
  let selectedText = false;
  const camel = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set(); this.scrollTop = 0; this.scrollLeft = 0; this.hidden = false; this.open = false; this.markup = ''; this.rawText = '';
      this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: name => this.classes.has(name), toggle: (name, value) => { const next = value ?? !this.classes.has(name); next ? this.classes.add(name) : this.classes.delete(name); return next; } };
    }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    set id(value) { this.attributes.set('id', String(value)); }
    get id() { return this.attributes.get('id') || ''; }
    get isConnected() { return this.root === true || this.parentElement?.isConnected === true; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = String(value); if (key === 'class') this.className = value; if (key === 'hidden') this.hidden = true; if (key === 'open') this.open = true; }
    getAttribute(key) { return key === 'class' ? this.className : key.startsWith('data-') ? this.dataset[camel(key.slice(5))] ?? null : this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.getAttribute(key) !== null; }
    get disabled() { return this.attributes.has('disabled'); }
    removeAttribute(key) { this.attributes.delete(key); if (key.startsWith('data-')) delete this.dataset[camel(key.slice(5))]; }
    append(...items) { for (const item of items) { item.remove(); this.children.push(item); item.parentElement = this; } }
    insertBefore(item, reference) { item.remove(); const index = reference ? this.children.indexOf(reference) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, item); item.parentElement = this; }
    remove() { if (!this.parentElement) return; const index = this.parentElement.children.indexOf(this); if (index >= 0) this.parentElement.children.splice(index, 1); this.parentElement = null; }
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
    matches(selector) {
      const attribute = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/), bare = selector.replace(/\[[^\]]*\]/g, '');
      if (bare.startsWith('.') && !this.classList.contains(bare.slice(1)) || bare.startsWith('#') && this.id !== bare.slice(1) || bare && !['.', '#'].includes(bare[0]) && this.tagName !== bare.toUpperCase()) return false;
      return !attribute || this.getAttribute(attribute[1]) !== null && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
    }
    querySelectorAll(selector) { const result = []; const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child); } }; visit(this); return result; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    set innerHTML(markup) {
      for (const child of this.children) child.parentElement = null; this.children = []; this.markup = markup; this.rawText = '';
      const stack = [this], tokens = /<!--[^]*?-->|<\/?([A-Za-z][\w:-]*)([^>]*?)\/?\s*>/g;
      for (const match of markup.matchAll(tokens)) {
        if (!match[1]) continue;
        if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const child = new Element(match[1]);
        for (const [, key, double, single, unquoted] of match[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'">]+)))?/g)) child.setAttribute(key, double ?? single ?? unquoted ?? '');
        stack.at(-1).append(child);
        if (!match[0].endsWith('/>') && !['LINK', 'IMG', 'INPUT', 'BR', 'HR', 'META'].includes(child.tagName)) stack.push(child);
      }
    }
    get innerHTML() { return this.markup; }
    set textContent(value) { this.rawText = String(value); }
    get textContent() { return this.rawText || this.markup.replace(/<[^>]*>/g, ''); }
    focus(options) { if (this.disabled || !this.isConnected) return; this.focusOptions = options; document.activeElement = this; }
    getBoundingClientRect() { return this.bounds || { top: 0, bottom: 50, left: 0, right: 450, height: 50, width: 450 }; }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    async dispatch(type, value = {}) { const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...value }; for (const handler of this.listeners.get(type) || []) await handler(event); return event; }
  }
  const body = new Element('body'), head = new Element('head'), events = new Element('document'), mount = new Element('aside'); body.root = true; head.root = true; body.append(mount);
  const document = { body, head, activeElement: null, createElement: tag => new Element(tag), getElementById: id => head.querySelector(`#${id}`) || body.querySelector(`#${id}`), addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args) };
  const media = new Element('media'); media.matches = width <= 600;
  globalThis.document = document; globalThis.window = { matchMedia: () => media, getSelection: () => selectedText ? { isCollapsed: false, containsNode: node => node === mount } : null };
  t.after(() => { for (const [key, before] of old) if (before.present) globalThis[key] = before.value; else delete globalThis[key]; });
  const region = name => mount.querySelector(`[data-plan-region="${name}"]`), node = id => mount.querySelectorAll('[data-plan-node]').find(item => item.dataset.planNode === id);
  return { mount, region, node, media, async resize(width) { media.matches = width <= 600; await media.dispatch('change', { matches: media.matches }); }, async toggleGoal(open) { const goal = mount.querySelector('[data-plan-disclosure="goal"]'); goal.open = open; await mount.dispatch('toggle', { target: goal }); return goal; }, element: tag => new Element(tag), document, events, viewport: () => mount.querySelector('.task-plan-tree-viewport'), inspector: () => region('inspector'), control(action, stepId = '') { return mount.querySelectorAll('[data-plan-action]').find(item => item.dataset.planAction === action && (item.dataset.stepId || '') === stepId); }, async click(target, value = {}) { return mount.dispatch('click', { target, ...value }); }, async key(target, key) { return mount.dispatch('keydown', { target, key }); }, async selectText(value) { selectedText = value; return events.dispatch('selectionchange'); } };
}

function plan(id = 'task-a') {
  return { taskId: id, goal: 'Build and inspect the result.', revision: 3, planVersion: 1, plan: { origin: 'agent', layout: 'sequence', detail: 'balanced', method: { id: 'implement', revision: 2, name: 'Implement a change' } }, steps: [
    { id: 'prepare', title: 'Prepare the inputs', parentId: null, kind: 'sequence', status: 'active', dependsOn: [] },
    { id: 'read', title: 'Read the supplied file', parentId: 'prepare', kind: 'action', status: 'active', dependsOn: [], doneWhen: 'The exact inputs are recorded.' },
    { id: 'inspect', title: 'Inspect the constraints', parentId: 'prepare', kind: 'action', status: 'pending', dependsOn: ['read'], note: 'Keep the existing limits.' },
    { id: 'write', title: 'Write the result', parentId: null, kind: 'action', status: 'pending', dependsOn: ['prepare'] },
  ], artifacts: [] };
}
const update = (ui, state, extra = {}) => ui.update({ taskState: state, runId: `${state.taskId}-run`, runStatus: 'running', canGuide: true, ...extra });
const mappedNode = (f, id) => f.mount.querySelectorAll('[data-plan-map-node]').find(element => element.dataset.planMapNode === id);
const mapCanvas = f => f.mount.querySelector('.task-plan-map-canvas');

test('Enlarge and Escape restore the existing outline, selection, scroll and focused size control', async t => {
  const f = planDOM(t), changes = [], ui = initTaskPlanUI({ mount: f.mount, onEnlargedChange: value => changes.push(value) }), state = plan(), before = structuredClone(state); update(ui, state);
  await f.click(f.node('inspect')); f.viewport().scrollTop = 86;
  const node = f.node('inspect'), control = f.control('enlarge'), selection = ui.getSelection();
  assert.equal(control.getAttribute('aria-controls'), f.mount.id); assert.equal(control.getAttribute('aria-expanded'), 'false');
  await f.click(control);
  assert.equal(f.node('inspect'), node); assert.equal(f.control('enlarge'), control); assert.equal(document.activeElement, control);
  assert.equal(control.getAttribute('aria-expanded'), 'true'); assert.equal(control.getAttribute('aria-label'), 'Restore plan size'); assert.equal(f.mount.dataset.planEnlarged, 'true');
  assert.deepEqual(ui.getSelection(), { ...selection, enlarged: true }); assert.equal(f.viewport().scrollTop, 86);
  node.focus(); const event = await f.key(node, 'Escape');
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true); assert.equal(document.activeElement, control);
  assert.equal(f.node('inspect'), node); assert.equal(f.control('enlarge'), control); assert.equal(control.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(ui.getSelection(), selection); assert.deepEqual(changes, [true, false]); assert.deepEqual(state, before); ui.destroy();
});

test('enlarging preserves the same map and restores normal pan after a larger viewport clamps it', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state);
  await f.click(f.control('view-map')); await f.click(mappedNode(f, 'inspect')); await f.click(f.control('map-zoom-in'));
  const canvas = mapCanvas(f), node = mappedNode(f, 'inspect'), control = f.control('enlarge'); canvas.scrollTop = 88; canvas.scrollLeft = 156;
  await f.click(control); assert.equal(mapCanvas(f), canvas); assert.equal(mappedNode(f, 'inspect'), node); assert.equal(ui.getSelection().mapZoom, 1.2);
  canvas.scrollTop = 0; canvas.scrollLeft = 0; await f.mount.dispatch('scroll', { target: canvas });
  state.revision++; state.steps[2].evidence = 'Current saved evidence'; update(ui, state);
  assert.equal(f.control('enlarge'), control, 'live progress cannot replace the focused Restore control'); assert.equal(control.getAttribute('aria-expanded'), 'true');
  await f.click(control); assert.equal(mapCanvas(f).scrollTop, 88); assert.equal(mapCanvas(f).scrollLeft, 156);
  assert.equal(ui.getSelection().selectedId, 'inspect'); assert.equal(ui.getSelection().mapZoom, 1.2); ui.destroy();
});

test('compact details keep Restore reachable and nested Escape returns through details before restoring size', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount }); update(ui, plan());
  const control = f.control('enlarge'); await f.click(control); await f.key(f.node('read'), 'Enter');
  assert.equal(ui.getSelection().detailsExpanded, true); assert.equal(f.region('toolbar').hidden, true);
  assert.equal(control.closest('[hidden]'), null); assert.equal(control.closest('[inert]'), null); assert.equal(control.getAttribute('aria-expanded'), 'true');
  await f.key(f.control('details'), 'Escape'); assert.equal(ui.getSelection().detailsExpanded, false); assert.equal(ui.getSelection().enlarged, true);
  await f.key(f.node('read'), 'Escape'); assert.equal(ui.getSelection().enlarged, false); assert.equal(document.activeElement, control); ui.destroy();
});

test('Outline and Mind map inspect one saved tree and share selection and collapsed branches', async t => {
  const f = planDOM(t), calls = [], ui = initTaskPlanUI({ mount: f.mount, onDraftDirection: value => calls.push(value) }), state = plan(), before = structuredClone(state); update(ui, state);
  await f.click(f.node('inspect')); await f.click(f.control('view-map'));
  assert.equal(ui.getSelection().presentation, 'map'); assert.equal(ui.getSelection().selectedId, 'inspect'); assert.equal(f.mount.querySelector('.task-plan-tree').hidden, true); assert.equal(f.region('map').hidden, false);
  assert.equal(mappedNode(f, 'inspect').getAttribute('aria-pressed'), 'true'); assert.match(f.inspector().innerHTML, /Keep the existing limits/);
  await f.click(mappedNode(f, 'prepare')); await f.key(mappedNode(f, 'prepare'), ' '); assert.deepEqual(ui.getSelection().mapVisibleIds, ['prepare', 'write']);
  await f.click(f.control('view-outline')); assert.equal(f.node('prepare').getAttribute('aria-expanded'), 'false'); assert.equal(ui.getSelection().selectedId, 'prepare');
  assert.deepEqual(calls, []); assert.deepEqual(state, before); ui.destroy();
});

test('map branch and leaf focus remain inspectable with a path back to the whole plan', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state); await f.click(f.control('view-map'));
  await f.click(mappedNode(f, 'prepare')); await f.click(f.control('map-focus'));
  assert.equal(ui.getSelection().mapFocusId, 'prepare'); assert.deepEqual(ui.getSelection().mapVisibleIds, ['prepare', 'read', 'inspect']); assert.match(f.region('map').innerHTML, /aria-label="Map focus"/);
  await f.click(mappedNode(f, 'inspect')); await f.key(mappedNode(f, 'inspect'), 'f'); assert.deepEqual(ui.getSelection().mapVisibleIds, ['inspect']); assert.match(f.region('map').innerHTML, /dependency lies outside this view/);
  await f.click(f.control('select', 'read')); assert.equal(ui.getSelection().selectedId, 'read'); assert.equal(ui.getSelection().mapFocusId, null, 'following a dependency outside the focus reveals its actual context');
  await f.click(f.control('map-reset')); assert.deepEqual(ui.getSelection().mapVisibleIds, ['prepare', 'read', 'inspect', 'write']); ui.destroy();
});

test('map selection, focus, zoom and scroll survive evidence streaming without changing the saved tree', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state); await f.click(f.control('view-map')); await f.click(mappedNode(f, 'inspect')); await f.click(f.control('map-zoom-in'));
  mappedNode(f, 'inspect').focus(); mapCanvas(f).scrollTop = 88; mapCanvas(f).scrollLeft = 156; await f.mount.dispatch('scroll', { target: mapCanvas(f) });
  const old = mappedNode(f, 'inspect'); state.revision++; state.steps[2].evidence = 'The real constraints were checked.'; state.plan.focusStepId = 'write'; update(ui, state);
  assert.equal(ui.getSelection().selectedId, 'inspect'); assert.equal(ui.getSelection().mapZoom, 1.2); assert.equal(mapCanvas(f).scrollTop, 88); assert.equal(mapCanvas(f).scrollLeft, 156); assert.notEqual(mappedNode(f, 'inspect'), old); assert.equal(document.activeElement, mappedNode(f, 'inspect'));
  assert.match(f.inspector().innerHTML, /real constraints were checked/); ui.destroy();
});

test('the keyboard pan region keeps focus and both scroll positions when live step status replaces the map', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state);
  await f.click(f.control('view-map')); await f.click(mappedNode(f, 'read'));
  const canvas = mapCanvas(f); canvas.scrollTop = 88; canvas.scrollLeft = 156; canvas.focus();
  await f.mount.dispatch('scroll', { target: canvas });
  state.revision++; state.steps[1].status = 'done'; state.steps[1].evidence = 'The actual source was inspected.'; state.steps[2].status = 'active'; state.plan.focusStepId = 'inspect';
  update(ui, state);
  const replacement = mapCanvas(f);
  assert.notEqual(replacement, canvas, 'the case exercises a real map subtree replacement');
  assert.equal(canvas.isConnected, false); assert.equal(replacement.isConnected, true);
  assert.equal(document.activeElement, replacement); assert.deepEqual(replacement.focusOptions, { preventScroll: true });
  assert.equal(replacement.scrollTop, 88); assert.equal(replacement.scrollLeft, 156);
  assert.equal(ui.getSelection().selectedId, 'read', 'streaming does not change the inspected step');
  assert.equal((await f.key(replacement, 'ArrowDown')).defaultPrevented, false, 'native keyboard panning remains available');
  ui.destroy();
});

test('resizing a focused map pan region preserves keyboard ownership and pan instead of revealing a different node', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state); await f.click(f.control('view-map'));
  const selected = ui.getSelection().selectedId;
  mapCanvas(f).scrollTop = 74; mapCanvas(f).scrollLeft = 126; mapCanvas(f).focus();
  for (const width of [390, 1440]) {
    await f.resize(width);
    assert.equal(f.viewport().hidden, false); assert.equal(document.activeElement, mapCanvas(f));
    assert.equal(mapCanvas(f).scrollTop, 74); assert.equal(mapCanvas(f).scrollLeft, 126);
    assert.equal(ui.getSelection().selectedId, selected);
  }
  ui.setPresentation('outline');
  assert.equal(document.activeElement, f.node(selected), 'leaving the map restores focus to a visible outline step');
  assert.equal(f.region('map').hidden, true); ui.destroy();
});

for (const [action, bound] of [['map-zoom-in', 2.5], ['map-zoom-out', .35]]) test(`${action} keeps focus on enabled Fit width when the zoom limit disables its button`, async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(), before = structuredClone(state); update(ui, state); await f.click(f.control('view-map'));
  for (let attempts = 0; ui.getSelection().mapZoom !== bound && attempts < 12; attempts++) {
    const control = f.control(action); assert.equal(control.disabled, false); control.focus(); await f.click(control);
  }
  assert.equal(ui.getSelection().mapZoom, bound); assert.equal(f.control(action).disabled, true);
  assert.equal(document.activeElement, f.control('map-fit')); assert.equal(document.activeElement.disabled, false);
  assert.equal(document.activeElement.isConnected, true); assert.deepEqual(document.activeElement.focusOptions, { preventScroll: true });
  await f.click(document.activeElement);
  assert.ok(ui.getSelection().mapZoom >= .9 && ui.getSelection().mapZoom <= 1, 'the focused fallback still performs a useful reading action');
  assert.equal(document.activeElement, f.control('map-fit')); assert.deepEqual(state, before); ui.destroy();
});

test('Fit keeps a short or mobile map readable while preserving selection and the saved tree', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(), before = structuredClone(state); update(ui, state); await f.click(f.control('view-map'));
  await f.click(mappedNode(f, 'inspect'));
  mapCanvas(f).clientWidth = 520; mapCanvas(f).clientHeight = 110;
  await f.click(f.control('map-fit'));
  assert.equal(ui.getSelection().mapZoom, .9, 'a short inspector-constrained canvas must not make labels microscopic');
  assert.match(f.region('map').innerHTML, /90% · Fit width/);
  mapCanvas(f).clientWidth = 520; mapCanvas(f).clientHeight = 800;
  await f.click(f.control('map-fit')); assert.equal(ui.getSelection().mapZoom, .9, 'available height does not decide reading size');
  mapCanvas(f).clientWidth = 320; mapCanvas(f).clientHeight = 110;
  await f.click(f.control('map-fit')); assert.equal(ui.getSelection().mapZoom, .9, 'a narrow map uses internal scrolling at reading size');
  assert.equal(ui.getSelection().selectedId, 'inspect'); assert.deepEqual(ui.getSelection().mapVisibleIds, ['prepare', 'read', 'inspect', 'write']);
  await f.click(f.control('map-zoom-out')); assert.equal(ui.getSelection().mapZoom, .7, 'an explicit overview zoom is still available');
  assert.deepEqual(state, before); ui.destroy();
});

test('map keyboard navigation opens details on mobile and Escape restores the same selected step', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state); await f.key(f.control('view-outline'), 'ArrowRight');
  assert.equal(ui.getSelection().presentation, 'map'); assert.equal(document.activeElement, f.control('view-map'));
  await f.click(mappedNode(f, 'read')); await f.key(mappedNode(f, 'read'), 'ArrowDown'); assert.equal(ui.getSelection().selectedId, 'inspect');
  await f.key(mappedNode(f, 'inspect'), 'Enter'); assert.equal(ui.getSelection().detailsExpanded, true); assert.equal(f.viewport().hidden, true); assert.match(f.inspector().innerHTML, /Back to map/);
  await f.key(f.control('details'), 'Escape'); assert.equal(f.viewport().hidden, false); assert.equal(document.activeElement, mappedNode(f, 'inspect'));
  await f.key(mappedNode(f, 'inspect'), 'ArrowLeft'); assert.equal(ui.getSelection().selectedId, 'prepare');
  await f.key(mappedNode(f, 'prepare'), 'f'); assert.equal(ui.getSelection().mapFocusId, 'prepare'); await f.key(mappedNode(f, 'prepare'), 'Escape'); assert.equal(ui.getSelection().mapFocusId, null); ui.destroy();
});

test('map presentation and branch focus are retained per task without leaking into another chat', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), a = plan('map-a'), b = plan('map-b'); update(ui, a); ui.focusMap('prepare');
  mapCanvas(f).scrollTop = 46; mapCanvas(f).scrollLeft = 72; await f.mount.dispatch('scroll', { target: mapCanvas(f) });
  update(ui, b); assert.equal(ui.getSelection().presentation, 'outline'); assert.equal(ui.getSelection().mapFocusId, null); ui.focusMap('write');
  update(ui, a); assert.equal(ui.getSelection().presentation, 'map'); assert.equal(ui.getSelection().mapFocusId, 'prepare'); assert.equal(mapCanvas(f).scrollTop, 46); assert.equal(mapCanvas(f).scrollLeft, 72);
  a.steps = a.steps.filter(step => step.id !== 'prepare'); a.revision++; update(ui, a); assert.equal(ui.getSelection().mapFocusId, null); assert.equal(ui.getSelection().mapVisibleIds.includes('read'), true); ui.destroy();
});

test('SVG and Freeplane exports include all saved branches, while Guide uses only the selected original step', async t => {
  const f = planDOM(t), exports = [], guided = [], ui = initTaskPlanUI({ mount: f.mount, onExport: value => exports.push(value), onDraftDirection: value => guided.push(value) }), state = plan(), before = structuredClone(state); update(ui, state); ui.focusMap('read');
  await f.click(f.control('export-svg')); await f.click(f.control('export-mm')); assert.equal(exports.length, 2);
  assert.match(exports[0].text, /data-plan-map-node="write"/); assert.match(exports[1].text, /NAME="BLACKICE step ID" VALUE="write"/); assert.deepEqual(guided, []);
  await f.click(f.control('guide')); assert.equal(guided.length, 1); assert.equal(guided[0].step, state.steps[1]); assert.equal(guided[0].taskState, state); assert.deepEqual(state, before); ui.destroy();
});

test('runtime scaffold turns into the default branching outline with semantic hierarchy and no fabricated steps', t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount });
  update(ui, { taskId: 'task-a', goal: 'Build and inspect the result.', steps: [], plan: { origin: 'runtime' } });
  assert.deepEqual(ui.getSelection().visibleIds, []); assert.match(f.region('empty').innerHTML, /First, a clear approach/);
  update(ui, plan());
  assert.deepEqual(ui.getSelection().visibleIds, ['prepare', 'read', 'inspect', 'write']); assert.equal(ui.getSelection().selectedId, 'read');
  assert.equal(f.node('prepare').getAttribute('role'), 'treeitem'); assert.equal(f.node('prepare').getAttribute('aria-expanded'), 'true'); assert.equal(f.node('read').getAttribute('aria-level'), '2'); assert.equal(f.node('read').tabIndex, 0);
  assert.equal(f.region('empty').hidden, true); assert.equal(f.inspector().hidden, false); assert.match(f.inspector().innerHTML, /exact inputs are recorded/); ui.destroy();
});

test('SSE updates preserve keyed rows, the inspected step, keyboard focus, and independent scroll positions', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state);
  await f.click(f.node('inspect')); const selected = f.node('inspect'), read = f.node('read');
  f.viewport().scrollTop = 94; f.inspector().scrollTop = 37; selected.focus({ preventScroll: true });
  state.revision++; state.steps[1].status = 'done'; state.steps[1].evidence = 'The source bytes were read.'; state.steps[2].status = 'active'; state.plan.focusStepId = 'write';
  update(ui, state);
  assert.equal(f.node('inspect'), selected); assert.equal(f.node('read'), read); assert.equal(document.activeElement, selected); assert.equal(ui.getSelection().selectedId, 'inspect'); assert.equal(f.viewport().scrollTop, 94); assert.equal(f.inspector().scrollTop, 37);
  assert.equal(f.node('read').dataset.status, 'done'); ui.destroy();
});

test('detail controls keep focus while the selected step gains evidence', t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount, onDraftDirection() {} }), state = plan(); update(ui, state);
  const old = f.control('guide'); old.focus({ preventScroll: true }); state.revision++; state.steps[1].evidence = 'Checked the actual file.';
  update(ui, state); const next = f.control('guide');
  assert.notEqual(next, old); assert.equal(old.isConnected, false); assert.equal(document.activeElement, next); assert.deepEqual(next.focusOptions, { preventScroll: true }); ui.destroy();
});

test('text selection defers streaming DOM changes and flushes only the newest saved state when released', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state); const original = f.node('read');
  await f.selectText(true); const first = structuredClone(state); first.revision++; first.steps[1].status = 'done'; update(ui, first);
  const last = structuredClone(first); last.revision++; last.steps[2].status = 'active'; last.steps[2].evidence = 'The newest evidence.'; update(ui, last);
  assert.equal(original.dataset.status, 'active'); assert.equal(f.node('inspect').dataset.status, 'pending');
  await f.selectText(false); assert.equal(f.node('read'), original); assert.equal(original.dataset.status, 'done'); assert.equal(f.node('inspect').dataset.status, 'active'); ui.destroy();
});

test('keyboard navigation changes only inspection, with real collapsed ARIA and child visibility state', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(), before = structuredClone(state); update(ui, state);
  f.node('read').focus(); let event = await f.key(f.node('read'), 'ArrowLeft'); assert.equal(event.defaultPrevented, true); assert.equal(document.activeElement, f.node('prepare'));
  await f.key(f.node('prepare'), 'ArrowLeft'); assert.equal(f.node('prepare').getAttribute('aria-expanded'), 'false'); assert.equal(f.node('prepare').querySelector('[role="group"]').hidden, true);
  assert.deepEqual(ui.getSelection().visibleIds, ['prepare', 'write']);
  await f.key(f.node('prepare'), 'ArrowRight'); await f.key(f.node('prepare'), 'ArrowRight'); assert.equal(document.activeElement, f.node('read')); assert.equal(ui.getSelection().selectedId, 'read');
  await f.key(f.node('read'), 'End'); assert.equal(document.activeElement, f.node('write')); assert.deepEqual(state, before); ui.destroy();
});

test('expanding a different branch keeps focus on the branch clicked, rather than jumping to the current work', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state);
  await f.click(f.control('toggle', 'prepare')); assert.equal(ui.getSelection().selectedId, 'prepare'); assert.equal(document.activeElement, f.node('prepare')); assert.equal(f.node('prepare').getAttribute('aria-expanded'), 'false');
  await f.click(f.control('toggle', 'prepare')); assert.equal(f.node('prepare').getAttribute('aria-expanded'), 'true'); assert.equal(document.activeElement, f.node('prepare')); ui.destroy();
});

test('task switches restore their own collapsed branches, inspected step, and scroll position', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), a = plan('task-a'), b = plan('task-b'); update(ui, a);
  await f.click(f.control('toggle', 'prepare')); await f.click(f.node('write')); f.viewport().scrollTop = 71; await f.viewport().dispatch('scroll');
  update(ui, b); assert.equal(ui.getSelection().selectedId, 'read'); await f.click(f.node('inspect'));
  update(ui, a); assert.equal(ui.getSelection().selectedId, 'write'); assert.deepEqual(ui.getSelection().collapsed, ['prepare']); assert.equal(f.viewport().scrollTop, 71);
  update(ui, b); assert.equal(ui.getSelection().selectedId, 'inspect'); assert.deepEqual(ui.getSelection().collapsed, []); ui.destroy();
});

test('a removed focused row transfers focus to a real surviving row without replaying work', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state); await f.click(f.node('inspect')); const old = f.node('inspect');
  state.steps = state.steps.filter(step => step.id !== 'inspect'); state.revision++; update(ui, state);
  assert.equal(old.isConnected, false); assert.equal(ui.getSelection().selectedId, 'read'); assert.equal(document.activeElement, f.node('read')); ui.destroy();
});

test('guidance and Planning are explicit callbacks; inspecting steps never changes saved work', async t => {
  const f = planDOM(t), directions = [], opened = [], ui = initTaskPlanUI({ mount: f.mount, onDraftDirection: value => directions.push(value), onOpenPlanning: value => opened.push(value) }), state = plan(); update(ui, state);
  await f.click(f.node('inspect')); await f.click(f.control('toggle', 'prepare')); assert.deepEqual(directions, []); assert.deepEqual(opened, []);
  await f.click(f.node('write')); await f.click(f.control('guide'));
  assert.equal(directions.length, 1); assert.equal(directions[0].step, state.steps[3]); assert.equal(directions[0].taskState, state); assert.equal(directions[0].runId, 'task-a-run');
  state.revision++; update(ui, state); await f.click(f.control('planning')); assert.equal(opened.length, 1); assert.equal(opened[0].taskId, state.taskId); assert.equal(opened[0].taskState, state); assert.equal(opened[0].runId, 'task-a-run');
  assert.equal(f.control('save-method'), undefined); assert.equal(f.control('method'), undefined); assert.equal(f.control('methods'), undefined);
  update(ui, state, { canGuide: false }); assert.equal(f.control('guide'), undefined); assert.ok(f.control('planning')); ui.destroy();
});

test('registered step files use the existing preview callback; modified link clicks retain browser behavior', async t => {
  const f = planDOM(t), opened = [], ui = initTaskPlanUI({ mount: f.mount, onArtifact: value => opened.push(value) }), state = plan(); state.steps[1].artifactIds = ['result', 'missing']; state.artifacts = [{ id: 'result', title: 'Result PDF', fileName: 'result.pdf' }]; update(ui, state);
  const file = f.control('artifact'); assert.equal(file.getAttribute('href'), '/api/tasks/task-a/artifacts/result/preview');
  const modified = await f.click(file, { ctrlKey: true }); assert.equal(modified.defaultPrevented, false); assert.deepEqual(opened, []);
  const clicked = await f.click(file); assert.equal(clicked.defaultPrevented, true); assert.deepEqual(opened, [{ taskId: 'task-a', artifactId: 'result' }]);
  assert.equal(f.mount.querySelectorAll('[data-artifact-id]').length, 1); ui.destroy();
});

test('an in-flight draft action cannot be duplicated and event handlers are removed on destruction', async t => {
  const f = planDOM(t); let count = 0, release;
  const ui = initTaskPlanUI({ mount: f.mount, onDraftDirection: () => { count++; return new Promise(resolve => { release = resolve; }); } }); update(ui, plan());
  const control = f.control('guide'), first = f.click(control); await f.click(control); assert.equal(count, 1); assert.equal(control.getAttribute('aria-busy'), 'true');
  release(); await first; assert.equal(control.getAttribute('aria-busy'), null); ui.destroy(); await f.click(control); assert.equal(count, 1); assert.equal(f.events.listeners.get('selectionchange').size, 0);
});

test('missing and unavailable plans display the explicit runtime reason, escaped as text', t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount });
  update(ui, { taskId: 'no-plan', steps: [], goal: 'Answer the question.' }, { runStatus: 'completed', planningStatus: 'missing', planningMessage: 'The provider returned <script>bad()</script> without a saved plan.' });
  assert.match(f.region('empty').innerHTML, /The plan was not recorded/); assert.match(f.region('empty').innerHTML, /&lt;script&gt;/); assert.doesNotMatch(f.region('empty').innerHTML, /<script>/);
  update(ui, { taskId: 'unavailable', steps: [] }, { planningAvailable: false }); assert.match(f.region('empty').innerHTML, /does not expose saved planning tools/); assert.equal(ui.getSelection().visibleIds.length, 0); ui.destroy();
});


test('a narrow plan starts with an accessible selected-step tray and gives the outline its own reading surface', async t => {
  const f = planDOM(t, { width: 390 }), actions = [], ui = initTaskPlanUI({ mount: f.mount, onDraftDirection: value => actions.push(value) }), state = plan(), before = structuredClone(state); update(ui, state);
  assert.equal(ui.getSelection().detailsExpanded, false); assert.equal(f.viewport().hidden, false); assert.equal(f.viewport().inert, false);
  assert.equal(f.mount.querySelector('.task-plan-detail-body').hidden, true); assert.equal(f.mount.querySelector('.task-plan-detail-body').inert, true);
  const tray = f.control('details'); assert.equal(tray.getAttribute('aria-expanded'), 'false'); assert.equal(tray.getAttribute('aria-controls'), f.mount.querySelector('.task-plan-detail-body').id);
  await f.click(f.node('inspect')); assert.equal(ui.getSelection().selectedId, 'inspect'); assert.equal(ui.getSelection().detailsExpanded, false); assert.equal(document.activeElement, f.node('inspect'));
  f.viewport().bounds = { top: 100, bottom: 400 }; f.node('inspect').querySelector('.task-plan-row').bounds = { top: 130, bottom: 185 };
  let visibleScroll = 108; Object.defineProperty(f.viewport(), 'scrollTop', { get() { return this.hidden ? 0 : visibleScroll; }, set(value) { if (!this.hidden) visibleScroll = value; } });
  await f.viewport().dispatch('scroll'); await f.click(f.control('details'));
  assert.equal(ui.getSelection().detailsExpanded, true); assert.equal(ui.getSelection().pinned, true); assert.equal(f.viewport().hidden, true); assert.equal(f.viewport().inert, true);
  assert.equal(f.mount.querySelector('.task-plan-detail-body').hidden, false); assert.equal(document.activeElement, f.control('details')); assert.match(f.inspector().innerHTML, /Back to outline/);
  await f.viewport().dispatch('scroll'); update(ui, structuredClone(state));
  await f.click(f.control('details')); assert.equal(f.viewport().hidden, false); assert.equal(f.viewport().scrollTop, 108); assert.equal(document.activeElement, f.node('inspect'));
  assert.deepEqual(actions, []); assert.deepEqual(state, before); ui.destroy();
});

test('keyboard details, dependencies, Escape and viewport changes never focus a hidden tree or detail control', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount, onDraftDirection() {} }), state = plan(); update(ui, state);
  f.node('read').focus(); const enter = await f.key(f.node('read'), 'Enter'); assert.equal(enter.defaultPrevented, true); assert.equal(document.activeElement, f.control('details'));
  await f.click(f.control('select', 'prepare')); assert.equal(ui.getSelection().selectedId, 'prepare'); assert.equal(ui.getSelection().detailsExpanded, true); assert.equal(document.activeElement, f.control('details'));
  f.control('guide').focus(); await f.resize(1440); assert.equal(f.viewport().hidden, false); assert.equal(document.activeElement, f.control('guide'));
  await f.resize(390); assert.equal(ui.getSelection().detailsExpanded, true); assert.equal(document.activeElement, f.control('guide')); assert.equal(f.mount.querySelector('.task-plan-detail-body').hidden, false);
  const escape = await f.key(f.control('guide'), 'Escape'); assert.equal(escape.defaultPrevented, true); assert.equal(document.activeElement, f.node('prepare')); assert.equal(f.viewport().hidden, false);
  await f.resize(1440); await f.click(f.control('details')); assert.equal(ui.getSelection().detailsExpanded, true);
  f.node('read').focus(); await f.resize(390); assert.equal(ui.getSelection().detailsExpanded, false); assert.equal(f.viewport().hidden, false); assert.equal(document.activeElement, f.node('prepare'));
  ui.destroy(); assert.equal(f.media.listeners.get('change').size, 0);
});

test('compact detail disclosure and independent reading positions survive SSE and task switches', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount, onDraftDirection() {} }), a = plan('task-a'), b = plan('task-b'); update(ui, a);
  await f.click(f.node('inspect')); await f.click(f.control('details')); f.inspector().scrollTop = 74; await f.inspector().dispatch('scroll'); const selected = f.node('inspect'); f.control('guide').focus();
  a.revision++; a.plan.focusStepId = 'write'; a.steps[2].evidence = 'New observed evidence.'; update(ui, a);
  assert.equal(f.node('inspect'), selected); assert.equal(ui.getSelection().selectedId, 'inspect'); assert.equal(f.inspector().scrollTop, 74); assert.equal(document.activeElement, f.control('guide'));
  update(ui, b); assert.equal(ui.getSelection().detailsExpanded, false); assert.equal(f.viewport().hidden, false);
  update(ui, a); assert.equal(ui.getSelection().detailsExpanded, true); assert.equal(ui.getSelection().selectedId, 'inspect'); assert.equal(f.inspector().scrollTop, 74);
  await f.click(f.control('details')); update(ui, structuredClone(a)); assert.equal(ui.getSelection().detailsExpanded, false); await f.click(f.control('details')); assert.equal(f.inspector().scrollTop, 74);
  ui.destroy();
});

test('the full task disclosure keeps its own reading focus across SSE and does not leak to another task', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount }), a = plan('task-a'), b = plan('task-b');
  a.goal = 'Build a clear checked local result with parallel preparation and an explicit repair-or-replace decision, preserving the entire supplied task.'; b.goal = a.goal + ' A different task.';
  update(ui, a); const goal = await f.toggleGoal(true), text = goal.querySelector('.task-plan-goal-text'); text.scrollTop = 33; text.focus();
  a.revision++; a.steps[1].status = 'done'; update(ui, a); const nextGoal = f.mount.querySelector('[data-plan-disclosure="goal"]');
  assert.equal(nextGoal.open, true); assert.equal(document.activeElement, nextGoal.querySelector('.task-plan-goal-text')); assert.equal(document.activeElement.scrollTop, 33);
  update(ui, b); assert.equal(f.mount.querySelector('[data-plan-disclosure="goal"]').open, false);
  update(ui, a); assert.equal(f.mount.querySelector('[data-plan-disclosure="goal"]').open, true); ui.destroy();
});


test('opening another compact step starts at its checks while the same step keeps its saved reading position', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state);
  await f.click(f.control('details')); f.inspector().scrollTop = 74; await f.inspector().dispatch('scroll'); await f.click(f.control('details'));
  await f.click(f.node('inspect')); await f.click(f.control('details'));
  assert.equal(ui.getSelection().selectedId, 'inspect'); assert.equal(f.inspector().scrollTop, 0, 'a different step does not inherit the previous evidence position');
  f.inspector().scrollTop = 29; await f.inspector().dispatch('scroll'); await f.click(f.control('details'));
  await f.click(f.node('inspect')); await f.click(f.control('details')); assert.equal(f.inspector().scrollTop, 29, 'reselecting the same step preserves its place');
  state.revision++; state.steps[2].evidence = 'Additional observed evidence.'; update(ui, state); assert.equal(f.inspector().scrollTop, 29, 'same-step SSE does not reset reading');
  ui.destroy();
});

for (const change of ['keyboard', 'current', 'branch', 'removed-step']) test(`changing detail selection through ${change} resets only the new step position`, async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state);
  if (change === 'current') await f.click(f.node('inspect'));
  const before = ui.getSelection().selectedId; await f.click(f.control('details')); f.inspector().scrollTop = 74; await f.inspector().dispatch('scroll'); await f.click(f.control('details'));
  if (change === 'keyboard') await f.key(f.node(before), 'ArrowDown');
  else if (change === 'current') await f.click(f.control('current'));
  else if (change === 'branch') await f.click(f.control('toggle', 'prepare'));
  else { state.steps = state.steps.filter(step => step.id !== before); state.revision++; update(ui, state); }
  assert.notEqual(ui.getSelection().selectedId, before); await f.click(f.control('details')); assert.equal(f.inspector().scrollTop, 0);
  ui.destroy();
});

test('following a new current step through SSE resets detail position without resetting same-step updates', async t => {
  const f = planDOM(t), ui = initTaskPlanUI({ mount: f.mount }), state = plan(); update(ui, state);
  f.inspector().scrollTop = 74; await f.inspector().dispatch('scroll'); state.revision++; state.steps[1].note = 'Reading the next part.'; update(ui, state);
  assert.equal(f.inspector().scrollTop, 74); assert.equal(ui.getSelection().pinned, false);
  state.revision++; state.steps[1].status = 'done'; state.plan.focusStepId = 'write'; update(ui, state);
  assert.equal(ui.getSelection().selectedId, 'write'); assert.equal(f.inspector().scrollTop, 0); ui.destroy();
});


test('a pending native full-task toggle survives an intervening SSE render for both opening and closing', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount }), state = plan();
  state.goal = 'Build and check the complete requested result with the supplied constraints and an explicit delivery decision.'; update(ui, state);
  for (const open of [true, false]) {
    const oldGoal = f.mount.querySelector('[data-plan-disclosure="goal"]'); oldGoal.open = open;
    state.revision++; state.steps[1].status = open ? 'done' : 'active'; update(ui, state);
    const nextGoal = f.mount.querySelector('[data-plan-disclosure="goal"]'); assert.notEqual(nextGoal, oldGoal); assert.equal(nextGoal.open, open);
    await f.mount.dispatch('toggle', { target: oldGoal }); assert.equal(nextGoal.open, open, 'late events from a removed disclosure cannot undo the current state');
  }
  ui.destroy();
});

test('a deferred full-task toggle stays with its task when navigation wins the event race', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount }), a = plan('task-a'), b = plan('task-b');
  a.goal = 'Build and check the original task with all its requested constraints and the complete original scope.';
  b.goal = 'Inspect the separate task with its own distinct constraints and an unrelated complete original scope.';
  update(ui, a); const outgoing = f.mount.querySelector('[data-plan-disclosure="goal"]'); outgoing.open = true;
  update(ui, b); const incoming = f.mount.querySelector('[data-plan-disclosure="goal"]'); assert.equal(incoming.open, false);
  await f.mount.dispatch('toggle', { target: outgoing }); assert.equal(incoming.open, false);
  update(ui, a); assert.equal(f.mount.querySelector('[data-plan-disclosure="goal"]').open, true, 'returning restores the outgoing task’s actual disclosure choice');
  ui.destroy();
});

test('a compact branch preview retains its complete condition in the opened step details', async t => {
  const f = planDOM(t, { width: 390 }), ui = initTaskPlanUI({ mount: f.mount }), state = plan();
  const condition = 'The component passes every declared check, including the complete file comparison, expected output format, and preservation of existing user constraints.';
  state.steps.push({ id: 'route', kind: 'choice', title: 'Choose the delivery route', status: 'pending', dependsOn: [], selectedChildId: 'repair' }, { id: 'repair', parentId: 'route', kind: 'action', title: 'Keep the checked component', status: 'pending', dependsOn: [], condition });
  update(ui, state); await f.click(f.node('repair')); assert.equal(ui.getSelection().detailsExpanded, false);
  assert.ok(f.node('repair').querySelector('.task-plan-row').innerHTML.includes(condition));
  await f.click(f.control('details')); assert.ok(f.inspector().innerHTML.includes(condition)); assert.match(f.inspector().innerHTML, /<dt>Condition<\/dt>/);
  ui.destroy();
});

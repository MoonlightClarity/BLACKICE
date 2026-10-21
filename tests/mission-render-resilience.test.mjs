import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the actual nested renderers with a small DOM so injected failures exercise
// signature commits, preserved content, and isolation without an Electron session.
const source = readFileSync(process.env.BLACKICE_MISSION_RENDER_SOURCE || new URL('../public/mission-ui.mjs', import.meta.url), 'utf8');
function renderer(name, next, context) {
  const start = source.indexOf('  function ' + name + '('), end = source.indexOf('  function ' + next + '(', start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext('(' + source.slice(start, end).trim() + ')', context);
}
class Element {
  constructor() { this.dataset = {}; this.children = []; this.slots = new Map(); this.className = ''; this.markup = ''; this.textContent = ''; this.classList = { toggle() {} }; }
  get innerHTML() { return this.markup; }
  set innerHTML(value) { if (this.failWrite) { this.failWrite = false; throw Error('private fixture detail'); } this.markup = value; }
  append(child) { child.remove(); child.parent = this; this.children.push(child); }
  insertBefore(child, reference) { child.remove(); child.parent = this; const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  querySelector(selector) {
    if (selector === '.conversation-render-error') return this.children.find(child => child.className.includes('conversation-render-error')) || null;
    if (selector === '.conversation-empty' || selector === 'details') return null;
    if (!this.slots.has(selector)) this.slots.set(selector, new Element());
    return this.slots.get(selector);
  }
  querySelectorAll() { return []; }
  contains() { return false; }
  setAttribute() {}
}
function fixture() {
  const section = new Element(), run = { id: 'first', status: 'completed', settled: true, attachmentIds: [], nodes: {}, workflow: { nodes: [] } };
  const turn = { run, userText: 'saved question', messages: [{ id: 'answer', role: 'assistant', text: 'saved answer' }] };
  const article = new Element(); article.dataset.messageId = 'answer'; section.querySelector('.conversation-responses').append(article);
  let selected = null;
  const context = {
    state: { feedback: {} }, document: { createElement: () => new Element(), activeElement: null }, window: { getSelection: () => selected },
    isActiveRun: () => false, isSettlingRun: () => false, runMetrics: () => ({ totalTokens: 10, hasUsage: true, durationMs: 50 }),
    recordedResponseRoutes: () => [{ model: 'saved', label: 'Saved model', agents: [{ name: 'Agent' }] }],
    messageHTML: message => '<p>' + message.text + '</p>', latest: () => run, getSnapshot: () => ({ runs: [run] }), selectedState: () => 'active',
    renderTaskState: () => '<p>saved plan</p>', renderToolIssues: () => '', renderTaskFiles: () => '<p>saved file</p>',
    stopNotice: () => null, latestMissionActivity: () => '', conversationRecovery: () => null, renderContextStatus: () => '', elapsed: () => '1s',
    onRepeatTask: null, taskSelectionPending: false, escape: value => String(value ?? ''), icon: () => '', $: () => new Element()
  };
  const render = renderer('renderTurn', 'scrollLatest', context);
  return { section, article, run, turn, context, render: () => render(section, turn), select: node => { selected = node ? { isCollapsed: false, containsNode: candidate => candidate === node } : null; } };
}
for (const selector of [
  '.conversation-user-slot', '.conversation-route-slot', '.conversation-work-slot', '.conversation-files-slot',
  '.conversation-turn-status', '.conversation-turn-controls', '.conversation-context-slot'
]) test('failed ' + selector + ' write preserves its content and can retry unchanged state', () => {
  const f = fixture(), slot = f.section.querySelector(selector);
  slot.dataset.signature = 'previous'; slot.innerHTML = 'previous content'; slot.failWrite = true;
  assert.throws(f.render, /private fixture detail/);
  assert.equal(slot.dataset.signature, 'previous');
  assert.equal(slot.innerHTML, 'previous content');
  assert.equal(f.render(), true);
  assert.notEqual(slot.dataset.signature, 'previous');
});
test('a response formatter failure keeps the saved article and does not cache a false success', () => {
  const f = fixture(); f.article.dataset.signature = 'previous'; f.article.innerHTML = 'previous answer';
  f.context.messageHTML = () => { throw Error('private formatter detail'); };
  assert.throws(f.render, /private formatter detail/);
  assert.equal(f.article.innerHTML, 'previous answer'); assert.equal(f.article.dataset.signature, 'previous');
  f.context.messageHTML = () => '<p>current answer</p>';
  assert.equal(f.render(), true); assert.equal(f.article.innerHTML, '<p>current answer</p>'); assert.notEqual(f.article.dataset.signature, 'previous');
});
for (const target of ['answer', 'plan']) test('selected ' + target + ' defers its signature and renders after selection clears', () => {
  const f = fixture(), slot = target === 'answer' ? f.article : f.section.querySelector('.conversation-work-slot');
  slot.dataset.signature = 'previous'; slot.innerHTML = 'selected content'; f.select(slot);
  assert.equal(f.render(), false); assert.equal(f.context.taskSelectionPending, true);
  assert.equal(slot.dataset.signature, 'previous'); assert.equal(slot.innerHTML, 'selected content');
  f.select(null); assert.equal(f.render(), true); assert.notEqual(slot.dataset.signature, 'previous');
});
function timelineFixture(renderTurn) {
  const timeline = new Element(), view = new Element(), jump = new Element(), runs = [
    { id: 'first', updatedAt: 'saved', status: 'completed', settled: true, nodes: {} },
    { id: 'second', updatedAt: 'saved', status: 'completed', settled: true, nodes: {} }
  ];
  const context = { state: { viewKey: 'task', runId: 'first', forceNew: false, autoScroll: true, feedback: {} }, NEW: 'new',
    family: snapshot => snapshot.runs, conversationId: () => 'task', conversationIsVisible: () => false,
    readingPositions: new Map(), clearSearchMatch() {}, switchDraft() {}, renderConversationTitle() {},
    $: selector => selector === '#conversation-timeline' ? timeline : selector === '#conversation-jump' ? jump : view,
    document: { createElement: () => new Element() }, selectedState: () => 'active', stopRequests: new Map(), renderTurn,
    conversationTurn: run => ({ run }), restoreConversationScroll() {}, scrollLatest() {}
  };
  const render = renderer('renderTimeline', 'renderWelcome', context);
  return { timeline, runs, render: () => render({ runs }) };
}
test('one bad turn preserves content, permits later turns, and retries the same receipt on the next update', () => {
  let failing = true; const calls = [];
  const f = timelineFixture((section, turn) => {
    calls.push(turn.run.id); if (turn.run.id === 'first' && failing) throw Error('private raw failure');
    section.querySelector('.conversation-responses').innerHTML = 'rendered ' + turn.run.id; return true;
  });
  const saved = new Element(); saved.dataset.runId = 'first'; saved.querySelector('.conversation-responses').innerHTML = 'previously visible'; f.timeline.append(saved);
  assert.doesNotThrow(f.render); assert.equal(saved.querySelector('.conversation-responses').innerHTML, 'previously visible');
  assert.equal(saved.dataset.runSignature, undefined);
  const notice = saved.querySelector('.conversation-render-error'); assert.match(notice.textContent, /Saved work is kept/); assert.doesNotMatch(notice.textContent, /private raw failure/);
  assert.equal(f.timeline.children[1].querySelector('.conversation-responses').innerHTML, 'rendered second');
  assert.ok(f.timeline.children[1].dataset.runSignature);
  failing = false; f.render();
  assert.deepEqual(calls, ['first', 'second', 'first']); assert.ok(saved.dataset.runSignature); assert.equal(saved.querySelector('.conversation-render-error'), null);
  assert.equal(f.timeline.children[0], saved);
});
test('bad saved node metadata is isolated before formatting so the next turn remains visible', () => {
  const calls = [], f = timelineFixture((section, turn) => { calls.push(turn.run.id); return true; });
  f.runs[0].nodes = { broken: null };
  assert.doesNotThrow(f.render);
  assert.deepEqual(calls, ['second']); assert.ok(f.timeline.children[0].querySelector('.conversation-render-error')); assert.ok(f.timeline.children[1].dataset.runSignature);
  f.runs[0].nodes = {}; f.render(); assert.deepEqual(calls, ['second', 'first']); assert.ok(f.timeline.children[0].dataset.runSignature);
});
test('selection-deferred turn rendering does not commit the parent signature', () => {
  let complete = false; const f = timelineFixture(() => complete);
  f.render(); assert.equal(f.timeline.children[0].dataset.runSignature, undefined);
  complete = true; f.render(); assert.ok(f.timeline.children[0].dataset.runSignature);
});

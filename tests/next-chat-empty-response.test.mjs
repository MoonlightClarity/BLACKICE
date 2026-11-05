import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesOfRun, mergeChatRunUpdate, chatHeaderStatus } from '../public/next/chat/model.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { paintHistory } from '../public/next/chat/render.mjs';

function viewFixture() {
  const document = {
    activeElement: null,
    createElement(tag) { return element(tag.toUpperCase()); },
    createDocumentFragment() { return element('#fragment'); },
  };
  function element(tagName) {
    const listeners = new Map();
    const node = {
      tagName, ownerDocument: document, className: '', dataset: {}, attributes: {}, children: [], _text: '',
      classList: { add() {} },
      append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } },
      insertBefore(child, before) {
        child.remove(); child.parentElement = this;
        this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
      },
      remove() { if (this.parentElement) { const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; } },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); },
      dispatch(name) { for (const handler of listeners.get(name) || []) handler({ target: this }); },
      click() { this.dispatch('click'); },
      focus() { document.activeElement = this; },
      querySelectorAll(selector) {
        assert.equal(selector, 'details[data-disclosure-id]');
        return descendants(this, child => child !== this && child.tagName === 'DETAILS' && child.dataset.disclosureId !== undefined);
      },
    };
    Object.defineProperties(node, {
      childNodes: { get() { return this.children; } },
      lastChild: { get() { return this.children.at(-1); } },
      textContent: {
        get() { return this._text + this.children.map(child => child.textContent).join(''); },
        set(value) { this._text = String(value ?? ''); this.children = []; },
      },
    });
    return node;
  }
  return { timeline: element('MAIN'), input: element('TEXTAREA') };
}
function descendants(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => descendants(child, predicate))];
}
const blankRun = (events = [
  { nodeId: 'agent', data: { type: 'delta', itemId: 'reply', delta: ' ' } },
  { nodeId: 'agent', data: { type: 'message', itemId: 'reply', phase: 'final_answer', text: ' ' } },
]) => ({
  id: 'empty-native-turn', taskId: 'conversation', input: 'test', status: 'completed', settled: true,
  workflow: { settings: { planningMode: 'off' }, nodes: [{ id: 'agent', type: 'agent', name: 'BLACKICE agent', model: 'mistral-vibe::zai-glm-5-3-flash' }] },
  nodes: { agent: { status: 'completed', threadId: 'vibe_fixture', output: ' ' } },
  output: '[BLACKICE agent]\n ', events,
});
const compact = source => projectFamily({ rootId: 'conversation', runs: [source] }).runs[0];
const buttons = view => descendants(view.timeline, node => node.tagName === 'BUTTON');

test('saved whitespace-only native turns show a truthful missing response and never replay work', () => {
  for (const events of [undefined, []]) {
    const source = blankRun(events), before = structuredClone(source), run = compact(source);
    assert.deepEqual(messagesOfRun(source), [], 'An aggregate agent heading is not an answer.');
    assert.deepEqual(run.precomputedMessages, []);
    const view = viewFixture(), actions = [];
    view.input.value = 'Keep my unfinished draft';
    paintHistory(view, [run], { onStop: (...args) => actions.push(args) });
    assert.match(view.timeline.textContent, /No response received/);
    assert.match(view.timeline.textContent, /ended without a response/);
    assert.doesNotMatch(view.timeline.textContent, /Response saved|\[BLACKICE agent\]/);
    const followup = buttons(view).find(button => button.textContent === 'Write a follow-up');
    assert.ok(followup, 'Recovery must be directly available without inventing an answer.');
    assert.equal(buttons(view).some(button => button.textContent === 'Retry'), false);
    followup.click();
    assert.equal(view.input.ownerDocument.activeElement, view.input);
    assert.equal(view.input.value, 'Keep my unfinished draft');
    assert.deepEqual(actions, [], 'Focusing the composer must not resend a prompt or replay tools.');
    assert.deepEqual(source, before, 'Historical source receipts must remain untouched.');
  }
});

test('failed empty output keeps the actual bounded error through worker projection and live updates', () => {
  const reason = 'Mistral ended the turn without response text. <provider-detail> ' + 'x'.repeat(4000);
  const source = blankRun();
  source.status = 'failed'; source.error = 'Agent failed.';
  source.nodes.agent = { ...source.nodes.agent, status: 'failed', error: reason };
  source.nodes.untrusted = { status: 'failed', error: { message: 'DO_NOT_SERIALIZE_RAW_ERROR', trace: 'private' } };
  const run = compact(source);
  assert.equal(run.error, 'Agent failed.');
  assert.equal(run.nodes.agent.error.length, 2000);
  assert.equal(run.nodes.untrusted.error, undefined);
  assert.doesNotMatch(JSON.stringify(run), /DO_NOT_SERIALIZE_RAW_ERROR|private/);
  const view = viewFixture();
  paintHistory(view, [run]);
  assert.match(view.timeline.textContent, /Mistral ended the turn without response text\. <provider-detail>/);
  assert.doesNotMatch(view.timeline.textContent, /Response saved/);
  assert.equal(buttons(view).some(button => button.textContent === 'Retry'), false, 'Empty failed turns use a new follow-up, not replay.');
  const updated = mergeChatRunUpdate(run, { id: run.id, status: 'failed', settled: true, error: 'Updated native failure' });
  assert.equal(updated.error, 'Updated native failure');
  paintHistory(view, [updated]);
  assert.match(view.timeline.textContent, /Updated native failure/);
});

test('real completed answers remain visible and saved, including legacy aggregate-only answers', () => {
  for (const legacy of [false, true]) {
    const source = blankRun([]);
    source.output = 'A real answer';
    if (legacy) delete source.nodes.agent.output;
    else source.nodes.agent.output = source.output;
    const view = viewFixture();
    paintHistory(view, [compact(source)]);
    assert.match(view.timeline.textContent, /A real answer/);
    assert.match(view.timeline.textContent, /Response saved/);
    assert.doesNotMatch(view.timeline.textContent, /No response received|Write a follow-up/);
  }
});

test('an intentional plan-only pause is not reported as a missing answer', () => {
  const source = blankRun([]);
  source.planningExecutionMode = 'plan_only';
  source.responseCycle = { state: 'paused_after_plan', requestId: 'saved-plan', cycleId: 'cycle', stage: 'plan' };
  const view = viewFixture();
  paintHistory(view, [compact(source)]);
  assert.match(view.timeline.textContent, /Plan ready/);
  assert.doesNotMatch(view.timeline.textContent, /No response received|ended without a response|Write a follow-up/);
});

test('commentary and provisional work stay in Details instead of being promoted to a delivered answer', () => {
  for (const extra of [{ phase: 'commentary' }, { phase: 'final_answer', provisional: true }]) {
    const source = blankRun([{ nodeId: 'agent', data: { type: 'message', itemId: 'work', text: 'Recorded work', ...extra } }]);
    source.nodes.agent.output = ''; source.output = '';
    const run = compact(source), view = viewFixture();
    assert.equal(run.precomputedMessages.length, 1);
    paintHistory(view, [run]);
    assert.match(view.timeline.textContent, /No response received/);
    assert.match(view.timeline.textContent, /Details/);
    assert.equal(descendants(view.timeline, node => node.className.includes('next-chat-response')).length, 0);
    assert.equal(run.precomputedMessages[0].text, 'Recorded work');
  }
});

test('an unsettled turn is still finishing and old missing turns cannot focus a newer prompt', () => {
  const pending = blankRun();
  pending.settled = false;
  const view = viewFixture();
  paintHistory(view, [compact(pending)]);
  assert.match(view.timeline.textContent, /Finishing/);
  assert.doesNotMatch(view.timeline.textContent, /No response received|Write a follow-up/);
  const answered = blankRun([]);
  answered.id = 'newer-turn'; answered.nodes.agent.output = 'Later answer'; answered.output = 'Later answer';
  paintHistory(view, [compact(blankRun()), compact(answered)]);
  assert.match(view.timeline.textContent, /No response received/);
  assert.equal(buttons(view).some(button => button.textContent === 'Write a follow-up'), false);
});

test('zero-width-only native output is missing in both saved and failed turns after projection', () => {
  const invisible = '\u200b\u2060';
  for (const status of ['completed', 'failed']) for (const streamed of [false, true]) {
    const source = blankRun(streamed ? [
      { nodeId: 'agent', data: { type: 'delta', itemId: 'reply', delta: invisible } },
      { nodeId: 'agent', data: { type: 'message', itemId: 'reply', phase: 'final_answer', text: invisible } },
    ] : []);
    source.status = status; source.nodes.agent.status = status;
    source.nodes.agent.output = invisible; source.output = '[BLACKICE agent]\n' + invisible;
    if (status === 'failed') source.nodes.agent.error = 'Mistral returned no visible answer.';
    const run = compact(source), view = viewFixture();
    assert.deepEqual(messagesOfRun(source), []);
    assert.deepEqual(run.precomputedMessages, []);
    paintHistory(view, [run]);
    assert.equal(view.timeline.textContent.includes(invisible), false);
    assert.doesNotMatch(view.timeline.textContent, /Response saved|\[BLACKICE agent\]/);
    if (status === 'completed') assert.match(view.timeline.textContent, /No response received/);
    else assert.match(view.timeline.textContent, /Mistral returned no visible answer/);
    assert.ok(buttons(view).some(button => button.textContent === 'Write a follow-up'));
    assert.equal(buttons(view).some(button => button.textContent === 'Retry'), false);
  }
});


test('conversation headers distinguish delivered answers, missing output, and intentional plan pauses', () => {
  const missing = blankRun();
  const invisible = blankRun([]);
  invisible.nodes.agent.output = '\u200b\u2060'; invisible.output = '[BLACKICE agent]\n' + invisible.nodes.agent.output;
  const answered = blankRun([]);
  answered.nodes.agent.output = 'Saved visible answer'; answered.output = answered.nodes.agent.output;
  const paused = blankRun([]);
  paused.responseCycle = { state: 'paused_after_plan', requestId: 'saved-plan', cycleId: 'cycle', stage: 'plan' };
  for (const project of [run => run, compact]) {
    assert.equal(chatHeaderStatus(project(missing)), 'No response received');
    assert.equal(chatHeaderStatus(project(invisible)), 'No response received');
    assert.equal(chatHeaderStatus(project(answered)), 'Saved response');
    assert.equal(chatHeaderStatus(project(paused)), 'Plan ready');
    assert.equal(chatHeaderStatus(project({ ...missing, settled: false })), 'Finishing');
  }
  assert.equal(chatHeaderStatus(undefined), 'Local workspace');
  assert.equal(chatHeaderStatus({ status: 'failed', settled: true }), 'failed');
});

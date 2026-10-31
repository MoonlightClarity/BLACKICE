import test from 'node:test';
import assert from 'node:assert/strict';
import { planningReturnRun } from './fixtures/planning-return-records.mjs';
import { messagesOfRun } from '../public/next/chat/model.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { paintHistory } from '../public/next/chat/render.mjs';
import { CHAT_PLANNING_ACTIVITY_LIMIT, CHAT_PLANNING_ACTIVITY_CHAR_LIMIT, planningActivityForEvent, mergePlanningActivity, projectPlanningActivity, chatTimeline } from '../public/next/chat/planning-timeline.mjs';
import { normalizeObserveEvent, createObserveFeed } from '../public/observe-model.mjs';
import { renderObserveFeed } from '../public/observe-ui.mjs';

function fakeTimeline() {
  const document = { createElement: element, createDocumentFragment: () => element('#fragment') };
  function element(tagName) {
    const node = { tagName, ownerDocument: document, className: '', dataset: {}, attributes: {}, children: [], _text: '',
      classList: { add() {} }, append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children.flatMap(child => child.tagName === '#fragment' ? child.children : [child]); this._text = ''; },
      setAttribute(name, value) { this.attributes[name] = String(value); }, addEventListener() {},
      querySelectorAll(selector) { assert.equal(selector, 'details[data-disclosure-id]'); return descendants(this, item => item.tagName === 'details' && item.dataset.disclosureId); } };
    Object.defineProperty(node, 'textContent', { get() { return this._text + this.children.map(child => child.textContent).join(''); }, set(value) { this._text = String(value ?? ''); this.children = []; } });
    Object.defineProperty(node, 'innerHTML', { get() { return this._html ?? ''; }, set(value) { this._html = String(value); this._text = ''; this.children = []; } });
    return node;
  }
  return element('main');
}
const descendants = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => descendants(child, predicate))];

test('public records retain Plan → Think → Plan → Think → Respond with timestamps, sources, and only one final answer', () => {
  const run = planningReturnRun(), before = structuredClone(run), messages = messagesOfRun(run), groups = chatTimeline(run, messages);
  assert.deepEqual(groups.map(group => group.phase), ['plan', 'think', 'plan', 'think', 'respond']);
  assert.deepEqual(groups.map(group => group.entries[0].at), [1, 2, 4, 5, 6].map(second => `2026-10-29T12:00:0${second}.000Z`));
  assert.deepEqual(groups.map(group => group.entries.map(entry => entry.source)), [['plan'], ['message', 'observation'], ['review'], ['message'], ['message']]);
  assert.equal(groups[2].entries[0].decision, 'respond');
  assert.equal(groups.at(-1).entries.length, 1, 'delta, completed message/item, and node output describe one actual answer');
  assert.equal(groups.at(-1).entries[0].message.text, run.output);
  assert.deepEqual(groups.map(group => group.id), chatTimeline(run, messages).map(group => group.id), 'stable IDs come from actual records');
  assert.deepEqual(run, before);
});

test('the production renderer preserves both planning visits in expandable history and the full dotted outline', () => {
  const [run] = projectFamily({ runs: [planningReturnRun()] }).runs, timeline = fakeTimeline();
  paintHistory({ timeline }, [run]);
  const history = descendants(timeline, node => node.className === 'next-chat-outline-history')[0];
  assert.ok(history, 'The saved work remains inspectable in its History disclosure.');
  assert.deepEqual(descendants(history, node => node.dataset.phase).map(node => node.dataset.phase), ['plan', 'think', 'think', 'plan', 'think']);
  const sources = descendants(timeline, node => node.dataset.activitySource).map(node => node.dataset.activitySource);
  assert.deepEqual(sources, ['plan', 'observation', 'review']);
  assert.deepEqual(descendants(timeline, node => node.dataset.stepNumber).map(node => [node.dataset.stepId, node.dataset.stepNumber]), [['check', '1'], ['amounts', '1.1'], ['calculate', '1.1.1']]);
  const outline = descendants(timeline, node => node.className === 'next-chat-details')[0];
  assert.equal(outline.children[0].textContent, 'Plan');
  assert.equal(descendants(outline, node => node.className === 'next-chat-plan-outline').length, 3, 'parents remain nested instead of flattened numbered rows');
  assert.equal(descendants(timeline, node => node.className === 'next-message next-chat-response').length, 1);
  assert.equal(timeline.textContent.split(run.output).length - 1, 1);
});

test('background projection keeps bounded public chronology and parent links without transferring raw reasoning or tool traces', () => {
  const run = planningReturnRun();
  run.events.splice(2, 0, { type: 'agent.event', runId: run.id, nodeId: 'agent', at: '2026-10-29T12:00:02.500Z', data: { type: 'item', item: { type: 'reasoning', text: 'PRIVATE_REASONING_TRACE' } } });
  run.events.splice(3, 0, { type: 'agent.event', runId: run.id, nodeId: 'agent', data: { type: 'item', item: { type: 'dynamicToolCall', arguments: { raw: 'RAW_TOOL_PAYLOAD' }, contentItems: [{ text: 'RAW_TOOL_RESULT' }] } } });
  const projected = projectFamily({ runs: [run] }).runs[0];
  assert.deepEqual(projected.events, []);
  assert.equal(projected.taskState.steps[2].parentId, 'amounts');
  assert.deepEqual(chatTimeline(projected, projected.precomputedMessages).map(group => group.phase), ['plan', 'think', 'plan', 'think', 'respond']);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_REASONING_TRACE|RAW_TOOL_PAYLOAD|RAW_TOOL_RESULT/);
  const many = mergePlanningActivity([], Array.from({ length: 300 }, (_, order) => ({ id: 'record-' + order, phase: 'plan', source: 'plan', order })));
  assert.equal(many.length, CHAT_PLANNING_ACTIVITY_LIMIT);
  assert.equal(many.at(-1).id, 'record-299');
});

test('live projection matches saved chronology, coalesces adjacent phases, and marks only the latest active phase', () => {
  const run = planningReturnRun(); let state = null, activity = [];
  for (const [order, event] of run.events.entries()) {
    activity = mergePlanningActivity(activity, planningActivityForEvent(run.id, event, state, order));
    if (event.data.type === 'task.state') state = event.data.state;
  }
  const live = { ...run, status: 'running', settled: false, planningActivity: activity };
  const messages = messagesOfRun(run).filter(message => message.phase === 'commentary');
  const groups = chatTimeline(live, messages);
  assert.deepEqual(groups.map(group => group.phase), ['plan', 'think', 'plan', 'think']);
  assert.equal(groups.filter(group => group.active).length, 1); assert.equal(groups.at(-1).active, true);
  assert.deepEqual(activity, projectPlanningActivity(run));
  const timeline = fakeTimeline(); paintHistory({ timeline }, [{ ...live, precomputedMessages: messages }]);
  const active = descendants(timeline, node => node.attributes.role === 'status');
  assert.equal(active.length, 1); assert.equal(active[0].dataset.liveOutput, run.id);
  assert.equal(active[0].attributes['aria-live'], 'polite'); assert.equal(active[0].attributes['aria-atomic'], 'true');
  assert.ok(active[0].textContent.trim(), 'Running work exposes its current progress to assistive technology.');
});

test('reading unchanged state adds no fake planning return and old review snapshots keep their original position', () => {
  const run = planningReturnRun(), saved = run.taskState;
  const rows = projectPlanningActivity(run);
  const readback = { type: 'agent.event', nodeId: 'agent', at: '2026-10-29T12:00:20.000Z', data: { type: 'task.state', state: saved } };
  assert.deepEqual(mergePlanningActivity(rows, planningActivityForEvent(run.id, readback, saved, 20)), rows);
  const fromReader = projectFamily({ runs: [run] }).runs[0].taskState;
  assert.equal(planningActivityForEvent(run.id, readback, fromReader, 20).filter(row => row.source === 'plan').length, 0);
  const withoutHistory = projectPlanningActivity({ ...run, events: [] });
  assert.equal(withoutHistory.length, 1); assert.equal(withoutHistory[0].source, 'review');
  assert.equal(withoutHistory[0].at, saved.planningReviews[0].at, 'only an independently dated saved receipt recovers missing history');
});

test('a new run adopting an unchanged unfinished outline records its actual new planning visit', () => {
  const run = planningReturnRun(), prior = structuredClone(run.events[0].data.state), adopted = structuredClone(prior);
  prior.plan.authoredBy.runId = 'previous-run'; adopted.revision++;
  const event = { type: 'agent.event', nodeId: 'agent', at: '2026-10-29T12:00:01.000Z', data: { type: 'task.state', state: adopted } };
  const rows = planningActivityForEvent(run.id, event, prior, 1);
  assert.equal(rows.length, 1); assert.equal(rows[0].source, 'plan');
  assert.deepEqual(planningActivityForEvent(run.id, { ...event, data: { type: 'task.state', state: prior } }, null, 1), [], 'old run planning is not presented as a new authored plan');
  prior.provenance = { runId: run.id, source: 'runtime' };
  assert.deepEqual(planningActivityForEvent(run.id, { ...event, data: { type: 'task.state', state: prior } }, null, 1), [], 'a status receipt for this run cannot reattribute the old plan');
});

test('actual replanning, revisiting a leaf, and saved continue review retain their chronology and next step', () => {
  const run = planningReturnRun(), original = run.events[0].data.state;
  const revised = structuredClone(original); revised.revision = 4; revised.updatedAt = '2026-10-29T12:00:04.000Z';
  revised.steps[2].attempt = 2; revised.steps[2].note = 'Recheck the corrected delivery fee.';
  revised.planningReviews = [{ runId: run.id, nodeId: 'agent', reviewedRevision: 3, at: revised.updatedAt, decision: 'continue', nextStepId: 'calculate', summary: 'The quoted fee changed; revisit the arithmetic before answering.' }];
  const event = { type: 'agent.event', nodeId: 'agent', at: revised.updatedAt, data: { type: 'task.state', state: revised } };
  const rows = planningActivityForEvent(run.id, event, run.events[2].data.state, 3);
  assert.deepEqual(rows.map(row => row.source), ['plan', 'review']);
  assert.equal(rows[1].nextStepId, 'calculate');
  const groups = chatTimeline({ ...run, events: run.events.slice(0, 3).concat(event), taskState: revised }, messagesOfRun(run).filter(message => message.phase === 'commentary'));
  assert.deepEqual(groups.map(group => group.phase), ['plan', 'think', 'plan', 'think']);
  assert.equal(groups[2].entries.length, 2, 'adjacent plan mutation and review share one heading without erasing either receipt');
});

test('Observe labels real review calls and runtime returns and admits both to its live activity feed', () => {
  const runId = 'live', at = '2026-10-29T12:00:04.000Z';
  const event = data => ({ type: 'agent.event', runId, nodeId: 'agent', at, data });
  const call = event({ type: 'item', stage: 'completed', item: { id: 'review-call', type: 'dynamicToolCall', name: 'relay_task', arguments: { action: 'review', review: { decision: 'continue', summary: 'A changed fee needs another check.', private: 'PRIVATE_PAYLOAD' } }, contentItems: [{ text: 'RAW_TOOL_RESULT' }] } });
  const review = normalizeObserveEvent(call);
  assert.equal(review.title, 'Reassess plan'); assert.equal(review.kind, 'plan'); assert.equal(review.reassessment, true);
  assert.equal(review.detail, 'continue · A changed fee needs another check.');
  assert.doesNotMatch(JSON.stringify(review), /PRIVATE_PAYLOAD|RAW_TOOL_RESULT/);
  const returning = event({ type: 'planning.reassessment', reviewStatus: 'continuing', returnCount: 1, reviewReason: 'No current review covers the recorded outcome.' });
  assert.equal(normalizeObserveEvent(returning).title, 'Return to planning');
  assert.equal(normalizeObserveEvent(returning).status, 'running');
  const current = event({ type: 'planning.reassessment', reviewStatus: 'current', returnCount: 1, review: { decision: 'respond', reviewedRevision: 5, summary: 'The corrected total is checked.' } });
  assert.equal(normalizeObserveEvent(current).title, 'Planning reviewed');
  const stalled = event({ type: 'planning.reassessment', reviewStatus: 'stalled', returnCount: 1, reviewReason: 'The same unfinished work remains.' });
  assert.equal(normalizeObserveEvent(stalled).status, 'failed');
  const feed = createObserveFeed(); feed.reset(runId);
  assert.equal(feed.event(returning), true); assert.equal(feed.event(returning), false);
  assert.equal(feed.event(call), true); assert.equal(feed.event(current), true);
  assert.equal(feed.event(event({ type: 'task.state', state: { steps: [] } })), false, 'ordinary snapshot cards stay in the saved outline');
  assert.deepEqual(feed.snapshot().entries.map(row => row.title), ['Return to planning', 'Reassess plan', 'Planning reviewed']);
  const html = renderObserveFeed(feed.snapshot().entries);
  assert.match(html, /Return to planning/); assert.match(html, /The corrected total is checked/);
});

test('runtime continuation is a visible planning return without inventing a thinking phase or answer', () => {
  const run = planningReturnRun(); run.events = run.events.slice(0, 3); run.taskState = run.events[2].data.state; run.output = ''; run.nodes.agent.output = ''; run.status = 'running'; run.settled = false;
  run.events.push({ type: 'agent.event', runId: run.id, nodeId: 'agent', at: '2026-10-29T12:00:04.000Z', data: { type: 'planning.reassessment', reviewStatus: 'continuing', returnCount: 1, reviewReason: 'Return to the saved plan and assess the completed check.' } });
  const groups = chatTimeline(run, messagesOfRun(run));
  assert.deepEqual(groups.map(group => group.phase), ['plan', 'think', 'plan']);
  assert.equal(groups.at(-1).entries[0].source, 'runtime-reassessment'); assert.equal(groups.at(-1).active, true);
  assert.equal(groups.some(group => group.phase === 'respond'), false);
});

test('the timeline keeps accepted user directions in place and never fabricates a second thinking update', () => {
  const run = planningReturnRun();
  run.events = run.events.filter(event => event.data.itemId !== 'working-two');
  run.events.splice(1, 0, { type: 'agent.event', nodeId: 'agent', at: '2026-10-29T12:00:01.500Z', data: { type: 'steer', accepted: true, text: 'Keep the delivery fee separate in the answer.' } });
  const groups = chatTimeline(run, messagesOfRun(run));
  assert.deepEqual(groups.map(group => group.phase), ['plan', 'direction', 'think', 'plan', 'respond']);
  assert.equal(groups[1].entries[0].message.text, 'Keep the delivery fee separate in the answer.');
  assert.equal(groups[1].entries[0].at, '2026-10-29T12:00:01.500Z');
});

test('delegated workers keep separate reassessment identities even when emitted through their coordinator', () => {
  const event = workerId => ({ type: 'agent.event', runId: 'run', nodeId: 'coordinator', at: '2026-10-29T12:00:04.000Z', data: { type: 'planning.reassessment', workerId, reviewStatus: 'continuing', returnCount: 1, reviewReason: 'Review the saved result.' } });
  const one = event('worker-one'), two = event('worker-two');
  const rows = mergePlanningActivity(planningActivityForEvent('run', one), planningActivityForEvent('run', two));
  assert.deepEqual(rows.map(row => row.nodeId), ['worker-one', 'worker-two']);
  assert.notEqual(normalizeObserveEvent(one).key, normalizeObserveEvent(two).key);
  assert.equal(normalizeObserveEvent(two).nodeId, 'worker-two');
  const run = planningReturnRun(), done = structuredClone(run.events[2]); done.nodeId = 'coordinator'; done.data.state.provenance = { runId: run.id, nodeId: 'worker-one' };
  assert.equal(planningActivityForEvent(run.id, done, run.events[0].data.state).find(row => row.source === 'observation').nodeId, 'worker-one');
});

test('malformed archived collections do not crash the reader and saved activity is allowlisted and bounded', () => {
  const run = planningReturnRun(); run.events = []; run.taskState.steps = [null]; run.taskState.planningReviews = { unexpected: true }; run.taskState.artifacts = 'invalid';
  run.planningActivity = Array.from({ length: 400 }, (_, index) => ({ id: `plan:${run.id}:${index}`, source: 'plan', phase: 'plan', at: { invalid: true }, order: index, title: 'x'.repeat(5000), text: 'e'.repeat(10000), privateTrace: 'PRIVATE_TRACE', rawTaskState: { private: 'RAW_SNAPSHOT' } }));
  run.planningActivity.push({ id: `reasoning:${run.id}:private`, source: 'reasoning', phase: 'think', text: 'PRIVATE_REASONING' });
  run.planningActivity.push({ id: 'plan:unrelated-run:1', source: 'plan', phase: 'plan', text: 'UNRELATED_RUN' });
  const projected = projectFamily({ runs: [run] }).runs[0];
  assert.deepEqual(projected.taskState.steps, []); assert.deepEqual(projected.taskState.planningReviews, []); assert.deepEqual(projected.taskState.artifacts, []);
  assert.ok(projected.planningActivity.length <= CHAT_PLANNING_ACTIVITY_LIMIT);
  assert.ok(JSON.stringify(projected.planningActivity).length <= CHAT_PLANNING_ACTIVITY_CHAR_LIMIT);
  assert.ok(projected.planningActivity.every(row => row.title.length <= 300 && row.text.length <= 1200));
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_TRACE|RAW_SNAPSHOT|PRIVATE_REASONING|UNRELATED_RUN/);
});

test('only an observed final-message start after a dated review adds public response preparation', () => {
  const run = planningReturnRun(); run.events = run.events.filter(event => event.data.itemId !== 'working-two');
  const started = { type: 'agent.event', nodeId: 'agent', at: '2026-10-29T12:00:05.000Z', data: { type: 'item', stage: 'started', item: { id: 'final-one', type: 'agentMessage', phase: 'final_answer', text: '' } } };
  run.events.splice(4, 0, started);
  const groups = chatTimeline(run, messagesOfRun(run));
  assert.deepEqual(groups.map(group => group.phase), ['plan', 'think', 'plan', 'think', 'respond']);
  assert.equal(groups[3].entries[0].source, 'composition'); assert.equal(groups[3].entries[0].at, started.at);
  assert.equal(groups[3].entries[0].title, 'Compose response');
  assert.deepEqual(planningActivityForEvent(run.id, started, null), [], 'missing review metadata cannot invent a composition boundary');
  assert.deepEqual(planningActivityForEvent(run.id, { ...started, at: '2026-10-29T12:00:03.000Z' }, run.taskState), [], 'an earlier start is not work after the review');
  assert.deepEqual(planningActivityForEvent(run.id, { ...started, data: { ...started.data, stage: 'completed' } }, run.taskState), []);
});

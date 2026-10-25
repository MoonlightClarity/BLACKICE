import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationRecovery, conversationId, conversationRuns, conversationSummaries, conversationSidebarItems, selectedConversationModel, selectedConversationContext, selectedConversationEffort, selectedConversationPlanDetail, selectedConversationPlanningMode, conversationPlanningConfig, restoreConversationDrafts, searchConversations, mergeConversationRuns, assistantMessages, conversationTurn, conversationAgents, shouldSendConversationKey, createRegisteredArtifactResolver } from '../public/conversation-model.mjs';
import { PLANNING_MODES, normalizePlanningMode, planningModeDetail } from '../public/planning-mode.mjs';
import { conversationReasoningChoice } from '../public/conversation-model.mjs';
import { selectedConversationServiceTier } from '../public/conversation-model.mjs';

test('metadata-only live updates reuse immutable event history without reprocessing its receipts', () => {
  const events = [{ at: '2026-10-24T12:00:00Z', nodeId: 'agent', data: { type: 'message', text: 'Already received' } }];
  const cached = { id: 'cached', events, nodes: { agent: { output: 'Already received' } }, status: 'running' };
  const statusOnly = { ...cached, status: 'completed', settled: true };
  const merged = mergeConversationRuns([cached], [statusOnly]);
  assert.equal(merged[0].status, 'completed');
  assert.equal(merged[0].settled, true);
  assert.strictEqual(merged[0].events, events);
  const withoutEvents = mergeConversationRuns([cached], [{ id: 'cached', status: 'failed' }]);
  assert.strictEqual(withoutEvents[0].events, events);
  assert.equal(withoutEvents[0].status, 'failed');
});

test('thousands of saved chats summarize without quadratic re-indexing on a frontend refresh', () => {
  const runs = Array.from({ length: 2500 }, (_, index) => ({
    id: 'performance-run-' + index, status: 'running', settled: false,
    createdAt: new Date(1740000000000 + index * 1000).toISOString(),
    input: { task: 'Chat ' + index }, nodes: {}, workflow: { nodes: [] },
  }));
  const start = performance.now(), result = conversationSummaries(runs);
  assert.equal(result.length, runs.length);
  assert.equal(result[0].id, runs.at(-1).id);
  assert.equal(result.at(-1).id, runs[0].id);
  assert.ok(performance.now() - start < 3000, 'Summarizing 2,500 chats must remain responsive on a normal desktop.');
});

test('Fast app defaults apply only to advertised new native chats and preserve explicit saved choices', () => {
  const status = { defaultModel: 'luna', runtimeSettings: { defaultServiceTier: 'fast' }, models: [{ id: 'luna', serviceTiers: [{ id: 'fast' }] }, { id: 'standard' }, { id: 'free::model', providerId: 'free', serviceTiers: [{ id: 'fast' }] }] };
  assert.equal(selectedConversationServiceTier({}, undefined, undefined, status), 'fast');
  for (const model of ['standard', 'free::model', 'unknown']) {
    assert.equal(selectedConversationServiceTier({ model }, undefined, undefined, status), undefined, 'An unsupported global default leaves the new request Standard.');
    assert.equal(selectedConversationServiceTier({ model, serviceTier: 'fast' }, undefined, undefined, status), 'fast', 'An authored unsupported Fast choice remains visible for correction.');
  }
  assert.equal(selectedConversationServiceTier({}, undefined, { id: 'legacy' }, status), undefined);
  assert.equal(selectedConversationServiceTier({}, { serviceTier: 'fast' }, { id: 'saved' }, status), 'fast');
  assert.equal(selectedConversationServiceTier({ serviceTier: 'default' }, { serviceTier: 'fast' }, { id: 'saved' }, status), 'default');
  assert.equal(selectedConversationServiceTier({}, undefined, undefined, status, 'free::model'), undefined, 'The actual preference-selected model controls capability.');
});

test('Maximal preview uses actual model metadata while retaining explicit and inherited reasoning intent', () => {
  const status = { defaultModel: 'wide', runtimeSettings: { defaultEffort: 'medium' }, models: [{ id: 'wide', supportedReasoningEfforts: ['low', 'high', 'ultra'] }, { id: 'narrow', supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }] }] };
  const chosen = draft => conversationReasoningChoice({ draft, status });
  assert.deepEqual(chosen({ planningMode: 'maximal' }), { effort: 'ultra', source: 'maximal-model-catalog', requestedEffort: null });
  assert.equal(chosen({ planningMode: 'maximal', model: 'narrow' }).effort, 'low');
  assert.equal(chosen({ planningMode: 'maximal', effort: 'high' }).effort, 'high');
  assert.equal(chosen({ planningMode: 'maximal', effort: 'default' }).effort, 'ultra');
  const agent = { id: 'agent', model: 'wide', effort: 'ultra' }, run = { planningMode: 'maximal', nodes: { agent: { effortSelection: { effort: 'ultra', source: 'maximal-model-catalog', requestedEffort: null } } } };
  assert.equal(conversationReasoningChoice({ draft: { planningMode: 'off' }, agent, run, status }).effort, 'medium');
  assert.equal(conversationReasoningChoice({ draft: { model: 'narrow' }, agent, run, status }).effort, 'low');
  agent.effort = 'medium'; run.planningMode = 'auto'; run.nodes.agent.effortSelection = { effort: 'medium', source: 'application-default', requestedEffort: null };
  assert.equal(conversationReasoningChoice({ draft: { planningMode: 'maximal' }, agent, run, status }).effort, 'ultra');
});

test('Maximal preview keeps the saved model and effort before the next turn is steerable', () => {
  const status = { defaultModel: 'wide', models: [{ id: 'wide', supportedReasoningEfforts: ['high', 'ultra'] }, { id: 'narrow', supportedReasoningEfforts: ['low', 'max'] }] };
  for (const state of [{ status: 'queued' }, { status: 'running' }, { status: 'running', threadId: 'thread' }, { status: 'running', threadId: 'thread', turnId: 'turn' }, { status: 'completed', threadId: 'thread', turnId: 'turn' }]) {
    const run = { planningMode: 'maximal', workflow: { nodes: [{ id: 'agent', type: 'agent', model: 'narrow', effort: 'max' }] }, nodes: { agent: { ...state, effortSelection: { effort: 'max', source: 'maximal-model-catalog', requestedEffort: null } } } };
    const agent = conversationAgents(run, state.status === 'completed' ? 'continue' : 'steer')[0];
    const displayedModel = selectedConversationModel({}, {}, agent || run.workflow.nodes.find(node => node.type === 'agent'));
    assert.equal(displayedModel, 'narrow');
    assert.equal(conversationReasoningChoice({ run, agent, status }).effort, 'max');
  }
});

test('the four planning modes have one validated vocabulary and Auto is the display fallback', () => {
  assert.deepEqual(PLANNING_MODES, ['maximal', 'on', 'auto', 'off']); assert.equal(normalizePlanningMode(undefined), 'auto'); assert.equal(normalizePlanningMode('MAXIMAL'), 'auto');
  for (const mode of PLANNING_MODES) assert.equal(normalizePlanningMode(mode), mode);
  assert.equal(planningModeDetail('maximal', 'compact'), 'detailed'); assert.equal(planningModeDetail('auto'), undefined);
});

test('planning mode follows an explicit draft, admitted run, workflow and preference without confusing depth or reasoning', () => {
  assert.equal(selectedConversationPlanningMode(), 'auto'); assert.equal(selectedConversationPlanningMode({}, { planningMode: 'off' }), 'off');
  assert.equal(selectedConversationPlanningMode({}, { planningMode: 'off' }, { workflow: { settings: { planningMode: 'on' } } }), 'on');
  assert.equal(selectedConversationPlanningMode({}, {}, { planningMode: 'maximal', workflow: { settings: { planningMode: 'on' } } }), 'maximal');
  assert.equal(selectedConversationPlanningMode({ planningMode: 'off', planDetail: 'detailed', effort: 'ultra' }, {}, { planningMode: 'maximal' }), 'off');
  assert.equal(selectedConversationPlanningMode({}, {}, { nodes: { worker: { planning: { mode: 'on' } } } }), 'on');
});

test('Auto omits synthesized runtime depth while explicit legacy hints survive compatible requests', () => {
  assert.deepEqual(conversationPlanningConfig(), { planningMode: 'auto' });
  const run = { planningMode: 'maximal', planDetail: 'detailed', taskState: { plan: { detail: 'detailed' } } };
  assert.deepEqual(conversationPlanningConfig({ planningMode: 'auto' }, {}, run), { planningMode: 'auto' });
  assert.deepEqual(conversationPlanningConfig({}, {}, { planDetail: 'compact' }), { planningMode: 'auto', planDetail: 'compact' });
  assert.deepEqual(conversationPlanningConfig({ planDetail: 'compact', planningMode: 'maximal' }), { planningMode: 'maximal', planDetail: 'detailed' });
  assert.deepEqual(conversationPlanningConfig({ planDetail: 'detailed', planningMode: 'off' }), { planningMode: 'off' });
  assert.deepEqual(conversationPlanningConfig({ planningMode: 'auto' }, {}, { ...run, input: { planDetail: 'compact' } }), { planningMode: 'auto', planDetail: 'compact' });
});

test('draft restoration preserves exact modes and removes malformed values without mutating saved source', () => {
  const source = { planningMode: 'on', conversationDrafts: { new: { task: 'Task', planningMode: 'off', planDetail: 'compact' }, invalid: { planningMode: 'OFF' } } }, before = structuredClone(source), restored = restoreConversationDrafts(source);
  assert.equal(restored.prefs.planningMode, 'on'); assert.equal(restored.drafts.new.planningMode, 'off'); assert.equal(restored.drafts.new.planDetail, 'compact'); assert.equal(restored.drafts.invalid.planningMode, undefined); assert.deepEqual(source, before);
});

test('plan detail follows explicit draft, saved task, workflow, saved plan and preference before its balanced default', () => {
  assert.equal(selectedConversationPlanDetail(), 'balanced');
  assert.equal(selectedConversationPlanDetail({}, { planDetail: 'compact' }), 'compact');
  assert.equal(selectedConversationPlanDetail({}, { planDetail: 'compact' }, { taskState: { plan: { detail: 'detailed' } } }), 'detailed');
  assert.equal(selectedConversationPlanDetail({}, {}, { workflow: { settings: { planDetail: 'compact' } }, taskState: { plan: { detail: 'detailed' } } }), 'compact');
  assert.equal(selectedConversationPlanDetail({}, {}, { planDetail: 'balanced', workflow: { settings: { planDetail: 'detailed' } } }), 'balanced');
  assert.equal(selectedConversationPlanDetail({ planDetail: 'detailed', effort: 'low' }, { planDetail: 'compact' }, { planDetail: 'balanced' }), 'detailed');
  assert.equal(selectedConversationPlanDetail({ planDetail: 'invalid' }, { planDetail: 'ultra' }, { planDetail: null, workflow: { settings: { planDetail: [] } } }), 'balanced');
});

test('draft restoration validates plan detail and retains independent reasoning settings', () => {
  const source = { modelPreferenceVersion: 2, planDetail: 'compact', conversationDrafts: { new: { task: 'Task', attachmentIds: [], planDetail: 'detailed', effort: 'ultra' }, invalid: { task: 'Other', planDetail: 'max' } } };
  const restored = restoreConversationDrafts(source); assert.equal(restored.prefs.planDetail, 'compact'); assert.equal(restored.drafts.new.planDetail, 'detailed'); assert.equal(restored.drafts.new.effort, 'ultra'); assert.equal(restored.drafts.invalid.planDetail, undefined); assert.equal(source.conversationDrafts.invalid.planDetail, 'max');
  assert.equal(restoreConversationDrafts({ planDetail: 'unrecognized' }).prefs.planDetail, undefined);
});

test('time-limit failures offer the matching settings while transient service failures leave Retry available',()=>{
  for(const code of ['CODEX_RUN_TIMEOUT','PROVIDER_TIMEOUT','PROVIDER_IDLE_TIMEOUT']){
    assert.deepEqual(conversationRecovery({status:'failed',errorCode:code}),{action:'run-limits',label:'Time limits'});
    assert.deepEqual(conversationRecovery({status:'failed',nodes:{worker:{errorCode:code}}}),{action:'run-limits',label:'Time limits'});
    for(const status of ['running','cancelled','completed'])assert.equal(conversationRecovery({status,errorCode:code}),null);
  }
  for(const code of ['PROVIDER_MODEL','PROVIDER_PROTOCOL'])assert.deepEqual(conversationRecovery({status:'failed',errorCode:code}),{action:'connections',label:'Models'});
  for(const code of ['PROVIDER_NETWORK','PROVIDER_RATE_LIMIT','PROVIDER_SERVICE'])assert.equal(conversationRecovery({status:'failed',errorCode:code}),null);
});

test('a newer catalog turn stays selectable when only an older transcript is cached, while actual newer and same-turn updates win', () => {
  const old = { id: 'old-turn', taskId: 'chat', createdAt: '2026-10-16T10:00:00Z', status: 'completed', input: 'Original title' };
  const summaries = { active: [{ taskId: 'chat', runId: 'latest-turn', createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T11:00:00Z', title: 'Saved chat title', status: 'failed' }] };
  let item = conversationSidebarItems({ summaries, runs: [old] })[0]; assert.equal(item.runId, 'latest-turn'); assert.equal(item.status, 'failed'); assert.equal(item.title, 'Saved chat title');
  const latest = { ...old, id: 'latest-turn', createdAt: '2026-10-17T10:00:00Z', status: 'running' };
  item = conversationSidebarItems({ summaries, runs: [old, latest] })[0]; assert.equal(item.runId, 'latest-turn'); assert.equal(item.status, 'running', 'the same loaded turn supplies fresh live status');
  latest.status = 'completed'; const newer = { ...old, id: 'newer-turn', createdAt: '2026-10-17T10:30:00Z', status: 'running' };
  item = conversationSidebarItems({ summaries, runs: [old, latest, newer] })[0]; assert.equal(item.runId, 'newer-turn'); assert.equal(item.status, 'running', 'compare turn creation, not the older turn’s later bookkeeping timestamp');
});
const graph = { nodes: [{ id: 'agent', type: 'agent', name: 'Relay agent' }] };
const event = data => ({ type: 'agent.event', nodeId: 'agent', data });

test('registered artifact paths resolve Windows forms, encoded spaces and paths relative to the actual working folder', () => {
  const run = { id: 'turn-2', taskId: 'task-1', cwd: 'C:\\Relay Work\\project', taskState: { taskId: 'task-1', artifacts: [{ id: 'artifact_svg', path: 'C:\\Relay Work\\project\\assets\\status (final).svg' }, { id: 'artifact_parent', path: 'C:\\Relay Work\\report.txt' }] } };
  const resolve = createRegisteredArtifactResolver(run), expected = { taskId: 'task-1', artifactId: 'artifact_svg' };
  for (const target of ['C:\\Relay Work\\project\\assets\\status (final).svg', '/C:/Relay%20Work/project/assets/status%20(final).svg', 'c:/relay work/PROJECT/assets/status (final).svg', './assets/status (final).svg', 'assets/./status%20(final).svg']) assert.deepEqual(resolve(target), expected);
  assert.deepEqual(resolve('../report.txt'), { taskId: 'task-1', artifactId: 'artifact_parent' });
  for (const target of ['assets/unregistered.svg', '/C:/Relay Work/project/assets/status (final).svg.exe', 'C:assets/status.svg', 'https://example.com/status.svg', 'file:///C:/Relay%20Work/project/assets/status%20(final).svg', 'javascript:alert(1)', '%zz', 'assets/%00status.svg', '../../../../status.svg']) assert.equal(resolve(target), null, target);
});

test('artifact resolution is exact, case sensitive on POSIX, and rejects invalid or ambiguous registrations', () => {
  const run = { id: 'posix-task', cwd: '/workspace/game', taskState: { artifacts: [{ id: 'svg-one', path: '/workspace/game/status.svg' }, { id: 'outside', path: '/workspace/report.txt' }, { id: 'bad" onclick="x', path: '/workspace/game/bad.svg' }] } };
  const resolve = createRegisteredArtifactResolver(run);
  assert.deepEqual(resolve('status.svg'), { taskId: 'posix-task', artifactId: 'svg-one' });
  assert.deepEqual(resolve('../report.txt'), { taskId: 'posix-task', artifactId: 'outside' });
  for (const target of ['Status.svg', '/workspace/game/status.svg#fragment', '/workspace/game/status.svg?download', 'bad.svg', '/workspace/game/secrets.txt']) assert.equal(resolve(target), null);
  assert.equal(createRegisteredArtifactResolver({ ...run, taskState: { ...run.taskState, taskId: '../bad' } })('status.svg'), null);
  assert.equal(createRegisteredArtifactResolver({ ...run, taskState: { artifacts: [...run.taskState.artifacts, { id: 'svg-two', path: '/workspace/game/status.svg' }] } })('status.svg'), null);
  assert.equal(createRegisteredArtifactResolver({ cwd: '/workspace/game' })('status.svg'), null);
  run.taskState.artifacts.length = 0; assert.deepEqual(resolve('status.svg'), { taskId: 'posix-task', artifactId: 'svg-one' }, 'the resolver captures the registered receipt');
});
test('all family turns are retained oldest-first across continuations, retries and shared task identity', () => {
  const runs = [{ id: 'first', taskId: 'task', input: 'Original', createdAt: '2026-01-01' }, { id: 'second', parentRunId: 'first', taskId: 'task', input: 'Follow up', createdAt: '2026-01-02' }, { id: 'third', parentRunId: 'second', retryOf: 'second', taskId: 'task', input: 'Follow up', createdAt: '2026-01-03' }, { id: 'unrelated', input: 'Other task', createdAt: '2026-01-04' }];
  assert.deepEqual(conversationRuns(runs, runs[1]).map(run => run.id), ['first', 'second', 'third']); assert.equal(conversationId(runs[2], runs), 'task'); assert.equal(conversationTurn(runs[2], runs).userText, '');
  assert.equal(conversationSummaries(runs).length, 2); assert.equal(conversationSummaries(runs)[1].title, 'Original');
});
test('legacy parent links group without task IDs and cycles terminate', () => {
  const runs = [{ id: 'a', input: 'First' }, { id: 'b', parentRunId: 'a' }, { id: 'c', parentRunId: 'b' }]; assert.equal(conversationId(runs[2], runs), 'a'); assert.equal(conversationRuns(runs, runs[2]).length, 3);
  assert.ok(conversationId({ id: 'a', parentRunId: 'b' }, [{ id: 'b', parentRunId: 'a' }, { id: 'a', parentRunId: 'b' }]));
});
test('real deltas reconcile with completed message snapshots without duplicate assistant text', () => {
  const run = { workflow: graph, nodes: { agent: { status: 'completed', output: 'Hello world' } }, events: [event({ type: 'delta', itemId: 'message-1', delta: 'Hello ' }), event({ type: 'delta', itemId: 'message-1', delta: 'world' }), event({ type: 'message', itemId: 'message-1', text: 'Hello world', phase: 'final_answer' }), event({ type: 'item', item: { type: 'agentMessage', id: 'message-1', text: 'Hello world', phase: 'final_answer' } })] };
  const messages = assistantMessages(run); assert.equal(messages.length, 1); assert.equal(messages[0].text, 'Hello world');
});
test('protocol data, internal user messages and tool JSON never appear as chat content', () => {
  const messages = assistantMessages({ workflow: graph, nodes: {}, events: [event({ type: 'protocol', message: 'Internal event' }), event({ type: 'item', item: { type: 'userMessage', text: 'Internal system prompt' } }), event({ type: 'item', item: { type: 'dynamicToolCall', result: { text: 'Private tool JSON' } } })] }); assert.deepEqual(messages, []);
});
test('provider text boundaries and accepted human directions remain separate real messages', () => {
  const messages = assistantMessages({ workflow: graph, nodes: { agent: { status: 'completed', output: 'Result' } }, events: [event({ type: 'delta', delta: 'Looking into it.' }), event({ type: 'item', item: { type: 'dynamicToolCall', name: 'read' } }), event({ type: 'steer', accepted: true, text: 'Use the smaller option', delivery: 'queued' }), event({ type: 'delta', delta: 'Result' })] });
  assert.deepEqual(messages.map(message => [message.role, message.text]), [['assistant', 'Looking into it.'], ['user', 'Use the smaller option'], ['assistant', 'Result']]);
});
test('actual accumulated output restores a stream prefix lost from bounded events; no fake reply is generated', () => {
  const messages = assistantMessages({ workflow: graph, nodes: { agent: { status: 'running', output: 'Complete real streamed text' } }, events: [event({ type: 'delta', itemId: 'm', delta: 'streamed text' })] }); assert.equal(messages.length, 1); assert.equal(messages[0].text, 'Complete real streamed text'); assert.deepEqual(assistantMessages({ workflow: graph, nodes: {}, status: 'running' }), []);
});
test('archived outputs remain readable and reused nodes do not replay prior assistant messages', () => {
  assert.equal(assistantMessages({ workflow: graph, nodes: { agent: { status: 'completed', output: 'Saved answer' } } })[0].text, 'Saved answer');
  assert.equal(assistantMessages({ workflow: graph, nodes: { agent: { status: 'completed', output: 'Old answer', reused: true } } }).length, 0);
});
test('newest currentRun overrides a stale list snapshot and retains full cached event history if omitted', () => {
  const runs = mergeConversationRuns([{ id: 'one', events: [event({ type: 'delta', delta: 'Hi' })], nodes: { agent: { output: 'old' } } }], [{ id: 'one', status: 'running' }], [{ id: 'one', nodes: { agent: { output: 'live' } } }]); assert.equal(runs[0].nodes.agent.output, 'live'); assert.equal(runs[0].events.length, 1);
});
test('continuation and live-direction choices require an actual saved thread and a live turn respectively', () => {
  const run = { workflow: { nodes: [{ id: 'done', type: 'agent' }, { id: 'failed', type: 'agent' }, { id: 'live', type: 'agent' }] }, nodes: { done: { status: 'completed', threadId: 'one' }, failed: { status: 'failed', threadId: 'two' }, live: { status: 'running', threadId: 'three', turnId: 'turn' } } };
  assert.deepEqual(conversationAgents(run).map(node => node.id), ['failed', 'done']); assert.deepEqual(conversationAgents(run, 'steer').map(node => node.id), ['live']);
});
test('durable messages and directions survive a bounded live ring while newer node state wins', () => {
  const receipt = (at, data) => ({ ...event(data), at });
  const early = receipt('2026-10-16T12:00:01Z', { type: 'message', itemId: 'early', text: 'Earlier progress.' });
  const direction = receipt('2026-10-16T12:00:02Z', { type: 'steer', accepted: true, text: 'Use the revised brief.' });
  const final = receipt('2026-10-16T12:00:04Z', { type: 'message', itemId: 'final', text: 'Final answer.', phase: 'final_answer' });
  const cached = { id: 'run', workflow: graph, nodes: { agent: { threadId: 'saved-thread', status: 'running' } }, events: [early, direction, final] };
  const live = { id: 'run', nodes: { agent: { status: 'completed', output: 'Final answer.' } }, events: [...Array.from({ length: 2500 }, (_, index) => receipt('2026-10-16T12:00:03Z', { type: 'item', item: { type: 'commandExecution', id: `tool-${index}` } })), receipt(final.at, { type: 'delta', itemId: 'final', delta: 'Final answer.' }), final] };
  const merged = mergeConversationRuns([cached], [live])[0];
  assert.deepEqual(assistantMessages(merged).map(message => message.text), ['Earlier progress.', 'Use the revised brief.', 'Final answer.']);
  assert.equal(merged.nodes.agent.threadId, 'saved-thread'); assert.equal(merged.nodes.agent.status, 'completed');
  assert.equal(merged.events.filter(value => value.data.itemId === 'final').length, 1); assert.equal(merged.events.filter(value => value.data.item?.type === 'commandExecution').length, 2500);
  assert.deepEqual(assistantMessages(mergeConversationRuns([merged], [live])[0]), assistantMessages(merged));
});
test('Enter sends conventionally while multiline and IME composition retain their keystrokes', () => {
  assert.equal(shouldSendConversationKey({ key: 'Enter' }), true); assert.equal(shouldSendConversationKey({ key: 'Enter', ctrlKey: true }), true);
  for (const modifier of [{ shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) assert.equal(shouldSendConversationKey({ key: 'Enter', ...modifier }), false);
  assert.equal(shouldSendConversationKey({ key: 'a' }), false);
});
test('a conversation model change survives draft persistence and takes precedence over its saved agent', () => {
  const preferences = { model: 'codex-model' }, agent = { model: 'original::model' }, saved = JSON.parse(JSON.stringify({ model: 'different::model', task: 'Follow up' }));
  assert.equal(selectedConversationModel(saved, preferences, agent), 'different::model');
  assert.equal(selectedConversationModel({}, preferences, agent), 'original::model');
  assert.equal(selectedConversationModel({}, preferences), 'codex-model');
  assert.equal(selectedConversationModel({ model: 'default' }, preferences, agent), 'default');
  assert.equal(selectedConversationModel(), 'default');
});

test('existing chats retain the model actually used when the app default changes', () => {
  const run = { workflow: { nodes: [{ id: 'agent', type: 'agent', model: 'default' }] }, nodes: { agent: { threadId: 'real-thread', status: 'completed', resolvedModel: 'original::model' } } };
  const agent = conversationAgents(run)[0];
  assert.equal(selectedConversationModel({}, { model: 'new::default' }, agent), 'original::model');
  assert.equal(selectedConversationModel({ model: 'default' }, {}, agent), 'default');
  assert.equal(run.workflow.nodes[0].resolvedModel, undefined, 'display never mutates the saved workflow');
});

test('upgrading model preferences keeps unsent choices but resets the new-chat fallback', () => {
  const saved = { model: 'old::model', cwd: 'C:\\project', conversationDrafts: { new: { task: 'Unsent work', attachmentIds: ['file'] }, root: { model: 'chat::model', task: 'Follow up' } } };
  const restored = restoreConversationDrafts(saved);
  assert.equal(restored.prefs.model, 'default'); assert.equal(restored.drafts.new.model, 'old::model');
  assert.equal(restored.drafts.root.model, 'chat::model'); assert.equal(restored.prefs.cwd, saved.cwd);
  assert.equal(saved.conversationDrafts.new.model, undefined);
  assert.equal(restoreConversationDrafts({ ...saved, conversationDrafts: { new: { task: '', attachmentIds: [] } } }).drafts.new.model, undefined);
  assert.equal(restoreConversationDrafts({ ...saved, modelPreferenceVersion: 2 }).drafts.new.model, undefined);
});

test('only genuinely flat legacy drafts migrate top-level text and files into New chat', () => {
  const flat = { task: 'A legacy unsent task', attachmentIds: ['legacy-file'], model: 'legacy::model' };
  const legacy = restoreConversationDrafts(flat); assert.equal(legacy.drafts.new.task, flat.task); assert.deepEqual(legacy.drafts.new.attachmentIds, flat.attachmentIds); assert.equal(legacy.drafts.new.model, flat.model);
  for (const conversationDrafts of [{ existing: { task: 'Keep my reply', attachmentIds: ['chat-file'] } }, {}, null, [], { new: null }, { new: [] }]) {
    const restored = restoreConversationDrafts({ ...flat, conversationDrafts });
    assert.deepEqual(restored.drafts.new, { task: '', attachmentIds: [] }, 'selected-chat mirror fields never become a new task');
  }
  const modern = restoreConversationDrafts({ ...flat, conversationDrafts: { new: { task: 'A deliberate separate task', attachmentIds: ['new-file'] } }, modelPreferenceVersion: 2 });
  assert.deepEqual(modern.drafts.new, { task: 'A deliberate separate task', attachmentIds: ['new-file'] });
});

test('chat search finds old archived titles, respects Trash, normalizes accents and bounds results', () => {
  const summaries = { active: [{ id: 'one', title: 'Café launch', updatedAt: '2026-01-01' }, { id: 'two', title: 'Launch checklist', updatedAt: '2026-02-01' }], archived: [{ id: 'three', title: 'Café launch retrospective' }], deleted: [{ id: 'four', title: 'Café launch draft' }] };
  assert.deepEqual(searchConversations({ summaries, query: 'CAFE launch' }).map(item => item.id), ['one', 'three']);
  assert.equal(searchConversations({ summaries, query: 'launch', limit: 1 }).length, 1);
  assert.deepEqual(searchConversations({ summaries, query: 'cafe', state: 'deleted' }).map(item => item.id), ['four']);
  assert.deepEqual(searchConversations({ summaries, query: 'missing' }), []);
  assert.deepEqual(searchConversations({ summaries, limit: 0 }), []);
});
test('archive and Trash metadata keep stale recent runs out of Chats without losing restored history', () => {
  const runs = [{ id: 'root', input: 'Original title', createdAt: '2026-01-01', status: 'completed' }, { id: 'next', taskId: 'root', parentRunId: 'root', input: 'Follow up', createdAt: '2026-01-02', status: 'completed' }, { id: 'other', input: 'A visible chat', createdAt: '2026-01-03', status: 'completed' }];
  const entry = { id: 'next', latestRunId: 'next', taskId: 'root', title: 'Original title' }, summaries = { active: [], archived: [entry], deleted: [] };
  assert.deepEqual(conversationSidebarItems({ summaries, runs }).map(item => item.id), ['other']);
  const archived = conversationSidebarItems({ summaries, runs, state: 'archived' }); assert.equal(archived.length, 1); assert.equal(archived[0].runId, 'next'); assert.equal(archived[0].title, 'Original title');
  summaries.archived = []; summaries.deleted = [entry]; assert.deepEqual(conversationSidebarItems({ summaries, runs, state: 'archived' }), []); assert.equal(conversationSidebarItems({ summaries, runs, state: 'deleted' }).length, 1); assert.equal(conversationSidebarItems({ summaries, runs }).length, 1);
  summaries.deleted = []; summaries.active = [entry]; assert.equal(conversationSidebarItems({ summaries, runs }).length, 2); assert.equal(conversationSidebarItems({ summaries, runs }).find(item => item.id === 'root').runId, 'next');
});

test('failed provider setup errors expose Models without redirecting unrelated failures or cancellations',()=>{for(const code of ['PROVIDER_AUTH','PROVIDER_QUOTA','PROVIDER_ACCESS','PROVIDER_ENDPOINT','INVALID_DEFAULT_MODEL','CONTEXT_OVERFLOW'])assert.deepEqual(conversationRecovery({status:'failed',errorCode:code}),{action:'connections',label:'Models'});assert.deepEqual(conversationRecovery({status:'failed',nodes:{agent:{errorCode:'PROVIDER_AUTH'}}}),{action:'connections',label:'Models'});assert.deepEqual(conversationRecovery({status:'failed',error:'API key rejected'}),{action:'connections',label:'Models'});for(const status of ['running','cancelled','completed'])assert.equal(conversationRecovery({status,errorCode:'PROVIDER_AUTH'}),null);for(const code of ['PROVIDER_RATE_LIMIT','PROVIDER_NETWORK','PROVIDER_SERVICE','TOOL_FAILED'])assert.equal(conversationRecovery({status:'failed',errorCode:code}),null);});

test('chat context and reasoning inheritance preserve explicit model defaults and normalize only invalid local drafts',()=>{
  const preferences={context:{preset:'900k'}},agent={context:{preset:'custom',windowTokens:128000},effort:'medium'},run={workflow:{settings:{context:{preset:'custom',windowTokens:64000}}}};
  assert.deepEqual(selectedConversationContext({},preferences,agent,run),agent.context);assert.deepEqual(selectedConversationContext({},preferences,{},run),run.workflow.settings.context);assert.deepEqual(selectedConversationContext({},preferences),preferences.context);assert.deepEqual(selectedConversationContext({context:{preset:'model'}},preferences,agent,run),{preset:'model'});
  assert.equal(selectedConversationEffort({},agent),'medium');assert.equal(selectedConversationEffort({effort:'default'},agent),'default');assert.equal(selectedConversationEffort({effort:'ultra'},agent),'ultra');assert.equal(selectedConversationEffort({},{}),'default');
  const saved={conversationDrafts:{new:{task:'Task',effort:'max',context:{preset:'900k'}},old:{task:'Reply',effort:'invalid',context:[]},legacy:{task:'Reply'}}},restored=restoreConversationDrafts(saved);
  assert.equal(restored.drafts.new.effort,'max');assert.deepEqual(restored.drafts.new.context,{preset:'900k'});assert.equal(restored.drafts.old.effort,undefined);assert.equal(restored.drafts.old.context,undefined);assert.equal(restored.drafts.legacy.effort,undefined);assert.equal(saved.conversationDrafts.old.effort,'invalid');restored.drafts.new.context.preset='model';assert.equal(saved.conversationDrafts.new.context.preset,'900k');
});

test('cached conversation history and current snapshots reconcile milestone revisions independently of response timestamps', () => {
  const saved = { taskId: 'root', revision: 7, steps: [{ id: 'check', title: 'Verify the result', status: 'active' }] };
  const cached = { id: 'followup', taskId: 'root', parentRunId: 'root', taskState: saved, status: 'completed', settled: true, updatedAt: '2026-10-16T12:00:01Z', workflow: graph, events: [event({ type: 'message', itemId: 'saved-message', text: 'Actual saved reply.' })] };
  const snapshot = { ...cached, taskState: { ...saved, revision: 6 }, updatedAt: '2026-10-16T12:00:03Z', nodes: { agent: { status: 'completed', output: 'Actual latest reply.' } }, events: [] };
  const merged = mergeConversationRuns([cached], [snapshot])[0];
  assert.strictEqual(merged.taskState, saved); assert.equal(merged.updatedAt, snapshot.updatedAt); assert.equal(merged.status, 'completed'); assert.equal(merged.nodes.agent.output, 'Actual latest reply.'); assert.equal(merged.events[0].data.text, 'Actual saved reply.');
  const latest = { ...saved, revision: 8, steps: [{ id: 'check', title: 'Verified result', status: 'done' }] };
  const next = mergeConversationRuns([merged], [{ id: cached.id, taskId: 'root', taskState: latest }])[0];
  assert.strictEqual(next.taskState, latest); assert.equal(next.nodes.agent.output, 'Actual latest reply.'); assert.equal(next.status, 'completed'); assert.strictEqual(cached.taskState, saved);
});

test('history merging rejects foreign or malformed milestone records without dropping matching saved work', () => {
  const valid = { taskId: 'root', revision: 3, steps: [] }, run = { id: 'followup', taskId: 'root', taskState: valid };
  for (const invalid of [{ taskId: 'other', revision: 100 }, { revision: 4 }, { taskId: 'root', revision: 0 }, { taskId: 'root', revision: '4' }, { taskId: 'root', revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(mergeConversationRuns([{ ...run, taskState: invalid }])[0].taskState, undefined);
    assert.strictEqual(mergeConversationRuns([run], [{ ...run, taskState: invalid }])[0].taskState, valid);
    assert.strictEqual(mergeConversationRuns([{ ...run, taskState: invalid }], [run])[0].taskState, valid);
  }
  const sameRevision = { ...valid, steps: [{ title: 'Uncommitted conflicting contents' }] };
  assert.strictEqual(mergeConversationRuns([run], [{ ...run, taskState: sameRevision }])[0].taskState, valid);
  assert.strictEqual(mergeConversationRuns([run], [{ id: run.id, status: 'completed' }])[0].taskState, valid);
});

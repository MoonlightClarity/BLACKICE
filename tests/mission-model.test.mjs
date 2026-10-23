import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFailure, missionModels, recentMissions, missionProgress, createMissionWorkflow, selectMissionRun, latestMissionActivity, missionDesktopPreference } from '../public/mission-model.mjs';
import { validateWorkflow } from '../lib/engine.mjs';

test('model choices preserve actual provider IDs and distinguish connection availability', () => {
  const models = missionModels({ codex: { connected: false, authenticated: false }, models: [{ id: 'gpt-real', displayName: 'Codex model' }, { id: 'local::custom-model', displayName: 'Local · Custom model', available: true, providerId: 'local' }] });
  assert.equal(models.find(model => model.value === 'default').available, false);
  assert.equal(models.find(model => model.value === 'local::custom-model').available, true);
  assert.equal(models.some(model => model.value === 'invented'), false);
});
test('custom native models remain exact selectable Chat and workflow choices while access evidence stays informational', () => {
  const id = 'Vendor/Explicit.Model:preview', snapshot = { defaultModel: id, defaultModelAvailable: true, codex: { connected: true, authenticated: true }, models: [{ id, model: id, source: 'custom', access: { state: 'failed', outcome: 'failed' } }] };
  const choices = missionModels(snapshot, id); assert.deepEqual(choices.map(choice => choice.value), ['default', id]);
  assert.equal(choices[0].source, 'custom'); assert.equal(choices[1].source, 'custom'); assert.equal(choices[1].access.state, 'failed'); assert.equal(choices[1].available, true, 'connection readiness permits a new request without promising access');
  assert.match(choices[1].label, /Custom model ID/); choices[1].access.state = 'accepted'; assert.equal(snapshot.models[0].access.state, 'failed');
  const workflow = validateWorkflow(createMissionWorkflow({ id: 'custom_native', task: 'Use the explicit native model.', model: id })); assert.equal(workflow.nodes[1].model, id);
  snapshot.codex.authenticated = false; assert.equal(missionModels(snapshot, id)[1].available, false);
  assert.equal(missionModels({ codex: { connected: true, authenticated: true }, models: [] })[0].available, false, 'no default ID means no inferred native readiness');
});
test('documented candidates require explicit registration and retain lifecycle in Chat, defaults and workflow choices', () => {
  const id = 'gpt-5.3-codex-spark', candidate = { id, model: id, displayName: 'Spark', source: 'documented', lifecycle: { state: 'retired', date: '2026-09-14' }, access: { state: 'accepted' } };
  const snapshot = { defaultModel: 'other', defaultModelAvailable: true, codex: { connected: true, authenticated: true }, models: [{ id: 'other' }], codexModelCandidates: [candidate] };
  assert.equal(missionModels(snapshot).some(model => model.value === id), false, 'a successful discovery check does not register a saved model choice');
  snapshot.models.push({ ...candidate, source: 'custom' }); snapshot.defaultModel = id;
  const options = missionModels(snapshot, id), option = options.find(model => model.value === id);
  assert.equal(option.available, true); assert.equal(option.access.state, 'accepted'); assert.equal(option.lifecycle.state, 'retired'); assert.match(option.label, /Retired 2026-09-14/); assert.match(options[0].label, /Retired/);
  assert.equal(validateWorkflow(createMissionWorkflow({ id: 'candidate_workflow', task: 'Use my explicit choice.', model: option.value })).nodes[1].model, id);
  option.lifecycle.state = 'current'; assert.equal(snapshot.models[1].lifecycle.state, 'retired', 'the UI cannot mutate source lifecycle');
});
test('recent missions keep one latest continuation per conversation and retain the original task', () => {
  const runs = [{ id: 'first', input: 'Original task', createdAt: '2026-01-01' }, { id: 'follow', parentRunId: 'first', input: 'Refine it', createdAt: '2026-01-03' }, { id: 'second', input: 'Other task', createdAt: '2026-01-02' }];
  const recent = recentMissions(runs); assert.equal(recent.length, 2); assert.equal(recent[0].id, 'follow'); assert.equal(recent[0].originalTask, 'Original task');
});
test('progress reports measured steps and never manufactures an ETA or completion', () => {
  const progress = missionProgress({ status: 'running', nodes: { input: { status: 'completed' }, agent: { status: 'running' }, output: { status: 'queued' } }, workflow: { nodes: [{ id: 'agent', name: 'Researcher' }] } });
  assert.equal(progress.completed, 1); assert.equal(progress.total, 3); assert.equal(progress.title, 'Researcher is working.'); assert.equal(progress.active, true);
});
test('a terminal task status never claims work has stopped before its outstanding work settles', () => {
  const run = { status: 'cancelled', settled: false, nodes: { done: { status: 'completed' }, agent: { status: 'cancelled' } } };
  const stopping = missionProgress(run);
  assert.equal(stopping.title, 'Stopping this task.'); assert.match(stopping.detail, /Waiting for active work/); assert.equal(stopping.completed, 1); assert.equal(stopping.total, 2);
  run.status = 'failed'; run.error = 'The provider disconnected.';
  const finishing = missionProgress(run); assert.equal(finishing.phase, 'finishing'); assert.match(finishing.detail, /provider disconnected.*Waiting for active work/);
  run.status = 'cancelled'; run.settled = true; assert.equal(missionProgress(run).title, 'Task stopped.');
  delete run.settled; assert.equal(missionProgress(run).title, 'Stop requested.');
});
test('Mission creates a real valid graph while preserving selected model and desktop tools', () => {
  const workflow = createMissionWorkflow({ id: 'mission_test', task: 'Finish the task', model: 'local::actual', cwd: 'C:\\Projects', desktop: true });
  const checked = validateWorkflow(workflow); assert.equal(checked.nodes[1].model, 'local::actual'); assert.equal(checked.nodes[1].desktop, true); assert.equal(checked.settings.maxParallel, 1); assert.equal(checked.nodes.length, 3);
});

test('Mission preserves explicit Fast and Standard independently of max reasoning', () => {
  for (const serviceTier of ['fast', 'default']) {
    const checked = validateWorkflow(createMissionWorkflow({ id: `speed_${serviceTier}`, task: 'Use the chosen processing speed.', model: 'native', effort: 'max', serviceTier, planningMode: 'on' }));
    assert.equal(checked.nodes[1].serviceTier, serviceTier); assert.equal(checked.nodes[1].effort, 'max'); assert.equal(checked.settings.planningMode, 'on');
  }
  assert.equal(Object.hasOwn(createMissionWorkflow({ task: 'Legacy omitted speed' }).nodes[1], 'serviceTier'), false);
  assert.throws(() => createMissionWorkflow({ task: 'Invalid speed', serviceTier: 'priority' }), /Standard or Fast/);
});
test('Mission recipes persist the planning mode without embedding an unconditional plan mandate', () => {
  for (const planningMode of ['maximal', 'on', 'auto', 'off']) {
    const workflow = validateWorkflow(createMissionWorkflow({ id: `mode_${planningMode}`, task: 'Handle this request.', planningMode }));
    assert.equal(workflow.settings.planningMode, planningMode); assert.equal(workflow.settings.planDetail, undefined);
    assert.match(workflow.nodes[1].prompt, /Follow the selected planning mode/); assert.doesNotMatch(workflow.nodes[1].prompt, /Use the attached task tool to keep a visible plan/);
  }
  assert.equal(createMissionWorkflow({ task: 'Default mode' }).settings.planningMode, 'auto');
  assert.equal(createMissionWorkflow({ task: 'Legacy hint', planDetail: 'compact' }).settings.planDetail, 'compact');
  assert.throws(() => createMissionWorkflow({ task: 'Invalid mode', planningMode: 'OFF' }), /Choose Maximal/);
});
test('New task hides an old result while an actual running task always stays visible', () => {
  const completed = { id: 'done', status: 'completed' }, running = { id: 'active', status: 'running' };
  assert.equal(selectMissionRun({ runs: [completed], currentRun: completed }, { hideCompleted: true }), null);
  assert.equal(selectMissionRun({ runs: [running, completed], currentRun: completed }, { hideCompleted: true, selectedId: 'done' }), running);
  assert.equal(selectMissionRun({ runs: [completed], currentRun: completed }, { selectedId: 'done' }), completed);
});
test('latest action is readable and ignores repeated internal protocol and user prompts', () => {
  const events = [{ data: { type: 'item', item: { type: 'dynamicToolCall', tool: 'relay_browser', arguments: { action: 'read' }, status: 'completed' } } }, { data: { type: 'protocol', message: 'Internal metadata' } }, { data: { type: 'item', item: { type: 'userMessage', text: 'Internal prompt' } } }];
  assert.equal(latestMissionActivity({ events }), 'Browser · Read page content · done');
});
test('default model uses the actual catalog display name', () => {
  const models = missionModels({ codex: { connected: true, authenticated: true, defaultModel: 'actual-id' }, models: [{ id: 'actual-id', displayName: 'Readable model' }] });
  assert.equal(models[0].label, 'Default · Codex · Readable model');
});
test('native model aliases preserve the selected routing string and hidden catalog metadata without duplicate choices', () => {
  const entry = { id: 'picker-alias', model: 'actual-slug', displayName: 'Friendly model', available: true, hidden: true, inputModalities: ['text', 'image', null], availabilityNux: { message: 'An informational notice.', extra: 'Do not project this field.' } };
  const snapshot = { defaultModel: 'actual-slug', defaultModelAvailable: true, codex: { connected: true, authenticated: true }, models: [entry] };
  for (const selected of ['actual-slug', 'picker-alias']) {
    const models = missionModels(snapshot, selected);
    assert.deepEqual(models.map(model => model.value), ['default', selected]);
    assert.equal(models[0].label, 'Default · Codex · Friendly model · Hidden by Codex');
    assert.equal(models[1].label, 'Codex · Friendly model · Hidden by Codex');
    assert.equal(models[1].available, true, 'Codex visibility and informational notices do not deny a reported model');
    assert.equal(models[1].hidden, true);
    assert.deepEqual(models[1].inputModalities, ['text', 'image']);
    assert.deepEqual(models[1].availabilityNux, { message: 'An informational notice.' });
    models[1].inputModalities.push('changed'); models[1].availabilityNux.message = 'changed';
  }
  assert.deepEqual(entry.inputModalities, ['text', 'image', null]);
  assert.equal(entry.availabilityNux.message, 'An informational notice.');
});
test('cached native availability never overrides a disconnected account and remote metadata stays provider-specific', () => {
  const models = [{ id: 'hidden-native', available: true, hidden: true }, { id: 'api::model', providerId: 'api', available: true, hidden: true, availabilityNux: { message: 'API metadata' } }];
  for (const codex of [{ connected: false, authenticated: true }, { connected: true, authenticated: false }]) {
    const choices = missionModels({ codex, models });
    assert.equal(choices.find(choice => choice.value === 'hidden-native').available, false);
    const remote = choices.find(choice => choice.value === 'api::model');
    assert.equal(remote.available, true); assert.equal(Object.hasOwn(remote, 'hidden'), false);
    assert.doesNotMatch(remote.label, /Hidden by Codex/); assert.equal(Object.hasOwn(remote, 'availabilityNux'), false);
  }
});
test('a ready remote runtime default stays ready when Codex is offline without changing manual choices', () => {
  const models = missionModels({ defaultModel: 'local::real-model', codex: { connected: false, authenticated: false, defaultModel: 'codex-real' }, models: [{ id: 'codex-real', displayName: 'Codex model' }, { id: 'local::real-model', displayName: 'Local · Real model', providerId: 'local', available: true }] });
  assert.deepEqual(models[0], { value: 'default', label: 'Default · Local · Real model', available: true, error: '', provider: 'local' });
  assert.equal(models.find(model => model.value === 'codex-real').available, false);
  assert.equal(models.find(model => model.value === 'local::real-model').available, true);
});

test('an explicitly unavailable default is never reported ready because another model is connected', () => {
  const models = missionModels({ connected: true, authenticated: true, defaultModel: 'removed::model', defaultModelAvailable: false, defaultModelError: 'Reconnect the selected provider.', models: [{ id: 'codex-model', available: true }] });
  assert.equal(models[0].available, false); assert.equal(models[0].error, 'Reconnect the selected provider.');
  assert.equal(models[1].available, true);
});
test('new chats discover connected Windows tools while preserving a saved explicit choice', () => {
  const legacy = { desktop: false }, connected = { enabled: true, available: true };
  assert.equal(missionDesktopPreference(legacy, connected), true);
  assert.equal(missionDesktopPreference(legacy, { enabled: false, available: true }), false);
  assert.equal(missionDesktopPreference(legacy, { enabled: true, available: false }), false);
  assert.equal(missionDesktopPreference(legacy), false);
  const explicit = JSON.parse(JSON.stringify({ desktop: false, desktopConfigured: true }));
  assert.equal(missionDesktopPreference(explicit, connected), false);
  assert.equal(missionDesktopPreference({ desktop: true, desktopConfigured: true }, { enabled: false }), true);
  assert.equal(createMissionWorkflow({ task: 'Hello', id: 'plain' }).nodes[1].desktop, false, 'shared graph defaults remain explicit; only new conversation preferences auto-discover');
});

test('generation failures stay scoped to the selected provider and native Codex stays independent',()=>{const failure={code:'PROVIDER_AUTH',message:'Update key',at:'2026-10-16'},status={defaultModel:'one::model',providers:[{id:'one',lastFailure:failure},{id:'two',lastFailure:null}]};assert.deepEqual(modelFailure(status),failure);assert.equal(modelFailure(status,'two::model'),null);assert.equal(modelFailure(status,'gpt-real'),null);assert.equal(modelFailure({...status,defaultModel:'gpt-real'}),null);});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine, validateWorkflow } from '../lib/engine.mjs';
import { TaskInbox } from '../lib/inbox.mjs';
import { TaskStateStore, TASK_SCHEMA_VERSION, TASK_TOOL, taskToolForVersion } from '../lib/task-state.mjs';
import { MethodStore } from '../lib/methods.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { capabilityGuidance } from '../lib/tool-routing.mjs';

const wait = async check => {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Task outline fixture did not settle.');
};
const payload = response => JSON.parse(response.contentItems.find(item => item.type === 'inputText').text);
const call = (options, name, args, context) => options.onToolCall({ name, arguments: args }, context);
async function taskCall(options, args) {
  const response = await call(options, 'relay_task', args); assert.equal(response.success, true, response.contentItems?.[0]?.text); return payload(response);
}
const leaf = (id = 'answer', title = 'Answer the current question') => ({
  id, title, kind: 'action', parentId: null, status: 'active',
  result: 'The observed result and saved effects of the named fixture operation.',
  note: 'Perform the operation specified by this fixture, inspect its returned receipt and saved effects, and compare them with the corresponding assertions.',
  doneWhen: 'The requested result is present and its stated check was performed.',
});
async function savePlan(options, steps = [leaf()], plan = {}) {
  const state = await taskCall(options, { action: 'read' });
  return taskCall(options, { action: 'plan', expectedRevision: state.revision, steps, plan: { layout: 'sequence', taskType: 'general', ...plan } });
}
async function fixture(t, execute, { model = 'fixture-plan-model', threadId = 'native-plan-thread', supportsTools = true, workflowId = 'ordinary-plan-chat' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-engine-plan-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const methods = await new MethodStore({ dataDir: directory, projects: { definition() {}, create() {} } }).init();
  class Runtime extends EventEmitter {
    constructor() { super(); this.calls = []; }
    status() { return { connected: true, authenticated: true, defaultModel: model, models: [{ id: model, supportsTools }] }; }
    async runAgent(options) { this.calls.push(options); options.onEvent({ type: 'thread', threadId, model }); return execute(options, this.calls.length, context); }
    async close() {}
  }
  const runtime = new Runtime(), engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init(); engine.methods = methods;
  const workflow = createMissionWorkflow({ id: workflowId, task: 'Complete the requested work.', cwd }); workflow.nodes.find(node => node.type === 'agent').model = model;
  const context = { engine, tasks, runtime, methods, cwd, directory, workflow, threadId,
    start: (input = 'Complete this task.', extras = {}) => engine.startRun({ workflow, input, ...extras }),
    settled: id => wait(() => { const run = engine.getRun(id); return run.settled && run; }),
  };
  t.after(async () => { await engine.close(); await tasks.close(); await methods.close(); assert.match(path.basename(directory), /^blackice-engine-plan-/); await rm(directory, { recursive: true, force: true }); });
  return context;
}
const completed = run => assert.equal(run.status, 'completed', run.error || run.nodes.agent.error);
const answerEvents = run => run.events.filter(event => ['delta', 'message'].includes(event.data?.type) || event.data?.type === 'item' && ['agentMessage', 'exitedReviewMode'].includes(event.data.item?.type));

test('preplanning answer events are discarded and fresh answers follow the durable current-turn plan', async t => {
  const f = await fixture(t, async (options, number, context) => {
    const before = context.engine.listRuns()[0];
    options.onEvent({ type: 'delta', itemId: 'early', delta: 'Prepared ' });
    options.onEvent({ type: 'delta', itemId: 'early', delta: 'answer.' });
    options.onEvent({ type: 'message', itemId: 'early', text: 'Prepared answer.', phase: 'final_answer' });
    options.onEvent({ type: 'item', item: { type: 'agentMessage', id: 'early', text: 'Prepared answer.', phase: 'final_answer' }, stage: 'completed' });
    options.onEvent({ type: 'usage', usage: { totalTokens: 13 } });
    const waiting = context.engine.getRun(before.id);
    assert.equal(waiting.nodes.agent.output, ''); assert.equal(answerEvents(waiting).length, 0);
    assert.equal(waiting.nodes.agent.usage.totalTokens, 13, 'Measured usage remains live while preplanning text is withheld');
    const state = await savePlan(options);
    assert.equal((await context.tasks.get(before.taskId)).revision, state.revision, 'The plan is committed before new answer text can be published');
    const planned = context.engine.getRun(before.id);
    assert.equal(planned.nodes.agent.output, ''); assert.equal(answerEvents(planned).length, 0, 'A later plan must not release earlier deltas or complete messages');
    assert.equal(planned.nodes.agent.usage.totalTokens, 13);
    options.onEvent({ type: 'delta', itemId: 'current', delta: 'Current ' });
    options.onEvent({ type: 'delta', itemId: 'current', delta: 'answer.' });
    options.onEvent({ type: 'message', itemId: 'current', text: 'Current answer.', phase: 'final_answer' });
    options.onEvent({ type: 'item', item: { type: 'agentMessage', id: 'current', text: 'Current answer.', phase: 'final_answer' }, stage: 'completed' });
    const published = context.engine.getRun(before.id);
    assert.equal(published.nodes.agent.output, 'Current answer.'); assert.equal(answerEvents(published).length, 4);
    options.onEvent({ type: 'delta', itemId: 'later', delta: ' More detail.' });
    assert.equal(context.engine.getRun(before.id).nodes.agent.output, 'Current answer. More detail.', 'Fresh text streams normally after the plan');
    return { output: 'Current answer. More detail.', threadId: context.threadId };
  });
  const run = await f.settled(f.start().id); completed(run);
  assert.equal(run.nodes.agent.planning.status, 'recorded'); assert.equal(f.runtime.calls.length, 1);
  assert.equal(run.nodes.agent.output, 'Current answer. More detail.');
  assert.ok(answerEvents(run).every(event => (event.data.item?.id || event.data.itemId) !== 'early'));
  const planAt = run.events.findIndex(event => event.data?.type === 'task.state' && event.data.state.plan?.authoredBy?.runId === run.id);
  assert.ok(planAt >= 0); assert.ok(run.events.every((event, index) => !answerEvents({ events: [event] }).length || index > planAt));
});

test('ordinary work publishes an honest root before inference and requires a durable plan before mutations', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.equal(number, 1);
    assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_task'), TASK_TOOL);
    assert.match(options.developerInstructions, /DEFAULT TASK WORKSPACE/);
    assert.doesNotMatch(options.developerInstructions, /Simple conversation needs no plan|Do not force a tool call or a saved plan/);
    const run = context.engine.listRuns()[0], initial = await context.tasks.get(run.taskId);
    assert.equal(initial.plan.origin, 'runtime'); assert.deepEqual(initial.steps, []); assert.equal(initial.progress.done, 0);
    assert.equal(run.nodes.agent.planning.status, 'preparing');
    assert.ok(run.events.some(event => event.data?.type === 'task.state' && event.data.state.plan.origin === 'runtime'));
    const denied = await call(options, 'relay_workspace', { action: 'write', path: 'result.txt', text: 'premature' });
    assert.equal(denied.success, false); assert.equal(denied.code, 'TASK_PLAN_REQUIRED'); assert.match(payload(denied).message, /without asking the user for approval/);
    await assert.rejects(readFile(path.join(context.cwd, 'result.txt')), { code: 'ENOENT' });
    assert.equal((await context.tasks.get(run.taskId)).revision, initial.revision);
    let state = await savePlan(options, [leaf('deliver', 'Create and inspect result.txt')]);
    assert.deepEqual(state.plan.authoredBy, { runId: run.id, nodeId: 'agent' });
    const written = await call(options, 'relay_workspace', { action: 'write', path: 'result.txt', text: 'verified fixture output' }); assert.equal(written.success, true);
    const read = await call(options, 'relay_workspace', { action: 'read', path: 'result.txt' }); assert.equal(read.success, true); assert.match(payload(read).content, /verified fixture output/);
    state = await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'deliver', status: 'done', evidence: 'Read result.txt through relay_workspace and observed verified fixture output.' });
    assert.equal(state.progress.done, 1); return { output: 'Created and read the result.', threadId: context.threadId };
  });
  const run = await f.settled(f.start().id); completed(run); assert.equal(f.runtime.calls.length, 1, 'Planning runs inside the same agent turn');
  assert.equal(run.nodes.agent.planning.status, 'recorded'); assert.equal(run.taskState.plan.origin, 'agent'); assert.equal(run.taskState.progress.done, 1);
  assert.equal(run.nodes.agent.taskSchemaVersion, TASK_SCHEMA_VERSION); assert.equal(await readFile(path.join(f.cwd, 'result.txt'), 'utf8'), 'verified fixture output');
});

test('saved Inbox planning metadata survives restart while Planning On retains full detail despite compact requests', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.match(options.developerInstructions, /detailed operational outline/);
    assert.doesNotMatch(options.developerInstructions, /Keep the outline compact/);
    const state = await savePlan(options, [leaf()], { detail: number === 1 ? 'compact' : 'detailed' });
    assert.equal(state.plan.detail, 'detailed', 'Planning On keeps full detail even if a request or saved plan carries a legacy compact hint');
    await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'answer', status: 'done', evidence: 'Returned the fixture answer and checked its stated result.' });
    return { output: 'The saved request preference was used.', threadId: context.threadId };
  });
  const legacy = structuredClone(f.workflow); delete legacy.settings.planDetail;
  assert.equal(Object.hasOwn(validateWorkflow(legacy).settings, 'planDetail'), false, 'omitted legacy settings remain omitted for receipt identity');
  assert.throws(() => validateWorkflow({ ...legacy, settings: { ...legacy.settings, planDetail: 'unbounded' } }), { code: 'PLAN_DETAIL_INVALID' });
  f.workflow.settings.planDetail = 'detailed';
  const options = { dataDir: f.directory, engine: f.engine, delayMs: 0 };
  let inbox = await new TaskInbox(options).init();
  try {
    const item = await inbox.add({ input: 'Keep the requested detail when I run this saved task.', cwd: f.cwd, workflow: f.workflow });
    assert.equal(item.workflow.settings.planDetail, 'detailed');
    await inbox.close(); inbox = await new TaskInbox(options).init();
    assert.equal(inbox.get(item.id).workflow.settings.planDetail, 'detailed');
    const receipt = await inbox.runNow(item.id), run = await f.settled(receipt.run.id);
    completed(run); assert.equal(run.planDetail, 'detailed'); assert.equal(run.taskState.plan.detail, 'detailed');
    assert.equal(run.workflow.settings.planDetail, 'detailed');
  } finally { await inbox.close(); }
  const override = await f.settled(f.start({ task: 'Use a compact plan for this request.', planDetail: 'compact' }).id);
  completed(override); assert.equal(override.planDetail, 'compact', 'The authored request is retained independently of its effective planning detail');
  assert.equal(override.nodes.agent.planning.detail, 'detailed'); assert.equal(override.taskState.plan.detail, 'detailed');
});

test('a bounded discovery allowance grounds the plan but does not admit shell commands or arbitrary connector calls', async t => {
  const f = await fixture(t, async (options, number, context) => {
    await writeFile(path.join(context.cwd, 'input.txt'), 'Actual task material.');
    for (let index = 0; index < 4; index++) assert.equal((await call(options, 'relay_workspace', { action: 'read', path: 'input.txt' })).success, true);
    const exhausted = await call(options, 'relay_workspace', { action: 'read', path: 'input.txt' }); assert.equal(exhausted.code, 'TASK_PLAN_REQUIRED'); assert.equal(payload(exhausted).inspectionCallsUsed, 4);
    const command = await call(options, 'relay_workspace', { action: 'run', command: 'echo must-not-run' }); assert.equal(command.code, 'TASK_PLAN_REQUIRED');
    const connector = await call(options, 'relay_connections', { action: 'call', connectionId: 'fixture', name: 'unknown_read' }); assert.equal(connector.code, 'TASK_PLAN_REQUIRED');
    const description = await taskCall(options, { action: 'describe', methodQuery: 'Research a question' }); assert.ok(JSON.stringify(description).includes('research-brief')); assert.equal(description.totalMethods, 589); assert.ok(description.methods.length <= 20);
    const state = await savePlan(options); assert.equal(state.plan.origin, 'agent');
    assert.equal((await call(options, 'relay_workspace', { action: 'read', path: 'input.txt' })).success, true, 'After planning the normal tool rules apply');
    return { output: 'The source was inspected.', threadId: context.threadId };
  });
  const run = await f.settled(f.start().id); completed(run);
  assert.equal(run.taskState.steps[0].status, 'active', 'A final answer must not fabricate a completed milestone');
  assert.equal(run.taskState.progress.done, 0);
});

test('an invalid or stale plan cannot admit work and a current read can recover without another model call', async t => {
  const f = await fixture(t, async (options, number, context) => {
    const initial = await taskCall(options, { action: 'read' });
    const invalid = await call(options, 'relay_task', { action: 'plan', expectedRevision: initial.revision, steps: [] }); assert.equal(invalid.success, false);
    assert.equal((await call(options, 'relay_workspace', { action: 'write', path: 'never.txt', text: 'no' })).code, 'TASK_PLAN_REQUIRED');
    const stale = await call(options, 'relay_task', { action: 'plan', expectedRevision: initial.revision + 1, steps: [leaf()] }); assert.equal(stale.success, false);
    assert.equal(context.engine.listRuns()[0].nodes.agent.planning.status, 'preparing');
    await savePlan(options); assert.equal((await call(options, 'relay_workspace', { action: 'write', path: 'after-plan.txt', text: 'yes' })).success, true);
    return { output: 'A current plan was saved.', threadId: context.threadId };
  });
  const run = await f.settled(f.start().id); completed(run); assert.equal(f.runtime.calls.length, 1); assert.equal(run.nodes.agent.planning.status, 'recorded');
  await assert.rejects(readFile(path.join(f.cwd, 'never.txt')), { code: 'ENOENT' });
});

test('nested parallel branches are persisted through the actual engine tool and emit live step receipts', async t => {
  const f = await fixture(t, async (options, number, context) => {
    const steps = [
      { id: 'sources', title: 'Inspect two inputs', kind: 'parallel', parentId: null },
      { ...leaf('left', 'Inspect the first input'), parentId: 'sources' },
      { ...leaf('right', 'Inspect the second input'), parentId: 'sources' },
      { ...leaf('report', 'Combine the findings'), status: 'pending', dependsOn: ['sources'] },
    ];
    let state = await savePlan(options, steps);
    state = await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'left', status: 'done', evidence: 'Fixture inspected the first supplied input.' });
    state = await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'right', status: 'done', evidence: 'Fixture inspected the second supplied input.' });
    state = await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'report', status: 'active' });
    assert.equal(state.steps.find(step => step.id === 'sources').status, 'done');
    return { output: 'Both inputs inspected; synthesis remains active.', threadId: context.threadId };
  });
  const run = await f.settled(f.start().id); completed(run); assert.equal(run.taskState.progress.total, 3); assert.equal(run.taskState.progress.done, 2);
  assert.equal(run.taskState.steps.find(step => step.id === 'left').parentId, 'sources');
  assert.ok(run.events.filter(event => event.data?.type === 'task.state').length >= 5);
  const reopened = await new TaskStateStore({ dataDir: f.directory }).init(); t.after(() => reopened.close());
  assert.deepEqual(await reopened.get(run.taskId), run.taskState);
});

test('follow-ups require a fresh plan while preserving earlier completed work, evidence and original run snapshots', async t => {
  let firstSnapshot;
  const f = await fixture(t, async (options, number, context) => {
    if (number === 1) {
      let state = await savePlan(options);
      state = await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'answer', status: 'done', evidence: 'The fixture computed 2 + 2 = 4.' });
      return { output: '4', threadId: context.threadId };
    }
    assert.equal(options.threadId, context.threadId); assert.match(options.developerInstructions, /On a follow-up or retry, preserve earlier work and its evidence/);
    assert.match(options.developerInstructions, /detailed operational outline/);
    const prior = await taskCall(options, { action: 'read' }); assert.equal(prior.steps[0].status, 'done'); assert.match(prior.steps[0].evidence, /2 \+ 2/);
    assert.equal((await call(options, 'relay_workspace', { action: 'write', path: 'followup.txt', text: 'not yet' })).code, 'TASK_PLAN_REQUIRED');
    const state = await taskCall(options, { action: 'plan', expectedRevision: prior.revision, steps: [...prior.steps, leaf('followup', 'Explain the follow-up question')], plan: { layout: 'sequence', detail: 'detailed', taskType: 'general' } });
    assert.equal(state.steps[0].evidence, prior.steps[0].evidence); assert.notEqual(state.plan.authoredBy.runId, firstSnapshot.id);
    await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'followup', status: 'done', evidence: 'The fixture explained the requested second example.' });
    return { output: 'A second example is ready.', threadId: context.threadId };
  });
  firstSnapshot = await f.settled(f.start({ task: 'What is 2 + 2?', planDetail: 'compact' }).id); completed(firstSnapshot);
  assert.equal(firstSnapshot.planDetail, 'compact'); assert.equal(firstSnapshot.nodes.agent.planning.detail, 'detailed');
  const request = { nodeId: 'agent', message: 'Give me another example.', planDetail: 'detailed', requestId: 'followup-detail-once' };
  const accepted = f.engine.continueRun(firstSnapshot.id, request);
  assert.equal(f.engine.continueRun(firstSnapshot.id, request).id, accepted.id);
  assert.throws(() => f.engine.continueRun(firstSnapshot.id, { ...request, planDetail: 'compact' }), /different|reused|conflict/i);
  const next = await f.settled(accepted.id); completed(next);
  assert.equal(next.planDetail, 'detailed'); assert.equal(next.taskState.progress.done, 2); assert.equal(next.nodes.agent.planning.status, 'recorded');
  assert.deepEqual(f.engine.getRun(firstSnapshot.id), firstSnapshot); assert.equal(f.runtime.calls.length, 2);
});

for (const version of [1, 2, 3]) test(`saved native task schema v${version} remains available with Planning Off and its original tool contract`, async t => {
  const f = await fixture(t, async (options, number, context) => {
    if (number === 1) { await savePlan(options); return { output: 'Original turn.', threadId: context.threadId }; }
    assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_task'), taskToolForVersion(version));
    assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|branching outline is the default/);
    assert.equal((await call(options, 'relay_workspace', { action: 'write', path: 'legacy.txt', text: `v${version}` })).success, true);
    const unsupported = await call(options, 'relay_task', { action: 'describe' }); assert.equal(unsupported.success, false);
    return { output: 'Legacy catalog retained.', threadId: context.threadId };
  });
  const first = await f.settled(f.start().id); completed(first);
  f.engine.runs.get(first.id).nodes.agent.taskSchemaVersion = version;
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Use the original tools.', planningMode:'off' }).id); completed(next);
  assert.equal(next.nodes.agent.taskSchemaVersion, version); assert.equal(next.nodes.agent.planning.status, 'off');
});

test('provider continuations receive current planning even if their older saved schema is missing', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_task'), TASK_TOOL);
    await savePlan(options); return { output: 'Current provider outline.', threadId: context.threadId };
  }, { model: 'fixture-api::model', threadId: 'provider_plan-fixture' });
  const first = await f.settled(f.start().id); completed(first); delete f.engine.runs.get(first.id).nodes.agent.taskSchemaVersion;
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue through the provider.' }).id); completed(next);
  assert.equal(next.nodes.agent.taskSchemaVersion, TASK_SCHEMA_VERSION); assert.equal(next.nodes.agent.planning.status, 'recorded'); assert.equal(f.runtime.calls[1].threadId, f.threadId);
});

test('a saved v4 native thread keeps its original method schema and planning guard across a v5 catalog update', async t => {
  const f = await fixture(t, async (options, number, context) => {
    if (number === 1) { await savePlan(options); return { output: 'The original outline is recorded.', threadId: context.threadId }; }
    assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_task'), taskToolForVersion(4));
    assert.doesNotMatch(options.developerInstructions, /METHOD DISCOVERY AND ADAPTATION/);
    assert.equal((await call(options, 'relay_workspace', { action: 'write', path: 'should-wait.txt', text: 'not admitted' })).code, 'TASK_PLAN_REQUIRED');
    const catalog = await taskCall(options, { action: 'describe' }); assert.equal(catalog.schemaVersion, 4); assert.equal(catalog.methods.length, 589); assert.ok(catalog.methods.some(method => method.id === 'catalyst-ach')); assert.ok(JSON.stringify(catalog).length < 128000);
    const unexposed = await call(options, 'relay_task', { action: 'describe', methodQuery: 'ACH' }); assert.equal(unexposed.code, 'TASK_SCHEMA_UNSUPPORTED');
    await savePlan(options); assert.equal((await call(options, 'relay_workspace', { action: 'write', path: 'kept-v4.txt', text: 'The saved tool contract was retained.' })).success, true);
    return { output: 'The original tool contract is retained.', threadId: context.threadId };
  });
  const first = await f.settled(f.start().id); completed(first); f.engine.runs.get(first.id).nodes.agent.taskSchemaVersion = 4;
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue this task with its saved method schema.' }).id); completed(next);
  assert.equal(next.nodes.agent.taskSchemaVersion, 4); assert.equal(next.nodes.agent.planning.status, 'recorded'); assert.equal(f.runtime.calls.length, 2);
});

test('project workers receive method and ontology guidance without recursive project orchestration', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_project'));
    const description = await taskCall(options, { action: 'describe', methodId: 'software-feature' }); assert.ok(JSON.stringify(description).includes('Inspect the current behavior'));
    await savePlan(options, [leaf('inspect', 'Inspect the assigned project task')], { taskType: 'software', method: { id: 'software-feature', revision: 1 } });
    return { output: 'Assigned project task planned.', threadId: context.threadId };
  }, { workflowId: 'project-plan-worker' });
  f.engine.projects = {}; f.engine.capabilities = {};
  const run = await f.settled(f.start().id); completed(run); assert.equal(run.taskState.plan.method.id, 'software-feature'); assert.equal(run.nodes.agent.planning.status, 'recorded');
});

test('missing or unsupported planning stays explicit and never fabricates model steps', async t => {
  const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };
  const missing = await fixture(t, async options => {
    options.onEvent({ type: 'delta', itemId: 'unplanned', delta: 'A fixture response with no plan.' });
    options.onEvent({ type: 'message', itemId: 'unplanned', text: 'A fixture response with no plan.', phase: 'final_answer' });
    options.onEvent({ type: 'item', item: { type: 'agentMessage', id: 'unplanned', text: 'A fixture response with no plan.' }, stage: 'completed' });
    return { output: 'A fixture response with no plan.', threadId: 'native-unplanned-result', turnId: 'turn-unplanned', usage };
  });
  const withoutPlan = await missing.settled(missing.start().id); assert.equal(withoutPlan.status, 'failed'); assert.equal(withoutPlan.nodes.agent.planning.status, 'missing');
  assert.equal(withoutPlan.errorCode, 'TASK_PLAN_REQUIRED'); assert.equal(withoutPlan.nodes.agent.errorCode, 'TASK_PLAN_REQUIRED'); assert.match(withoutPlan.error, /answer was withheld/);
  assert.equal(withoutPlan.nodes.agent.status, 'failed'); assert.equal(withoutPlan.nodes.output.status, 'skipped');
  assert.equal(withoutPlan.nodes.agent.output, ''); assert.equal(withoutPlan.output, ''); assert.equal(answerEvents(withoutPlan).length, 0);
  assert.deepEqual(withoutPlan.nodes.agent.usage, usage); assert.equal(withoutPlan.nodes.agent.threadId, 'native-unplanned-result'); assert.equal(withoutPlan.nodes.agent.turnId, 'turn-unplanned');
  assert.equal(withoutPlan.taskState.plan.origin, 'runtime'); assert.deepEqual(withoutPlan.taskState.steps, []); assert.equal(withoutPlan.taskState.progress.done, 0); assert.equal(missing.runtime.calls.length, 1);
  const unsupported = await fixture(t, async options => {
    assert.equal(options.dynamicTools, undefined); assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE/);
    assert.doesNotMatch(options.prompt, /DEFAULT TASK OUTLINE|CALL relay_task describe/);
    options.onEvent({ type: 'delta', delta: 'This model can answer without tools.' });
    return { output: 'This model can answer without tools.' };
  }, { supportsTools: false });
  const noTools = await unsupported.settled(unsupported.start('Complete with Planning Off.',{planningMode:'off'}).id); completed(noTools); assert.equal(noTools.nodes.agent.planning.status, 'off');
  assert.equal(noTools.taskState.plan, undefined); assert.deepEqual(noTools.taskState.steps, []); assert.equal(noTools.nodes.agent.taskSchemaVersion, undefined);
  assert.equal(answerEvents(noTools).length, 1);
});

test('a prior completed plan cannot release an unplanned follow-up answer', async t => {
  const f = await fixture(t, async (options, number, context) => {
    if (number === 1) {
      const state = await savePlan(options);
      await taskCall(options, { action: 'step', expectedRevision: state.revision, stepId: 'answer', status: 'done', evidence: 'The original fixture answer was checked.' });
      return { output: 'Original answer.', threadId: context.threadId };
    }
    const prior = await taskCall(options, { action: 'read' }); assert.equal(prior.steps[0].status, 'done');
    options.onEvent({ type: 'delta', delta: 'Unplanned follow-up.' });
    return { output: 'Unplanned follow-up.', threadId: context.threadId };
  });
  const first = await f.settled(f.start().id); completed(first);
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Answer the next question.' }).id);
  assert.equal(next.status, 'failed'); assert.equal(next.errorCode, 'TASK_PLAN_REQUIRED'); assert.equal(next.nodes.agent.planning.status, 'missing');
  assert.equal(next.nodes.agent.output, ''); assert.equal(answerEvents(next).length, 0); assert.equal(f.runtime.calls.length, 2);
  assert.equal(next.taskState.plan.authoredBy.runId, first.id); assert.equal(next.taskState.steps[0].status, 'done');
  assert.equal(next.taskState.steps[0].evidence, first.taskState.steps[0].evidence);
});

test('plan detail is part of idempotent request identity and failed turns retain it on Retry', async t => {
  const f = await fixture(t, async (options, number, context) => { if (number === 1) throw Error('Fixture connection lost.'); assert.match(options.developerInstructions, /detailed operational outline/); await savePlan(options); return { output: 'Retry completed.', threadId: context.threadId }; });
  assert.throws(() => f.start({ task: 'A request.', planDetail: 'endless' }), { code: 'PLAN_DETAIL_INVALID' });
  assert.throws(() => f.start({ task: 'A request.', planDetail: 'compact' }, { planDetail: 'detailed' }), { code: 'PLAN_DETAIL_INVALID' });
  const accepted = f.start({ task: 'A request.', planDetail: 'detailed' }, { requestId: 'detail-once' });
  assert.equal(f.start({ task: 'A request.', planDetail: 'detailed' }, { requestId: 'detail-once' }).id, accepted.id);
  assert.throws(() => f.start({ task: 'A request.', planDetail: 'compact' }, { requestId: 'detail-once' }), /different|reused|conflict/i);
  const failed = await f.settled(accepted.id); assert.equal(failed.status, 'failed'); assert.equal(failed.nodes.agent.planning.status, 'missing');
  const retried = await f.settled(f.engine.retryRun(failed.id).id); completed(retried); assert.equal(retried.planDetail, 'detailed'); assert.equal(retried.nodes.agent.planning.status, 'recorded');
});

for (const alreadyPlanned of [false, true]) test(`Stop ${alreadyPlanned ? 'after' : 'before'} planning preserves actual state and rejects later work`, async t => {
  let ready = false;
  const f = await fixture(t, async (options, number, context) => {
    if (alreadyPlanned) await savePlan(options);
    options.onEvent({ type: 'delta', delta: 'Text before Stop.' });
    ready = true;
    await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); });
    await assert.rejects(call(options, 'relay_workspace', { action: 'write', path: 'after-stop.txt', text: 'must not be written' }), { name: 'AbortError' });
    options.onEvent({ type: 'delta', delta: 'Late text must not be published.' });
    options.onEvent({ type: 'usage', usage: { totalTokens: 17 } });
    throw Object.assign(new Error('Fixture stopped.'), { name: 'AbortError' });
  });
  const accepted = f.start();
  try {
    await wait(() => {
      const run = f.engine.getRun(accepted.id);
      assert.ok(!run.settled, run.error || run.nodes.agent?.error || 'The cancellation fixture settled before its ready signal.');
      return ready;
    });
  } finally {
    if (!f.engine.getRun(accepted.id).settled) f.engine.cancelRun(accepted.id);
  }
  const stopped = await f.settled(accepted.id); assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.taskState.progress.done, 0); assert.equal(stopped.taskState.plan.origin, alreadyPlanned ? 'agent' : 'runtime');
  assert.equal(stopped.nodes.agent.planning.status, alreadyPlanned ? 'recorded' : 'missing');
  assert.equal(stopped.taskState.interruption.status, 'cancelled');
  assert.equal(answerEvents(stopped).length, alreadyPlanned ? 1 : 0); assert.equal(stopped.nodes.agent.output, alreadyPlanned ? 'Text before Stop.' : '');
  assert.equal(stopped.nodes.agent.usage.totalTokens, 17, 'Final measured usage survives cancellation before or after planning');
  if (alreadyPlanned) assert.equal(stopped.taskState.steps[0].status, 'active'); else assert.deepEqual(stopped.taskState.steps, []);
  await assert.rejects(readFile(path.join(f.cwd, 'after-stop.txt')), { code: 'ENOENT' });
});

test('capability instructions use default planning only for its actual v4 schema', () => {
  const modern = capabilityGuidance([TASK_TOOL]); assert.match(modern, /branching outline is the default/); assert.doesNotMatch(modern, /Simple conversation needs no plan record/);
  for (const version of [1, 2, 3]) { const legacy = capabilityGuidance([taskToolForVersion(version)]); assert.match(legacy, /Simple conversation needs no plan record/); assert.doesNotMatch(legacy, /branching outline is the default/); }
});

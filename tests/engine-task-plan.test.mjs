import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine, validateWorkflow } from '../lib/engine.mjs';
import { TaskInbox } from '../lib/inbox.mjs';
import { TaskStateStore, TASK_SCHEMA_VERSION, currentTaskTool } from '../lib/task-state.mjs';
import { MethodStore } from '../lib/methods.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { capabilityGuidance } from '../lib/tool-routing.mjs';
import { projectTurnMachineTrace } from '../lib/turn-machine-trace.mjs';

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
  operation: { kind: 'reasoning', target: title },
  result: 'The observed result and saved effects of the named fixture operation.',
  note: 'Perform the named fixture operation, inspect its receipt and saved effects, and compare them with the assertions.',
  doneWhen: 'The requested result is present and its stated check was performed.',
});
const toolLeaf = (id, action, target, status = 'active') => ({ ...leaf(id, action + ' ' + target), status,
  operation: { kind: 'tool', tool: 'relay_workspace', action, target },
  result: 'The returned ' + action + ' receipt for ' + target, note: 'Call relay_workspace ' + action + ' once for ' + target,
  doneWhen: 'The receipt identifies the requested path and result.' });
async function saveManualPlan(context, options, steps = [leaf()], plan = {}) {
  const state = await taskCall(options, { action: 'read' });
  return context.tasks.setPlan(state.taskId, { steps, plan: { layout: 'sequence', taskType: 'general', ...plan } }, { expectedRevision: state.revision, source: 'human' });
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
  // Legacy saved settings must not resurrect compulsory Planning orchestration.
  engine.runtimeSettings = { get: () => ({ executionGuardrails: true }) };
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
const optionalTool = () => currentTaskTool({ executionGuardrails: false });

test('only Maximal retains provider and host final boundaries with the actual review mode', async t => {
  const f = await fixture(t, async options => {
    options.onEvent({ type:'provider.final', providerType:'codex', providerTermination:'completed', terminationField:'turn-status', reviewConfigured:Boolean(options.onBeforeFinal), turnId:'fixture-turn' });
    options.onEvent({ type:'host.final-review', reviewDecision:'not-configured', turnId:'fixture-turn' });
    return { output:'Direct answer.' };
  });
  for(const depth of ['off','on','maximal']){
    const initial = f.start({task:'What is the fixture result?',directoryDiagnostics:depth});
    const run = await f.settled(initial.id);
    completed(run);
    const boundaries = projectTurnMachineTrace(f.engine.runs.get(initial.id)).entries.filter(row => ['provider.final','host.final-review'].includes(row.kind));
    assert.equal(boundaries.length, depth==='maximal' ? 2 : 0);
    assert.equal(run.events.filter(row => ['provider.final','host.final-review'].includes(row.data?.type)).length, boundaries.length);
    if(boundaries.length){
      assert.deepEqual(boundaries.map(row=>row.metadata.reviewMode),['none','none']);
      assert.equal(boundaries[0].metadata.reviewConfigured,false);
      assert.equal(boundaries[1].metadata.reviewDecision,'not-configured');
      assert.equal(boundaries[0].turnRef,boundaries[1].turnRef);
    }
  }
});

test('ordinary answer events stream without a compulsory plan or final review', async t => {
  const f = await fixture(t, async (options, number, context) => {
    const run = context.engine.listRuns()[0];
    options.onEvent({ type: 'delta', itemId: 'answer', delta: 'Direct ' });
    options.onEvent({ type: 'delta', itemId: 'answer', delta: 'answer.' });
    options.onEvent({ type: 'message', itemId: 'answer', text: 'Direct answer.', phase: 'final_answer' });
    options.onEvent({ type: 'usage', usage: { totalTokens: 13 } });
    const live = context.engine.getRun(run.id);
    assert.equal(live.nodes.agent.output, 'Direct answer.');
    assert.equal(answerEvents(live).length, 3);
    assert.equal(live.nodes.agent.usage.totalTokens, 13);
    assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_task'));
    const denied = await call(options, 'relay_task', { action: 'read' });
    assert.equal(denied.success, false); assert.equal(denied.code, 'TASK_PLAN_UNAVAILABLE');
    const initial = await context.tasks.get(run.taskId);
    assert.deepEqual(initial.steps, []); assert.equal(initial.plan, undefined);
    return { output: 'Direct answer.', threadId: context.threadId };
  });
  const run = await f.settled(f.start().id); completed(run);
  assert.equal(f.runtime.calls.length, 1); assert.equal(run.nodes.agent.planning.status, 'off');
  assert.equal(run.nodes.agent.output, 'Direct answer.'); assert.equal(answerEvents(run).length, 3);
  assert.deepEqual(run.taskState.steps, []); assert.equal(run.taskState.plan, undefined);
});

test('ordinary tools run directly and an optional authored outline preserves real outcomes', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.equal(number, 1); assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_task'), optionalTool(TASK_SCHEMA_VERSION));
    assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|detailed operational outline/);
    const run = context.engine.listRuns()[0], initial = await context.tasks.get(run.taskId);
    assert.deepEqual(initial.steps, []); assert.equal(initial.plan, undefined);
    const written = await call(options, 'relay_workspace', { action: 'write', path: 'result.txt', text: 'verified fixture output' });
    assert.equal(written.success, true, written.contentItems?.[0]?.text);
    assert.equal(await readFile(path.join(context.cwd, 'result.txt'), 'utf8'), 'verified fixture output');
    let state = await saveManualPlan(context, options, [toolLeaf('inspect', 'read', 'result.txt')]);
    assert.equal(state.plan.origin, 'human');
    const read = await call(options, 'relay_workspace', { action: 'read', path: 'result.txt' });
    assert.equal(read.success, true); assert.match(payload(read).content, /verified fixture output/);
    state = await context.tasks.setStep(state.taskId, 'inspect', { status: 'done', evidence: 'Read result.txt and observed verified fixture output.' }, { expectedRevision: state.revision, source: 'human' });
    assert.equal(state.progress.done, 1);
    return { output: 'Created and read the result.', threadId: context.threadId };
  });
  const run = await f.settled(f.start('/plan Complete the requested fixture work.').id); completed(run);
  assert.equal(f.runtime.calls.length, 1); assert.equal(run.nodes.agent.planning.status, 'off');
  assert.equal(run.taskState.plan.origin, 'human'); assert.equal(run.taskState.progress.done, 1);
  assert.equal(run.nodes.agent.taskSchemaVersion, TASK_SCHEMA_VERSION);
});

test('saved Inbox detail survives restart without reactivating automatic Planning', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.doesNotMatch(options.developerInstructions, /detailed operational outline/);
    const state = await saveManualPlan(context, options, [leaf()], { detail: number === 1 ? 'detailed' : 'compact' });
    assert.equal(state.plan.detail, number === 1 ? 'detailed' : 'compact');
    return { output: 'The optional authored detail was retained.', threadId: context.threadId };
  });
  const legacy = structuredClone(f.workflow); delete legacy.settings.planDetail;
  assert.equal(Object.hasOwn(validateWorkflow(legacy).settings, 'planDetail'), false);
  assert.throws(() => validateWorkflow({ ...legacy, settings: { ...legacy.settings, planDetail: 'unbounded' } }), { code: 'PLAN_DETAIL_INVALID' });
  f.workflow.settings.planDetail = 'detailed';
  const options = { dataDir: f.directory, engine: f.engine, delayMs: 0 };
  let inbox = await new TaskInbox(options).init();
  try {
    const item = await inbox.add({ input: '/plan Keep the requested detail when I run this saved task.', cwd: f.cwd, workflow: f.workflow });
    assert.equal(item.workflow.settings.planDetail, 'detailed');
    await inbox.close(); inbox = await new TaskInbox(options).init();
    assert.equal(inbox.get(item.id).workflow.settings.planDetail, 'detailed');
    const receipt = await inbox.runNow(item.id), run = await f.settled(receipt.run.id); completed(run);
    assert.equal(run.planDetail, 'detailed'); assert.equal(run.taskState.plan.detail, 'detailed');
    assert.equal(run.workflow.settings.planDetail, 'detailed'); assert.equal(run.planningMode, 'off');
  } finally { await inbox.close(); }
  const override = await f.settled(f.start({ task: '/plan Use a compact outline for this request.', planDetail: 'compact' }).id);
  completed(override); assert.equal(override.planDetail, 'compact'); assert.equal(override.taskState.plan.detail, 'compact');
});

test('inspection needs no saved leaf and answering does not fabricate optional step completion', async t => {
  const f = await fixture(t, async (options, number, context) => {
    await writeFile(path.join(context.cwd, 'input.txt'), 'Actual task material.');
    const read = await call(options, 'relay_workspace', { action: 'read', path: 'input.txt' });
    assert.equal(read.success, true); assert.equal(payload(read).content, '1: Actual task material.');
    const description = await taskCall(options, { action: 'describe' });
    assert.ok(description.actionFields.plan.includes('contract'));
    await saveManualPlan(context, options, [toolLeaf('inspect', 'read', 'input.txt')]);
    return { output: 'The source was inspected; the optional outline is still active.', threadId: context.threadId };
  });
  const run = await f.settled(f.start('/plan Complete the requested fixture work.').id); completed(run);
  assert.equal(run.taskState.steps[0].status, 'active'); assert.equal(run.taskState.progress.done, 0);
  assert.equal(run.nodes.agent.planning.status, 'off');
});

test('invalid and stale optional edits remain atomic without vetoing independent tools', async t => {
  const f = await fixture(t, async (options, number, context) => {
    const initial = await taskCall(options, { action: 'read' });
    const invalid = await call(options, 'relay_task', { action: 'plan', expectedRevision: initial.revision, steps: [] });
    assert.equal(invalid.success, false);
    assert.deepEqual(await taskCall(options, { action: 'read' }), initial);
    const stale = await call(options, 'relay_task', { action: 'plan', expectedRevision: initial.revision + 1, steps: [leaf()] });
    assert.equal(stale.success, false); assert.deepEqual(await taskCall(options, { action: 'read' }), initial);
    const write = await call(options, 'relay_workspace', { action: 'write', path: 'independent.txt', text: 'real write' });
    assert.equal(write.success, true);
    const state = await saveManualPlan(context, options, [leaf()]); assert.equal(state.plan.origin, 'human');
    return { output: 'Rejected edits preserved state; the independent write succeeded.' };
  });
  const run = await f.settled(f.start('/plan Complete the requested fixture work.').id); completed(run); assert.equal(f.runtime.calls.length, 1);
  assert.equal(await readFile(path.join(f.cwd, 'independent.txt'), 'utf8'), 'real write');
});

test('nested outline chronology and continue reviews persist without gating the answer', async t => {
  const f = await fixture(t, async (options, number, context) => {
    let state = await saveManualPlan(context, options, [
      { id: 'sources', title: 'Inspect two inputs', kind: 'parallel', parentId: null },
      { ...leaf('left', 'Inspect the first input'), parentId: 'sources' },
      { ...leaf('right', 'Inspect the second input'), parentId: 'sources', status: 'pending' },
      { ...leaf('report', 'Combine findings'), status: 'pending', dependsOn: ['sources'] },
    ]);
    state = await context.tasks.setStep(state.taskId, 'left', { status: 'done', evidence: 'Inspected the first supplied input.' }, { expectedRevision: state.revision, source: 'human' });
    state = await context.tasks.setStep(state.taskId, 'right', { status: 'active' }, { expectedRevision: state.revision, source: 'human' });
    state = await context.tasks.setStep(state.taskId, 'right', { status: 'done', evidence: 'Inspected the second supplied input.' }, { expectedRevision: state.revision, source: 'human' });
    state = await context.tasks.setStep(state.taskId, 'report', { status: 'active' }, { expectedRevision: state.revision, source: 'human' });
    assert.equal(state.steps.find(step => step.id === 'sources').status, 'done');
    await context.tasks.review(state.taskId, { decision: 'continue', nextStepId: 'report', summary: 'Both inputs are inspected. Synthesis remains active and is not claimed complete.' }, { expectedRevision: state.revision, source: 'human', schemaVersion: 14, runId: context.engine.listRuns()[0].id, nodeId: 'agent' });
    return { output: 'Both inputs inspected; synthesis remains active.' };
  });
  const run = await f.settled(f.start('/plan Complete the requested fixture work.').id); completed(run);
  assert.equal(run.taskState.planningReviews.at(-1).decision, 'continue');
  assert.equal(run.taskState.progress.total, 3); assert.equal(run.taskState.progress.done, 2);
  assert.equal(run.taskState.steps.find(step => step.id === 'left').parentId, 'sources');
  const reopened = await new TaskStateStore({ dataDir: f.directory }).init(); t.after(() => reopened.close());
  assert.deepEqual(await reopened.get(run.taskId), run.taskState);
});

test('follow-ups preserve completed evidence, request identity and original run snapshots', async t => {
  let firstSnapshot;
  const f = await fixture(t, async (options, number, context) => {
    if (number === 1) {
      const state = await saveManualPlan(context, options);
      await context.tasks.setStep(state.taskId, 'answer', { status: 'done', evidence: 'Computed 2 + 2 = 4.' }, { expectedRevision: state.revision, source: 'human' });
      return { output: '4', threadId: context.threadId };
    }
    assert.equal(options.threadId, context.threadId);
    const prior = await context.tasks.get((await taskCall(options, { action: 'read' })).taskId); assert.equal(prior.steps[0].status, 'done'); assert.match(prior.steps[0].evidence, /2 \+ 2/);
    assert.equal((await call(options, 'relay_workspace', { action: 'write', path: 'followup.txt', text: 'direct follow-up' })).success, true);
    const state = await context.tasks.setPlan(prior.taskId, { steps: [...prior.steps, leaf('followup', 'Explain the next example')], plan: { layout: 'sequence', detail: 'detailed', taskType: 'general' } }, { expectedRevision: prior.revision, source: 'human' });
    assert.equal(state.steps[0].evidence, prior.steps[0].evidence); assert.equal(state.plan.origin, 'human');
    await context.tasks.setStep(state.taskId, 'followup', { status: 'done', evidence: 'Explained the requested second example.' }, { expectedRevision: state.revision, source: 'human' });
    return { output: 'A second example is ready.', threadId: context.threadId };
  });
  firstSnapshot = await f.settled(f.start({ task: '/plan What is 2 + 2?', planDetail: 'compact' }).id); completed(firstSnapshot);
  const request = { nodeId: 'agent', message: '/plan Give me another example.', planDetail: 'detailed', requestId: 'followup-detail-once' };
  const accepted = f.engine.continueRun(firstSnapshot.id, request);
  assert.equal(f.engine.continueRun(firstSnapshot.id, request).id, accepted.id);
  assert.throws(() => f.engine.continueRun(firstSnapshot.id, { ...request, planDetail: 'compact' }), /different|reused|conflict/i);
  const next = await f.settled(accepted.id); completed(next);
  assert.equal(next.planDetail, 'detailed'); assert.equal(next.taskState.progress.done, 2);
  assert.deepEqual(f.engine.getRun(firstSnapshot.id), firstSnapshot); assert.equal(f.runtime.calls.length, 2);
});

for (const version of [1, 2, 3, 4]) test('unsupported native task schema v' + version + ' cannot dispatch or mutate saved work', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_task'), optionalTool());
    return { output: 'Current catalog observed.', threadId: context.threadId };
  });
  const first = await f.settled(f.start('/plan Complete the requested fixture work.').id); completed(first);
  f.engine.runs.get(first.id).nodes.agent.taskSchemaVersion = version;
  const prior = await f.tasks.get(first.taskId);
  assert.throws(() => f.engine.continueRun(first.id, { nodeId: 'agent', message: '/plan Continue.' }), { code: 'NATIVE_CATALOG_UNSUPPORTED' });
  assert.equal(f.runtime.calls.length, 1);
  assert.deepEqual(await f.tasks.get(first.taskId), prior);
});

test('provider continuations receive current optional tools when saved schema is absent', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_task'), optionalTool(TASK_SCHEMA_VERSION));
    const prior = await context.tasks.get((await taskCall(options, { action: 'read' })).taskId);
    await saveManualPlan(context, options, [...prior.steps, { ...leaf('provider-' + number, 'Inspect provider catalog'), status: 'pending' }]);
    return { output: 'Current provider catalog.', threadId: context.threadId };
  }, { model: 'fixture-api::model', threadId: 'provider_plan-fixture' });
  const first = await f.settled(f.start('/plan Complete the requested fixture work.').id); completed(first); delete f.engine.runs.get(first.id).nodes.agent.taskSchemaVersion;
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: '/plan Continue through the provider.' }).id); completed(next);
  assert.equal(next.nodes.agent.taskSchemaVersion, TASK_SCHEMA_VERSION); assert.equal(f.runtime.calls[1].threadId, f.threadId);
});

test('project workers retain manually authored method metadata without recursive project orchestration', async t => {
  const f = await fixture(t, async (options, number, context) => {
    assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_project'));
    const description = await taskCall(options, { action: 'describe' });
    assert.ok(description.actionFields.plan.includes('contract'));
    const state = await saveManualPlan(context, options, [leaf('inspect', 'Inspect assigned task')], { taskType: 'software', method: { id: 'software-feature', revision: 1 } });
    await context.tasks.setStep(state.taskId, 'inspect', { status: 'done', evidence: 'Observed the current contract schema and no recursive project tool; retained manually authored software-feature metadata.' }, { expectedRevision: state.revision, source: 'human' });
    return { output: 'Current task authoring and manual method metadata checked.' };
  }, { workflowId: 'project-plan-worker' });
  f.engine.projects = {}; f.engine.capabilities = {};
  const run = await f.settled(f.start('/plan Complete the requested fixture work.').id); completed(run);
  assert.equal(run.taskState.plan.method.id, 'software-feature'); assert.equal(run.taskState.progress.done, 1);
});

test('answers without plans or tool support preserve measured usage and never fabricate steps', async t => {
  const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };
  const missing = await fixture(t, async (options, number, context) => {
    options.onEvent({ type: 'delta', delta: 'A direct response.' });
    return { output: 'A direct response.', threadId: 'native-unplanned-result', turnId: 'turn-unplanned', usage };
  });
  const run = await missing.settled(missing.start().id); completed(run);
  assert.equal(run.nodes.agent.output, 'A direct response.'); assert.equal(answerEvents(run).length, 1);
  assert.deepEqual(run.nodes.agent.usage, usage); assert.equal(run.nodes.agent.threadId, 'native-unplanned-result'); assert.equal(run.nodes.agent.turnId, 'turn-unplanned');
  assert.equal(run.taskState.plan, undefined); assert.deepEqual(run.taskState.steps, []); assert.equal(run.taskState.progress.done, 0);
  const unsupported = await fixture(t, async (options, number, context) => {
    assert.equal(options.dynamicTools, undefined); assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE/);
    return { output: 'This model can answer without tools.' };
  }, { supportsTools: false });
  const noTools = await unsupported.settled(unsupported.start().id); completed(noTools);
  assert.equal(noTools.nodes.agent.planning.status, 'off'); assert.equal(noTools.taskState.plan, undefined);
  assert.deepEqual(noTools.taskState.steps, []); assert.equal(noTools.nodes.agent.taskSchemaVersion, undefined);
});

test('a follow-up can answer directly while preserving earlier completed outline evidence', async t => {
  const f = await fixture(t, async (options, number, context) => {
    if (number === 1) {
      const state = await saveManualPlan(context, options);
      await context.tasks.setStep(state.taskId, 'answer', { status: 'done', evidence: 'The original answer was checked.' }, { expectedRevision: state.revision, source: 'human' });
      return { output: 'Original answer.', threadId: context.threadId };
    }
    assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_task'));
    const prior = await context.tasks.get(context.engine.listRuns().find(run => !run.settled).taskId);
    assert.equal(prior.steps[0].status, 'done');
    options.onEvent({ type: 'delta', delta: 'Direct follow-up.' });
    return { output: 'Direct follow-up.', threadId: context.threadId };
  });
  const first = await f.settled(f.start('/plan Complete the requested fixture work.').id); completed(first);
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Answer the next question.' }).id); completed(next);
  assert.equal(next.nodes.agent.output, 'Direct follow-up.'); assert.equal(answerEvents(next).length, 1);
  assert.deepEqual(next.taskState.plan.authoredBy, first.taskState.plan.authoredBy); assert.deepEqual(next.taskState.steps, first.taskState.steps);
});

test('plan detail remains request identity and Retry retains a genuine failure cause', async t => {
  const f = await fixture(t, async (options, number, context) => {
    if (number === 1) throw Object.assign(Error('Fixture connection lost.'), { code: 'FIXTURE_CONNECTION_LOST' });
    assert.doesNotMatch(options.developerInstructions, /detailed operational outline/);
    return { output: 'Retry completed.', threadId: context.threadId };
  });
  assert.throws(() => f.start({ task: 'A request.', planDetail: 'endless' }), { code: 'PLAN_DETAIL_INVALID' });
  assert.throws(() => f.start({ task: 'A request.', planDetail: 'compact' }, { planDetail: 'detailed' }), { code: 'PLAN_DETAIL_INVALID' });
  const accepted = f.start({ task: 'A request.', planDetail: 'detailed' }, { requestId: 'detail-once' });
  assert.equal(f.start({ task: 'A request.', planDetail: 'detailed' }, { requestId: 'detail-once' }).id, accepted.id);
  assert.throws(() => f.start({ task: 'A request.', planDetail: 'compact' }, { requestId: 'detail-once' }), /different|reused|conflict/i);
  const failed = await f.settled(accepted.id); assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'FIXTURE_CONNECTION_LOST');
  const retried = await f.settled(f.engine.retryRun(failed.id).id); completed(retried);
  assert.equal(retried.planDetail, 'detailed'); assert.equal(retried.nodes.agent.planning.status, 'off');
  assert.equal(f.runtime.calls.length, 2);
});

for (const alreadyPlanned of [false, true]) test('Stop ' + (alreadyPlanned ? 'after' : 'before') + ' optional authoring preserves state and rejects late work', async t => {
  let ready = false;
  const f = await fixture(t, async (options, number, context) => {
    if (alreadyPlanned) await saveManualPlan(context, options);
    options.onEvent({ type: 'delta', delta: 'Text before Stop.' }); ready = true;
    await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); });
    await assert.rejects(call(options, 'relay_workspace', { action: 'write', path: 'after-stop.txt', text: 'must not be written' }), { name: 'AbortError' });
    options.onEvent({ type: 'delta', delta: 'Late text must not be published.' });
    options.onEvent({ type: 'usage', usage: { totalTokens: 17 } });
    throw Object.assign(new Error('Fixture stopped.'), { name: 'AbortError' });
  });
  const accepted = alreadyPlanned ? f.start('/plan Author the optional fixture outline.') : f.start();
  try { await wait(() => { const run = f.engine.getRun(accepted.id); assert.ok(!run.settled, run.error); return ready; }); }
  finally { if (!f.engine.getRun(accepted.id).settled) f.engine.cancelRun(accepted.id); }
  const stopped = await f.settled(accepted.id); assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.taskState.progress.done, 0); assert.equal(stopped.taskState.plan?.origin, alreadyPlanned ? 'human' : undefined);
  assert.equal(stopped.nodes.agent.planning.status, 'off'); assert.equal(stopped.taskState.interruption.status, 'cancelled');
  assert.equal(answerEvents(stopped).length, 1); assert.equal(stopped.nodes.agent.output, 'Text before Stop.');
  assert.equal(stopped.nodes.agent.usage.totalTokens, 17);
  if (alreadyPlanned) assert.equal(stopped.taskState.steps[0].status, 'active'); else assert.deepEqual(stopped.taskState.steps, []);
  await assert.rejects(readFile(path.join(f.cwd, 'after-stop.txt')), { code: 'ENOENT' });
});

test('optional capability guidance never advertises compulsory outline gates', () => {
  for (const version of [TASK_SCHEMA_VERSION]) {
    const guidance = capabilityGuidance([optionalTool(version)], { planningMode: 'off', executionGuardrails: false });
    assert.doesNotMatch(guidance, /branching outline is the working state|branching outline is the default|Before the final response, return to planning/);
  }
});

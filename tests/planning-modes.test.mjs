import {fixtureOutcomeReview,finishFixtureCandidate} from './fixture-modular-provider.mjs';
// Historical schema-13 protocol regression; schema-14 behavior has separate canonical-contract and production-engine acceptance coverage.
import test from 'node:test';
import { fixtureDeferredUserAgency } from './fixture-user-agency.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine, validateWorkflow } from './fixture-legacy-planning-engine.mjs';
import { TaskStateStore, taskToolForVersion } from './fixture-legacy-task-state.mjs';
import { MethodStore } from '../lib/methods.mjs';
import { TaskInbox } from '../lib/inbox.mjs';
import { OperationsStore } from '../lib/operations.mjs';
import { capabilityGuidance } from '../lib/tool-routing.mjs';
import { BLACKICE_HARNESS_INSTRUCTIONS } from '../lib/harness-identity.mjs';

const graph = () => ({
  id: 'planning-policy-fixture', name: 'Planning policy fixture',
  nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Agent', prompt: 'Complete the requested work.', model: 'fixture-model' }, { id: 'output', type: 'output' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 },
});
const until = async check => {
  const end = Date.now() + 7000;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Planning-mode fixture did not settle.');
};
const unpack = response => JSON.parse(response.contentItems.find(item => item.type === 'inputText').text);
const call = (options, name, args) => options.onToolCall({ name, arguments: args });
async function task(options, args) { const result = await call(options, 'relay_task', args); assert.equal(result.success, true, result.contentItems?.[0]?.text); return unpack(result); }
const action = (id = 'answer', status = 'active') => ({ id, kind: 'action', parentId: null, title: 'Answer the current request', status, operation: { kind: 'reasoning', target: `The ${id} fixture question and supplied input` }, doneWhen: 'The response contains the requested result and any relevant limits.', result: 'A direct answer to the supplied fixture inputs.', note: 'Use the supplied fixture input to construct the answer and compare it with the explicit request constraints.' });
const detailedAction = (id = 'answer', status = 'active') => ({ ...action(id, status), result: 'A direct answer to the actual user request.', note: 'Use the supplied inputs, check that the response answers the request, and report only performed work.' });
async function plan(options, { steps, detail, previous } = {}) {
  const state = previous || await task(options, { action: 'read' });
  if (!steps) {
    steps = state.steps;
    if (!steps.some(step => (step.kind || 'action') === 'action' && !['done', 'skipped'].includes(step.status))) {
      let id = 'answer'; while (steps.some(step => step.id === id)) id += '-next';
      steps = [...steps, detailedAction(id)];
    }
  }
  return task(options, { action: 'plan', expectedRevision: state.revision, steps, plan: { layout: 'sequence', ...(detail ? { detail } : {}) } });
}
async function completeAndReview(options, state, decision = 'respond') {
  state ||= await task(options, { action: 'read' });
  const active = state.steps.find(step => (step.kind || 'action') === 'action' && step.status === 'active');
  if (active) state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: active.id, status: 'done', evidence: 'The supplied fixture request was compared with the saved prospective criterion and the result is ready for this turn.' });
  const summary = decision === 'blocked'
    ? 'The supplied input gap remains a real blocker and there is no independent ready action that can resolve it.'
    : 'The actual result covers this fixture request; completed history is preserved and no further work is needed before the answer.';
  return task(options, { action: 'review', expectedRevision: state.revision, review: { decision, summary,
    ...(decision === 'blocked' && options.dynamicTools?.find(item => item.name === 'relay_task')?.inputSchema?.properties?.review?.properties?.userAgency
      ? { userAgency: fixtureDeferredUserAgency(summary) } : {}) } });
}
const finished = run => assert.equal(run.status, 'completed', run.error || run.nodes.agent.error);
async function fixture(t, execute) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-mode-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), methods = await new MethodStore({ dataDir: directory, projects: { definition() {}, create() {} } }).init();
  let context;
  class Runtime extends EventEmitter {
    constructor() { super(); this.calls = []; this.models = [{ id: 'fixture-model', supportsTools: true, supportedReasoningEfforts: ['low', 'medium', 'high'] }]; }
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: this.models }; }
    async runAgent(options) {
      const review=fixtureOutcomeReview(options);if(review)return review;
      this.calls.push(options);
      options.onEvent({ type: 'thread', threadId: options.threadId || 'planning-mode-thread', model: options.model || 'fixture-model' });
      return finishFixtureCandidate(options,await execute(options, this.calls.length, context));
    }
    async close() {}
  }
  // This suite varies inert legacy aliases with explicit authoring and review modules; it is not a default-policy fixture.
  const runtime = new Runtime(), settings = { executionGuardrails: true, planningOntology:{version:2,modules:{decomposition:true,verification:true}} }, engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init();
  engine.methods = methods; engine.runtimeSettings = { get: () => ({ ...settings }) };
  context = { engine, tasks, methods, runtime, settings, directory, cwd, workflow: graph(),
    start: (value = {}) => context.engine.startRun({ workflow: context.workflow, input: 'Answer this fixture request.', ...value }),
    settle: id => until(() => { const run = context.engine.getRun(id); return run.settled && run; }),
    reopen: async () => { await context.engine.close(); context.engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init(); context.engine.methods = methods; context.engine.runtimeSettings = { get: () => ({ ...settings }) }; return context.engine; },
  };
  t.after(async () => { await context.engine.close(); await tasks.close(); await methods.close(); assert.match(path.basename(directory), /^blackice-planning-mode-/); await rm(directory, { recursive: true, force: true }); });
  return context;
}

for (const mode of ['auto', 'on', 'maximal', 'forced', 'advisory']) test(mode + ' migrates to explicit modules without legacy operation gates or model effort changes', async t => {
  const f = await fixture(t, async options => {
    assert.ok(options.developerInstructions.startsWith(BLACKICE_HARNESS_INSTRUCTIONS));
    assert.match(options.developerInstructions, /BLACKICE PLANNING MODULES \u2014 ON \/ OFF/);
    assert.doesNotMatch(options.developerInstructions, /REQUIRED FIRST-PARTY BLACKICE PLANNING SKILL/);
    assert.equal(typeof options.onBeforeFinal, 'function');
    options.onEvent({ type: 'delta', itemId: 'answer', delta: 'The actual local write is complete.' });
    const written = await call(options, 'relay_workspace', { action: 'write', path: 'unplanned.txt', text: 'Authorized ordinary work.' });
    assert.equal(written.success, true);
    return { output: 'The actual local write is complete.', threadId: 'planning-mode-thread', usage: { totalTokens: 17 } };
  });
  const run = await f.settle(f.start({ planningMode: mode }).id); finished(run);
  assert.equal(run.planningMode, 'off'); assert.equal(run.runtimeSettings.planningGuardrails, false);
  assert.equal(run.nodes.agent.planning.status, 'off'); assert.equal(run.nodes.agent.planningSkill, undefined);
  assert.equal(run.nodes.agent.output, 'The actual local write is complete.');
  assert.equal(run.nodes.agent.usage.totalTokens, 17); assert.equal(run.nodes.agent.threadId, 'planning-mode-thread');
  assert.deepEqual(run.taskState.steps, []); assert.equal(f.runtime.calls.length, 1);
  assert.equal(await readFile(path.join(f.cwd, 'unplanned.txt'), 'utf8'), 'Authorized ordinary work.');
});

test('legacy Forced and Advisory leave the separate external-action setting unchanged', async t => {
  const attempts = [];
  const f = await fixture(t, async options => {
    const receipt = await call(options, 'relay_workspace', { action: 'write', path: 'planning-policy.txt', text: 'The requested policy was observed.' });
    attempts.push(receipt);
    return { output: 'The policy was exercised.', threadId: 'planning-policy-thread-' + attempts.length };
  });
  for (const [mode, legacy] of [['forced', false], ['advisory', true]]) {
    f.settings.executionGuardrails = legacy;
    const run = await f.settle(f.start({ planningMode: mode }).id); finished(run);
    assert.equal(run.planningMode, 'off'); assert.equal(run.planningEnforcement, undefined);
    assert.equal(run.runtimeSettings.executionGuardrails, legacy);
    assert.equal(run.runtimeSettings.planningGuardrails, false); assert.equal(attempts.at(-1).success, true);
  }
});

test('a saved historical Advisory conversation keeps its captured guardrail state across a changed global default', async t => {
  const f = await fixture(t, async options => {
    const receipt = await call(options, 'relay_workspace', { action: 'write', path: 'legacy-advisory.txt', text: 'Scoped to the saved chat.' });
    assert.equal(receipt.success, true, 'An existing advisory thread does not unexpectedly switch into forced planning.');
    return { output: 'Completed using the saved mode.', threadId: 'legacy-advisory-thread' };
  });
  f.settings.executionGuardrails = false;
  const first = await f.settle(f.start({ planningMode: 'on' }).id);
  finished(first);
  assert.equal(first.runtimeSettings.planningGuardrails, false);
  f.settings.executionGuardrails = true;
  const next = await f.settle(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue this existing request.' }).id);
  finished(next);
  assert.equal(next.planningEnforcement, undefined);
  assert.equal(next.runtimeSettings.executionGuardrails, false);
  assert.equal(next.runtimeSettings.planningGuardrails, false);
});

test('a historical On request does not attach the retired mandatory skill', async t => {
  const f = await fixture(t, async options => {
    assert.doesNotMatch(options.developerInstructions, /REQUIRED FIRST-PARTY BLACKICE PLANNING SKILL/);
    assert.equal(typeof options.onBeforeFinal, 'function');
    return { output: 'The fixture answered without a sequence guard.' };
  });
  f.settings.executionGuardrails = false;
  const run = await f.settle(f.start({ planningMode: 'on' }).id); finished(run);
  assert.equal(run.nodes.agent.planningSkill, undefined);
  assert.equal(run.nodes.agent.output, 'The fixture answered without a sequence guard.');
});

test('coordinator and independent read-only workers omit the retired skill without inventing a shared plan tool', async t => {
  const f = await fixture(t, async options => {
    assert.doesNotMatch(options.developerInstructions, /REQUIRED FIRST-PARTY BLACKICE PLANNING SKILL/);
    if (options.prompt.includes('YOUR ASSIGNED TASK:')) {
      assert.equal(options.dynamicTools.some(tool => tool.name === 'relay_task'), false);
      return { output: 'The supplied fixture contains no external action or guest operation.' };
    }
    const delegated = await options.onToolCall({ name: 'relay_delegate', arguments: { tasks: [{ id: 'inspect-input', prompt: 'Read the supplied fixture only and report its scope; do not execute commands or edit files.', readOnly: true }, { id: 'inspect-tools', prompt: 'Independently inspect the supplied worker tool catalog; do not execute commands or edit files.', readOnly: true }] } });
    assert.equal(delegated.success, true, delegated.contentItems?.[0]?.text);
    assert.equal(unpack(delegated).completed, 2);
    return { output: 'The independent read was integrated; no external effect is claimed.' };
  });
  Object.assign(f.settings, { executionGuardrails: false, subagentsEnabled: true, maxSubagents: 2 });
  finished(await f.settle(f.start({ planningMode: 'on' }).id));
  assert.equal(f.runtime.calls.length, 3);
});

test('a legacy On alias does not reject a tool-less model or invoke a planner', async t => {
  const f = await fixture(t, async options => {
    assert.equal(typeof options.onBeforeFinal, 'function'); assert.equal(options.dynamicTools, undefined);
    return { output: 'A direct model answer.' };
  });
  f.runtime.models[0].supportsTools = false;
  const run = await f.settle(f.start({ planningMode: 'on' }).id); finished(run);
  assert.equal(run.nodes.agent.planning.mode, 'off'); assert.equal(run.nodes.agent.planning.status, 'off');
  assert.equal(f.runtime.calls.length, 1); assert.equal(run.nodes.agent.output, 'A direct model answer.');
});

test('a legacy On continuation preserves the exact native catalog and provider session', async t => {
  const f = await fixture(t, async (options, number) => {
    assert.match(options.developerInstructions, /TASK PLANNING MODE: OFF/);
    if (number === 2) {
      assert.equal(options.threadId, 'planning-mode-thread');
      assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_task'));
    }
    return { output: 'Legacy notes remain readable.', threadId: 'planning-mode-thread' };
  });
  const previous = await f.settle(f.start({ planningMode: 'off' }).id); finished(previous);
  const state = f.engine.runs.get(previous.id); state.nodes.agent.toolNames = ['relay_workspace']; state.nodes.agent.taskSchemaVersion = 1;
  const continuation = await f.settle(f.engine.continueRun(previous.id, { nodeId: 'agent', message: 'Continue the historical request.', planningMode: 'on' }).id);
  finished(continuation); assert.equal(continuation.taskId, previous.taskId); assert.equal(continuation.conversationId, previous.conversationId);
  assert.equal(continuation.modelHandoff, undefined); assert.deepEqual(continuation.nodes.agent.toolNames, ['relay_workspace']);
  assert.equal(f.runtime.calls.length, 2); assert.equal(previous.status, 'completed');
});

test('Off permits normal operations and final output without creating an automatic outline or method lookup', async t => {
  const f = await fixture(t, async options => {
    assert.ok(options.developerInstructions.startsWith(BLACKICE_HARNESS_INSTRUCTIONS));
    assert.match(options.developerInstructions, /TASK PLANNING MODE: OFF/);
    assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|Maintain the current task outline|form a brief operational plan|For substantive work, discover relevant methods/);
    assert.doesNotMatch(options.prompt, /DEFAULT TASK OUTLINE|METHOD DISCOVERY AND ADAPTATION/);
    assert.match(options.prompt, /EXECUTION GUARDRAILS: OFF|OPTIONAL TASK NOTES/); assert.match(options.prompt, /EXTERNAL ACTION RECOVERY/);
    const optionalTaskTool = options.dynamicTools.find(tool => tool.name === 'relay_task');
    assert.equal(optionalTaskTool.name, 'relay_task'); assert.match(optionalTaskTool.description, /Optional compact auditable task context/, 'Explicit Off does not advertise mandatory planning.');
    options.onEvent({ type: 'delta', delta: 'The actual operation is complete.' });
    const response = await call(options, 'relay_workspace', { action: 'write', path: 'off.txt', text: 'actual off-mode result' }); assert.equal(response.success, true);
    return { output: 'The actual operation is complete.', threadId: 'planning-mode-thread' };
  });
  const run = await f.settle(f.start({ planningMode: 'off' }).id); finished(run);
  assert.equal(run.planningMode, 'off'); assert.equal(run.nodes.agent.planningSkill, undefined);
  assert.doesNotMatch(f.runtime.calls[0].developerInstructions, /REQUIRED FIRST-PARTY BLACKICE PLANNING SKILL/);
  assert.equal(run.nodes.agent.planning.mode, 'off'); assert.equal(run.nodes.agent.planning.status, 'off');
  assert.equal(run.taskState.plan, undefined); assert.deepEqual(run.taskState.steps, []); assert.equal(run.taskState.checkpoint, null);
  assert.equal(await readFile(path.join(f.cwd, 'off.txt'), 'utf8'), 'actual off-mode result');
});

test('optional authored detail remains explicit instead of being inflated by legacy aliases', async t => {
  const f = await fixture(t, async (options, number) => {
    const detail = number === 1 ? 'compact' : 'detailed';
    const state = await plan(options, { steps: [action()], detail });
    assert.equal(state.plan.detail, 'compact', 'The explicit request detail takes precedence over a later tool hint.'); await completeAndReview(options, state);
    return { output: 'The chosen detail was recorded.', threadId: 'detail-' + number };
  });
  const first = await f.settle(f.start({ planningMode: 'on' }).id); finished(first);
  const second = await f.settle(f.start({ planningMode: 'maximal', planDetail: 'compact' }).id); finished(second);
  assert.equal(first.taskState.plan.detail, 'compact'); assert.equal(second.taskState.plan.detail, 'compact');
  assert.equal(second.planDetail, 'compact'); assert.equal(second.planningMode, 'off');
});

test('legacy Maximal retains explicit user-authored task evidence while final output awaits outcome review', async t => {
  const f = await fixture(t, async (options, number, context) => {
    options.onEvent({ type: 'delta', delta: 'The current observed result.' });
    assert.equal(context.engine.listRuns()[0].nodes.agent.output, '', 'Provisional output is not an accepted outcome.');
    const state = await plan(options, { steps: [action()], detail: 'compact' });
    assert.equal(state.plan.detail, 'compact');
    await completeAndReview(options, state);
    return { output: 'A sufficient optional plan was recorded.', threadId: 'planning-mode-thread' };
  });
  const run = await f.settle(f.start({ planningMode: 'maximal', planDetail: 'compact' }).id); finished(run);
  assert.equal(run.planningMode, 'off'); assert.equal(run.taskState.plan.detail, 'compact');
  assert.equal(run.taskState.steps[0].status, 'done'); assert.ok(run.taskState.steps[0].evidence);
});

test('continuation preserves the exact prior tree, evidence, notes and native schema across inert aliases', async t => {
  let saved, oldTools;
  const f = await fixture(t, async (options, number) => {
    if (number === 1) {
      let state = await plan(options, { steps: [action()] });
      state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'answer', status: 'done', evidence: 'Checked the original fixture answer.' });
      saved = await task(options, { action: 'checkpoint', expectedRevision: state.revision, goal: 'Keep useful context.', decisions: ['Keep the original observed result.'], completed: ['Original reply checked.'], nextSteps: ['Wait for the actual follow-up.'], nextAction: 'Use the next user request.' });
      saved = await completeAndReview(options, saved);
      oldTools = options.dynamicTools;
    } else if (number === 2) {
      assert.equal(options.threadId, 'planning-mode-thread'); assert.deepEqual(options.dynamicTools.map(item => item.name), oldTools.map(item => item.name));
      assert.deepEqual(options.dynamicTools, oldTools, 'Historical aliases do not replace the existing optional catalog.');
      assert.match(options.developerInstructions, /TASK PLANNING MODE: OFF/);
      assert.equal((await call(options, 'relay_workspace', { action: 'write', path: 'continued.txt', text: 'continued without automatic plan' })).success, true);
    } else {
      assert.match(options.developerInstructions, /TASK PLANNING MODE: OFF/);
      const written = await call(options, 'relay_workspace', { action: 'write', path: 'on.txt', text: 'Authorized optional work.' }); assert.equal(written.success, true);
      const current = await task(options, { action: 'read' }); assert.deepEqual(current.steps, saved.steps);
      const expanded = await plan(options, { previous: current, steps: [...current.steps, action('follow-up')] }); assert.deepEqual(expanded.steps[0], saved.steps[0]);
      await completeAndReview(options, expanded);
    }
    return { output: `Actual turn ${number}.`, threadId: 'planning-mode-thread' };
  });
  const initial = await f.settle(f.start().id); finished(initial);
  const off = await f.settle(f.engine.continueRun(initial.id, { nodeId: 'agent', message: 'Continue with automatic planning off.', planningMode: 'off' }).id); finished(off);
  assert.deepEqual(await f.tasks.get(initial.taskId), saved); assert.deepEqual(off.taskState, saved); assert.equal(initial.planningMode, 'off'); assert.equal(off.planningMode, 'off');
  const on = await f.settle(f.engine.continueRun(off.id, { nodeId: 'agent', message: 'Continue with a visible plan.', planningMode: 'on' }).id); finished(on);
  assert.equal(on.planningMode, 'off'); assert.equal(on.taskState.plan.authoredBy.runId, on.id); assert.equal(on.taskState.steps[0].evidence, 'Checked the original fixture answer.');
});

test('legacy Maximal follow-up preserves earlier completed evidence and adds fully specified current work', async t => {
  let original;
  const f = await fixture(t, async (options, number) => {
    if (number === 1) {
      const state = await plan(options, { steps: [action()] });
      original = (await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'answer', status: 'done', evidence: 'Original response checked.' })).steps[0];
    } else {
      const previous = await task(options, { action: 'read' });
      const state = await plan(options, { previous, steps: [...previous.steps, action('expanded')] });
      assert.deepEqual(state.steps[0], original);
      assert.equal(state.plan.detail, 'balanced');
      assert.ok(state.steps[1].result); assert.ok(state.steps[1].note);
    }
    await completeAndReview(options);
    return { output: 'Observed work preserved.', threadId: 'planning-mode-thread' };
  });
  const first = await f.settle(f.start().id); finished(first);
  const next = await f.settle(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Add only useful new work.', planningMode: 'maximal' }).id); finished(next);
  assert.equal(next.planningMode, 'off');
  assert.equal(next.taskState.steps[0].result, original.result);
  assert.equal(next.taskState.steps[0].note, original.note);
});

test('Retry inherits the accepted mode and an explicit override changes only the new recovery turn', async t => {
  const f = await fixture(t, async (options, number) => {
    if (number < 3) { assert.match(options.developerInstructions, /TASK PLANNING MODE: OFF/); throw Error('Observed fixture transport failure.'); }
    assert.match(options.developerInstructions, /TASK PLANNING MODE: OFF/); await completeAndReview(options, await plan(options)); return { output: 'Recovered in the selected mode.', threadId: 'planning-mode-thread' };
  });
  const first = await f.settle(f.start({ planningMode: 'off' }).id); assert.equal(first.status, 'failed');
  assert.throws(() => f.engine.retryRun(first.id, { planningMode: 'invalid' }), { code: 'PLANNING_MODE_INVALID' });
  const inherited = await f.settle(f.engine.retryRun(first.id).id); assert.equal(inherited.planningMode, 'off'); assert.equal(inherited.status, 'failed');
  const override = await f.settle(f.engine.retryRun(inherited.id, { planningMode: 'on' }).id); finished(override);
  assert.equal(override.planningMode, 'off'); assert.equal(override.nodes.agent.resumeThreadId, 'planning-mode-thread'); assert.equal(f.engine.getRun(first.id).planningMode, 'off');
});

test('mode admission is strict, has explicit precedence, and is bound into start and continuation receipts across restart', async t => {
  const f = await fixture(t, async options => { await completeAndReview(options, await plan(options)); return { output: 'Request accepted once.', threadId: 'planning-mode-thread' }; });
  assert.equal(Object.hasOwn(validateWorkflow(f.workflow).settings, 'planningMode'), false, 'Omitted legacy settings retain their receipt identity');
  for (const invalid of ['always', 'OFF', null, false, 4, {}]) {
    assert.throws(() => f.start({ planningMode: invalid }), { code: 'PLANNING_MODE_INVALID' });
    assert.throws(() => validateWorkflow({ ...f.workflow, settings: { planningMode: invalid } }), { code: 'PLANNING_MODE_INVALID' });
    await assert.rejects(f.engine.saveWorkflow({ ...f.workflow, settings: { planningMode: invalid } }), { code: 'PLANNING_MODE_INVALID' });
  }
  const mixed = await f.settle(f.start({ planningMode: 'on', input: { task: 'Request.', planningMode: 'off' } }).id); finished(mixed); assert.equal(mixed.planningMode, 'off');
  f.workflow.settings.planningMode = 'off';
  const request = { requestId: 'mode-start-once', planningMode: 'on' }, first = await f.settle(f.start(request).id); finished(first); assert.equal(first.planningMode, 'off');
  assert.equal(f.start(request).id, first.id); assert.throws(() => f.start({ ...request, planningMode: 'maximal' }), { code: 'RUN_REQUEST_CONFLICT' }, 'Receipt identity preserves the authored alias even though both execute without forced planning.');
  const continuation = { requestId: 'mode-continue-once', nodeId: 'agent', message: 'Expand this reply.', planningMode: 'maximal' };
  const next = await f.settle(f.engine.continueRun(first.id, continuation).id); finished(next); assert.equal(next.planningMode, 'off');
  await f.reopen(); assert.equal(f.start(request).id, first.id); assert.equal(f.engine.continueRun(first.id, continuation).id, next.id); assert.equal(f.runtime.calls.length, 3);
  assert.equal(f.engine.continueRun(first.id, { ...continuation, planningMode: 'off' }).id, next.id, 'Continuation receipts normalize the retired execution-mode aliases.');
  assert.throws(() => f.engine.continueRun(first.id, { ...continuation, message: 'A different request.' }), { code: 'RUN_REQUEST_CONFLICT' });
  assert.throws(() => f.engine.continueRun(first.id, { ...continuation, planningMode: undefined }), { code: 'RUN_REQUEST_CONFLICT' });
  const inherited = await f.settle(f.engine.continueRun(next.id, { nodeId: 'agent', message: 'Use the saved choice.' }).id); finished(inherited); assert.equal(inherited.planningMode, 'off');
});

test('missing-mode receipts remain recoverable without permitting a changed authored Off request', async t => {
  const f = await fixture(t, async options => { await completeAndReview(options, await plan(options)); return { output: 'Legacy-compatible default.', threadId: 'planning-mode-thread' }; });
  const request = { requestId: 'old-start-receipt' }, first = await f.settle(f.start(request).id); finished(first);
  delete f.engine.runs.get(first.id).planningMode;
  delete f.engine.runs.get(first.id).nodes.agent.planning.mode;
  await f.reopen(); assert.equal(f.start(request).id, first.id); assert.equal(f.runtime.calls.length, 1);
  assert.throws(() => f.start({ ...request, planningMode: 'off' }), { code: 'RUN_REQUEST_CONFLICT' });
  const resumed = await f.settle(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue a legacy default request.' }).id); finished(resumed); assert.equal(resumed.planningMode, 'off');
});

for (const scenario of [
  { label: 'advertised object levels', advertised: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'max' }], expected: 'low', source: 'application-default' },
  { label: 'explicit model default', advertised: ['low', 'high'], requested: 'default', expected: 'default', source: 'request' },
  { label: 'explicit concrete override', advertised: ['low', 'high'], requested: 'low', expected: 'low', source: 'request' },
  { label: 'unknown provider support', advertised: [], defaultEffort: 'medium', expected: 'medium', source: 'application-default' },
  { label: 'unknown advertised token', advertised: ['unlimited'], requested: 'default', expected: 'default', source: 'request' },
]) test(`Planning aliases never select model effort: ${scenario.label}`, async t => {
  const f = await fixture(t, async options => { assert.equal(options.effort, scenario.expected); await completeAndReview(options, await plan(options)); return { output: 'Actual fixture result.', threadId: 'planning-mode-thread' }; });
  f.runtime.models[0].supportedReasoningEfforts = scenario.advertised; f.settings.defaultEffort = scenario.defaultEffort || 'low';
  if (scenario.requested) f.workflow.nodes[1].effort = scenario.requested;
  const run = await f.settle(f.start({ planningMode: 'maximal' }).id); finished(run);
  assert.equal(run.workflow.nodes[1].effort, scenario.expected);
  assert.deepEqual(run.nodes.agent.effortSelection, { effort: scenario.expected, source: scenario.source, requestedEffort: scenario.requested ?? null });
});

test('planning stays independent of model effort while concrete user overrides remain authoritative', async t => {
  const expected = ['default', 'default', 'default', 'low', 'low'];
  const f = await fixture(t, async (options, number) => {
    assert.equal(options.effort, expected[number - 1]);
    if (number !== 3) await completeAndReview(options, await plan(options));
    return { output: 'Effort selection follows this turn.', threadId: 'planning-mode-thread' };
  });
  f.runtime.models.push({ id: 'narrow-model', supportsTools: true, supportedReasoningEfforts: ['low'] });
  const first = await f.settle(f.start({ planningMode: 'maximal' }).id); finished(first);
  const narrow = await f.settle(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Use the narrower model.', model: 'narrow-model' }).id); finished(narrow);
  const off = await f.settle(f.engine.continueRun(narrow.id, { nodeId: 'agent', message: 'Turn planning off.', planningMode: 'off' }).id); finished(off);
  const explicit = await f.settle(f.engine.continueRun(off.id, { nodeId: 'agent', message: 'Use low explicitly.', planningMode: 'on', effort: 'low' }).id); finished(explicit);
  const preserved = await f.settle(f.engine.continueRun(explicit.id, { nodeId: 'agent', message: 'Expand the plan with the same effort.', planningMode: 'maximal', model: 'fixture-model' }).id); finished(preserved);
  assert.equal(preserved.nodes.agent.effortSelection.source, 'request'); assert.equal(f.engine.getRun(first.id).workflow.nodes[1].effort, 'default');
});

test('a saved Inbox workflow keeps each selected mode across restart and real engine dispatch', async t => {
  const f = await fixture(t, async (options, number, context) => {
    const mode = context.engine.listRuns().find(run => run.status === 'running').planningMode;
    if (mode === 'off') assert.match(options.developerInstructions, /TASK PLANNING MODE: OFF/); else await completeAndReview(options, await plan(options));
    return { output: 'Queued mode honored.', threadId: `queued-mode-${number}` };
  });
  const options = { dataDir: f.directory, engine: f.engine, delayMs: 0 }; let inbox = await new TaskInbox(options).init();
  try {
    const items = [];
    for (const mode of ['maximal', 'on', 'auto', 'off']) items.push(await inbox.add({ input: `Use saved ${mode} planning.`, cwd: f.cwd, workflow: { ...f.workflow, settings: { planningMode: mode, maxParallel: 1 } } }));
    await inbox.close(); inbox = await new TaskInbox(options).init();
    for (const item of items) {
      assert.equal(inbox.get(item.id).workflow.settings.planningMode, item.workflow.settings.planningMode);
      const receipt = await inbox.runNow(item.id), run = await f.settle(receipt.run.id); finished(run);
      assert.equal(run.planningMode, 'off'); assert.equal(run.nodes.agent.planning.mode, run.planningMode); await inbox.reconcile();
    }
  } finally { await inbox.close(); }
  assert.equal(f.runtime.calls.length, 4);
});

test('a saved cron Maximal alias migrates to nonblocking execution across restart', async t => {
  const f = await fixture(t, async options => { await completeAndReview(options, await plan(options)); return { output: 'The scheduled workflow kept its mode.', threadId: 'scheduled-mode-thread' }; });
  let now = Date.parse('2026-10-19T12:00:00Z');
  const inbox = await new TaskInbox({ dataDir: f.directory, engine: f.engine }).init(), options = { dataDir: f.directory, inbox, engine: f.engine, clock: () => now, pollMs: 100000 };
  let operations = await new OperationsStore(options).init(); operations.kick = () => {};
  try {
    const deployment = await operations.create({ name: 'Bounded planning fixture', input: 'Run one local planning check.', cwd: f.cwd, workflow: { ...f.workflow, settings: { planningMode: 'maximal', maxParallel: 1 } }, enabled: true, trigger: { type: 'cron', expression: '* * * * *', timezone: 'UTC' }, limits: { maxIterations: 1 } });
    await operations.close(); operations = await new OperationsStore(options).init(); operations.kick = () => {};
    assert.equal(operations.getDeployment(deployment.id).workflow.settings.planningMode, 'off');
    assert.equal(operations.status().paused, true); await operations.resume();
    now += 60000; await operations.poll();
    const admitted = operations.snapshot().jobs[0]; assert.ok(admitted); assert.equal(admitted.definition.workflow.settings.planningMode, 'off');
    const run = await until(() => f.engine.listRuns()[0]); const settled = await f.settle(run.id); finished(settled); assert.equal(settled.planningMode, 'off'); assert.equal(settled.nodes.agent.planning.status, 'off');
    await operations.poll(); assert.equal(operations.getJob(admitted.id).status, 'completed'); now += 120000; await operations.poll(); assert.equal(f.runtime.calls.length, 1);
  } finally { await operations.close(); await inbox.close(); }
});

test('Off keeps optional legacy task tools and external recovery guidance without importing default plan playbooks', () => {
  for (const version of [1, 2, 3, 4, 5]) {
    const instructions = capabilityGuidance([taskToolForVersion(version, { executionGuardrails: true })], { planningMode: 'off', executionGuardrails: true });
    assert.match(instructions, /Automatic planning is off/);
    assert.doesNotMatch(instructions, /before operational work or the final answer|save this turn's plan|form a brief operational plan|For substantive work, discover relevant methods/);
    if (version >= 3) assert.match(instructions, /Reconcile uncertain effects before retry/);
  }
  assert.doesNotMatch(capabilityGuidance([], { planningMode: 'off' }), /form a brief operational plan/);
});

test('Off identity and disabled automatic planning apply to delegated workers without changing coordinator ownership', async t => {
  const f = await fixture(t, async options => {
    assert.ok(options.developerInstructions.startsWith(BLACKICE_HARNESS_INSTRUCTIONS)); assert.match(options.developerInstructions, /TASK PLANNING MODE: OFF/);
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_task')); assert.doesNotMatch(options.developerInstructions, /form a brief operational plan/);
      assert.match(options.developerInstructions, /The coordinator owns the final remote send/);
      return { output: 'Observed independent fixture result.' };
    }
    const result = await call(options, 'relay_delegate', { tasks: [{ id: 'inspect', prompt: 'Inspect the supplied fixture request without external actions.' }, { id: 'inspect-tools', prompt: 'Independently inspect the supplied worker tool catalog without external actions.' }] });
    assert.equal(result.success, true); assert.equal(unpack(result).allCompleted, true);
    return { output: 'Worker result received.', threadId: 'planning-mode-thread' };
  });
  f.settings.subagentsEnabled = true;
  const run = await f.settle(f.start({ planningMode: 'off' }).id); finished(run); assert.equal(f.runtime.calls.length, 3); assert.equal(run.nodes.agent.planning.status, 'off');
});

test('invalid saved planning modes recover through the existing backup path and preserve corrupt evidence', async t => {
  const f = await fixture(t, async options => ({ output: 'Saved Off result.', threadId: 'planning-mode-thread' }));
  const first = await f.settle(f.start({ planningMode: 'off' }).id); finished(first); await f.engine.persist(); await f.engine.close();
  const file = path.join(f.directory, 'runs.json'), raw = JSON.parse(await readFile(file, 'utf8')); raw[0].planningMode = 'unbounded'; await writeFile(file, JSON.stringify(raw));
  await f.reopen(); assert.equal(f.engine.getRun(first.id).planningMode, 'off'); assert.ok(f.engine.storageStatus().recovered.includes('runs.json'));
  const preserved = (await readdir(f.directory)).find(name => name.startsWith('runs.json.corrupt-')); assert.ok(preserved); assert.match(await readFile(path.join(f.directory, preserved), 'utf8'), /unbounded/);
});


test('archived run restoration rejects invalid saved planning modes before admitting the snapshot', async t => {
  const f = await fixture(t, async () => ({ output: 'Original receipt.', threadId: 'planning-mode-thread' }));
  const run = await f.settle(f.start({ planningMode: 'off' }).id); finished(run);
  const invalid = { ...structuredClone(run), id: 'bad-planning-archive', planningMode: 'forever' };
  assert.throws(() => f.engine.restoreArchivedRun(invalid), { code: 'PLANNING_MODE_INVALID' });
  invalid.planningMode = 'off'; invalid.nodes.agent.planning.mode = 'forever';
  assert.throws(() => f.engine.restoreArchivedRun(invalid), { code: 'PLANNING_MODE_INVALID' });
  assert.equal(f.engine.runs.has(invalid.id), false); assert.equal(f.runtime.calls.length, 1);
});

test('inherited application effort keeps its origin across ordinary follow-ups and Retry before a later Maximal turn', async t => {
  const expected = ['medium', 'medium', 'medium', 'medium'];
  const f = await fixture(t, async (options, number) => {
    assert.equal(options.effort, expected[number - 1]); await plan(options);
    if (number === 2) throw Error('Observed fixture failure after a recorded plan.');
    await completeAndReview(options);
    return { output: 'Saved effort origin preserved.', threadId: 'planning-mode-thread' };
  });
  f.settings.defaultEffort = 'medium';
  const first = await f.settle(f.start().id); finished(first); f.settings.defaultEffort = 'low';
  const second = await f.settle(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue with this chat’s saved effort.' }).id); assert.equal(second.status, 'failed');
  const retried = await f.settle(f.engine.retryRun(second.id).id); finished(retried);
  for (const run of [first, second, retried]) assert.deepEqual(run.nodes.agent.effortSelection, { effort: 'medium', source: 'application-default', requestedEffort: null });
  const maximal = await f.settle(f.engine.continueRun(retried.id, { nodeId: 'agent', message: 'Now use Maximal planning.', planningMode: 'maximal' }).id); finished(maximal);
  assert.notEqual(maximal.nodes.agent.effortSelection.source, 'maximal-model-catalog'); assert.equal(maximal.nodes.agent.planning.mode, 'off');
});

for (const limitation of ['tool-less model', 'legacy catalog']) test(`Off reports task capability accurately for a ${limitation}`, async t => {
  const f = await fixture(t, async options => ({ output: 'Ordinary Off reply.', threadId: 'planning-mode-thread' }));
  if (limitation === 'tool-less model') f.runtime.models[0].supportsTools = false;
  let run = await f.settle(f.start({ planningMode: 'off' }).id); finished(run);
  if (limitation === 'legacy catalog') {
    const previous = f.engine.runs.get(run.id); previous.nodes.agent.toolNames = ['relay_workspace']; previous.nodes.agent.taskSchemaVersion = 1;
    run = await f.settle(f.engine.continueRun(run.id, { nodeId: 'agent', message: 'Continue without changing the saved catalog.' }).id); finished(run);
  }
  assert.equal(run.nodes.agent.planning.mode, 'off'); assert.equal(run.nodes.agent.planning.status, 'off');
  assert.match(run.nodes.agent.planning.message, /does not expose task-state tools/); assert.doesNotMatch(run.nodes.agent.planning.message, /planning tools remain available/);
  assert.ok(!(f.runtime.calls.at(-1).dynamicTools || []).some(tool => tool.name === 'relay_task'));
});

test('optional authoring requires a correct revision but no mandatory fresh-read checkpoint', async t => {
  const f = await fixture(t, async options => {
    const accepted = await call(options, 'relay_task', { action: 'plan', expectedRevision: 1, plan: { layout: 'sequence' }, steps: [detailedAction()] });
    assert.equal(accepted.success, true); const state = unpack(accepted);
    const stale = await call(options, 'relay_task', { action: 'plan', expectedRevision: 1, steps: [] });
    assert.equal(stale.code, 'TASK_STATE_CONFLICT');
    await completeAndReview(options, state);
    return { output: 'The explicit revision was respected.', threadId: 'planning-mode-thread' };
  });
  finished(await f.settle(f.start().id));
});

test('republishing completed history preserves its evidence without gating new authorized operations',async t=>{
  let previousEvidence;
  const f=await fixture(t,async (options,number)=>{
    if(number===1){
      const planned=await plan(options);
      const done=await task(options,{action:'step',expectedRevision:planned.revision,stepId:'answer',status:'done',evidence:'The original fixture input and constraints were checked.'});
      previousEvidence=done.steps[0].evidence;
      await completeAndReview(options, done);
      return {output:'The original task is complete.',threadId:'planning-mode-thread'};
    }
    const current=await task(options,{action:'read'});
    const history=await task(options,{action:'plan',expectedRevision:current.revision,steps:current.steps,plan:{layout:'sequence'}});
    assert.equal(history.steps[0].evidence,previousEvidence);
    const denied=await call(options,'relay_workspace',{action:'write',path:'history-only.txt',text:'current authorized work'});
    assert.equal(denied.success,true);
    return {output:'A new answer without new work.',threadId:'planning-mode-thread'};
  });
  const original=await f.settle(f.start().id);finished(original);
  const next=await f.settle(f.engine.continueRun(original.id,{nodeId:'agent',message:'A different current request.'}).id);
  finished(next);assert.equal(next.nodes.agent.planning.status,'off');
  assert.equal(next.nodes.agent.output,'A new answer without new work.');assert.equal(next.taskState.steps[0].evidence,previousEvidence);
  assert.equal(await readFile(path.join(f.cwd,'history-only.txt'),'utf8'),'current authorized work');
});

test('current prospective work can be added beside completed history without rewriting it',async t=>{
  let originalStep;
  const f=await fixture(t,async (options,number)=>{
    if(number===1){
      const planned=await plan(options);
      originalStep=(await task(options,{action:'step',expectedRevision:planned.revision,stepId:'answer',status:'done',evidence:'The first request was checked against its supplied input.'})).steps[0];
    }else{
      const current=await task(options,{action:'read'});
      const planned=await plan(options,{previous:current,steps:[...current.steps,{...detailedAction('current'),operation:{kind:'tool',tool:'relay_workspace',action:'write',target:'current.txt'},note:'Write current.txt once with the current fixture result.'}]});
      assert.deepEqual(planned.steps[0],originalStep);
      const written=await call(options,'relay_workspace',{action:'write',path:'current.txt',text:'current turn effect'});
      assert.equal(written.success,true);
      await task(options,{action:'step',expectedRevision:planned.revision,stepId:'current',status:'done',evidence:'The write receipt reports current.txt containing the current-turn result.'});
    }
    await completeAndReview(options);
    return {output:'The actual current work was handled.',threadId:'planning-mode-thread'};
  });
  const first=await f.settle(f.start().id);finished(first);
  const next=await f.settle(f.engine.continueRun(first.id,{nodeId:'agent',message:'Perform the current fixture work.'}).id);finished(next);
  assert.deepEqual(next.taskState.steps[0],originalStep);
  assert.equal(next.taskState.progress.complete,true);
  assert.equal(await readFile(path.join(f.cwd,'current.txt'),'utf8'),'current turn effect');
});

test('ordinary module candidates stay provisional until actual outcome review accepts them',async t=>{
  const f=await fixture(t,async (options,number,context)=>{
    options.onEvent({type:'delta',itemId:'premature',delta:'Provisional current observation.'});
    options.onEvent({type:'message',text:'A later provisional observation.'});
    await completeAndReview(options, await plan(options));
    assert.equal(context.engine.listRuns()[0].nodes.agent.output,'','An optional task-note review does not substitute for the actual outcome review.');
    options.onEvent({type:'delta',itemId:'grounded',delta:'The answer produced after the prospective plan.'});
    return {output:'The answer produced after the prospective plan.',threadId:'planning-mode-thread'};
  });
  const run=await f.settle(f.start().id);finished(run);
  assert.equal(run.nodes.agent.output,'The answer produced after the prospective plan.');
  assert.doesNotMatch(run.output,/Provisional current observation|later provisional observation/);
});

test('a legacy On alias permits truthful partial results without marking unresolved work complete',async t=>{
  const f=await fixture(t,async options=>{
    const planned=await plan(options,{steps:[detailedAction()]});
    const current=await task(options,{action:'step',expectedRevision:planned.revision,stepId:'answer',status:'blocked',blockedReason:'The fixture input omits the values needed for the comparison.'});
    assert.equal(current.steps[0].status,'blocked');
    await completeAndReview(options, current, 'blocked');
    return {output:'The supplied inputs do not establish the requested comparison. The unresolved action remains blocked.',threadId:'planning-mode-thread'};
  });
  const run=await f.settle(f.start().id);finished(run);
  assert.equal(run.taskState.steps[0].status,'blocked');
  assert.equal(run.taskState.progress.complete,false);
  assert.equal(run.nodes.agent.planning.status,'off');
});

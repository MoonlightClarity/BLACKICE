// Current engine modes and explicit owner task state. No historical model catalog adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine, validateWorkflow } from '../lib/engine.mjs';
import { persistedRunRows } from './fixture-persisted-runs.mjs';
import { TaskStateStore, currentTaskTool } from '../lib/task-state.mjs';
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
const action = (id = 'answer', status = 'active') => ({ id, kind: 'action', parentId: null, title: 'Answer the current request', status, operation: { kind: 'reasoning', target: `The ${id} fixture question and supplied input` }, doneWhen: 'The response contains the requested result and any relevant limits.', result: 'A direct answer to the supplied fixture inputs.', note: 'Use the supplied fixture input to construct the answer and compare it with the explicit request constraints.' });
const detailedAction = (id = 'answer', status = 'active') => ({ ...action(id, status), result: 'A direct answer to the actual user request.', note: 'Use the supplied inputs, check that the response answers the request, and report only performed work.' });
const finished = run => assert.equal(run.status, 'completed', run.error || run.nodes.agent.error);
async function fixture(t, execute) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-mode-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), methods = await new MethodStore({ dataDir: directory, projects: { definition() {}, create() {} } }).init();
  let context;
  class Runtime extends EventEmitter {
    constructor() { super(); this.calls = []; this.models = [{ id: 'fixture-model', supportsTools: true, supportedReasoningEfforts: ['low', 'medium', 'high'] }]; }
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: this.models }; }
    async runAgent(options) {
      assert.notEqual(options.responseOnly,true,'No automatic reviewer turn is admitted.');
      assert.equal(options.onBeforeFinal,undefined,'No automatic final-review hook is installed.');
      this.calls.push(options);
      options.onEvent({ type: 'thread', threadId: options.threadId || 'planning-mode-thread', model: options.model || 'fixture-model' });
      return execute(options, this.calls.length, context);
    }
    async close() {}
  }
  // Historical mode values normalize through the actual current engine; no legacy schema is stamped.
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

for (const mode of ['auto', 'on', 'maximal', 'forced', 'advisory']) test(mode + ' normalizes without retired operation gates or model effort changes', async t => {
  const f = await fixture(t, async options => {
    assert.ok(options.developerInstructions.startsWith(BLACKICE_HARNESS_INSTRUCTIONS));
    assert.doesNotMatch(options.developerInstructions, /BLACKICE PLANNING MODULES/);
    const planningTool=options.dynamicTools.find(tool=>tool.name==='relay_task'||tool.name==='relay_planning_read');
    if(planningTool)assert.match(planningTool.description,/task|planning/i);
    assert.doesNotMatch(options.developerInstructions, /REQUIRED FIRST-PARTY BLACKICE PLANNING SKILL/);
    assert.equal(typeof options.onBeforeFinal, 'undefined');
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
    assert.equal(typeof options.onBeforeFinal, 'undefined');
    return { output: 'The fixture answered without a sequence guard.' };
  });
  f.settings.executionGuardrails = false;
  const run = await f.settle(f.start({ planningMode: 'on' }).id); finished(run);
  assert.equal(run.nodes.agent.planningSkill, undefined);
  assert.equal(run.nodes.agent.output, 'The fixture answered without a sequence guard.');
});

test('coordinator and independent read-only workers use the current catalog without the retired skill', async t => {
  const f = await fixture(t, async options => {
    assert.doesNotMatch(options.developerInstructions, /REQUIRED FIRST-PARTY BLACKICE PLANNING SKILL/);
    if (options.prompt.includes('YOUR ASSIGNED TASK:')) {
      assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_task'));
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
    assert.equal(typeof options.onBeforeFinal, 'undefined'); assert.equal(options.dynamicTools, undefined);
    return { output: 'A direct model answer.' };
  });
  f.runtime.models[0].supportsTools = false;
  const run = await f.settle(f.start({ planningMode: 'on' }).id); finished(run);
  assert.equal(run.nodes.agent.planning.mode, 'off'); assert.equal(run.nodes.agent.planning.status, 'off');
  assert.equal(f.runtime.calls.length, 1); assert.equal(run.nodes.agent.output, 'A direct model answer.');
});

test('a current native session keeps its exact task catalog across an inert mode alias',async t=>{
 let catalog;
 const f=await fixture(t,async(options,number)=>{
  if(number===1)catalog=structuredClone(options.dynamicTools);
  else {assert.equal(options.threadId,'planning-mode-thread');assert.deepEqual(options.dynamicTools,catalog);}
  return {output:'Current native catalog retained.',threadId:'planning-mode-thread'};
 });
 const first=await f.settle(f.start({planningMode:'off'}).id);finished(first);
 const next=await f.settle(f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue current work.',planningMode:'on'}).id);finished(next);
 assert.equal(next.taskId,first.taskId);assert.equal(next.conversationId,first.conversationId);assert.equal(next.modelHandoff,undefined);assert.equal(f.runtime.calls.length,2);
});

test('Off permits normal operations and final output without creating an automatic outline or method lookup', async t => {
  const f = await fixture(t, async options => {
    assert.ok(options.developerInstructions.startsWith(BLACKICE_HARNESS_INSTRUCTIONS));
    assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|FIRST-PARTY BLACKICE PLANNING SKILL/);
    assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|Maintain the current task outline|form a brief operational plan|For substantive work, discover relevant methods/);
    assert.doesNotMatch(options.prompt, /DEFAULT TASK OUTLINE|METHOD DISCOVERY AND ADAPTATION/);
    assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_task'));
    assert.ok(options.dynamicTools.some(tool=>/receipt|reconcil|uncertain/i.test(tool.description)), 'Recovery guidance remains on actual tools');
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

test('Retry inherits the accepted mode and an explicit override changes only the new recovery turn', async t => {
  const f = await fixture(t, async (options, number) => {
    if (number < 3) { assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|FIRST-PARTY BLACKICE PLANNING SKILL/); throw Error('Observed fixture transport failure.'); }
    assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|FIRST-PARTY BLACKICE PLANNING SKILL/);  return { output: 'Recovered in the selected mode.', threadId: 'planning-mode-thread' };
  });
  const first = await f.settle(f.start({ planningMode: 'off' }).id); assert.equal(first.status, 'failed');
  assert.throws(() => f.engine.retryRun(first.id, { planningMode: 'invalid' }), { code: 'PLANNING_MODE_INVALID' });
  const inherited = await f.settle(f.engine.retryRun(first.id).id); assert.equal(inherited.planningMode, 'off'); assert.equal(inherited.status, 'failed');
  const override = await f.settle(f.engine.retryRun(inherited.id, { planningMode: 'on' }).id); finished(override);
  assert.equal(override.planningMode, 'off'); assert.equal(override.nodes.agent.resumeThreadId, 'planning-mode-thread'); assert.equal(f.engine.getRun(first.id).planningMode, 'off');
});

test('mode admission is strict, has explicit precedence, and is bound into start and continuation receipts across restart', async t => {
  const f = await fixture(t, async options => {  return { output: 'Request accepted once.', threadId: 'planning-mode-thread' }; });
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
  const f = await fixture(t, async options => {  return { output: 'Legacy-compatible default.', threadId: 'planning-mode-thread' }; });
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
  const f = await fixture(t, async options => { assert.equal(options.effort, scenario.expected);  return { output: 'Actual fixture result.', threadId: 'planning-mode-thread' }; });
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
    if (mode === 'off') assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|FIRST-PARTY BLACKICE PLANNING SKILL/);
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
  const f = await fixture(t, async options => {  return { output: 'The scheduled workflow kept its mode.', threadId: 'scheduled-mode-thread' }; });
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

test('Off keeps the current optional task tool and external recovery guidance without importing default plan playbooks', () => {
  for (const executionGuardrails of [false, true]) {
    const instructions = BLACKICE_HARNESS_INSTRUCTIONS + capabilityGuidance([currentTaskTool({ executionGuardrails })], { planningMode: 'off', executionGuardrails: true });
    assert.match(instructions, /Automatic planning is off/);
    assert.doesNotMatch(instructions, /before operational work or the final answer|save this turn's plan|form a brief operational plan|For substantive work, discover relevant methods/);
    assert.match(instructions, /When a tool says input was not dispatched, refresh the needed state and retry with corrected arguments/);
    assert.match(instructions, /If it may have run, inspect the saved receipt or destination before repeating that action/);
    assert.match(instructions, /Continue independent work while checking/);
  }
  assert.doesNotMatch(capabilityGuidance([], { planningMode: 'off' }), /form a brief operational plan/);
});

test('Off identity and disabled automatic planning apply to delegated workers within current assigned scope', async t => {
  const f = await fixture(t, async options => {
    assert.ok(options.developerInstructions.startsWith(BLACKICE_HARNESS_INSTRUCTIONS)); assert.doesNotMatch(options.developerInstructions, /DEFAULT TASK WORKSPACE|FIRST-PARTY BLACKICE PLANNING SKILL/);
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_task')); assert.doesNotMatch(options.developerInstructions, /form a brief operational plan/);
      assert.match(options.developerInstructions, /Maintain the exact assigned canonical work-item IDs/);
      assert.ok(!options.dynamicTools.some(tool=>['relay_delegate','relay_control'].includes(tool.name)));
      return { output: 'Observed independent fixture result.' };
    }
    const result = await call(options, 'relay_delegate', { tasks: [{ id: 'inspect', prompt: 'Inspect the supplied fixture request without external actions.' }, { id: 'inspect-tools', prompt: 'Independently inspect the supplied worker tool catalog without external actions.' }] });
    assert.equal(result.success, true,JSON.stringify(result)); assert.equal(unpack(result).allCompleted, true,JSON.stringify(unpack(result)));
    return { output: 'Worker result received.', threadId: 'planning-mode-thread' };
  });
  f.settings.subagentsEnabled = true;
  const run = await f.settle(f.start({ planningMode: 'off' }).id); finished(run); assert.equal(f.runtime.calls.length, 3); assert.equal(run.nodes.agent.planning.status, 'off');
});

test('invalid saved planning modes recover through the existing backup path and preserve corrupt evidence', async t => {
  const f = await fixture(t, async options => ({ output: 'Saved Off result.', threadId: 'planning-mode-thread' }));
  const first = await f.settle(f.start({ planningMode: 'off' }).id); finished(first); await f.engine.close();
  const valid = persistedRunRows(f.directory);
  const malformed = structuredClone(valid); malformed[0].planningMode = 'unbounded';
  // Deliberately simulate first import from an old profile, not a new engine writing JSON.
  await rm(path.join(f.directory, 'run-state.sqlite'));
  await writeFile(path.join(f.directory, 'runs.json.bak'), JSON.stringify(valid));
  await writeFile(path.join(f.directory, 'runs.json'), JSON.stringify(malformed));
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
    assert.equal(options.effort, expected[number - 1]);
    if (number === 2) throw Error('Observed fixture failure after a recorded plan.');

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

test('Off reports unavailable task tools accurately for a tool-less model',async t=>{
 const f=await fixture(t,async()=>({output:'Ordinary Off reply.',threadId:'planning-mode-thread'}));f.runtime.models[0].supportsTools=false;
 const run=await f.settle(f.start({planningMode:'off'}).id);finished(run);
 assert.equal(run.nodes.agent.planning.status,'off');assert.match(run.nodes.agent.planning.message,/does not expose task-state tools/);
 assert.ok(!(f.runtime.calls.at(-1).dynamicTools||[]).some(tool=>tool.name==='relay_task'));
});
test('a manually altered pinned catalog cannot silently resume with a different contract',async t=>{
 const f=await fixture(t,async()=>({output:'Original current reply.',threadId:'planning-mode-thread'}));
 const first=await f.settle(f.start().id);finished(first);
 const saved=f.engine.runs.get(first.id);saved.nodes.agent.toolNames=['relay_workspace'];
 const next=await f.settle(f.engine.continueRun(first.id,{nodeId:'agent',message:'Resume altered catalog.'}).id);
 assert.equal(next.status,'failed');assert.match(next.error||next.nodes.agent.error,/different execution contract or tool catalog/);assert.equal(f.runtime.calls.length,1);
 assert.equal(f.engine.getRun(first.id).output,first.output);
});

test('ordinary deltas stream and final response replaces provisional text without an automatic review',async t=>{
  const f=await fixture(t,async (options,number,context)=>{
    options.onEvent({type:'delta',itemId:'premature',delta:'Provisional current observation.'});
    options.onEvent({type:'message',text:'A later provisional observation.'});

    assert.equal(context.engine.listRuns()[0].nodes.agent.output,'Provisional current observation.','Ordinary deltas stream without hidden review.');
    options.onEvent({type:'delta',itemId:'grounded',delta:'The answer produced after the prospective plan.'});
    return {output:'The answer produced after the prospective plan.',threadId:'planning-mode-thread'};
  });
  const run=await f.settle(f.start().id);finished(run);
  assert.equal(run.nodes.agent.output,'The answer produced after the prospective plan.');
  assert.doesNotMatch(run.output,/Provisional current observation|later provisional observation/);
});


const canonicalContract=()=>({contractVersion:2,goal:'Answer the supplied request',criteria:[{id:'answer',kind:'judgment',description:'Answer matches supplied inputs'}],workItems:[{id:'answer',title:'Inspect supplied input',objective:'Derive an answer from the supplied input',owner:'agent',resourceKeys:['fixture'],effects:['observe'],dependsOn:[],criterionIds:['answer']}],instructions:[]});
test('optional current model authoring uses exact revision without a mandatory preliminary read',async t=>{
 const f=await fixture(t,async options=>{
  const accepted=await call(options,'relay_task',{action:'plan',expectedRevision:1,contract:canonicalContract()});assert.equal(accepted.success,true,accepted.contentItems?.[0]?.text);
  const stale=await call(options,'relay_task',{action:'plan',expectedRevision:1,contract:canonicalContract()});assert.equal(stale.code,'TASK_STATE_CONFLICT');
  const unsupported=await call(options,'relay_task',{action:'step',expectedRevision:2,stepId:'answer',status:'done',evidence:'Unverified claim'});assert.equal(unsupported.success,false);
  return {output:'Authored intent is not completion evidence.',threadId:'planning-mode-thread'};
 });
 const run=await f.settle(f.start({input:'/plan Author the optional fixture outline.',planDetail:'compact',planningMode:'maximal'}).id);finished(run);
 const state=await f.tasks.get(run.taskId);assert.equal(state.contract.workItems[0].id,'answer');assert.equal(state.contract.workItems[0].status,undefined);assert.equal(run.planDetail,'compact');assert.equal(run.planningMode,'off');
});

test('human-authored tree, completed evidence and checkpoint survive current continuation, expansion and restart',async t=>{
 let catalog;
 const f=await fixture(t,async(options,number)=>{
  if(number===1)catalog=structuredClone(options.dynamicTools);else assert.deepEqual(options.dynamicTools,catalog);
  const receipt=await call(options,'relay_workspace',{action:'write',path:'continued.txt',text:'current authorized effect'});assert.equal(receipt.success,true);
  return {output:'Actual effect completed without automatic planning.',threadId:'planning-mode-thread'};
 });
 const first=await f.settle(f.start().id);finished(first);
 let state=await f.tasks.get(first.taskId);
 state=await f.tasks.setPlan(first.taskId,{steps:[detailedAction()],plan:{layout:'sequence',detail:'compact'}},{expectedRevision:state.revision});
 state=await f.tasks.setStep(first.taskId,'answer',{status:'done',evidence:'Owner checked original fixture input.'},{expectedRevision:state.revision});
 state=await f.tasks.checkpoint(first.taskId,{goal:state.goal,decisions:['Keep checked evidence'],completed:['Original check'],nextSteps:['Await current request'],nextAction:'Inspect the new request'},{expectedRevision:state.revision});
 const original=await f.tasks.get(first.taskId);await f.reopen();
 const next=await f.settle(f.engine.continueRun(first.id,{nodeId:'agent',message:'Perform new authorized work.',planningMode:'maximal'}).id);finished(next);
 const retained=await f.tasks.get(first.taskId);assert.deepEqual(retained,original);
 for(const key of ['steps','checkpoint','plan','revision','goal'])assert.deepEqual(next.taskState[key],original[key]);
 state=await f.tasks.setPlan(first.taskId,{steps:[...original.steps,detailedAction('current','pending')],plan:{layout:'sequence',detail:'compact'}},{expectedRevision:original.revision});
 assert.deepEqual(state.steps[0],original.steps[0]);const {nextAction,...priorCheckpoint}=original.checkpoint;assert.deepEqual(state.checkpoint,{...priorCheckpoint,supersededNextAction:{text:nextAction,previousStepId:null,currentStepId:'current',reason:'plan-focus-changed'}});assert.equal(state.steps[1].status,'pending');assert.equal(state.plan.detail,'compact');
 const last=await f.settle(f.engine.continueRun(next.id,{nodeId:'agent',message:'Report current progress.',planningMode:'off'}).id);finished(last);
 const after=await f.tasks.get(first.taskId);assert.deepEqual(after.steps,state.steps);assert.deepEqual(after.checkpoint,state.checkpoint);assert.equal(after.progress.complete,false);
 assert.equal(await readFile(path.join(f.cwd,'continued.txt'),'utf8'),'current authorized effect');
});

test('a partial response preserves owner-recorded blocked work without automatically completing it',async t=>{
 const f=await fixture(t,async()=>({output:'Missing fixture values remain unresolved.',threadId:'planning-mode-thread'}));
 const first=await f.settle(f.start().id);finished(first);let state=await f.tasks.get(first.taskId);
 state=await f.tasks.setPlan(first.taskId,{steps:[detailedAction()],plan:{layout:'sequence'}},{expectedRevision:state.revision});
 state=await f.tasks.setStep(first.taskId,'answer',{status:'blocked',blockedReason:'Fixture values are absent.'},{expectedRevision:state.revision});
 const next=await f.settle(f.engine.continueRun(first.id,{nodeId:'agent',message:'Report the missing inputs.',planningMode:'on'}).id);finished(next);
 const after=await f.tasks.get(first.taskId);assert.deepEqual(after.steps,state.steps);assert.equal(after.progress.complete,false);assert.equal(next.nodes.agent.planning.status,'off');
});

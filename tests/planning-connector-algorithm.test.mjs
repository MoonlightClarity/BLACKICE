import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteAgentAPI, validRemoteArguments } from '../lib/remote-agent-api.mjs';
import { ChatGPTPlanningAPI } from '../lib/chatgpt-planning.mjs';
import { createChatGPTToolCatalog } from '../lib/chatgpt-tool-catalog.mjs';
import { TaskStateStore, TASK_TOOL, taskToolForVersion } from '../lib/task-state.mjs';

const client = { id: 'algorithm-client', kind: 'agent', label: 'Connected planning client', scopes: ['read', 'planning:write'] };
const literal = value => ({ value });
const fact = id => ({ fact: id });
const compare = (left, op, right) => ({ compare: { left, op, right } });
const outerBranch = () => ({ if: { and: [fact('ready'), { not: fact('blocked') }] }, then: 'fast',
  elif: [{ if: { and: [compare(fact('score'), '>=', literal(3)), compare(fact('region'), 'in', literal(['north', 'west']))] }, then: 'slow' }], else: 'wait' });
const innerBranch = () => ({ if: { xor: [fact('cached'), { not: compare(fact('optional'), 'is', literal(null)) }] }, then: 'reuse', else: 'fetch' });
const facts = (ready = null, cached = true) => [
  { id: 'ready', value: ready, ...(ready === null ? {} : { evidence: 'The source reported its actual readiness.' }) },
  { id: 'blocked', value: false, evidence: 'No source blocker was observed.' },
  { id: 'score', value: 4, evidence: 'The response returned score 4.' },
  { id: 'region', value: 'north', evidence: 'The response named the north region.' },
  { id: 'cached', value: cached, evidence: 'The cache observation returned this Boolean.' },
  { id: 'optional', value: null, known: true, evidence: 'The optional field was observed as None.' },
];
const leaf = (id, parentId = null, tool = false) => ({ id, parentId, title: `Inspect ${id}`, kind: 'action', status: 'pending',
  operation: tool ? { kind: 'tool', tool: 'relay_workspace', action: 'read', target: `${id}.txt` } : { kind: 'reasoning', target: `Compare the supplied ${id} observation with its criterion` },
  result: 'The actual observed finding is recorded.', note: 'Inspect this one declared input and report the bounded finding.', doneWhen: 'The declared input has been inspected and its actual finding recorded.' });
const initialEdits = () => [
  { type: 'metadata', patch: { layout: 'choice', facts: facts(), branch: outerBranch() } },
  { type: 'add', step: leaf('fast', null, true) },
  { type: 'add', step: { id: 'slow', title: 'Choose the observed fallback', kind: 'choice', branch: innerBranch() } },
  { type: 'add', step: leaf('reuse', 'slow') },
  { type: 'add', step: leaf('fetch', 'slow', true) },
  { type: 'add', step: leaf('wait') },
];

async function fixture(t, surface) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-connector-algorithm-'));
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const initial = await tasks.ensure({ taskId: 'algorithm-task', runId: 'saved-run', cwd: directory, goal: 'Inspect the observed branch, one operation at a time.', defaultPlan: true });
  const run = { id: 'saved-run', taskId: 'algorithm-task', status: 'cancelled', settled: true, taskState: initial, nodes: { agent: { status: 'cancelled' } } };
  const runs = new Map([[run.id, run]]), events = [];
  const engine = { runs, listRuns: () => [...runs.values()], adoptTaskState: (value, state) => { value.taskState = state; return true; }, notify: (...args) => events.push(args),
    startRun: () => assert.fail('A connected plan edit must not start a worker.'), continueRun: () => assert.fail('A connected plan edit must not resume a worker.') };
  const conversations = { list: () => [{ id: 'algorithm-task', taskId: 'algorithm-task', title: 'Saved algorithm', state: 'active' }], status: () => ({ healthy: true }) };
  const api = surface === 'remote' ? new RemoteAgentAPI({ tasks, engine, conversations, onEvent: event => events.push(event) })
    : new ChatGPTPlanningAPI({ tasks, engine, conversations, onUpdated: event => events.push(event) });
  const entry = surface === 'remote' ? null : createChatGPTToolCatalog({ providers: [api], version: 'algorithm-fixture' }).get('blackice_edit_plan');
  const call = args => entry ? entry.call(args, client) : api.call('blackice_edit_plan', args, client);
  const edit = async operations => call({ taskId: 'algorithm-task', expectedRevision: (await tasks.get('algorithm-task')).revision, operations });
  t.after(async () => { api.close?.(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return { api, call, edit, tasks, initial, run, events };
}

test('connected planning catalogs publish complete canonical recursive definitions without changing cached schemas', () => {
  const cached = Array.from({ length: 8 }, (_, index) => JSON.stringify(taskToolForVersion(index + 1)));
  for (const api of [new RemoteAgentAPI({}), new ChatGPTPlanningAPI({})]) {
    const tool = api.tools(client).find(value => value.name === 'blackice_edit_plan'), input = tool.inputSchema;
    assert.deepEqual(input.$defs, TASK_TOOL.inputSchema.$defs);
    const variant = type => input.properties.operations.items.oneOf.find(item => item.properties.type.const === type);
    assert.deepEqual(variant('add').properties.step.properties.operation, TASK_TOOL.inputSchema.properties.steps.items.properties.operation);
    assert.deepEqual(variant('update').properties.patch.properties.branch, TASK_TOOL.inputSchema.properties.operations.items.properties.patch.properties.branch);
    assert.deepEqual(variant('update').properties.patch.properties.reconciliation, TASK_TOOL.inputSchema.properties.operations.items.properties.patch.properties.reconciliation);
    assert.deepEqual(variant('metadata').properties.patch.properties.facts, TASK_TOOL.inputSchema.properties.plan.properties.facts);
    assert.deepEqual(variant('revisit').required, ['type', 'stepId', 'reason']);
    let references = 0;
    const inspect = node => {
      if (!node || typeof node !== 'object') return;
      if (node.$ref) {
        references++;
        assert.ok(node.$ref.startsWith('#/'));
        const resolved = node.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], input);
        assert.ok(resolved && typeof resolved === 'object', `Unresolved advertised reference ${node.$ref}`);
      }
      Object.values(node).forEach(inspect);
    };
    inspect(input); assert.ok(references > 10);
    input.$defs.planExpression.anyOf.length = 0;
    variant('add').properties.step.properties.operation.anyOf.length = 0;
    assert.ok(api.tools(client).find(value => value.name === 'blackice_edit_plan').inputSchema.$defs.planExpression.anyOf.length > 0);
  }
  assert.deepEqual(Array.from({ length: 8 }, (_, index) => JSON.stringify(taskToolForVersion(index + 1))), cached);
  for (let version = 1; version <= 8; version++) assert.equal(taskToolForVersion(version).inputSchema.$defs, undefined);
});

for (const surface of ['remote', 'chatgpt']) {
  test(`${surface} API persists ordered ELIF, nested XOR/comparisons and explicit revisits without starting work`, async t => {
    const f = await fixture(t, surface);
    let state = await f.edit(initialEdits());
    assert.equal(state.plan.selectedChildId, undefined, 'unknown IF must not fall through to a true ELIF');
    assert.equal(state.availableWork.byId.reuse.state, 'awaiting-choice');
    assert.deepEqual(state.availableWork.active, []);
    state = await f.edit([{ type: 'metadata', patch: { facts: facts(false) } }]);
    assert.equal(state.plan.selectedChildId, 'slow');
    assert.equal(state.steps.find(step => step.id === 'slow').selectedChildId, 'reuse');
    assert.equal(state.availableWork.byId.reuse.state, 'ready');
    assert.equal(state.availableWork.byId.fast.state, 'unselected');
    assert.equal(state.availableWork.byId.fetch.state, 'unselected');
    state = await f.edit([{ type: 'update', stepId: 'reuse', patch: { status: 'active' } }]);
    state = await f.edit([{ type: 'update', stepId: 'reuse', patch: { status: 'done', evidence: 'The supplied cached observation matched the stated reuse criterion.' } }]);
    const completed = state.steps.find(step => step.id === 'reuse');
    state = await f.edit([{ type: 'revisit', stepId: 'reuse', reason: 'A later cache observation changed the earlier decision.' }, { type: 'metadata', patch: { facts: facts(false, false) } }]);
    const revisited = state.steps.find(step => step.id === 'reuse');
    assert.equal(revisited.attempt, 2); assert.equal(revisited.status, 'pending');
    assert.equal(revisited.pastAttempts[0].status, 'done'); assert.equal(revisited.pastAttempts[0].evidence, completed.evidence);
    assert.deepEqual(revisited.pastAttempts[0].operation, completed.operation);
    assert.equal(state.steps.find(step => step.id === 'slow').selectedChildId, 'fetch');
    assert.equal(state.availableWork.byId.fetch.state, 'ready'); assert.equal(state.availableWork.byId.reuse.state, 'unselected');
    assert.equal(f.run.status, 'cancelled'); assert.equal(f.run.settled, true); assert.deepEqual(f.run.nodes, { agent: { status: 'cancelled' } });
    assert.equal(f.run.taskState.revision, state.revision);
    assert.deepEqual((await f.tasks.get('algorithm-task')).steps, state.steps);
    await assert.rejects(f.call({ taskId: 'algorithm-task', expectedRevision: state.revision - 1, operations: [{ type: 'update', stepId: 'fetch', patch: { title: 'Stale edit' } }] }), { code: 'TASK_STATE_CONFLICT' });
  });

  test(`${surface} API rejects malformed recursive values before saving any part of an edit`, async t => {
    const f = await fixture(t, surface); const state = await f.edit(initialEdits());
    const malformed = [
      { type: 'update', stepId: 'fast', patch: { operation: [{ kind: 'reasoning', target: 'A compound operation' }] } },
      { type: 'update', stepId: 'fast', patch: { operation: { kind: 'reasoning', target: 'Bounded question', tool: 'relay_workspace' } } },
      { type: 'update', stepId: 'fast', patch: { operation: { kind: 'tool', target: 'source.txt', tool: 'arbitrary-code' } } },
      { type: 'update', stepId: 'slow', patch: { branch: { if: { and: [{ not: [] }] }, then: 'reuse', else: 'fetch' } } },
      { type: 'update', stepId: 'slow', patch: { branch: { if: compare(fact('score'), '===', literal(4)), then: 'reuse', else: 'fetch' } } },
      { type: 'update', stepId: 'slow', patch: { branch: { if: compare(fact('score'), '==', literal({ nested: true })), then: 'reuse', else: 'fetch' } } },
      { type: 'metadata', patch: { facts: [{ id: 'ready', value: true, known: 'true', evidence: 'A supplied string is not a known flag.' }] } },
      { type: 'metadata', patch: { facts: [{ id: 'ready', value: [[true]], evidence: 'Nested arrays are not a scalar list.' }] } },
      { type: 'metadata', patch: { facts: [{ id: 'ready', value: Infinity, evidence: 'Nonfinite numbers are not observed scalar values.' }] } },
      { type: 'revisit', stepId: 'fast' },
      { type: 'revisit', stepId: 'fast', reason: 'x'.repeat(1001) },
      { type: 'update', stepId: 'fast', patch: { attempt: 8, pastAttempts: [] } },
    ];
    for (const operation of malformed) {
      await assert.rejects(f.call({ taskId: 'algorithm-task', expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'fast', patch: { title: 'Must not be saved' } }, operation] }), { code: surface === 'remote' ? 'REMOTE_REQUEST_INVALID' : 'CHATGPT_ARGUMENTS_INVALID' });
      assert.deepEqual(await f.tasks.get('algorithm-task'), state);
    }
    // These shapes are advertised correctly, but canonical plan validation is
    // still required for evidence and relationships rather than only types.
    for (const operation of [
      { type: 'metadata', patch: { facts: [{ id: 'ready', value: true }] } },
      { type: 'update', stepId: 'slow', patch: { branch: { if: true, then: 'reuse', else: 'not-a-child' } } },
      { type: 'choose', stepId: null, selectedChildId: 'slow' },
    ]) {
      await assert.rejects(f.edit([operation]), /evidence|child|condition|branch/i);
      assert.deepEqual(await f.tasks.get('algorithm-task'), state);
    }
  });

  test(`${surface} API accepts canonical expression limits and rejects excessive depth or node count atomically`, async t => {
    const f = await fixture(t, surface); await f.edit(initialEdits());
    let nested = fact('ready'); for (let depth = 1; depth < 24; depth++) nested = { and: [nested] };
    let state = await f.edit([{ type: 'metadata', patch: { branch: { ...outerBranch(), if: nested } } }]);
    assert.equal(state.plan.selectedChildId, undefined);
    await assert.rejects(f.edit([{ type: 'metadata', patch: { branch: { ...outerBranch(), if: { not: nested } } } }]), /24 nested levels/);
    assert.equal((await f.tasks.get('algorithm-task')).revision, state.revision);
    state = await f.edit([{ type: 'metadata', patch: { branch: { ...outerBranch(), if: { and: Array(511).fill(true) } } } }]);
    assert.equal(state.plan.selectedChildId, 'fast');
    await assert.rejects(f.edit([{ type: 'metadata', patch: { branch: { ...outerBranch(), if: { and: Array(512).fill(true) } } } }]), /512 nodes/);
    assert.equal((await f.tasks.get('algorithm-task')).revision, state.revision);
  });
}

test('local-reference validation rejects missing or remote references and terminates cyclic schemas', () => {
  for (const spec of [{ $ref: '#/$defs/missing', $defs: {} }, { $ref: 'https://example.invalid/schema' }, { $ref: '#/$defs/loop', $defs: { loop: { $ref: '#/$defs/loop' } } }]) assert.equal(validRemoteArguments({}, spec), false);
  const cyclic = {}; cyclic.not = cyclic;
  assert.equal(validRemoteArguments(cyclic, { $ref: '#/$defs/planExpression', $defs: TASK_TOOL.inputSchema.$defs }), false);
});

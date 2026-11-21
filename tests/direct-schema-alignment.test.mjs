import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI, validDirectArguments } from '../lib/direct-execution-api.mjs';
import { conversationGoalsDirectTool } from '../lib/conversation-goals-direct-tool.mjs';
import { chatGPTStartChatTool } from '../lib/chatgpt-start-chat.mjs';
import { chatGPTFileImportTool } from '../lib/chatgpt-file-import.mjs';
import { createDirectResponseCycleTools } from '../lib/direct-response-cycle-tools.mjs';
import { createDirectPlanningBrowserTools } from '../lib/direct-planning-browser-tools.mjs';
import { createDirectPlanningExecutionTools } from '../lib/direct-planning-execution-tools.mjs';
import { ChatGPTConnector } from '../lib/chatgpt-connector.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { ResponseCycleService } from '../lib/response-cycle.mjs';

const client = { id: 'schema-alignment-fixture', kind: 'chatgpt', scopes: ['read', 'planning:write', 'files:read', 'browser:read', 'browser:write'] };
const settle = async (api, jobId) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await api.getJob(jobId, client);
    if (job.settled) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Fixture job did not settle.');
};

test('current goal schema accepts its advertised nullable types and rejects other types', () => {
  const tool = conversationGoalsDirectTool({ goals: { get() {}, control() {} } }).definition;
  const base = { requestId: 'goal-union', conversationId: 'fixture-chat', action: 'set', objective: 'Save fixture result' };
  for (const maxTurns of [null, 1, 9]) assert.equal(validDirectArguments({ ...base, maxTurns }, tool.inputSchema), true);
  for (const deadlineAt of [null, '2099-01-01T00:00:00Z']) assert.equal(validDirectArguments({ ...base, deadlineAt }, tool.inputSchema), true);
  for (const maxTurns of [0, -1, 1.5, '1', {}, []]) assert.equal(validDirectArguments({ ...base, maxTurns }, tool.inputSchema), false);
  for (const deadlineAt of [1, true, {}, []]) assert.equal(validDirectArguments({ ...base, deadlineAt }, tool.inputSchema), false);
});

test('advertised goal and start_chat union values reach handlers through the direct API', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-schema-alignment-'));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd);
  const controls = [], starts = [];
  const goals = { get: async () => null, control: async (id, value) => { controls.push({ id, value }); return { goal: { id, revision: 1 } }; } };
  const engine = { startRun: value => { starts.push(value); return { id: 'fixture-run', taskId: 'fixture-chat', status: 'queued' }; } };
  const api = await new DirectExecutionAPI({ dataDir: path.join(root, 'profile'), allowedRoot: cwd, additionalTools: [
    conversationGoalsDirectTool({ goals }), chatGPTStartChatTool({ engine, defaultCwd: cwd })
  ] }).init();
  t.after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });
  const goal = await api.call('blackice_goal', { requestId: 'goal-null', conversationId: 'fixture-chat', action: 'set', objective: 'Save a fixture', maxTurns: null, deadlineAt: '2099-01-01T00:00:00Z' }, client);
  assert.equal((await settle(api, goal.jobId)).status, 'succeeded');
  assert.equal(controls[0].value.maxTurns, null);
  assert.equal(controls[0].value.deadlineAt, '2099-01-01T00:00:00Z');
  for (const [index, maxTurns] of [undefined, null, 3].entries()) {
    const goal = { ...(maxTurns === undefined ? {} : { maxTurns }), deadlineAt: null };
    const chat = await api.call('blackice_start_chat', { requestId: 'chat-limit-' + index, message: 'Save a fixture', planningMode: 'off', directoryMode: 'off', goal }, client);
    assert.equal((await settle(api, chat.jobId)).status, 'succeeded');
    assert.equal(starts[index].input.goal.maxTurns, maxTurns ?? null);
  }
  assert.equal(starts.length, 3);
});

test('retired cycle metadata does not advertise executable legacy actions', () => {
  const tool = createDirectResponseCycleTools({ service: {} })[0].definition;
  const run = { requestId: 'cycle-run', action: 'run', graphRequestId: 'fixture-graph', expectedRequestRevision: 1, cycleId: 'fixture-cycle', expectedCycleRevision: 1, planningExecutionMode: 'automatic' };
  assert.equal(validDirectArguments(run, tool.inputSchema), true);
  assert.equal(validDirectArguments({ ...run, planningExecutionMode: 'plan_only' }, tool.inputSchema), false);
  assert.match(tool.description, /PLANNING_CYCLE_RETIRED/);
  for (const action of ['createCycle', 'runCycle', 'editPlan', 'continueCycle']) {
    assert.throws(() => ResponseCycleService.prototype[action].call({}), { code: 'PLANNING_CYCLE_RETIRED' });
  }
  assert.doesNotMatch(tool.description, /plan_only|Plan only/);
});

test('Planning schema lookup returns the same action fields that the write tool validates', async () => {
  const store = Object.fromEntries(['list', 'get', 'create', 'addNode', 'updateNode', 'link', 'addSource'].map(name => [name, () => {}]));
  const entries = createDirectPlanningBrowserTools({ store });
  const read = entries.find(entry => entry.definition.name === 'blackice_planning_graph_read');
  const write = entries.find(entry => entry.definition.name === 'blackice_planning_graph_write');
  const query = { requestId: 'schema-read', action: 'schema', writeAction: 'record_response' };
  assert.equal(validDirectArguments(query, read.definition.inputSchema), true);
  const delivered = await read.execute(query);
  const body = JSON.parse(delivered.contentItems[0].text);
  const actual = write.definition.inputSchema.oneOf.find(row => row.properties.action.const === 'record_response');
  assert.deepEqual(body.schema, actual);
  const example = { requestId: 'response', action: 'record_response', graphRequestId: 'fixture-graph', nodeId: 'fixture-node', expectedNodeRevision: 1, values: { interpretation: 'Read the failing route.' } };
  assert.equal(validDirectArguments(example, body.schema), true);
  assert.equal(validDirectArguments({ ...example, operation: 'record_response' }, body.schema), false);
  assert.equal(validDirectArguments({ ...example, response: example.values }, body.schema), false);
});

test('connector instructions distinguish direct actions from model-starting tools', () => {
  const tool = chatGPTStartChatTool({ engine: { startRun() {} }, defaultCwd: tmpdir() });
  const catalog = new Map([[tool.definition.name, tool]]);
  const instructions = ChatGPTConnector.prototype.instructions.call({}, catalog);
  assert.match(instructions, /Tools that describe starting a model launch the configured provider/);
  assert.doesNotMatch(instructions, /never starts another model-backed worker/);
});

test('direct browser capacity recovery uses actions from its attached tools', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-direct-capacity-'));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd);
  const browser = new BrowserWorkspace({ driver: {
    status: () => ({ available: true, contained: true, tabs: [] }),
    perform: async args => {
      if (args.action === 'open') throw Object.assign(new Error('Task page capacity reached.'), { code: 'BROWSER_TASK_TAB_LIMIT', actionDispatched: false });
      if (args.action === 'tabs') return { tabs: [] };
      throw new Error('Unexpected fixture browser action');
    }
  } });
  const api = await new DirectExecutionAPI({ dataDir: path.join(root, 'profile'), allowedRoot: cwd, browser }).init();
  t.after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });
  const admitted = await api.call('blackice_browser_action', { requestId: 'capacity-open', action: 'open', browser: 'relay', url: 'https://example.test/' }, client);
  const job = await settle(api, admitted.jobId);
  assert.equal(job.status, 'failed');
  const result = JSON.parse(job.result.text.text);
  assert.equal(result.code, 'BROWSER_TASK_TAB_LIMIT');
  assert.equal(result.actionDispatched, false);
  assert.doesNotMatch(result.error, /relay_browser|\{"action"/);
  const attached = api.tools(client);
  const actions = new Set(['blackice_browser_read', 'blackice_browser_action'].flatMap(name => attached.find(tool => tool.name === name).inputSchema.properties.action.enum));
  for (const action of ['tabs', 'navigate', 'suspend', 'close']) {
    assert.equal(actions.has(action), true);
    assert.match(result.error, new RegExp('\\b' + action + '\\b'));
  }
  const recovered = await api.call('blackice_browser_read', { requestId: 'capacity-read-current-tabs', action: 'tabs', browser: 'relay' }, client);
  assert.equal((await settle(api, recovered.jobId)).status, 'succeeded');
});

test('status reports registered model-starting tools without invoking a handler or creating a job', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-status-model-tools-'));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  let handlerCalls = 0;
  const neverExecute = () => { handlerCalls++; assert.fail('Status must not execute a tool handler.'); };
  const start = chatGPTStartChatTool({ engine: { startRun: neverExecute }, defaultCwd: cwd });
  const goal = conversationGoalsDirectTool({ goals: { get: neverExecute, control: neverExecute } });
  const module = createDirectPlanningExecutionTools({ store: { get: neverExecute }, runner: { start: neverExecute, cancel: neverExecute, status: neverExecute } })[0];
  const ordinary = { ...chatGPTFileImportTool({ directory: path.join(root, 'imports') }), execute: neverExecute };
  const cases = [
    { tools: [], names: [] },
    { tools: [ordinary], names: [] },
    { tools: [start], names: ['blackice_start_chat'] },
    { tools: [goal], names: ['blackice_goal'] },
    { tools: [module], names: ['blackice_planning_module'] },
    { tools: [module, ordinary, goal, start], names: ['blackice_start_chat', 'blackice_goal', 'blackice_planning_module'] },
  ];
  for (const [index, value] of cases.entries()) {
    const api = await new DirectExecutionAPI({ dataDir: path.join(root, 'profile-' + index), allowedRoot: cwd, additionalTools: value.tools }).init();
    try {
      const definitions = api.tools();
      const status = await api.call('blackice_direct_status', { nonce: 'status-model-tools' }, client);
      assert.equal(status.nonce, 'status-model-tools');
      assert.equal(status.capabilities.modelWorkers, value.names.length > 0);
      assert.deepEqual(status.capabilities.modelStartingTools, value.names);
      assert.equal(status.modelStarted, false);
      assert.equal(status.providerTurns, false);
      assert.equal(status.jobs.total, 0);
      assert.equal(status.jobs.active, 0);
      assert.equal(handlerCalls, 0);
      assert.deepEqual(api.tools(), definitions);
    } finally { await api.close(); }
  }
});

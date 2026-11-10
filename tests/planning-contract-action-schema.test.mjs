import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { TaskStateStore, createTaskToolHandler, TASK_TOOL, TASK_WORKER_TOOL, TASK_TOOL_V13, TASK_WORKER_TOOL_V13 } from '../lib/task-state.mjs';
import { createVibeToolBridge } from '../lib/mistral-vibe-tools.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parsed = reply => JSON.parse(reply.content.find(item => item.type === 'text').text);
const contract = goal => ({
  contractVersion: 2, goal,
  criteria: [{ id: 'reviewed', kind: 'judgment', description: 'The supplied material supports the review.' }],
  workItems: [{ id: 'review', title: 'Review material', objective: 'Inspect the supplied material and report a supported conclusion.',
    owner: 'coordinator', resourceKeys: ['discovery'], effects: ['observe'], dependsOn: [], criterionIds: ['reviewed'] }],
  instructions: [],
});

function request(bridge, sessionId, message) {
  return new Promise((resolve, reject) => {
    const authorization = Object.fromEntries(bridge.server.headers.map(item => [item.name, item.value]));
    const req = http.request(bridge.server.url, { method: 'POST', headers: {
      ...authorization, 'Content-Type': 'application/json', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(message));
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-action-schema-'));
  const tasks = new TaskStateStore({ dataDir: path.join(root, 'data') });
  const taskId = 'action-schema-task', runId = 'action-schema-run', nodeId = 'coordinator';
  await tasks.ensure({ taskId, runId, nodeId, cwd: root, goal: 'Review supplied material.', schemaVersion: 14, defaultPlan: true });
  const handler = createTaskToolHandler({ store: tasks, taskId, runId, nodeId, schemaVersion: 14, planningMode: 'on', executionGuardrails: true });
  const bridge = await createVibeToolBridge({ tools: [TASK_TOOL], onToolCall: handler });
  t.after(async () => { await bridge.close(); await tasks.close?.(); await fs.rm(root, { recursive: true, force: true }); });
  const initialized = await request(bridge, null, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers['mcp-session-id'];
  assert.equal(typeof sessionId, 'string');
  assert.equal((await request(bridge, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  let id = 1;
  const rpc = async (method, params) => {
    const response = await request(bridge, sessionId, { jsonrpc: '2.0', id: id++, method, params });
    assert.equal(response.status, 200);
    assert.equal(response.body.error, undefined);
    return response.body.result;
  };
  const catalog = (await rpc('tools/list', {})).tools;
  assert.equal(catalog.length, 1);
  return { tasks, taskId, advertised: catalog[0], call: args => rpc('tools/call', { name: catalog[0].name, arguments: args }) };
}

test('native MCP describe delivers exact action fields and distinguishes the two concurrency tokens', async t => {
  const f = await fixture(t), reply = await f.call({ action: 'describe' });
  assert.equal(reply.isError, false);
  const described = parsed(reply);
  assert.deepEqual(described.schema, f.advertised.inputSchema);
  assert.deepEqual(described.actionFields.plan, ['action', 'expectedRevision', 'contract']);
  assert.deepEqual(described.actionFields.bind_receipt, ['action', 'expectedRevision', 'workItemId', 'criterionId', 'receiptBinding']);
  assert.deepEqual(described.actionFields.focus, ['action', 'expectedPlanEpoch', 'workItemId']);
  assert.deepEqual(described.actionFields.review, ['action']);
  assert.deepEqual(Object.keys(described.actionFields).sort(), [...described.schema.properties.action.enum].sort());
  for (const [action, fields] of Object.entries(described.actionFields)) {
    assert.match(described.schema.properties.action.description, new RegExp(action + ': ' + fields.join(', ')));
  }
  assert.match(described.note, /plan accepts only action, expectedRevision and contract/);
  assert.match(described.schema.properties.expectedPlanEpoch.description, /only for focus and assess/);
  assert.match(described.schema.properties.expectedPlanEpoch.description, /Omit this field.*including plan/);
  assert.match(described.schema.properties.expectedRevision.description, /plan, bind_receipt, checkpoint and artifact/);
  assert.match(described.schema.properties.expectedRevision.description, /read.*only with view=contract/);
  assert.equal(described.schema.properties.contract.additionalProperties, false);
  assert.equal(Object.hasOwn(described.schema.properties.contract.properties, 'planEpoch'), false);
  assert.match(described.schema.properties.contract.description, /authorable canonical intent/);
  assert.match(described.schema.properties.contract.description, /Omit host-owned contract\.planEpoch/);
  assert.match(described.note, /omit host-owned contract\.planEpoch/);
  assert.deepEqual(TASK_WORKER_TOOL.inputSchema, TASK_TOOL.inputSchema);
  assert.match(TASK_WORKER_TOOL.description, /plan accepts only action, expectedRevision and contract/);
  assert.equal(described.schema.oneOf, undefined);
  assert.equal(described.schema.if, undefined);
});

test('native MCP keeps top-level concurrency fields and fresh contracts strict', async t => {
  const f = await fixture(t);
  for (const goal of ['Review the supplied material.', 'Review the additional supplied material.']) {
    const before = await f.tasks.get(f.taskId), draft = contract(goal);
    const rejected = await f.call({ action: 'plan', expectedRevision: before.revision,
      expectedPlanEpoch: before.contract?.planEpoch || 1, contract: draft });
    assert.equal(rejected.isError, true);
    assert.equal(parsed(rejected).code, 'TASK_CONTRACT_INVALID');
    assert.match(parsed(rejected).error, /unexpected fields: expectedPlanEpoch/);
    assert.match(parsed(rejected).error, /Allowed fields: action, expectedRevision, contract\./);
    if (!before.contract) {
      const nested = await f.call({ action: 'plan', expectedRevision: before.revision,
        contract: { ...draft, planEpoch: 1 } });
      assert.equal(nested.isError, true);
      assert.equal(parsed(nested).code, 'TASK_CONTRACT_INVALID');
    }
    const unchanged = await f.tasks.get(f.taskId);
    assert.equal(unchanged.revision, before.revision);
    assert.deepEqual(unchanged.contract, before.contract);
    const accepted = await f.call({ action: 'plan', expectedRevision: before.revision, contract: draft });
    assert.equal(accepted.isError, false, JSON.stringify(accepted));
    assert.equal(parsed(accepted).contract.goal, goal);
    assert.equal(parsed(accepted).revision, before.revision + 1);
  }
  const before = await f.tasks.get(f.taskId);
  const rejected = await f.call({ action: 'focus', workItemId: 'review', expectedPlanEpoch: before.contract.planEpoch, expectedRevision: before.revision });
  assert.equal(rejected.isError, true);
  assert.match(parsed(rejected).error, /unexpected fields: expectedRevision/);
  assert.match(parsed(rejected).error, /Allowed fields: action, expectedPlanEpoch, workItemId\./);
  const accepted = await f.call({ action: 'focus', workItemId: 'review', expectedPlanEpoch: before.contract.planEpoch });
  assert.equal(accepted.isError, false, JSON.stringify(accepted));
  const after = await f.tasks.get(f.taskId);
  assert.equal(after.revision, before.revision);
  assert.equal(after.contract.planEpoch, before.contract.planEpoch);
  const unpinned = await f.call({ action: 'read', expectedRevision: after.revision });
  assert.equal(unpinned.isError, true);
  assert.equal(parsed(unpinned).code, 'TASK_CONTRACT_INVALID');
  for (const action of ['constructor', 'toString', '__proto__', 'missing']) {
    const unknown = await f.call({ action });
    assert.equal(unknown.isError, true);
    assert.equal(parsed(unknown).code, 'TASK_CONTRACT_INVALID');
  }
  assert.equal((await f.tasks.get(f.taskId)).revision, after.revision);
});

test('native MCP plan accepts a copied epoch only at the exact saved revision', async t => {
  const f = await fixture(t), initial = await f.tasks.get(f.taskId);
  const seeded = await f.call({ action: 'plan', expectedRevision: initial.revision, contract: contract('Review the supplied material.') });
  assert.equal(seeded.isError, false, JSON.stringify(seeded));
  const read = parsed(await f.call({ action: 'read' }));
  const exact = await f.call({ action: 'plan', expectedRevision: read.revision, contract: read.contract });
  assert.equal(exact.isError, false, JSON.stringify(exact));
  const unchanged = parsed(exact);
  assert.equal(unchanged.revision, read.revision + 1);
  assert.deepEqual(unchanged.contract, read.contract);

  const stale = await f.call({ action: 'plan', expectedRevision: read.revision, contract: read.contract });
  assert.equal(stale.isError, true);
  assert.equal(parsed(stale).code, 'TASK_STATE_CONFLICT');
  const edited = { ...unchanged.contract, instructions: [
    { id: 'supporting-passages', text: 'Report the exact supporting passages.', handling: 'audit' },
  ] };
  const changedReply = await f.call({ action: 'plan', expectedRevision: unchanged.revision, contract: edited });
  assert.equal(changedReply.isError, false, JSON.stringify(changedReply));
  const changed = parsed(changedReply);
  assert.equal(changed.revision, unchanged.revision + 1);
  assert.equal(changed.contract.planEpoch, unchanged.contract.planEpoch + 1);
  assert.deepEqual(changed.contract.instructions, edited.instructions);

  const mismatch = await f.call({ action: 'plan', expectedRevision: changed.revision, contract: edited });
  assert.equal(mismatch.isError, true);
  assert.equal(parsed(mismatch).code, 'TASK_CONTRACT_EPOCH_CONFLICT');
  for (const planEpoch of [null, 0, 1.5, String(changed.contract.planEpoch)]) {
    const malformed = await f.call({ action: 'plan', expectedRevision: changed.revision, contract: { ...changed.contract, planEpoch } });
    assert.equal(malformed.isError, true);
    assert.equal(parsed(malformed).code, 'TASK_CONTRACT_INVALID');
  }
  const extra = await f.call({ action: 'plan', expectedRevision: changed.revision, contract: { ...changed.contract, journalSeq: 1 } });
  assert.equal(extra.isError, true);
  assert.match(parsed(extra).error, /undeclared fields: journalSeq/);
  assert.throws(() => f.tasks.setContract(f.taskId, changed.contract,
    { schemaVersion: 14, expectedRevision: changed.revision, adoption: {} }), { code: 'TASK_CONTRACT_INVALID' });
  const saved = await f.tasks.get(f.taskId);
  assert.equal(saved.revision, changed.revision);
  assert.deepEqual(saved.contract, changed.contract);
});

test('native MCP prior binding guidance identifies pre-existing records without adding defaults or predicates', async t => {
  const f = await fixture(t), described = parsed(await f.call({ action: 'describe' }));
  const bindings = f.advertised.inputSchema.properties.contract.properties.criteria.items.properties.receiptBinding.anyOf;
  const prior = bindings[0].properties.prior;
  assert.deepEqual(prior, described.schema.properties.contract.properties.criteria.items.properties.receiptBinding.anyOf[0].properties.prior);
  assert.match(prior.description, /pre-existing records excluded from new outcome counts/);
  assert.match(prior.properties.field.description, /Observed receipt field.*pre-existing record/);
  assert.match(prior.properties.values.description, /Observed values denoting pre-existing records/);
  assert.match(prior.properties.values.description, /do not copy the current field value automatically/);
  assert.deepEqual(prior.required, ['field', 'values']);
  assert.equal(prior.additionalProperties, false);
  assert.equal(prior.properties.values.minItems, 1);
  assert.equal(prior.properties.values.maxItems, 20);
  for (const field of [prior, prior.properties.field, prior.properties.values, prior.properties.values.items]) {
    assert.equal(Object.hasOwn(field, 'default'), false);
    assert.equal(Object.hasOwn(field, 'enum'), false);
  }
  assert.equal(bindings[1].properties.prior, undefined);
});

test('canonical action guidance leaves captured schema13 tool identities unchanged', () => {
  assert.equal(digest(TASK_TOOL_V13), '79cd92332491362dec6cd6f6b8ea0506d4057280b175424d3447603bbbc86cb0');
  assert.equal(digest(TASK_WORKER_TOOL_V13), '7e4ec1dedb6f3d132d9303c1b252c3119048591649f8698c216d785678b9f2aa');
});

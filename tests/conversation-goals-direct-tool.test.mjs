import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { conversationGoalsDirectTool } from '../lib/conversation-goals-direct-tool.mjs';
import { chatGPTStartChatTool } from '../lib/chatgpt-start-chat.mjs';

const client = { id: 'goal-owner', kind: 'chatgpt', label: 'Goal fixture', scopes: ['read'] };
const until = async check => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('The goal fixture did not settle.');
};

test('direct goal retries recover the same durable admission across connector restart', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-goal-direct-'));
  const cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
  await mkdir(cwd);
  const changes = [];
  const goals = {
    get: async () => ({ id: 'goal-fixture', revision: 1, objective: 'Finish the saved task', status: 'active' }),
    control: async (id, value) => { changes.push({ id, value }); return { goal: { id: 'goal-fixture', revision: 1 }, run: { id: 'continued-once' } }; },
  };
  const tool = conversationGoalsDirectTool({ goals });
  let api = new DirectExecutionAPI({ dataDir, allowedRoot: cwd, additionalTools: [tool] });
  await api.init();
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const args = { requestId: 'resume-once', conversationId: 'saved-conversation', action: 'resume', expectedRevision: 1 };
  const first = await api.call('blackice_goal', args, client);
  const settled = await until(async () => { const value = await api.getJob(first.jobId, client); return value.settled && value; });
  assert.equal(settled.status, 'succeeded');
  assert.equal(changes.length, 1);
  assert.equal(JSON.parse(settled.result.text.text).run.id, 'continued-once');
  await api.close();
  api = new DirectExecutionAPI({ dataDir, allowedRoot: cwd, additionalTools: [tool] });
  await api.init();
  const repeated = await api.call('blackice_goal', args, client);
  assert.equal(repeated.jobId, first.jobId);
  assert.equal(repeated.existing, true);
  assert.equal(changes.length, 1);
  await assert.rejects(api.call('blackice_goal', { ...args, action: 'clear' }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
  assert.equal(changes.length, 1);
});

test('goal controls honor actual cancellation and shutdown without changing the conversation', async () => {
  const changes = [], goals = { get: async () => null, control: async (...args) => { changes.push(args); } };
  const aborted = new AbortController(); aborted.abort();
  const tool = conversationGoalsDirectTool({ goals });
  await assert.rejects(tool.execute({ requestId: 'cancelled', conversationId: 'saved', action: 'resume' }, { client, signal: aborted.signal }), { code: 'ABORT_ERR' });
  const closing = conversationGoalsDirectTool({ goals, isClosing: () => true });
  await assert.rejects(closing.execute({ requestId: 'closing', conversationId: 'saved', action: 'set', objective: 'Finish' }, { client }), { code: 'GOAL_UNAVAILABLE' });
  assert.equal(changes.length, 0);
  assert.equal(tool.definition.annotations.readOnlyHint, false);
});

test('starting a connector goal admits the objective atomically through the normal chat runner', async () => {
  const starts = [], engine = { startRun: value => { starts.push(value); return { id: 'goal-root', taskId: 'goal-root', status: 'queued' }; } };
  const tool = chatGPTStartChatTool({ engine, defaultCwd: tmpdir() });
  const objective = 'Complete all three steps and verify the resulting artifact.';
  await tool.execute({ requestId: 'new-goal', message: objective, model: 'fixture-model', planningMode: 'off', directoryMode: 'off', goal: {} }, { client });
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].input.goal, { objective, maxTurns: null });
  assert.equal(starts[0].input.task, objective);
  await tool.execute({ requestId: 'ordinary-chat', message: 'One response', planningMode: 'off', directoryMode: 'off' }, { client });
  assert.equal(Object.hasOwn(starts[1].input, 'goal'), false);
});

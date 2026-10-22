import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

const origin = 'https://credentials.example.test';
const generation = { action: 'generate', origin, requestId: 'signup_1', username: 'owned@example.test' };
const call = (options, args) => options.onToolCall({ name: 'relay_credentials', arguments: args });
const payload = result => JSON.parse(result.contentItems[0].text);
const wait = async predicate => { const end = Date.now() + 6000; while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Owned credential engine did not settle.'); };

async function fixture(t, execute, { available = true, subagents = false, shared = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-credential-engine-')), cwd = path.join(root, 'work'); await mkdir(cwd);
  const generated = [], owners = new Map();
  const vault = {
    available, status: async () => ({ available: vault.available, healthy: true }),
    list: async ({ origin: requested }) => generated.filter(entry => entry.origin === requested),
    generate: async (args, context) => {
      assert.match(context.ownerId, /^tool_[a-f0-9]{64}$/);
      const key = context.ownerId + ':' + args.requestId;
      if (owners.has(key)) return { ...owners.get(key), existing: true };
      const entry = { credentialId: 'credential_' + (owners.size + 1), revision: 1, origin: args.origin, username: args.username, label: '', source: 'generated', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), vaultRevision: owners.size + 1 };
      owners.set(key, entry); generated.push(entry); return entry;
    },
  };
  const calls = [];
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture', models: [{ id: 'fixture', supportsTools: true }] }; }
    async runAgent(options) { calls.push(options); options.onEvent({ type: 'thread', threadId: options.prompt.startsWith('You are a short-lived') ? 'credential-child' : 'credential-main' }); return execute(options, context); }
    async close() {}
  }
  const tasks = shared ? await new TaskStateStore({ dataDir: root }).init() : undefined;
  const prefs = await new RuntimeSettingsStore({ dataDir: root }).init();
  await prefs.update({ subagentsEnabled: subagents, maxSubagents: 2, codexHistory: 'codex' });
  const browser = { status: () => ({ available: true, contained: true, tabs: [] }), perform: async () => assert.fail('No real browser action is authorized by this engine fixture.'), close: async () => {} };
  const engine = new HarnessEngine({ runtime: new Runtime(), credentials: vault, browser, tasks, dataDir: root, defaultCwd: cwd }); engine.runtimeSettings = prefs; await engine.init();
  const workflow = createMissionWorkflow({ id: 'credential-engine', task: 'Create the authorized account at ' + origin + '.', model: 'fixture', cwd });
  const context = { engine, vault, owners, generated, calls, root, cwd, workflow, tasks, start: (graph = workflow) => engine.startRun({ workflow: graph, input: 'Create the authorized account at ' + origin + '.' }), settled: id => wait(() => engine.getRun(id)?.settled && engine.getRun(id)) };
  t.after(async () => { await engine.close(); await prefs.close(); await tasks?.close(); assert.match(path.basename(root), /^blackice-credential-engine-/); await rm(root, { recursive: true, force: true }); });
  return context;
}
const done = run => assert.equal(run.status, 'completed', run.error || Object.values(run.nodes).find(node => node.error)?.error);

test('a fresh coordinator receives opaque credentials and retries generation with one stable trusted request owner', async t => {
  const f = await fixture(t, async (options, context) => {
    assert.ok(options.dynamicTools.some(tool => tool.name === 'relay_credentials'));
    assert.match(options.prompt, /do not ask the user to invent or type one/);
    assert.match(options.prompt, /Password text never belongs in ordinary tool arguments/);
    const result = await call(options, generation); assert.equal(result.success, true);
    assert.equal(payload(result).saved, true); assert.equal(payload(result).passwordReturned, false);
    assert.equal(payload(result).existing, context.calls.length > 1);
    const listed = await call(options, { action: 'list', origin }); assert.equal(listed.success, true); assert.equal(payload(listed).credentials.length, 1);
    return { output: 'A protected credential handle was saved; no submission was requested.', threadId: 'credential-main' };
  });
  const first = await f.settled(f.start().id); done(first);
  assert.ok(first.nodes.agent.toolNames.includes('relay_credentials'));
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Retry the same protected credential request.' }).id); done(next);
  assert.equal(f.generated.length, 1); assert.equal(f.owners.size, 1);
  await f.engine.persist(); const stored = await readFile(path.join(f.root, 'runs.json'), 'utf8'); assert.doesNotMatch(stored, /"password"\s*:/);
});

test('unavailable encrypted storage does not advertise a credential tool', async t => {
  const f = await fixture(t, async options => {
    assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_credentials'));
    assert.doesNotMatch(options.prompt, /PROTECTED WEBSITE CREDENTIALS/);
    await assert.rejects(call(options, generation), /not attached/);
    return { output: 'Protected credentials are unavailable.' };
  }, { available: false });
  done(await f.settled(f.start().id)); assert.equal(f.generated.length, 0);
});

test('an existing native conversation keeps its recorded catalog when storage later becomes available', async t => {
  const f = await fixture(t, async options => {
    assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_credentials'));
    await assert.rejects(call(options, generation), /not attached|not.*available|saved/i);
    return { output: 'Original tools retained.', threadId: 'credential-main' };
  }, { available: false });
  const first = await f.settled(f.start().id); done(first); f.vault.available = true;
  done(await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue this saved native conversation.' }).id));
  assert.equal(f.calls[1].threadId, 'credential-main'); assert.equal(f.generated.length, 0);
});

test('delegated workers receive the protected flow with a distinct trusted owner and no recursive coordinator controls', async t => {
  const f = await fixture(t, async options => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      assert.ok(options.dynamicTools.some(tool => tool.name === 'relay_credentials'));
      assert.ok(!options.dynamicTools.some(tool => ['relay_delegate', 'relay_control'].includes(tool.name)));
      assert.match(options.prompt, /PROTECTED WEBSITE CREDENTIALS/);
      assert.equal((await call(options, generation)).success, true);
      return { output: 'Scoped credential saved without submission.' };
    }
    assert.equal((await call(options, generation)).success, true);
    const result = await options.onToolCall({ name: 'relay_delegate', arguments: { tasks: [{ id: 'signup', prompt: 'Prepare the explicitly authorized signup credential; do not submit.' }] } });
    assert.equal(result.success, true); return { output: 'Both opaque results were checked.' };
  }, { subagents: true });
  done(await f.settled(f.start().id)); assert.equal(f.generated.length, 2); assert.equal(f.owners.size, 2);
});

test('a read-only assigned worker can inspect metadata but cannot generate or fill credentials', async t => {
  const agent = (id, canWrite) => ({ id, type: 'agent', name: id, model: 'fixture', prompt: 'Inspect the assigned credential metadata.', assignment: { scope: 'Only inspect credential metadata.', inputs: ['The user request.'], result: 'Checked metadata.', doneWhen: 'The exact-origin metadata is inspected.', canWrite } });
  const graph = { name: 'Credential scopes', nodes: [{ id: 'input', type: 'input', name: 'Task' }, agent('worker', false), agent('coordinator', true), { id: 'output', type: 'output', name: 'Result' }], edges: [{ source: 'input', target: 'worker' }, { source: 'worker', target: 'coordinator' }, { source: 'coordinator', target: 'output' }], settings: { maxParallel: 1 }, planning: { shared: true, coordinatorNodeId: 'coordinator' } };
  const f = await fixture(t, async options => {
    const worker = options.prompt.startsWith('You are worker.'), id = worker ? 'worker' : 'coordinator';
    if (!worker) await recordFixturePlan(options);
    let current = payload(await options.onToolCall({ name: 'relay_task', arguments: { action: 'read' } }));
    const acknowledged = await options.onToolCall({ name: 'relay_task', arguments: { action: 'edit', expectedRevision: current.revision, operations: [{ type: 'update', stepId: `agent-${id}-work`, patch: { status: 'active', note: 'Inspecting only the assigned credential metadata.' } }] } });
    assert.equal(acknowledged.success, true, acknowledged.contentItems[0].text); current = payload(acknowledged);
    if (worker) {
      assert.equal(options.sandbox, 'read-only');
      const listed = await call(options, { action: 'list', origin }); assert.equal(listed.success, true);
      for (const args of [generation, { action: 'fill', origin }]) { const denied = await call(options, args); assert.equal(denied.success, false); assert.equal(denied.code, 'TASK_PLAN_READ_ONLY'); }
    }
    const update = await options.onToolCall({ name: 'relay_task', arguments: { action: 'step', expectedRevision: current.revision, stepId: `agent-${id}-work`, status: 'done', evidence: 'The assigned metadata scope was checked without changing credentials.' } });
    assert.equal(update.success, true, update.contentItems[0].text);
    return { output: 'Checked metadata within the assigned scope.' };
  }, { shared: true });
  done(await f.settled(f.start(graph).id)); assert.equal(f.generated.length, 0);
});

test('a recorded human MFA challenge applies to its origin while metadata and unrelated credentials remain usable', async t => {
  const f = await fixture(t, async options => {
    const reported = await options.onToolCall({ name: 'relay_browser_signin', arguments: { site: 'https://credentials.example.com/challenge', reason: 'verification', evidence: 'verification-page' } });
    assert.equal(reported.success, true);
    const blockedOrigin = 'https://credentials.example.com';
    const generated = await call(options, { ...generation, origin: blockedOrigin }); assert.equal(generated.success, false); assert.equal(payload(generated).code, 'BROWSER_SIGNIN_REQUIRED');
    assert.equal((await call(options, { action: 'list', origin: blockedOrigin })).success, true);
    assert.equal((await call(options, generation)).success, true, 'a challenge at a different origin does not block this authorized signup');
    return { output: 'The observed MFA step requires the user.' };
  });
  done(await f.settled(f.start().id)); assert.equal(f.generated.length, 1); assert.equal(f.generated[0].origin, origin);
});

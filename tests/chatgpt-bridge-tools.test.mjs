import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGPTBridgeStore } from '../lib/chatgpt-bridge.mjs';
import { CHATGPT_BRIDGE_TOOL, createChatGPTBridgeToolHandler } from '../lib/chatgpt-bridge-tools.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';

const payload = response => JSON.parse(response.contentItems[0].text);
const call = arguments_ => ({ name: CHATGPT_BRIDGE_TOOL.name, arguments: arguments_ });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-chatgpt-tools-'));
  const cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  await mkdir(cwd);
  const store = await new ChatGPTBridgeStore({ dataDir }).init(), cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { cwd, dataDir, store, cleanups };
}

test('agent bridge queues explicit context, inherits cwd, retries exactly, and reads the external answer', async t => {
  const { cwd, store } = await fixture(t), handler = createChatGPTBridgeToolHandler({ store, cwd });
  const input = { action: 'request', requestId: 'review:one', title: 'Review a result', prompt: 'Check the supplied reasoning.', context: 'Only this context is shared.' };
  const queued = await handler(call(JSON.stringify(input)));
  assert.equal(queued.success, true);
  const { request, handoff } = payload(queued);
  assert.equal(request.cwd, cwd); assert.equal(request.status, 'pending'); assert.equal(request.context, input.context);
  assert.match(handoff, /configured connector handoff/); assert.match(handoff, /not started automatically/);
  assert.equal(payload(await handler(call(input))).request.id, request.id);
  assert.equal(store.status().count, 1);
  assert.equal(payload(await handler(call({ action: 'status' }))).bridge.pending, 1);
  assert.equal(payload(await handler(call({ action: 'list' }))).items[0].id, request.id);
  const completed = await store.complete({ id: request.id, revision: request.revision, answer: 'The independent check passed.' });
  assert.deepEqual(payload(await handler(call({ action: 'get', id: request.id }))).request, completed);
  const retry = payload(await handler(call(input)));
  assert.equal(retry.request.status, 'completed'); assert.equal(retry.handoff, undefined);
  const overwrite = await handler(call({ action: 'complete', id: request.id, revision: 1, answer: 'Invented answer.' }));
  assert.equal(overwrite.success, false); assert.equal(store.get(request.id).answer, completed.answer);
  assert.equal((await handler(call({ ...input, requestId: 'other', cwd: path.dirname(cwd) }))).success, false);
  assert.equal(store.status().count, 1);
});

test('agent bridge cancellation uses saved revision and stopped parent or child calls cannot create work', async t => {
  const { cwd, store } = await fixture(t), controller = new AbortController();
  const handler = createChatGPTBridgeToolHandler({ store, cwd, signal: controller.signal });
  const input = { action: 'request', requestId: 'cancel:one', prompt: 'Review one result.' };
  const request = payload(await handler(call(input))).request;
  assert.equal((await handler(call({ ...input, prompt: 'Different content.' }))).success, false);
  assert.equal((await handler(call({ action: 'cancel', id: request.id, revision: 9 }))).success, false);
  assert.equal(store.get(request.id).status, 'pending');
  const cancelled = await handler(call({ action: 'cancel', id: request.id, revision: request.revision }));
  assert.equal(cancelled.success, true); assert.equal(payload(cancelled).request.status, 'cancelled');
  assert.deepEqual(payload(await handler(call({ action: 'cancel', id: request.id, revision: request.revision }))), payload(cancelled));
  const child = new AbortController(); child.abort();
  const stoppedChild = await handler(call({ ...input, requestId: 'child:stopped' }), { signal: child.signal });
  assert.equal(stoppedChild.success, false); assert.equal(payload(stoppedChild).code, 'CHATGPT_BRIDGE_STOPPED');
  controller.abort();
  const stoppedParent = await handler(call({ ...input, requestId: 'parent:stopped' }));
  assert.equal(stoppedParent.success, false); assert.equal(payload(stoppedParent).code, 'CHATGPT_BRIDGE_STOPPED');
  assert.equal(store.status().count, 1);
});

test('agent bridge rejects malformed and unavailable operations with honest errors', async () => {
  const handler = createChatGPTBridgeToolHandler({ store: { get: () => { throw Object.assign(new Error('Unavailable saved request.'), { code: 'CHATGPT_BRIDGE_NOT_FOUND' }); } } });
  for (const request of [{ name: 'wrong', arguments: {} }, call('{'), call([]), call({ action: 'status', prompt: 'Unexpected' })]) {
    const result = await handler(request); assert.equal(result.success, false); assert.equal(typeof payload(result).error, 'string');
  }
  const missing = await handler(call({ action: 'get', id: 'missing' }));
  assert.equal(missing.success, false); assert.equal(payload(missing).code, 'CHATGPT_BRIDGE_NOT_FOUND');
  const unavailable = await createChatGPTBridgeToolHandler()(call({ action: 'status' }));
  assert.equal(unavailable.success, false); assert.equal(payload(unavailable).code, 'CHATGPT_BRIDGE_UNAVAILABLE');
});

test('engine and delegated agents never offer the retired Bridge, including old saved catalogs', async t => {
  const { cwd, dataDir, store, cleanups } = await fixture(t);
  let parentTurns = 0, childTurns = 0;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model' }; }
    async runAgent(options) {
      assert.equal(options.dynamicTools.some(tool => tool.name === CHATGPT_BRIDGE_TOOL.name), false);
      assert.doesNotMatch(options.developerInstructions || '', /relay_chatgpt/);
      await assert.rejects(async () => options.onToolCall(call({ action: 'status' })), /not (?:available|attached)/);
      if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
        childTurns++;
        return { output: 'No Bridge tool is attached.' };
      }
      parentTurns++;
      const delegated = await options.onToolCall({ name: 'relay_delegate', arguments: { tasks: [{ id: 'review', prompt: 'Inspect the assigned fixture.' }] } });
      assert.equal(delegated.success, true);
      assert.equal(payload(delegated).allCompleted, true);
      return { output: payload(delegated).results[0].output, threadId: 'native-retired-bridge', codexHistory: 'codex' };
    }
  }
  const prefs = await new RuntimeSettingsStore({ dataDir }).init();
  await prefs.update({ subagentsEnabled: true, codexHistory: 'codex' });
  const engine = new HarnessEngine({ runtime: new Runtime(), dataDir, defaultCwd: cwd, chatgptBridge: store });
  // Even a caller restoring an obsolete field cannot enable the feature.
  engine.chatgptBridge = store; engine.runtimeSettings = prefs; await engine.init();
  cleanups.push(async () => { await engine.close(); await prefs.close(); });
  const workflow = { id: 'retired-bridge-task', name: 'Retired Bridge fixture', nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Coordinator', prompt: 'Follow the user request.', model: 'fixture-model' }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1, planningMode: 'off' } };
  const first = engine.startRun({ workflow, input: 'Inspect the fixture.' }); await engine.executions.get(first.id);
  assert.equal(engine.getRun(first.id).status, 'completed', engine.getRun(first.id).error);
  engine.runs.get(first.id).nodes.agent.toolNames.push(CHATGPT_BRIDGE_TOOL.name);
  const next = engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the old catalog.' }); await engine.executions.get(next.id);
  assert.equal(engine.getRun(next.id).status, 'completed', engine.getRun(next.id).error);
  assert.equal(parentTurns, 2); assert.equal(childTurns, 2); assert.equal(store.status().count, 0);
});

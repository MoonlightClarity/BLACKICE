import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';

const workflow = model => ({ id: 'recovery-effects', name: 'Resume confirmed work', nodes: [
  { id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Agent', prompt: 'Create the requested file exactly once and verify it.', model, effort: 'default' }, { id: 'output', type: 'output' },
], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1, planningMode: 'off' } });
const settle = async (engine, run) => { await engine.executions.get(run.id); assert.equal(engine.getRun(run.id).settled, true); return engine.getRun(run.id); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Native extends EventEmitter {
  calls = [];
  status() { return { connected: true, authenticated: true, defaultModel: 'native-model', models: [{ id: 'native-model', model: 'native-model' }] }; }
  async start() { return this.status(); }
  async close() {}
}

test('Retry after an actual API tool edit and application restart preserves the saved tool receipt instead of repeating the edit', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-recovery-effects-')), cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data'), requests = [], engines = [], runtimes = []; await mkdir(cwd);
  const send = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    // Catalog discovery is not an inference attempt or an external file edit.
    if (request.method === 'GET' && request.url === '/v1/models') return send(response, { data: [{ id: 'tool-model', context_length: 262144, top_provider: { max_completion_tokens: 4096 } }] });
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    // Both the initial transient rejection and its one automatic retry fail.
    if (requests.length === 2 || requests.length === 3) return send(response, { error: { message: 'Fixture connection failed after the confirmed edit.' } }, 503);
    const hasReceipt = body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'confirmed-file-edit');
    const message = hasReceipt ? { role: 'assistant', content: 'Verified the previously completed file edit without repeating it.' } : {
      role: 'assistant', content: 'Write the artifact once.', tool_calls: [{ id: 'confirmed-file-edit', type: 'function', function: { name: 'relay_workspace', arguments: JSON.stringify({ action: 'write', path: 'result.txt', text: requests.length === 1 ? 'CONFIRMED_INITIAL_EDIT' : 'DUPLICATE_EDIT_AFTER_LOST_CONTEXT' }) } }],
    };
    send(response, { choices: [{ message, finish_reason: hasReceipt ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const boot = async () => {
    const runtime = await new ProviderRuntime({ codex: new Native(), dataDir }).init(); runtimes.push(runtime);
    const engine = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(); engines.push(engine); return { runtime, engine };
  };
  t.after(async () => { for (const engine of engines) await engine.close(); for (const runtime of runtimes) await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.match(path.basename(directory), /^relay-recovery-effects-/); await rm(directory, { recursive: true, force: true }); });
  let { runtime, engine } = await boot();
  await runtime.saveProvider({ id: 'local', type: 'compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'tool-model' }] });
  const first = await settle(engine, engine.startRun({ workflow: workflow('local::tool-model'), input: 'Create the actual result file once.' }));
  assert.equal(first.status, 'failed'); assert.match(first.error, /after the confirmed edit/); assert.equal(await readFile(path.join(cwd, 'result.txt'), 'utf8'), 'CONFIRMED_INITIAL_EDIT');
  const thread = await runtime.readThread(first.nodes.agent.threadId); assert.ok(thread.messages.some(message => message.role === 'tool' && message.tool_call_id === 'confirmed-file-edit')); assert.equal(first.nodes.agent.resumeThreadId, undefined);
  await engine.close(); await runtime.close(); ({ runtime, engine } = await boot());
  const recoveredFirst = engine.getRun(first.id), retried = await settle(engine, engine.retryRun(first.id));
  assert.equal(retried.status, 'completed', retried.error); assert.equal(retried.nodes.agent.threadId, first.nodes.agent.threadId); assert.equal(retried.nodes.agent.resumeThreadId, first.nodes.agent.threadId);
  assert.equal(requests.length, 4, 'Retry retains the completed tool exchange after the bounded transient retry fails'); assert.deepEqual(requests[2], requests[1], 'The transient retry preserves the same receipt-bearing request.'); assert.equal(await readFile(path.join(cwd, 'result.txt'), 'utf8'), 'CONFIRMED_INITIAL_EDIT'); assert.match(requests[3].messages.at(-1).content, /Resume this interrupted agent conversation/); assert.match(requests[3].messages.at(-1).content, /Verify the current workspace/);
  assert.deepEqual(engine.getRun(first.id), recoveredFirst); assert.equal(retried.taskId, first.id); assert.equal(retried.retryOf, first.id); assert.equal(retried.nodes.agent.usage.totalTokens, 38); assert.equal(retried.nodes.agent.usage.total.totalTokens, 76);
});

test('Retry of a cancelled initial persistent agent waits for settlement and retains its actual native thread, original tools and final usage', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-recovery-native-')), cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data'), runtime = new Native(), entered = deferred(), release = deferred(); await mkdir(cwd);
  runtime.runAgent = async options => {
    runtime.calls.push(options); const first = runtime.calls.length === 1, threadId = options.threadId || `native-thread-${runtime.calls.length}`;
    options.onEvent({ type: 'thread', model: 'native-model', threadId, turnId: `turn-${runtime.calls.length}`, codexHistory: 'codex' });
    if (first) {
      options.onEvent({ type: 'message', threadId, text: 'Actual partial result; the first action is complete.', phase: 'commentary' }); options.onEvent({ type: 'usage', threadId, usage: { totalTokens: 10, total: { totalTokens: 10 } } }); entered.resolve();
      await release.promise; options.onEvent({ type: 'usage', threadId, usage: { totalTokens: 14, total: { totalTokens: 14 } } }); throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
    }
    return { output: 'Recovered without repeating confirmed work.', threadId };
  };
  const engine = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(); t.after(async () => { release.resolve(); await engine.close(); assert.match(path.basename(directory), /^relay-recovery-native-/); await rm(directory, { recursive: true, force: true }); });
  const started = engine.startRun({ workflow: workflow('native-model'), input: 'Complete the actual task.' }); await entered.promise; engine.cancelRun(started.id);
  assert.throws(() => engine.retryRun(started.id), { status: 409 }); assert.equal(runtime.calls.length, 1); release.resolve(); const first = await settle(engine, started), before = structuredClone(first);
  const retried = await settle(engine, engine.retryRun(first.id)); assert.equal(retried.status, 'completed', retried.error); assert.equal(runtime.calls[1].threadId, first.nodes.agent.threadId); assert.deepEqual(runtime.calls[1].usageBaseline, { totalTokens: 14 }); assert.deepEqual(runtime.calls[1].dynamicTools.map(tool => tool.name), first.nodes.agent.toolNames); assert.match(runtime.calls[1].prompt, /Resume this interrupted agent conversation/); assert.deepEqual(engine.getRun(first.id), before); assert.equal(retried.nodes.agent.usage, undefined, 'old measured usage is a baseline, not charged again');
});

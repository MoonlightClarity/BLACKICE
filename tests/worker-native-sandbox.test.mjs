import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { CodexRuntime } from '../lib/codex.mjs';

// Replace only the native process boundary with duplex byte streams. Runtime
// startup, request serialization, response parsing and turn lifecycle are real;
// no runAgent/_request stubs, model calls, network or workspace tools are used.
function nativeFixture(t, { approvalRequests = [] } = {}) {
  const messages = [];
  const runtime = new CodexRuntime({
    command: process.execPath,
    requestTimeoutMs: 2000,
    runTimeoutMs: 3000,
    spawnImpl() {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
      const threads = new Map(), approvals = new Map(); let nextId = 0;
      const send = message => child.stdout.write(JSON.stringify(message) + '\n');
      const reply = (id, result) => send({ id, result });
      const notice = (method, params) => send({ method, params });
      const server = readline.createInterface({ input: child.stdin });
      server.on('line', line => {
        const message = JSON.parse(line); messages.push(message);
        const { id, method, params = {} } = message; if (id === undefined) return;
        if (!method) { const complete = approvals.get(id); approvals.delete(id); complete?.(); return; }
        if (method === 'initialize') return reply(id, { userAgent: 'sandbox-fixture/1.0.0' });
        if (method === 'account/read') return reply(id, { requiresOpenaiAuth: false });
        if (method === 'config/read') return reply(id, { config: {} });
        if (method === 'skills/list') return reply(id, { data: (params.cwds || []).map(cwd => ({ cwd, skills: [], errors: [] })) });
        if (method === 'thread/read') {
          const state = threads.get(params.threadId);
          if (!state) return send({ id, error: { code: -32602, message: 'Unknown fixture thread.' } });
          return reply(id, { thread: { id: params.threadId, cwd: state.cwd, model: 'fixture' } });
        }
        if (method === 'model/list') return reply(id, { data: [{ id: 'fixture', model: 'fixture', isDefault: true, contextWindowTokens: 128000 }], nextCursor: null });
        if (method === 'thread/start' || method === 'thread/resume') {
          const threadId = params.threadId || `fixture-${++nextId}`;
          if (!['read-only', 'workspace-write', 'danger-full-access'].includes(params.sandbox) || method === 'thread/resume' && !threads.has(threadId)) return send({ id, error: { code: -32602, message: 'Invalid fixture thread or sandbox.' } });
          threads.set(threadId, { sandbox: params.sandbox, cwd: params.cwd || threads.get(threadId)?.cwd });
          return reply(id, { thread: { id: threadId, ephemeral: params.ephemeral === true }, model: 'fixture' });
        }
        if (method === 'turn/start' || method === 'thread/compact/start') {
          const threadId = params.threadId, turnId = `turn-${++nextId}`, compact = method === 'thread/compact/start';
          assert.ok(threads.has(threadId));
          reply(id, compact ? {} : { turn: { id: turnId } });
          const item = compact ? { type: 'contextCompaction', id: `compact-${turnId}` } : { type: 'agentMessage', id: `message-${turnId}`, text: 'Fixture evidence inspected.' };
          notice('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
          const complete = () => {
            notice('item/completed', { threadId, turnId, item });
            notice('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, last: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, modelContextWindow: 128000 } });
            notice('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [item] } });
          };
          if (!compact && approvalRequests.length) {
            let remaining = approvalRequests.length;
            const requests = approvalRequests.map((method, index) => ({ id: `approval-${turnId}-${index}`, method, params: { threadId, turnId, permissions: { fileSystem: { write: ['/outside-workspace'] } }, command: 'fixture prohibited write' } }));
            for (const request of requests) approvals.set(request.id, () => { if (!--remaining) complete(); });
            for (const request of requests) send(request);
            return;
          }
          return complete();
        }
        reply(id, {});
      });
      const exit = () => { if (child.killed) return; child.killed = true; server.close(); child.stdout.end(); child.stderr.end(); child.emit('exit', 0); };
      child.stdin.once('finish', () => queueMicrotask(exit)); child.kill = () => queueMicrotask(exit);
      return child;
    },
  });
  t.after(() => runtime.close());
  return { runtime, messages, openings: () => messages.filter(item => ['thread/start', 'thread/resume'].includes(item.method)) };
}
const input = { cwd: process.cwd(), prompt: 'Inspect the supplied fixture evidence without editing files.' };

test('native read-only policy reaches thread start, explicit and implicit resumes, and compaction unchanged', { timeout: 10000 }, async t => {
  const { runtime, openings } = nativeFixture(t), events = [];
  const first = await runtime.runAgent({ ...input, sandbox: 'read-only', onEvent: event => events.push(event) });
  await runtime.runAgent({ ...input, threadId: first.threadId, sandbox: 'read-only', onEvent: event => events.push(event) });
  await runtime.runAgent({ ...input, threadId: first.threadId, onEvent: event => events.push(event) });
  assert.equal((await runtime.compactThread(first.threadId)).compacted, true);
  await runtime.runAgent({ ...input, threadId: first.threadId, onEvent: event => events.push(event) });
  assert.deepEqual(openings().map(item => item.method), ['thread/start', 'thread/resume', 'thread/resume', 'thread/resume', 'thread/resume']);
  for (const message of openings()) {
    assert.equal(message.params.sandbox, 'read-only');
    assert.equal(message.params.approvalPolicy, 'never');
  }
  assert.ok(events.filter(event => event.type === 'thread').every(event => event.sandbox === 'read-only'));
});

test('native writable callers retain the declared boundary and the existing new-thread default', { timeout: 10000 }, async t => {
  const { runtime, openings } = nativeFixture(t);
  for (const requested of [undefined, 'workspace-write', 'danger-full-access']) {
    const expected = requested ?? 'danger-full-access', before = openings().length;
    const first = await runtime.runAgent({ ...input, ...(requested ? { sandbox: requested } : {}) });
    await runtime.runAgent({ ...input, threadId: first.threadId });
    await runtime.compactThread(first.threadId);
    assert.deepEqual(openings().slice(before).map(item => item.params.sandbox), [expected, expected, expected]);
  }
});

test('an unknown resumed policy cannot silently become full access after the host loses its cache', { timeout: 10000 }, async t => {
  const { runtime, openings } = nativeFixture(t);
  const first = await runtime.runAgent({ ...input, sandbox: 'read-only' });
  runtime.contexts.delete(first.threadId);
  await runtime.runAgent({ ...input, threadId: first.threadId });
  assert.equal(openings().at(-1).params.sandbox, 'read-only');
  runtime.contexts.delete(first.threadId);
  await runtime.compactThread(first.threadId);
  assert.equal(openings().at(-1).params.sandbox, 'read-only');
  // A later writable run remains possible when the trusted host declares it.
  await runtime.runAgent({ ...input, threadId: first.threadId, sandbox: 'workspace-write' });
  assert.equal(openings().at(-1).params.sandbox, 'workspace-write');
});

test('native history import retains read-only policy through its intermediate compaction state', { timeout: 10000 }, async t => {
  const { runtime, openings, messages } = nativeFixture(t);
  const first = await runtime.runAgent({ ...input, sandbox: 'read-only', continuity: { text: 'Previously confirmed research: one cited source and one unresolved question.' } });
  assert.ok(messages.some(item => item.method === 'thread/inject_items'));
  assert.ok(messages.some(item => item.method === 'thread/compact/start'));
  await runtime.runAgent({ ...input, threadId: first.threadId });
  assert.deepEqual(openings().map(item => item.params.sandbox), ['read-only', 'read-only']);
});

test('invalid native sandbox values fail before opening any transport or turn', async t => {
  let starts = 0;
  const runtime = new CodexRuntime({ command: process.execPath, spawnImpl() { starts++; assert.fail('An invalid sandbox must not start native execution.'); } });
  t.after(() => runtime.close());
  for (const sandbox of [null, false, '', 'readonly', 'READ-ONLY', {}, ['read-only']]) {
    await assert.rejects(runtime.runAgent({ ...input, sandbox }), { code: 'INVALID_SANDBOX' });
    await assert.rejects(runtime.runAgent({ ...input, sandbox, threadId: 'saved-thread' }), { code: 'INVALID_SANDBOX' });
  }
  assert.equal(starts, 0);
});

test('native capability requests cannot expand restricted worker sandboxes or introduce approval prompts', { timeout: 10000 }, async t => {
  const approvalRequests = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval'];
  const { runtime, messages } = nativeFixture(t, { approvalRequests }), events = [];
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
    const before = messages.length;
    await runtime.runAgent({ ...input, sandbox, onEvent: event => events.push(event) });
    const responses = messages.slice(before).filter(item => String(item.id).startsWith('approval-'));
    assert.equal(responses.length, approvalRequests.length);
    const allowed = sandbox === 'danger-full-access';
    assert.deepEqual(responses.slice(0, 2).map(item => item.result.decision), allowed ? ['accept', 'accept'] : ['decline', 'decline']);
    assert.deepEqual(responses[2].result.permissions, allowed ? { fileSystem: { write: ['/outside-workspace'] } } : {});
    for (const response of responses.slice(3)) {
      if (allowed) assert.equal(response.result.decision, 'approved');
      else assert.ok(response.result.decision.denied);
    }
  }
  assert.equal(events.some(event => event.type === 'approval'), false);
});

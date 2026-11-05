import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { VibeAcpConnection, safeVibeError } from '../lib/mistral-vibe-protocol.mjs';

function transport(handler, options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', null, 'SIGTERM');
  child.stdin.once('finish', () => child.emit('exit', 0, null));
  const received = [];
  let buffer = '';
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      received.push(message); handler?.(message, send, child);
    }
  });
  const connection = new VibeAcpConnection({
    command: 'owned-vibe-acp', cwd: process.cwd(), env: {},
    spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; }, ...options,
  });
  return { connection, child, send, received };
}

test('ACP initialization opts into delegated auth without native filesystem or terminal access', async t => {
  const f = transport((message, send) => { if (message.method) send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { version: '3.1.0' } } }); });
  t.after(() => f.connection.close());
  const initialized = await f.connection.initialize();
  assert.equal(initialized.agentInfo.version, '3.1.0');
  const request = f.received[0];
  assert.equal(request.method, 'initialize');
  assert.equal(request.params.clientCapabilities.terminal, false);
  assert.deepEqual(request.params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false });
  assert.equal(request.params.clientCapabilities._meta['browser-auth-delegated'], true);
});

test('ACP transport decodes split UTF-8 messages without corrupting response text', async t => {
  const f = transport((message, send, child) => {
    const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { text: 'snow ❄ and fire 🔥' } }) + '\n');
    for (const byte of data) child.stdout.write(Buffer.from([byte]));
  });
  t.after(() => f.connection.close());
  assert.deepEqual(await f.connection.request('read'), { text: 'snow ❄ and fire 🔥' });
});

test('unadvertised native client requests are denied instead of running host actions', async t => {
  let response;
  const ready = new Promise(resolve => {
    const f = transport(message => { if (message.id === 77) { response = message; resolve(f); } });
    t.after(() => f.connection.close());
    f.send({ jsonrpc: '2.0', id: 77, method: 'fs/read_text_file', params: { path: 'private' } });
  });
  await ready;
  assert.equal(response.error.code, -32601);
  assert.equal(response.result, undefined);
});

test('invalid ACP frames fail pending requests and close the owned process', async t => {
  const f = transport((message, send, child) => child.stdout.write('not-json\n'));
  t.after(() => f.connection.close());
  await assert.rejects(f.connection.request('initialize'), { code: 'MISTRAL_VIBE_PROTOCOL' });
  assert.equal(f.connection.pending.size, 0);
});

test('an ACP timeout is explicit and a late response cannot satisfy another request', async t => {
  let old;
  const f = transport((message, send) => {
    if (message.method === 'slow') { old = message.id; return; }
    send({ jsonrpc: '2.0', id: old, result: { wrong: true } });
    send({ jsonrpc: '2.0', id: message.id, result: { correct: true } });
  });
  t.after(() => f.connection.close());
  await assert.rejects(f.connection.request('slow', {}, { timeoutMs: 10 }), { code: 'MISTRAL_VIBE_TIMEOUT' });
  assert.deepEqual(await f.connection.request('next'), { correct: true });
});

test('safe errors remove auth bearer values and delegated sign-in tokens', () => {
  const safe = safeVibeError('Bearer private-secret https://console.mistral.ai/auth?complete_token=one-time&token=other-token api_key=private-key');
  for (const value of ['private-secret', 'one-time', 'other-token', 'private-key']) assert.equal(safe.includes(value), false);
  assert.match(safe, /\[redacted\]/);
});

function shutdownFixture({ startError = null, closeGraceMs = 5, closeKillTimeoutMs = 1000 } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed, killCount = 0, exitSent = false;
  const killRequested = new Promise(resolve => { killed = resolve; });
  child.kill = () => { killCount++; killed(); return true; };
  const connection = new VibeAcpConnection({
    command: 'synthetic-shutdown-only', cwd: process.cwd(), env: {},
    closeGraceMs, closeKillTimeoutMs,
    spawnImpl: () => { queueMicrotask(() => child.emit(startError ? 'error' : 'spawn', startError)); return child; },
  });
  const exit = (code = 0, signal = null) => { if (!exitSent) { exitSent = true; child.emit('exit', code, signal); } };
  return { connection, child, exit, killRequested, get killCount() { return killCount; } };
}

test('ACP graceful shutdown reports the actual zero exit without forced termination', async () => {
  const f = transport();
  await f.connection.started;
  assert.deepEqual(await f.connection.close(), { closed: true, graceful: true, forced: false, exitCode: 0, signal: null });
  assert.equal(f.connection.closed, true);
});

test('ACP forced shutdown stays pending until its owned child actually exits', async t => {
  const f = shutdownFixture();
  t.after(async () => { f.exit(); await f.connection.close().catch(() => {}); });
  await f.connection.started;
  let settled = false;
  const closing = f.connection.close();
  closing.then(() => { settled = true; }, () => { settled = true; });
  assert.strictEqual(f.connection.close(), closing, 'Repeated close calls must share the same termination.');
  await f.killRequested;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.killCount, 1);
  assert.equal(settled, false, 'Sending a termination signal is not evidence of process exit.');
  assert.equal(f.connection.closed, false);
  f.exit(1, 'SIGTERM');
  assert.deepEqual(await closing, { closed: true, graceful: false, forced: true, exitCode: 1, signal: 'SIGTERM' });
  assert.equal(f.connection.closed, true);
});

test('ACP unconfirmed termination rejects instead of claiming the process has closed', async t => {
  const f = shutdownFixture({ closeKillTimeoutMs: 15 });
  t.after(() => f.exit(1, 'SIGTERM'));
  await f.connection.started;
  const closing = f.connection.close();
  await assert.rejects(closing, { code: 'MISTRAL_VIBE_CLOSE_UNCONFIRMED' });
  assert.equal(f.connection.closed, false);
  assert.equal(f.killCount, 1);
  assert.strictEqual(f.connection.close(), closing);
});

test('ACP shutdown preserves a pending request cancellation and the first protocol failure', async t => {
  for (const kind of ['cancel', 'failure']) {
    const f = shutdownFixture(), controller = new AbortController();
    t.after(async () => { f.exit(); await f.connection.close().catch(() => {}); });
    const cause = Object.assign(Error(kind === 'cancel' ? 'User stopped the operation' : 'Original protocol failure'), { code: kind === 'cancel' ? 'ABORTED' : 'MISTRAL_VIBE_PROTOCOL' });
    const pending = f.connection.request('pending', {}, { signal: controller.signal, timeoutMs: null });
    const rejected = assert.rejects(pending, error => error === cause);
    await f.connection.started;
    if (kind === 'cancel') controller.abort(cause);
    else f.connection.fail(cause);
    await rejected;
    const closing = f.connection.close();
    await f.killRequested;
    f.exit(1, 'SIGTERM');
    await closing;
    assert.equal(f.connection.pending.size, 0);
    if (kind === 'failure') assert.strictEqual(f.connection.failure, cause);
  }
});

test('ACP startup failure has no owned process to kill and cannot claim graceful persistence', async () => {
  const error = Object.assign(Error('Synthetic executable not found'), { code: 'ENOENT' });
  const f = shutdownFixture({ startError: error });
  await assert.rejects(f.connection.started, cause => cause === error);
  assert.deepEqual(await f.connection.close(), { closed: true, graceful: false, forced: false, exitCode: null, signal: null, notStarted: true });
  assert.equal(f.killCount, 0);
  assert.equal(f.connection.failure.code, 'MISTRAL_VIBE_START_FAILED');
});

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

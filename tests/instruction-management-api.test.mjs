import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const route = '/api/instructions/core';
const hash = text => createHash('sha256').update(text).digest('hex');
const updateBody = (record, content) => ({ content, expectedRevision: record.revision, expectedHash: record.hash });

class Runtime extends EventEmitter {
  calls = 0;
  status() { return { connected: true, authenticated: true, defaultModel: 'instruction-http-fixture', models: [{ model: 'instruction-http-fixture' }] }; }
  async start() { return this.status(); }
  async runAgent() { this.calls++; throw new Error('Management fixtures must not start a model.'); }
  async close() {}
}
class NoDesktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}

async function application(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-instruction-http-'));
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'workspace');
  const runtime = new Runtime();
  const app = await createHarnessServer({ port: 0, dataDir, defaultCwd: cwd, runtime, desktop: new NoDesktop() });
  t.after(async () => {
    try { await app.close(); assert.equal(runtime.calls, 0); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const url = await app.listen();
  const home = await fetch(url);
  const cookie = home.headers.get('set-cookie').split(';', 1)[0];
  await home.arrayBuffer();
  const request = async (pathname = route, { method = 'GET', body, authenticated = true, headers = {} } = {}) => {
    // Raw HTTP preserves the Host and fetch-metadata headers under test.
    // A fetch implementation may normalize or replace those transport headers.
    return new Promise((resolve, reject) => {
      const request = httpRequest(new URL(pathname, url), {
        method,
        headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const file = path.join(dataDir, 'instructions', 'instructions.json');
  const bytes = () => readFile(file, 'utf8');
  const initial = await request();
  assert.equal(initial.status, 200);
  return { app, request, initial: initial.data, file, bytes, origin: new URL(url).origin };
}

test('Instructions management uses actual cookie, Host, Origin and cross-site checks before reads or saves', async t => {
  const { request, initial, bytes, origin } = await application(t);
  const before = await bytes();
  for (const pathname of [route, route + '/versions', route + '/versions/0']) {
    assert.equal((await request(pathname, { authenticated: false })).status, 401);
  }
  const value = updateBody(initial, 'Unauthorized edit.');
  assert.equal((await request(route, { method: 'PUT', body: value, authenticated: false })).status, 401);
  for (const headers of [{ Host: 'untrusted.example' }, { Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const denied = await request(route, { method: 'PUT', body: value, headers });
    assert.equal(denied.status, 403, JSON.stringify(headers));
    assert.equal(await bytes(), before);
  }
  assert.equal((await request(route, { headers: { Origin: origin } })).status, 200);
  assert.deepEqual((await request()).data, initial);
});

test('any remote-management marker denies Instructions saves even with a valid local session cookie', async t => {
  const { request, initial, bytes } = await application(t);
  const before = await bytes();
  for (const marker of ['1', '0', 'false', '']) {
    const denied = await request(route, { method: 'PUT', body: updateBody(initial, 'Remote edit.'), headers: { 'X-Blackice-Remote': marker } });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'INSTRUCTIONS_LOCAL_REQUIRED');
    assert.equal(await bytes(), before);
  }
  const readable = await request(route, { headers: { 'X-Blackice-Remote': '1' } });
  assert.equal(readable.status, 200);
  assert.deepEqual(readable.data, initial);
});

test('the management API rejects caller-authored provenance, extra controls and invalid CAS inputs without revisions', async t => {
  const { request, initial, bytes } = await application(t);
  const before = await bytes(), valid = updateBody(initial, 'Attempted edit.');
  const invalid = [
    null, [], 'not an object',
    { ...valid, source: 'user' },
    { ...valid, provenance: { source: 'user' } },
    { ...valid, path: 'another-file.json' },
    { ...valid, action: 'restore' },
    { content: 'No guards.' },
    { content: 'No hash.', expectedRevision: initial.revision },
    { content: 'No revision.', expectedHash: initial.hash },
    { ...valid, content: null },
    { ...valid, expectedRevision: -1 },
    { ...valid, expectedHash: 'invalid' },
  ];
  for (const body of invalid) {
    const denied = await request(route, { method: 'PUT', body });
    assert.equal(denied.status, 400);
    assert.equal(denied.data.code, 'INSTRUCTIONS_INVALID');
    assert.equal(await bytes(), before);
  }
  assert.deepEqual((await request()).data, initial);
  assert.deepEqual((await request(route + '/versions')).data.map(record => record.revision), [0]);
});

test('local owner saves preserve exact and empty text, enforce CAS, and expose immutable version history', async t => {
  const { request, initial, bytes } = await application(t);
  const content = '  \r\nOwner text: café 東京 🙂.\nKeep exact whitespace.\t\r\n';
  const saved = await request(route, { method: 'PUT', body: updateBody(initial, content) });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.content, content);
  assert.equal(saved.data.text, content);
  assert.equal(saved.data.hash, hash(content));
  assert.equal(saved.data.revision, initial.revision + 1);
  assert.equal(saved.data.source, 'user');
  assert.deepEqual((await request()).data, saved.data);
  const empty = await request(route, { method: 'PUT', body: updateBody(saved.data, '') });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.content, '');
  assert.equal(empty.data.hash, hash(''));
  assert.equal(empty.data.revision, saved.data.revision + 1);
  const durable = await bytes();
  const repeat = await request(route, { method: 'PUT', body: updateBody(empty.data, '') });
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.data, empty.data);
  assert.equal(await bytes(), durable);
  for (const body of [updateBody(initial, 'Stale revision.'), { content: 'Stale hash.', expectedRevision: empty.data.revision, expectedHash: saved.data.hash }]) {
    const conflict = await request(route, { method: 'PUT', body });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'INSTRUCTIONS_CONFLICT');
  }
  const history = await request(route + '/versions');
  assert.equal(history.status, 200);
  assert.deepEqual(history.data.map(record => record.revision), [2, 1, 0]);
  assert.deepEqual(history.data.map(record => record.current), [true, false, false]);
  for (const record of history.data) {
    assert.equal(Object.hasOwn(record, 'content'), false);
    assert.equal(Object.hasOwn(record, 'text'), false);
  }
  assert.deepEqual((await request(route + '/versions/0')).data, initial);
  assert.deepEqual((await request(route + '/versions/1')).data, saved.data);
  const absent = await request(route + '/versions/99');
  assert.equal(absent.status, 404);
  assert.equal(absent.data.code, 'INSTRUCTIONS_NOT_FOUND');
  assert.equal((await request(route + '/versions/0', { method: 'PUT', body: updateBody(empty.data, 'Rewrite history.') })).status, 405);
  assert.equal((await request(route, { method: 'DELETE' })).status, 405);
  assert.equal(await bytes(), durable);
  assert.deepEqual((await request()).data, empty.data);
});

test('corrupt storage produces a repair error over HTTP while preserving its bytes and refusing a save', async t => {
  const { request, initial, file, bytes } = await application(t);
  const damaged = '{ fixture-corrupted saved instructions';
  await writeFile(file, damaged);
  for (const operation of [
    () => request(),
    () => request(route + '/versions'),
    () => request(route, { method: 'PUT', body: updateBody(initial, 'Must not reset damaged data.') }),
  ]) {
    const response = await operation();
    assert.equal(response.status, 503);
    assert.equal(response.data.code, 'INSTRUCTIONS_STORAGE_INVALID');
    assert.equal(await bytes(), damaged);
  }
});

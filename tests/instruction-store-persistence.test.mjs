import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InstructionStore } from '../lib/instruction-store.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const save = (store, current, content) => store.update({ content, expectedRevision: current.revision, expectedHash: current.hash });

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-instruction-store-'));
  const stores = [];
  t.after(async () => {
    try { for (const store of stores) await store.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const open = async (options = {}) => {
    const store = new InstructionStore({ dataDir, defaultContent: 'Initial fixture instructions.', ...options });
    stores.push(store);
    await store.init();
    return store;
  };
  return { dataDir, stores, open };
}

test('initial revision is persisted once and survives a changed release default before any owner save', async t => {
  const { open } = await fixture(t);
  const original = '  Initial release instructions.\r\n';
  const first = await open({ defaultContent: original });
  const seed = await first.read();
  assert.equal(seed.revision, 0);
  assert.equal(seed.source, 'initial-default');
  assert.equal(seed.content, original);
  assert.equal(seed.hash, hash(original));
  const bytes = await readFile(first.file, 'utf8');
  await first.close();
  const upgraded = await open({ defaultContent: 'A different future release default.' });
  assert.deepEqual(await upgraded.read(), seed);
  assert.equal(await readFile(upgraded.file, 'utf8'), bytes);
  assert.equal((await upgraded.versions()).length, 1);
});

test('empty initial defaults and exact owner text persist without trimming, truncation or fallback', async t => {
  const { open } = await fixture(t);
  const store = await open({ defaultContent: '' });
  let current = await store.read();
  assert.equal(current.content, '');
  assert.equal(current.hash, hash(''));
  const contents = [' \t\r\n# Owner rules\r\nKeep café, 東京 and 🙂 exactly.  \n', '', ' \t\r\n', 'Long owner instruction: ' + 'x \t'.repeat(60000) + '\r\n'];
  for (const content of contents) {
    current = await save(store, current, content);
    assert.equal(current.content, content);
    assert.equal(current.text, content);
    assert.equal(current.hash, hash(content));
    assert.equal(current.characters, content.length);
    assert.equal((await store.read()).content, content);
  }
  await store.close();
  const reopened = await open({ defaultContent: 'Must not replace owner text.' });
  assert.deepEqual(await reopened.read(), current);
  for (const [index, content] of contents.entries()) assert.equal((await reopened.readVersion(index + 1)).content, content);
});

test('an unchanged initial save records owner authorship while later identical saves are idempotent and still enforce CAS', async t => {
  const { open } = await fixture(t);
  const store = await open();
  const seed = await store.read();
  const owned = await save(store, seed, seed.content);
  assert.equal(owned.revision, 1);
  assert.equal(owned.source, 'user');
  assert.equal(owned.hash, seed.hash);
  const bytes = await readFile(store.file, 'utf8');
  assert.deepEqual(await save(store, owned, owned.content), owned);
  assert.equal(await readFile(store.file, 'utf8'), bytes);
  assert.equal((await store.versions()).length, 2);
  await assert.rejects(save(store, seed, seed.content), { status: 409, code: 'INSTRUCTIONS_CONFLICT' });
  assert.deepEqual(await store.read(), owned);
});

test('revision and content-hash conflicts preserve the current value and history', async t => {
  const { open } = await fixture(t);
  const store = await open();
  const seed = await store.read();
  const current = await save(store, seed, 'Current owner text.');
  const bytes = await readFile(store.file, 'utf8');
  for (const args of [
    { content: 'Stale revision.', expectedRevision: seed.revision, expectedHash: current.hash },
    { content: 'Stale hash.', expectedRevision: current.revision, expectedHash: seed.hash },
    { content: 'Stale both.', expectedRevision: seed.revision, expectedHash: seed.hash },
  ]) await assert.rejects(store.update(args), { status: 409, code: 'INSTRUCTIONS_CONFLICT' });
  for (const args of [
    { content: 'Missing guards.' },
    { content: 'Missing hash.', expectedRevision: current.revision },
    { content: 'Missing revision.', expectedHash: current.hash },
    { content: 'Invalid revision.', expectedRevision: -1, expectedHash: current.hash },
    { content: 'Invalid hash.', expectedRevision: current.revision, expectedHash: 'not-a-hash' },
    { content: null, expectedRevision: current.revision, expectedHash: current.hash },
  ]) await assert.rejects(store.update(args), { status: 400, code: 'INSTRUCTIONS_INVALID' });
  assert.equal(await readFile(store.file, 'utf8'), bytes);
  assert.deepEqual(await store.read(), current);
});

test('two independent store sessions cannot overwrite one another with the same observed revision', async t => {
  const { open } = await fixture(t);
  const left = await open(), right = await open({ defaultContent: 'Unused later default.' });
  const current = await left.read();
  const results = await Promise.allSettled([save(left, current, 'Left update.'), save(right, current, 'Right update.')]);
  const successful = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'INSTRUCTIONS_CONFLICT');
  assert.equal(rejected[0].reason.status, 409);
  const winner = successful[0].value;
  assert.equal(winner.revision, 1);
  assert.deepEqual(await left.read(), winner);
  assert.deepEqual(await right.read(), winner);
  assert.deepEqual((await right.versions()).map(record => record.revision), [1, 0]);
});

test('history remains immutable across owner updates, returned-object edits and reopen; metadata omits full text', async t => {
  const { open } = await fixture(t);
  const store = await open();
  const seed = await store.read();
  const first = await save(store, seed, 'First owner revision.');
  const historical = await store.readVersion(first.revision);
  const latest = await save(store, first, 'Second owner revision.');
  const changedCopy = await store.readVersion(first.revision);
  changedCopy.content = 'Mutated caller copy.';
  changedCopy.text = 'Mutated caller alias.';
  changedCopy.hash = '0'.repeat(64);
  assert.deepEqual(await store.readVersion(first.revision), historical);
  const history = await store.versions();
  assert.deepEqual(history.map(record => record.revision), [2, 1, 0]);
  assert.deepEqual(history.map(record => record.current), [true, false, false]);
  for (const record of history) {
    assert.equal(Object.hasOwn(record, 'content'), false);
    assert.equal(Object.hasOwn(record, 'text'), false);
    assert.equal(record.hash, hash((await store.readVersion(record.revision)).content));
  }
  history[1].source = 'caller mutation';
  assert.equal((await store.versions())[1].source, 'user');
  await assert.rejects(store.readVersion(3), { status: 404, code: 'INSTRUCTIONS_NOT_FOUND' });
  await assert.rejects(store.readVersion(-1), { status: 400, code: 'INSTRUCTIONS_INVALID' });
  await store.close();
  const reopened = await open({ defaultContent: 'Unused upgrade default.' });
  assert.deepEqual(await reopened.readVersion(0), seed);
  assert.deepEqual(await reopened.readVersion(first.revision), historical);
  assert.deepEqual(await reopened.read(), latest);
});

test('invalid saved storage is reported without replacing it with release defaults or attempted updates', async t => {
  const { dataDir, stores, open } = await fixture(t);
  const store = await open();
  const seed = await store.read();
  const valid = JSON.parse(await readFile(store.file, 'utf8'));
  const wrongHash = structuredClone(valid); wrongHash.records[0].hash = '0'.repeat(64);
  const wrongRevision = structuredClone(valid); wrongRevision.currentRevision = 9;
  const wrongSource = structuredClone(valid); wrongSource.records[0].source = 'model';
  for (const malformed of ['{ incomplete JSON', JSON.stringify(wrongHash), JSON.stringify(wrongRevision), JSON.stringify(wrongSource)]) {
    await writeFile(store.file, malformed);
    const reader = new InstructionStore({ dataDir, defaultContent: 'Must not reset damaged data.' });
    stores.push(reader);
    await assert.rejects(reader.init(), { status: 503, code: 'INSTRUCTIONS_STORAGE_INVALID' });
    await assert.rejects(store.read(), { status: 503, code: 'INSTRUCTIONS_STORAGE_INVALID' });
    await assert.rejects(save(store, seed, 'Attempted replacement.'), { status: 503, code: 'INSTRUCTIONS_STORAGE_INVALID' });
    assert.equal(await readFile(store.file, 'utf8'), malformed);
  }
});

test('a closed store refuses subsequent read and save operations', async t => {
  const { open } = await fixture(t);
  const store = await open(), current = await store.read();
  const bytes = await readFile(store.file, 'utf8');
  await store.close();
  await assert.rejects(store.read(), { status: 503, code: 'INSTRUCTIONS_CLOSED' });
  await assert.rejects(save(store, current, 'Too late.'), { status: 503, code: 'INSTRUCTIONS_CLOSED' });
  assert.equal(await readFile(store.file, 'utf8'), bytes);
});

test('a live lock owner is never displaced by age and a different token cannot release its lock', async t => {
  const { open } = await fixture(t);
  const store = await open(), before = await readFile(store.file, 'utf8');
  const ownerToken = randomUUID();
  const ownerHandle = await store.acquireLock(store.lockFile, ownerToken);
  await ownerHandle.close(); // Keep the live owner's logical lock on disk.
  const lock = await readFile(store.lockFile, 'utf8');
  const owner = JSON.parse(lock);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.token, ownerToken);
  assert.match(owner.hostId, /^[a-f0-9]{64}$/);
  assert.ok(typeof owner.startId === 'string' && owner.startId.length > 0);
  const oldTime = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(store.lockFile, oldTime, oldTime);
  await assert.rejects(store.acquireLock(store.lockFile, randomUUID()), { status: 409, code: 'INSTRUCTIONS_BUSY' });
  assert.equal(await readFile(store.lockFile, 'utf8'), lock);
  assert.equal(await readFile(store.file, 'utf8'), before);
  await rm(store.lockFile);
  const token = randomUUID(), handle = await store.acquireLock(store.lockFile, token);
  try { await store.releaseLock(store.lockFile, handle, randomUUID()); }
  finally { await handle.close(); }
  assert.equal(JSON.parse(await readFile(store.lockFile, 'utf8')).token, token);
  await rm(store.lockFile);
  assert.equal((await store.read()).revision, 0);
});

test('competing sessions safely reclaim a proven exited owner and leave one live lock holder', async t => {
  const { open } = await fixture(t);
  const first = await open(), second = await open();
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10000, windowsHide: true });
  assert.equal(child.status, 0, child.error?.message || child.stderr?.toString());
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  const before = await readFile(first.file, 'utf8');
  await writeFile(first.lockFile, JSON.stringify({ pid: child.pid, token: randomUUID() }));
  const stores = [first, second], tokens = [randomUUID(), randomUUID()];
  const results = await Promise.allSettled(stores.map((store, index) => store.acquireLock(store.lockFile, tokens[index])));
  try {
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'INSTRUCTIONS_BUSY');
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const owner = JSON.parse(await readFile(first.lockFile, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.token, tokens[winner]);
    assert.match(owner.hostId, /^[a-f0-9]{64}$/);
    assert.ok(typeof owner.startId === 'string' && owner.startId.length > 0);
    assert.equal(await readFile(first.file, 'utf8'), before);
  } finally {
    for (const [index, result] of results.entries()) if (result.status === 'fulfilled') await stores[index].releaseLock(stores[index].lockFile, result.value, tokens[index]);
  }
  await assert.rejects(readFile(first.lockFile, 'utf8'), { code: 'ENOENT' });
  assert.equal((await first.read()).revision, 0);
});

test('startup reclaims a stale lock after its live PID belongs to a different process generation', async t => {
  const { open } = await fixture(t);
  const hostId = 'a'.repeat(64);
  let startId = '100';
  const observeProcessIdentity = async pid => {
    assert.equal(pid, process.pid);
    return { hostId, startId };
  };
  const original = await open({ observeProcessIdentity });
  const seed = await original.read();
  const owned = await save(original, seed, 'Owner instructions survive a reused PID.');
  const handle = await original.acquireLock(original.lockFile, randomUUID());
  await handle.close(); // Simulate the previous process leaving its logical lock.
  const stale = JSON.parse(await readFile(original.lockFile, 'utf8'));
  assert.equal(stale.pid, process.pid);
  assert.equal(stale.startId, '100');
  startId = '200';
  const restarted = await open({ observeProcessIdentity, defaultContent: 'Unused upgrade default.' });
  assert.deepEqual(await restarted.read(), owned);
  assert.equal((await restarted.readVersion(0)).content, seed.content);
  await assert.rejects(readFile(restarted.lockFile, 'utf8'), { code: 'ENOENT' });
});

test('startup opens restored owner instructions despite a foreign-host lock with a colliding live local PID', async t => {
  const { dataDir, open } = await fixture(t);
  const observeOriginal = async pid => {
    assert.equal(pid, process.pid);
    return { hostId: 'a'.repeat(64), startId: '100' };
  };
  const original = await open({ observeProcessIdentity: observeOriginal });
  const seed = await original.read();
  const owned = await save(original, seed, 'Owner instructions restored from another host.');
  const handle = await original.acquireLock(original.lockFile, randomUUID());
  await handle.close();
  const restoredData = path.join(dataDir, 'restored-profile-data');
  await mkdir(restoredData);
  await cp(original.directory, path.join(restoredData, 'instructions'), { recursive: true });
  const observeRestored = async pid => {
    assert.equal(pid, process.pid);
    return { hostId: 'b'.repeat(64), startId: '100' };
  };
  const restored = await open({ dataDir: restoredData, observeProcessIdentity: observeRestored, defaultContent: 'Unused restore-host default.' });
  const current = await restored.read();
  assert.equal(current.content, owned.content);
  assert.equal(current.hash, owned.hash);
  assert.equal(current.revision, owned.revision);
  assert.equal(current.source, 'user');
  assert.equal((await restored.readVersion(0)).content, seed.content);
  await assert.rejects(readFile(restored.lockFile, 'utf8'), { code: 'ENOENT' });
});

test('one store reuses its observed process identity across initialization and ordinary operations', async t => {
  const { open } = await fixture(t);
  let observations = 0;
  const store = await open({ observeProcessIdentity: async pid => {
    assert.equal(pid, process.pid);
    observations++;
    return { hostId: 'c'.repeat(64), startId: '300' };
  } });
  const seed = await store.read();
  const current = await save(store, seed, 'Warm identity cache fixture.');
  await store.versions();
  assert.equal((await store.readVersion(current.revision)).content, current.content);
  await store.init();
  assert.deepEqual(await store.read(), current);
  assert.equal(observations, 1);
});

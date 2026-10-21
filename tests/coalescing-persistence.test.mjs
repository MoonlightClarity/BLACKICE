import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtomicJsonSnapshots, CoalescingWriter, renameWithRetry } from '../lib/coalescing-persistence.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
const temporaryDirectory = async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-persistence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const read = (directory, name = 'runs.json') => fs.readFile(path.join(directory, name), 'utf8');
const error = code => Object.assign(new Error(`injected ${code}`), { code });

test('a burst writes the latest state once and resolves only after it is saved', async () => {
  const gate = deferred(), writes = [];
  let state = 0, settled = false;
  const writer = new CoalescingWriter(async () => { writes.push(state); await gate.promise; });
  const requests = Array.from({ length: 100 }, (_, index) => { state = index; return writer.request(); });
  requests[0].then(() => { settled = true; });
  assert.ok(requests.every(request => request === requests[0]));
  assert.deepEqual(writes, []);
  await turn();
  assert.deepEqual(writes, [99]);
  assert.equal(settled, false);
  gate.resolve();
  await Promise.all(requests);
  assert.equal(settled, true);
});

test('updates during a write share one later batch and do not resolve with the older snapshot', async () => {
  const firstGate = deferred(), secondGate = deferred(), writes = [];
  let state = 'first', laterSettled = false;
  const writer = new CoalescingWriter(async () => {
    writes.push(state);
    await (writes.length === 1 ? firstGate : secondGate).promise;
  });
  const first = writer.request();
  await turn();
  state = 'second';
  const second = writer.request();
  state = 'latest';
  const latest = writer.request();
  assert.notEqual(first, second);
  assert.equal(second, latest);
  second.then(() => { laterSettled = true; });
  firstGate.resolve();
  await first;
  assert.deepEqual(writes, ['first', 'latest']);
  assert.equal(laterSettled, false);
  secondGate.resolve();
  await latest;
  assert.equal(laterSettled, true);
});

test('a failed batch rejects its callers while pending and subsequent batches can recover', async () => {
  const gate = deferred();
  let calls = 0;
  const failure = error('ENOSPC');
  const writer = new CoalescingWriter(async () => { if (++calls === 1) { await gate.promise; throw failure; } });
  const first = writer.request();
  await turn();
  const next = writer.request();
  const rejection = assert.rejects(first, candidate => candidate === failure);
  gate.resolve();
  await rejection;
  await next;
  await writer.request();
  assert.equal(calls, 3);
});

test('serialization failures reject asynchronously and leave the writer reusable', async () => {
  let fail = true;
  const writer = new CoalescingWriter(() => { if (fail) throw error('SERIALIZE'); });
  const request = writer.request();
  await assert.rejects(request, { code: 'SERIALIZE' });
  fail = false;
  await writer.request();
});

test('transient rename locks are retried with bounded delays', async () => {
  let attempts = 0;
  const waits = [], transient = ['EPERM', 'EACCES', 'EBUSY'];
  await renameWithRetry('a', 'b', {
    io: { rename: async () => { if (attempts++ < transient.length) throw error(transient[attempts - 1]); } },
    wait: async delay => waits.push(delay), delays: [1, 2, 3],
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [1, 2, 3]);
});

test('permanent failures are immediate and transient locks eventually reject', async () => {
  let attempts = 0, waits = 0;
  const options = code => ({ io: { rename: async () => { attempts++; throw error(code); } }, wait: async () => { waits++; }, delays: [1, 2] });
  await assert.rejects(renameWithRetry('a', 'b', options('ENOSPC')), { code: 'ENOSPC' });
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
  attempts = 0;
  await assert.rejects(renameWithRetry('a', 'b', options('EPERM')), { code: 'EPERM' });
  assert.equal(attempts, 3);
  assert.equal(waits, 2);
});

test('unchanged files are not rewritten and valid prior snapshots are copied without rereading history', async t => {
  const directory = await temporaryDirectory(t), calls = { read: 0, copy: 0, open: 0 };
  const io = { ...fs,
    readFile: async (...args) => { calls.read++; return fs.readFile(...args); },
    copyFile: async (...args) => { calls.copy++; return fs.copyFile(...args); },
    open: async (...args) => { calls.open++; return fs.open(...args); },
  };
  const snapshots = new AtomicJsonSnapshots(directory, { io });
  assert.equal(await snapshots.write('runs.json', '[{"id":"a"}]'), true);
  const initial = { ...calls };
  assert.equal(await snapshots.write('runs.json', '[{"id":"a"}]'), false);
  assert.deepEqual(calls, initial);
  await snapshots.write('runs.json', '[{"id":"b"}]');
  await snapshots.write('runs.json', '[{"id":"c"}]');
  assert.equal(calls.read, 0);
  assert.equal(calls.copy, 2);
  assert.equal(await read(directory), '[{"id":"c"}]');
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"b"}]');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['runs.json', 'runs.json.bak']);
});

test('an existing snapshot is validated once and an unchanged startup performs no write', async t => {
  const directory = await temporaryDirectory(t);
  await fs.writeFile(path.join(directory, 'runs.json'), '[{"id":"a"}]');
  let reads = 0, opens = 0;
  const io = { ...fs, readFile: async (...args) => { reads++; return fs.readFile(...args); }, open: async (...args) => { opens++; return fs.open(...args); } };
  const snapshots = new AtomicJsonSnapshots(directory, { io });
  assert.equal(await snapshots.write('runs.json', '[{"id":"a"}]'), false);
  assert.equal(reads, 1);
  assert.equal(opens, 0);
  await snapshots.write('runs.json', '[{"id":"b"}]');
  assert.equal(reads, 1);
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"a"}]');
});

test('external corruption is not copied into the valid backup or overwritten', async t => {
  const directory = await temporaryDirectory(t), snapshots = new AtomicJsonSnapshots(directory);
  await snapshots.write('runs.json', '[{"id":"a"}]');
  await snapshots.write('runs.json', '[{"id":"b"}]');
  await fs.writeFile(path.join(directory, 'runs.json'), 'corrupt external contents');
  await assert.rejects(snapshots.write('runs.json', '[{"id":"c"}]'));
  assert.equal(await read(directory), 'corrupt external contents');
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"a"}]');
});

test('a valid external update is revalidated and retained as the next backup', async t => {
  const directory = await temporaryDirectory(t), snapshots = new AtomicJsonSnapshots(directory);
  await snapshots.write('runs.json', '[{"id":"a"}]');
  await fs.writeFile(path.join(directory, 'runs.json'), '[{"id":"external"}]');
  await snapshots.write('runs.json', '[{"id":"a"}]');
  assert.equal(await read(directory), '[{"id":"a"}]');
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"external"}]');
});

test('a failed replacement preserves saved history and removes its temporary files', async t => {
  const directory = await temporaryDirectory(t), destination = path.join(directory, 'runs.json');
  await fs.writeFile(destination, '[{"id":"saved"}]');
  let attempts = 0;
  const io = { ...fs, rename: async (source, target) => {
    if (target === destination) { attempts++; throw error('EPERM'); }
    return fs.rename(source, target);
  } };
  const snapshots = new AtomicJsonSnapshots(directory, { io, wait: async () => {}, delays: [1, 2] });
  await assert.rejects(snapshots.write('runs.json', '[{"id":"new"}]'), { code: 'EPERM' });
  assert.equal(attempts, 3);
  assert.equal(await read(directory), '[{"id":"saved"}]');
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"saved"}]');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['runs.json', 'runs.json.bak']);
});

test('a temporary Windows sharing lock recovers with both current and backup intact', async t => {
  const directory = await temporaryDirectory(t), destination = path.join(directory, 'runs.json');
  await fs.writeFile(destination, '[{"id":"saved"}]');
  let attempts = 0;
  const io = { ...fs, rename: async (source, target) => {
    if (target === destination && ++attempts <= 2) throw error('EPERM');
    return fs.rename(source, target);
  } };
  const snapshots = new AtomicJsonSnapshots(directory, { io, wait: async () => {}, delays: [1, 2] });
  await snapshots.write('runs.json', '[{"id":"new"}]');
  assert.equal(attempts, 3);
  assert.equal(await read(directory), '[{"id":"new"}]');
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"saved"}]');
});

test('a failed backup copy leaves both prior files intact', async t => {
  const directory = await temporaryDirectory(t);
  await fs.writeFile(path.join(directory, 'runs.json'), '[{"id":"current"}]');
  await fs.writeFile(path.join(directory, 'runs.json.bak'), '[{"id":"backup"}]');
  const io = { ...fs, copyFile: async () => { throw error('ENOSPC'); } };
  const snapshots = new AtomicJsonSnapshots(directory, { io });
  await assert.rejects(snapshots.write('runs.json', '[{"id":"new"}]'), { code: 'ENOSPC' });
  assert.equal(await read(directory), '[{"id":"current"}]');
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"backup"}]');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['runs.json', 'runs.json.bak']);
});

test('a source modified during native copying never replaces the last valid backup', async t => {
  const directory = await temporaryDirectory(t), destination = path.join(directory, 'runs.json');
  await fs.writeFile(destination, '[{"id":"current"}]');
  await fs.writeFile(`${destination}.bak`, '[{"id":"known-good-backup"}]');
  const io = { ...fs, copyFile: async (...args) => {
    await fs.writeFile(destination, 'modified during copying');
    return fs.copyFile(...args);
  } };
  const snapshots = new AtomicJsonSnapshots(directory, { io });
  await assert.rejects(snapshots.write('runs.json', '[{"id":"new"}]'), { code: 'STORAGE_CHANGED' });
  assert.equal(await read(directory), 'modified during copying');
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"known-good-backup"}]');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['runs.json', 'runs.json.bak']);
});

test('a shutdown checkpoint backs up the latest saved state without rewriting it', async t => {
  const directory = await temporaryDirectory(t), snapshots = new AtomicJsonSnapshots(directory);
  await snapshots.write('runs.json', '[{"id":"running"}]');
  await snapshots.write('runs.json', '[{"id":"completed"}]');
  const before = await fs.stat(path.join(directory, 'runs.json'));
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"running"}]');
  assert.equal(await snapshots.checkpoint('runs.json'), true);
  assert.equal(await read(directory, 'runs.json.bak'), '[{"id":"completed"}]');
  assert.equal(await snapshots.checkpoint('runs.json'), false);
  const after = await fs.stat(path.join(directory, 'runs.json'));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
});

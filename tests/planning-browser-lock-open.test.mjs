import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const failure = (code, file, syscall = 'open') => Object.assign(new Error('Injected ' + code + ' during planning lock ' + syscall), { code, path: file, syscall });
const selectedNode = state => state.nodes.find(node => node.id === 'choice');

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-lock-open-'));
  const store = await new PlanningBrowserStore({ dataDir }).init();
  t.after(async () => { await store.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  let state = await store.create({ conversationId: 'lock-fixture', title: 'Synthetic lock fixture', objective: 'Retain the saved synthetic choice.', cwd: dataDir });
  state = await store.addNode(state.id, { id: 'choice', kind: 'decision', title: 'Original choice', prompt: 'Compare the supplied alternatives.' });
  const file = store.file(state.id), lockFile = path.join(store.lockDirectory, state.id + '.lock');
  return { dataDir, store, state, file, lockFile, main: await fs.readFile(file, 'utf8'), backup: await fs.readFile(file + '.bak', 'utf8') };
}

async function withLockOpen(file, intercept, work) {
  const original = fs.open, calls = [];
  fs.open = async function(target, flags, mode) {
    if (target !== file || flags !== 'wx') return original.call(this, target, flags, mode);
    calls.push({ target, flags, mode });
    return intercept({ attempt: calls.length, open: () => original.call(this, target, flags, mode) });
  };
  try { return await work(calls); } finally { fs.open = original; }
}

const update = f => f.store.updateNode(f.state.id, 'choice', { title: 'Updated choice' }, { expectedNodeRevision: selectedNode(f.state).revision });
async function unchanged(f) {
  assert.equal(await fs.readFile(f.file, 'utf8'), f.main);
  assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), f.backup);
}

// Interceptors affect only this fixture's exclusive lock open; document IO stays real.
describe('planning lock exclusive creation', { concurrency: false }, () => {
  test('transient sharing and access denials recover before any saved mutation', async t => {
    const f = await fixture(t), codes = ['EPERM', 'EACCES', 'EBUSY'];
    await withLockOpen(f.lockFile, async ({ attempt, open }) => {
      if (attempt <= codes.length) {
        await unchanged(f);
        throw failure(codes[attempt - 1], f.lockFile);
      }
      return open();
    }, async calls => {
      const saved = await update(f);
      assert.equal(calls.length, 4);
      assert.equal(saved.revision, f.state.revision + 1);
      assert.equal(selectedNode(saved).revision, selectedNode(f.state).revision + 1);
      assert.equal(selectedNode(saved).title, 'Updated choice');
      assert(calls.every(call => call.flags === 'wx' && call.mode === 0o600));
    });
    assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), f.main);
  });

  for (const code of ['EPERM', 'EACCES']) {
    test('persistent ' + code + ' remains bounded and preserves its native error and saved bytes', async t => {
      const f = await fixture(t), injected = failure(code, f.lockFile), now = Date.now();
      t.mock.method(Date, 'now', () => now); // Isolate the retry-count bound from scheduler latency.
      await withLockOpen(f.lockFile, async () => { throw injected; }, async calls => {
        await assert.rejects(update(f), error => error === injected);
        assert.equal(calls.length, 6, 'one initial open plus five refused-open retries');
      });
      await unchanged(f);
    });
  }

  test('intervening EEXIST observations do not reset the denied-open retry budget', { timeout: 5000 }, async t => {
    const f = await fixture(t), injected = failure('EPERM', f.lockFile), now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await withLockOpen(f.lockFile, async ({ attempt }) => {
      // The owner may release between an EEXIST result and its inspection.
      if (attempt % 2 === 0) throw failure('EEXIST', f.lockFile);
      throw injected;
    }, async calls => {
      await assert.rejects(update(f), error => error === injected);
      assert.equal(calls.length, 11, 'six denials with five intervening contention observations');
    });
    await unchanged(f);
  });

  test('the existing acquisition deadline can stop retries before their count limit', async t => {
    const f = await fixture(t), injected = failure('EPERM', f.lockFile), now = Date.now();
    let attempts = 0;
    t.mock.method(Date, 'now', () => now + (attempts ? 2990 : 0));
    await withLockOpen(f.lockFile, async () => { attempts++; throw injected; }, async calls => {
      await assert.rejects(update(f), error => error === injected);
      assert.equal(calls.length, 1, 'the next 20ms wait cannot exceed the remaining 10ms');
    });
    await unchanged(f);
  });

  test('nontransient open errors are not retried or wrapped', async t => {
    const f = await fixture(t), injected = failure('EIO', f.lockFile);
    await withLockOpen(f.lockFile, async () => { throw injected; }, async calls => {
      await assert.rejects(update(f), error => error === injected);
      assert.equal(calls.length, 1);
    });
    await unchanged(f);
  });

  for (const phase of ['write', 'close']) {
    test('an uncertain owner ' + phase + ' is not repeated after exclusive creation', async t => {
      const f = await fixture(t), injected = failure('EPERM', f.lockFile, phase);
      let ownedAttempt = null, writes = 0, closes = 0, ownerBytes;
      await withLockOpen(f.lockFile, async ({ attempt, open }) => {
        const handle = await open(); ownedAttempt = attempt;
        return {
          writeFile: async value => {
            writes++; ownerBytes = value;
            if (phase === 'write') { await handle.writeFile(value.slice(0, 12)); throw injected; }
            return handle.writeFile(value);
          },
          close: async () => { closes++; await handle.close(); if (phase === 'close') throw injected; },
        };
      }, async calls => {
        await assert.rejects(update(f), error => error === injected);
        assert.equal(calls.length, ownedAttempt, 'no further open may follow an acquired handle');
        assert.equal(writes, 1);
        assert.equal(closes, 1);
      });
      assert.equal(await fs.readFile(f.lockFile, 'utf8'), phase === 'write' ? ownerBytes.slice(0, 12) : ownerBytes);
      await unchanged(f);
    });
  }

  test('a live owner remains exclusive through EEXIST, release, and a transient reopen denial', { timeout: 5000 }, async t => {
    const f = await fixture(t), other = await new PlanningBrowserStore({ dataDir: f.dataDir }).init();
    t.after(() => other.close());
    const entered = deferred(), release = deferred(), released = deferred(), contended = deferred();
    const held = f.store._lock(f.state.id, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const ownerBytes = await fs.readFile(f.lockFile, 'utf8');
    assert.equal(JSON.parse(ownerBytes).pid, process.pid);
    let sawContention = false, deniedReopen = false;
    try {
      await withLockOpen(f.lockFile, async ({ open }) => {
        if (sawContention && !deniedReopen) {
          await released.promise;
          deniedReopen = true;
          throw failure('EPERM', f.lockFile);
        }
        try { return await open(); }
        catch (error) { if (error.code === 'EEXIST') { sawContention = true; contended.resolve(); } throw error; }
      }, async () => {
        const pending = other.updateNode(f.state.id, 'choice', { title: 'Updated by the waiting writer' }, { expectedNodeRevision: selectedNode(f.state).revision });
        await Promise.race([contended.promise, pending.then(() => { throw Error('The contender ran before the live owner released its lock.'); })]);
        assert.equal(await fs.readFile(f.lockFile, 'utf8'), ownerBytes, 'the live PID/token must not be replaced');
        await unchanged(f);
        release.resolve(); await held; released.resolve();
        const saved = await pending;
        assert.equal(deniedReopen, true);
        assert.equal(saved.revision, f.state.revision + 1);
        assert.equal(selectedNode(saved).title, 'Updated by the waiting writer');
      });
    } finally { release.resolve(); await held; released.resolve(); }
  });

  test('a protected operation error is returned without repeating the operation', async t => {
    const f = await fixture(t), injected = failure('EPERM', f.file, 'protected-write');
    let executions = 0;
    await assert.rejects(f.store._lock(f.state.id, async () => { executions++; throw injected; }), error => error === injected);
    assert.equal(executions, 1);
    await unchanged(f);
  });
});

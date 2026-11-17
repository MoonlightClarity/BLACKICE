import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DirectExecutionJobs, directRequestDigest } from '../lib/direct-execution-jobs.mjs';
import { retireWithFixtureBackup } from './fixtures/retire-with-verified-fixture.mjs';
import { StartupCriticalTrace } from '../lib/startup-critical-trace.mjs';
import { PACK_MARKER, PACK_MANIFEST, PACK_MARKER_CONTENT } from '../lib/direct-execution-packs.mjs';

const sha = raw => createHash('sha256').update(raw).digest('hex');
const owner = 'synthetic-owner-a';
const client = id => ({ id, kind: 'chatgpt', label: 'offline fixture', scopes: ['read','browser:read'] });
const request = (requestId, ownerId = owner) => ({
  ownerId, requestId, tool: 'blackice_browser_read',
  arguments: { action: 'read', expectedUrl: 'https://example.test/item/' + requestId },
  requiredScopes: ['browser:read'], client: client(ownerId), mutating: false,
});
const identity = input => ({ ownerId: input.ownerId, requestId: input.requestId,
  requestDigest: directRequestDigest({ tool: input.tool, arguments: input.arguments }) });
const errorWith = (code, message = 'injected offline I/O fault') => Object.assign(Error(message), { code });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-terminal-pack-offline-'));
  const stores = [];
  const make = opts => { const store = new DirectExecutionJobs({ dataDir: directory, ...opts }); stores.push(store); return store; };
  t.after(async () => {
    for (const store of stores) await store.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, storeDir: path.join(directory, 'direct-execution-jobs'), make };
}
async function seed(store, count, { unfinished = 0 } = {}) {
  const data = [];
  for (let n = 0; n < count; n++) {
    const input = request('packed-' + String(n).padStart(4, '0'), n % 9 === 0 ? 'synthetic-owner-b' : owner);
    const created = (await store.admit(input)).job;
    const terminal = n < count - unfinished;
    if (terminal) {
      await store.update(created.id, () => ({
        status: 'succeeded', dispatched: true, finishedAt: new Date().toISOString(),
        result: { success: true, contentItems: [{ type: 'inputText',
          text: 'Synthetic evidence for item ' + n + ' — Café 日本語 ' + 'x'.repeat(250 + n % 13) }] },
      }));
    } else {
      await store.update(created.id, () => ({ status: 'awaiting_input',
        interaction: { id: 'fixture-' + n, kind: 'verification' } }));
    }
    data.push({ input, id: created.id, terminal });
  }
  return data;
}
const archiveFiles = async directory => (await fs.readdir(directory)).filter(name => name.startsWith('terminal-pack-') && name.endsWith('.bin'));
const looseFiles = async directory => (await fs.readdir(directory)).filter(name => /^direct_[a-f0-9]{64}\.json$/.test(name) && name !== PACK_MARKER);
async function snapshotState(store, jobs) {
  const data = [];
  for (const job of jobs) data.push({ id: job.id, value: await store.get(job.id) });
  return { counts: await store.counts(), snapshots: await store.snapshot(),
    data, observations: await store.resourceHistory({ ownerId: owner, scopes: ['browser:read'],
      urls: [jobs[1].input.arguments.expectedUrl], limit: 5 }) };
}

test('two-phase immutable staging, independent restart, exact retirement and post-start idempotency', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), jobs = await seed(first, 22, { unfinished: 2 });
  const baseline = await snapshotState(first, jobs);
  const original = new Map();
  for (const job of jobs) if (job.terminal) original.set(job.id, await fs.readFile(first.file(job.id)));
  for (let batch = 0; batch < 4; batch++) {
    const value = await first.packTerminalReceipts({ maxRecords: 6 });
    if (batch < 4) assert.equal(value.removed, 0);
  }
  assert.equal((await looseFiles(storeDir)).length, 22, 'stage never removes originals');
  assert.equal((await archiveFiles(storeDir)).length, 4);
  assert.equal((await first.get(jobs[0].id)).revision, baseline.data[0].value.revision);
  await assert.rejects(retireWithFixtureBackup(first), { code: 'DIRECT_JOB_STORAGE' });
  await first.close();
  const second = make(); await second.init();
  assert.equal(second.packedIndex.size, 20);
  assert.equal((await looseFiles(storeDir)).length, 22);
  assert.deepEqual(await snapshotState(second, jobs), baseline);
  const retired = await retireWithFixtureBackup(second, { maxRecords: 100 });
  assert.equal(retired.removed, 20);
  assert.equal(retired.protectedByMarker, true);
  assert.equal(await fs.readFile(path.join(storeDir, PACK_MARKER), 'utf8'), PACK_MARKER_CONTENT);
  assert.equal((await looseFiles(storeDir)).length, 2);
  assert.equal((await archiveFiles(storeDir)).length, 4);
  for (const job of jobs) if (job.terminal) assert.equal((await fs.stat(first.file(job.id)).catch(() => null)), null);
  assert.deepEqual(await snapshotState(second, jobs), baseline);
  await second.close();
  const third = make(); await third.init();
  assert.deepEqual(await snapshotState(third, jobs), baseline);
  for (const job of jobs.filter(job => job.terminal)) {
    const value = await third.get(job.id);
    assert.equal(sha(original.get(job.id)), third.records.get(job.id).receiptHash);
    assert.equal(value.id, job.id);
    assert.equal((await third.admit(job.input)).created, false);
    await assert.rejects(third.admit({ ...job.input, arguments: { ...job.input.arguments, expectedUrl: 'https://evil.test' } }),
      { code: 'DIRECT_REQUEST_CONFLICT' });
    await assert.rejects(third.get(job.id, { ownerId: 'foreign-owner' }), { code: 'DIRECT_JOB_NOT_FOUND' });
  }
  const chosen = jobs[1];
  assert.deepEqual(await third.findRequest(identity(chosen.input)), baseline.data[1].value);
  assert.equal(third.unfinished, 2);
});

test('packed-only terminal update creates a higher-revision loose override without changing the archived bytes', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), [job] = await seed(first, 1);
  const original = await fs.readFile(first.file(job.id));
  await first.packTerminalReceipts();
  await first.close();
  const second = make(); await second.init();
  await retireWithFixtureBackup(second);
  const archive = (await archiveFiles(storeDir))[0], archiveBytes = await fs.readFile(path.join(storeDir, archive));
  const updated = await second.update(job.id, () => ({ result: { success: true, updated: 'exact retained override' } }));
  assert.equal(updated.revision, 3);
  assert.equal((await looseFiles(storeDir)).length, 1);
  assert.deepEqual(await fs.readFile(path.join(storeDir, archive)), archiveBytes);
  assert.ok(!(await fs.readFile(second.file(job.id))).equals(original));
  await second.close();
  const third = make(); await third.init();
  assert.deepEqual((await third.get(job.id)).result, updated.result);
  assert.equal((await third.admit(job.input)).created, false);
  assert.equal((await retireWithFixtureBackup(third)).removed, 0, 'never delete a newer override');
  assert.deepEqual(await fs.readFile(path.join(storeDir, archive)), archiveBytes);
});

test('post-startup archive tampering is detected on access and blocks later admissions', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), [job] = await seed(first, 1);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second);
  const archive = path.join(storeDir, (await archiveFiles(storeDir))[0]);
  const bytes = await fs.readFile(archive), mutated = Buffer.from(bytes);
  mutated[mutated.length - 3] ^= 1;
  await fs.writeFile(archive, mutated);
  await assert.rejects(second.get(job.id), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(second.admit(request('other-job')), { code: 'DIRECT_JOB_STORAGE' });
  await second.close();
  const third = make();
  await assert.rejects(third.init(), { code: 'DIRECT_JOB_STORAGE' });
});

test('stage crash before manifest publication leaves originals, failed adoption does not admit work', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), jobs = await seed(first, 5);
  const originals = await Promise.all(jobs.map(job => fs.readFile(first.file(job.id))));
  const io = first.io;
  first.io = { ...io, rename: async (a, b) => {
    if (b.endsWith(PACK_MANIFEST)) throw errorWith('EIO');
    return io.rename(a, b);
  } };
  await assert.rejects(first.packTerminalReceipts(), { code: 'DIRECT_JOB_STORAGE' });
  await first.close();
  assert.equal((await looseFiles(storeDir)).length, 5);
  assert.equal((await fs.readdir(storeDir)).includes(PACK_MANIFEST), false);
  const second = make(); await second.init();
  assert.deepEqual((await Promise.all(jobs.map(job => second.get(job.id)))).map(v => v.id), jobs.map(j => j.id));
  assert.deepEqual(await Promise.all(jobs.map(job => fs.readFile(second.file(job.id)))), originals);
  assert.equal((await second.admit(jobs[0].input)).created, false);
});

test('lost manifest rename acknowledgement is reconciled by exact committed manifest bytes', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), jobs = await seed(first, 5);
  const io = first.io; let injected = false;
  first.io = { ...io, rename: async (a, b) => {
    if (b.endsWith(PACK_MANIFEST) && !injected) {
      injected = true; await io.rename(a, b); throw errorWith('EPERM');
    }
    return io.rename(a, b);
  } };
  const packed = await first.packTerminalReceipts();
  assert.equal(packed.staged, 5);
  assert.equal((await looseFiles(storeDir)).length, 5);
  assert.ok(injected);
  await first.close();
  const second = make(); await second.init();
  assert.equal(second.packedIndex.size, 5);
  assert.equal((await second.admit(jobs[0].input)).created, false);
  assert.equal((await retireWithFixtureBackup(second)).removed, 5);
});

test('corrupted, missing, replaced and contradictory packed sources fail closed', async t => {
  for (const fault of ['segment-missing','segment-corrupt','manifest-corrupt','same-revision-conflict','marker-missing']) {
    await t.test(fault, async t => {
      const { make, storeDir } = await fixture(t);
      const first = make(), [job] = await seed(first, 1);
      await first.packTerminalReceipts(); await first.close();
      if (fault === 'segment-missing') await fs.unlink(path.join(storeDir, (await archiveFiles(storeDir))[0]));
      if (fault === 'segment-corrupt') {
        const segment = path.join(storeDir, (await archiveFiles(storeDir))[0]), bytes = await fs.readFile(segment);
        bytes[bytes.length - 1] ^= 4; await fs.writeFile(segment, bytes);
      }
      if (fault === 'manifest-corrupt') await fs.writeFile(path.join(storeDir, PACK_MANIFEST), '{broken manifest');
      if (fault === 'same-revision-conflict') {
        const file = first.file(job.id), value = JSON.parse(await fs.readFile(file, 'utf8'));
        value.result = { success: true, forged: true };
        await fs.writeFile(file, JSON.stringify(value));
      }
      if (fault === 'marker-missing') {
        const second = make(); await second.init(); await retireWithFixtureBackup(second); await second.close();
        await fs.unlink(path.join(storeDir, PACK_MARKER));
      }
      const reopened = make();
      await assert.rejects(reopened.init(), { code: 'DIRECT_JOB_STORAGE' });
      await assert.rejects(reopened.admit(request('new-application')), { code: 'DIRECT_JOB_STORAGE' });
    });
  }
});

test('partial duplicate retirement and restart keep no-replay, byte equivalence and marker guard', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), jobs = await seed(first, 8, { unfinished: 1 });
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init();
  const original = new Map(await Promise.all(jobs.map(async job => [job.id, await fs.readFile(second.file(job.id))])));
  const io = second.io; let deletes = 0;
  second.io = { ...io, unlink: async file => {
    if (file.endsWith('.json') && path.basename(file) !== PACK_MANIFEST && path.basename(file) !== PACK_MARKER) {
      deletes++;
      if (deletes === 3) throw errorWith('EACCES');
    }
    return io.unlink(file);
  } };
  await assert.rejects(retireWithFixtureBackup(second, { maxRecords: 7 }), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(deletes, 3);
  assert.equal(await fs.readFile(path.join(storeDir, PACK_MARKER), 'utf8'), PACK_MARKER_CONTENT);
  await second.close();
  const third = make(); await third.init();
  assert.equal(third.unfinished, 1);
  assert.equal((await third.get(jobs[7].id)).status, 'awaiting_input');
  for (const job of jobs) assert.equal((await third.get(job.id)).id, job.id);
  const finish = await retireWithFixtureBackup(third);
  assert.equal(finish.removed, 5);
  for (const job of jobs.filter(j => j.terminal)) {
    assert.equal((await third.get(job.id)).status, 'succeeded');
    assert.equal(sha(original.get(job.id)), third.records.get(job.id).receiptHash);
  }
  assert.equal((await looseFiles(storeDir)).length, 1);
});



test('lost rollback-marker link and duplicate-unlink acknowledgments are independently verified without replay', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), jobs = await seed(first, 4);
  const originals = await Promise.all(jobs.map(job => fs.readFile(first.file(job.id))));
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init();
  const io = second.io;
  let markerAcknowledgmentLost = false, deletionAcknowledgmentLost = false;
  second.io = { ...io,
    link: async (from, to) => {
      if (to === path.join(storeDir, PACK_MARKER) && !markerAcknowledgmentLost) {
        markerAcknowledgmentLost = true; await io.link(from, to); throw errorWith('EPERM');
      }
      return io.link(from, to);
    },
    unlink: async file => {
      if (path.basename(file).startsWith('direct_') && file.endsWith('.json') &&
          path.basename(file) !== PACK_MARKER && !deletionAcknowledgmentLost) {
        deletionAcknowledgmentLost = true; await io.unlink(file); throw errorWith('EACCES');
      }
      return io.unlink(file);
    },
  };
  const result = await retireWithFixtureBackup(second);
  assert.equal(result.removed, 4);
  assert.equal(markerAcknowledgmentLost, true);
  assert.equal(deletionAcknowledgmentLost, true);
  assert.equal((await looseFiles(storeDir)).length, 0);
  await second.close();
  const third = make(); await third.init();
  for (let i = 0; i < jobs.length; i++) {
    assert.equal((await third.admit(jobs[i].input)).created, false);
    assert.equal(third.records.get(jobs[i].id).receiptHash, sha(originals[i]));
  }
});

test('explicit segment-byte cap bounds a staged pack and leaves larger originals untouched', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), jobs = await seed(first, 3);
  const firstRaw = await fs.readFile(first.file(jobs[0].id));
  const allowed = 8 + 4 + firstRaw.length;
  const result = await first.packTerminalReceipts({ maxRecords: 3, maxBytes: allowed });
  assert.equal(result.staged, 1);
  assert.ok(result.bytes <= allowed);
  assert.equal((await archiveFiles(storeDir)).length, 1);
  assert.equal((await looseFiles(storeDir)).length, 3);
  assert.deepEqual(await fs.readFile(first.file(jobs[0].id)), firstRaw);
  await first.close();
  const second = make(); await second.init();
  assert.equal(second.packedIndex.size, 1);
  assert.equal((await retireWithFixtureBackup(second)).removed, 1);
  assert.equal((await looseFiles(storeDir)).length, 2);
});


test('post-startup manifest or rollback-marker mutation blocks every subsequent operation', async t => {
  for (const changed of ['manifest', 'marker']) {
    await t.test(changed, async t => {
      const { make, storeDir } = await fixture(t);
      const initial = make(), [job] = await seed(initial, 1);
      await initial.packTerminalReceipts(); await initial.close();
      const reloaded = make(); await reloaded.init();
      await retireWithFixtureBackup(reloaded);
      const source = changed === 'manifest' ? path.join(storeDir, PACK_MANIFEST) : path.join(storeDir, PACK_MARKER);
      if (changed === 'manifest') {
        const document = JSON.parse(await fs.readFile(source, 'utf8'));
        await fs.writeFile(source, JSON.stringify(document, null, 2));
      } else await fs.writeFile(source, 'tampered rollback marker');
      await assert.rejects(reloaded.get(job.id), { code: 'DIRECT_JOB_STORAGE' });
      await assert.rejects(reloaded.counts(), { code: 'DIRECT_JOB_STORAGE' });
      await assert.rejects(reloaded.admit(request('fresh-after-corruption')), { code: 'DIRECT_JOB_STORAGE' });
      assert.equal((await looseFiles(storeDir)).length, 0);
    });
  }
});

test('Windows manifest publication retries transient file locks without deleting originals', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make({ platform: 'win32' }), jobs = await seed(first, 7);
  const io = first.io; let conflicts = 0;
  first.io = { ...io, rename: async (from, to) => {
    if (to === path.join(storeDir, PACK_MANIFEST) && conflicts++ < 2) throw errorWith('EBUSY');
    return io.rename(from, to);
  } };
  const result = await first.packTerminalReceipts();
  assert.equal(result.staged, 7);
  assert.ok(conflicts >= 3);
  assert.equal((await looseFiles(storeDir)).length, 7);
  await first.close();
  const second = make(); await second.init();
  assert.equal(second.packedIndex.size, 7);
  assert.equal((await second.admit(jobs[0].input)).created, false);
});

test('unavailable archive publish and downgrade marker do not destroy originals', async t => {
  for (const fault of ['segment-link','manifest-rename','marker-link']) {
    await t.test(fault, async t => {
      const { make, storeDir } = await fixture(t), first = make();
      const jobs = await seed(first, 4);
      const original = await Promise.all(jobs.map(job => fs.readFile(first.file(job.id))));
      if (fault !== 'marker-link') {
        const io = first.io;
        first.io = {
          ...io,
          link: async (src, dest) => {
            if (fault === 'segment-link' && dest.endsWith('.bin')) throw errorWith('EACCES');
            return io.link(src, dest);
          },
          rename: async (src, dest) => {
            if (fault === 'manifest-rename' && dest.endsWith(PACK_MANIFEST)) throw errorWith('EACCES');
            return io.rename(src, dest);
          },
        };
        await assert.rejects(first.packTerminalReceipts(), { code: 'DIRECT_JOB_STORAGE' });
        await first.close();
        const second = make(); await second.init();
        assert.equal(second.packedIndex.size, 0);
        for (let i = 0; i < jobs.length; i++)
          assert.deepEqual(await fs.readFile(second.file(jobs[i].id)), original[i]);
        assert.equal((await looseFiles(storeDir)).length, 4);
      } else {
        await first.packTerminalReceipts(); await first.close();
        const second = make(); await second.init();
        const io = second.io;
        second.io = { ...io, link: async (src, dest) => {
          if (dest === path.join(storeDir, PACK_MARKER)) throw errorWith('EBUSY');
          return io.link(src, dest);
        } };
        await assert.rejects(retireWithFixtureBackup(second), { code: 'DIRECT_JOB_STORAGE' });
        assert.equal((await looseFiles(storeDir)).length, 4);
        assert.equal(await fs.stat(path.join(storeDir, PACK_MARKER)).then(() => true, () => false), false);
        await second.close();
        const third = make(); await third.init();
        assert.equal(third.packedIndex.size, 4);
        assert.equal((await retireWithFixtureBackup(third)).removed, 4);
        for (let i = 0; i < jobs.length; i++)
          assert.equal(third.records.get(jobs[i].id).receiptHash, sha(original[i]));
      }
    });
  }
});

test('archive cannot legitimize changed admitted-request fields in a higher-revision loose override', async t => {
  const { make } = await fixture(t);
  const first = make(), [job] = await seed(first, 1);
  await first.packTerminalReceipts(); await first.close();
  const file = first.file(job.id);
  const altered = JSON.parse(await fs.readFile(file, 'utf8'));
  altered.revision++;
  altered.client = { ...altered.client, scopes: ['read'] };
  altered.result = { success: true, changed: true };
  await fs.writeFile(file, JSON.stringify(altered));
  const reopened = make();
  await assert.rejects(reopened.init(), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(reopened.admit(request('new-after-immutable-change')), { code: 'DIRECT_JOB_STORAGE' });
});

test('unfinished dispatched side effects stay individually recovered and are never replayed after pack retirement', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), terminal = await seed(first, 2);
  const runningInput = request('running-uncertain');
  const running = (await first.admit(runningInput)).job;
  await first.update(running.id, () => ({
    status: 'running', dispatched: true, startedAt: new Date().toISOString(),
  }));
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init();
  assert.equal((await second.get(running.id)).status, 'interrupted');
  assert.equal((await second.get(running.id)).effects.possible, true);
  assert.equal((await second.admit(runningInput)).created, false);
  await retireWithFixtureBackup(second);
  assert.equal((await looseFiles(storeDir)).length, 1);
  await second.close();
  const third = make(); await third.init();
  const uncertain = await third.get(running.id);
  assert.equal(uncertain.status, 'interrupted');
  assert.equal(uncertain.effects.possible, true);
  assert.equal(uncertain.effects.confirmed, false);
  assert.equal((await third.admit(runningInput)).created, false);
  assert.equal((await third.admit(terminal[0].input)).created, false);
});


test('readiness and admissions remain blocked until an entire published pack is validated', async t => {
  const { make } = await fixture(t);
  const first = make(), jobs = await seed(first, 4);
  await first.packTerminalReceipts(); await first.close();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  let blocked = true, admitted = false;
  const io = { ...fs, open: async (file, ...args) => {
    if (blocked && typeof file === 'string' && /terminal-pack-[a-f0-9]{32}\.bin$/.test(file)) {
      blocked = false; entered(); await gate;
    }
    return fs.open(file, ...args);
  } };
  const reopened = make({ io });
  let initSettled = false;
  const initializing = reopened.init().then(() => { initSettled = true; });
  const admission = reopened.admit(request('new-after-checked-pack')).then(v => {
    admitted = true; return v;
  });
  await reached;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(initSettled, false);
  assert.equal(admitted, false);
  assert.equal(reopened.hasLease, true);
  release();
  await initializing;
  assert.equal((await admission).created, true);
  assert.equal(reopened.packedIndex.size, 4);
  assert.equal((await reopened.admit(jobs[0].input)).created, false);
});

test('unavailable packed-segment storage fails closed without replacing original loose receipts', async t => {
  const { make, storeDir } = await fixture(t);
  const original = make(), jobs = await seed(original, 4);
  const looseBefore = await Promise.all(jobs.map(job => fs.readFile(original.file(job.id))));
  await original.packTerminalReceipts(); await original.close();
  const io = { ...fs, open: async (file, ...args) => {
    if (typeof file === 'string' && /terminal-pack-[a-f0-9]{32}\.bin$/.test(file))
      throw errorWith('EACCES');
    return fs.open(file, ...args);
  } };
  const rejected = make({ io });
  await assert.rejects(rejected.init(), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(rejected.admit(request('never-admitted')), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(rejected.hasLease, false);
  assert.equal((await looseFiles(storeDir)).length, 4);
  assert.deepEqual(await Promise.all(jobs.map(job => fs.readFile(original.file(job.id)))), looseBefore);
});

test('full schema validation still rejects frames even when a tampered segment and manifest hashes agree', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(); await seed(first, 1);
  await first.packTerminalReceipts(); await first.close();
  const segmentFile = path.join(storeDir, (await archiveFiles(storeDir))[0]);
  const bytes = await fs.readFile(segmentFile);
  const length = bytes.readUInt32LE(8), offset = 12;
  const original = bytes.subarray(offset, offset + length).toString('utf8');
  assert.ok(original.includes('"version":1'));
  const modified = original.replace('"version":1', '"version":0');
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(modified));
  bytes.write(modified, offset, 'utf8');
  await fs.writeFile(segmentFile, bytes);
  const manifestFile = path.join(storeDir, PACK_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.segments[0].sha256 = sha(bytes);
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const second = make();
  await assert.rejects(second.init(), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal((await looseFiles(storeDir)).length, 1);
});

test('terminal record can transition to dispatched nonterminal and recover uncertainty with intact archived original', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), [job] = await seed(first, 1);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second);
  const changed = await second.update(job.id, () => ({
    status: 'running', dispatched: true, finishedAt: null, startedAt: new Date().toISOString(),
    effects: { possible: true, confirmed: false },
  }));
  assert.equal(changed.status, 'running');
  assert.equal((await looseFiles(storeDir)).length, 1);
  await second.close();
  const third = make(); await third.init();
  const recovered = await third.get(job.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.revision, changed.revision + 1);
  assert.equal(recovered.effects.possible, true);
  assert.equal(recovered.effects.confirmed, false);
  assert.equal((await third.admit(job.input)).created, false);
});

test('published pack manifest deletion after retirement cannot silently re-admit archived requests', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), [job] = await seed(first, 1);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second); await second.close();
  assert.equal((await looseFiles(storeDir)).length, 0);
  assert.equal(await fs.readFile(path.join(storeDir, PACK_MARKER), 'utf8'), PACK_MARKER_CONTENT);
  await fs.unlink(path.join(storeDir, PACK_MANIFEST));
  const third = make();
  await assert.rejects(third.init(), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(third.admit(job.input), { code: 'DIRECT_JOB_STORAGE' });
});



test('installed-style startup trace and ledger metrics remain truthful for fully archived receipts', async t => {
  const { directory, make } = await fixture(t);
  const first = make(), jobs = await seed(first, 8, { unfinished: 2 });
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second); await second.close();
  const trace = new StartupCriticalTrace({ dataDir: directory, startTimer: false, version: '2.39.101' });
  await trace.start({ buildFiles: { code: path.resolve(new URL('../lib/direct-execution-jobs.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')) } });
  let diagnostics;
  const third = make({ startupTrace: trace, onStartupDiagnostics: event => { diagnostics = event; } });
  await third.init(); await trace.finish('ready');
  assert.deepEqual(await third.counts(), { total: 8, unfinished: 2 });
  assert.equal(third.packedIndex.size, 6);
  assert.equal(trace.ledger.required, 8);
  assert.equal(trace.ledger.dispatched, 8);
  assert.equal(trace.ledger.validated, 8);
  assert.equal(trace.ledger.failed, 0);
  assert.equal(diagnostics.outcome, 'ready');
  assert.equal(diagnostics.receipts, 8);
  assert.equal(diagnostics.recovered, 0);
  for (const job of jobs) assert.equal((await third.get(job.id)).id, job.id);
});

test('512 real temporary-file opens become two fully checked segment-file opens after retirement', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make(), [seeded] = await seed(first, 1);
  const template = await first.get(seeded.id);
  await first.close();
  const count = 512;
  for (let i = 0; i < count; i++) {
    const input = request('scale-' + String(i).padStart(5, '0'));
    const digest = directRequestDigest({ tool: input.tool, arguments: input.arguments });
    const id = 'direct_' + sha(input.ownerId + '\0' + input.requestId);
    const record = { ...template, id, ownerId: input.ownerId, requestId: input.requestId,
      requestDigest: digest, storedRequestDigest: digest,
      arguments: input.arguments, client: input.client, createdAt: template.createdAt,
      result: { success: true, contentItems: [{ type: 'inputText', text: 'scale-' + i + '-Café' }] } };
    await fs.writeFile(path.join(storeDir, id + '.json'), JSON.stringify(record));
  }
  const metrics = () => ({ loose: 0, segment: 0 });
  const ioFor = counter => ({ ...fs, readFile: async (file, ...args) => {
    if (typeof file === 'string' && /^direct_[a-f0-9]{64}\.json$/.test(path.basename(file)) &&
        path.basename(file) !== PACK_MARKER) counter.loose++;
    if (typeof file === 'string' && /^terminal-pack-[a-f0-9]{32}\.bin$/.test(path.basename(file))) counter.segment++;
    return fs.readFile(file, ...args);
  },
    open: async (file, ...args) => {
      if (typeof file === 'string' && /^terminal-pack-[a-f0-9]{32}\.bin$/.test(path.basename(file))) counter.segment++;
      return fs.open(file, ...args);
    },
  });
  const baselineCounter = metrics(), baseline = make({ io: ioFor(baselineCounter) }); await baseline.init();
  const looseBefore = baselineCounter.loose;
  assert.equal(looseBefore, 513);
  const hashBefore = sha(JSON.stringify((await baseline.snapshot()).map(item => [item.id, item.status, item.revision])));
  const firstPack = await baseline.packTerminalReceipts({ maxRecords: 256 });
  const secondPack = await baseline.packTerminalReceipts({ maxRecords: 256 });
  const finalPack = await baseline.packTerminalReceipts({ maxRecords: 256 });
  assert.equal(firstPack.staged, 256);
  assert.equal(secondPack.staged, 256);
  assert.equal(finalPack.staged, 1);
  await baseline.close();
  const verifier = make(); await verifier.init();
  assert.equal(verifier.packedIndex.size, 513);
  assert.equal((await retireWithFixtureBackup(verifier, { maxRecords: 256 })).removed, 256);
  assert.equal((await retireWithFixtureBackup(verifier, { maxRecords: 256 })).removed, 256);
  assert.equal((await retireWithFixtureBackup(verifier, { maxRecords: 256 })).removed, 1);
  await verifier.close();
  const packedCounter = metrics(), packed = make({ io: ioFor(packedCounter) }); await packed.init();
  assert.equal(packedCounter.loose, 0);
  assert.equal(packedCounter.segment, 3);
  const packedStartupFileOpens = packedCounter.segment + packedCounter.loose;
  const hashAfter = sha(JSON.stringify((await packed.snapshot()).map(item => [item.id, item.status, item.revision])));
  assert.equal(hashAfter, hashBefore);
  assert.equal((await packed.counts()).total, 513);
  assert.equal((await packed.get(seeded.id)).id, seeded.id);
  t.diagnostic(JSON.stringify({ source: 'synthetic-only', fixtureReceipts: 513,
    byteSizeCeiling: 'a few megabytes, not the installed 1.34 GB',
    unarchivedStartupFileOpens: looseBefore, packedStartupFileOpens,
    segmentCount: packedStartupFileOpens, recordStateHash: hashAfter,
    installedStartupSpeedupMeasured: false }));
});

test('constrained real filesystem open counts decrease after fully validated packed retirement', async t => {
  const { make, storeDir } = await fixture(t);
  const first = make();
  const jobs = await seed(first, 90, { unfinished: 6 });
  await first.close();
  const counters = () => ({ looseReads: 0, segmentReads: 0, archiveOpens: 0 });
  const counted = counter => ({
    ...fs,
    readFile: async (file, ...args) => {
      if (typeof file === 'string' && /direct_[a-f0-9]{64}\.json$/.test(file) && !file.endsWith(PACK_MARKER)) counter.looseReads++;
      if (typeof file === 'string' && /terminal-pack-[a-f0-9]{32}\.bin$/.test(file)) counter.segmentReads++;
      return fs.readFile(file, ...args);
    },
    open: async (file, ...args) => {
      if (typeof file === 'string' && /terminal-pack-[a-f0-9]{32}\.bin$/.test(file)) { counter.archiveOpens++; counter.segmentReads++; }
      return fs.open(file, ...args);
    },
  });
  const beforeCounts = counters(), baseline = make({ io: counted(beforeCounts) });
  const startBaseline = performance.now(); await baseline.init();
  const baselineWallMs = performance.now() - startBaseline;
  assert.equal(beforeCounts.looseReads, 90);
  const baselineReceiptFileOpens = beforeCounts.looseReads;
  const expected = await snapshotState(baseline, jobs);
  await baseline.packTerminalReceipts({ maxRecords: 45 }); await baseline.packTerminalReceipts({ maxRecords: 45 });
  await baseline.close();
  const stage = make(); await stage.init();
  assert.equal((await retireWithFixtureBackup(stage, { maxRecords: 90 })).removed, 84);
  await stage.close();
  const afterCounts = counters(), packed = make({ io: counted(afterCounts) });
  const startPacked = performance.now(); await packed.init();
  const packedWallMs = performance.now() - startPacked;
  assert.equal(afterCounts.looseReads, 6);
  assert.equal(afterCounts.segmentReads, 2);
  const packedReceiptFileOpens = afterCounts.looseReads + afterCounts.segmentReads;
  const segmentCount = afterCounts.segmentReads;
  assert.equal(packed.packedIndex.size, 84);
  assert.deepEqual(await snapshotState(packed, jobs), expected);
  assert.equal((await looseFiles(storeDir)).length, 6);
  t.diagnostic(JSON.stringify({ baselineReceiptFileOpens,
    packedReceiptFileOpens,
    segments: segmentCount, validatedJobs: packed.records.size,
    baselineComponentWallMs: Math.round(baselineWallMs),
    packedComponentWallMs: Math.round(packedWallMs),
    syntheticOnly: true, cacheUncontrolled: true, packagedWindowsClaim: false }));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPinnedLegacyReader, verifyPinnedLegacyReader } from './fixtures/pinned-legacy-reader.mjs';
import { DirectExecutionJobs, directRequestDigest } from '../lib/direct-execution-jobs.mjs';
import { StartupCriticalTrace } from '../lib/startup-critical-trace.mjs';
import { PACK_MARKER, PACK_MANIFEST } from '../lib/direct-execution-packs.mjs';
import { RECEIPT_BACKUP_JOURNAL } from '../lib/direct-execution-pack-recovery.mjs';
import { retireWithFixtureBackup } from './fixtures/retire-with-verified-fixture.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const client = ownerId => ({ id: ownerId, label: 'synthetic fixture', kind: 'chatgpt', scopes: ['read', 'browser:read'] });
const admission = (i, ownerId = i % 5 === 0 ? 'owner-beta' : 'owner-alpha') => ({
  ownerId, requestId: 'restore-' + i, tool: 'blackice_browser_read',
  arguments: { action: 'read', expectedUrl: 'https://example.test/receipt/' + i },
  requiredScopes: ['browser:read'], client: client(ownerId), mutating: false,
});
async function makeFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-pack-rollout-'));
  const destination = dataDir + '-export', sources = [];
  const make = opts => { const s = new DirectExecutionJobs({ dataDir, ...opts }); sources.push(s); return s; };
  t.after(async () => {
    await Promise.allSettled(sources.map(s => s.close()));
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(destination, { recursive: true, force: true });
  });
  return { dataDir, directory: path.join(dataDir, 'direct-execution-jobs'), destination, make };
}
async function seed(store, amount, { unfinished = 0 } = {}) {
  const jobs = [];
  for (let i = 0; i < amount; i++) {
    const input = admission(i), job = (await store.admit(input)).job;
    if (i < amount - unfinished) await store.update(job.id, () => ({
      status: 'succeeded', dispatched: true, finishedAt: new Date().toISOString(),
      result: { success: true, contentItems: [{ type: 'inputText', text: 'Café 日本語 ' + i + ' '.repeat(i % 11) }] },
    }));
    else await store.update(job.id, () => ({ status: 'awaiting_input',
      interaction: { id: 'user-required-' + i, kind: 'verification' } }));
    jobs.push({ input, job, terminal: i < amount - unfinished });
  }
  return jobs;
}
async function snapshot(store, jobs) {
  const result = [];
  for (const { job } of jobs) result.push(await store.get(job.id));
  return { counts: await store.counts(), records: result,
    ownerScoped: (await store.list({ ownerId: 'owner-alpha' })).jobs.map(v => v.id),
    history: await store.resourceHistory({ ownerId: 'owner-alpha', scopes: ['browser:read'],
      urls: [admission(1).arguments.expectedUrl], limit: 3 }) };
}
async function untilPhase(store, destination, action, { maxRecords = 3, maxBytes = 16 * 1024 * 1024 } = {}) {
  const reports = [];
  for (let i = 0; i < 200; i++) {
    const report = await store[action]({ destination, maxRecords, maxBytes });
    reports.push(report);
    if (action === 'exportReceiptBackup' && report.phase === 'complete') return reports;
    if (action === 'restoreReceiptBackup' && report.fullyRestored) return reports;
  }
  assert.fail('Bounded legacy recovery never reached its terminal phase.');
}
test('verified bounded receipt backup/restore preserves exact data and the packed guard', async t => {
  const { directory, destination, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 11, { unfinished: 2 });
  for (const name of ['finishLegacyDowngrade','retirePackedDuplicatesWithVerifiedExport','exportLegacyReceipts','restoreLegacyReceipts']) assert.equal(typeof first[name], 'undefined', name);
  assert.equal(RECEIPT_BACKUP_JOURNAL, 'legacy-export-v1.json', 'Durable backup filename is unchanged.');
  const baseline = await snapshot(first, jobs);
  const original = new Map();
  for (const { job } of jobs) original.set(job.id, await fs.readFile(first.file(job.id)));
  for (let i = 0; i < 3; i++) assert.equal((await first.packTerminalReceipts({ maxRecords: 3 })).removed, 0);
  await first.close();
  const second = make(); await second.init();
  assert.equal((await retireWithFixtureBackup(second, { maxRecords: 9 })).removed, 9);
  await second.close();

  const oldModule = await loadPinnedLegacyReader();
  const rejected = new oldModule.DirectExecutionJobs({ dataDir: path.dirname(directory) });
  await assert.rejects(rejected.init(), { code: 'DIRECT_JOB_STORAGE' });
  await rejected.close();

  const third = make(); await third.init();
  const exportReports = await untilPhase(third, destination, 'exportReceiptBackup', { maxRecords: 3 });
  assert.ok(exportReports.some(x => x.phase === 'verify'));
  const journal = JSON.parse(await fs.readFile(path.join(destination, RECEIPT_BACKUP_JOURNAL), 'utf8'));
  assert.equal(journal.phase, 'complete');
  assert.equal(journal.total, 11);
  assert.equal(journal.copyCursor, 11);
  assert.equal(journal.verifyCursor, 11);
  assert.deepEqual(await snapshot(third, jobs), baseline);
  const restoreReports = await untilPhase(third, destination, 'restoreReceiptBackup', { maxRecords: 2 });
  assert.equal(restoreReports.at(-1).remaining, 0);
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true), true);
  for (const { job } of jobs)
    assert.deepEqual(await fs.readFile(third.file(job.id)), original.get(job.id));
  assert.equal(typeof third.finishLegacyDowngrade, 'undefined');
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true), true);
  assert.equal(await fs.stat(path.join(directory, PACK_MANIFEST)).then(() => true), true);
  await third.close();
  const old = new oldModule.DirectExecutionJobs({ dataDir: path.dirname(directory) });
  await assert.rejects(old.init(), { code: 'DIRECT_JOB_STORAGE' });
  await old.close();
  const newAgain = make(); await newAgain.init();
  assert.deepEqual(await snapshot(newAgain, jobs), baseline);
});

test('receipt restoration refuses stale source revisions without dropping guard', async t => {
  const { directory, destination, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 4);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second);
  await untilPhase(second, destination, 'exportReceiptBackup', { maxRecords: 2 });
  const changed = await second.update(jobs[0].job.id, () => ({ result: { success: true, changed: 'new revision' } }));
  assert.ok(changed.revision > 2);
  await assert.rejects(second.restoreReceiptBackup({ destination }), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true), true);
});

test('capacity fail-closed before staging leaves authoritative store usable, without new segment', async t => {
  const { directory, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 4);
  const io = first.io;
  let calls = 0;
  first.io = { ...io, statfs: async () => {
    calls++;
    return { bsize: 4096n, bavail: 1024n };
  } };
  await assert.rejects(first.packTerminalReceipts({ maxRecords: 3 }), error => {
    t.diagnostic('preflight=' + error.code + ', cause=' + error.cause?.code + ', detail=' + error.cause?.message);
    return error.code === 'DIRECT_JOB_INSUFFICIENT_SPACE';
  });
  assert.ok(calls > 0);
  assert.equal(first.storageError, null, 'preflight must not poison ordinary ledger use');
  assert.equal((await first.admit(jobs[0].input)).created, false);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.bin')), false);
  first.io = io;
  const packed = await first.packTerminalReceipts({ maxRecords: 3 });
  assert.equal(packed.staged, 3);
  assert.equal(packed.diskSpace.source, 'filesystem-statfs');
  assert.equal(packed.directorySync.segment.powerLossProven, false);
  assert.equal(packed.directorySync.manifest.powerLossProven, false);
});


test('newer loose override backs up and restores exactly without reviving archived effects', async t => {
  const { directory, destination, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 2);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second);
  const advanced = await second.update(jobs[0].job.id, () => ({
    result: { success: true, revisionMarker: 'newer-loose-revision' },
  }));
  assert.equal(advanced.revision, 3);
  await untilPhase(second, destination, 'exportReceiptBackup', { maxRecords: 1 });
  const exported = JSON.parse(await fs.readFile(path.join(destination, 'direct-execution-jobs', jobs[0].job.id + '.json'), 'utf8'));
  assert.equal(exported.revision, 3);
  assert.deepEqual(exported.result, advanced.result);
  await untilPhase(second, destination, 'restoreReceiptBackup', { maxRecords: 1 });
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true), true);
  await second.close();
  const old = make();
  await old.init();
  assert.equal((await old.get(jobs[0].job.id)).revision, 3);
  assert.deepEqual((await old.get(jobs[0].job.id)).result, advanced.result);
  assert.equal((await old.admit(jobs[0].input)).created, false);
  await old.close();
});

test('completed independent loose export remains bootable by old source when active pack becomes corrupt', async t => {
  const { directory, destination, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 3);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second);
  await untilPhase(second, destination, 'exportReceiptBackup', { maxRecords: 2 });
  await second.close();
  const segment = (await fs.readdir(directory)).find(name => name.endsWith('.bin'));
  const bytes = await fs.readFile(path.join(directory, segment));
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(path.join(directory, segment), bytes);
  const damaged = make(); await assert.rejects(damaged.init(), { code: 'DIRECT_JOB_STORAGE' });
  const oldModule = await loadPinnedLegacyReader();
  const standalone = new oldModule.DirectExecutionJobs({ dataDir: destination });
  await standalone.init();
  for (const { job, input } of jobs) {
    assert.equal((await standalone.get(job.id)).id, job.id);
    assert.equal((await standalone.admit(input)).created, false);
  }
  await standalone.close();
  assert.equal((await fs.readdir(destination)).includes(RECEIPT_BACKUP_JOURNAL), true);
});

test('export and restoration capacity refusals keep all archived bytes and the old-source refusal marker', async t => {
  const { directory, destination, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 3);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second);
  const originalIO = second.io;
  second.io = { ...originalIO, statfs: async () => ({ bsize: 4096n, bavail: 5n }) };
  await assert.rejects(second.exportReceiptBackup({ destination }), { code: 'DIRECT_JOB_INSUFFICIENT_SPACE' });
  assert.equal(second.storageError, null);
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true), true);
  second.io = originalIO;
  await untilPhase(second, destination, 'exportReceiptBackup', { maxRecords: 1 });
  second.io = { ...originalIO, statfs: async () => ({ bsize: 4096n, bavail: 5n }) };
  await assert.rejects(second.restoreReceiptBackup({ destination }), { code: 'DIRECT_JOB_INSUFFICIENT_SPACE' });
  assert.equal(second.storageError, null);
  assert.equal((await fs.readdir(directory)).filter(name => /^direct_[a-f0-9]{64}\.json$/.test(name) &&
    name !== PACK_MARKER).length, 0);
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true), true);
  second.io = originalIO;
  await untilPhase(second, destination, 'restoreReceiptBackup', { maxRecords: 2 });
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true), true);
  for (const { job } of jobs) assert.equal((await second.get(job.id)).id, job.id);
});

test('lost Windows journal rename acknowledgment and transient busy retries preserve verified progress', async t => {
  const { destination, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 5);
  const originalIO = first.io; let busy = 0, lost = false;
  first.io = { ...originalIO, rename: async (from, to) => {
    if (to === path.join(destination, RECEIPT_BACKUP_JOURNAL)) {
      if (busy++ < 2) throw Object.assign(Error('journal busy'), { code: 'EBUSY' });
      if (!lost) { lost = true; await originalIO.rename(from, to); throw Object.assign(Error('lost acknowledgment'), { code: 'EPERM' }); }
    }
    return originalIO.rename(from, to);
  } };
  await untilPhase(first, destination, 'exportReceiptBackup', { maxRecords: 2 });
  assert.ok(busy >= 3);
  assert.equal(lost, true);
  const journal = JSON.parse(await fs.readFile(path.join(destination, RECEIPT_BACKUP_JOURNAL), 'utf8'));
  assert.equal(journal.phase, 'complete');
  assert.equal(journal.total, 5);
  const oldModule = await loadPinnedLegacyReader();
  const old = new oldModule.DirectExecutionJobs({ dataDir: destination }); await old.init();
  for (const { job } of jobs) assert.equal((await old.get(job.id)).id, job.id);
  await old.close();
});

test('tampered backup refuses restoration and leaves the packed guard', async t => {
  const { directory, destination, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 2);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second);
  await untilPhase(second, destination, 'exportReceiptBackup', { maxRecords: 1 });
  const backupFile = path.join(destination, 'direct-execution-jobs', jobs[0].job.id + '.json');
  await fs.writeFile(backupFile, '{"private":"tampered export"}');
  await assert.rejects(second.restoreReceiptBackup({ destination }), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true), true);
  assert.equal((await second.admit(jobs[0].input)).created, false);
});


test('verified-backup retirement refuses incomplete or tampered exports before any loose deletion', async t => {
  const { directory, destination, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 4);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init();
  await assert.rejects(second.retirePackedDuplicates({ destination }), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal((await fs.readdir(directory)).filter(name => /^direct_[a-f0-9]{64}\.json$/.test(name) &&
    name !== PACK_MARKER).length, 4);
  await untilPhase(second, destination, 'exportReceiptBackup', { maxRecords: 2 });
  const bad = path.join(destination, 'direct-execution-jobs', jobs[1].job.id + '.json');
  const original = await fs.readFile(bad);
  await fs.writeFile(bad, '{"status":"forged"}');
  await assert.rejects(second.retirePackedDuplicates({ destination }), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal((await fs.readdir(directory)).filter(name => /^direct_[a-f0-9]{64}\.json$/.test(name) &&
    name !== PACK_MARKER).length, 4);
  await fs.writeFile(bad, original);
  const safe = await second.retirePackedDuplicates({ destination, maxRecords: 2 });
  assert.equal(safe.removed, 2);
  assert.equal(safe.verifiedBackup.checked, 2);
  assert.equal(safe.verifiedBackup.powerLossDurabilityProven, false);
  const remaining = await second.retirePackedDuplicates({ destination, maxRecords: 2 });
  assert.equal(remaining.removed, 2);
  assert.equal((await fs.readdir(directory)).filter(name => /^direct_[a-f0-9]{64}\.json$/.test(name) &&
    name !== PACK_MARKER).length, 0);
});

test('insufficient space for downgrade guard refuses before deleting any receipt and leaves normal ledger usable', async t => {
  const { directory, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 2);
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init();
  const real = second.io;
  second.io = { ...real, statfs: async () => ({ bsize: 4096n, bavail: 4n }) };
  await assert.rejects(retireWithFixtureBackup(second), { code: 'DIRECT_JOB_INSUFFICIENT_SPACE' });
  assert.equal(second.storageError, null);
  assert.equal(await fs.stat(path.join(directory, PACK_MARKER)).then(() => true, () => false), false);
  assert.equal((await second.admit(jobs[0].input)).created, false);
  second.io = real;
  assert.equal((await retireWithFixtureBackup(second)).removed, 2);
});

test('bounded segment read telemetry records segment open/read/validation/hydration, not receipt contents', async t => {
  const { directory, make } = await makeFixture(t);
  const first = make(), jobs = await seed(first, 6, { unfinished: 1 });
  await first.packTerminalReceipts(); await first.close();
  const second = make(); await second.init(); await retireWithFixtureBackup(second); await second.close();
  const trace = new StartupCriticalTrace({ dataDir: path.dirname(directory), startTimer: false, version: '2.39.101' });
  await trace.start({ buildFiles: { code: path.resolve(new URL('../lib/direct-execution-packs.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')) } });
  let receipt;
  const third = make({ startupTrace: trace, onStartupDiagnostics: value => { receipt = value; } });
  await third.init(); await trace.finish('ready');
  assert.equal(third.records.size, 6);
  for (const kind of ['pack-stat','pack-open','pack-read','pack-close','pack-validate','pack-hydrate'])
    assert.ok(trace.opMetrics[kind].completed > 0, kind);
  assert.equal(trace.opMetrics['pack-hydrate'].completed, 5);
  assert.equal(trace.opMetrics['pack-open'].completed, 1);
  assert.equal(trace.opMetrics['pack-read'].completed, 1);
  assert.equal(receipt.outcome, 'ready');
  assert.equal(receipt.receipts, 6);
  const serialized = JSON.stringify(trace.snapshot());
  assert.ok(!serialized.includes('Café'));
  assert.ok(!serialized.includes(jobs[0].job.id));
});

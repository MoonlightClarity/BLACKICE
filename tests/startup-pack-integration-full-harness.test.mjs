import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DirectExecutionJobs, directRequestDigest } from '../lib/direct-execution-jobs.mjs';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { StartupCriticalTrace } from '../lib/startup-critical-trace.mjs';
import { createProfileBackup, verifyProfileBackup, restoreProfileBackup } from '../lib/profile-backup.mjs';
import { loadPinnedLegacyReader } from './fixtures/pinned-legacy-reader.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binding = { platform: process.platform, userIdHash: 'a'.repeat(64), machineIdHash: 'b'.repeat(64) };
const backupSettings = { getBinding: async () => binding, isProcessAlive: () => false };
const admission = (index, ownerId = index % 7 === 0 ? 'second-owner' : 'first-owner') => ({
  ownerId, requestId: 'integrated-103-' + index, tool: 'blackice_browser_read',
  arguments: { action: 'read', expectedUrl: 'https://example.test/packed/' + index },
  requiredScopes: ['browser:read'], client: { id: ownerId, kind: 'chatgpt', scopes: ['browser:read'] },
  mutating: false,
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-103-full-harness-'));
  const profile = path.join(root, 'isolated-profile');
  const backup = path.join(root, 'whole-profile-backup');
  const exportDir = path.join(root, 'independent-direct-receipts');
  await fs.mkdir(profile);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, profile, backup, exportDir };
}
const put = async (profile, relative, text) => {
  const filename = path.join(profile, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, text);
};
async function seed(profile, total, { terminal = total - 3 } = {}) {
  const store = new DirectExecutionJobs({ dataDir: profile }), values = [];
  try {
    for (let i = 0; i < total; i++) {
      const input = admission(i);
      const original = (await store.admit(input)).job;
      if (i < terminal) {
        await store.update(original.id, () => ({ status: 'succeeded', dispatched: true,
          finishedAt: new Date().toISOString(),
          result: { success: true, contentItems: [
            { type: 'inputText', text: JSON.stringify({ url: input.arguments.expectedUrl, message: 'Synthetic Café ' + i }) },
          ] } }));
      } else if (i === terminal) {
        await store.update(original.id, () => ({
          status: 'running', dispatched: true, startedAt: new Date().toISOString(),
          effects: { possible: true, confirmed: false },
        }));
      } else if (i === terminal + 1) {
        // Ordinary queued work gets interrupted, never dispatched on restart.
      } else {
        await store.update(original.id, () => ({ status: 'awaiting_input',
          interaction: { id: 'synthetic-approval-' + i, kind: 'approval' } }));
      }
      values.push({ input, id: original.id });
    }
  } finally { await store.close(); }
  return values;
}
async function exportAll(store, destination, maxRecords = 16) {
  let complete = false, calls = 0;
  for (; calls < 64; calls++) {
    const result = await store.exportLegacyReceipts({ destination, maxRecords, maxBytes: 1024 * 1024 });
    if (result.phase === 'complete') { complete = true; break; }
  }
  assert.equal(complete, true, 'Independent export did not finish copy + verify');
  return calls + 1;
}
async function retireAll(store, destination, maxRecords = 16) {
  let total = 0;
  for (let i = 0; i < 64; i++) {
    const result = await store.retirePackedDuplicatesWithVerifiedExport({ destination, maxRecords });
    if (!result.removed) return total;
    assert.equal(result.verifiedBackup.checked, result.removed);
    total += result.removed;
  }
  assert.fail('Retirement did not settle under bounded fixtures');
}
async function stageAll(store, maxRecords = 16) {
  let total = 0;
  for (let i = 0; i < 64; i++) {
    const result = await store.packTerminalReceipts({ maxRecords, maxBytes: 1024 * 1024 });
    assert.equal(result.removed, 0);
    if (!result.staged) return total;
    total += result.staged;
  }
  assert.fail('Bounded pack staging did not settle');
}
async function restoreAll(store, destination) {
  let count = 0;
  for (let i = 0; i < 64; i++) {
    const result = await store.restoreLegacyReceipts({ destination, maxRecords: 16, maxBytes: 1024 * 1024 });
    count += result.copiedOrChecked;
    if (result.fullyRestored) return count;
  }
  assert.fail('Verified legacy restoration did not settle');
}

test('integrated full direct host: packed validation, idempotency, no replay, exact complete profile backup and rollback', async t => {
  const f = await fixture(t);
  await put(f.profile, 'data/conversations/synthetic-chat.json', '{"fixture":"complete profile conversation"}');
  await put(f.profile, 'data/settings.json', '{"mode":"synthetic-only"}');
  await put(f.profile, 'workspace/preserved-note.txt', 'Non-ledger profile content survives backup and rollback');
  const jobs = await seed(f.profile, 48, { terminal: 44 });
  const first = new DirectExecutionJobs({ dataDir: f.profile });
  await first.init(); // Deterministically interrupt queued and dispatched-running work.
  const baseline = await first.snapshot();
  const saved = new Map();
  for (const { id } of jobs) saved.set(id, await first.get(id));
  const running = saved.get(jobs[44].id), queued = saved.get(jobs[45].id);
  assert.equal(running.status, 'interrupted');
  assert.equal(running.effects.possible, true);
  assert.equal(running.effects.confirmed, false);
  assert.equal(queued.status, 'interrupted');
  assert.equal(queued.effects.possible, false);
  await first.close();

  // Production full-profile backup, not merely the direct-job export. It
  // captures non-ledger conversations/settings/workspace while store is closed.
  const backup = await createProfileBackup({
    ...backupSettings, profileDir: f.profile, backupDir: f.backup, appVersion: '2.39.103',
  });
  const verifiedBackup = await verifyProfileBackup({ ...backupSettings, backupDir: f.backup, appVersion: '2.39.103' });
  assert.equal(backup.manifestSha256, verifiedBackup.manifestSha256);
  for (const relative of ['data/conversations/synthetic-chat.json', 'data/settings.json',
    'workspace/preserved-note.txt']) {
    assert.ok(backup.manifest.entries.some(e => e.path === relative), 'Complete profile backup omitted ' + relative);
  }
  assert.equal(backup.manifest.entries.filter(e => e.path.startsWith('direct-execution-jobs/') && e.type === 'file').length, 48);

  const staging = new DirectExecutionJobs({ dataDir: f.profile });
  await staging.init();
  const staged = await stageAll(staging);
  assert.equal(staged, 46, '44 completed plus two restarted interrupted receipts become immutable');
  await staging.close();

  const exporting = new DirectExecutionJobs({ dataDir: f.profile });
  await exporting.init();
  assert.equal(exporting.packedIndex.size, staged);
  const exportBatches = await exportAll(exporting, f.exportDir);
  assert.ok(exportBatches > 1);
  assert.equal(await retireAll(exporting, f.exportDir), staged);
  await exporting.close();

  let diagnostics;
  const trace = new StartupCriticalTrace({ dataDir: f.profile, startTimer: false, version: '2.39.103' });
  await trace.start({ buildFiles: { directjobs: fileURLToPath(new URL('../lib/direct-execution-jobs.mjs', import.meta.url)) } });
  const api = new DirectExecutionAPI({
    dataDir: f.profile, allowedRoot: f.root, startupTrace: trace,
    onStartupDiagnostics: data => { diagnostics = data; },
  });
  try {
    await api.init(); await trace.finish('ready');
    assert.deepEqual(await api.jobs.counts(), { total: 48, unfinished: 2 });
    assert.deepEqual(await api.jobs.snapshot(), baseline);
    assert.equal(diagnostics.outcome, 'ready');
    assert.equal(diagnostics.receipts, 48);
    assert.equal(trace.ledger.required, 48);
    assert.equal(trace.ledger.validated, 48);
    assert.equal(trace.opMetrics['pack-open'].completed > 0, true);
    assert.equal(trace.opMetrics['pack-validate'].completed > 0, true);
    for (const { input, id } of jobs) {
      assert.deepEqual(await api.jobs.get(id), saved.get(id));
      const digest = directRequestDigest({ tool: input.tool, arguments: input.arguments });
      assert.equal((await api.jobs.findRequest({
        ownerId: input.ownerId, requestId: input.requestId, requestDigest: digest,
      })).id, id);
      assert.equal((await api.jobs.admit(input)).created, false);
    }
    assert.equal((await api.jobs.get(jobs[44].id)).effects.possible, true);
    await assert.rejects(api.jobs.admit({ ...jobs[0].input,
      arguments: { action: 'read', expectedUrl: 'https://different.test' } }),
    { code: 'DIRECT_REQUEST_CONFLICT' });
    const history = await api.jobs.resourceHistory({ ownerId: jobs[1].input.ownerId,
      scopes: ['browser:read'], urls: [jobs[1].input.arguments.expectedUrl] });
    assert.equal(history.observations[0].jobId, jobs[1].id);
    const traceText = JSON.stringify(trace.snapshot());
    assert.ok(!traceText.includes('Synthetic Café'));
    assert.ok(!traceText.includes(jobs[1].id));
  } finally { await api.close(); }

  // Restore the *whole* original profile after packed migration and compare
  // actual old-reader behavior; preserve the previous packed profile in the
  // restore transaction's previousProfileDir for forensic recovery.
  const restored = await restoreProfileBackup({
    ...backupSettings, profileDir: f.profile, backupDir: f.backup, appVersion: '2.39.103',
  });
  assert.equal(restored.restored, true);
  assert.equal(await fs.readFile(path.join(f.profile, 'workspace','preserved-note.txt'),'utf8'),
    'Non-ledger profile content survives backup and rollback');
  assert.equal(await fs.readFile(path.join(f.profile,'data/conversations/synthetic-chat.json'),'utf8'),
    '{"fixture":"complete profile conversation"}');
  const oldReader = await loadPinnedLegacyReader();
  const old = new oldReader.DirectExecutionJobs({ dataDir: f.profile });
  try {
    await old.init();
    // The pinned old reader predates the additive in-memory conversation projection.
    // Compare its supported metadata; full on-disk receipts remain exact below.
    assert.deepEqual(await old.snapshot(), baseline.map(({ browserConversationId, ...legacy }) => legacy));
    for (const { id } of jobs) assert.deepEqual(await old.get(id), saved.get(id));
  } finally { await old.close(); }
  assert.ok(restored.previousProfileDir !== f.profile);
  assert.equal((await fs.readdir(restored.previousProfileDir)).includes('direct-execution-jobs'), true);
  t.diagnostic(JSON.stringify({ version: '2.39.103', syntheticRecords: 48, packed: staged,
    unfinished: 2, fullProfileBackupFiles: backup.files, backupSha256: backup.manifestSha256,
    exportBatches, oldReaderRestored: true, installedStartupProof: false }));
});

test('integrated offline archive-aware downgrade requires re-export after a newer loose revision', async t => {
  const f = await fixture(t);
  const jobs = await seed(f.profile, 6, { terminal: 3 });
  const first = new DirectExecutionJobs({ dataDir: f.profile });
  await first.init();
  await stageAll(first);
  await first.close();
  const second = new DirectExecutionJobs({ dataDir: f.profile });
  await second.init();
  await exportAll(second, f.exportDir, 3);
  await retireAll(second, f.exportDir, 3);
  const latest = await second.update(jobs[0].id, () => ({
    result: { success: true, latest: 'newer-loose-103-revision' },
  }));
  await assert.rejects(second.finishLegacyDowngrade({ destination: f.exportDir }), { code: 'DIRECT_JOB_STORAGE' });
  const newerExport = path.join(f.root, 'independent-newer-export');
  await exportAll(second, newerExport, 3);
  await restoreAll(second, newerExport);
  assert.equal((await second.finishLegacyDowngrade({ destination: newerExport })).markerRemoved, true);
  await second.close();
  const reader = await loadPinnedLegacyReader();
  const old = new reader.DirectExecutionJobs({ dataDir: f.profile });
  try {
    await old.init();
    assert.equal((await old.get(jobs[0].id)).revision, latest.revision);
    assert.deepEqual((await old.get(jobs[0].id)).result, latest.result);
    assert.equal((await old.admit(jobs[0].input)).created, false);
    const current = await old.get(jobs[3].id);
    assert.equal(current.status, 'interrupted');
    assert.equal(current.effects.possible, true);
  } finally { await old.close(); }
});

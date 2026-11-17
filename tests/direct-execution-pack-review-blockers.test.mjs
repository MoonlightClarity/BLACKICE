import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DirectExecutionJobs } from '../lib/direct-execution-jobs.mjs';
import { retirePackedCopies } from '../lib/direct-execution-pack-migration.mjs';
import { PACK_MARKER } from '../lib/direct-execution-packs.mjs';
import { loadPinnedLegacyReader, verifyPinnedLegacyReader } from './fixtures/pinned-legacy-reader.mjs';

const sample = i => ({
  ownerId: 'fixture-owner', requestId: 'file-' + i, tool: 'blackice_workspace_read',
  arguments: { action: 'read', path: 'disposable/' + i },
  client: { id: 'fixture-owner', kind: 'chatgpt', scopes: ['read','files:read'] },
  requiredScopes: ['files:read'], mutating: false,
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-pack-review-alias-'));
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  const stores = [];
  const make = () => { const store = new DirectExecutionJobs({ dataDir: profile }); stores.push(store); return store; };
  t.after(async () => {
    await Promise.allSettled(stores.map(store => store.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const first = make(), jobs = [];
  for (let i = 0; i < 3; i++) {
    const input = sample(i), job = (await first.admit(input)).job;
    await first.update(job.id, () => ({
      status: 'succeeded', dispatched: true, finishedAt: new Date().toISOString(),
      result: { success: true, contentItems: [{ type: 'inputText', text: 'Café fixture ' + i }] },
    }));
    jobs.push({ input, job, file: first.file(job.id) });
  }
  await first.packTerminalReceipts({ maxRecords: 3 });
  await first.close();
  const second = make();
  await second.init();
  return { root, profile, directory: second.directory, make, store: second, jobs };
}
async function fullExport(store, destination) {
  for (let i = 0; i < 20; i++) {
    const result = await store.exportLegacyReceipts({ destination, maxRecords: 2 });
    if (result.phase === 'complete') return;
  }
  assert.fail('Independent export did not complete its copy and verify phases');
}
const exists = async file => fs.stat(file).then(() => true, () => false);
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
async function actualDirectoryAlias(t, from, to) {
  try { await fs.symlink(to, from, linkType); return true; }
  catch (error) {
    if (['EPERM','EACCES','ENOTSUP','ENOSYS'].includes(error?.code)) {
      t.diagnostic('Actual directory link unsupported by this host: ' + error.code);
      return false;
    }
    throw error;
  }
}
const looseNames = async dir => (await fs.readdir(dir)).filter(name =>
  /^direct_[a-f0-9]{64}\.json$/.test(name) && name !== PACK_MARKER);

test('pinned legacy reader contains exact checked Git blobs with no sibling checkout or dependency installation', async () => {
  const identity = await verifyPinnedLegacyReader();
  assert.equal(identity.sourceCommit, '30c4a7f7d5ec75d32f924399daa9af3e56620d93');
  assert.equal(identity.manifestSha256, '4ee5c946550e17d34cbcc2e788de9f4ed7768e17da11f17b83e49ef43144131b');
  assert.equal(identity.checkedFiles, 3);
  const legacy = await loadPinnedLegacyReader();
  assert.equal(typeof legacy.DirectExecutionJobs, 'function');
});

test('the public direct method and exported low-level function cannot delete without an independent export', async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.store.retirePackedDuplicates(), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(fx.store.retirePackedDuplicatesWithVerifiedExport({ maxRecords: 1 }), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(retirePackedCopies(fx.store, () => {}), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(fx.store.storageError, null);
  assert.equal((await looseNames(fx.directory)).length, 3);
  assert.equal(await exists(path.join(fx.directory, PACK_MARKER)), false);
  assert.equal((await fx.store.admit(fx.jobs[0].input)).created, false);
  const independent = path.join(fx.root, 'verified-independent');
  await fullExport(fx.store, independent);
  assert.equal((await fx.store.retirePackedDuplicates({ destination: independent, maxRecords: 1 })).removed, 1);
  assert.equal((await looseNames(fx.directory)).length, 2);
  assert.equal(await exists(path.join(fx.directory, PACK_MARKER)), true);
});

test('missing, stale and corrupted independent exports fail before unlinking any authoritative receipt', async t => {
  for (const problem of ['missing', 'stale', 'corrupt']) {
    await t.test(problem, async t => {
      const fx = await fixture(t);
      const independent = path.join(fx.root, 'verified-' + problem);
      if (problem !== 'missing') await fullExport(fx.store, independent);
      if (problem === 'stale') await fx.store.update(fx.jobs[0].job.id, () =>
        ({ result: { success: true, changed: 'newer-loose-revision' } }));
      if (problem === 'corrupt') await fs.writeFile(path.join(independent, 'direct-execution-jobs',
        fx.jobs[0].job.id + '.json'), '{"changed":"unverified"}');
      await assert.rejects(fx.store.retirePackedDuplicates({ destination: independent }),
        { code: 'DIRECT_JOB_STORAGE' });
      assert.equal((await looseNames(fx.directory)).length, 3);
      assert.equal(await exists(path.join(fx.directory, PACK_MARKER)), false);
      assert.equal(fx.store.storageError, null);
      assert.equal((await fx.store.admit(fx.jobs[1].input)).created, false);
    });
  }
});

test('existing source ancestors, Windows case aliases and a link with missing descendant cannot masquerade as export storage', async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.store.exportLegacyReceipts({ destination: fx.profile }), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(fx.store.exportLegacyReceipts({ destination: fx.root }), { code: 'DIRECT_JOB_STORAGE' });
  if (process.platform === 'win32')
    await assert.rejects(fx.store.exportLegacyReceipts({ destination: fx.profile.toUpperCase() }), { code: 'DIRECT_JOB_STORAGE' });
  const alias = path.join(fx.root, 'looks-external');
  if (!(await actualDirectoryAlias(t, alias, fx.profile))) return;
  const nonexistent = path.join(alias, 'not-yet-created', 'export');
  await assert.rejects(fx.store.exportLegacyReceipts({ destination: nonexistent }),
    { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(await exists(path.join(fx.profile, 'not-yet-created')), false);
  assert.equal(await exists(path.join(fx.directory, PACK_MARKER)), false);
  assert.equal((await looseNames(fx.directory)).length, 3);
});

test('swapped external junction after backup verification is caught before the first destructive unlink', async t => {
  const fx = await fixture(t);
  const safeRoot = path.join(fx.root, 'safe-outside');
  await fs.mkdir(safeRoot);
  const alias = path.join(fx.root, 'changing-link');
  if (!(await actualDirectoryAlias(t, alias, safeRoot))) return;
  const destination = path.join(alias, 'verified');
  await fullExport(fx.store, destination);
  let swapped = false;
  const io = fx.store.io;
  fx.store.io = { ...io, link: async (source, target) => {
    await io.link(source, target);
    if (!swapped && target === path.join(fx.directory, PACK_MARKER)) {
      swapped = true;
      await fs.unlink(alias);
      await fs.symlink(fx.profile, alias, linkType);
    }
  } };
  await assert.rejects(fx.store.retirePackedDuplicates({ destination }), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(swapped, true);
  assert.equal((await looseNames(fx.directory)).length, 3);
  assert.equal(await exists(path.join(fx.directory, PACK_MARKER)), true);
  await fx.store.close(); // Release the synthetic executor lease before restart.
  const reopened = fx.make(); await reopened.init();
  for (const { job, input } of fx.jobs) {
    assert.equal((await reopened.admit(input)).created, false);
    assert.equal((await reopened.get(job.id)).id, job.id);
  }
});

test('backup-link topology changes before full downgrade cannot remove old-version refusal marker', async t => {
  const fx = await fixture(t);
  const safeRoot = path.join(fx.root, 'separate-backup');
  await fs.mkdir(safeRoot);
  const alias = path.join(fx.root, 'replaced-before-downgrade');
  if (!(await actualDirectoryAlias(t, alias, safeRoot))) return;
  const destination = path.join(alias, 'verified');
  await fullExport(fx.store, destination);
  await fx.store.retirePackedDuplicates({ destination });
  for (let n = 0; n < 20; n++) {
    const result = await fx.store.restoreLegacyReceipts({ destination, maxRecords: 2 });
    if (result.fullyRestored) break;
  }
  assert.equal((await looseNames(fx.directory)).length, 3);
  await fs.unlink(alias);
  await fs.symlink(fx.profile, alias, linkType);
  await assert.rejects(fx.store.finishLegacyDowngrade({ destination }), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(await exists(path.join(fx.directory, PACK_MARKER)), true);
});

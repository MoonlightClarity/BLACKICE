import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DirectExecutionJobs, directRequestDigest } from '../lib/direct-execution-jobs.mjs';
import { PACK_MARKER, PACK_MANIFEST } from '../lib/direct-execution-packs.mjs';
import { retireWithFixtureBackup } from './fixtures/retire-with-verified-fixture.mjs';

const worker = fileURLToPath(new URL('./fixtures/direct-pack-interruption-worker.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const input = id => ({
  ownerId: 'offline-owner', requestId: 'process-' + id, tool: 'blackice_workspace_read',
  arguments: { action: 'read', path: 'synthetic/' + id },
  requiredScopes: ['files:read'],
  client: { id: 'offline-owner', kind: 'chatgpt', scopes: ['read','files:read'] },
  mutating: false,
});
async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-real-child-crash-'));
  const exportDir = dataDir + '-independent-export';
  const stores = [];
  const make = options => { const store = new DirectExecutionJobs({ dataDir, ...options }); stores.push(store); return store; };
  t.after(async () => {
    await Promise.allSettled(stores.map(store => store.close()));
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(exportDir, { recursive: true, force: true });
  });
  const original = make(), jobs = [];
  for (let i = 0; i < 4; i++) {
    const request = input(i), job = (await original.admit(request)).job;
    await original.update(job.id, () => ({ status: 'succeeded', dispatched: true,
      result: { success: true, contentItems: [{ type: 'inputText', text: 'Exact Café ' + i }] },
      finishedAt: new Date().toISOString() }));
    jobs.push({ request, job, bytes: await fs.readFile(original.file(job.id)) });
  }
  const uncertainInput = input('uncertain');
  const uncertain = (await original.admit(uncertainInput)).job;
  await original.update(uncertain.id, () => ({ status: 'running', dispatched: true,
    startedAt: new Date().toISOString(), effects: { possible: true, confirmed: false } }));
  await original.close();
  return { dataDir, exportDir, directory: path.join(dataDir,'direct-execution-jobs'),
    make, jobs, uncertain, uncertainInput };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runWorker(mode, dataDir, exportDir) {
  const child = spawn(process.execPath, [worker, mode, dataDir, exportDir], {
    // Verify the pinned old reader from a disposable working directory with
    // no sibling release checkout in module resolution.
    stdio: ['ignore','pipe','pipe'], windowsHide: true, cwd: dataDir,
  });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { errors += part; });
  return { child, get output() { return output; }, get errors() { return errors; } };
}
async function interruptAt(mode, dataDir, exportDir) {
  const run = await runWorker(mode, dataDir, exportDir);
  try {
    const deadline = Date.now() + 15000;
    while (!run.output.includes('KILL_POINT ' + mode)) {
      if (run.errors || run.output.includes('UNEXPECTED_COMPLETION'))
        assert.fail('Disposable worker did not stop at injected commit boundary: ' + run.errors + run.output);
      assert.ok(run.child.exitCode === null, 'Disposable worker exited before interruption.');
      assert.ok(Date.now() < deadline, 'Disposable worker failed to reach its commit boundary.');
      await sleep(10);
    }
    assert.equal(run.child.kill('SIGKILL'), true, 'Expected child-only terminate to be acknowledged.');
    await Promise.race([
      once(run.child, 'close'),
      sleep(10000).then(() => assert.fail('Disposable child did not exit after termination.')),
    ]);
    return run.output;
  } finally {
    if (run.child.exitCode === null) run.child.kill('SIGKILL');
  }
}
async function runOld(dataDir, exportDir) {
  const run = await runWorker('old-refusal', dataDir, exportDir);
  await Promise.race([
    once(run.child, 'close'),
    sleep(12000).then(() => assert.fail('Old-source fixture child did not exit.')),
  ]);
  assert.equal(run.child.exitCode, 0, run.errors);
  return run.output;
}
async function completeExport(store, destination) {
  for (let i = 0; i < 30; i++) {
    const result = await store.exportReceiptBackup({ destination, maxRecords: 2 });
    if (result.phase === 'complete') return;
  }
  assert.fail('Legacy export never completed.');
}
async function completeRestore(store, destination) {
  for (let i = 0; i < 30; i++) {
    const result = await store.restoreReceiptBackup({ destination, maxRecords: 2 });
    if (result.fullyRestored) return;
  }
  assert.fail('Legacy restore never completed.');
}

test('real disposable child termination after segment link leaves loose originals and no admitted phantom pack', async t => {
  const fx = await setup(t);
  await interruptAt('stage-link', fx.dataDir, fx.exportDir);
  const entries = await fs.readdir(fx.directory);
  assert.equal(entries.includes(PACK_MANIFEST), false, 'Killed prepublication segment must not become authoritative.');
  assert.ok(entries.some(name => name.endsWith('.bin')), 'Retain orphan for inspectable recovery.');
  const reopened = fx.make(); await reopened.init();
  for (const job of fx.jobs) {
    assert.equal((await reopened.admit(job.request)).created, false);
    assert.deepEqual(await fs.readFile(reopened.file(job.job.id)), job.bytes);
  }
  const uncertain = await reopened.get(fx.uncertain.id);
  assert.equal(uncertain.status, 'interrupted');
  assert.equal(uncertain.effects.possible, true);
  assert.equal(uncertain.effects.confirmed, false);
  assert.equal((await reopened.admit(fx.uncertainInput)).created, false);
  await reopened.close();
  assert.match(await runOld(fx.dataDir, fx.exportDir), /OLD_ACCEPTED/);
});

test('real disposable child termination between marker and duplicate unlink resumes from archived exact receipts', async t => {
  const fx = await setup(t);
  const initial = fx.make(); await initial.init();
  await initial.packTerminalReceipts({ maxRecords: 6 });
  await initial.close();
  const backed = fx.make(); await backed.init();
  await completeExport(backed, fx.exportDir);
  await backed.close();
  await interruptAt('retire-unlink', fx.dataDir, fx.exportDir);
  const files = await fs.readdir(fx.directory);
  assert.ok(files.includes(PACK_MARKER), 'Downgrade refusal is published before deleting any receipt.');
  assert.ok(files.filter(name => name.endsWith('.json') && name !== PACK_MARKER && /^direct_/.test(name)).length < 5);
  assert.match(await runOld(fx.dataDir, fx.exportDir), /OLD_REFUSED DIRECT_JOB_STORAGE/);
  const recovery = fx.make(); await recovery.init();
  assert.equal(recovery.packedIndex.size >= 4, true);
  for (const job of fx.jobs) {
    assert.equal((await recovery.admit(job.request)).created, false);
    assert.equal(recovery.records.get(job.job.id).receiptHash, hash(job.bytes));
  }
  assert.equal((await recovery.get(fx.uncertain.id)).effects.possible, true);
  await retireWithFixtureBackup(recovery, { maxRecords: 6 });
  await recovery.close();
});

test('real process kills during export and restore resume exact backup; packed guard remains after verified complete restoration', async t => {
  const fx = await setup(t);
  const initial = fx.make(); await initial.init();
  await initial.packTerminalReceipts({ maxRecords: 6 }); await initial.close();
  const retiring = fx.make(); await retiring.init(); await retireWithFixtureBackup(retiring, { maxRecords: 6 }); await retiring.close();
  assert.match(await runOld(fx.dataDir, fx.exportDir), /OLD_REFUSED DIRECT_JOB_STORAGE/);

  await interruptAt('export-link', fx.dataDir, fx.exportDir);
  const exportResume = fx.make(); await exportResume.init();
  await completeExport(exportResume, fx.exportDir);
  await exportResume.close();
  const journal = JSON.parse(await fs.readFile(path.join(fx.exportDir, 'legacy-export-v1.json'), 'utf8'));
  assert.equal(journal.phase, 'complete');
  assert.equal(journal.total, 5);
  await interruptAt('restore-link', fx.dataDir, fx.exportDir);
  assert.match(await runOld(fx.dataDir, fx.exportDir), /OLD_REFUSED DIRECT_JOB_STORAGE/);
  const restoring = fx.make(); await restoring.init();
  await completeRestore(restoring, fx.exportDir);
  for (const job of fx.jobs) {
    assert.deepEqual(await fs.readFile(restoring.file(job.job.id)), job.bytes);
    assert.equal((await restoring.admit(job.request)).created, false);
  }
  assert.equal((await restoring.get(fx.uncertain.id)).effects.possible, true);
  assert.equal(typeof restoring.finishLegacyDowngrade, 'undefined');
  assert.equal(restoring.packMarkerPresent, true);
  await restoring.close();
  assert.match(await runOld(fx.dataDir, fx.exportDir), /OLD_REFUSED DIRECT_JOB_STORAGE/);
  const verified = fx.make(); await verified.init();
  for (const job of fx.jobs) {
    assert.equal((await verified.admit(job.request)).created, false);
    assert.deepEqual((await verified.get(job.job.id)).result, { success: true,
      contentItems: [{ type: 'inputText', text: 'Exact Café ' + fx.jobs.indexOf(job) }] });
  }
  const pending = await verified.get(fx.uncertain.id);
  assert.equal(pending.status, 'interrupted');
  assert.equal(pending.effects.possible, true);
  await assert.rejects(verified.admit({ ...fx.jobs[0].request, arguments: { action: 'read', path: 'changed' } }),
    { code: 'DIRECT_REQUEST_CONFLICT' });
});

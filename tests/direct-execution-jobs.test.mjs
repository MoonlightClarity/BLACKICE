import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { DirectExecutionJobs, directRequestDigest } from '../lib/direct-execution-jobs.mjs';

const client = { id: 'grant-a', label: 'ChatGPT test', kind: 'chatgpt', scopes: ['read', 'files:read'] };
const admission = (requestId = 'read-one', args = { action: 'read', path: 'example.txt' }) => ({ ownerId: client.id, requestId, tool: 'blackice_workspace_read', arguments: args, requiredScopes: ['files:read'], client, mutating: false });
async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-direct-ledger-'));
  const stores = [], make = options => { const store = new DirectExecutionJobs({ dataDir: directory, ...options }); stores.push(store); return store; };
  t.after(async () => { await Promise.allSettled(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }); });
  return { directory, make };
}

test('concurrent identical admissions have one durable identity and changed arguments conflict', async t => {
  const { make, directory } = await harness(t), store = make();
  const values = await Promise.all(Array.from({ length: 20 }, () => store.admit(admission())));
  assert.equal(values.filter(value => value.created).length, 1); assert.equal(new Set(values.map(value => value.job.id)).size, 1);
  await assert.rejects(store.admit(admission('read-one', { action: 'read', path: 'other.txt' })), { code: 'DIRECT_REQUEST_CONFLICT' });
  const files = (await readdir(path.join(directory, 'direct-execution-jobs'))).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1); assert.equal(JSON.parse(await readFile(path.join(directory, 'direct-execution-jobs', files[0]), 'utf8')).requestId, 'read-one');
});

test('request lookup waits for durable admission and checks the owner and original digest without admitting work', async t => {
  const { make } = await harness(t), store = make(), input = admission();
  const identity = { ownerId: input.ownerId, requestId: input.requestId, requestDigest: directRequestDigest({ tool: input.tool, arguments: input.arguments }) };
  const admitted = store.admit(input), lookup = store.findRequest(identity);
  const [created, saved] = await Promise.all([admitted, lookup]); assert.equal(saved.id, created.job.id);
  saved.arguments.path = 'changed outside ledger'; assert.equal((await store.get(saved.id)).arguments.path, 'example.txt');
  assert.equal(await store.findRequest({ ...identity, ownerId: 'another-grant' }), null);
  assert.equal(await store.findRequest({ ...identity, requestId: 'unadmitted-request' }), null);
  await assert.rejects(store.findRequest({ ...identity, requestDigest: directRequestDigest({ tool: input.tool, arguments: { ...input.arguments, path: 'different.txt' } }) }), { code: 'DIRECT_REQUEST_CONFLICT' });
  await assert.rejects(store.findRequest({ ...identity, requestDigest: 'invalid' }), { code: 'DIRECT_JOB_INVALID' });
  assert.equal((await store.list()).total, 1);
});

test('idempotency keys are scoped to the authenticated owner and record reads enforce that owner', async t => {
  const { make } = await harness(t), store = make();
  const first = await store.admit(admission()), second = await store.admit({ ...admission(), ownerId: 'grant-b', client: { ...client, id: 'grant-b' } });
  assert.notEqual(first.job.id, second.job.id);
  await assert.rejects(store.get(first.job.id, { ownerId: 'grant-b' }), { code: 'DIRECT_JOB_NOT_FOUND' });
  assert.equal((await store.list({ ownerId: 'grant-a' })).total, 1);
});

test('restart retains completed receipts and marks queued or dispatched work interrupted without replay', async t => {
  const { make } = await harness(t); const first = make();
  const queued = (await first.admit(admission('queued'))).job, running = (await first.admit({ ...admission('running'), mutating: true })).job;
  const done = (await first.admit(admission('completed'))).job;
  await first.update(running.id, () => ({ status: 'running', dispatched: true, startedAt: new Date().toISOString() }));
  await first.update(done.id, () => ({ status: 'succeeded', result: { success: true, contentItems: [{ type: 'inputText', text: 'Saved exact receipt ✓' }] }, finishedAt: new Date().toISOString() }));
  await first.close(); const second = make(); await second.init();
  assert.equal((await second.get(queued.id)).status, 'interrupted'); assert.equal((await second.get(queued.id)).effects.possible, false);
  assert.equal((await second.get(running.id)).status, 'interrupted'); assert.equal((await second.get(running.id)).effects.possible, true);
  assert.equal((await second.get(done.id)).result.contentItems[0].text, 'Saved exact receipt ✓');
  const retried = await second.admit(admission('queued')); assert.equal(retried.created, false); assert.equal(retried.job.status, 'interrupted');
});

test('saved local approvals survive restart but volatile signed inputs never do', async t => {
  const { make, directory } = await harness(t), first = make();
  const interaction = { id: 'input-test', kind: 'approval', message: 'Review locally.' };
  const plain = (await first.admit({ ...admission('plain'), interaction })).job;
  const full = { action: 'import', fileId: 'file-one', download_url: 'https://files.example.test/private?secret=signed-token' }, durable = { action: 'import', fileId: 'file-one' };
  const secret = (await first.admit({ ...admission('transient', durable), interaction, transientArguments: true, originalRequestDigest: directRequestDigest({ tool: 'blackice_workspace_read', arguments: full }) })).job;
  const raw = await readFile(path.join(directory, 'direct-execution-jobs', `${secret.id}.json`), 'utf8'); assert.doesNotMatch(raw, /signed-token|download_url|files\.example/);
  await first.close(); const second = make(); await second.init();
  assert.equal((await second.get(plain.id)).status, 'awaiting_input'); assert.equal((await second.get(secret.id)).status, 'interrupted');
  assert.equal((await second.get(secret.id)).effects.possible, false);
});

test('expected revision rejects stale interaction edits and immutable request fields cannot change', async t => {
  const { make } = await harness(t), store = make(), job = (await store.admit(admission())).job;
  await store.update(job.id, () => ({ status: 'running', dispatched: true }), { expectedRevision: 1 });
  await assert.rejects(store.update(job.id, () => ({ status: 'cancelled' }), { expectedRevision: 1 }), { code: 'DIRECT_JOB_CONFLICT', currentRevision: 2 });
  await assert.rejects(store.update(job.id, () => ({ arguments: { path: 'changed.txt' } })), /cannot change/);
  assert.equal((await store.get(job.id)).arguments.path, 'example.txt');
});

test('a second process cannot own the same live ledger; after hard process exit recovery is honest', async t => {
  const { directory, make } = await harness(t);
  const moduleURL = new URL('../lib/direct-execution-jobs.mjs', import.meta.url).href;
  const program = `import {DirectExecutionJobs} from ${JSON.stringify(moduleURL)}; const store=new DirectExecutionJobs({dataDir:process.argv[1]}); await store.init(); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, directory], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdout.resume(); child.stderr.resume();
  const deadline = Date.now() + 4000; let ready = false;
  while (Date.now() < deadline) {
    try { if (JSON.parse(await readFile(path.join(directory, 'direct-execution-jobs', 'executor.lock'), 'utf8')).pid === child.pid) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(`Ledger owner exited ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(ready, true, 'child publishes its durable lease'); await assert.rejects(make().init(), { code: 'DIRECT_JOB_LOCKED' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const recovered = make(); await recovered.init(); assert.equal((await recovered.list()).total, 0);
});

test('corrupt durable records fail closed without deleting records or silently forgetting request IDs', async t => {
  const { make, directory } = await harness(t), first = make(), job = (await first.admit(admission())).job;
  await first.close(); const file = path.join(directory, 'direct-execution-jobs', `${job.id}.json`);
  const damaged = '{"damaged":true}'; await writeFile(file, damaged);
  await assert.rejects(make().init(), { code: 'DIRECT_JOB_STORAGE' }); assert.equal(await readFile(file, 'utf8'), damaged);
});

test('ledger capacity preserves all idempotency receipts instead of silently expiring old keys', async t => {
  const { make } = await harness(t), store = make({ maxJobs: 1 });
  const first = await store.admit(admission()); await assert.rejects(store.admit(admission('second')), { code: 'DIRECT_JOB_LIMIT' });
  assert.equal((await store.admit(admission())).job.id, first.job.id);
});

test('completed history can exceed the unfinished limit and retains exact identities and payloads after reopening', async t => {
  const { make, directory } = await harness(t), first = make({ maxJobs: 1 }), completed = [];
  for (let index = 0; index < 6; index++) {
    const input = admission(`history-${index}`, { action: 'read', path: `history-${index}.txt` }), job = (await first.admit(input)).job;
    const result = { success: true, contentItems: [{ type: 'inputText', text: `Exact original output ${index} ✓` }] };
    completed.push({ input, job: await first.update(job.id, () => ({ status: 'succeeded', result, finishedAt: new Date().toISOString() })) });
  }
  assert.deepEqual(await first.counts(), { total: 6, unfinished: 0 });
  const old = completed[0], file = path.join(directory, 'direct-execution-jobs', `${old.job.id}.json`), bytes = await readFile(file);
  await first.close(); const reopened = make({ maxJobs: 1 }); await reopened.init();
  assert.deepEqual(await reopened.counts(), { total: 6, unfinished: 0 });
  const pending = (await reopened.admit(admission('outstanding'))).job;
  await assert.rejects(reopened.admit(admission('over-capacity')), { code: 'DIRECT_JOB_LIMIT' });
  const duplicate = await reopened.admit(old.input); assert.equal(duplicate.created, false); assert.deepEqual(duplicate.job, old.job);
  assert.deepEqual(await reopened.findRequest({ ownerId: client.id, requestId: old.input.requestId, requestDigest: old.job.requestDigest }), old.job);
  await assert.rejects(reopened.admit({ ...old.input, arguments: { action: 'read', path: 'different.txt' } }), { code: 'DIRECT_REQUEST_CONFLICT' });
  await assert.rejects(reopened.get(old.job.id, { ownerId: 'another-owner' }), { code: 'DIRECT_JOB_NOT_FOUND' });
  assert.deepEqual(await reopened.snapshot({ ownerId: 'another-owner' }), []); assert.deepEqual(await readFile(file), bytes);
  await reopened.update(pending.id, () => ({ status: 'cancelled', finishedAt: new Date().toISOString() }));
  const admissions = await Promise.allSettled([reopened.admit(admission('fresh-a')), reopened.admit(admission('fresh-b'))]);
  assert.equal(admissions.filter(value => value.status === 'fulfilled').length, 1); assert.equal(admissions.find(value => value.status === 'rejected').reason.code, 'DIRECT_JOB_LIMIT');
});

test('queued, running and awaiting-input work consume capacity, while terminal outcomes release it', async t => {
  const { make } = await harness(t), store = make({ maxJobs: 2 });
  const first = (await store.admit(admission('first'))).job; await store.update(first.id, () => ({ status: 'running', dispatched: true }));
  const second = (await store.admit({ ...admission('needs-input'), interaction: { id: 'input-capacity', kind: 'verification' } })).job;
  assert.deepEqual(await store.counts(), { total: 2, unfinished: 2 }); await assert.rejects(store.admit(admission('third')), { code: 'DIRECT_JOB_LIMIT' });
  await store.update(first.id, () => ({ status: 'failed', finishedAt: new Date().toISOString() }));
  const third = (await store.admit(admission('third'))).job;
  assert.deepEqual(new Set((await store.snapshot({ unfinishedOnly: true })).map(value => value.id)), new Set([second.id, third.id]));
  assert.deepEqual(await store.counts(), { total: 3, unfinished: 2 });
});

test('terminal payloads leave memory and metadata reads never hydrate or copy arguments, clients or results', async t => {
  const { make } = await harness(t), store = make();
  const input = admission('large-history', { action: 'read', path: 'example.txt', privateNote: 'argument-only-marker-' + 'a'.repeat(32000) });
  const job = (await store.admit(input)).job, result = { success: true, contentItems: [{ type: 'inputText', text: 'result-only-marker-' + 'r'.repeat(512000) }] };
  await store.update(job.id, () => ({ status: 'succeeded', result, finishedAt: new Date().toISOString() }));
  let receiptReads = 0;
  store.io = { ...fs, readFile: (...args) => { if (/direct_[a-f0-9]{64}\.json$/.test(args[0])) receiptReads++; return fs.readFile(...args); } };
  for (const value of [store.records.get(job.id), ...(await store.snapshot()), ...(await store.listMetadata()).jobs]) {
    for (const key of ['arguments', 'client', 'result']) assert.equal(Object.hasOwn(value, key), false);
    assert.equal(value.resultAvailable, true); assert.equal(value.action, 'read'); assert.equal(JSON.stringify(value).length < 10000, true);
  }
  assert.deepEqual(await store.counts(), { total: 1, unfinished: 0 }); assert.equal(receiptReads, 0);
  const hydrated = await store.get(job.id); assert.deepEqual(hydrated.result, result); assert.deepEqual(hydrated.arguments, input.arguments); assert.equal(receiptReads, 1);
  hydrated.result.contentItems[0].text = 'caller mutation'; assert.deepEqual((await store.get(job.id)).result, result);
  assert.deepEqual((await store.list()).jobs[0].result, result); assert.equal(Object.hasOwn(store.records.get(job.id), 'result'), false);
});

test('terminal hydration is serialized with receipt updates and snapshots remain independent of later admissions', async t => {
  const { make } = await harness(t), store = make(); const job = (await store.admit(admission('serialized'))).job;
  await store.update(job.id, () => ({ status: 'succeeded', result: { before: true }, finishedAt: new Date().toISOString() }));
  let reading, release, block = true, updated = false;
  const started = new Promise(resolve => { reading = resolve; }), held = new Promise(resolve => { release = resolve; });
  store.io = { ...fs, readFile: async (...args) => { const raw = await fs.readFile(...args); if (block && /direct_[a-f0-9]{64}\.json$/.test(args[0])) { block = false; reading(); await held; } return raw; } };
  const getting = store.get(job.id); await started;
  const updating = store.update(job.id, () => { updated = true; return { result: { after: true } }; });
  await Promise.resolve(); assert.equal(updated, false); release();
  assert.deepEqual((await getting).result, { before: true }); assert.deepEqual((await updating).result, { after: true }); assert.deepEqual((await store.get(job.id)).result, { after: true });
  const snapshot = await store.snapshot(); await store.admit(admission('later'));
  assert.equal(snapshot.length, 1); snapshot[0].effects.confirmed = 'caller change'; assert.equal((await store.snapshot()).find(value => value.id === job.id).effects.confirmed, false);
});

test('unreadable or changed terminal receipt files fail closed without forgetting identities or overwriting evidence', async t => {
  for (const damage of ['corrupt', 'changed', 'missing']) await t.test(damage, async t => {
    const { make, directory } = await harness(t), store = make(), input = admission('must-not-replay'), job = (await store.admit(input)).job;
    await store.update(job.id, () => ({ status: 'succeeded', result: { exact: 'original' }, finishedAt: new Date().toISOString() }));
    const file = path.join(directory, 'direct-execution-jobs', `${job.id}.json`);
    if (damage === 'missing') await rm(file);
    else if (damage === 'corrupt') await writeFile(file, '{broken');
    else { const value = JSON.parse(await readFile(file, 'utf8')); value.result.exact = 'changed'; await writeFile(file, JSON.stringify(value)); }
    const evidence = damage === 'missing' ? null : await readFile(file);
    await assert.rejects(store.get(job.id), { code: 'DIRECT_JOB_STORAGE' }); assert.equal(store.records.has(job.id), true);
    await assert.rejects(store.admit(input), { code: 'DIRECT_JOB_STORAGE' }); await assert.rejects(store.admit(admission('no-bypass')), { code: 'DIRECT_JOB_STORAGE' });
    await assert.rejects(store.findRequest({ ownerId: client.id, requestId: input.requestId, requestDigest: job.requestDigest }), { code: 'DIRECT_JOB_STORAGE' });
    if (evidence) assert.deepEqual(await readFile(file), evidence); else await assert.rejects(readFile(file), { code: 'ENOENT' });
    if (damage === 'corrupt') { await store.close(); await assert.rejects(make().init(), { code: 'DIRECT_JOB_STORAGE' }); assert.deepEqual(await readFile(file), evidence); }
  });
});

test('unconfirmed writes cannot overwrite receipt evidence, including a rename that committed before reporting failure', async t => {
  for (const committed of [false, true]) await t.test(committed ? 'rename committed' : 'rename not committed', async t => {
    const { make, directory } = await harness(t), store = make(), input = admission('uncertain-write'), job = (await store.admit(input)).job;
    await store.update(job.id, () => ({ status: 'succeeded', result: { exact: 'original' }, finishedAt: new Date().toISOString() }));
    const indexed = structuredClone(store.records.get(job.id));
    store.io = { ...fs, rename: async (...args) => { if (committed) await fs.rename(...args); throw Object.assign(new Error('Write acknowledgement failed.'), { code: 'EIO' }); } };
    await assert.rejects(store.update(job.id, () => ({ result: { exact: 'replacement' } })), { code: 'DIRECT_JOB_STORAGE' });
    assert.deepEqual(store.records.get(job.id), indexed);
    const file = path.join(directory, 'direct-execution-jobs', `${job.id}.json`), evidence = await readFile(file), expected = committed ? 'replacement' : 'original';
    assert.equal(JSON.parse(evidence).result.exact, expected);
    await assert.rejects(store.update(job.id, () => ({ result: { exact: 'must-not-overwrite' } })), { code: 'DIRECT_JOB_STORAGE' });
    await assert.rejects(store.admit(input), { code: 'DIRECT_JOB_STORAGE' }); await assert.rejects(store.admit(admission('new-work')), { code: 'DIRECT_JOB_STORAGE' }); assert.deepEqual(await readFile(file), evidence);
    await store.close(); const reopened = make(); await reopened.init();
    const duplicate = await reopened.admit(input); assert.equal(duplicate.created, false); assert.equal(duplicate.job.result.exact, expected); assert.deepEqual(await readFile(file), evidence);
  });
});

test('a failed temporary handle close preserves the storage error used to cancel active work', async t => {
  const { make, directory } = await harness(t), store = make(), input = admission('failed-close'), job = (await store.admit(input)).job;
  const indexed = structuredClone(store.records.get(job.id)), file = path.join(directory, 'direct-execution-jobs', `${job.id}.json`), before = await readFile(file);
  let closeAttempts = 0;
  store.io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: (...values) => handle.writeFile(...values), sync: () => handle.sync(), close: async () => {
      closeAttempts++; await handle.close(); throw Object.assign(new Error('The temporary handle close could not be confirmed.'), { code: 'EIO' });
    } };
  } };
  await assert.rejects(store.update(job.id, () => ({ status: 'cancelled' })), error => error === store.storageError && error.code === 'DIRECT_JOB_STORAGE');
  assert.equal(closeAttempts, 2); assert.deepEqual(store.records.get(job.id), indexed); assert.deepEqual(await readFile(file), before);
  await assert.rejects(store.admit(admission('no-bypass-after-close')), { code: 'DIRECT_JOB_STORAGE' });
  assert.deepEqual((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
});

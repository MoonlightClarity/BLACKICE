import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { DirectExecutionJobs, directRequestDigest } from '../lib/direct-execution-jobs.mjs';

const client = { id: 'grant-a', label: 'ChatGPT test', kind: 'chatgpt', scopes: ['read', 'files:read'] };
const admission = (requestId = 'read-one', args = { action: 'read', path: 'example.txt' }) => ({ ownerId: client.id, requestId, tool: 'blackice_workspace_read', arguments: args, requiredScopes: ['files:read'], client, mutating: false });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async check => { const deadline = Date.now() + 3000; while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('The ledger did not reach the expected startup state.'); };
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
  assert.equal((await store.counts()).total,1);assert.equal((await store.list()).jobs[0].requestId,'read-one');
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

test('expected revision rejects stale interaction edits and immutable request fields cannot change', async t => {
  const { make } = await harness(t), store = make(), job = (await store.admit(admission())).job;
  await store.update(job.id, () => ({ status: 'running', dispatched: true }), { expectedRevision: 1 });
  await assert.rejects(store.update(job.id, () => ({ status: 'cancelled' }), { expectedRevision: 1 }), { code: 'DIRECT_JOB_CONFLICT', currentRevision: 2 });
  await assert.rejects(store.update(job.id, () => ({ arguments: { path: 'changed.txt' } })), /Cannot change/);
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
  const old = completed[0], bytes = JSON.stringify(await first.get(old.job.id));
  await first.close(); const reopened = make({ maxJobs: 1 }); await reopened.init();
  assert.deepEqual(await reopened.counts(), { total: 6, unfinished: 0 });
  const pending = (await reopened.admit(admission('outstanding'))).job;
  await assert.rejects(reopened.admit(admission('over-capacity')), { code: 'DIRECT_JOB_LIMIT' });
  const duplicate = await reopened.admit(old.input); assert.equal(duplicate.created, false); assert.deepEqual(duplicate.job, old.job);
  assert.deepEqual(await reopened.findRequest({ ownerId: client.id, requestId: old.input.requestId, requestDigest: old.job.requestDigest }), old.job);
  await assert.rejects(reopened.admit({ ...old.input, arguments: { action: 'read', path: 'different.txt' } }), { code: 'DIRECT_REQUEST_CONFLICT' });
  await assert.rejects(reopened.get(old.job.id, { ownerId: 'another-owner' }), { code: 'DIRECT_JOB_NOT_FOUND' });
  assert.deepEqual(await reopened.snapshot({ ownerId: 'another-owner' }), []); assert.equal(JSON.stringify(await reopened.get(old.job.id)), bytes);
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


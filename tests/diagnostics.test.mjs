import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DiagnosticsStore } from '../lib/diagnostics.mjs';

async function harness(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'relay-diagnostics-test-'));
  const store = new DiagnosticsStore({ dataDir, version: '2.12.0', ...options });
  t.after(async () => { await store.close(); assert.equal(path.dirname(dataDir), path.resolve(tmpdir())); assert.match(path.basename(dataDir), /^relay-diagnostics-test-/); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { store, dataDir, directory: store.directory };
}
const record = { component: 'desktop', event: 'ready', level: 'info' };
const saved = overrides => ({ at: '2026-10-16T22:00:00.000Z', ...record, ...overrides });

test('prompt library diagnostics expose health without retaining template bodies or field values',async t=>{
  const {store}=await harness(t);const result=await store.snapshot({health:{promptsHealthy:true,promptText:'PRIVATE_TEMPLATE',values:'PRIVATE_VALUES'}});assert.deepEqual(result.health,{promptsHealthy:true});assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

test('API inactivity has a distinct safe diagnostic code without retaining provider or prompt details',async t=>{
  const {store}=await harness(t);await store.record({component:'provider',event:'provider_failed',code:'PROVIDER_IDLE_TIMEOUT',message:'PRIVATE_PROVIDER_RESPONSE',url:'https://private.example/?api_key=PRIVATE_KEY'});const snapshot=await store.snapshot();assert.equal(snapshot.events.at(-1).code,'PROVIDER_IDLE_TIMEOUT');assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_/);
});

test('diagnostics durably retain only safe event metadata and an independent support snapshot', async t => {
  const { store, dataDir, directory } = await harness(t);
  assert.equal(await store.record({ ...record, code: 'OK', status: 200, exitCode: 0, reason: 'crashed', state: 'completed' }), true);
  const disk = JSON.parse((await fs.readFile(path.join(directory, 'events.0.jsonl'), 'utf8')).trim());
  assert.deepEqual(disk, { at: disk.at, ...record, code: 'OK', status: 200, state: 'completed', reason: 'crashed', exitCode: 0 });
  const snapshot = await store.snapshot({ counts: { savedRuns: 12, activeRuns: 2 }, health: { storageHealthy: true } });
  assert.equal(snapshot.format, 'relay-support'); assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.application.version, '2.12.0');
  assert.deepEqual(snapshot.counts, { savedRuns: 12, activeRuns: 2 }); assert.deepEqual(snapshot.health, { storageHealthy: true });
  snapshot.events[0].component = 'changed'; assert.equal((await store.snapshot()).events[0].component, 'desktop');
  const restored = new DiagnosticsStore({ dataDir, version: '2.12.0' }); await restored.init(); t.after(() => restored.close());
  assert.deepEqual((await restored.snapshot()).events, [disk]);
});

test('messages, credentials, tokens, cookies, paths, prompts and payloads never enter the log or export', async t => {
  const secret = 'PRIVATE_MARKER_DO_NOT_EXPORT';
  const { store, directory } = await harness(t, { platform: secret, arch: secret });
  await store.record({ ...record, code: secret, message: `Bearer ${secret}`, stack: `C:\\Users\\${secret}`, path: secret, url: `https://${secret}.example/`, cookie: secret, prompt: secret, tool: { arguments: secret }, runId: secret, providerName: secret, reason: secret, status: secret, exitCode: secret });
  await store.recordError('provider', 'provider_failed', Object.assign(new Error(secret), { code: 'PROVIDER_AUTH', headers: { Authorization: secret }, cause: secret }));
  const snapshot = await store.snapshot({ version: secret, counts: { activeRuns: 3, providers: secret, token: secret, prompt: secret }, health: { storageHealthy: true, attachmentsHealthy: false, identityHealthy: true, knowledgeHealthy: true, cookies: secret } });
  assert.equal(snapshot.application.version, 'unknown'); assert.equal(snapshot.application.platform, 'unknown'); assert.equal(snapshot.application.arch, 'unknown');
  assert.equal(snapshot.events[0].code, 'UNKNOWN_ERROR'); assert.equal(snapshot.events[1].code, 'PROVIDER_AUTH');
  assert.deepEqual(snapshot.counts, { activeRuns: 3 });
  assert.ok(!JSON.stringify(snapshot).includes(secret)); assert.ok(!(await fs.readFile(path.join(directory, 'events.0.jsonl'), 'utf8')).includes(secret));
});

test('malformed event values and throwing error metadata are contained without invoking arbitrary serialization', async t => {
  const { store } = await harness(t);
  for (const entry of [null, [], 'private message', { component: 'unknown', event: 'ready' }, { component: 'desktop', event: 'arbitrary-secret' }, { get component() { throw new Error('private getter'); } }]) assert.equal(await store.record(entry), false);
  let serialized = false;
  await store.record({ ...record, toJSON() { serialized = true; throw new Error('private serializer'); } });
  await store.recordError('desktop', 'uncaught_exception', { get code() { throw new Error('private error code'); } });
  const snapshot = await store.snapshot(); assert.equal(serialized, false); assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events[1].code, 'UNKNOWN_ERROR'); assert.equal(snapshot.diagnostics.droppedEvents, 6);
});

test('rotation bounds file count, bytes and retained events across restart', async t => {
  let sequence = 0;
  const { store, dataDir, directory } = await harness(t, { maxFileBytes: 512, maxFiles: 3, maxEvents: 5, now: () => new Date(Date.UTC(2026, 9, 16, 22, 0, sequence++)) });
  for (let index = 0; index < 60; index++) assert.equal(await store.record({ ...record, status: 200 + index }), true);
  const files = await fs.readdir(directory); assert.equal(files.length, 3); let total = 0;
  for (const name of files) { const bytes = (await fs.stat(path.join(directory, name))).size; assert.ok(bytes <= 512); total += bytes; }
  assert.ok(total <= 1536); const current = await store.snapshot(); assert.equal(current.events.length, 5);
  const restored = new DiagnosticsStore({ dataDir, maxFileBytes: 512, maxFiles: 3, maxEvents: 5 }); await restored.init(); t.after(() => restored.close());
  assert.deepEqual((await restored.snapshot()).events, current.events);
});

test('lowering the retained segment count removes only owned old segments and preserves unrelated files', async t => {
  const { store, directory } = await harness(t, { maxFiles: 1 }); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'events.0.jsonl'), JSON.stringify(saved()) + '\n');
  for (const name of ['events.1.jsonl', 'events.2.jsonl']) await fs.writeFile(path.join(directory, name), JSON.stringify(saved()) + '\n');
  await fs.writeFile(path.join(directory, 'unrelated.txt'), 'preserved');
  await store.init(); await store.record(record);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['events.0.jsonl', 'unrelated.txt']);
  assert.equal(await fs.readFile(path.join(directory, 'unrelated.txt'), 'utf8'), 'preserved');
});

test('partial, corrupt and hostile log lines are tolerated and an unterminated final record does not absorb later events', async t => {
  const { store, dataDir, directory } = await harness(t);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'events.0.jsonl'), [JSON.stringify(saved({ message: 'PRIVATE_CORRUPT_LOG_MARKER', code: 'PRIVATE_CORRUPT_LOG_MARKER' })), '{partial', JSON.stringify({ at: 'bad', component: 'desktop', event: 'ready' }), JSON.stringify(saved({ event: 'stopping' }))].join('\n'));
  await store.init(); const snapshot = await store.snapshot(); assert.equal(snapshot.events.length, 2); assert.equal(snapshot.diagnostics.malformedRecords, 2);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_CORRUPT_LOG_MARKER'));
  await store.record({ component: 'desktop', event: 'stopped' });
  const restored = new DiagnosticsStore({ dataDir }); await restored.init(); t.after(() => restored.close());
  assert.deepEqual((await restored.snapshot()).events.map(event => event.event), ['ready', 'stopping', 'stopped']);
});

test('oversized existing logs are read in bounded tails and reset to the byte budget', async t => {
  const { store, directory } = await harness(t, { maxFileBytes: 512 }); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'events.0.jsonl'), 'PRIVATE_OVERSIZED_MARKER'.repeat(2000) + '\n' + JSON.stringify(saved()) + '\n');
  await store.init(); const snapshot = await store.snapshot(); assert.equal(snapshot.diagnostics.truncatedFiles, 1); assert.equal(snapshot.events.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_OVERSIZED_MARKER')); assert.equal((await fs.stat(path.join(directory, 'events.0.jsonl'))).size, 0);
  await store.record(record); assert.ok((await fs.stat(path.join(directory, 'events.0.jsonl'))).size <= 512);
});

test('disk-full and unreadable logs never throw or recurse, preserve bounded in-memory evidence and recover health', async t => {
  let fail = true, attemptedWrites = 0;
  const io = { ...fs, open: async (file, mode, ...args) => { if (mode === 'a') { attemptedWrites++; if (fail) throw Object.assign(new Error('PRIVATE_DISK_PATH_AND_CREDENTIAL'), { code: 'ENOSPC' }); } return fs.open(file, mode, ...args); } };
  const { store, directory } = await harness(t, { io });
  assert.equal(await store.recordError('desktop', 'unhandled_rejection', new Error('PRIVATE_REJECTION_PROMPT')), false);
  let snapshot = await store.snapshot(); assert.equal(snapshot.diagnostics.healthy, false); assert.equal(snapshot.diagnostics.errorCode, 'DIAGNOSTICS_IO_FAILED'); assert.equal(snapshot.events.length, 1);
  assert.equal(attemptedWrites, 1, 'logging failure must not log another logging failure'); assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
  fail = false; assert.equal(await store.record(record), true); assert.equal(store.status().healthy, true); assert.equal(store.status().errorCode, null);
  assert.equal(store.status().ioFailures, 1, 'recovery must retain evidence that diagnostic durability failed earlier in this process');
  assert.equal(attemptedWrites, 2); assert.ok((await fs.readFile(path.join(directory, 'events.0.jsonl'), 'utf8')).includes('ready'));
});

test('startup I/O errors are reported by status and do not block subsequent lifecycle hooks', async t => {
  let denied = true;
  const io = { ...fs, mkdir: async (...args) => { if (denied) throw Object.assign(new Error('PRIVATE_ACCESS_PATH'), { code: 'EACCES' }); return fs.mkdir(...args); } };
  const { store } = await harness(t, { io }); await store.init(); assert.equal(store.status().healthy, false);
  assert.equal(await store.recordError('desktop', 'start_failed', { code: 'EACCES', message: 'PRIVATE_STARTUP_SETTINGS' }), false);
  denied = false; assert.equal(await store.record({ component: 'desktop', event: 'started' }), true);
  const snapshot = await store.snapshot(); assert.equal(snapshot.diagnostics.healthy, true); assert.deepEqual(snapshot.events.map(event => event.event), ['start_failed', 'started']);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
});

test('a rotation failure is observable and a later event can recover without exceeding the file budget', async t => {
  let fail = false;
  const io = { ...fs, rename: async (...args) => { if (fail) throw new Error('PRIVATE_ROTATION_PATH'); return fs.rename(...args); } };
  const { store, directory } = await harness(t, { io, maxFileBytes: 512, maxFiles: 2 });
  for (let index = 0; index < 4; index++) await store.record(record);
  fail = true;
  for (let index = 0; index < 5 && store.status().healthy; index++) await store.record(record);
  assert.equal(store.status().healthy, false); fail = false; assert.equal(await store.record(record), true);
  for (const name of await fs.readdir(directory)) assert.ok((await fs.stat(path.join(directory, name))).size <= 512);
  assert.ok(!JSON.stringify(await store.snapshot()).includes('PRIVATE_ROTATION_PATH'));
});

test('bounded pending admission drops an event storm and flush/close settle every accepted write', async t => {
  const { store } = await harness(t, { maxPending: 2 });
  const writes = [store.record({ component: 'desktop', event: 'started' }), store.record(record), store.record({ component: 'desktop', event: 'stopping' })];
  assert.deepEqual(await Promise.all(writes), [true, true, false]);
  const status = await store.flush(); assert.equal(status.pendingWrites, 0); assert.equal(status.droppedEvents, 1);
  await store.close(); assert.equal(await store.record(record), false); assert.equal(store.status().pendingWrites, 0);
});

test('fixed lifecycle hooks accept failure codes while excluding Error names, messages and renderer descriptions', async t => {
  const { store } = await harness(t);
  for (const event of ['uncaught_exception', 'unhandled_rejection', 'start_failed', 'stop_failed', 'emergency_stop_failed']) await store.recordError('desktop', event, Object.assign(new Error('PRIVATE_HOOK_MESSAGE'), { code: 'EIO', name: 'PRIVATE_HOOK_NAME' }));
  await store.record({ component: 'desktop', event: 'renderer_gone', level: 'error', reason: 'oom', exitCode: 137, message: 'PRIVATE_RENDERER_DESCRIPTION' });
  const snapshot = await store.snapshot(); assert.equal(snapshot.events.length, 6); assert.ok(snapshot.events.slice(0, 5).every(event => event.code === 'EIO'));
  assert.equal(snapshot.events[5].reason, 'oom'); assert.equal(snapshot.events[5].exitCode, 137); assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
  const main = await fs.readFile(fileURLToPath(new URL('../desktop/main.mjs', import.meta.url)), 'utf8');
  for (const event of ['uncaught_exception', 'unhandled_rejection', 'renderer_gone', 'start_failed', 'stopped', 'emergency_stop_failed']) assert.ok(main.includes(`'${event}'`), `native lifecycle must wire ${event}`);
  assert.match(main, /diagnostics\.close\(\)/); assert.match(main, /diagnostics,/);
});

test('restart and window lifecycle failures survive logging and reopening without exporting error text', async t => {
  const { store, dataDir, directory } = await harness(t);
  const events = ['restart_failed', 'window_reopen_failed', 'lifecycle_request_failed', 'desktop_detach_failed'];
  for (const event of events) assert.equal(await store.recordError('desktop', event, Object.assign(new Error('PRIVATE_LIFECYCLE_ARGUMENTS'), { code: 'EIO', stack: 'PRIVATE_PROFILE_PATH' })), true);
  await store.close();
  const restored = new DiagnosticsStore({ dataDir }); t.after(() => restored.close());
  const snapshot = await restored.snapshot();
  assert.deepEqual(snapshot.events.map(value => value.event), events);
  assert.ok(snapshot.events.every(value => value.code === 'EIO' && value.level === 'error'));
  assert.equal(snapshot.diagnostics.droppedEvents, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_/);
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'events.0.jsonl'), 'utf8'), /PRIVATE_/);
});

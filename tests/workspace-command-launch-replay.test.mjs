import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

// Actual frozen ledger/API and candidate workspace implementation. Only their
// unrelated adapters and the process launcher are substituted. Storage is real
// in a disposable test directory. No shell, browser, HTTP, or provider runs.
const sources = Object.fromEntries(await Promise.all(['workspace-tools', 'direct-execution-jobs', 'direct-execution-api'].map(async name =>
  [name, await fs.readFile(new URL(`../lib/${name}.mjs`, import.meta.url), 'utf8')])));
const forbidden = () => { throw Error('Unexpected external adapter in inert replay test'); };
function evaluate(name, globals, exports) {
  const sandbox = { fs, path, createHash, randomUUID, StringDecoder, Buffer, TextDecoder,
    structuredClone, setTimeout, clearTimeout, queueMicrotask, AbortController, AbortSignal,
    process: { pid: process.pid, platform: 'linux', env: {}, kill: forbidden }, ...globals };
  vm.runInNewContext(sources[name].replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
    `\nthis.exports = { ${exports.join(',')} };`, sandbox, { filename: name + '.mjs' });
  return sandbox.exports;
}
async function fixture(t, observed) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-launch-replay-'));
  let launches = 0, preparedExecutions = 0;
  const spawn = () => {
    launches++;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    if (observed) child.pid = 321;
    queueMicrotask(() => {
      if (observed) child.emit('spawn');
      child.emit('error', Object.assign(new Error('fixture launch refused'), { code: 'EPERM' }));
      child.emit('close', null, null);
    });
    return child;
  };
  const workspace = evaluate('workspace-tools', { spawn, DESKTOP_RESTART_ORIGIN_ENV: 'BLACKICE_RESTART_ORIGIN' }, ['createWorkspaceToolHandler']);
  const ledger = evaluate('direct-execution-jobs', { directResourceKeys: () => [], normalizeResourceUrl: forbidden, resourceObservation: forbidden },
    ['DirectExecutionJobs', 'DIRECT_JOB_LIMITS', 'DIRECT_JOB_STATES', 'directJobTerminal', 'directRequestDigest']);
  const apiModule = evaluate('direct-execution-api', { ...ledger,
    createWorkspaceToolHandler: options => {
      const handler = workspace.createWorkspaceToolHandler(options);
      return async (...args) => { preparedExecutions++; return handler(...args); };
    },
    createDirectTaskContractTools: () => [], createDirectTaskContextTools: () => [],
    supportsTaskContext: () => false, withTaskContext: forbidden, BROWSER_CLEANUP_PROTOCOL: '',
    DesktopRestartOrigins: class { finish() {} }, directResourceKeys: () => [],
    createBrowserToolHandler: forbidden, agentBrowserRequest: forbidden, connectorBrowserOwner: forbidden,
    containedBrowserAvailable: () => false,
  }, ['DirectExecutionAPI']);
  const make = () => new apiModule.DirectExecutionAPI({ dataDir: directory, allowedRoot: directory,
    authorizeClient: async () => true, taskRuntime: { close: async () => {} } });
  const instances = [];
  const open = () => { const api = make(); instances.push(api); return api; };
  t.after(async () => { for (const api of instances) await api.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { open, directory, counts: () => ({ launches, preparedExecutions }) };
}
const client = { id: 'fixture-command-grant', kind: 'chatgpt', scopes: ['read', 'commands:run'] };
const args = { requestId: 'fixture-denied-command', command: 'fixture-only-never-executed', timeoutMs: 1000 };
async function settle(api, id) {
  for (let n = 0; n < 200; n++) {
    const job = await api.call('blackice_get_job', { jobId: id }, client);
    if (job.settled && api.active.size === 0) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Inert direct job did not settle');
}
for (const observed of [false, true]) test(`durable denied launch replay preserves bytes and does not dispatch again (spawn observed=${observed})`, async t => {
  const f = await fixture(t, observed), api = f.open();
  const admitted = await api.call('blackice_run_command', args, client);
  const first = await settle(api, admitted.jobId);
  assert.equal(first.status, 'failed'); assert.equal(first.result.success, false);
  const launch = JSON.parse(first.result.text.text).launch;
  assert.equal(launch.processStartObserved, observed); assert.equal(launch.executionOutcome, 'unknown');
  assert.equal(launch.securityBlockConfirmed, false); assert.equal(launch.securityBlockPossible, true);
  assert.equal(first.effects.possible, true); assert.equal(first.effects.confirmed, false);
  assert.deepEqual(f.counts(), { launches: 1, preparedExecutions: 1 });
  const receiptPath = path.join(f.directory, 'direct-execution-jobs', admitted.jobId + '.json');
  const bytes = await fs.readFile(receiptPath);
  const replays = await Promise.all(Array.from({ length: 8 }, () => api.call('blackice_run_command', { ...args }, client)));
  for (const replay of replays) { assert.equal(replay.existing, true); assert.equal(replay.jobId, first.jobId); assert.equal(replay.status, 'failed'); }
  assert.equal((await settle(api, first.jobId)).result.text.text, first.result.text.text);
  assert.deepEqual(await fs.readFile(receiptPath), bytes);
  await assert.rejects(api.call('blackice_run_command', { ...args, command: 'different-fixture' }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
  // Read/status/list/cancel and an invalid interaction cannot reopen a failed action.
  await api.call('blackice_direct_status', {}, client); await api.call('blackice_list_jobs', {}, client);
  await api.call('blackice_cancel_job', { jobId: first.jobId }, client);
  await assert.rejects(api.resolveInteraction(first.jobId, 'nonexistent'), { code: 'DIRECT_INTERACTION_CHANGED' });
  assert.deepEqual(await fs.readFile(receiptPath), bytes); assert.deepEqual(f.counts(), { launches: 1, preparedExecutions: 1 });
  await api.close();
  const reopened = f.open();
  const replay = await reopened.call('blackice_run_command', { ...args }, client);
  assert.equal(replay.existing, true); assert.equal(replay.status, 'failed');
  assert.equal((await settle(reopened, first.jobId)).result.text.text, first.result.text.text);
  assert.deepEqual(await fs.readFile(receiptPath), bytes); assert.deepEqual(f.counts(), { launches: 1, preparedExecutions: 1 });
});

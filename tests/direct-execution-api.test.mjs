import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI, DIRECT_EXECUTION_SCOPES } from '../lib/direct-execution-api.mjs';
import { FilePatchStore } from '../lib/file-patches.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { chatGPTFileImportTool } from '../lib/chatgpt-file-import.mjs';

const client = { id: 'grant-one', label: 'Authorized ChatGPT', kind: 'chatgpt', scopes: [...DIRECT_EXECUTION_SCOPES] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const held = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const toolReceipt = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const customTool = (execute, extra = {}) => ({ definition: { name: 'blackice_test_action', description: 'Owned test action.', scope: 'files:write', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, text: { type: 'string' } }, required: ['requestId'], additionalProperties: false } }, execute, ...extra });
async function harness(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-direct-api-')), cwd = path.join(directory, 'allowed'), other = path.join(directory, 'outside'), dataDir = path.join(directory, 'profile');
  await mkdir(cwd); await mkdir(other); const patches = new FilePatchStore({ dataDir });
  const api = new DirectExecutionAPI({ dataDir, allowedRoot: cwd, patchStore: patches, ...options }); await api.init();
  t.after(async () => { await api.close().catch(() => {}); await patches.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, cwd, other, dataDir, patches, api };
}
async function waitJob(api, id, predicate = job => job.settled, who = client) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const value = await api.getJob(id, who); if (predicate(value)) return value; await sleep(5); }
  throw new Error(`Direct job did not reach the expected state: ${JSON.stringify(await api.getJob(id, who))}`);
}
async function legacyApproval(api, requestId, selectedPath = 'legacy.txt') {
  const { job } = await api.jobs.admit({ ownerId: client.id, requestId, tool: 'blackice_workspace_write', arguments: { action: 'write', path: selectedPath, text: 'Legacy action must not run.' }, requiredScopes: ['files:write'], client, mutating: true,
    interaction: { id: `legacy-${requestId}`, kind: 'approval', message: 'Old local approval.', createdAt: new Date().toISOString() } });
  return api.getJob(job.id, client);
}

test('read-only nonce probe proves authenticated request and has no file, browser or model side effect', async t => {
  const { api, cwd } = await harness(t);
  const read = { ...client, scopes: ['read'] }, status = await api.call('blackice_direct_status', { nonce: 'chat-proof-314' }, read);
  assert.equal(status.connectionId, read.id); assert.deepEqual(status.grantedScopes, ['read']); assert.notEqual(status.grantedScopes, read.scopes);
  assert.equal(status.nonce, 'chat-proof-314'); assert.equal(status.providerTurns, false); assert.equal(status.modelStarted, false); assert.equal(status.jobs.total, 0); assert.deepEqual(await readdir(cwd), []);
  assert.equal(status.localMutationApproval, false); assert.equal(Object.hasOwn(status, 'approvalPolicy'), false);
  assert.deepEqual(api.tools(read).map(tool => tool.name), ['blackice_direct_status', 'blackice_list_jobs', 'blackice_get_job', 'blackice_cancel_job']);
  await assert.rejects(api.call('blackice_workspace_read', { requestId: 'denied', action: 'list' }, read), { code: 'DIRECT_SCOPE_REQUIRED', scope: 'files:read' });
  await assert.rejects(api.call('blackice_direct_status', { nonce: 'x', scopes: ['files:write'] }, read), /declared arguments/);
  await assert.rejects(api.call('blackice_start_task', {}, client), { code: 'DIRECT_TOOL_UNKNOWN' });
});

test('direct status exposes only the validated caller grant and omits identity from host status', async t => {
  let authorized = true;
  const { api } = await harness(t, { authorizeClient: () => authorized });
  const first = { ...client, id: 'first-approval', scopes: ['read', 'files:read'] };
  const probe = await api.call('blackice_direct_status', {}, first);
  assert.equal(probe.connectionId, first.id); assert.deepEqual(probe.grantedScopes, first.scopes);
  probe.grantedScopes.push('commands:run'); assert.deepEqual(first.scopes, ['read', 'files:read']);
  const sameGrant = await api.call('blackice_direct_status', {}, { ...first, scopes: ['read'] });
  assert.equal(sameGrant.connectionId, probe.connectionId); assert.deepEqual(sameGrant.grantedScopes, ['read']);
  const newGrant = await api.call('blackice_direct_status', {}, { ...first, id: 'new-approval' });
  assert.notEqual(newGrant.connectionId, probe.connectionId); assert.deepEqual(newGrant.grantedScopes, first.scopes);
  const host = await api.status();
  assert.equal(Object.hasOwn(host, 'connectionId'), false); assert.equal(Object.hasOwn(host, 'grantedScopes'), false);
  await assert.rejects(api.call('blackice_direct_status', {}, undefined), { code: 'DIRECT_AUTH_REQUIRED' });
  await assert.rejects(api.status({ id: 'invalid', scopes: [] }), { code: 'DIRECT_SCOPE_REQUIRED' });
  authorized = false; await assert.rejects(api.status(first), { code: 'DIRECT_AUTH_REQUIRED' });
});

test('real bounded workspace read returns one durable receipt and exact replay never reads changed file', async t => {
  const { api, cwd } = await harness(t); await writeFile(path.join(cwd, 'sample.txt'), 'First line\nA real café receipt\nThird line');
  const request = { requestId: 'read-sample', action: 'read', path: 'sample.txt', startLine: 2, lineCount: 1 };
  const first = await api.call('blackice_workspace_read', request, client), done = await waitJob(api, first.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(JSON.parse(done.result.text.text).content, '2: A real café receipt');
  await writeFile(path.join(cwd, 'sample.txt'), 'Changed after the completed job.');
  const repeated = await api.call('blackice_workspace_read', { ...request }, client); assert.equal(repeated.existing, true); assert.equal(repeated.jobId, first.jobId);
  assert.equal((await api.getJob(first.jobId, client)).result.text.text, done.result.text.text);
  await assert.rejects(api.call('blackice_workspace_read', { ...request, path: 'another.txt' }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
});

test('scoped writes execute directly and no local action approval API or remote override exists', async t => {
  const { api, cwd } = await harness(t), file = path.join(cwd, 'new.txt');
  const request = { requestId: 'write-local', action: 'write', path: 'new.txt', text: 'Approved exact bytes.' };
  const pending = await api.call('blackice_workspace_write', request, client); assert.equal(pending.status, 'queued'); assert.equal(pending.interaction, null);
  await assert.rejects(api.call('blackice_workspace_write', { ...request, approved: true }, client), /declared arguments/);
  await assert.rejects(api.call('blackice_approve_job', { jobId: pending.jobId }, client), { code: 'DIRECT_TOOL_UNKNOWN' });
  assert.equal(typeof api.approve, 'undefined'); assert.equal(Object.hasOwn(api, 'requireMutationApproval'), false); assert.equal(Object.hasOwn(api, 'resolveApprovalPolicy'), false);
  const done = await waitJob(api, pending.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(await readFile(file, 'utf8'), request.text);
  assert.equal((await api.pendingInteractions()).total, 0);
});

test('new authorized work needs no local setting and the choice persists naturally after restart', async t => {
  const { api, cwd, dataDir } = await harness(t);
  const job = await api.call('blackice_workspace_write', { requestId: 'authorized-write', action: 'write', path: 'nested/result.txt', text: 'Host-authorized bytes.' }, client);
  assert.equal((await waitJob(api, job.jobId)).status, 'succeeded'); assert.equal(await readFile(path.join(cwd, 'nested', 'result.txt'), 'utf8'), 'Host-authorized bytes.');
  await api.close(); const reopened = new DirectExecutionAPI({ dataDir, allowedRoot: cwd }); t.after(() => reopened.close()); await reopened.init();
  assert.equal((await reopened.status(client)).localMutationApproval, false); assert.equal((await reopened.getJob(job.jobId, client)).status, 'succeeded');
  const next = await reopened.call('blackice_workspace_write', { requestId: 'authorized-after-restart', action: 'write', path: 'after.txt', text: 'After restart.' }, client);
  assert.equal(next.interaction, null); assert.equal((await waitJob(reopened, next.jobId)).status, 'succeeded');
  await reopened.close();
});

test('legacy pending and cancelled approval requests stay preserved and never replay on upgrade or retry', async t => {
  const { api, dataDir, cwd } = await harness(t), pending = await legacyApproval(api, 'old-pending'), cancelled = await legacyApproval(api, 'old-cancelled', 'cancelled.txt');
  await api.cancel(cancelled.jobId); await api.close();
  const reopened = new DirectExecutionAPI({ dataDir, allowedRoot: cwd }); t.after(() => reopened.close()); await reopened.init();
  const kept = await reopened.getJob(pending.jobId, client); assert.equal(kept.status, 'awaiting_input'); assert.match(kept.nextAction, /legacy approval request will not run/);
  const oldArgs = { requestId: 'old-pending', action: 'write', path: 'legacy.txt', text: 'Legacy action must not run.' };
  const repeated = await reopened.call('blackice_workspace_write', oldArgs, client); assert.equal(repeated.existing, true); assert.equal(repeated.status, 'awaiting_input');
  const cancelledRetry = await reopened.call('blackice_workspace_write', { ...oldArgs, requestId: 'old-cancelled', path: 'cancelled.txt' }, client); assert.equal(cancelledRetry.status, 'cancelled');
  assert.equal(typeof reopened.approve, 'undefined'); await reopened.reject(pending.jobId, pending.interaction.id);
  assert.equal((await reopened.getJob(pending.jobId, client)).status, 'cancelled'); assert.deepEqual(await readdir(cwd), []);
  await reopened.close();
});

test('explicit absolute paths, parent paths and ordinary symlinks work under the account permissions', async t => {
  const { api, cwd, other } = await harness(t); await writeFile(path.join(other, 'private.txt'), 'Requested file outside the working directory.');
  await symlink(other, path.join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [index, selected] of [path.join(other, 'private.txt'), '../outside/private.txt', 'escape/private.txt'].entries()) {
    const job = await api.call('blackice_workspace_read', { requestId: `escape-read-${index}`, action: 'read', path: selected }, client), result = await waitJob(api, job.jobId);
    assert.equal(result.status, 'succeeded'); assert.match(result.result.text.text, /Requested file outside the working directory/);
  }
  const write = await api.call('blackice_workspace_write', { requestId: 'escape-write', action: 'write', path: 'escape/created/deep.txt', text: 'Requested external write.' }, client);
  assert.equal((await waitJob(api, write.jobId)).status, 'succeeded'); assert.equal(await readFile(path.join(other, 'created', 'deep.txt'), 'utf8'), 'Requested external write.');
  const absoluteWrite = await api.call('blackice_workspace_write', { requestId: 'absolute-write', action: 'write', path: path.join(other, 'absolute.txt'), text: 'Absolute write.' }, client);
  assert.equal((await waitJob(api, absoluteWrite.jobId)).status, 'succeeded'); assert.equal(await readFile(path.join(other, 'absolute.txt'), 'utf8'), 'Absolute write.');
  const search = await api.call('blackice_workspace_read', { requestId: 'outside-search', action: 'search', path: other, query: 'Requested file' }, client), done = await waitJob(api, search.jobId);
  assert.equal(done.status, 'succeeded'); assert.match(done.result.text.text, /Requested file outside the working directory/);
});

test('replacing a working directory keeps it usable for new relative file operations', async t => {
  const release = held(), started = held();
  const { api, cwd } = await harness(t, { maxConcurrent: 1, additionalTools: [customTool(async () => { started.resolve(); await release.promise; return toolReceipt({ held: true }); })] }); t.after(() => release.resolve());
  const blocker = await api.call('blackice_test_action', { requestId: 'hold-root-swap' }, client); await started.promise;
  const pending = await api.call('blackice_workspace_write', { requestId: 'root-swap', action: 'write', path: 'x.txt', text: 'Do not dispatch.' }, client);
  await rename(cwd, `${cwd}-old`); await mkdir(cwd); release.resolve(); await waitJob(api, blocker.jobId);
  const done = await waitJob(api, pending.jobId); assert.equal(done.status, 'succeeded'); assert.equal(await readFile(path.join(cwd, 'x.txt'), 'utf8'), 'Do not dispatch.');
});

test('patch and guarded undo use durable receipts for relative and explicit external paths', async t => {
  const { api, cwd, other, patches } = await harness(t);
  await writeFile(path.join(cwd, 'code.txt'), 'old unique text'); await writeFile(path.join(other, 'private.txt'), 'outside original');
  const outside = await patches.patch({ cwd, path: path.join(other, 'private.txt'), oldText: 'original', newText: 'changed' });
  const externalUndo = await api.call('blackice_workspace_write', { requestId: 'outside-undo', action: 'undo_patch', patchId: outside.id }, client); assert.equal((await waitJob(api, externalUndo.jobId)).status, 'succeeded'); assert.equal(await readFile(path.join(other, 'private.txt'), 'utf8'), 'outside original');
  const patched = await api.call('blackice_workspace_write', { requestId: 'patch-one', action: 'patch', path: 'code.txt', oldText: 'old unique', newText: 'new unique' }, client), receipt = JSON.parse((await waitJob(api, patched.jobId)).result.text.text);
  assert.equal(await readFile(path.join(cwd, 'code.txt'), 'utf8'), 'new unique text');
  const undone = await api.call('blackice_workspace_write', { requestId: 'undo-one', action: 'undo_patch', patchId: receipt.id }, client); assert.equal((await waitJob(api, undone.jobId)).status, 'succeeded'); assert.equal(await readFile(path.join(cwd, 'code.txt'), 'utf8'), 'old unique text');
  const history = await api.call('blackice_workspace_read', { requestId: 'history', action: 'patch_history' }, client), listed = await waitJob(api, history.jobId); assert.match(listed.result.text.text, new RegExp(outside.id));
});

test('owner isolation holds for get, list and cancel even when job ID is known', async t => {
  const { api } = await harness(t), pending = await api.call('blackice_workspace_write', { requestId: 'owned', action: 'write', path: 'own.txt', text: 'Owned.' }, client), other = { ...client, id: 'grant-other' };
  await assert.rejects(api.call('blackice_get_job', { jobId: pending.jobId }, other), { code: 'DIRECT_JOB_NOT_FOUND' });
  await assert.rejects(api.call('blackice_cancel_job', { jobId: pending.jobId }, other), { code: 'DIRECT_JOB_NOT_FOUND' });
  assert.equal((await api.call('blackice_list_jobs', {}, other)).total, 0); assert.equal((await waitJob(api, pending.jobId)).status, 'succeeded');
});

test('revocation cancels active and pending work and scopes are rechecked immediately before dispatch', async t => {
  let authorized = true, called = 0; const started = held();
  const { api } = await harness(t, { maxConcurrent: 1, authorizeClient: () => authorized, additionalTools: [customTool(async (_args, { signal }) => { called++; started.resolve(); await new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }); }); })] });
  authorized = false; await assert.rejects(api.call('blackice_test_action', { requestId: 'stale-grant' }, client), { code: 'DIRECT_AUTH_REQUIRED' }); assert.equal(called, 0); authorized = true;
  const pending = await api.call('blackice_test_action', { requestId: 'current-grant' }, client); await started.promise;
  const second = await api.call('blackice_test_action', { requestId: 'waiting' }, client); await api.revokeClient(client.id);
  const deadline = Date.now() + 2000; while (api.active.size && Date.now() < deadline) await sleep(5);
  assert.equal((await api.jobs.get(pending.jobId)).status, 'cancelled'); assert.equal((await api.jobs.get(pending.jobId)).effects.possible, true);
  assert.equal((await api.jobs.get(second.jobId)).status, 'cancelled'); assert.equal((await api.jobs.get(second.jobId)).effects.possible, false); assert.equal(called, 1);
  await assert.rejects(api.call('blackice_direct_status', {}, client), { code: 'DIRECT_AUTH_REQUIRED' });
});

test('cancellation before queued dispatch never reaches the handler and repeated IDs do not duplicate active work', async t => {
  const release = held(), started = held(), calls = [];
  const { api } = await harness(t, { maxConcurrent: 1, additionalTools: [customTool(async args => { calls.push(args.text); started.resolve(); await release.promise; return toolReceipt({ receipt: args.text }); })] });
  const firstRequest = { requestId: 'active', text: 'one' }, first = await api.call('blackice_test_action', firstRequest, client); await started.promise;
  const duplicate = await api.call('blackice_test_action', firstRequest, client); assert.equal(duplicate.jobId, first.jobId);
  const queued = await api.call('blackice_test_action', { requestId: 'queued', text: 'two' }, client); await api.call('blackice_cancel_job', { jobId: queued.jobId }, client); release.resolve();
  assert.equal((await waitJob(api, first.jobId)).status, 'succeeded'); assert.equal((await waitJob(api, queued.jobId)).effects.possible, false); assert.deepEqual(calls, ['one']);
});

test('cancelled dispatched work preserves a late success receipt instead of claiming no effects', async t => {
  const started = held(), release = held();
  const { api } = await harness(t, { additionalTools: [customTool(async () => { started.resolve(); await release.promise; return toolReceipt({ wrote: true, receipt: 'actual-side-effect' }); })] });
  const job = await api.call('blackice_test_action', { requestId: 'late-result' }, client); await started.promise;
  assert.equal((await api.call('blackice_cancel_job', { jobId: job.jobId }, client)).status, 'cancelling'); release.resolve();
  const done = await waitJob(api, job.jobId); assert.equal(done.status, 'cancelled'); assert.equal(done.effects.possible, true); assert.equal(done.effects.confirmed, true); assert.match(done.result.text.text, /actual-side-effect/);
});

test('signed import arguments are hashed for replay but never persisted or echoed in pending metadata', async t => {
  let received;
  const { api, dataDir } = await harness(t, { additionalTools: [customTool(async args => { received = args.text; return toolReceipt({ imported: true }); }, { durableArguments: args => ({ text: 'file-one metadata only' }) })] });
  const secret = 'https://files.example.test/object?private=signed-token', pending = await api.call('blackice_test_action', { requestId: 'import-one', text: secret }, client);
  const raw = await readFile(path.join(dataDir, 'direct-execution-jobs', `${pending.jobId}.json`), 'utf8'); assert.doesNotMatch(raw, /signed-token|files\.example/);
  assert.doesNotMatch(JSON.stringify(await api.pendingInteractions()), /signed-token/); assert.equal((await waitJob(api, pending.jobId)).status, 'succeeded'); assert.equal(received, secret);
  await assert.rejects(api.call('blackice_test_action', { requestId: 'import-one', text: `${secret}-changed` }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
});

test('the concrete ChatGPT file-import tool executes under scopes and saves its receipt without retaining its signed URL', async t => {
  const { api, cwd, dataDir } = await harness(t), importedBytes = Buffer.from('Actual attached fixture bytes ✓'); let downloads = 0;
  // A second independent ledger is unnecessary: register the fixed host tool in
  // the actual constructor, then use that API for its normal action lifecycle.
  await api.close();
  const importer = new DirectExecutionAPI({ dataDir, allowedRoot: cwd, additionalTools: [chatGPTFileImportTool({ directory: path.join(cwd, 'blackice-imports'), download: async () => { downloads++; return importedBytes; } })] });
  await importer.init(); t.after(() => importer.close().catch(() => {}));
  const args = { requestId: 'attached_fixture', file: { download_url: 'https://files.example.test/attached?sig=secret-temporary', file_id: 'file_fixture', file_name: 'report.txt', mime_type: 'text/plain' } };
  const pending = await importer.call('blackice_import_file', args, client); assert.equal(pending.status, 'queued'); assert.equal(pending.interaction, null);
  assert.doesNotMatch(await readFile(path.join(dataDir, 'direct-execution-jobs', `${pending.jobId}.json`), 'utf8'), /secret-temporary|download_url/);
  const done = await waitJob(importer, pending.jobId), receipt = JSON.parse(done.result.text.text);
  assert.equal(done.status, 'succeeded'); assert.equal(receipt.bytes, importedBytes.length); assert.deepEqual(await readFile(receipt.path), importedBytes);
  assert.equal((await importer.call('blackice_import_file', args, client)).existing, true); assert.equal(downloads, 1);
  await importer.close();
});

test('contained browser reads use real serialized handler and reject external browser or implicit active tab', async t => {
  const calls = [], browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async args => { calls.push(args); return { tabId: args.tabId, frames: [{ text: 'Actual browser receipt' }] }; }, close: async () => {} } });
  t.after(() => browser.close()); const { api } = await harness(t, { browser });
  await assert.rejects(api.call('blackice_browser_read', { requestId: 'implicit', action: 'snapshot' }, client), /explicitly observed/);
  await assert.rejects(api.call('blackice_browser_read', { requestId: 'external', action: 'snapshot', tabId: 'one', browser: 'firefox' }, client), /declared arguments/);
  const job = await api.call('blackice_browser_read', { requestId: 'contained', action: 'snapshot', tabId: 'one' }, client), done = await waitJob(api, job.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(calls[0].browser, 'relay'); assert.match(done.result.text.text, /Actual browser receipt/);
});

test('browser failures keep actionable durable messages, uncertainty and exact replay across reload', async t => {
  const stale = 'This element ref is stale. Take a new snapshot and choose its current ref.', calls = [];
  const browser = new BrowserWorkspace({ driver: {
    status: () => ({ available: true, contained: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }),
    perform: async args => { calls.push(args.ref); if (args.ref === 'detached') throw Object.assign(new Error(stale), { code: 'BROWSER_REF_STALE', actionDispatched: false }); throw stale; },
    close: async () => {},
  } }); t.after(() => browser.close());
  const { api, dataDir, cwd } = await harness(t, { browser }), completed = [];
  for (const [ref, possible] of [['detached', false], ['unknown-boundary', true]]) {
    const request = { requestId: `failure-${ref}`, action: 'click', tabId: 'one', ref };
    const pending = await api.call('blackice_browser_action', request, client), done = await waitJob(api, pending.jobId);
    assert.equal(done.status, 'failed'); assert.equal(done.error.code, 'DIRECT_TOOL_FAILED');
    const receipt = JSON.parse(done.result.text.text);
    assert.equal(receipt.error, stale); assert.equal(receipt.code, possible ? 'BROWSER_ACTION_FAILED' : 'BROWSER_REF_STALE');
    assert.equal(receipt.actionDispatched, possible ? undefined : false);
    assert.deepEqual(done.effects, { possible, confirmed: false });
    const replay = await api.call('blackice_browser_action', request, client);
    assert.equal(replay.existing, true); assert.equal(replay.jobId, pending.jobId);
    completed.push({ request, jobId: pending.jobId, text: done.result.text.text, possible });
  }
  assert.deepEqual(calls, ['detached', 'unknown-boundary']); await api.close();
  const reopened = new DirectExecutionAPI({ dataDir, allowedRoot: cwd, browser }); t.after(() => reopened.close()); await reopened.init();
  for (const { request, jobId, text, possible } of completed) {
    const saved = await reopened.getJob(jobId, client); assert.equal(saved.result.text.text, text); assert.deepEqual(saved.effects, { possible, confirmed: false });
    const replay = await reopened.call('blackice_browser_action', request, client); assert.equal(replay.existing, true); assert.equal(replay.jobId, jobId);
  }
  assert.deepEqual(calls, ['detached', 'unknown-boundary'], 'Reading and replaying an error receipt must not send the click again.');
  await reopened.close();
});

test('a concrete pending browser interaction blocks without dispatch and local resolution never replays it', async t => {
  let performed = 0;
  const browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async () => { performed++; return {}; }, close: async () => {} } }); t.after(() => browser.close());
  const { api } = await harness(t, { browser, inspectBrowserInteraction: () => ({ id: 'native-dialog-17', kind: 'browser', tabId: 'one' }) });
  const job = await api.call('blackice_browser_action', { requestId: 'blocked-click', action: 'click', tabId: 'one', ref: 'observed-ref' }, client), waiting = await waitJob(api, job.jobId, item => item.status === 'awaiting_input');
  assert.equal(waiting.interaction.browserInteractionId, 'native-dialog-17'); assert.equal(performed, 0); assert.equal(waiting.effects.possible, false);
  const resolved = await api.resolveInteraction(job.jobId, waiting.interaction.id); assert.equal(resolved.status, 'interrupted'); assert.equal(performed, 0);
  const replay = await api.call('blackice_browser_action', { requestId: 'blocked-click', action: 'click', tabId: 'one', ref: 'observed-ref' }, client); assert.equal(replay.existing, true); assert.equal(performed, 0);
});

test('contained page text is kept only in memory and public job metadata never echoes its value', async t => {
  let supplied;
  const browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async args => { supplied = args.text; return { tabId: args.tabId, receipt: { typed: true, characters: args.text.length } }; }, close: async () => {} } }); t.after(() => browser.close());
  const { api, dataDir } = await harness(t, { browser }), text = 'sensitive-field-text-fixture';
  const pending = await api.call('blackice_browser_action', { requestId: 'type-memory-only', action: 'type', tabId: 'one', expectedUrl: 'https://example.test/', expectedDocumentId: 'document-one', text }, client);
  assert.doesNotMatch(await readFile(path.join(dataDir, 'direct-execution-jobs', `${pending.jobId}.json`), 'utf8'), new RegExp(text));
  assert.doesNotMatch(JSON.stringify(await api.pendingInteractions()), new RegExp(text));
  const done = await waitJob(api, pending.jobId); assert.equal(supplied, text); assert.equal(done.status, 'succeeded'); assert.doesNotMatch(JSON.stringify(done), new RegExp(text));
});

test('fill and select receipts omit echoed page values, URLs, images and dialog text from durable history', async t => {
  const secret = 'private-input-marker-847', observed = [];
  const browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async args => {
    observed.push(args.text || args.value);
    if (args.action === 'type') throw Error(`A page error echoed ${secret}`);
    return { tabId: 'one', documentId: 'one:1', title: secret, url: `https://example.test/?value=${secret}`, imageUrl: `data:image/png;base64,${Buffer.from(secret).toString('base64')}`,
      frames: [{ text: secret, elements: [{ value: secret, label: secret }] }], receipt: args.action === 'fill' ? { filled: true, characters: secret.length } : { selected: secret },
      ...(args.action === 'select' ? { actionDispatched: true, pendingInteraction: { id: 'browser_input_11111111-1111-4111-8111-111111111111', kind: 'javascript_dialog', status: 'pending', tabId: 'one', documentId: 'one:1', message: secret, url: `https://example.test/${secret}` } } : {}) };
  }, close: async () => {} } }); t.after(() => browser.close());
  const { api, dataDir } = await harness(t, { browser });
  for (const action of ['fill', 'select', 'type']) {
    const args = { requestId: `private-${action}`, action, tabId: 'one', ...(action === 'type' ? { expectedUrl: `https://example.test/?private=${secret}`, expectedDocumentId: 'one:1', text: secret } : { ref: 'observed-control', [action === 'select' ? 'value' : 'text']: secret }) };
    const job = await api.call('blackice_browser_action', args, client), done = await waitJob(api, job.jobId, value => value.settled || value.status === 'awaiting_input');
    const raw = await readFile(path.join(dataDir, 'direct-execution-jobs', `${job.jobId}.json`), 'utf8');
    assert.doesNotMatch(raw, new RegExp(secret)); assert.doesNotMatch(raw, new RegExp(Buffer.from(secret).toString('base64')));
    assert.doesNotMatch(JSON.stringify(done), new RegExp(secret)); assert.equal(done.result.imageCount, 0);
    assert.equal(JSON.parse(done.result.text.text).pageContentOmitted, true);
    if (action === 'select') { assert.equal(done.interaction.kind, 'javascript_dialog'); assert.equal(done.effects.possible, true); assert.equal(done.effects.confirmed, false); }
    if (action === 'type') assert.equal(done.status, 'failed');
  }
  assert.deepEqual(observed, [secret, secret, secret]);
});

test('shutdown waits for physical completion, retains its lease on timeout and supports explicit cleanup retry', async t => {
  const started = held(), release = held();
  const { api, dataDir, cwd } = await harness(t, { additionalTools: [customTool(async () => { started.resolve(); await release.promise; return toolReceipt({ completed: true }); })] });
  const job = await api.call('blackice_test_action', { requestId: 'shutdown-held' }, client); await started.promise;
  await assert.rejects(api.close({ timeoutMs: 20 }), { code: 'DIRECT_SHUTDOWN_UNCONFIRMED' });
  const contender = new DirectExecutionAPI({ dataDir, allowedRoot: cwd }); await contender.init();
  assert.equal((await contender.status()).available, false); assert.equal((await contender.status()).storageError.code, 'DIRECT_JOB_LOCKED'); await contender.close();
  release.resolve(); const done = await waitJob(api, job.jobId); assert.equal(done.status, 'cancelled'); assert.equal(done.effects.confirmed, true);
  await api.close(); const recovered = new DirectExecutionAPI({ dataDir, allowedRoot: cwd }); await recovered.init();
  assert.equal((await recovered.getJob(job.jobId, client)).result.text.text, done.result.text.text); await recovered.close();
});

test('commands require their separate scope and do not borrow files write authority', async t => {
  const { api, cwd } = await harness(t, {});
  await assert.rejects(api.call('blackice_run_command', { requestId: 'scope-command', command: 'echo forbidden' }, { ...client, scopes: ['read', 'files:write'] }), { code: 'DIRECT_SCOPE_REQUIRED', scope: 'commands:run' });
  const command = process.platform === 'win32' ? "[System.IO.File]::WriteAllText('command-receipt.txt','Actual shell result'); Write-Output 'actual-command-proof'" : "printf 'Actual shell result' > command-receipt.txt; printf 'actual-command-proof'";
  const job = await api.call('blackice_run_command', { requestId: 'command-proof', command }, client), done = await waitJob(api, job.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(await readFile(path.join(cwd, 'command-receipt.txt'), 'utf8'), 'Actual shell result'); assert.match(done.result.text.text, /actual-command-proof/); assert.equal((await api.status(client)).capabilities.shellIsSandboxed, false);
});

test('a corrupt optional job ledger preserves all receipts and exposes unavailable status without blocking app initialization', async t => {
  const { api, cwd, dataDir } = await harness(t);
  const kept = await legacyApproval(api, 'keep-pending', 'keep.txt');
  const damaged = await legacyApproval(api, 'damage-pending', 'damage.txt');
  await api.close();
  const keptPath = path.join(dataDir, 'direct-execution-jobs', `${kept.jobId}.json`), damagedPath = path.join(dataDir, 'direct-execution-jobs', `${damaged.jobId}.json`);
  const keptBytes = await readFile(keptPath), corruptBytes = Buffer.from('{"broken":'); await writeFile(damagedPath, corruptBytes);
  const reopened = new DirectExecutionAPI({ dataDir, allowedRoot: cwd }); t.after(() => reopened.close());
  assert.equal(await reopened.init(), reopened);
  const status = await reopened.call('blackice_direct_status', { nonce: 'health-only' }, client);
  assert.equal(status.available, false); assert.equal(status.jobs.available, false); assert.equal(status.jobs.total, null); assert.equal(status.storageError.code, 'DIRECT_JOB_STORAGE');
  assert.equal(status.nonce, 'health-only'); assert.equal((await reopened.pendingInteractions()).available, false);
  for (const [tool, args] of [
    ['blackice_list_jobs', {}], ['blackice_get_job', { jobId: kept.jobId }], ['blackice_cancel_job', { jobId: kept.jobId }],
    ['blackice_workspace_write', { requestId: 'cannot-bypass', action: 'write', path: 'bypass.txt', text: 'Forbidden.' }],
  ]) await assert.rejects(reopened.call(tool, args, client), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(reopened.reject(kept.jobId, kept.interaction.id), { code: 'DIRECT_JOB_STORAGE' });
  await reopened.revokeClient(client.id); await reopened.close();
  assert.deepEqual(await readFile(keptPath), keptBytes); assert.deepEqual(await readFile(damagedPath), corruptBytes); assert.deepEqual(await readdir(cwd), []);
});

test('fresh attenuated grants cannot retrieve or enumerate saved results and errors outside their current scopes', async t => {
  let scopes = new Set(client.scopes);
  const command = customTool(async () => { throw Error('Private command detail: marker-command-719.'); });
  command.definition = { ...command.definition, name: 'blackice_test_command', scope: 'commands:run' };
  const { api, cwd } = await harness(t, { authorizeClient: (_client, { requiredScopes }) => requiredScopes.every(scope => scopes.has(scope)), additionalTools: [command] });
  await writeFile(path.join(cwd, 'read.txt'), 'Protected file marker.');
  const read = await api.call('blackice_workspace_read', { requestId: 'private-file-request', action: 'read', path: 'read.txt' }, client); await waitJob(api, read.jobId);
  const ran = await api.call('blackice_test_command', { requestId: 'marker-command-719' }, client); await waitJob(api, ran.jobId);
  scopes = new Set(['read', 'files:read']);
  await assert.rejects(api.getJob(ran.jobId, client), error => error.code === 'DIRECT_AUTH_REQUIRED' && error.requiredScopes.includes('commands:run'));
  const visible = await api.call('blackice_list_jobs', { limit: 1 }, client);
  assert.equal(visible.total, 1); assert.equal(visible.jobs[0].jobId, read.jobId); assert.equal(visible.nextOffset, null); assert.doesNotMatch(JSON.stringify(visible), /marker-command-719|Private command detail/);
  const cancelled = await api.call('blackice_cancel_job', { jobId: ran.jobId }, client);
  assert.equal(cancelled.detailsRestricted, true); assert.doesNotMatch(JSON.stringify(cancelled), /marker-command-719|Private command detail/);
  assert.match((await api.getJob(read.jobId, client)).result.text.text, /Protected file marker/);
  // A result read that already began must still observe attenuation while its
  // storage read is pending, even though its bearer client object is stale.
  const started = held(), release = held(), originalGet = api.jobs.get.bind(api.jobs);
  api.jobs.get = async (...args) => { const value = await originalGet(...args); started.resolve(); await release.promise; return value; };
  const pending = api.getJob(read.jobId, client); await started.promise; scopes = new Set(['read']); release.resolve();
  await assert.rejects(pending, { code: 'DIRECT_AUTH_REQUIRED' }); api.jobs.get = originalGet;
  assert.deepEqual((await api.call('blackice_list_jobs', {}, client)).jobs, []);
  await assert.rejects(api.getJob(read.jobId, { ...client, scopes: ['read'] }), { code: 'DIRECT_SCOPE_REQUIRED', scope: 'files:read' });
});

test('uploads admit exactly one observed ref or chooser with both document guards and carry trusted path checks', async t => {
  const calls = [], checked = [];
  const browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async (args, options) => {
    assert.equal(typeof options.validateUploadPath, 'function');
    for (const file of args.paths) { await options.validateUploadPath(file); checked.push(file); }
    calls.push(args); return { tabId: args.tabId, receipt: { uploaded: [{ name: 'chosen.txt', size: 4 }] } };
  }, close: async () => {} } }); t.after(() => browser.close());
  const { api, cwd } = await harness(t, { browser }); await writeFile(path.join(cwd, 'chosen.txt'), 'test');
  const base = { requestId: 'chooser-upload', tabId: 'one', chooserId: 'browser_input_11111111-1111-4111-8111-111111111111', expectedUrl: 'https://example.test/', expectedDocumentId: 'one:7', paths: ['chosen.txt'] };
  for (const extra of [{ chooserId: undefined }, { ref: 'observed-file' }, { chooserId: 'guessed' }, { expectedUrl: undefined }, { expectedDocumentId: undefined }, { paths: [] }, { approved: true }]) {
    const args = { ...base, ...extra }; for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key];
    await assert.rejects(api.call('blackice_browser_upload', args, client), /declared arguments/);
  }
  await assert.rejects(api.call('blackice_browser_upload', base, { ...client, scopes: ['read', 'browser:write'] }), { scope: 'files:read' });
  const chosen = await api.call('blackice_browser_upload', base, client); assert.equal((await waitJob(api, chosen.jobId)).status, 'succeeded');
  const ref = { ...base, requestId: 'ref-upload', ref: 'observed-file' }; delete ref.chooserId;
  const regular = await api.call('blackice_browser_upload', ref, client); assert.equal((await waitJob(api, regular.jobId)).status, 'succeeded');
  assert.equal(calls.length, 2); assert.equal(calls[0].chooserId, base.chooserId); assert.equal(calls[1].ref, 'observed-file');
  assert.deepEqual(checked, [path.join(cwd, 'chosen.txt'), path.join(cwd, 'chosen.txt')]); assert.equal(calls[0].beforeDispatch, undefined);
});

test('durable upload receipt preserves verified delivery with unconfirmed site acceptance and replay does not dispatch again', async t => {
  let dispatches = 0;
  const receipt = { delivered: [{ name: 'chosen.pdf', size: 12, type: 'application/pdf' }], retained: [], deliveryVerified: true, inputSelection: 'cleared_by_page', siteAcceptance: 'unconfirmed', inspectBeforeContinuing: true,
    warning: 'The page cleared the file input after delivery. Inspect the page before continuing or repeating the upload.' };
  const browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async (args, options) => {
    assert.equal(args.action, 'upload'); await options.validateUploadPath(args.paths[0]); dispatches++;
    return { tabId: args.tabId, url: args.expectedUrl, documentId: args.expectedDocumentId, receipt: structuredClone(receipt) };
  }, close: async () => {} } }); t.after(() => browser.close());
  const { api, cwd } = await harness(t, { browser }); await writeFile(path.join(cwd, 'chosen.pdf'), '%PDF-fixture');
  const request = { requestId: 'delivery-cleared-once', tabId: 'one', ref: 'observed-file', expectedUrl: 'https://example.test/', expectedDocumentId: 'one:7', paths: ['chosen.pdf'] };
  const pending = await api.call('blackice_browser_upload', request, client), done = await waitJob(api, pending.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(done.result.success, true);
  const stored = JSON.parse(done.result.text.text);
  assert.deepEqual(stored.receipt, receipt); assert.equal(Object.hasOwn(stored.receipt, 'uploaded'), false);
  const repeated = await api.call('blackice_browser_upload', { ...request }, client);
  assert.equal(repeated.existing, true); assert.equal(repeated.jobId, pending.jobId);
  const reread = await api.getJob(repeated.jobId, client);
  assert.equal(reread.status, 'succeeded'); assert.equal(reread.result.text.text, done.result.text.text); assert.equal(dispatches, 1);
});

test('uploads use requested local files even when an ordinary symlink points outside the working directory', async t => {
  const release = held(), started = held(), calls = []; t.after(() => release.resolve());
  const browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async args => {
    calls.push(args.action); if (args.action === 'snapshot') { started.resolve(); await release.promise; } return { tabId: 'one' };
  }, close: async () => {} } }); t.after(() => browser.close());
  const { api, cwd, other } = await harness(t, { browser });
  await mkdir(path.join(cwd, 'selected')); await writeFile(path.join(cwd, 'selected', 'chosen.txt'), 'Owned bytes'); await writeFile(path.join(other, 'chosen.txt'), 'Outside bytes');
  const busy = browser.perform({ action: 'snapshot', browser: 'relay', tabId: 'one' }); await started.promise;
  const job = await api.call('blackice_browser_upload', { requestId: 'queue-path-swap', tabId: 'one', ref: 'observed-file', expectedUrl: 'https://example.test/', expectedDocumentId: 'one:1', paths: ['selected/chosen.txt'] }, client);
  const deadline = Date.now() + 2000; while (!browser.queue.length && Date.now() < deadline) await sleep(5); assert.equal(browser.queue.length, 1);
  await rename(path.join(cwd, 'selected'), path.join(cwd, 'selected-original')); await symlink(other, path.join(cwd, 'selected'), process.platform === 'win32' ? 'junction' : 'dir');
  release.resolve(); await busy;
  const done = await waitJob(api, job.jobId); assert.equal(done.status, 'succeeded'); assert.equal(done.effects.confirmed, true); assert.deepEqual(calls, ['snapshot', 'upload']);
  assert.equal(await readFile(path.join(cwd, 'selected', 'chosen.txt'), 'utf8'), 'Outside bytes');
});

test('a browser action waiting in the serialized queue rechecks refreshed scopes immediately before dispatch', async t => {
  const release = held(), started = held(), calls = []; let allowed = true; t.after(() => release.resolve());
  const browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async args => { calls.push(args.action); if (args.action === 'snapshot') { started.resolve(); await release.promise; } return { tabId: 'one' }; }, close: async () => {} } }); t.after(() => browser.close());
  const { api } = await harness(t, { browser, authorizeClient: (_client, { requiredScopes }) => allowed || !requiredScopes.includes('browser:write') });
  const busy = browser.perform({ action: 'snapshot', browser: 'relay', tabId: 'one' }); await started.promise;
  const job = await api.call('blackice_browser_action', { requestId: 'queue-scope-change', action: 'click', tabId: 'one', ref: 'observed-control' }, client);
  const deadline = Date.now() + 2000; while (!browser.queue.length && Date.now() < deadline) await sleep(5); assert.equal(browser.queue.length, 1);
  allowed = false; release.resolve(); await busy;
  const end = Date.now() + 2000; let done; while (Date.now() < end) { done = await api.jobs.get(job.jobId); if (done.status === 'failed') break; await sleep(5); }
  assert.equal(done.status, 'failed'); assert.equal(done.dispatched, false); assert.equal(done.effects.possible, false); assert.deepEqual(calls, ['snapshot']);
});

test('real browser handoff receipts retain dialog kinds and never claim an undispatched input completed', async t => {
  const kinds = ['javascript_dialog', 'http_auth', 'file_chooser']; let calls = 0;
  const browser = new BrowserWorkspace({ driver: { status: () => ({ contained: true, available: true, tabs: [{ tabId: 'one' }], activeTab: 'one' }), perform: async args => ({ tabId: args.tabId, actionDispatched: false, pendingInteraction: { id: `input-native-${calls}`, kind: kinds[calls++], tabId: args.tabId, documentId: 'one:4', status: 'blocked' } }), close: async () => {} } }); t.after(() => browser.close());
  const { api, dataDir, cwd } = await harness(t, { browser }); const ids = [];
  for (const kind of kinds) {
    const job = await api.call('blackice_browser_action', { requestId: `blocked-${kind}`, action: 'click', tabId: 'one', ref: 'observed-ref' }, client), waiting = await waitJob(api, job.jobId, value => value.status === 'awaiting_input');
    ids.push(job.jobId); assert.equal(waiting.interaction.kind, kind); assert.equal(waiting.interaction.documentId, 'one:4'); assert.equal(waiting.interaction.status, 'blocked');
    assert.deepEqual(waiting.effects, { possible: false, confirmed: false }); assert.equal((await api.jobs.get(job.jobId)).dispatched, false);
  }
  await api.close(); const reopened = new DirectExecutionAPI({ dataDir, allowedRoot: cwd }); t.after(() => reopened.close()); await reopened.init();
  assert.equal((await reopened.status()).available, true);
  for (const [index, id] of ids.entries()) assert.equal((await reopened.getJob(id, client)).interaction.kind, kinds[index]);
  assert.equal(calls, kinds.length); await reopened.close();
});

test('completed API history does not consume admission capacity and old requests still return exact receipts after reopening', async t => {
  let executions = 0;
  const extension = customTool(async args => { executions++; return toolReceipt({ exact: args.text }); });
  const { api, cwd, dataDir } = await harness(t, { additionalTools: [extension] }); api.jobs.maxJobs = 1;
  let first;
  for (let index = 0; index < 5; index++) {
    const args = { requestId: `history-action-${index}`, text: `Original receipt ${index}` }, job = await api.call('blackice_test_action', args, client);
    const receipt = await waitJob(api, job.jobId); assert.equal(receipt.status, 'succeeded');
    if (!first) first = { args, job, receipt };
  }
  assert.equal((await api.status(client)).jobs.total, 5); assert.equal(executions, 5); await api.close();
  const reopened = new DirectExecutionAPI({ dataDir, allowedRoot: cwd, additionalTools: [extension] }); t.after(() => reopened.close()); await reopened.init(); reopened.jobs.maxJobs = 1;
  const existing = await reopened.call('blackice_test_action', first.args, client); assert.equal(existing.existing, true); assert.equal(existing.jobId, first.job.jobId);
  assert.equal((await reopened.getJob(existing.jobId, client)).result.text.text, first.receipt.result.text.text);
  await assert.rejects(reopened.call('blackice_test_action', { ...first.args, text: 'Changed operation' }, client), { code: 'DIRECT_REQUEST_CONFLICT' }); assert.equal(executions, 5);
  const fresh = await reopened.call('blackice_test_action', { requestId: 'history-action-fresh', text: 'New receipt' }, client); assert.equal((await waitJob(reopened, fresh.jobId)).status, 'succeeded'); assert.equal(executions, 6);
  await reopened.close();
});

test('status, public history, and revocation do not hydrate completed result payloads', async t => {
  const { api } = await harness(t);
  const admission = (requestId, who = client) => ({ ownerId: who.id, requestId, tool: 'blackice_workspace_read', arguments: { action: 'read', path: 'argument-only-marker.txt' }, requiredScopes: ['files:read'], client: who, mutating: false });
  const history = (await api.jobs.admit(admission('metadata-history'))).job;
  await api.jobs.update(history.id, () => ({ status: 'succeeded', finishedAt: new Date().toISOString(), result: { success: true, contentItems: [{ type: 'inputText', text: 'large-result-marker-' + 'x'.repeat(256000) }] } }));
  const pending = (await api.jobs.admit(admission('metadata-pending'))).job, otherClient = { ...client, id: 'unrelated-owner' }, other = (await api.jobs.admit(admission('other-pending', otherClient))).job;
  const hydrate = api.jobs.fullRecord.bind(api.jobs); let terminalReads = 0;
  api.jobs.fullRecord = value => { if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status)) terminalReads++; return hydrate(value); };
  api.jobs.list = () => { throw new Error('Metadata-only API paths must not request full record pages.'); };
  const status = await api.status(client), listed = await api.listJobs(client, { limit: 100 });
  assert.equal(status.jobs.total, 2); assert.equal(listed.total, 2); assert.equal(listed.jobs.find(value => value.jobId === history.id).resultAvailable, true); assert.equal(listed.jobs.find(value => value.jobId === pending.id).resultAvailable, false);
  assert.doesNotMatch(JSON.stringify(listed), /large-result-marker|argument-only-marker/); assert.equal(terminalReads, 0);
  const revoked = await api.revokeClient(client.id); assert.equal(revoked.cancelled, 1); assert.equal(terminalReads, 0);
  assert.equal((await api.jobs.get(pending.id)).status, 'cancelled'); assert.equal((await api.jobs.get(other.id)).status, 'queued');
});

test('public history uses one metadata snapshot when a concurrent admission changes more than one page', async t => {
  const { api } = await harness(t);
  const admission = requestId => ({ ownerId: client.id, requestId, tool: 'blackice_workspace_read', arguments: { action: 'read', path: 'receipt.txt' }, requiredScopes: ['files:read'], client, mutating: false });
  for (let index = 0; index < 101; index++) { const job = (await api.jobs.admit(admission(`snapshot-${index}`))).job; await api.jobs.update(job.id, () => ({ status: 'succeeded', finishedAt: new Date().toISOString() })); }
  const snapshot = api.jobs.snapshot.bind(api.jobs); let captured, calls = 0;
  api.jobs.snapshot = async options => {
    const values = await snapshot(options); calls++;
    if (!captured) { captured = values; await api.jobs.admit(admission('snapshot-late-admission')); }
    return values;
  };
  const listed = await api.listJobs(client, { offset: 50, limit: 100 });
  assert.equal(calls, 1); assert.equal(listed.total, 101); assert.equal(listed.jobs.length, 51); assert.equal(new Set(listed.jobs.map(value => value.jobId)).size, 51);
  assert.deepEqual(listed.jobs.map(value => value.jobId), captured.slice(50).map(value => value.id)); assert.equal((await api.jobs.counts()).total, 102);
  assert.equal((await api.listJobs(client, { limit: 100 })).total, 102);
});

test('terminal hydration corruption makes direct execution unavailable and never replays or admits around the damaged receipt', async t => {
  let executions = 0;
  const { api, dataDir } = await harness(t, { additionalTools: [customTool(async () => { executions++; return toolReceipt({ kept: true }); })] });
  const args = { requestId: 'hydrate-original', text: 'Original input' }, job = await api.call('blackice_test_action', args, client); await waitJob(api, job.jobId);
  const file = path.join(dataDir, 'direct-execution-jobs', `${job.jobId}.json`), damaged = '{broken-terminal-receipt'; await writeFile(file, damaged);
  await assert.rejects(api.getJob(job.jobId, client), { code: 'DIRECT_JOB_STORAGE' });
  const status = await api.status(client); assert.equal(status.available, false); assert.equal(status.jobs.available, false); assert.equal(status.jobs.total, null);
  await assert.rejects(api.call('blackice_test_action', args, client), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(api.call('blackice_test_action', { requestId: 'hydrate-no-bypass', text: 'New input' }, client), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(executions, 1); assert.equal(await readFile(file, 'utf8'), damaged);
});

async function damagedHistory(api, dataDir) {
  const job = (await api.jobs.admit({ ownerId: client.id, requestId: 'damaged-history-for-cancellation', tool: 'blackice_workspace_read', arguments: { action: 'read', path: 'private-history.txt' }, requiredScopes: ['files:read'], client, mutating: false })).job;
  await api.jobs.update(job.id, () => ({ status: 'succeeded', finishedAt: new Date().toISOString(), result: toolReceipt({ private: 'historic detail' }) }));
  const file = path.join(dataDir, 'direct-execution-jobs', `${job.id}.json`), bytes = '{damaged-history'; await writeFile(file, bytes);
  await assert.rejects(api.jobs.get(job.id), { code: 'DIRECT_JOB_STORAGE' });
  return { file, bytes };
}

test('authenticated owners can signal active cancellation after storage failure without leaking or claiming a saved receipt', async t => {
  const started = held(), release = held(); t.after(() => release.resolve());
  let signal, denyFallbackRead = false, readChecks = 0;
  const { api, dataDir } = await harness(t, {
    authorizeClient: (_client, { requiredScopes }) => !(denyFallbackRead && requiredScopes.length === 1 && ++readChecks === 2),
    additionalTools: [customTool(async (_args, context) => { signal = context.signal; started.resolve(); await release.promise; return toolReceipt({ private: 'active result' }); })],
  });
  const admitted = await api.call('blackice_test_action', { requestId: 'private-active-request', text: 'private input' }, client); await started.promise;
  const execution = api.active.get(admitted.jobId).settled, file = path.join(dataDir, 'direct-execution-jobs', `${admitted.jobId}.json`), before = await readFile(file);
  const damaged = await damagedHistory(api, dataDir), read = { ...client, scopes: ['read'] };
  await assert.rejects(api.call('blackice_cancel_job', { jobId: admitted.jobId }, undefined), { code: 'DIRECT_AUTH_REQUIRED' });
  await assert.rejects(api.call('blackice_cancel_job', { jobId: admitted.jobId }, { ...read, id: 'unrelated-owner' }), { code: 'DIRECT_JOB_STORAGE' });
  await assert.rejects(api.call('blackice_cancel_job', { jobId: `direct_${'0'.repeat(64)}` }, read), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal(signal.aborted, false);
  denyFallbackRead = true; readChecks = 0;
  await assert.rejects(api.call('blackice_cancel_job', { jobId: admitted.jobId }, read), { code: 'DIRECT_AUTH_REQUIRED' });
  assert.equal(signal.aborted, false, 'the current read grant is checked before signalling the owned executor');
  denyFallbackRead = false;
  const acknowledgement = await api.call('blackice_cancel_job', { jobId: admitted.jobId }, read);
  assert.deepEqual(acknowledgement, { jobId: admitted.jobId, cancellationRequested: true, settled: false, durable: false, detailsRestricted: true, storageUnavailable: true });
  assert.equal(signal.aborted, true); assert.deepEqual(await readFile(file), before);
  await assert.rejects(api.call('blackice_test_action', { requestId: 'no-storage-bypass' }, client), { code: 'DIRECT_JOB_STORAGE' });
  assert.equal((await api.revokeClient(client.id)).available, false);
  release.resolve(); await execution;
  assert.deepEqual(await readFile(file), before); assert.equal(await readFile(damaged.file, 'utf8'), damaged.bytes);
});

test('shutdown signals and drains active work after storage failure, retaining the lease until physical settlement', async t => {
  for (const failure of ['existing hydration latch', 'rename failure during cancellation']) await t.test(failure, async t => {
    const release = held(), started = held(), signals = []; t.after(() => release.resolve());
    const { api, dataDir } = await harness(t, { additionalTools: [customTool(async (_args, { signal }) => { signals.push(signal); if (signals.length === 2) started.resolve(); await release.promise; return toolReceipt({ complete: true }); })] });
    const first = await api.call('blackice_test_action', { requestId: 'shutdown-one' }, client), second = await api.call('blackice_test_action', { requestId: 'shutdown-two' }, client); await started.promise;
    const work = [...api.active.values()].map(value => value.settled), files = [first, second].map(value => path.join(dataDir, 'direct-execution-jobs', `${value.jobId}.json`));
    let damaged;
    if (failure === 'existing hydration latch') damaged = await damagedHistory(api, dataDir);
    else api.jobs.io = { ...api.jobs.io, rename: async (...args) => { await rename(...args); throw Object.assign(new Error('The receipt rename committed but its acknowledgement failed.'), { code: 'EIO' }); } };
    await assert.rejects(api.close({ timeoutMs: 30 }), { code: 'DIRECT_SHUTDOWN_UNCONFIRMED' });
    assert.equal(signals.every(signal => signal.aborted), true); assert.ok(api.jobs.storageError);
    assert.equal(api.jobs.hasLease, true); await readFile(api.jobs.leaseFile);
    const evidence = await Promise.all(files.map(file => readFile(file)));
    release.resolve(); await Promise.allSettled(work); await api.close();
    assert.equal(api.jobs.hasLease, false); await assert.rejects(readFile(api.jobs.leaseFile), { code: 'ENOENT' });
    for (let index = 0; index < files.length; index++) {
      assert.deepEqual(await readFile(files[index]), evidence[index]);
      const record = JSON.parse(evidence[index]); assert.equal(record.finishedAt, null); assert.equal(record.effects.possible, true);
    }
    if (damaged) assert.equal(await readFile(damaged.file, 'utf8'), damaged.bytes);
  });
});

test('direct browser grants receive stable task ownership and cannot target another grant page', async t => {
  const pages = [{ tabId: 'personal', browser: 'relay', url: 'https://example.test/personal', title: 'Personal' }], dispatched = [];
  const driver = {
    status: () => ({ available: true, contained: true, activeTab: 'personal', tabs: pages, folders: [] }),
    async perform(args, context) {
      dispatched.push({ args, owner: context.owner });
      if (args.action === 'open') { const page = { tabId: `grant-page-${pages.length}`, browser: 'relay', url: args.url, title: 'Source', owner: { ...context.owner } }; pages.push(page); return page; }
      return { ...pages.find(page => page.tabId === args.tabId), text: 'Observed source' };
    },
  };
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const { api } = await harness(t, { browser });
  const first = await api.call('blackice_browser_action', { requestId: 'owned-open', action: 'open', url: 'https://example.test/source' }, client);
  const done = await waitJob(api, first.jobId); assert.equal(done.status, 'succeeded');
  const page = JSON.parse(done.result.text.text), owner = dispatched[0].owner;
  assert.equal(owner.allowUserTabs, true); assert.equal(owner.nodeId, 'bridge');
  const read = await api.call('blackice_browser_read', { requestId: 'owned-read', action: 'read', tabId: page.tabId }, client);
  assert.equal((await waitJob(api, read.jobId)).status, 'succeeded'); assert.deepEqual(dispatched[1].owner, owner);
  const other = { ...client, id: 'another-grant' };
  await assert.rejects(api.call('blackice_browser_read', { requestId: 'foreign-read', action: 'read', tabId: page.tabId }, other), { code: 'BROWSER_TAB_OWNERSHIP' });
  assert.equal(dispatched.length, 2);
  const personal = await api.call('blackice_browser_read', { requestId: 'explicit-personal', action: 'read', tabId: 'personal' }, client);
  assert.equal((await waitJob(api, personal.jobId)).status, 'succeeded');
  const replay = await api.call('blackice_browser_action', { requestId: 'owned-open', action: 'open', url: 'https://example.test/source' }, client);
  assert.equal(replay.existing, true); assert.equal(replay.jobId, first.jobId); assert.equal(dispatched.length, 3);
});

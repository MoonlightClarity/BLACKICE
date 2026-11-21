import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { managedContextPaths } from '../lib/managed-context-paths.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { FilePatchStore } from '../lib/file-patches.mjs';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { HarnessEngine } from '../lib/engine.mjs';

const call = args => ({ name: 'relay_workspace', arguments: args });
const parse = result => JSON.parse(result.contentItems[0].text);
const client = { id: 'instruction-owner-fixture', kind: 'chatgpt', label: 'Fixture', scopes: ['read', 'files:read', 'files:write'] };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-instruction-protection-'));
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'project');
  await mkdir(dataDir); await mkdir(cwd);
  const cleanup = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, dataDir, cwd, cleanup };
}

function denied(result) {
  assert.equal(result.success, false);
  const body = parse(result);
  assert.equal(body.code, 'WORKSPACE_PROTECTED_PATH');
  assert.equal(body.actionDispatched, false);
}

async function waitJob(api, jobId) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const job = await api.getJob(jobId, client);
    if (job.settled) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Instruction protection fixture job did not settle.');
}

test('instruction protection follows the active store directory without reserving every same-basename project file', () => {
  const dataDir = path.resolve('instruction-fixture');
  const defaultPaths = managedContextPaths({ dataDir });
  assert.ok(defaultPaths.includes(path.join(dataDir, 'instructions')));
  assert.ok(!defaultPaths.includes(dataDir));
  const custom = path.resolve('instruction-fixture-custom');
  const paths = managedContextPaths({ dataDir, instructionSettings: { directory: custom } });
  assert.ok(paths.includes(custom));
  assert.ok(!paths.includes(path.join(dataDir, 'instructions')));
  assert.ok(!paths.includes(path.join(dataDir, 'instructions.json')));
});

test('model structured writes, patches and undo cannot mutate instruction snapshots, history, locks or staging files', async t => {
  const { dataDir, cwd, cleanup } = await fixture(t);
  const directory = path.join(dataDir, 'instructions');
  const patchStore = new FilePatchStore({ dataDir: path.join(dataDir, 'patches') });
  cleanup.push(() => patchStore.close());
  let admissions = 0;
  const handler = createWorkspaceToolHandler({ cwd, patchStore, protectedPaths: managedContextPaths({ dataDir }) });
  for (const relative of ['instructions.json', 'instructions.json.bak', 'versions/1.json', '.instructions-lock', 'instructions.json.12345678-1234-1234-1234-123456789abc.tmp']) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'owner content');
    for (const args of [{ action: 'write', path: target, text: 'model content' }, { action: 'patch', path: target, oldText: 'owner', newText: 'model' }]) {
      denied(await handler(call(args), { onOperationDispatch: () => { admissions++; } }));
    }
    const receipt = await patchStore.patch({ cwd, path: target, oldText: 'owner', newText: 'user' });
    denied(await handler(call({ action: 'undo_patch', patchId: receipt.id, path: 'unrelated-decoy.json' })));
    assert.equal(await readFile(target, 'utf8'), 'user content');
    assert.equal((await handler(call({ action: 'read', path: target }))).success, true);
  }
  assert.equal(admissions, 0);
  denied(await handler(call({ action: 'write', path: path.join(directory, 'future', 'new.json'), text: 'model content' })));
  assert.equal((await handler(call({ action: 'write', path: 'instructions.json', text: 'ordinary project file' }))).success, true);
  assert.equal((await handler(call({ action: 'write', path: path.join(dataDir, 'instructions-extra', 'notes.txt'), text: 'ordinary neighbor' }))).success, true);
});

test('instruction protection resolves directory aliases and absent descendants before dispatch', async t => {
  const { root, dataDir, cwd } = await fixture(t);
  const directory = path.join(dataDir, 'instructions'), alias = path.join(root, 'instruction-alias');
  await mkdir(directory);
  const target = path.join(directory, 'instructions.json');
  await writeFile(target, 'owner content');
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const handler = createWorkspaceToolHandler({ cwd, protectedPaths: managedContextPaths({ dataDir }) });
  denied(await handler(call({ action: 'write', path: path.join(alias, 'instructions.json'), text: 'changed' })));
  denied(await handler(call({ action: 'write', path: path.join(alias, 'future', 'new.json'), text: 'changed' })));
  const custom = createWorkspaceToolHandler({ cwd, protectedPaths: managedContextPaths({ dataDir, instructionSettings: { directory: alias } }) });
  denied(await custom(call({ action: 'write', path: target, text: 'changed' })));
  if (process.platform === 'win32') denied(await handler(call({ action: 'write', path: target.toUpperCase(), text: 'changed' })));
  assert.equal(await readFile(target, 'utf8'), 'owner content');
});

test('direct connector file authority cannot mutate default or configured instruction stores', async t => {
  const { root, cwd, cleanup } = await fixture(t);
  for (const custom of [false, true]) {
    const label = custom ? 'custom' : 'default';
    const dataDir = path.join(root, label);
    const directory = custom ? path.join(root, 'configured-instructions') : path.join(dataDir, 'instructions');
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, 'instructions.json');
    await writeFile(target, 'owner content');
    const patchStore = new FilePatchStore({ dataDir });
    cleanup.push(() => patchStore.close());
    const api = await new DirectExecutionAPI({ dataDir, allowedRoot: cwd, patchStore, ...(custom ? { managedStores: { instructionSettings: { directory } } } : {}) }).init();
    cleanup.push(() => api.close());
    const receipt = await patchStore.patch({ cwd, path: target, oldText: 'owner', newText: 'user' });
    const actions = [{ action: 'write', path: target, text: 'changed' }, { action: 'patch', path: target, oldText: 'user', newText: 'model' }, { action: 'undo_patch', patchId: receipt.id }];
    for (const [index, args] of actions.entries()) {
      const pending = await api.call('blackice_workspace_write', { requestId: label + '-deny-' + index, ...args }, client);
      const job = await waitJob(api, pending.jobId);
      assert.equal(job.status, 'failed');
      assert.equal(job.effects.possible, false);
      const body = JSON.parse(job.result.text.text);
      assert.equal(body.code, 'WORKSPACE_PROTECTED_PATH');
      assert.equal(body.actionDispatched, false);
    }
    assert.equal(await readFile(target, 'utf8'), 'user content');
    const read = await api.call('blackice_workspace_read', { requestId: label + '-read', action: 'read', path: target }, client);
    assert.equal((await waitJob(api, read.jobId)).status, 'succeeded');
  }
});

test('production engine applies instruction directory protection to its model file handler', async t => {
  const { dataDir, cwd, cleanup } = await fixture(t);
  const target = path.join(dataDir, 'instructions', 'versions', 'fixture.txt');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'owner content');
  let observed;
  class Runtime extends EventEmitter {
    store = { get: () => ({ baseUrl: 'https://api.example/v1' }) };
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture::remote', models: [{ id: 'fixture::remote', supportsTools: true }] }; }
    async runAgent(options) {
      observed = await options.onToolCall(call({ action: 'write', path: target, text: 'model content' }));
      return { output: 'Instruction write was blocked.', threadId: 'instruction-protection-fixture' };
    }
  }
  const engine = await new HarnessEngine({ runtime: new Runtime(), dataDir, defaultCwd: cwd }).init();
  cleanup.push(() => engine.close());
  engine.runtimeSettings = { get: () => ({ subagentsEnabled: false, executionGuardrails: false }) };
  const workflow = { name: 'Instruction guard', nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model: 'fixture::remote', prompt: 'Try the fixture write.' }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { planningMode: 'off' } };
  const run = engine.startRun({ workflow, input: { task: 'Fixture write', directoryMode: 'off' } });
  await engine.executions.get(run.id);
  assert.equal(engine.getRun(run.id).status, 'completed', engine.getRun(run.id).error);
  denied(observed);
  assert.equal(await readFile(target, 'utf8'), 'owner content');
});

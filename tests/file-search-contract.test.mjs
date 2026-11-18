import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FIND_FILES_TOOL, WORKSPACE_TOOL, createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { validateFileSearchCall } from '../lib/file-search-contract.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
const call = (args, name = 'relay_find_files') => ({ name, arguments: JSON.stringify(args) });
const payload = result => JSON.parse(result.contentItems[0].text);
const success = result => { assert.equal(result.success, true, JSON.stringify(result)); return payload(result); };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-find-contract-')), cwd = path.join(root, 'work'); await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, handler: createWorkspaceToolHandler({ cwd, fileSearchScope: randomUUID() }) };
}

test('find callable advertises one required query and exact host ranges without duplicate workspace find', () => {
  assert.equal(FIND_FILES_TOOL.name, 'relay_find_files');
  const s = FIND_FILES_TOOL.inputSchema;
  assert.deepEqual(s.required, ['query']); assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.query.minLength, 1); assert.equal(s.properties.query.maxLength, 256);
  assert.deepEqual([s.properties.limit.minimum, s.properties.limit.maximum], [1, 100]);
  assert.deepEqual([s.properties.timeoutMs.minimum, s.properties.timeoutMs.maximum], [100, 10000]);
  assert.deepEqual([s.properties.roots.minItems, s.properties.roots.maxItems], [1, 64]);
  assert.equal(s.properties.extensions.maxItems, 16);
  assert.equal(s.properties.depth, undefined); assert.equal(s.properties.action, undefined);
  assert.ok(!WORKSPACE_TOOL.inputSchema.properties.action.enum.includes('find'));
  for (const field of ['roots', 'match', 'extensions', 'cursor']) assert.equal(WORKSPACE_TOOL.inputSchema.properties[field], undefined);
  assert.deepEqual(WORKSPACE_TOOL.inputSchema.properties.depth.enum, [0, 1, 2, 3]);
});

test('advertised query requirement is enforced for missing, empty, whitespace, null and oversized values', async t => {
  const { cwd, handler } = await fixture(t);
  for (const args of [{ path: cwd }, { path: cwd, query: '' }, { path: cwd, query: '  ' }, { path: cwd, query: null }, { path: cwd, query: 'x'.repeat(257) }, { path: cwd, query: 'a\nb' }, { path: cwd, query: '\0' }]) {
    assert.throws(() => validateFileSearchCall(args), error => error.code === 'FILE_SEARCH_ARGUMENT_INVALID' && error.field === 'query');
    const result = await handler(call(args)); assert.equal(result.success, false);
    assert.equal(payload(result).code, 'FILE_SEARCH_ARGUMENT_INVALID'); assert.equal(payload(result).actionDispatched, false);
    assert.match(payload(result).error, /query/);
  }
});

test('unknown fields and invalid bounds produce field-specific errors before filesystem actions', async t => {
  const { cwd, handler } = await fixture(t);
  const cases = [
    ['pattern', { pattern: '*.txt' }], ['depth', { depth: 999 }], ['limit', { limit: 101 }],
    ['limit', { limit: 0 }], ['limit', { limit: 1.5 }], ['timeoutMs', { timeoutMs: 10001 }],
    ['timeoutMs', { timeoutMs: 99 }], ['roots', { roots: [] }], ['roots', { roots: Array(65).fill(cwd) }],
    ['match', { match: 'regex' }], ['caseSensitive', { caseSensitive: 'false' }],
  ];
  for (const [field, extra] of cases) {
    const args = { query: 'resume', ...extra };
    const result = await handler(call(args)); assert.equal(result.success, false, field);
    const error = payload(result); assert.equal(error.code, 'FILE_SEARCH_ARGUMENT_INVALID');
    assert.equal(error.actionDispatched, false); assert.match(error.error, new RegExp(field));
  }
});

test('query is required again for cursor continuation and correct repeated query uses same backend', async t => {
  const { cwd, handler } = await fixture(t);
  await Promise.all([1, 2, 3].map(i => writeFile(path.join(cwd, `resume-${i}.txt`), 'synthetic')));
  const first = success(await handler(call({ path: cwd, query: 'resume', limit: 1 })));
  assert.equal(first.matches.length, 1); assert.ok(first.cursor);
  const missing = await handler(call({ cursor: first.cursor, limit: 1 }));
  assert.equal(missing.success, false); assert.match(payload(missing).error, /query.*required/);
  const changed = await handler(call({ cursor: first.cursor, query: 'other', limit: 1 })); assert.equal(changed.success, false);
  const second = success(await handler(call({ cursor: first.cursor, query: 'resume', limit: 1 })));
  assert.equal(second.matches.length, 1); assert.notEqual(first.matches[0].path, second.matches[0].path);
  const backend = success(await handler(call({ action: 'find', path: cwd, query: 'resume', limit: 100 }, 'relay_workspace')));
  assert.equal(backend.matches.length, 3, 'legacy/direct action backend remains compatible without advertising duplicate native interface');
});

test('list depth errors identify the field and callable rather than a generic integer failure', async t => {
  const { handler } = await fixture(t);
  for (const depth of [-1, 4, 100, null, '3']) {
    const result = await handler(call({ action: 'list', depth }, 'relay_workspace'));
    assert.equal(result.success, false); const error = payload(result);
    assert.equal(error.code, 'WORKSPACE_DEPTH_INVALID'); assert.equal(error.actionDispatched, false);
    assert.match(error.error, /depth/); assert.match(error.error, /0, 1, 2 or 3/); assert.match(error.error, /relay_find_files/);
  }
});

test('main and delegated worker catalogs expose one narrow filename callable and route it read-only', async t => {
  const { root, cwd } = await fixture(t); await writeFile(path.join(cwd, 'resume.txt'), 'synthetic');
  let mainCalls = 0, workerCalls = 0;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture', models: [{ id: 'fixture', supportsTools: true }] }; }
    async runAgent(options) {
      const found = options.dynamicTools.filter(tool => tool.name === 'relay_find_files');
      assert.equal(found.length, 1); assert.deepEqual(found[0], FIND_FILES_TOOL);
      const workspace = options.dynamicTools.find(tool => tool.name === 'relay_workspace');
      assert.ok(workspace); assert.ok(!workspace.inputSchema.properties.action.enum.includes('find'));
      const result = success(await options.onToolCall(call({ path: cwd, query: 'resume' })));
      assert.equal(result.matches[0].path, path.join(cwd, 'resume.txt'));
      if (options.prompt.startsWith('You are a short-lived')) workerCalls++;
      else {
        mainCalls++;
        const obsolete = await options.onToolCall({ name: 'relay_delegate', arguments: { tasks: [{ id:'obsolete', prompt:'Find fixture files only.', canWrite:false }] } });
        assert.equal(obsolete.success, false, 'Removed worker arguments must reject before dispatch.');
        assert.equal(workerCalls, 0);
        const delegated = await options.onToolCall({ name: 'relay_delegate', arguments: { tasks: [
          { id: 'find-one', prompt: 'Inspect filename fixture only.' },
          { id: 'find-two', prompt: 'Independently inspect filename fixture only.' },
        ] } });
        assert.equal(delegated.success, true, JSON.stringify(delegated));
      }
      return { output: 'Inspected the synthetic filename fixture.', threadId: 'provider_find_contract' };
    }
    async close() {}
  }
  const engine = new HarnessEngine({ runtime: new Runtime(), dataDir: path.join(root, 'data'), defaultCwd: cwd });
  engine.runtimeSettings = { get: () => ({ subagentsEnabled: true, maxSubagents: 2 }) };
  await engine.init(); t.after(() => engine.close());
  const workflow = createMissionWorkflow({ id: 'find-contract', task: 'Find fixture files.', model: 'fixture', cwd, planningMode: 'off' });
  const run = engine.startRun({ workflow, input: 'Find the synthetic fixture.' }); await engine.executions.get(run.id);
  const saved = engine.getRun(run.id); assert.equal(saved.status, 'completed', saved.error || saved.nodes.agent?.error);
  assert.equal(mainCalls, 1); assert.equal(workerCalls, 2);
  assert.equal(await readFile(path.join(cwd,'resume.txt'),'utf8'),'synthetic');
  assert.deepEqual(await readdir(cwd),['resume.txt'],'Root and worker find calls do not create files.');
  await engine.close();
});


test('path fields reject whitespace-only and NUL values in the advertised schema and host validator', async t => {
  const { handler } = await fixture(t);
  for (const [field, extra] of [
    ['path', { path: '   ' }], ['path', { path: '\t\r\n' }], ['path', { path: '\0' }],
    ['roots[0]', { roots: ['  '] }], ['cwd', { cwd: '   ' }],
  ]) {
    const args = { query: 'resume', ...extra };
    assert.throws(() => validateFileSearchCall(args), error => error.code === 'FILE_SEARCH_ARGUMENT_INVALID' && error.field === field);
    const result = await handler(call(args)); assert.equal(result.success, false);
    assert.equal(payload(result).code, 'FILE_SEARCH_ARGUMENT_INVALID'); assert.equal(payload(result).actionDispatched, false);
  }
  const pattern = new RegExp(FIND_FILES_TOOL.inputSchema.properties.path.pattern, 'u');
  assert.equal(pattern.test('   '), false); assert.equal(pattern.test('\0'), false);
  assert.equal(pattern.test('Directory with spaces'), true);
});

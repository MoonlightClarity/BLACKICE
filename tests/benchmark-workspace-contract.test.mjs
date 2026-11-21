import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validDirectArguments } from '../lib/direct-execution-api.mjs';
import { normalizeBenchmarkProfile } from '../lib/benchmark-profile.mjs';
import { BENCHMARK_WORKSPACE_TOOL, createBenchmarkWorkspaceToolHandler } from '../lib/benchmark-workspace.mjs';
import { parseBenchmarkWorkspaceCall } from '../lib/benchmark-workspace-contract.mjs';
import { benchmarkFixture, workspaceCall, toolJSON, validSource } from './helpers/minicpm-benchmark-fixture.mjs';

const schema = BENCHMARK_WORKSPACE_TOOL.inputSchema;
const parse = args => parseBenchmarkWorkspaceCall(workspaceCall(args));
const minimum = [
  { action: 'list' },
  { action: 'read', path: 'METHOD.md' },
  { action: 'write', path: 'src/index.cjs', text: validSource },
  { action: 'patch', path: 'src/index.cjs', oldText: 'ok:', newText: '' },
  { action: 'run', command: 'node test-public.cjs' },
];

for (const args of minimum) test('published ' + args.action + ' schema and parser accept its minimal call', () => {
  assert.equal(validDirectArguments(args, schema), true);
  assert.deepEqual(parse(args), args);
  assert.deepEqual(parseBenchmarkWorkspaceCall({ name: 'relay_workspace', arguments: JSON.stringify(args) }), args);
});

test('optional fields and their valid boundaries survive without coercion or added defaults', () => {
  const cases = [
    { action: 'list', path: '.', depth: 3, limit: 300 },
    { action: 'read', path: 'METHOD.md', startLine: 200000, lineCount: 1500 },
    { action: 'write', path: 'src/index.cjs', text: '', expectedHash: 'a'.repeat(64) },
    { action: 'patch', path: 'src/index.cjs', oldText: 'x', newText: '', expectedHash: '0'.repeat(64) },
    { action: 'run', command: 'node test-public.cjs', timeoutMs: 100 },
  ];
  for (const args of cases) {
    const before = structuredClone(args);
    assert.equal(validDirectArguments(args, schema), true);
    assert.deepEqual(parse(args), before);
    assert.deepEqual(args, before);
  }
  assert.deepEqual(parse({ action: 'list' }), { action: 'list' });
});

test('fields from another action are rejected even when empty, and errors name the exact field', () => {
  const cases = [
    [{ action: 'list', command: '' }, 'command'],
    [{ action: 'read', path: 'METHOD.md', text: '' }, 'text'],
    [{ action: 'write', path: 'src/index.cjs', text: validSource, oldText: '' }, 'oldText'],
    [{ action: 'patch', path: 'src/index.cjs', oldText: 'ok:', newText: '', text: '' }, 'text'],
    [{ action: 'run', command: 'node test-public.cjs', path: '' }, 'path'],
    [{ action: 'run', command: 'node test-public.cjs', cwd: '' }, 'cwd'],
  ];
  for (const [args, field] of cases) {
    assert.equal(validDirectArguments(args, schema), false);
    assert.throws(() => parse(args), error => error.code === 'BENCHMARK_ARGUMENTS' &&
      error.message.includes('Action ' + args.action) &&
      error.message.includes(JSON.stringify(field)) &&
      error.message.includes('Allowed fields:') &&
      error.message.includes('Required fields:'));
  }
});

test('published action variants require every field that host parsing requires', () => {
  for (const args of minimum) {
    const variant = schema.oneOf.find(item => item.properties.action.const === args.action);
    const expected = Object.keys(args);
    assert.deepEqual(variant.required, expected);
    for (const field of expected.filter(key => key !== 'action')) {
      const missing = { ...args }; delete missing[field];
      assert.equal(validDirectArguments(missing, schema), false, args.action + '.' + field);
      assert.throws(() => parse(missing), error =>
        ['BENCHMARK_ARGUMENTS', 'BENCHMARK_PATH', 'BENCHMARK_COMMAND'].includes(error.code) &&
        error.message.includes(JSON.stringify(field)) && error.message.includes('required'));
    }
  }
});

test('wrong types, ranges, hashes and command text fail schema and host validation', () => {
  const cases = [
    { action: 'list', depth: -1 },
    { action: 'list', depth: 4 },
    { action: 'list', limit: 0 },
    { action: 'read', path: 'METHOD.md', startLine: 0 },
    { action: 'read', path: 'METHOD.md', lineCount: 1501 },
    { action: 'read', path: 'METHOD.md', lineCount: 1.5 },
    { action: 'read', path: 'METHOD.md', lineCount: '1' },
    { action: 'read', path: null },
    { action: 'write', path: 'src/index.cjs', text: null },
    { action: 'write', path: 'src/index.cjs', text: '', expectedHash: '' },
    { action: 'write', path: 'src/index.cjs', text: '', expectedHash: 'A'.repeat(64) },
    { action: 'patch', path: 'src/index.cjs', oldText: '', newText: 'x' },
    { action: 'patch', path: 'src/index.cjs', oldText: 'x', newText: null },
    { action: 'run', command: 'node test-public.cjs', timeoutMs: 99 },
    { action: 'run', command: 'node test-public.cjs', timeoutMs: 10001 },
    { action: 'run', command: 'node test-public.cjs', timeoutMs: null },
    { action: 'run', command: 'node test-public.cjs; echo extra' },
  ];
  for (const args of cases) {
    assert.equal(validDirectArguments(args, schema), false, JSON.stringify(args));
    assert.throws(() => parse(args));
  }
});

test('malformed JSON, unavailable tool namespaces and unknown actions stay rejected', () => {
  assert.throws(() => parseBenchmarkWorkspaceCall({ name: 'relay_workspace', arguments: '{' }), { code: 'BENCHMARK_ARGUMENTS' });
  assert.throws(() => parseBenchmarkWorkspaceCall({ name: 'relay_other', arguments: minimum[0] }), { code: 'BENCHMARK_TOOL_UNAVAILABLE' });
  assert.throws(() => parseBenchmarkWorkspaceCall({ name: 'relay_workspace', namespace: 'external', arguments: minimum[0] }), { code: 'BENCHMARK_TOOL_UNAVAILABLE' });
  for (const action of ['plan', 'constructor', '__proto__', 'missing']) {
    assert.equal(validDirectArguments({ action }, schema), false);
    assert.throws(() => parse({ action }), { code: 'BENCHMARK_ACTION' });
  }
});

test('action must be an own string discriminator, without property-key coercion', () => {
  for (const action of [['read'], ['run'], [], {}, null, 0, true]) {
    const args = { action, path: 'METHOD.md' };
    assert.equal(validDirectArguments(args, schema), false);
    assert.throws(() => parse(args), { code: 'BENCHMARK_ACTION' });
  }
  const inherited = Object.assign(Object.create({ action: 'run' }), { command: 'node test-public.cjs' });
  assert.equal(validDirectArguments(inherited, schema), false);
  assert.throws(() => parse(inherited), { code: 'BENCHMARK_ACTION' });
  assert.throws(() => parseBenchmarkWorkspaceCall({ name: 'relay_workspace', arguments: '{"action":["run"],"command":"node test-public.cjs"}' }), { code: 'BENCHMARK_ACTION' });
});

test('actual handler rejects mixed write/run fields before saving source or launching a process', async t => {
  const fixture = benchmarkFixture(t);
  const profile = normalizeBenchmarkProfile(fixture.request, { cwd: fixture.workspace });
  let starts = 0, dispatches = 0;
  const handler = createBenchmarkWorkspaceToolHandler({ profile, runProcess: async () => { starts++; throw Error('Unexpected process launch'); } });
  const sourcePath = path.join(fixture.workspace, 'src/index.cjs');
  const before = fs.readFileSync(sourcePath);
  for (const args of [
    { action: 'write', path: 'src/index.cjs', text: 'must-not-save', command: '' },
    { action: 'write', path: 'src/new.cjs', text: 'must-not-save', startLine: 1 },
    { action: 'run', command: 'node test-public.cjs', path: '' },
    { action: ['run'], command: 'node test-public.cjs' },
    { action: ['read'], path: 'METHOD.md' },
    Object.assign(Object.create({ action: 'run' }), { command: 'node test-public.cjs' }),
  ]) {
    const result = await handler(workspaceCall(args), { onOperationDispatch: () => { dispatches++; } });
    assert.equal(result.success, false);
    assert.equal(result.code, typeof args.action === 'string' && Object.hasOwn(args, 'action') ? 'BENCHMARK_ARGUMENTS' : 'BENCHMARK_ACTION');
    assert.equal(result.actionDispatched, false);
    assert.equal(toolJSON(result).actionDispatched, false);
    if (result.code === 'BENCHMARK_ARGUMENTS') assert.match(toolJSON(result).error, /Allowed fields:/);
  }
  assert.deepEqual(fs.readFileSync(sourcePath), before);
  assert.equal(fs.existsSync(path.join(fixture.workspace, 'src/new.cjs')), false);
  assert.equal(starts, 0);
  assert.equal(dispatches, 0);
});

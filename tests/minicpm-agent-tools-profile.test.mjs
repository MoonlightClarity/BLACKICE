import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BENCHMARK_PROFILE, BENCHMARK_AGENT_TOOLS_PROFILE, BENCHMARK_FILES, BENCHMARK_LIMITS,
  benchmarkRequest, normalizeBenchmarkProfile, assertBenchmarkExecutionOptions, assertBenchmarkIntegrity,
  isAgentToolsBenchmark, benchmarkHash, benchmarkContractHash,
} from '../lib/benchmark-profile.mjs';
import {
  BENCHMARK_WORKSPACE_INSTRUCTIONS, benchmarkWorkspaceInstructions, createBenchmarkWorkspaceToolHandler,
} from '../lib/benchmark-workspace.mjs';
import { benchmarkFixture, fixtureWorkflow, validSource, toolJSON, workspaceCall, readHashes } from './helpers/minicpm-benchmark-fixture.mjs';

const legacyInstructions = "\nBENCHMARK FILE CAPABILITY\nThis run uses the explicit minicpm-code-v1 benchmark profile. Only relay_directory_action and relay_workspace are attached. The benchmark workspace tool accepts task-relative paths with forward slashes; no absolute path, parent traversal, cwd override or outside discovery is available. Read the fixed task files and implementation. Change only .cjs files under src. Run exactly node test-public.cjs and inspect its actual exit status and report. General descriptions of unrestricted workspace access do not apply to this selected capability. The controller grades the saved source separately.\n";
const modes = { profile: BENCHMARK_AGENT_TOOLS_PROFILE, workflow: fixtureWorkflow,
  chatPlanning: 'on', directoryActions: 'on', pastChats: 'off', planningMode: 'off', directoryMode: 'off' };
function setup(t, options, handlerOptions = {}) {
  const f = benchmarkFixture(t, options);
  const request = { ...f.request, profile: BENCHMARK_AGENT_TOOLS_PROFILE };
  const profile = normalizeBenchmarkProfile(request, { cwd: f.workspace });
  const handler = createBenchmarkWorkspaceToolHandler({ profile, ...handlerOptions });
  return { ...f, request, profile, handler, call: args => handler(workspaceCall(args)) };
}
const denied = result => { assert.equal(result.success, false); assert.equal(result.actionDispatched, false); assert.equal(toolJSON(result).actionDispatched, false); };

test('v2 explicit identity binds the same frozen scaffold and limits to a distinct contract', t => {
  const f = benchmarkFixture(t);
  const legacy = normalizeBenchmarkProfile(f.request, { cwd: f.workspace });
  const request = { ...f.request, profile: BENCHMARK_AGENT_TOOLS_PROFILE };
  const profile = normalizeBenchmarkProfile(request, { cwd: f.workspace });
  assert.equal(BENCHMARK_PROFILE, 'minicpm-code-v1');
  assert.equal(BENCHMARK_AGENT_TOOLS_PROFILE, 'minicpm-agent-tools-v2');
  assert.deepEqual(benchmarkRequest(request), request);
  assert.equal(profile.schema, legacy.schema); assert.equal(profile.profile, BENCHMARK_AGENT_TOOLS_PROFILE);
  assert.deepEqual(profile.immutableFiles, legacy.immutableFiles);
  assert.deepEqual(Object.keys(profile.immutableFiles).sort(), [...BENCHMARK_FILES].sort());
  assert.deepEqual(profile.limits, BENCHMARK_LIMITS); assert.equal(profile.publicCaseCount, 2);
  assert.notEqual(profile.contractSha256, legacy.contractSha256);
  assert.equal(profile.contractSha256, benchmarkContractHash(profile));
  assert(Object.isFrozen(profile)); assert(Object.isFrozen(profile.immutableFiles)); assert(Object.isFrozen(profile.limits));
  assert.equal(assertBenchmarkIntegrity(profile).files.length, 1);
  assert(isAgentToolsBenchmark(profile)); assert(isAgentToolsBenchmark(BENCHMARK_AGENT_TOOLS_PROFILE));
  assert.equal(isAgentToolsBenchmark(legacy), false); assert.equal(isAgentToolsBenchmark(undefined), false);
  for (const value of [{ ...request, profile: 'other' }, { ...request, extra: true }, { ...request, scaffoldReceiptSha256: '0'.repeat(64) }])
    assert.throws(() => normalizeBenchmarkProfile(value, { cwd: f.workspace }));
});

test('v2 requires the actual UI toggles while keeping both retired modes explicitly off', () => {
  assertBenchmarkExecutionOptions(modes);
  assertBenchmarkExecutionOptions({ ...modes, profile: { profile: BENCHMARK_AGENT_TOOLS_PROFILE } });
  for (const changed of [
    { chatPlanning: 'off' }, { chatPlanning: undefined }, { directoryActions: 'off' }, { pastChats: 'on' },
    { planningMode: 'on' }, { planningMode: undefined }, { directoryMode: 'on' }, { directoryMode: undefined },
    { attachmentIds: ['file'] }, { goal: {} },
    { workflow: { ...fixtureWorkflow, nodes: [...fixtureWorkflow.nodes, { id: 'second', type: 'agent' }] } },
    { workflow: { ...fixtureWorkflow, planning: { shared: true } } },
    { workflow: { ...fixtureWorkflow, nodes: fixtureWorkflow.nodes.map(node => ({ ...node, assignment: {} })) } },
  ]) assert.throws(() => assertBenchmarkExecutionOptions({ ...modes, ...changed }), { code: 'BENCHMARK_RUN_SHAPE' });
  assert.throws(() => assertBenchmarkExecutionOptions({ ...modes, continuation: true }), { code: 'BENCHMARK_RESUME_UNSUPPORTED' });
  assert.throws(() => assertBenchmarkExecutionOptions({ ...modes, profile: 'other' }), { code: 'BENCHMARK_PROFILE_INVALID' });
});

test('v1 stays strict and preserves its original capability instructions byte for byte', () => {
  const legacy = { workflow: fixtureWorkflow, directoryActions: 'on', chatPlanning: 'off', pastChats: 'off' };
  assertBenchmarkExecutionOptions(legacy);
  assertBenchmarkExecutionOptions({ ...legacy, profile: BENCHMARK_PROFILE });
  for (const profile of [undefined, BENCHMARK_PROFILE, { profile: BENCHMARK_PROFILE }]) {
    assert.throws(() => assertBenchmarkExecutionOptions({ ...legacy, profile, chatPlanning: 'on' }), { code: 'BENCHMARK_RUN_SHAPE' });
    assert.equal(benchmarkWorkspaceInstructions(profile), legacyInstructions);
  }
  assert.equal(BENCHMARK_WORKSPACE_INSTRUCTIONS, legacyInstructions);
  assert(!legacyInstructions.includes('relay_code')); assert(!legacyInstructions.includes('relay_skills'));
});

test('v2 scoped saving, readback and public checks use the unchanged restricted worker', { timeout: 20000 }, async t => {
  const f = setup(t), before = readHashes(f), source = validSource + '// v2 saved-source proof\n';
  const saved = await f.call({ action: 'write', path: 'src/index.cjs', text: source, expectedHash: benchmarkHash(validSource) });
  assert.equal(saved.success, true); assert.equal(toolJSON(saved).readbackVerified, true);
  const read = toolJSON(await f.call({ action: 'read', path: 'src/index.cjs' }));
  assert.equal(read.sha256, benchmarkHash(source));
  const checked = await f.call({ action: 'run', command: 'node test-public.cjs' }), receipt = toolJSON(checked);
  assert.equal(checked.success, true, JSON.stringify(receipt));
  assert.equal(receipt.exitCode, 0); assert.equal(receipt.timedOut, false); assert.equal(receipt.shell, 'none');
  assert.equal(receipt.sourceSnapshotVerified, true);
  const report = JSON.parse(receipt.stdout);
  assert.equal(report.executedCases, 2); assert.equal(report.passedCases, 2); assert.equal(report.semanticPass, true);
  assert(report.child.args.includes('--permission')); assert(report.child.args.includes('--no-addons'));
  assert.deepEqual(readHashes(f), before);
});

test('v2 cannot read outside, alter fixtures or dispatch an alternate command', async t => {
  let starts = 0;
  const f = setup(t, undefined, { runProcess: async () => { starts++; throw Error('Unexpected process launch'); } });
  const before = readHashes(f), source = fs.readFileSync(path.join(f.workspace, 'src/index.cjs'));
  for (const file of ['../outside.cjs', f.canary, 'C:/outside.cjs', 'src/index.cjs:secret']) {
    denied(await f.call({ action: 'read', path: file }));
    denied(await f.call({ action: 'write', path: file, text: 'tamper' }));
  }
  for (const file of BENCHMARK_FILES) denied(await f.call({ action: 'write', path: file, text: 'tamper' }));
  denied(await f.call({ action: 'write', path: 'src/index.js', text: 'tamper' }));
  for (const extra of [{ command: 'node test-public.cjs; whoami' }, { cwd: f.root }, { env: {} }, { timeoutMs: 10001 }])
    denied(await f.call({ action: 'run', command: 'node test-public.cjs', ...extra }));
  denied(await f.handler({ name: 'relay_skills', arguments: { action: 'read', id: 'library-modular-development' } }));
  assert.equal(starts, 0); assert.deepEqual(readHashes(f), before);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'src/index.cjs')), source);
  assert.equal(fs.readFileSync(f.canary, 'utf8'), 'outside-private-canary\n');
});

test('v2 refuses symlink or hard-link aliases before any outside read or write', async t => {
  for (const kind of ['directory-link', 'hard-link']) {
    const f = setup(t);
    if (kind === 'directory-link') {
      const outside = path.join(f.root, 'other-attempt'); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.cjs'), 'private-other-attempt\n');
      fs.symlinkSync(outside, path.join(f.workspace, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
      denied(await f.call({ action: 'read', path: 'src/linked/secret.cjs' }));
      denied(await f.call({ action: 'write', path: 'src/linked/secret.cjs', text: 'tamper' }));
      assert.equal(fs.readFileSync(path.join(outside, 'secret.cjs'), 'utf8'), 'private-other-attempt\n');
    } else {
      fs.linkSync(f.canary, path.join(f.workspace, 'src/linked.cjs'));
      denied(await f.call({ action: 'read', path: 'src/linked.cjs' }));
      denied(await f.call({ action: 'write', path: 'src/linked.cjs', text: 'tamper' }));
      assert.equal(fs.readFileSync(f.canary, 'utf8'), 'outside-private-canary\n');
    }
  }
});

test('v2 contract, scaffold and controller-receipt drift fail before dispatch', async t => {
  const f = setup(t), before = fs.readFileSync(path.join(f.workspace, 'src/index.cjs'));
  assert.throws(() => createBenchmarkWorkspaceToolHandler({ profile: { ...f.profile, contractSha256: '0'.repeat(64) } }), { code: 'BENCHMARK_PROFILE_INVALID' });
  fs.writeFileSync(path.join(f.workspace, 'METHOD.md'), 'changed\n');
  const scaffold = await f.call({ action: 'write', path: 'src/index.cjs', text: 'tamper' });
  denied(scaffold); assert.equal(scaffold.code, 'BENCHMARK_SCAFFOLD_CHANGED');
  fs.writeFileSync(path.join(f.workspace, 'METHOD.md'), f.files['METHOD.md']); fs.appendFileSync(f.receiptPath, ' ');
  const receipt = await f.call({ action: 'run', command: 'node test-public.cjs' });
  denied(receipt); assert.equal(receipt.code, 'BENCHMARK_RECEIPT_CHANGED');
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'src/index.cjs')), before);
});

test('v2 instructions name its native tool surfaces without expanding the file boundary', () => {
  const text = benchmarkWorkspaceInstructions(BENCHMARK_AGENT_TOOLS_PROFILE);
  assert.equal(text, benchmarkWorkspaceInstructions({ profile: BENCHMARK_AGENT_TOOLS_PROFILE }));
  for (const name of ['relay_directory_action', 'relay_workspace', 'relay_code', 'relay_skills']) assert(text.includes(name));
  assert(text.includes('read-only relay_skills with search/read actions'));
  assert(text.includes('Chat Planning and Action Directory are on'));
  assert(text.includes('retired planningMode and directoryMode remain off'));
  assert(text.includes('only .cjs implementation files under src'));
  assert(text.includes('exactly node test-public.cjs'));
  assert.throws(() => benchmarkWorkspaceInstructions('unknown-profile'), { code: 'BENCHMARK_PROFILE_INVALID' });
});

import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore, TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';
import { readContractJournal } from '../lib/planning-contract-runtime.mjs';
import { describeHostOperation } from '../lib/operation-descriptors.mjs';

const payload = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const graph = () => ({ id: 'canonical-compatibility', name: 'Canonical compatibility',
  nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model: 'fixture::free', prompt: 'Complete the supplied task.' }, { id: 'output', type: 'output' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 } });

async function fixture(t, execute, { subagents = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-canonical-engine-'));
  const cwd = path.join(directory, 'workspace'); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'input.txt'), 'The actual fixture input.\n');
  await fs.writeFile(path.join(cwd, 'independent.txt'), 'The independent fixture input.\n');
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  let context;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture::free', models: [{ id: 'fixture::free', supportsTools: true }] }; }
    async runAgent(options) {
      const review = fixtureOutcomeReview(options); if (review) return review;
      options.onEvent?.({ type: 'thread', threadId: 'provider_fixture_compatibility', model: 'fixture::free', providerId: 'fixture' });
      const invoke = async (name, args) => {
        const call = { name, arguments: args, callId: randomUUID() };
        const result = await options.onToolCall(call, { signal: options.signal });
        await options.onToolResultDelivered?.({ call, result });
        return result;
      };
      return finishFixtureCandidate(options, await execute(options, { ...context, invoke }));
    }
    async close() {}
  }
  const engine = await new HarnessEngine({ runtime: new Runtime(), tasks, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ executionGuardrails: false, subagentsEnabled: subagents, maxSubagents: 2 }) };
  context = { engine, tasks, cwd, directory };
  t.after(async () => { await engine.close(); await tasks.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { ...context, async run(mode) {
    const accepted = engine.startRun({ workflow: graph(), input: 'Read the supplied input file and report its contents.', planningMode: mode });
    await engine.executions.get(accepted.id);
    return engine.getRun(accepted.id);
  } };
}

test('new production runs preserve optional schema 14 authoring and actual reads without claiming contract completion', async t => {
  assert.equal(TASK_SCHEMA_VERSION, 14);
  const calls = [];
  const f = await fixture(t, async (options, { cwd, invoke }) => {
    assert.ok(options.dynamicTools.find(tool => tool.name === 'relay_task').inputSchema.properties.contract);
    const send = async (name, args) => { calls.push([name, args.action]); const result = await invoke(name, args); assert.equal(result.success, true, JSON.stringify(result)); return result; };
    const state = payload(await send('relay_task', { action: 'read' }));
    const descriptor = await describeHostOperation({ name: 'relay_workspace', arguments: { action: 'read', path: 'input.txt' } }, { cwd });
    const resourceKey = descriptor.resources.find(resource => resource.key.startsWith('path:') && resource.scopeOnly !== true).key;
    const contract = { contractVersion: 2, goal: 'Read the supplied input file.',
      criteria: [{ id: 'read-input', kind: 'source-coverage', resourceKey, description: 'Read the complete current input file.' }],
      workItems: [{ id: 'inspect-input', title: 'Inspect input', objective: 'Read the current input file and report its contents.', owner: 'agent', resourceKeys: [resourceKey], effects: ['observe'], dependsOn: [], criterionIds: ['read-input'] }], instructions: [] };
    await send('relay_task', { action: 'plan', expectedRevision: state.revision, contract });
    await send('relay_workspace', { action: 'read', path: 'input.txt' });
    assert.equal(typeof options.onBeforeFinal, 'function');
    return { output: 'The actual fixture input.', threadId: 'provider_fixture_compatibility' };
  });
  const run = await f.run('forced');
  assert.equal(run.status, 'completed', run.error || run.nodes.agent.error);
  assert.equal(run.planningContractVersion, 14); assert.equal(run.planningEnforcement, undefined); assert.equal(run.planningMode, 'off');
  assert.equal(run.taskState.contract.planEpoch, 1);
  assert.deepEqual(calls, [['relay_task', 'read'], ['relay_task', 'plan'], ['relay_workspace', 'read']]);
  const journal = await readContractJournal(f.tasks, run.taskId);
  assert.equal(journal.records.length, 0);
  assert.equal(run.taskState.contractRuntime.criteria[0].satisfied, false, 'Manual authoring alone cannot certify the observed outcome.');
});

for (const mode of ['forced', 'advisory', 'off']) test('schema 14 treats ' + mode + ' as nonblocking during actual workspace dispatch', async t => {
  let receipt;
  const f = await fixture(t, async (_options, { invoke }) => {
    receipt = await invoke('relay_workspace', { action: 'write', path: 'mode-result.txt', text: 'The requested local write.' });
    return { output: receipt.success ? 'The file was written.' : 'The write was not dispatched.', threadId: 'provider_fixture_compatibility' };
  });
  const run = await f.run(mode);
  assert.equal(run.planningContractVersion, 14); assert.equal(run.planningEnforcement, undefined); assert.equal(run.planningMode, 'off');
  assert.equal(receipt.success, true, JSON.stringify(receipt));
  assert.equal(run.status, 'completed', run.error || run.nodes.agent.error);
  assert.equal(await fs.readFile(path.join(f.cwd, 'mode-result.txt'), 'utf8'), 'The requested local write.');
  const journal = await readContractJournal(f.tasks, run.taskId);
  assert.equal(journal.records.length, 0, 'Retired planning modes do not manufacture contract evidence.');
});

for (const mode of ['advisory', 'off']) test('schema 14 ' + mode + ' permits unplanned delegation while preserving read-only assignments', async t => {
  let childCalls = 0;
  const f = await fixture(t, async (options, { invoke }) => {
    if (options.dynamicTools.some(tool => tool.name === 'relay_delegate')) {
      const result = await invoke('relay_delegate', { tasks: [{ id: 'reader', readOnly: true, prompt: 'Read input.txt and report its actual contents.' }, { id: 'independent-reader', readOnly: true, prompt: 'Read independent.txt and report its actual contents.' }] });
      assert.equal(result.success, true, JSON.stringify(result));
      return { output: 'The delegated input read completed.', threadId: 'provider_fixture_parent' };
    }
    childCalls++;
    const denied = await invoke('relay_workspace', { action: 'write', path: 'forbidden.txt', text: 'This must not be written.' });
    assert.equal(denied.success, false); assert.match(JSON.stringify(denied), /read.only/i);
    const independent = options.prompt.includes('Read independent.txt');
    const read = await invoke('relay_workspace', { action: 'read', path: independent ? 'independent.txt' : 'input.txt' });
    assert.equal(read.success, true, JSON.stringify(read));
    assert.match(JSON.stringify(read), independent ? /The independent fixture input/ : /The actual fixture input/);
    return { output: 'The actual fixture input.', threadId: 'provider_fixture_child' };
  }, { subagents: true });
  const run = await f.run(mode);
  assert.equal(run.status, 'completed', run.error || run.nodes.agent.error);
  assert.equal(run.planningContractVersion, 14); assert.equal(childCalls, 2);
  await assert.rejects(fs.stat(path.join(f.cwd, 'forbidden.txt')), { code: 'ENOENT' });
  const journal = await readContractJournal(f.tasks, run.taskId);
  assert.equal(journal.records.length, 0, 'An optional plan is not an automatic evidence claim.');
});

test('schema 14 legacy Forced delegation preserves optional canonical owners without claiming completion', async t => {
  let childCalls = 0;
  const f = await fixture(t, async (options, { cwd, invoke }) => {
    const send = async (name, args) => { const result = await invoke(name, args); assert.equal(result.success, true, JSON.stringify(result)); return result; };
    if (!options.dynamicTools.some(tool => tool.name === 'relay_delegate')) {
      childCalls++;
      await send('relay_workspace', { action: 'read', path: options.prompt.includes('Read independent.txt') ? 'independent.txt' : 'input.txt' });
      return { output: 'The actual fixture input.', threadId: 'provider_fixture_child' };
    }
    const state = payload(await send('relay_task', { action: 'read' }));
    const descriptor = await describeHostOperation({ name: 'relay_workspace', arguments: { action: 'read', path: 'input.txt' } }, { cwd });
    const resourceKey = descriptor.resources.find(resource => resource.key.startsWith('path:') && resource.scopeOnly !== true).key;
    const independentDescriptor = await describeHostOperation({ name: 'relay_workspace', arguments: { action: 'read', path: 'independent.txt' } }, { cwd });
    const independentResourceKey = independentDescriptor.resources.find(resource => resource.key.startsWith('path:') && resource.scopeOnly !== true).key;
    const contract = { contractVersion: 2, goal: 'Delegate the two independent input reads and report them.',
      criteria: [
        { id: 'coordinate-read', kind: 'observation', resourceKey: 'tool:relay_delegate', description: 'Receive the actual delegated result.' },
        { id: 'read-input', kind: 'source-coverage', resourceKey, description: 'Read the complete current input file.' },
        { id: 'read-independent', kind: 'source-coverage', resourceKey: independentResourceKey, description: 'Read the complete independent input file.' }
      ],
      workItems: [
        { id: 'coordinate', title: 'Coordinate read', objective: 'Delegate and receive the input read.', owner: 'agent', resourceKeys: ['tool:relay_delegate'], effects: ['opaque'], dependsOn: [], criterionIds: ['coordinate-read'] },
        { id: 'inspect-input', title: 'Inspect input', objective: 'Read the current input file.', owner: 'agent', resourceKeys: [resourceKey], effects: ['observe'], dependsOn: [], criterionIds: ['read-input'] },
        { id: 'inspect-independent', title: 'Inspect independent input', objective: 'Read the independent input file.', owner: 'agent', resourceKeys: [independentResourceKey], effects: ['observe'], dependsOn: [], criterionIds: ['read-independent'] }
      ], instructions: [] };
    const accepted = payload(await send('relay_task', { action: 'plan', expectedRevision: state.revision, contract }));
    await send('relay_task', { action: 'focus', expectedPlanEpoch: accepted.contract.planEpoch, workItemId: 'coordinate' });
    await send('relay_delegate', { tasks: [{ id: 'reader', stepId: 'inspect-input', readOnly: true, prompt: 'Read input.txt and report its actual contents.' }, { id: 'independent-reader', stepId: 'inspect-independent', readOnly: true, prompt: 'Read independent.txt and report its actual contents.' }] });
    assert.equal(typeof options.onBeforeFinal, 'function');
    return { output: 'The actual fixture input.', threadId: 'provider_fixture_parent' };
  }, { subagents: true });
  const run = await f.run('forced');
  assert.equal(run.status, 'completed', run.error || run.nodes.agent.error);
  assert.equal(childCalls, 2);
  assert.equal(run.taskState.contract.planEpoch, 1);
  assert.equal(run.taskState.contract.workItems.find(item => item.id === 'inspect-input').owner, 'agent');
  assert.ok(run.taskState.contractRuntime.criteria.every(item => !item.satisfied));
  const journal = await readContractJournal(f.tasks, run.taskId);
  assert.equal(journal.records.length, 0);
});

test('schema 14 publishes optional material edits without falsely completing criteria after ordinary reads', async t => {
  let observed, revised;
  const f = await fixture(t, async (options, { cwd, engine, tasks, invoke }) => {
    const send = async (name, args) => { const result = await invoke(name, args); assert.equal(result.success, true, JSON.stringify(result)); return result; };
    const state = payload(await send('relay_task', { action: 'read' }));
    const descriptor = await describeHostOperation({ name: 'relay_workspace', arguments: { action: 'read', path: 'input.txt' } }, { cwd });
    const resourceKey = descriptor.resources.find(resource => resource.key.startsWith('path:') && resource.scopeOnly !== true).key;
    const contract = { contractVersion: 2, goal: 'Read the supplied input file.',
      criteria: [{ id: 'read-input', kind: 'source-coverage', resourceKey, description: 'Read the complete current input file.' }],
      workItems: [{ id: 'inspect-input', title: 'Inspect input', objective: 'Read and report the current input file.', owner: 'agent', resourceKeys: [resourceKey], effects: ['observe'], dependsOn: [], criterionIds: ['read-input'] }], instructions: [] };
    await send('relay_task', { action: 'plan', expectedRevision: state.revision, contract });
    await send('relay_workspace', { action: 'read', path: 'input.txt' });
    observed = { visible: engine.getRun(state.taskId).taskState, saved: await tasks.get(state.taskId) };
    const current = payload(await send('relay_task', { action: 'read' }));
    await send('relay_task', { action: 'plan', expectedRevision: current.revision, contract: { ...contract, goal: 'Read the supplied input file and report its actual contents.' } });
    revised = { visible: engine.getRun(state.taskId).taskState, saved: await tasks.get(state.taskId) };
    assert.equal(typeof options.onBeforeFinal, 'function');
    return { output: 'The actual fixture input.', threadId: 'provider_fixture_live_projection' };
  });
  const run = await f.run('forced');
  assert.equal(run.status, 'completed', run.error || run.nodes.agent.error);
  assert.equal(observed.saved.progress.done, 0);
  assert.deepEqual(observed.visible.contractRuntime, observed.saved.contractRuntime, 'Live canonical evidence must match the durable projection, including absence of proof.');
  assert.deepEqual(observed.visible.progress, observed.saved.progress, 'Optional authoring must not fabricate live completion after an ordinary read.');
  assert.deepEqual(observed.visible.availableWork, observed.saved.availableWork, 'Live work readiness must match the current evidence.');
  assert.equal(revised.saved.contract.planEpoch, 2);
  assert.deepEqual(revised.visible.contractRuntime, revised.saved.contractRuntime, 'Material edits must publish the re-evaluated journal projection immediately.');
  assert.deepEqual(revised.visible.progress, revised.saved.progress);
  assert.deepEqual(revised.visible.availableWork, revised.saved.availableWork);
});

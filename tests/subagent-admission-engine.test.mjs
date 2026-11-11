import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { createProviderExecutionContract } from '../lib/provider-execution-contract.mjs';

for (const scenario of [
  { name: 'remote default model', model: 'default', defaultModel: 'fixture::remote', endpoint: 'https://api.example/v1', allowed: true },
  { name: 'remote fc-prefixed DNS endpoint', model: 'fixture::remote', endpoint: 'https://fcloud.example/v1', allowed: true },
  { name: 'local endpoint for the default model', model: 'default', defaultModel: 'fixture::local', endpoint: 'http://127.0.0.1:1234/v1', allowed: false },
  { name: 'local IPv6 inference endpoint', model: 'fixture::local', endpoint: 'http://[fd12::1]/v1', allowed: false },
  { name: 'known local provider', model: 'ollama::fixture', allowed: false },
  { name: 'single configured remote worker slot', model: 'fixture::remote', maxSubagents: 1, allowed: false },
]) test('production engine applies static admission for ' + scenario.name, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-admission-engine-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  const calls = [], providerLookups = []; let receipt, catalog;
  const defaultModel = scenario.defaultModel || scenario.model;
  class Runtime extends EventEmitter {
    store = { get: id => { providerLookups.push(id); return { baseUrl: scenario.endpoint }; } };
    status() { return { connected: true, authenticated: true, defaultModel,
      models: [{ id: defaultModel, supportsTools: true }] }; }
    async runAgent(options) {
      calls.push(options);
      if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
        assert.ok(!options.dynamicTools?.some(tool => tool.name === 'relay_delegate'));
        return { output: 'Independent synthetic result.' };
      }
      catalog = options.dynamicTools.find(tool => tool.name === 'relay_delegate');
      assert.ok(catalog); assert.equal(catalog.inputSchema.properties.forecast, undefined);
      const value = await options.onToolCall({ name: 'relay_delegate', callId: 'parallel-batch',
        arguments: { tasks: [{ id: 'left', prompt: 'Inspect the synthetic left input.' },
          { id: 'right', prompt: 'Inspect the separate synthetic right input.' }] } });
      receipt = JSON.parse(value.contentItems[0].text);
      assert.equal(value.success, scenario.allowed, JSON.stringify(receipt));
      return { output: scenario.allowed ? 'Reviewed both independent results.' : 'Continue the work directly.' };
    }
  }
  const runtime = new Runtime();
  const engine = await new HarnessEngine({ runtime, dataDir: path.join(root, 'data'), defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ subagentsEnabled: true, maxSubagents: scenario.maxSubagents || 3, executionGuardrails: false }) };
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const run = engine.startRun({ input: 'Review two independent synthetic inputs.', planningMode: 'off', workflow: {
    name: 'Admission fixture', nodes: [{ id: 'input', type: 'input' },
      { id: 'agent', type: 'agent', model: scenario.model, prompt: 'Review the assigned inputs.' },
      { id: 'output', type: 'output' }],
    edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
    settings: { maxParallel: 2 },
  } });
  await engine.executions.get(run.id);
  const settled = engine.getRun(run.id);
  assert.equal(settled.status, 'completed', settled.error || settled.nodes.agent.error);
  assert.equal(calls.length, scenario.allowed ? 3 : 1, 'No forecast or speculative provider turn is started.');
  const admission = settled.events.find(event => event.data?.type === 'subagent.admission')?.data;
  assert.ok(admission); assert.equal(admission.allowed, scenario.allowed); assert.equal(admission.providerCalls, 0);
  assert.equal(admission.mode, 'static_dag');
  if (scenario.allowed) { assert.equal(receipt.completed, 2); assert.equal(receipt.maxParallel, 3); }
  else { assert.equal(receipt.code, 'SUBAGENT_NO_PARALLEL_CAPACITY'); assert.equal(receipt.providerCalls, 0); }
  if (scenario.endpoint) assert.ok(providerLookups.includes('fixture'), 'The selected provider endpoint is inspected.');
});

import { SUBAGENT_V4_TOOL, SUBAGENT_V5_TOOL, SUBAGENT_SCHEMA_VERSION, subagentToolForExecution } from '../lib/subagents.mjs';

for (const [version, savedTool] of [[4, SUBAGENT_V4_TOOL], [5, SUBAGENT_V5_TOOL]]) test('native continuation and Retry retain the exact saved v' + version + ' subagent catalog', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-admission-catalog-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd); const catalogs = [], calls = [];
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture' }; }
    async runAgent(options) {
      calls.push(options); catalogs.push(options.dynamicTools.find(tool => tool.name === 'relay_delegate'));
      options.onEvent({ type: 'thread', threadId: 'native-subagent-catalog-thread', model: 'fixture' });
      if (calls.length === 2) throw Error('Fixture interruption after the saved native catalog was opened.');
      return { output: 'The saved native catalog remains available.', threadId: 'native-subagent-catalog-thread' };
    }
  }
  const engine = await new HarnessEngine({ runtime: new Runtime(), dataDir: path.join(root, 'data'), defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ subagentsEnabled: true, maxSubagents: 3, executionGuardrails: false }) };
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const run = engine.startRun({ input: 'Inspect synthetic catalog compatibility.', planningMode: 'off', workflow: {
    name: 'Saved catalog fixture', nodes: [{ id: 'input', type: 'input' },
      { id: 'agent', type: 'agent', model: 'fixture', prompt: 'Inspect compatibility.' },
      { id: 'output', type: 'output' }],
    edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 },
  } });
  await engine.executions.get(run.id);
  assert.equal(engine.getRun(run.id).status, 'completed');
  assert.equal(engine.getRun(run.id).nodes.agent.subagentSchemaVersion, SUBAGENT_SCHEMA_VERSION);
  engine.runs.get(run.id).nodes.agent.subagentSchemaVersion = version;
  // A persisted canonical session records both catalog version fields.
  engine.runs.get(run.id).nodes.agent.taskSchemaVersion = 14;
  engine.runs.get(run.id).nodes.agent.providerExecutionContract = createProviderExecutionContract({
    planningContractVersion: 14, dynamicTools: calls[0].dynamicTools.map(tool => tool.name === 'relay_delegate'
      ? subagentToolForExecution(savedTool, { planningContractVersion: 14, schemaVersion: version }) : tool),
  });
  const continued = engine.continueRun(run.id, { nodeId: 'agent', message: 'Continue the original saved native conversation.' });
  await engine.executions.get(continued.id);
  const failed = engine.getRun(continued.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.nodes.agent.error, /Fixture interruption/);
  assert.equal(failed.nodes.agent.subagentSchemaVersion, version);
  const retry = engine.retryRun(continued.id); await engine.executions.get(retry.id);
  assert.equal(engine.getRun(retry.id).status, 'completed');
  assert.equal(engine.getRun(retry.id).nodes.agent.subagentSchemaVersion, version);
  const expected = subagentToolForExecution(savedTool, { planningContractVersion: 14, schemaVersion: version });
  assert.deepEqual(catalogs[1], expected); assert.deepEqual(catalogs[2], expected);
  assert.equal(calls[1].threadId, 'native-subagent-catalog-thread');
  assert.equal(calls[2].threadId, 'native-subagent-catalog-thread');
});

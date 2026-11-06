import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderExecutionContract, providerExecutionContractRequiresFreshSession, validateProviderExecutionContract } from '../lib/provider-execution-contract.mjs';
import { BROWSER_TOOL } from '../lib/browser.mjs';
import { WORKSPACE_TOOL } from '../lib/workspace-tools.mjs';
import path from 'node:path';
import { CodexRuntime } from '../lib/codex.mjs';
import { MistralVibeRuntime } from '../lib/mistral-vibe.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';

const tools = () => structuredClone([BROWSER_TOOL, WORKSPACE_TOOL]);
const contract = (dynamicTools = tools(), planningContractVersion = 14) => createProviderExecutionContract({ dynamicTools, planningContractVersion });

test('execution contract binds actual browser/workspace schemas and is independent of object key order', () => {
  const original = tools();
  const reordered = original.map(tool => Object.fromEntries(Object.entries(tool).reverse()));
  assert.deepEqual(contract(original), contract(reordered));
  assert.ok(Object.isFrozen(contract(original)));
  const changed = structuredClone(original);
  changed[0].inputSchema.properties.action.enum.push('unregistered_action');
  assert.notEqual(contract(changed).catalogHash, contract(original).catalogHash);
});

test('namespace, tool identity, schema and tool order changes require an explicit new session boundary', () => {
  const original = contract();
  for (const updated of [
    tools().reverse(),
    [{ type: 'namespace', name: 'private', tools: tools() }],
    tools().map((tool, index) => index ? tool : { ...tool, name: 'other_browser' }),
    tools().map((tool, index) => index ? tool : { ...tool, inputSchema: { type: 'object', properties: {} } }),
  ]) assert.equal(providerExecutionContractRequiresFreshSession(original, contract(updated)), true);
  assert.equal(providerExecutionContractRequiresFreshSession(original, contract(tools(), 15)), true);
});

test('same saved contract resumes, missing or malformed legacy metadata requires an explicit boundary for a new contract', () => {
  const current = contract();
  assert.equal(providerExecutionContractRequiresFreshSession(structuredClone(current), current), false);
  assert.equal(providerExecutionContractRequiresFreshSession(undefined, current), true);
  assert.equal(providerExecutionContractRequiresFreshSession({ version: 1 }, current), true);
  assert.equal(providerExecutionContractRequiresFreshSession(current, undefined), false);
  assert.equal(validateProviderExecutionContract({ dynamicTools: tools() }), undefined);
});

test('adapter validation rejects a mismatched catalog before a provider call and never grants authority from flags', () => {
  const current = contract();
  assert.deepEqual(validateProviderExecutionContract({ providerExecutionContract: current, dynamicTools: tools() }), current);
  assert.throws(() => validateProviderExecutionContract({ providerExecutionContract: current, dynamicTools: [] }), { code: 'PROVIDER_EXECUTION_CONTRACT_INVALID' });
  assert.throws(() => validateProviderExecutionContract({ providerExecutionContract: { ...current, readOnly: true }, dynamicTools: tools() }), { code: 'PROVIDER_EXECUTION_CONTRACT_INVALID' });
  assert.throws(() => validateProviderExecutionContract({ providerExecutionContract: current, dynamicTools: tools(), responseOnly: true }), { code: 'PROVIDER_EXECUTION_CONTRACT_INVALID' });
});

test('non-JSON catalogs and invalid planning versions are rejected without lossy hashing', () => {
  for (const dynamicTools of [null, {}, [{ bad: NaN }], [{ bad: () => {} }], [undefined]])
    assert.throws(() => createProviderExecutionContract({ dynamicTools, planningContractVersion: 14 }), { code: 'PROVIDER_EXECUTION_CONTRACT_INVALID' });
  for (const planningContractVersion of [undefined, 0, -1, 1.5, '14'])
    assert.throws(() => createProviderExecutionContract({ dynamicTools: [], planningContractVersion }), { code: 'PROVIDER_EXECUTION_CONTRACT_INVALID' });
});

test('a later caller mutation changes its contract without changing the earlier saved value', () => {
  const dynamicTools = tools(), saved = contract(dynamicTools), before = structuredClone(saved);
  dynamicTools[0].description += ' Changed.';
  assert.deepEqual(saved, before);
  assert.notEqual(contract(dynamicTools).catalogHash, saved.catalogHash);
});


test('each real provider entry rejects catalog substitution before transport or process startup', async () => {
  const options = { prompt: 'Inspect the task.', cwd: path.resolve('.'), dynamicTools: [], providerExecutionContract: contract() };
  const noStartup = new Proxy({}, { get(_target, key) { throw new Error('Unexpected runtime access before contract validation: ' + String(key)); } });
  for (const entry of [CodexRuntime.prototype._runAgent, MistralVibeRuntime.prototype.runAgent, ProviderRuntime.prototype.runAgent])
    await assert.rejects(entry.call(noStartup, options), { code: 'PROVIDER_EXECUTION_CONTRACT_INVALID' });
});

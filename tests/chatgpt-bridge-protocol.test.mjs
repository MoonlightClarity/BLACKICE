import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChatGPTBridgeRPC } from '../lib/chatgpt-bridge-protocol.mjs';
import { ChatGPTBridgeConnection } from '../lib/chatgpt-bridge-connection.mjs';

test('MCP initialization explains Chat Mode handoff and authorization reuse without changing completion annotations', async () => {
  const result = await handleChatGPTBridgeRPC({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
  assert.match(result.result.instructions, /ChatGPT Chat Mode with the configured connector/);
  assert.match(result.result.instructions, /read that ID with blackice_get_request/);
  assert.match(result.result.instructions, /Existing authorization covers repeats of those same steps/);
  assert.match(result.result.instructions, /exact missing capability and the work still pending/);
  assert.match(result.result.instructions, /blackice_complete_request using the current id and revision/);
  assert.doesNotMatch(result.result.instructions, /ask once before accessing|handing off to Work Mode/);
  const catalog = await handleChatGPTBridgeRPC({}, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const read = catalog.result.tools.find(tool => tool.name === 'blackice_get_request');
  const complete = catalog.result.tools.find(tool => tool.name === 'blackice_complete_request');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.deepEqual(complete.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test('connection instructions reflect the saved approval preference for either connection method', () => {
  let config = { revision: 3, connectorName: 'My installation', mode: 'connector', enabled: false, port: 8791, publicMcpUrl: '', approvalMode: 'reuse' };
  const settings = { get: () => structuredClone(config), status: () => ({ healthy: true, error: null, hasToken: false }) };
  const connection = new ChatGPTBridgeConnection({ settings, store: {}, localURL: () => 'http://127.0.0.1:4317', cliPath: '/apps/blackice/scripts/chatgpt-bridge.mjs', platform: 'linux' });
  for (const mode of ['connector', 'mcp']) {
    config = { ...config, mode, approvalMode: 'reuse' };
    const reused = connection.snapshot();
    assert.equal(reused.config.approvalMode, 'reuse'); assert.match(reused.setup.instructions, /Sending a handoff authorizes reading that exact request/);
    assert.match(reused.setup.instructions, /cannot bypass that confirmation/); assert.equal(reused.connection.listening, false);
    assert.match(reused.setup.instructions, /Keep the handoff in ChatGPT Chat Mode/);
    assert.match(reused.setup.instructions, /a rejected answer leaves the request pending/);
    config = { ...config, approvalMode: 'confirm' };
    const confirmed = connection.snapshot();
    assert.match(confirmed.setup.instructions, /current conversation for explicit approval of the same steps for that exact request/);
    assert.match(confirmed.setup.instructions, /Only when that approval is absent should ChatGPT ask once/);
    assert.doesNotMatch(confirmed.setup.instructions, /Sending a handoff authorizes/);
    assert.equal(confirmed.local.url, 'http://127.0.0.1:4317');
  }
});

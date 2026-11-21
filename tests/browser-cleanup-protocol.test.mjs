import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { ChatGPTConnector } from '../lib/chatgpt-connector.mjs';
import { BROWSER_TOOL } from '../lib/browser.mjs';
import * as cleanupPolicy from '../lib/browser-cleanup-policy.mjs';

const { BROWSER_CLEANUP_PROTOCOL } = cleanupPolicy;
// Frozen 2.40.73 external connector contract. Native delivery must not alter it.
const directProtocolSha256 = '43e6503cc34852dd6b619c731bb1a9b4bbac6e3688d2a748b767825939ab0fde';

test('direct cleanup protocol is byte-stable and delivered by MCP initialization and browser action metadata', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-cleanup-protocol-'));
  t.after(async () => { await api.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const api = new DirectExecutionAPI({ dataDir, allowedRoot: dataDir });
  const connector = await new ChatGPTConnector({
    dataDir, execution: api, planning: { tools: () => [], call: () => assert.fail('Discovery must not execute tools') },
    oauth: { setOrigin() {}, status: () => ({ grants: [] }), authenticateRequest: async () => ({ id: 'cleanup-fixture', scopes: ['read'] }) },
  }).init();
  connector.setOrigin('https://cleanup.example.test');
  await connector.setEnabled(true);
  const request = Readable.from([Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 'cleanup-initialize', method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cleanup-fixture', version: '1' } },
  }))]);
  Object.assign(request, { method: 'POST', url: '/mcp/chatgpt',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' } });
  let body = '', status;
  const response = { setHeader() {}, writeHead(value) { status = value; }, end(value = '') { body += value; } };
  await connector.handle(request, response);
  assert.equal(status, 200);
  const delivered = JSON.parse(body).result;
  assert.ok(delivered.instructions.includes(BROWSER_CLEANUP_PROTOCOL));
  const action = api.tools().find(tool => tool.name === 'blackice_browser_action');
  const exposed = connector.tools().find(tool => tool.name === action.name);
  assert.ok(action.description.endsWith(BROWSER_CLEANUP_PROTOCOL));
  assert.equal(exposed.description, action.description);
  assert.equal(createHash('sha256').update(BROWSER_CLEANUP_PROTOCOL).digest('hex'), directProtocolSha256);
  for (const required of ['record the baseline', 'exact tab IDs', 'connection-wide owner', 'personal/pre-existing', 'awaiting input', 'running downloads', 'unfinished forms', 'blackice_get_job', 'verify removal', 'already absent']) assert.ok(BROWSER_CLEANUP_PROTOCOL.includes(required), required);
});

test('native and direct browser cleanup share preservation rules with their own execution semantics', () => {
  const native = BROWSER_TOOL.description;
  assert.match(native, /BROWSER TAB CLEANUP:/);
  assert.equal(typeof cleanupPolicy.BROWSER_CLEANUP_BASELINE, 'string');
  assert.equal(typeof cleanupPolicy.BROWSER_CLEANUP_INVARIANTS, 'string');
  for (const shared of [cleanupPolicy.BROWSER_CLEANUP_BASELINE, cleanupPolicy.BROWSER_CLEANUP_INVARIANTS]) {
    assert.ok(BROWSER_CLEANUP_PROTOCOL.includes(shared));
    assert.ok(native.includes(shared));
  }
  assert.ok(native.endsWith(cleanupPolicy.NATIVE_BROWSER_CLEANUP_PROTOCOL));
  for (const required of ['incrementally', 'navigate', 'relay_browser', 'action:"close"', 'action:"tabs"', 'native tool result', 'verify removal', 'already absent', 'inUse', 'your own', 'personal/pre-existing', 'foreign', 'empty']) assert.ok(native.includes(required), required);
  assert.doesNotMatch(native, /blackice_browser_action|blackice_get_job/);
  assert.doesNotMatch(BROWSER_CLEANUP_PROTOCOL, /relay_browser|native tool result/);
});

test('host completion status reaches both worker and node browser finalizers', async () => {
  const engine = await readFile(new URL('../lib/engine.mjs', import.meta.url), 'utf8');
  assert.match(engine, /const handback = status === 'completed'/);
  assert.match(engine, /const retainedGoal = this\.goals\?\.retainsResources\(run\) === true/);
  assert.match(engine, /releaseOwner\(\{ taskId, runId: run.id, nodeId \}, \{ status: handback \? 'awaiting-user' : retainedGoal \? 'paused' : status, retainForContinuation: retainedGoal \|\| status === 'failed' \|\| status === 'cancelled' \}\)/);
  // Current workers release their exact owner and finish awareness even if cleanup fails.
  assert.match(engine, /const cleanupNodeId=delegatedPlanNodeId\(node.id, task.id\)/);
  assert.match(engine, /try \{ await releaseBrowserOwner\(cleanupNodeId, result.status\); \}/);
  assert.match(engine, /finally \{ this\.tasks\?\.awareness\?\.finish/);
  assert.match(engine, /releaseBrowserOwner\(node.id, cleanupStatus \|\| run.nodes\[node.id\]\?\.status\)/);
});

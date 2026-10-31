import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BROWSER_CLEANUP_PROTOCOL } from '../lib/browser-cleanup-policy.mjs';
test('direct cleanup protocol is exposed in both MCP instructions and browser action metadata', async () => {
  const connector = await readFile(new URL('../lib/chatgpt-connector.mjs', import.meta.url), 'utf8');
  const api = await readFile(new URL('../lib/direct-execution-api.mjs', import.meta.url), 'utf8');
  assert.match(connector, /\+ BROWSER_CLEANUP_PROTOCOL/);
  assert.match(api, /reconnect\.' \+ BROWSER_CLEANUP_PROTOCOL/);
  for (const required of ['record the baseline', 'exact tab IDs', 'connection-wide owner', 'personal/pre-existing', 'awaiting input', 'running downloads', 'unfinished forms', 'blackice_get_job', 'verify removal', 'already absent']) assert.ok(BROWSER_CLEANUP_PROTOCOL.includes(required), required);
});
test('host completion status reaches both worker and node browser finalizers', async () => {
  const engine = await readFile(new URL('../lib/engine.mjs', import.meta.url), 'utf8');
  assert.match(engine, /releaseOwner\(\{ taskId, runId: run.id, nodeId \}, \{ status \}\)/);
  assert.match(engine, /releaseBrowserOwner\(delegatedPlanNodeId\(node.id, task.id\), result.status\)/);
  assert.match(engine, /releaseBrowserOwner\(node.id, run.nodes\[node.id\]\?\.status\)/);
});

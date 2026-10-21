import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createWorkspaceToolHandler, WORKSPACE_TOOL } from '../lib/workspace-tools.mjs';
import { normalizeObserveEvent, observeTrace, createObserveFeed } from '../public/observe-model.mjs';
import { renderObserveCommand, renderObserveFeed } from '../public/observe-ui.mjs';

const at = '2026-10-16T14:00:00.000Z';
const event = item => ({ type: 'agent.event', runId: 'fixture-run', nodeId: 'agent', at, data: { type: 'item', item } });

test('native command receipts retain the current command and folder, and actual exit failures override completed status', () => {
  const started = event({ type: 'commandExecution', id: 'native-command', command: 'npm test', cwd: 'C:\\fixture\\project', status: 'inProgress' });
  const running = normalizeObserveEvent(started);
  assert.equal(running.detail, 'npm test'); assert.equal(running.command.line, 'npm test'); assert.equal(running.command.cwd, 'C:\\fixture\\project'); assert.equal(running.status, 'running');
  assert.match(renderObserveCommand(running), /Output appears when the command finishes/); assert.ok(!renderObserveCommand(running).includes('Exit 0'));
  const completed = event({ type: 'commandExecution', id: 'native-command', status: 'completed', exitCode: 7, aggregatedOutput: 'Actual test failure <svg onload=bad>\n' });
  const rows = observeTrace({ events: [started, completed] }); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'failed'); assert.equal(rows[0].command.exitCode, 7); assert.equal(rows[0].command.line, 'npm test'); assert.equal(rows[0].command.cwd, 'C:\\fixture\\project');
  const html = renderObserveFeed(rows);
  assert.match(html, /Command output · Exit 7/); assert.match(html, /npm test/); assert.match(html, /&lt;svg onload=bad&gt;/); assert.ok(!html.includes('<svg onload=bad>')); assert.ok(!html.includes('data-observe-output="agent:native-command" open'));
  assert.match(renderObserveFeed(rows, { openOutputs: new Set(['agent:native-command']) }), /data-observe-output="agent:native-command" open/);
});

test('workspace command results show bounded actual stdout/stderr and failure even when the tool envelope claims success', () => {
  const item = { type: 'dynamicToolCall', id: 'gateway-command', tool: 'relay_workspace', arguments: JSON.stringify({ action: 'run', command: 'npm test' }), status: 'completed', success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ cwd: '/fixture', exitCode: 2, stdout: '\u001b[32mActual output\u001b[0m\n' + 'x'.repeat(20000), stderr: 'Actual error\n' + 'e'.repeat(9000), timedOut: false }) }] };
  const row = normalizeObserveEvent(event(item));
  assert.equal(row.status, 'failed'); assert.equal(row.command.exitCode, 2); assert.equal(row.command.stdout.length, 12000); assert.equal(row.command.stderr.length, 6000); assert.equal(row.command.truncated, true); assert.ok(!row.command.stdout.includes('\u001b'));
  const rendered = renderObserveCommand(row); assert.match(rendered, /Actual output/); assert.match(rendered, /Actual error/); assert.match(rendered, /Output preview shortened/);
  const timeout = normalizeObserveEvent(event({ ...item, contentItems: [{ type: 'inputText', text: JSON.stringify({ exitCode: 0, timedOut: true, stdout: '' }) }] }));
  assert.equal(timeout.status, 'failed'); assert.match(renderObserveCommand(timeout), /Timed out/);
  const unrelated = normalizeObserveEvent(event({ ...item, name: 'relay_files', tool: undefined, arguments: { action: 'read' } })); assert.equal(unrelated.command, undefined); assert.ok(!JSON.stringify(unrelated).includes('Actual output'));
});

test('live command feed reconciles receipts without preloading output and releases command buffers on reset', () => {
  const feed = createObserveFeed(); feed.reset('fixture-run');
  assert.deepEqual(feed.snapshot().entries, []);
  feed.event(event({ type: 'dynamicToolCall', id: 'cmd', tool: 'relay_workspace', arguments: { action: 'run', command: 'npm test' }, status: 'inProgress' }));
  feed.event(event({ type: 'dynamicToolCall', id: 'cmd', tool: 'relay_workspace', arguments: { action: 'run', command: 'npm test' }, status: 'completed', success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ exitCode: 0, stdout: 'Actual passing check\n', stderr: '', cwd: '/fixture' }) }] }));
  const entries = feed.snapshot().entries; assert.equal(entries.length, 1); assert.equal(entries[0].command.exitCode, 0); assert.match(renderObserveFeed(entries), /Actual passing check/);
  feed.reset(); assert.deepEqual(feed.snapshot().entries, []); assert.ok(!JSON.stringify(feed.snapshot()).includes('Actual passing check'));
});

test('an actual provider tool turn preserves redacted command arguments at start/completion and exposes its real shell result', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-observe-command-')), secret = 'fixture-provider-key-command-redaction';
  const command = (process.platform === 'win32' ? "Write-Output 'Actual stdout <svg>';[Console]::Error.WriteLine('Actual stderr');exit 7" : "printf 'Actual stdout <svg>\\n'; printf 'Actual stderr\\n' >&2; exit 7") + ` # ${secret}`;
  const args = { action: 'run', command, cwd: directory }, events = []; let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { /* Drain only this fixture request. */ }
    const body = ++requests === 1 ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'command-call', type: 'function', function: { name: 'relay_workspace', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] } : { choices: [{ message: { role: 'assistant', content: 'The fixture command returned a verified failure.' }, finish_reason: 'stop' }] };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  class Codex extends EventEmitter { status() { return { connected: true, models: [] }; } async close() {} }
  const runtime = await new ProviderRuntime({ codex: new Codex(), dataDir: directory }).init();
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.match(path.basename(directory), /^relay-observe-command-/); await rm(directory, { recursive: true, force: true }); });
  await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: secret, models: ['fixture-model'] });
  const handler = createWorkspaceToolHandler({ cwd: directory });
  await runtime.runAgent({ cwd: directory, prompt: 'Run the isolated fixture command.', model: 'fixture::fixture-model', dynamicTools: [WORKSPACE_TOOL], onToolCall: handler, onEvent: data => events.push({ type: 'agent.event', runId: 'fixture-run', nodeId: 'agent', at, data }) });
  const calls = events.filter(entry => entry.data.item?.type === 'dynamicToolCall'); assert.equal(calls.length, 2);
  for (const call of calls) { const actual = JSON.parse(call.data.item.arguments); assert.equal(actual.action, 'run'); assert.equal(actual.cwd, directory); assert.equal(actual.command, command.replace(secret, '[redacted]')); }
  assert.ok(!JSON.stringify(events).includes(secret));
  const started = normalizeObserveEvent(calls[0]), completed = normalizeObserveEvent(calls[1]);
  assert.equal(started.status, 'running'); assert.match(started.command.line, /Actual stdout/); assert.equal(completed.status, 'failed'); assert.equal(completed.command.exitCode, 7); assert.equal(completed.command.cwd, directory); assert.match(completed.command.stdout, /Actual stdout <svg>/); assert.match(completed.command.stderr, /Actual stderr/); assert.match(renderObserveCommand(completed), /Exit 7/);
});

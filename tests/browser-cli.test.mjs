import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserCLIRequest, desktopBrowserArgs, executeBrowserCLI, parseBrowserArgs, runBrowserCLI } from '../lib/browser-cli.mjs';

test('browser commands are recognized before desktop startup and mutations need a stable ID', () => {
  assert.deepEqual(desktopBrowserArgs(['BLACKICE.exe', 'browser', 'profiles']), ['browser', 'profiles']);
  assert.equal(desktopBrowserArgs(['BLACKICE.exe', '--restart']), null);
  assert.deepEqual(desktopBrowserArgs(['electron', 'app', 'browser', 'connections'], { packaged: false }), ['browser', 'connections']);
  assert.deepEqual(parseBrowserArgs(['browser', 'connect-chrome', '--request-id=connect-1']), { command: 'connect-chrome', 'request-id': 'connect-1' });
  for (const args of [['browser', 'connect-chrome'], ['browser', 'call', '--connection=chrome-live', '--tool=click', '--arguments-file=x.json'], ['browser', 'profiles', '--source=arbitrary'], ['browser', 'tools', '--connection=x', '--connection=y']]) assert.throws(() => parseBrowserArgs(args), { code: 'BROWSER_CLI_ARGUMENTS' });
});

test('call arguments are JSON data and exact request IDs reach the shared tool', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-browser-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'args.json'), args = { text: 'A literal $(value), `quote`, and newline\n', uid: '4_2' };
  await writeFile(file, JSON.stringify(args));
  const options = parseBrowserArgs(['browser', 'call', '--connection=chrome-live', '--tool=fill', '--arguments-file=' + file, '--request-id=fill-once']);
  assert.deepEqual(await browserCLIRequest(options), { tool: 'blackice_connected_browser_action', arguments: { requestId: 'fill-once', action: 'call', connectionId: 'chrome-live', name: 'fill', arguments: args } });
  await writeFile(file, '[]'); await assert.rejects(browserCLIRequest(options), { code: 'BROWSER_CLI_INPUT' });
});

test('CLI admits once then reads the same durable job without repeating an uncertain website action', async () => {
  const calls = [], jobId = 'direct_' + 'a'.repeat(64); let polls = 0;
  const options = parseBrowserArgs(['browser', 'connect-chrome', '--request-id=connect-once']);
  const result = await executeBrowserCLI(options, { pollMs: 0, connect: async () => ({ request: async (route, value) => {
    calls.push({ route, value });
    if (value) return { jobId, status: 'queued' };
    return { jobId, status: ++polls > 1 ? 'succeeded' : 'running', result: { success: true } };
  } }) });
  assert.equal(result.status, 'succeeded'); assert.equal(calls.filter(item => item.value).length, 1);
  assert.deepEqual(calls.slice(1).map(item => item.route), Array(2).fill('/api/browser/commands/' + jobId));
  assert.equal(calls[0].value.arguments.requestId, 'connect-once');
});

test('a running job remains pending, and explicit job inspection never submits', async () => {
  const jobId = 'direct_' + 'b'.repeat(64), calls = [], context = { waitMs: 0, connect: async () => ({ request: async (route, value) => { calls.push({ route, value }); return { jobId, status: 'running' }; } }) };
  const pending = await executeBrowserCLI(parseBrowserArgs(['browser', 'connect-chrome', '--request-id=pending']), context);
  assert.equal(pending.status, 'running'); assert.equal(calls.length, 1);
  calls.length = 0; await executeBrowserCLI(parseBrowserArgs(['browser', 'job', '--job-id=' + jobId]), context);
  assert.deepEqual(calls, [{ route: '/api/browser/commands/' + jobId, value: undefined }]);
});

test('CLI retrieves every saved result page without repeating the browser action', async () => {
  const jobId = 'direct_' + 'c'.repeat(64), calls = [];
  const result = await executeBrowserCLI(parseBrowserArgs(['browser', 'job', '--job-id=' + jobId]), { connect: async () => ({ request: async route => {
    calls.push(route); const second = route.endsWith('?offset=5');
    return { jobId, revision: 3, status: 'succeeded', result: { text: { text: second ? 'world' : 'hello', offset: second ? 5 : 0, nextOffset: second ? null : 5, totalCharacters: 10 } } };
  } }) });
  assert.equal(result.result.text.text, 'helloworld'); assert.equal(result.result.text.nextOffset, null); assert.equal(calls.length, 2);
});

test('profile commands use returned source/import identities and do not accept arbitrary inline executable options', async () => {
  assert.deepEqual(await browserCLIRequest(parseBrowserArgs(['browser', 'import-profile', '--source=browser-profile-a', '--request-id=copy-a'])), { tool: 'blackice_profile_import', arguments: { requestId: 'copy-a', sourceId: 'browser-profile-a' } });
  assert.deepEqual(await browserCLIRequest(parseBrowserArgs(['browser', 'connect-profile', '--import=browser-profile-a', '--request-id=connect-a'])), { tool: 'blackice_profile_connect', arguments: { requestId: 'connect-a', importId: 'browser-profile-a' } });
  assert.throws(() => parseBrowserArgs(['browser', 'profiles', '--executable=other.exe']), { code: 'BROWSER_CLI_ARGUMENTS' });
});

test('help and failed commands return truthful exit status without launching the desktop', async () => {
  let output = '', error = ''; const context = { stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } } };
  assert.equal(await runBrowserCLI(['browser', '--help'], context), 0); assert.match(output, /same browser connections/); assert.equal(error, '');
  assert.equal(await runBrowserCLI(['browser', 'connect-chrome'], context), 1); assert.match(error, /request-id/);
});

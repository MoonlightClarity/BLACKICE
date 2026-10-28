import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI, DIRECT_EXECUTION_SCOPES } from '../lib/direct-execution-api.mjs';
import { createDirectConnectedBrowserTools, createDirectBrowserProfileTools } from '../lib/connected-browser-tools.mjs';
import { BrowserProfileStore } from '../lib/browser-profile.mjs';

const client = { id: 'native-browser-grant', label: 'ChatGPT', scopes: [...DIRECT_EXECUTION_SCOPES] };
const success = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
async function fixture(t, additionalTools) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-native-tools-')), cwd = path.join(dir, 'work'); await mkdir(cwd);
  const api = await new DirectExecutionAPI({ dataDir: path.join(dir, 'data'), allowedRoot: cwd, additionalTools }).init();
  t.after(async () => { await api.close(); await rm(dir, { recursive: true, force: true }); }); return api;
}
async function settled(api, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const job = await api.getJob(id, client); if (job.settled || job.status === 'awaiting_input') return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Native browser job did not settle.');
}

test('ChatGPT native browser calls run with no contained browser and retry one saved receipt', async t => {
  const calls = [], manager = {};
  const api = await fixture(t, createDirectConnectedBrowserTools({ manager, execute: async args => { calls.push(args); return success({ browser: 'chrome', session: 'existing' }); } }));
  const request = { requestId: 'native-call-once', action: 'call', connectionId: 'chrome-live', name: 'fill', arguments: { uid: '1_2', value: 'private form input' } };
  const first = await api.call('blackice_connected_browser_action', request, client), done = await settled(api, first.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(calls.length, 1); assert.equal(calls[0].manager, manager); assert.equal(calls[0].arguments.value, 'private form input');
  const repeated = await api.call('blackice_connected_browser_action', request, client); assert.equal(repeated.existing, true); assert.equal(repeated.jobId, first.jobId); assert.equal(calls.length, 1);
  const stored = await api.jobs.get(first.jobId); assert.equal(stored.arguments.argumentsOmitted, true); assert.equal(JSON.stringify(stored.arguments).includes('private form input'), false);
  await assert.rejects(api.call('blackice_connected_browser_action', { ...request, arguments: { uid: '1_2', value: 'different' } }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
});

test('native discovery works for the existing browser read grant and keeps mutation scope checks', async t => {
  const calls = [], api = await fixture(t, createDirectConnectedBrowserTools({ manager: {}, execute: async args => { calls.push(args); return success({ connections: [] }); } }));
  const reader = { ...client, scopes: ['read', 'browser:read'] };
  const first = await api.call('blackice_connected_browser_read', { requestId: 'native-list', action: 'connections' }, reader);
  await settled(api, first.jobId); assert.equal(calls[0].action, 'connections');
  await assert.rejects(api.call('blackice_connected_browser_action', { requestId: 'native-connect', action: 'connect_chrome' }, reader), { code: 'DIRECT_SCOPE_REQUIRED' });
});

test('profile import records the completed copy without implying a working login or starting a model', async t => {
  let copies = 0, refreshes = 0;
  const profiles = { discover: async () => ({ sources: [{ id: 'source-one' }], imports: [] }), import: async ({ sourceId }) => { copies++; return { id: sourceId, authentication: 'unverified', filesCopied: 42 }; } };
  const api = await fixture(t, createDirectBrowserProfileTools({ profiles, manager: {}, onChange: async () => { refreshes++; } }));
  const request = { requestId: 'profile-copy-once', sourceId: 'source-one' };
  const job = await api.call('blackice_profile_import', request, client), done = await settled(api, job.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(copies, 1); assert.equal(refreshes, 1);
  assert.equal(JSON.parse(done.result.text.text).authentication, 'unverified');
  await api.call('blackice_profile_import', request, client); assert.equal(copies, 1);
});

test('profile connection launches its production configuration and verifies native tool response', async () => {
  const events = [], config = { id: 'browser-profile-1234', transport: 'stdio', command: 'npx', args: ['chrome-devtools-mcp', '--userDataDir=C:\\copied-profile'] };
  const tools = createDirectBrowserProfileTools({ profiles: { connection: async id => { assert.equal(id, config.id); return config; } }, manager: {
    list: () => [], save: async value => { events.push(['save', value]); }, connect: async id => { events.push(['connect', id]); }, call: async (id, name, args) => { events.push(['call', id, name, args]); return { content: [{ type: 'text', text: 'One fixture page' }] }; },
  } });
  const result = await tools.find(tool => tool.definition.name === 'blackice_profile_connect').execute({ importId: config.id });
  assert.equal(result.success, true); assert.equal(events[2][2], 'list_pages');
  const value = JSON.parse(result.contentItems[0].text); assert.equal(value.connected, true); assert.equal(value.accountAuthenticated, 'unknown');
});

test('profile connection preserves conflicting or disabled settings and never treats an empty response as connected', async () => {
  const config = { id: 'browser-profile-1234567890abcdef', transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--userDataDir=/imports/snapshots/browser-profile-1234567890abcdef-11111111-1111-1111-1111-111111111111/user-data'] };
  let saves = 0, connections = 0;
  const manager = { list: () => [{ ...config, command: 'custom-tool' }], save: async () => { saves++; }, connect: async () => { connections++; }, call: async () => ({ content: [] }) };
  const execute = createDirectBrowserProfileTools({ profiles: { connection: async () => config }, manager }).find(tool => tool.definition.name === 'blackice_profile_connect').execute;
  await assert.rejects(execute({ importId: config.id }), { code: 'BROWSER_PROFILE_CONNECTION_CONFLICT' });
  manager.list = () => [{ ...config, enabled: false }];
  await assert.rejects(execute({ importId: config.id }), { code: 'BROWSER_PROFILE_CONNECTION_DISABLED' });
  assert.equal(saves, 0); assert.equal(connections, 0);
  manager.list = () => [config];
  await assert.rejects(execute({ importId: config.id }), { code: 'BROWSER_PROFILE_CONNECTION_UNVERIFIED' });
  assert.equal(connections, 1);
});

test('managed imported profile vision upgrade preserves an active connection and rejects custom vision settings', async () => {
  const config={id:'browser-profile-1234567890abcdef',transport:'stdio',command:'npx',args:['-y','chrome-devtools-mcp@1.11.0','--userDataDir=C:/copied','--experimentalVision=true']};
  let current={...config,connected:true,args:config.args.filter(arg=>arg!=='--experimentalVision=true')}, saves=0, connects=0;
  const manager={list:()=>[current],save:async value=>{current=value;saves++;},connect:async()=>{connects++;},call:async()=>({content:[{type:'text',text:'Fixture'}]})};
  const connect=createDirectBrowserProfileTools({profiles:{connection:async()=>config},manager}).find(tool=>tool.definition.name==='blackice_profile_connect').execute;
  await assert.rejects(connect({importId:config.id}),{code:'BROWSER_PROFILE_CONNECTION_ACTIVE'});
  assert.equal(saves,0); assert.equal(connects,0);
  current.connected=false; await connect({importId:config.id}); assert.equal(saves,1); assert.equal(connects,1);
  current={...config,args:config.args.map(arg=>arg==='--experimentalVision=true'?'--experimentalVision=false':arg)};
  await assert.rejects(connect({importId:config.id}),{code:'BROWSER_PROFILE_CONNECTION_CONFLICT'});
});

test('reimported compact profiles reconnect from an older owned revision without adopting another profile', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-profile-reconnect-'));
  const userDataDir = path.join(root, 'source'), executablePath = path.join(root, 'synthetic-browser');
  await mkdir(path.join(userDataDir, 'Profile 2'), { recursive: true }); await mkdir(path.join(userDataDir, 'Default'));
  await writeFile(executablePath, 'synthetic executable; never launched');
  await writeFile(path.join(userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Selected' }, Default: { name: 'Other' } } } }));
  await writeFile(path.join(userDataDir, 'Profile 2', 'Preferences'), '{}'); await writeFile(path.join(userDataDir, 'Default', 'Preferences'), '{}');
  const profiles = await new BrowserProfileStore({ dataDir: path.join(root, 'data') }).init();
  t.after(async () => { await profiles.close(); await rm(root, { recursive: true, force: true }); });
  const input = { browser: 'chrome', userDataDir, executablePath, profileDirectory: 'Profile 2' };
  let configured, saves = 0, connects = 0;
  const manager = { list: () => configured ? [configured] : [], save: async value => { configured = value; saves++; }, connect: async () => { connects++; }, call: async () => ({ content: [{ type: 'text', text: 'Verified fixture page' }] }) };
  const connect = createDirectBrowserProfileTools({ profiles, manager }).find(tool => tool.definition.name === 'blackice_profile_connect').execute;
  const first = await profiles.import(input); await connect({ importId: first.id });
  assert.ok(configured.args.includes('--userDataDir=' + first.userDataDir));
  configured = { ...configured, args: configured.args.map(arg => arg === 'chrome-devtools-mcp@1.11.0' ? 'chrome-devtools-mcp@latest' : arg) };
  await connect({ importId: first.id });
  assert.equal(configured.args[1], 'chrome-devtools-mcp@1.11.0'); assert.equal(saves, 2); assert.equal(connects, 2);
  configured = { ...configured, args: configured.args.map(arg => arg === 'chrome-devtools-mcp@1.11.0' ? 'chrome-devtools-mcp@latest' : arg) };
  await profiles.import(input); // A refresh need not have been connected.
  const latest = await profiles.import(input); await connect({ importId: first.id });
  assert.ok(configured.args.includes('--userDataDir=' + latest.userDataDir)); assert.equal(configured.args[1], 'chrome-devtools-mcp@1.11.0'); assert.equal(saves, 3); assert.equal(connects, 3);
  const expected = configured;
  for (const args of [expected.args.map(arg => arg === 'chrome-devtools-mcp@1.11.0' ? 'chrome-devtools-mcp@1.12.0' : arg), [...expected.args, '--browserUrl=http://localhost:9222']]) {
    configured = { ...expected, args };
    await assert.rejects(connect({ importId: first.id }), { code: 'BROWSER_PROFILE_CONNECTION_CONFLICT' });
  }
  configured = expected;
  const other = await profiles.import({ ...input, profileDirectory: 'Default' });
  configured = { ...configured, args: configured.args.map(arg => arg.startsWith('--userDataDir=') ? '--userDataDir=' + other.userDataDir : arg) };
  await assert.rejects(connect({ importId: first.id }), { code: 'BROWSER_PROFILE_CONNECTION_CONFLICT' });
  assert.equal(saves, 3); assert.equal(connects, 3);
});

test('host-owned tool time budgets cancel actual work and unlimited profile work remains explicitly cancellable', async t => {
  const make = (name, timeoutMs) => ({ definition: { name, scope: 'files:write', inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false } }, timeoutMs,
    execute: async (_args, { signal }) => { await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); return success({ aborted: true }); },
  });
  const api = await fixture(t, [make('blackice_test_short_budget', 15), make('blackice_test_profile_copy', null)]);
  const short = await api.call('blackice_test_short_budget', { requestId: 'short-budget' }, client);
  assert.equal((await settled(api, short.jobId)).status, 'cancelled');
  const copy = await api.call('blackice_test_profile_copy', { requestId: 'copy-with-cancel' }, client);
  for (let n = 0; n < 100 && (await api.getJob(copy.jobId, client)).status !== 'running'; n++) await new Promise(resolve => setTimeout(resolve, 2));
  await api.cancel(copy.jobId, { ownerId: client.id }); assert.equal((await settled(api, copy.jobId)).status, 'cancelled');
});

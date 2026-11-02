import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {CodexRuntime} from '../lib/codex.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const continuityFixture = fileURLToPath(new URL('./fixtures/persistent-history-app-server.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));
function runtime(t, flags = [], overrides = {}) {
  const client = new CodexRuntime({isolatedHistory: true, command: process.execPath,
    args: [fixture, ...flags], cwd, nativeModelMetadata: false, requestTimeoutMs: 5000, runTimeoutMs: 8000, ...overrides});
  const requests = [], request = client._request.bind(client);
  client._request = (method, params = {}, ...rest) => { requests.push({method, params: structuredClone(params)}); return request(method, params, ...rest); };
  t.after(() => client.close()); return {client, requests};
}

test('BLACKICE isolated runtime keeps Chat, worker and learning turns ephemeral despite legacy persistent requests', async t => {
  const {client, requests} = runtime(t), events = [];
  assert.equal(client.isolatedHistory, true); assert.equal(client.status().isolatedHistory, true);
  assert.throws(() => { client.isolatedHistory = false; }, TypeError);
  const results = await Promise.all(['Chat user turn', 'Delegated BLACKICE worker', 'Relay post-task learning reviewer'].map(prompt =>
    client.runAgent({cwd, prompt, codexHistory: 'codex', onEvent: event => events.push(event)})));
  assert.ok(results.every(result => result.codexHistory === 'relay'));
  assert.ok(results.every((result, index) => result.output.includes(['Chat user turn', 'Delegated BLACKICE worker', 'Relay post-task learning reviewer'][index])));
  assert.ok(events.filter(event => event.type === 'thread').every(event => event.codexHistory === 'relay'));
  const starts = requests.filter(request => request.method === 'thread/start');
  assert.equal(starts.length, 3); assert.ok(starts.every(request => request.params.ephemeral === true));
  assert.ok(starts.every(request => request.params.config['features.multi_agent'] === false && request.params.config['features.multi_agent_v2'] === false));
  assert.ok(starts.every(request => request.params.config['features.shell_tool'] === undefined), 'Do not disable ordinary authorized execution tools.');
  assert.equal(requests.filter(request => request.method === 'experimentalFeature/list' && request.params.threadId).length, 3, 'Confirm each actual thread applied native spawning restrictions before its turn.');
  assert.equal(requests.filter(request => request.method === 'turn/start').length, 3);
  assert.equal(requests.filter(request => request.method === 'thread/resume').length, 0);
  assert.equal(client.contexts.size, 0, 'Released ephemeral provider IDs are never retained as durable checkpoints.');
  const stored = await client._request('fixture/threadState');
  assert.deepEqual(stored.threads, [], 'Completion releases every private fixture thread instead of keeping a sidebar entry.');
});

for (const flag of ['--no-ephemeral', '--omit-ephemeral']) test(`unsupported private thread acknowledgement fails before any user turn (${flag})`, async t => {
  const {client, requests} = runtime(t, [flag]);
  await assert.rejects(client.runAgent({cwd, prompt: 'Never send this user task to stored Codex history.', codexHistory: 'codex'}), {code: 'CODEX_HISTORY_UNSUPPORTED'});
  assert.equal(requests.filter(request => request.method === 'thread/start').length, 1);
  assert.equal(requests.filter(request => request.method === 'turn/start').length, 0);
  assert.equal(requests.filter(request => ['thread/archive', 'thread/delete'].includes(request.method)).length, 0, 'No existing user history is removed.');
  assert.equal(client.contexts.size, 0);
  assert.equal(client.modelAccess.size, 0, 'A local history boundary failure does not disprove model access.');
});

for (const flag of ['--no-native-agent-control', '--ignore-native-agent-control']) test(`private native spawn control must be supported and actually disabled (${flag})`, async t => {
  const {client, requests} = runtime(t, [flag]);
  await assert.rejects(client.runAgent({cwd, prompt: 'No unowned native child sessions.'}), {code: 'CODEX_HISTORY_UNSUPPORTED'});
  assert.equal(requests.filter(request => request.method === 'turn/start').length, 0);
  assert.equal(client.contexts.size, 0); assert.equal(client.modelAccess.size, 0);
});

test('private history cannot resume old sidebar threads or report an ephemeral native checkpoint as durable', async t => {
  const {client, requests} = runtime(t);
  await assert.rejects(client.runAgent({cwd, prompt: 'Continue the saved BLACKICE conversation.', threadId: 'old-shared-codex-thread'}), {code: 'CODEX_PRIVATE_THREAD_RESTART_REQUIRED'});
  await assert.rejects(client.compactThread('old-shared-codex-thread'), {code: 'CODEX_PRIVATE_COMPACTION_UNAVAILABLE'});
  await assert.rejects(client.compactHistory({cwd, continuity: {text: 'Original conversation remains in the BLACKICE archive.'}}), {code: 'CODEX_PRIVATE_COMPACTION_UNAVAILABLE'});
  assert.deepEqual(requests, [], 'Rejected resume/compression does not touch the old rollout or start model work.');
  assert.equal(client.child, null);
});

test('generic persistent library integration remains explicit and separate from BLACKICE app isolation', async t => {
  const {client, requests} = runtime(t, [], {isolatedHistory: false});
  const first = await client.runAgent({cwd, prompt: 'Generic persistent library task.'});
  const continued = await client.runAgent({cwd, prompt: 'READ_PRIOR', threadId: first.threadId});
  assert.equal(first.codexHistory, 'codex'); assert.equal(continued.threadId, first.threadId);
  assert.match(continued.output, /Generic persistent library task/);
  assert.equal(requests.find(request => request.method === 'thread/start').params.ephemeral, undefined);
  assert.ok(requests.some(request => request.method === 'thread/resume'));
  assert.equal(requests.some(request => request.method === 'experimentalFeature/list'), false, 'Generic library feature behavior is unchanged.');
});

test('private provider failure releases its temporary context without changing another conversation', async t => {
  const {client, requests} = runtime(t);
  await assert.rejects(client.runAgent({cwd, prompt: 'FAIL_TURN'}), /Deliberate fixture failure/);
  const next = await client.runAgent({cwd, prompt: 'Independent private next task.'});
  assert.match(next.output, /Independent private next task/); assert.equal(next.codexHistory, 'relay');
  assert.ok(requests.filter(request => request.method === 'thread/start').every(request => request.params.ephemeral === true));
  assert.equal(client.contexts.size, 0); assert.equal(client.status().activeTurns, 0);
});

test('automatic saved-history preparation injects and compresses inside one private session before its only task turn', async t => {
  const {client, requests} = runtime(t, [], {args: [continuityFixture]}), events = [];
  const history = 'SAVED_PRIVATE_BEGIN\n' + 'Confirmed result 7; preserve this fact and its uncertainty.\n'.repeat(700) + 'SAVED_PRIVATE_END';
  const result = await client.runAgent({cwd, prompt: 'Continue this BLACKICE conversation once.', codexHistory: 'codex',
    context: {preset: 'custom', windowTokens: 8192, outputReserveTokens: 512, headroomTokens: 256},
    continuity: {text: history}, onEvent: event => events.push(event)});
  const detail = JSON.parse(result.output), starts = requests.filter(request => request.method === 'thread/start');
  const imports = requests.filter(request => request.method === 'thread/inject_items');
  const compactions = requests.filter(request => request.method === 'thread/compact/start');
  assert.equal(starts.length, 1); assert.equal(starts[0].params.ephemeral, true);
  assert.ok(imports.length > 1); assert.equal(compactions.length, imports.length);
  assert.equal(requests.filter(request => request.method === 'turn/start').length, 1, 'Historical text cannot execute an extra user task.');
  assert.equal(requests.filter(request => request.method === 'thread/resume').length, 0);
  assert.match(detail.savedText, /SAVED_PRIVATE_BEGIN/); assert.match(detail.savedText, /SAVED_PRIVATE_END/);
  assert.equal(detail.compactions, imports.length); assert.equal(result.codexHistory, 'relay');
  assert.equal(events.filter(event => event.type === 'thread').length, 1, 'Partially prepared context is not exposed as a resumable thread.');
  assert.equal(client.contexts.size, 0, 'The private checkpoint expires with this response.');
});

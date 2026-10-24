import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EMAIL_SCHEMA_VERSION, EMAIL_TOOL, EMAIL_INSTRUCTIONS, LEGACY_EMAIL_TOOL, LEGACY_EMAIL_INSTRUCTIONS, emailToolForVersion, emailInstructionsForVersion, createEmailToolHandler } from '../lib/email-tools.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { readOnlyToolDenial } from '../lib/worker-permissions.mjs';
import { createHarnessServer } from '../server.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const payload = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const call = (options, args, context) => options.onToolCall({ name: 'relay_email', arguments: args }, context);
const composeInput = () => ({ requestId: 'compose-fixture', from: 'sender@example.invalid', to: ['recipient@example.invalid'], cc: ['copy@example.invalid'], bcc: ['private@example.invalid'], subject: 'Synthetic résumé ✓', body: 'Exact fixture content\nNo actual email is sent.', attachments: [path.resolve('fixture attachment.pdf')] });
const prepared = () => ({ id: 'email_fixture', requestId: 'compose-fixture', state: 'prepared', sent: false, messageId: '<fixture@example.invalid>', messageSha256: 'a'.repeat(64), attachments: [{ fileName: 'fixture attachment.pdf', size: 8, sha256: 'b'.repeat(64) }] });
function fakeStore() {
  const calls = [], store = {
    calls,
    status: () => ({ available: true, capabilities: { compose: true, send: true } }),
    snapshot: () => ({ config: {}, drafts: [], deliveries: [prepared()], capabilities: { compose: true, send: true } }),
    async compose(input, options) { calls.push({ action: 'compose', input, signal: options?.signal }); return { ...prepared(), ...input }; },
    async send(input, options) { calls.push({ action: 'send', input, signal: options?.signal }); return { ...prepared(), state: 'sent', sent: true, transportAccepted: true, recipientAcknowledged: false }; },
    getDelivery(id) { calls.push({ action: 'get_delivery', id }); return prepared(); },
    listDeliveries() { calls.push({ action: 'deliveries' }); return [prepared()]; },
    listDrafts: () => [],
    async close() {},
  };
  return store;
}

test('email v1 schema and instructions retain exact pre-sending bytes', () => {
  assert.equal(hash(JSON.stringify(LEGACY_EMAIL_TOOL)), 'e05ea1d8409d310dab6110a1332a9459466dd6ee610c11c8f4e78e28731daa27');
  assert.equal(hash(LEGACY_EMAIL_INSTRUCTIONS), '364cc13a2b05661600913fb00023a36f019b54f54ecf6aa5ae32e920ac7d1d46');
  assert.equal(emailToolForVersion(1), LEGACY_EMAIL_TOOL); assert.equal(emailInstructionsForVersion(1), LEGACY_EMAIL_INSTRUCTIONS);
  assert.equal(EMAIL_SCHEMA_VERSION, 2); assert.equal(emailToolForVersion(), EMAIL_TOOL); assert.equal(emailInstructionsForVersion(), EMAIL_INSTRUCTIONS);
  assert.ok(EMAIL_TOOL.inputSchema.properties.action.enum.includes('send')); assert.ok(!Object.hasOwn(EMAIL_TOOL.inputSchema.properties, 'confirmSend'));
  assert.doesNotMatch(EMAIL_INSTRUCTIONS, /provides no sending capability|read-only Gmail|Sending is not implemented/);
});

test('v2 composes exact structured attachments and sends directly with stable request IDs', async () => {
  const store = fakeStore(), signal = new AbortController().signal, handler = createEmailToolHandler({ store, signal });
  const input = composeInput(), compose = await handler({ name: 'relay_email', arguments: JSON.stringify({ action: 'compose', ...input }) });
  assert.equal(compose.success, true); assert.equal(payload(compose).state, 'prepared'); assert.equal(payload(compose).sent, false);
  assert.deepEqual(store.calls[0].input, input); assert.equal(store.calls[0].signal, signal);
  const request = { id: payload(compose).id, requestId: 'send-fixture' }, sent = await handler({ name: 'relay_email', arguments: { action: 'send', ...request } });
  assert.equal(sent.success, true); assert.equal(payload(sent).transportAccepted, true); assert.equal(payload(sent).recipientAcknowledged, false);
  assert.deepEqual(store.calls[1].input, request); assert.equal(store.calls[1].signal, signal); assert.deepEqual(store.calls.map(value => value.action), ['compose', 'send']);
});

test('v2 refuses ignored send fields and v1 never dispatches new sending actions', async () => {
  const store = fakeStore(), handler = createEmailToolHandler({ store }), legacy = createEmailToolHandler({ store, schemaVersion: 1 });
  for (const args of [{ action: 'send', id: 'email_fixture', requestId: 'send-fixture', body: 'Replacement content must not be ignored.' }, { action: 'send', id: 'email_fixture', requestId: 'send-fixture', confirmSend: true }, { action: 'deliveries', to: ['ignored@example.invalid'] }]) assert.equal((await handler({ name: 'relay_email', arguments: args })).success, false);
  for (const action of ['compose', 'send', 'deliveries', 'get_delivery']) assert.equal((await legacy({ name: 'relay_email', arguments: { action } })).success, false);
  assert.deepEqual(store.calls, []);
});

test('uncertain transport outcomes remain failed send receipts and can be inspected without another dispatch', async () => {
  const store = fakeStore(); store.send = async (input, options) => { store.calls.push({ action: 'send', input, signal: options.signal }); return { ...prepared(), state: 'uncertain', sent: false, error: { code: 'EMAIL_SEND_UNCERTAIN', message: 'The sending result is unknown. Inspect the saved delivery before further action.' } }; };
  store.getDelivery = id => { store.calls.push({ action: 'get_delivery', id }); return { ...prepared(), state: 'uncertain', sent: false }; };
  const handler = createEmailToolHandler({ store }), response = await handler({ name: 'relay_email', arguments: { action: 'send', id: 'email_fixture', requestId: 'send-fixture' } });
  assert.equal(response.success, false); assert.equal(payload(response).state, 'uncertain'); assert.equal(payload(response).error.code, 'EMAIL_SEND_UNCERTAIN');
  const observed = await handler({ name: 'relay_email', arguments: { action: 'get_delivery', id: 'email_fixture' } }); assert.equal(observed.success, true); assert.equal(payload(observed).sent, false);
  const listed = await handler({ name: 'relay_email', arguments: { action: 'deliveries' } }); assert.equal(listed.success, true); assert.ok(Array.isArray(payload(listed).deliveries));
  assert.equal(store.calls.filter(value => value.action === 'send').length, 1);
  const aborted = new AbortController(); aborted.abort(); const cancelled = await handler({ name: 'relay_email', arguments: { action: 'send', id: 'email_fixture', requestId: 'send-new' } }, { signal: aborted.signal });
  assert.equal(cancelled.success, false); assert.equal(payload(cancelled).code, 'ABORT_ERR'); assert.equal(store.calls.filter(value => value.action === 'send').length, 1);
});

test('explicit reviewers can read delivery records while compose and send remain task write effects', () => {
  for (const action of ['deliveries', 'get_delivery']) assert.equal(readOnlyToolDenial({ name: 'relay_email', arguments: { action } }, false), null);
  for (const action of ['compose', 'send']) { assert.equal(readOnlyToolDenial({ name: 'relay_email', arguments: { action } }, false).code, 'TASK_PLAN_READ_ONLY'); assert.equal(readOnlyToolDenial({ name: 'relay_email', arguments: { action } }, true), null); }
});

test('a valid deferred CLI result remains queued and unsent without another send', async () => {
  const store = fakeStore(); store.send = async input => { store.calls.push({ action: 'send', input }); return { ...prepared(), state: 'queued', sent: false, transportAccepted: false, recipientAcknowledged: false, delivery: { queueId: 'queue-fixture' } }; };
  const response = await createEmailToolHandler({ store })({ name: 'relay_email', arguments: { action: 'send', id: 'email_fixture', requestId: 'send-queued' } });
  assert.equal(response.success, true); assert.equal(payload(response).state, 'queued'); assert.equal(payload(response).sent, false); assert.equal(payload(response).transportAccepted, false); assert.equal(payload(response).delivery.queueId, 'queue-fixture'); assert.equal(store.calls.length, 1);
  assert.match(EMAIL_INSTRUCTIONS, /do not resubmit a queued message/);
});

async function engineFixture(t, execute, { threadId = 'email-native-thread', workers = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-email-engine-')), cwd = path.join(root, 'workspace'); await mkdir(cwd);
  const email = fakeStore();
  class Runtime extends EventEmitter {
    constructor() { super(); this.calls = []; }
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture', models: [{ id: 'fixture', supportsTools: true }] }; }
    async runAgent(options) { this.calls.push(options); options.onEvent?.({ type: 'thread', threadId }); return execute(options, this.calls.length, context); }
    async close() {}
  }
  const runtime = new Runtime(), engine = new HarnessEngine({ runtime, email, dataDir: root, defaultCwd: cwd });
  engine.runtimeSettings = { get: () => ({ subagentsEnabled: workers, maxSubagents: 2 }) }; await engine.init();
  const workflow = createMissionWorkflow({ id: 'email-fixture', task: 'Send the requested fixture email.', model: 'fixture', cwd, planningMode: 'off' });
  const context = { engine, runtime, email, root, cwd, threadId, workflow, async settled(run) { await context.engine.executions.get(run.id); const saved = context.engine.getRun(run.id); assert.equal(saved.settled, true); return saved; } };
  t.after(async () => { await context.engine.close(); assert.match(path.basename(root), /^blackice-email-engine-/); await rm(root, { recursive: true, force: true }); }); return context;
}

test('new native chats capture v2 and retain exact tool/instructions on continuation', async t => {
  const f = await engineFixture(t, async (options, index, context) => {
    assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_email'), EMAIL_TOOL); assert.ok(options.prompt.includes(EMAIL_INSTRUCTIONS));
    if (index === 1) { const composed = await call(options, { action: 'compose', ...composeInput() }); assert.equal(composed.success, true); assert.equal((await call(options, { action: 'send', id: payload(composed).id, requestId: 'send-main' })).success, true); }
    return { output: 'Transport evidence retained.', threadId: context.threadId };
  });
  const first = await f.settled(f.engine.startRun({ workflow: f.workflow, input: 'Send the requested synthetic message.' })); assert.equal(first.status, 'completed', first.error); assert.equal(first.nodes.agent.emailSchemaVersion, 2);
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Read the delivery record.' })); assert.equal(next.status, 'completed', next.error); assert.equal(next.nodes.agent.emailSchemaVersion, 2); assert.equal(f.runtime.calls[1].threadId, f.threadId); assert.equal(f.email.calls.filter(value => value.action === 'send').length, 1);
});

test('v2 native email metadata survives a real engine reload before continuation', async t => {
  const f = await engineFixture(t, async (options, _index, context) => { assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_email'), EMAIL_TOOL); return { output: 'Email catalog captured.', threadId: context.threadId }; });
  const first = await f.settled(f.engine.startRun({ workflow: f.workflow, input: 'Inspect fixture email.' })); await f.engine.close();
  f.engine = await new HarnessEngine({ runtime: f.runtime, email: f.email, dataDir: f.root, defaultCwd: f.cwd }).init();
  assert.equal(f.engine.getRun(first.id).nodes.agent.emailSchemaVersion, 2);
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the saved email catalog.' })); assert.equal(next.status, 'completed', next.error); assert.equal(next.nodes.agent.emailSchemaVersion, 2); assert.equal(f.runtime.calls[1].threadId, f.threadId);
});

test('new v2 native retries retain the sending catalog after an interrupted turn', async t => {
  const f = await engineFixture(t, async (options, index, context) => { assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_email'), EMAIL_TOOL); if (index === 1) throw new Error('Fixture interruption.'); return { output: 'Resumed the same email catalog.', threadId: context.threadId }; });
  const first = await f.settled(f.engine.startRun({ workflow: f.workflow, input: 'Inspect fixture email.' })); assert.equal(first.status, 'failed'); assert.equal(first.nodes.agent.emailSchemaVersion, 2);
  const next = await f.settled(f.engine.retryRun(first.id)); assert.equal(next.status, 'completed', next.error); assert.equal(next.nodes.agent.emailSchemaVersion, 2); assert.equal(f.runtime.calls[1].threadId, f.threadId);
});

for (const retry of [false, true]) test(`legacy native ${retry ? 'retry' : 'continuation'} retains v1 when saved metadata predates email versioning`, async t => {
  const f = await engineFixture(t, async (options, index, context) => {
    if (index === 1 && retry) throw new Error('Fixture interrupted after native thread creation.');
    if (index === 2) { assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_email'), LEGACY_EMAIL_TOOL); assert.ok(options.prompt.includes(LEGACY_EMAIL_INSTRUCTIONS)); assert.ok(!options.prompt.includes(EMAIL_INSTRUCTIONS)); assert.equal((await call(options, { action: 'send', id: 'email_fixture', requestId: 'legacy-send' })).success, false); }
    return { output: 'Legacy catalog retained.', threadId: context.threadId };
  });
  const first = await f.settled(f.engine.startRun({ workflow: f.workflow, input: 'Read fixture email.' })); delete f.engine.runs.get(first.id).nodes.agent.emailSchemaVersion;
  const next = await f.settled(retry ? f.engine.retryRun(first.id) : f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue this saved native chat.' }));
  assert.equal(next.status, 'completed', next.error); assert.equal(next.nodes.agent.emailSchemaVersion, 1); assert.equal(f.runtime.calls[1].threadId, f.threadId); assert.equal(f.email.calls.filter(value => value.action === 'send').length, 0);
});

test('saved native catalogs that omit email never silently gain the sending tool', async t => {
  const f = await engineFixture(t, async (options, index, context) => { if (index === 2) { assert.equal(options.dynamicTools.find(tool => tool.name === 'relay_email'), undefined); assert.ok(!options.prompt.includes(EMAIL_INSTRUCTIONS)); assert.ok(!options.prompt.includes(LEGACY_EMAIL_INSTRUCTIONS)); } return { output: 'Saved tool names preserved.', threadId: context.threadId }; });
  const first = await f.settled(f.engine.startRun({ workflow: f.workflow, input: 'Inspect fixture tools.' })); f.engine.runs.get(first.id).nodes.agent.toolNames = first.nodes.agent.toolNames.filter(name => name !== 'relay_email');
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the saved tools.' })); assert.equal(next.status, 'completed', next.error); assert.equal(next.nodes.agent.emailSchemaVersion, undefined);
});

test('provider continuations use the current v2 catalog instead of native cache compatibility', async t => {
  const f = await engineFixture(t, async (options, _index, context) => { assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_email'), EMAIL_TOOL); return { output: 'Current provider tools available.', threadId: context.threadId }; }, { threadId: 'provider_email-fixture' });
  const first = await f.settled(f.engine.startRun({ workflow: f.workflow, input: 'Inspect fixture email.' })); f.engine.runs.get(first.id).nodes.agent.emailSchemaVersion = 1;
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Use current tools.' })); assert.equal(next.status, 'completed', next.error); assert.equal(next.nodes.agent.emailSchemaVersion, 2);
});

test('fresh delegated worker catalogs receive v2 and can inspect background delivery records', async t => {
  const f = await engineFixture(t, async (options, _index, context) => {
    if (options.prompt.startsWith('You are a short-lived')) { assert.deepEqual(options.dynamicTools.find(tool => tool.name === 'relay_email'), EMAIL_TOOL); assert.ok(options.prompt.includes(EMAIL_INSTRUCTIONS)); assert.equal((await call(options, { action: 'deliveries' })).success, true); return { output: 'Observed the prepared fixture only.', threadId: 'email-worker-thread' }; }
    const delegated = await options.onToolCall({ name: 'relay_delegate', arguments: { tasks: [{ id: 'inspect-email', prompt: 'Inspect the existing delivery record.', canWrite: false }] } }); assert.equal(delegated.success, true, JSON.stringify(delegated));
    return { output: 'Independent delivery inspection completed.', threadId: context.threadId };
  }, { workers: true });
  const run = await f.settled(f.engine.startRun({ workflow: f.workflow, input: 'Have a reviewer inspect the fixture delivery.' })); assert.equal(run.status, 'completed', run.error); assert.equal(f.runtime.calls.length, 2); assert.equal(f.email.calls.filter(value => value.action === 'deliveries').length, 1);
});

test('local email API composes/sends without flags and returns inspectable explicit transport outcomes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-email-api-')), email = fakeStore();
  class Runtime extends EventEmitter { status() { return { connected: true, authenticated: true, defaultModel: 'fixture' }; } async start() {} async close() {} }
  const app = await createHarnessServer({ runtime: new Runtime(), email, port: 0, dataDir: path.join(root, 'data'), defaultCwd: path.join(root, 'workspace') }), url = await app.listen();
  t.after(async () => { await app.close(); assert.match(path.basename(root), /^blackice-email-api-/); await rm(root, { recursive: true, force: true }); });
  const home = await fetch(url), cookie = home.headers.get('set-cookie').split(';')[0]; await home.text();
  const request = async (route, body, authenticated = true) => { const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  assert.equal((await request('/api/email/compose', composeInput(), false)).status, 401); assert.equal(email.calls.length, 0);
  const composed = await request('/api/email/compose', composeInput()); assert.equal(composed.status, 201); assert.equal(composed.value.delivery.state, 'prepared'); assert.deepEqual(email.calls[0].input, composeInput()); assert.ok(email.calls[0].signal instanceof AbortSignal);
  const sendInput = { id: 'email_fixture', requestId: 'send-http' }, sent = await request('/api/email/send', sendInput); assert.equal(sent.status, 200); assert.equal(sent.value.delivery.sent, true); assert.equal(sent.value.delivery.recipientAcknowledged, false); assert.deepEqual(email.calls[1].input, sendInput);
  const listed = await request('/api/email/deliveries'); assert.equal(listed.status, 200); assert.equal(listed.value.deliveries.length, 1);
  const detail = await request('/api/email/deliveries/email_fixture'); assert.equal(detail.status, 200); assert.equal(detail.value.delivery.messageSha256, 'a'.repeat(64));
  const beforeRejected = email.calls.length; assert.equal((await request('/api/email/send', { ...sendInput, confirmSend: true })).status, 400); assert.equal(email.calls.length, beforeRejected);
  email.send = async () => ({ ...prepared(), state: 'uncertain', sent: false, error: { code: 'EMAIL_SEND_UNCERTAIN', message: 'Inspect the saved delivery.' } });
  const uncertain = await request('/api/email/send', sendInput); assert.equal(uncertain.status, 200); assert.equal(uncertain.value.delivery.state, 'uncertain'); assert.equal(uncertain.value.delivery.sent, false);
  email.send = async () => ({ ...prepared(), state: 'queued', sent: false, transportAccepted: false, delivery: { queueId: 'queue-http-fixture' } });
  const queued = await request('/api/email/send', sendInput); assert.equal(queued.status, 200); assert.equal(queued.value.delivery.state, 'queued'); assert.equal(queued.value.delivery.sent, false); assert.equal(queued.value.delivery.delivery.queueId, 'queue-http-fixture');
  email.compose = async () => { throw Object.assign(new Error('This request ID already identifies different exact content.'), { code: 'EMAIL_COMPOSE_CONFLICT', status: 409 }); };
  const conflict = await request('/api/email/compose', composeInput()); assert.equal(conflict.status, 409); assert.equal(conflict.value.code, 'EMAIL_COMPOSE_CONFLICT');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentEmailStore } from '../lib/agent-email.mjs';
import { parseEmailMessage } from '../lib/email-message.mjs';
import { emailSha256 } from '../lib/email-mime.mjs';

const input = overrides => ({ requestId: 'fixture-compose', from: 'sender@example.invalid', to: ['recipient@example.invalid'], subject: 'Research application – résumé', body: 'A truthful UTF-8 body.\nSecond line ✓', ...overrides });
const help = '--json --account --mailbox --page-size --page --raw --seen Read leaving its flags alone otherwise <MESSAGE> profile';
async function setup(t, { send, oauth, renameDeliveryFile } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-send-'));
  const configPath = path.join(directory, 'fixture.toml');
  await fs.writeFile(configPath, '# No live account, network transport or credentials.\n');
  const calls = [];
  const runner = async request => {
    calls.push(request);
    if (request.args.includes('--version')) return { stdout: 'himalaya v2.2.1 +smtp +gmail +msgraph', exitCode: 0 };
    if (request.args.includes('--help')) return { stdout: help, exitCode: 0 };
    if (request.args.includes('send')) return send ? send(request, directory) : { stdout: JSON.stringify({ message: 'Message sent', queueId: null }), exitCode: 0 };
    throw new Error('Unexpected fixture command.');
  };
  if (oauth) { oauth.configPath = configPath; oauth.account = 'managed'; }
  const store = await new AgentEmailStore({ dataDir: directory, runner, oauth, renameDeliveryFile }).init();
  t.after(async () => { await store.close(); const resolved = path.resolve(directory); assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('blackice-email-send-')); await fs.rm(resolved, { recursive: true, force: true }); });
  await store.configure({ enabled: true, executable: process.execPath, configPath, account: 'fixture', ...(oauth ? { connection: 'oauth' } : {}) });
  await store.check();
  return { store, directory, configPath, calls, runner };
}

test('compose snapshots binary attachments into MIME, round-trips Unicode, and retains old local drafts', async t => {
  const { store, directory, calls } = await setup(t);
  const filename = path.join(directory, 'résumé 人.pdf');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 37, 80, 68, 70]);
  await fs.writeFile(filename, bytes);
  const message = await store.compose(input({ cc: ['copy@example.invalid'], bcc: ['hidden@example.invalid'], attachments: [filename] }));
  assert.equal(message.state, 'prepared'); assert.equal(message.sent, false);
  assert.equal(message.transportAccepted, false); assert.equal(message.recipientAcknowledged, false);
  assert.equal(message.attachments[0].fileName, 'résumé 人.pdf');
  assert.equal(message.attachments[0].size, bytes.length); assert.equal(message.attachments[0].sha256, emailSha256(bytes));
  const raw = await fs.readFile(message.path, 'utf8');
  const parsed = parseEmailMessage(raw);
  assert.equal(parsed.subject, input().subject); assert.equal(parsed.text.trim(), input().body);
  assert.equal(parsed.from[0].email, input().from); assert.equal(parsed.attachments[0].filename, 'résumé 人.pdf');
  assert.equal(parsed.attachments[0].size, bytes.length); assert.deepEqual(parsed.warnings, []);
  assert.match(raw, /Message-ID: <[a-f\d-]+@blackice\.local>/); assert.doesNotMatch(raw, /X-Unsent:/);
  assert.equal(message.messageSha256, emailSha256(raw));
  const draft = await store.draft({ requestId: 'legacy', to: input().to, body: 'Local unsent draft.' });
  assert.equal(store.getDraft(draft.id).state, 'local_draft');
  assert.equal(store.listDeliveries().length, 1); assert.equal(store.listDrafts().length, 1);
  assert.equal(calls.filter(call => call.args.includes('send')).length, 0);
});

test('compose request IDs are idempotent and reject changed body or attachment bytes', async t => {
  const { store, directory } = await setup(t);
  const filename = path.join(directory, 'evidence.txt'); await fs.writeFile(filename, 'first');
  const first = await store.compose(input({ attachments: [filename] }));
  const duplicate = await store.compose(input({ attachments: [filename] }));
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.duplicate, true);
  await assert.rejects(store.compose(input({ body: 'changed', attachments: [filename] })), { code: 'EMAIL_COMPOSE_CONFLICT' });
  await fs.writeFile(filename, 'second');
  await assert.rejects(store.compose(input({ attachments: [filename] })), { code: 'EMAIL_COMPOSE_CONFLICT' });
  assert.equal(store.listDeliveries().length, 1);
});

test('composition rejects header injection, directory/relative attachments, and cancellation without sending', async t => {
  const { store, directory, calls } = await setup(t);
  for (const value of [input({ from: 'sender@example.invalid\r\nBcc: victim@example.invalid' }), input({ subject: 'Hi\nBcc: victim' }), input({ to: ['recipient@example.invalid\n'] }), input({ attachments: ['relative.pdf'] }), input({ attachments: [directory] })]) {
    await assert.rejects(Promise.resolve().then(() => store.compose(value)), { code: 'EMAIL_COMPOSE_INVALID' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.compose(input(), { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.deepEqual(store.listDeliveries(), []);
  assert.equal(calls.filter(call => call.args.includes('send')).length, 0);
});

test('attachment resource limits are explicit and cannot launch a transport', async t => {
  const { store, directory, calls } = await setup(t);
  const filename = path.join(directory, 'large.pdf');
  const handle = await fs.open(filename, 'w'); await handle.truncate(25 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(store.compose(input({ attachments: [filename] })), { code: 'EMAIL_COMPOSE_INVALID' });
  assert.deepEqual(store.listDeliveries(), []);
  assert.equal(calls.filter(call => call.args.includes('send')).length, 0);
});

test('lost rename acknowledgment is recognized for both MIME and metadata without losing referenced bytes', async t => {
  let promoted = 0;
  const { store } = await setup(t, { renameDeliveryFile: async (source, destination) => {
    await fs.rename(source, destination); promoted++;
    throw Object.assign(new Error('Acknowledgment lost after promotion'), { code: 'EIO' });
  } });
  const composed = await store.compose(input());
  assert.equal(promoted, 2); assert.equal(composed.state, 'prepared');
  assert.equal(emailSha256(await fs.readFile(composed.path)), composed.messageSha256);
  assert.equal(JSON.parse(await fs.readFile(store.deliveryFilename, 'utf8')).messages[0].id, composed.id);
  const result = await store.send({ id: composed.id, requestId: 'rename-lost-ack' });
  assert.equal(result.state, 'sent'); assert.equal(result.persistenceFailed, undefined);
  assert.equal(JSON.parse(await fs.readFile(store.deliveryFilename, 'utf8')).messages[0].state, 'sent');
});

test('unconfirmed metadata promotion preserves the MIME that disk metadata may already reference', async t => {
  let destinationPath;
  const { store, directory, runner } = await setup(t, { renameDeliveryFile: async (source, destination) => {
    await fs.rename(source, destination);
    if (destination.endsWith('deliveries.json')) {
      const value = JSON.parse(await fs.readFile(destination, 'utf8')); value.concurrentFixtureMarker = true;
      await fs.writeFile(destination, JSON.stringify(value)); destinationPath = destination;
      throw Object.assign(new Error('Unknown metadata promotion result'), { code: 'EIO' });
    }
  } });
  await assert.rejects(store.compose(input()), error => error.code === 'EMAIL_DELIVERY_STORAGE' && error.commitUncertain === true);
  const saved = JSON.parse(await fs.readFile(destinationPath, 'utf8'));
  const filename = path.join(directory, 'agent-email', `message-${saved.messages[0].id}.eml`);
  assert.equal(emailSha256(await fs.readFile(filename)), saved.messages[0].messageSha256);
  const restarted = await new AgentEmailStore({ dataDir: directory, runner }).init(); t.after(() => restarted.close());
  assert.equal(restarted.getDelivery(saved.messages[0].id).state, 'prepared');
});

test('send persists uncertainty BEFORE dispatch and uses immutable MIME with exact hidden-process arguments', async t => {
  let observed;
  const { store, directory, configPath } = await setup(t, { send: async (request, root) => {
    const journal = JSON.parse(await fs.readFile(path.join(root, 'agent-email', 'deliveries.json'), 'utf8'));
    assert.equal(journal.messages[0].state, 'uncertain');
    assert.equal(journal.messages[0].delivery.requestId, 'fixture-send');
    assert.equal(journal.messages[0].delivery.transportAccepted, false);
    observed = request;
    return { stdout: '{"message":"Message sent","queueId":null}', exitCode: 0 };
  } });
  const attachment = path.join(directory, 'resume.pdf'); await fs.writeFile(attachment, 'original PDF bytes');
  const prepared = await store.compose(input({ attachments: [attachment] }));
  await fs.writeFile(attachment, 'changed source after snapshot');
  const sent = await store.send({ id: prepared.id, requestId: 'fixture-send' });
  assert.equal(sent.state, 'sent'); assert.equal(sent.sent, true); assert.equal(sent.transportAccepted, true);
  assert.equal(sent.recipientAcknowledged, false); assert.equal(sent.delivery.recipientAcknowledged, false);
  assert.equal(sent.messageSha256, prepared.messageSha256);
  assert.equal(sent.attachments[0].sha256, emailSha256('original PDF bytes'));
  assert.deepEqual(observed.args, [`--config=./${path.basename(configPath)}`, '--json', 'message', 'send', '--account=fixture', '--', prepared.path]);
  assert.equal(observed.cwd, path.dirname(configPath));
  const saved = JSON.parse(await fs.readFile(store.deliveryFilename, 'utf8'));
  assert.equal(saved.messages[0].state, 'sent'); assert.ok(saved.messages[0].delivery.responseSha256);
});

test('concurrent send retries and different request IDs never dispatch the same message twice', async t => {
  let sends = 0;
  const { store } = await setup(t, { send: async () => { sends++; await new Promise(resolve => setTimeout(resolve, 15)); return { stdout: '{"message":"Message sent"}', exitCode: 0 }; } });
  const prepared = await store.compose(input());
  const [first, concurrent] = await Promise.all([store.send({ id: prepared.id, requestId: 'once' }), store.send({ id: prepared.id, requestId: 'once' })]);
  assert.equal(first.state, 'sent'); assert.equal(concurrent.duplicate, true); assert.equal(sends, 1);
  const retry = await store.send({ id: prepared.id, requestId: 'different-id' });
  assert.equal(retry.duplicate, true); assert.equal(sends, 1);
  const other = await store.compose(input({ requestId: 'other-compose' }));
  await assert.rejects(store.send({ id: other.id, requestId: 'once' }), { code: 'EMAIL_SEND_CONFLICT' });
  assert.equal(store.getDelivery(other.id).state, 'prepared');
});

test('lost result is durable uncertainty and remains non-replayed after restart', async t => {
  let sends = 0;
  const { store, directory, runner } = await setup(t, { send: async () => { sends++; throw Object.assign(new Error('PRIVATE_PROVIDER_PAYLOAD'), { code: 'EMAIL_TIMEOUT' }); } });
  const prepared = await store.compose(input());
  const uncertain = await store.send({ id: prepared.id, requestId: 'lost-result' });
  assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.sent, false);
  assert.doesNotMatch(JSON.stringify(uncertain), /PRIVATE_PROVIDER_PAYLOAD/);
  await store.close();
  const restarted = await new AgentEmailStore({ dataDir: directory, runner }).init();
  t.after(() => restarted.close());
  assert.equal(restarted.getDelivery(prepared.id).state, 'uncertain');
  const recovered = await restarted.send({ id: prepared.id, requestId: 'lost-result' });
  assert.equal(recovered.duplicate, true); assert.equal(sends, 1);
  assert.equal(restarted.status().cli.checked, false);
});

test('close drains pending sends and prevents dispatch after a delayed preflight response', async t => {
  const { store, calls } = await setup(t);
  const prepared = await store.compose(input());
  const original = store.runner; let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  store.runner = request => request.args.includes('send') && request.args.includes('--help') ? new Promise(resolve => { release = () => resolve({ stdout: help, exitCode: 0 }); entered(); }) : original(request);
  const sending = store.send({ id: prepared.id, requestId: 'closing-before-dispatch' });
  await started;
  let drained = false; const closing = store.close().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release();
  await assert.rejects(sending, { code: 'ABORT_ERR' }); await closing;
  assert.equal(store.getDelivery(prepared.id).state, 'prepared');
  assert.equal(calls.filter(call => call.args.includes('send') && !call.args.includes('--help')).length, 0);
});

test('close waits for an in-flight transport and retains the durable uncertain attempt', async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const { store } = await setup(t, { send: () => new Promise(resolve => { release = () => resolve({ stdout: '{"message":"Message sent"}', exitCode: 0 }); entered(); }) });
  const prepared = await store.compose(input());
  const sending = store.send({ id: prepared.id, requestId: 'closing-after-dispatch' }); await started;
  let drained = false; const closing = store.close().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); const outcome = await sending; await closing;
  assert.equal(outcome.state, 'uncertain'); assert.equal(outcome.sent, false);
  assert.equal(JSON.parse(await fs.readFile(store.deliveryFilename, 'utf8')).messages[0].state, 'uncertain');
});

test('preflight cancellation and modified immutable bytes leave the message prepared and never dispatch', async t => {
  const { store, calls } = await setup(t);
  const prepared = await store.compose(input());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.send({ id: prepared.id, requestId: 'aborted' }, { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal(store.getDelivery(prepared.id).state, 'prepared');
  await fs.appendFile(prepared.path, 'modified');
  await assert.rejects(store.send({ id: prepared.id, requestId: 'modified' }), { code: 'EMAIL_MESSAGE_CHANGED' });
  assert.equal(calls.filter(call => call.args.includes('send') && !call.args.includes('--help')).length, 0);
});

test('unwritable pre-dispatch journal prevents dispatch; post-transport persistence loss never permits replay', async t => {
  let sends = 0;
  const { store } = await setup(t, { send: async () => { sends++; return { stdout: '{"message":"Message sent"}', exitCode: 0 }; } });
  const first = await store.compose(input());
  const save = store.saveDeliveries.bind(store);
  store.saveDeliveries = async () => { throw Object.assign(new Error('fixture disk unavailable'), { code: 'EMAIL_DELIVERY_STORAGE' }); };
  await assert.rejects(store.send({ id: first.id, requestId: 'before' }), { code: 'EMAIL_DELIVERY_STORAGE' });
  assert.equal(sends, 0); assert.equal(store.getDelivery(first.id).state, 'prepared');
  store.saveDeliveries = next => next.messages.some(message => message.state === 'sent') ? Promise.reject(new Error('fixture disk unavailable')) : save(next);
  const result = await store.send({ id: first.id, requestId: 'after' });
  assert.equal(result.state, 'uncertain'); assert.equal(result.transportAccepted, true); assert.equal(result.persistenceFailed, true);
  const recovered = await store.send({ id: first.id, requestId: 'after' });
  assert.equal(recovered.state, 'uncertain'); assert.equal(recovered.duplicate, true); assert.equal(sends, 1);
});

test('damaged delivery state is preserved and isolated from legacy local drafts', async t => {
  const { store, directory, runner } = await setup(t);
  const draft = await store.draft({ requestId: 'legacy', to: input().to, body: 'Still available.' });
  await store.compose(input()); await store.close();
  const damaged = '{"schema":1,"private":"DO_NOT_ECHO",';
  await fs.writeFile(store.deliveryFilename, damaged);
  const restarted = await new AgentEmailStore({ dataDir: directory, runner }).init();
  t.after(() => restarted.close());
  assert.equal(restarted.status().deliveryStorage.healthy, false);
  assert.equal(restarted.status().capabilities.compose, false); assert.equal(restarted.status().capabilities.send, false);
  assert.equal(restarted.getDraft(draft.id).body, 'Still available.');
  assert.throws(() => restarted.listDeliveries(), { code: 'EMAIL_DELIVERY_STORAGE' });
  assert.doesNotMatch(JSON.stringify(restarted.snapshot()), /DO_NOT_ECHO/);
  assert.equal(await fs.readFile(store.deliveryFilename, 'utf8'), damaged);
});

test('the actual v2 shared queue result remains queued and cannot be mistaken for sent or replayed', async t => {
  let sends = 0;
  const { store, directory, runner } = await setup(t, { send: async () => { sends++; return { stdout: '{"message":"Message queued","queueId":42}', exitCode: 0 }; } });
  const prepared = await store.compose(input());
  const queued = await store.send({ id: prepared.id, requestId: 'queued' });
  assert.equal(queued.state, 'queued'); assert.equal(queued.sent, false); assert.equal(queued.transportAccepted, false);
  assert.equal(queued.delivery.queueId, 42); assert.equal(queued.recipientAcknowledged, false);
  await store.close();
  const restarted = await new AgentEmailStore({ dataDir: directory, runner }).init(); t.after(() => restarted.close());
  const duplicate = await restarted.send({ id: prepared.id, requestId: 'queued' });
  assert.equal(duplicate.state, 'queued'); assert.equal(duplicate.duplicate, true); assert.equal(sends, 1);
});

test('malformed JSON and unsupported successful output preserve uncertainty instead of claiming sent', async t => {
  for (const stdout of ['not json', '{}', 'null', '{"message":"queued","queueId":-1}']) {
    const { store } = await setup(t, { send: async () => ({ stdout, exitCode: 0 }) });
    const prepared = await store.compose(input());
    const uncertain = await store.send({ id: prepared.id, requestId: 'protocol' });
    assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.transportAccepted, false);
    assert.equal(uncertain.error.code, 'EMAIL_PROTOCOL');
  }
});

class ManagedFixture extends EventEmitter {
  constructor(provider, canSend = true) { super(); this.provider = provider; this.canSend = canSend; this.generation = 1; }
  status() { return { configured: true, connected: true, provider: this.provider, capabilities: { read: true, send: this.canSend } }; }
  async ensureManagedConfig() {}
  async commandContext() { return { generation: this.generation, environment: { FIXTURE_AUTH: 'in-memory-fixture-only' } }; }
  async close() {}
}
test('managed sending uses actual Gmail/Graph raw-message commands and respects real grant capability', async t => {
  for (const provider of ['gmail', 'microsoft']) {
    const { store, calls } = await setup(t, { oauth: new ManagedFixture(provider) });
    const prepared = await store.compose(input());
    assert.equal(store.status().capabilities.send, true);
    const sent = await store.send({ id: prepared.id, requestId: `managed-${provider}` });
    assert.equal(sent.state, 'sent');
    const call = calls.find(item => item.args.includes('send') && !item.args.includes('--help'));
    assert.deepEqual(call.args.slice(2, 5), [provider === 'gmail' ? 'gmail' : 'msgraph', 'messages', 'send']);
    assert.equal(call.environment.FIXTURE_AUTH, 'in-memory-fixture-only');
    assert.doesNotMatch(JSON.stringify(sent), /in-memory-fixture-only/);
  }
  const { store, calls } = await setup(t, { oauth: new ManagedFixture('gmail', false) });
  const prepared = await store.compose(input());
  assert.equal(store.status().capabilities.send, false);
  await assert.rejects(store.send({ id: prepared.id, requestId: 'readonly' }), { code: 'EMAIL_SEND_UNAVAILABLE' });
  assert.equal(store.getDelivery(prepared.id).state, 'prepared');
  assert.equal(calls.filter(item => item.args.includes('send')).length, 0);
});

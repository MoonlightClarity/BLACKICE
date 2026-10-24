import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentEmailStore, runEmailCli } from '../lib/agent-email.mjs';
import { EMAIL_TOOL, EMAIL_INSTRUCTIONS, LEGACY_EMAIL_TOOL, LEGACY_EMAIL_INSTRUCTIONS, createEmailToolHandler } from '../lib/email-tools.mjs';

const payload = result => JSON.parse(result.contentItems[0].text);
const invoke = (handler, args) => handler({ name: 'relay_email', arguments: args });
const records = Array.from({ length: 237 }, (_, index) => ({ id: `email_${index}`, state: index % 2 ? 'prepared' : 'sent', sent: index % 2 === 0 }));
function fixture(deliveries = records) {
  const calls = [];
  const handler = createEmailToolHandler({ store: {
    listDeliveries() { calls.push('deliveries'); return deliveries; },
    async read(input, options) { calls.push({ input, options }); return { ...input, message: 'Synthetic message' }; },
    async compose() { assert.fail('An invalid compose must not dispatch.'); },
    async send() { assert.fail('An invalid send must not dispatch.'); },
  } });
  return { handler, calls };
}

test('email usability fixes preserve exact cached v1 and v2 catalogs and instructions', () => {
  const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
  assert.equal(hash(EMAIL_TOOL), '7e0a5a35f54d7b6389a52283ce68cce306775372edecce3fa46d2c247ee9d9e8');
  assert.equal(hash(EMAIL_INSTRUCTIONS), '65f8fe07198ec6f5801f3ed3c6f005c5d9d2a13942cc6a23a55af664eb0df9c0');
  assert.equal(hash(LEGACY_EMAIL_TOOL), 'e05ea1d8409d310dab6110a1332a9459466dd6ee610c11c8f4e78e28731daa27');
  assert.equal(hash(LEGACY_EMAIL_INSTRUCTIONS), '364cc13a2b05661600913fb00023a36f019b54f54ecf6aa5ae32e920ac7d1d46');
});

test('unpaged deliveries retain every record and the compatible response shape', async () => {
  const { handler, calls } = fixture(), result = await invoke(handler, { action: 'deliveries' });
  assert.equal(result.success, true);
  assert.deepEqual(payload(result), { deliveries: records });
  assert.deepEqual(calls, ['deliveries']);
});

test('explicit deliveries limit 100 pages preserve order and lose no records', async () => {
  const { handler } = fixture(), observed = [];
  for (let page = 1; page <= 3; page++) {
    const result = await invoke(handler, { action: 'deliveries', page, limit: 100 });
    assert.equal(result.success, true);
    const value = payload(result);
    assert.equal(value.total, records.length); assert.equal(value.page, page); assert.equal(value.limit, 100);
    assert.equal(value.mayHaveMore, page < 3); assert.equal(value.deliveries.length, page < 3 ? 100 : 37);
    observed.push(...value.deliveries);
  }
  assert.deepEqual(observed, records);
});

test('single pagination arguments expose their effective defaults', async () => {
  const { handler } = fixture();
  const limited = await invoke(handler, { action: 'deliveries', limit: 100 });
  assert.equal(limited.success, true);
  assert.deepEqual(payload(limited), { deliveries: records.slice(0, 100), total: records.length, page: 1, limit: 100, mayHaveMore: true });
  const paged = await invoke(handler, { action: 'deliveries', page: 2 });
  assert.equal(paged.success, true);
  assert.deepEqual(payload(paged), { deliveries: records.slice(20, 40), total: records.length, page: 2, limit: 20, mayHaveMore: true });
});

test('empty and exhausted delivery pages report truthful terminal metadata', async () => {
  const { handler } = fixture();
  assert.deepEqual(payload(await invoke(handler, { action: 'deliveries', page: 100000, limit: 100 })), { deliveries: [], total: records.length, page: 100000, limit: 100, mayHaveMore: false });
  const empty = fixture([]);
  assert.deepEqual(payload(await invoke(empty.handler, { action: 'deliveries', page: 1, limit: 1 })), { deliveries: [], total: 0, page: 1, limit: 1, mayHaveMore: false });
});

test('invalid delivery bounds are rejected before reading the store', async () => {
  const { handler, calls } = fixture();
  for (const args of [
    { page: 0 }, { page: -1 }, { page: 100001 }, { page: 1.5 }, { page: '2' }, { page: null }, { page: undefined },
    { limit: 0 }, { limit: -1 }, { limit: 101 }, { limit: 2.5 }, { limit: '100' }, { limit: null }, { limit: undefined },
  ]) {
    const result = await invoke(handler, { action: 'deliveries', ...args });
    assert.equal(result.success, false, JSON.stringify(args));
    assert.equal(payload(result).code, 'EMAIL_INVALID'); assert.equal(payload(result).status, 400);
    assert.match(payload(result).error, /page.*1 to 100000.*limit.*1 to 100/);
  }
  assert.deepEqual(calls, []);
});

test('pagination does not make irrelevant delivery, compose or send fields silently ignorable', async () => {
  const { handler, calls } = fixture();
  for (const args of [
    { action: 'deliveries', page: 1, to: ['ignored@example.invalid'] },
    { action: 'compose', requestId: 'fixture', from: 'from@example.invalid', to: ['to@example.invalid'], page: 1 },
    { action: 'send', id: 'email_fixture', requestId: 'send-fixture', limit: 100 },
    { action: 'get_delivery', id: 'email_fixture', limit: 100 },
  ]) {
    const result = await invoke(handler, args); assert.equal(result.success, false); assert.match(payload(result).error, /Use only/);
  }
  assert.deepEqual(calls, []);
});

test('v2 missing-folder reads give exact source guidance without dispatch', async () => {
  const { handler, calls } = fixture();
  for (const folder of [undefined, null, '', '  ', 42]) {
    const result = await invoke(handler, { action: 'read', id: 'folder-scoped-id', ...(folder === undefined ? {} : { folder }) });
    assert.equal(result.success, false); assert.equal(payload(result).code, 'EMAIL_FOLDER_REQUIRED'); assert.equal(payload(result).status, 400);
    assert.match(payload(result).error, /exact source folder.*folder-scoped message ID.*list\/search/);
    assert.match(payload(result).error, /same result.*Message-ID header/);
  }
  assert.deepEqual(calls, []);
});

test('v2 explicit-folder reads preserve exact source identity and cancellation signal', async () => {
  const { handler, calls } = fixture(), controller = new AbortController();
  const input = { folder: 'Archive & receipts / exact ID ', id: 'opaque:AAMkAG-node_42=' };
  const result = await handler({ name: 'relay_email', arguments: { action: 'read', ...input } }, { signal: controller.signal });
  assert.equal(result.success, true); assert.deepEqual(payload(result), { ...input, message: 'Synthetic message' });
  assert.deepEqual(calls[0].input, input); assert.equal(calls[0].options.signal.aborted, false);
  controller.abort(); assert.equal(calls[0].options.signal.aborted, true);
});

test('v1 omitted-folder reads and direct backend INBOX defaults remain unchanged', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-tool-usability-'));
  t.after(async () => {
    const resolved = path.resolve(directory), base = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('blackice-email-tool-usability-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const configPath = path.join(directory, 'fixture.toml'); await fs.writeFile(configPath, '# no account transport\n');
  const cliFixture = fileURLToPath(new URL('./fixtures/email-cli.mjs', import.meta.url)), commands = [];
  const store = await new AgentEmailStore({ dataDir: directory, runner: async input => {
    commands.push([...input.args]);
    return runEmailCli({ ...input, executable: process.execPath, args: [cliFixture, 'ok', ...input.args] });
  } }).init();
  t.after(() => store.close());
  await store.configure({ enabled: true, executable: process.execPath, configPath, account: 'fixture' }); await store.check();
  const count = commands.length, modern = createEmailToolHandler({ store });
  assert.equal((await invoke(modern, { action: 'read', id: '42' })).success, false); assert.equal(commands.length, count);
  const legacy = createEmailToolHandler({ store, schemaVersion: 1 });
  assert.equal((await invoke(legacy, { action: 'read', id: '42' })).success, true); assert.ok(commands.at(-1).includes('--mailbox=INBOX'));
  assert.equal((await store.read({ id: '42' })).folder, 'INBOX'); assert.ok(commands.at(-1).includes('--mailbox=INBOX'));
  assert.equal((await invoke(modern, { action: 'read', folder: 'Archive & receipts', id: 'opaque:42=' })).success, true);
  assert.ok(commands.at(-1).includes('--mailbox=Archive & receipts')); assert.equal(commands.at(-1).at(-1), 'opaque:42=');
  const before = commands.length;
  assert.equal((await invoke(legacy, { action: 'deliveries', limit: 100 })).success, false); assert.equal(commands.length, before);
});

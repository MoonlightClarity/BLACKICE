import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentEmailStore } from '../lib/agent-email.mjs';
import { createEmailToolHandler, EMAIL_TOOL } from '../lib/email-tools.mjs';

const help = '--json --page-size --page --mailbox --account --raw --seen Read, leaving its flags alone otherwise';
async function setup(t, accountResponse) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-completion-'));
  const configPath = path.join(directory, 'fixture.toml'); await fs.writeFile(configPath, '# fixture only');
  const calls = [], store = await new AgentEmailStore({ dataDir: directory, runner: async input => {
    calls.push(input); const stdout = input.args.includes('--version') ? 'himalaya 2.2.1' : input.args.includes('--help') ? help : JSON.stringify(typeof accountResponse === 'function' ? await accountResponse(input) : accountResponse);
    return { stdout, exitCode: 0 };
  } }).init();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await store.configure({ enabled: true, executable: process.execPath, configPath, account: '-literal account' });
  return { store, calls, configPath };
}

test('mailbox discovery is explicit, account-scoped, and never requests message counts', async t => {
  const { store, calls, configPath } = await setup(t, { mailboxes: [{ id: 'folder-id', name: 'Archive & receipts', role: null, total: null, unread: null }] });
  await assert.rejects(store.mailboxes(), { code: 'EMAIL_CLI_UNCHECKED' });
  await store.check(); assert.equal(calls.length, 5); assert.equal(store.status().account.observed, false);
  const result = await store.mailboxes();
  assert.deepEqual(result.mailboxes, [{ id: 'folder-id', name: 'Archive & receipts', role: null, total: null, unread: null }]);
  assert.deepEqual(calls.at(-1).args, ['--config=./fixture.toml', '--json', 'mailbox', 'list', '--account=-literal account']);
  assert.equal(calls.at(-1).cwd, path.dirname(configPath)); assert.equal(result.evidence.operation, 'mailboxes');
  assert.equal(store.status().capabilities.mailboxes, true);
});

test('malformed, oversized or legacy mailbox lists never become successful account evidence', async t => {
  const valid = { id: 'id', name: 'INBOX', role: null, total: null, unread: null };
  for (const response of [[valid], {}, { mailboxes: [{ ...valid, name: 'bad\nname' }] }, { mailboxes: [{ ...valid, id: null }] }, { mailboxes: [{ ...valid, total: -1 }] }, { mailboxes: Array.from({ length: 1001 }, () => valid) }]) {
    const { store } = await setup(t, response); await store.check();
    await assert.rejects(store.mailboxes(), { code: 'EMAIL_PROTOCOL' }); assert.equal(store.status().account.observed, false);
  }
});

test('read preserves exact raw message, flag behavior and adds decoded preview for tools', async t => {
  const raw = 'Subject: =?UTF-8?B?UsOpc3Vtw6k=?=\r\nFrom: Sender <sender@example.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nQm9keSDigJQgaW50YWN0Lg==';
  const { store, calls } = await setup(t, { message: raw }); await store.check();
  const read = await store.read({ folder: 'folder-id', id: 'opaque.message' });
  assert.equal(read.message, raw); assert.equal(read.content.subject, 'Résumé'); assert.equal(read.content.text, 'Body — intact.'); assert.equal(read.content.from[0].email, 'sender@example.invalid');
  assert.ok(calls.at(-1).args.includes('--raw')); assert.ok(!calls.at(-1).args.includes('--seen'));
  const handler = createEmailToolHandler({ store });
  const toolRead = await handler({ name: EMAIL_TOOL.name, arguments: { action: 'read', id: 'opaque.message', folder: 'folder-id' } });
  assert.equal(toolRead.success, true); assert.equal(JSON.parse(toolRead.contentItems[0].text).content.text, 'Body — intact.');
});

test('mailbox discovery is exposed through the bounded email tool and honours cancellation', async t => {
  const { store, calls } = await setup(t, { mailboxes: [] }); await store.check();
  const handler = createEmailToolHandler({ store });
  assert.ok(EMAIL_TOOL.inputSchema.properties.action.enum.includes('mailboxes'));
  const result = await handler({ name: EMAIL_TOOL.name, arguments: { action: 'mailboxes' } });
  assert.equal(result.success, true); assert.deepEqual(JSON.parse(result.contentItems[0].text).mailboxes, []);
  const before = calls.length, controller = new AbortController(); controller.abort();
  const cancelled = await handler({ name: EMAIL_TOOL.name, arguments: { action: 'mailboxes' } }, { signal: controller.signal });
  assert.equal(cancelled.success, false); assert.equal(JSON.parse(cancelled.contentItems[0].text).code, 'ABORT_ERR'); assert.equal(calls.length, before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStateStore } from '../lib/task-state.mjs';
import { observeExternalActions } from '../public/observe-model.mjs';
import { renderObserveExternalActions } from '../public/observe-ui.mjs';

const destination = 'mailto:Hiring.Team%2Bresume@example.invalid';
const reference = (left = 'Case+research', right = 'Example.INVALID') => ({ url: `mid:${encodeURIComponent(left)}@${encodeURIComponent(right)}`, referenceKind: 'email-message', emailMessageId: `<${left}@${right}>` });
const fixture = (extra = {}) => ({ taskState: { externalActions: [{ id: 'email-result', destination, status: 'confirmed', attempts: 1, evidence: 'Observed one matching Sent copy and the original attachment.', ...reference(), ...extra }] } });

test('a reloaded real email confirmation is recognized without a web link and displayed as noninteractive text', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-observe-mid-')), stores = [];
  const open = async () => { const store = await new TaskStateStore({ dataDir: directory }).init(); stores.push(store); return store; };
  t.after(async () => { await Promise.all(stores.map(store => store.close())); const resolved = path.resolve(directory); assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith('blackice-observe-mid-')); await fs.rm(resolved, { recursive: true, force: true }); });
  const store = await open(); await store.ensure({ taskId: 'email-task', cwd: directory, goal: 'Preserve an observed synthetic email result.' });
  const act = async value => store.externalAction('email-task', value, { expectedRevision: (await store.get('email-task')).revision, runId: 'send-run', nodeId: 'agent' });
  await act({ receiptId: 'email-result', operation: 'prepare', destination, content: 'Synthetic message.', attachmentSha256: 'a'.repeat(64) });
  await act({ receiptId: 'email-result', operation: 'attempt' });
  await act({ receiptId: 'email-result', operation: 'confirm', url: 'MID:Case%2Bresearch@Example.INVALID', evidence: 'Transport and matching Sent copy observed.' });
  const reloaded = await open(), saved = await reloaded.get('email-task'), before = structuredClone(saved);
  const model = observeExternalActions({ taskState: saved }), receipt = model.receipts[0], html = renderObserveExternalActions(model, { canOpenConversation: true });
  assert.equal(receipt.url, reference().url); assert.equal(receipt.referenceKind, 'email-message'); assert.equal(receipt.emailMessageId, reference().emailMessageId);
  assert.equal(receipt.needsInspection, false); assert.equal(model.needsInspection, 0); assert.equal(model.confirmed, 1);
  assert.equal(receipt.sourceRunId, 'send-run'); assert.equal(receipt.attachmentSha256, 'a'.repeat(64));
  assert.match(html, /Email Message-ID/); assert.match(html, /&lt;Case\+research@Example\.INVALID&gt;/); assert.match(html, /without sending it again/);
  assert.match(html, /View receipt conversation/); assert.match(html, /Receipts are agent reports/);
  assert.doesNotMatch(html, /href=|window\.open|onclick=|Open confirmed result|no usable result link|employer acknowledgment|recipient received/i);
  assert.deepEqual(saved, before, 'Observe must not rewrite the durable receipt.');
});

test('opaque encoded Message-ID punctuation and domain literals remain escaped display text', () => {
  for (const [left, right] of [['part/one?two#three', 'Example.INVALID'], ["O'Neil&team", '[IPv6:2001:db8::1]'], ['id', '[test@host]'], ['id', '[<img>]']]) {
    const expected = reference(left, right), model = observeExternalActions(fixture(expected)), html = renderObserveExternalActions(model);
    assert.equal(model.receipts[0].emailMessageId, expected.emailMessageId); assert.equal(model.needsInspection, 0);
    assert.match(html, /Email Message-ID/); assert.doesNotMatch(html, /href=|<script|<img|onclick=|window\.open/);
    if (left.includes('&')) assert.ok(html.includes('O&#39;Neil&amp;team'));
    if (right.includes('<')) assert.ok(html.includes('&lt;img&gt;'));
  }
});

test('the canonical message reference has the same bounded URI length as the persisted contract', () => {
  const right='example.invalid', left='a'.repeat(2048-'mid:'.length-1-right.length), exact=reference(left,right);
  assert.equal(exact.url.length,2048); assert.equal(observeExternalActions(fixture(exact)).needsInspection,0);
  const oversized=reference(left+'a',right), rejected=observeExternalActions(fixture(oversized));
  assert.equal(oversized.url.length,2049); assert.equal(rejected.receipts[0].url,null); assert.equal(rejected.needsInspection,1);
});

test('unsafe, noncanonical or mismatched saved email references remain inspection items with no active link', () => {
  for (const extra of [
    { url: 'mid:id@example.invalid?query=bad' }, { url: 'mid:id@example.invalid#fragment' }, { url: 'mid:id@example.invalid/part@other.invalid' },
    { url: 'mid://id@example.invalid' }, { url: 'mid:id%0D%0A@example.invalid' }, { url: 'mid:id%00@example.invalid' }, { url: 'mid:id%ZZ@example.invalid' },
    { url: 'MID:Case%2Bresearch@Example.INVALID' }, { url: 'mid:%43ase%2Bresearch@Example.INVALID' }, { url: ' mid:id@example.invalid' },
    { url: 'mid:id@example.invalid ' }, { url: 'mid:id@@example.invalid' }, { url: 'mid:.id@example.invalid' }, { url: 'mid:id..name@example.invalid' },
    { url: 'mid:%3Cimg%20src%3Dx%3E@example.invalid', emailMessageId: '<img src=x>@example.invalid' },
    { url: reference().url, emailMessageId: '<different@example.invalid>' }, { url: reference().url, referenceKind: 'web' },
    { url: reference().url, destination: 'https://example.invalid/apply' }, { url: reference().url, destination: 'mailto:team@example.invalid?cc=other@example.invalid' },
    { url: 'mid:' + 'a'.repeat(2048) + '@example.invalid' },
  ]) {
    const model = observeExternalActions(fixture(extra)), receipt = model.receipts[0], html = renderObserveExternalActions(model);
    assert.equal(receipt.url, null, JSON.stringify(extra)); assert.equal(receipt.emailMessageId, undefined, JSON.stringify(extra));
    assert.equal(model.needsInspection, 1, JSON.stringify(extra));
    assert.doesNotMatch(html, /href="mid:|Email Message-ID|<img|<script|onclick=|window\.open/, JSON.stringify(extra));
  }
});

test('prepared and uncertain records cannot use MID metadata to imply confirmation', () => {
  for (const status of ['prepared', 'uncertain', 'unrecognized']) {
    const model = observeExternalActions(fixture({ status })), receipt = model.receipts[0], html = renderObserveExternalActions(model);
    assert.equal(receipt.url, null); assert.equal(receipt.emailMessageId, undefined); assert.equal(model.confirmed, 0);
    assert.doesNotMatch(html, /Email Message-ID|Open confirmed result|href=/);
  }
});

test('HTTP confirmations retain the existing link and ignore forged email metadata', () => {
  for (const destination of ['https://example.invalid/apply', 'mailto:team@example.invalid']) {
    const model = observeExternalActions(fixture({ destination, url: 'https://example.invalid/result/1', emailMessageId: '<forged@example.invalid>' })), receipt = model.receipts[0], html = renderObserveExternalActions(model);
    assert.equal(receipt.url, 'https://example.invalid/result/1'); assert.equal(receipt.emailMessageId, undefined); assert.equal(receipt.referenceKind, undefined); assert.equal(model.needsInspection, 0);
    assert.match(html, /href="https:\/\/example\.invalid\/result\/1"/); assert.match(html, /Open confirmed result/); assert.doesNotMatch(html, /Email Message-ID/);
  }
});

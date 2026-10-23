import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { FilePatchStore } from '../lib/file-patches.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const parsed = response => JSON.parse(response.contentItems[0].text);
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-json-feedback-'));
  const store = new FilePatchStore({ dataDir: path.join(root, 'history'), ...options });
  t.after(async () => { await store.close(); assert.match(path.basename(root), /^blackice-json-feedback-/); await fs.rm(root, { recursive: true, force: true }); });
  const handler = createWorkspaceToolHandler({ cwd: root, patchStore: store });
  return { root, store, call: args => handler({ name: 'relay_workspace', arguments: args }) };
}

for (const valid of [true, false]) test(`atomic JSON write reports syntax ${valid ? 'validity' : 'warning'} while preserving saved bytes and success`, async t => {
  const { root, call } = await fixture(t), text = valid ? '{"rows":[]}' : '{"private-marker-DO-NOT-ECHO":"secret-DO-NOT-ECHO" "rows":[]}';
  const response = await call({ action: 'write', path: 'saved.JSON', text }), receipt = parsed(response);
  assert.equal(response.success, true); assert.equal(receipt.atomic, true); assert.equal(receipt.bytesWritten, Buffer.byteLength(text));
  assert.equal(await fs.readFile(path.join(root, 'saved.JSON'), 'utf8'), text);
  assert.deepEqual({ format: receipt.formatValidation.format, performed: receipt.formatValidation.performed, valid: receipt.formatValidation.valid }, { format: 'json', performed: true, valid });
  if (!valid) assert.match(receipt.formatValidation.warning, /^Saved content is not valid JSON\./);
  assert.doesNotMatch(JSON.stringify(receipt), /private-marker-DO-NOT-ECHO|secret-DO-NOT-ECHO/);
});

test('applied malformed JSON patch keeps its durable receipt and can be repaired with a later patch', async t => {
  const { root, store, call } = await fixture(t), file = path.join(root, 'state.json'), before = '{"first":1,"second":2}';
  await fs.writeFile(file, before);
  const bad = parsed(await call({ action: 'patch', path: 'state.json', oldText: ',"second"', newText: ' "second"' }));
  assert.equal(bad.status, 'applied'); assert.equal(bad.formatValidation.valid, false);
  const saved = await store.get(bad.id); assert.equal(saved.status, 'applied'); assert.equal(bad.beforeHash, hash(before)); assert.equal(bad.afterHash, hash(saved.after));
  assert.equal(await fs.readFile(file, 'utf8'), saved.after); assert.equal(saved.formatValidation, undefined, 'Syntax feedback must not rewrite durable patch history.');
  const response = await call({ action: 'patch', path: 'state.json', oldText: ' "second"', newText: ',"second"', expectedHash: bad.afterHash });
  assert.equal(response.success, true); assert.equal(parsed(response).formatValidation.valid, true); assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('committed promotion with a lost acknowledgement retains applied status and syntax feedback without replay', async t => {
  let target, promotions = 0;
  const io = { ...fs, rename: async (from, to) => { await fs.rename(from, to); if (to === target) { promotions++; throw new Error('Acknowledgement lost.'); } } };
  const { root, call } = await fixture(t, { io }); target = path.join(root, 'state.json'); await fs.writeFile(target, '{"a":1,"b":2}');
  const response = await call({ action: 'patch', path: 'state.json', oldText: ',"b"', newText: ' "b"' }), receipt = parsed(response);
  assert.equal(response.success, true); assert.equal(receipt.status, 'applied'); assert.equal(receipt.formatValidation.valid, false); assert.equal(promotions, 1);
  assert.equal(await fs.readFile(target, 'utf8'), '{"a":1 "b":2}');
});

test('validation is bounded and does not mark oversized, unreadable, or changed saved files invalid', async t => {
  const { root } = await fixture(t);
  for (const mode of ['large', 'missing', 'changed']) {
    const file = path.join(root, `${mode}.json`), saved = mode === 'large' ? ' '.repeat(1024 * 1024 + 1) : '{"actual":true}';
    if (mode !== 'missing') await fs.writeFile(file, saved);
    const receipt = { id: mode, path: file, status: 'applied', afterHash: mode === 'changed' ? hash('{"earlier":true}') : hash(saved), auditReceiptPending: true };
    const handler = createWorkspaceToolHandler({ cwd: root, patchStore: { patch: async () => receipt } });
    const response = await handler({ name: 'relay_workspace', arguments: { action: 'patch', path: `${mode}.json`, oldText: 'fixture', newText: 'fixture replacement' } }), result = parsed(response);
    assert.equal(response.success, true); assert.equal(result.status, 'applied'); assert.equal(result.id, receipt.id); assert.equal(result.auditReceiptPending, true);
    assert.equal(result.formatValidation.performed, false); assert.equal(Object.hasOwn(result.formatValidation, 'valid'), false); assert.match(result.formatValidation.warning, /validation was not performed/);
  }
});

test('exactly 1 MiB JSON is checked while non-JSON and prepared receipts acquire no syntax claim', async t => {
  const { root, call } = await fixture(t), text = '"' + 'x'.repeat(1024 * 1024 - 2) + '"';
  const maximum = await call({ action: 'write', path: 'maximum.json', text }); assert.equal(maximum.success, true); assert.equal(parsed(maximum).formatValidation.valid, true);
  const plain = await call({ action: 'write', path: 'notes.txt', text: '{not json' }); assert.equal(plain.success, true); assert.equal(parsed(plain).formatValidation, undefined);
  const receipt = { id: 'prepared', path: path.join(root, 'not-written.json'), status: 'prepared', afterHash: hash('not saved') };
  const handler = createWorkspaceToolHandler({ cwd: root, patchStore: { patch: async () => receipt } });
  const response = await handler({ name: 'relay_workspace', arguments: { action: 'patch', path: 'not-written.json', oldText: 'before', newText: 'after' } });
  assert.deepEqual(parsed(response), receipt); await assert.rejects(fs.stat(receipt.path), { code: 'ENOENT' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const call = arguments_ => ({ name: 'relay_workspace', arguments: arguments_ });
const body = result => JSON.parse(result.contentItems[0].text);
async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'relay-code-write-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, handler: createWorkspaceToolHandler({ cwd, ...options }) };
}

test('omitted write hash retains create and replacement behavior', async t => {
  const { cwd, handler } = await fixture(t);
  for (const text of ['first\n', 'replacement ✓\r\n']) {
    const result = await handler(call({ action: 'write', path: 'code.cjs', text }));
    assert.equal(result.success, true);
    assert.equal(body(result).atomic, true);
    assert.equal(await readFile(path.join(cwd, 'code.cjs'), 'utf8'), text);
  }
  assert.deepEqual(await readdir(cwd), ['code.cjs']);
});

test('matching byte hash permits a guarded replacement and records the checked preimage', async t => {
  const { cwd, handler } = await fixture(t);
  const before = 'const label = "✓";\r\n';
  await writeFile(path.join(cwd, 'code.cjs'), before);
  const result = await handler(call({ action: 'write', path: 'code.cjs', text: 'module.exports = 2;\n', expectedHash: hash(before) }));
  assert.equal(result.success, true);
  assert.equal(body(result).previousHash, hash(before));
  assert.equal(await readFile(path.join(cwd, 'code.cjs'), 'utf8'), 'module.exports = 2;\n');
  assert.deepEqual(await readdir(cwd), ['code.cjs']);
});

test('stale hash fails without changing saved bytes or leaving a staging file', async t => {
  const { cwd, handler } = await fixture(t);
  await writeFile(path.join(cwd, 'code.cjs'), 'current');
  const result = await handler(call({ action: 'write', path: 'code.cjs', text: 'overwrite', expectedHash: hash('stale') }));
  assert.equal(result.success, false);
  assert.equal(body(result).code, 'WORKSPACE_WRITE_CONFLICT');
  assert.equal(body(result).actionDispatched, false);
  assert.equal(await readFile(path.join(cwd, 'code.cjs'), 'utf8'), 'current');
  assert.deepEqual(await readdir(cwd), ['code.cjs']);
});

test('expected missing target does not create a file or its parent directory', async t => {
  const { cwd, handler } = await fixture(t);
  const result = await handler(call({ action: 'write', path: 'new/deep/code.cjs', text: 'overwrite', expectedHash: hash('missing') }));
  assert.equal(result.success, false);
  assert.equal(body(result).code, 'WORKSPACE_WRITE_CONFLICT');
  assert.equal(body(result).actionDispatched, false);
  await assert.rejects(stat(path.join(cwd, 'new')), { code: 'ENOENT' });
});

test('malformed hashes fail before operation admission', async t => {
  const { handler } = await fixture(t);
  for (const expectedHash of ['', null, 5, 'a'.repeat(63), 'G'.repeat(64)]) {
    let admitted = 0;
    const result = await handler(call({ action: 'write', path: 'code.cjs', text: 'x', expectedHash }), { onOperationDispatch: () => { admitted++; } });
    assert.equal(result.success, false);
    assert.equal(body(result).code, 'WORKSPACE_WRITE_HASH_INVALID');
    assert.equal(body(result).actionDispatched, false);
    assert.equal(admitted, 0);
  }
});

test('expected hash is checked after an awaited admission changes the target', async t => {
  const { cwd, handler } = await fixture(t);
  const target = path.join(cwd, 'code.cjs');
  await writeFile(target, 'before admission');
  const result = await handler(call({ action: 'write', path: 'code.cjs', text: 'must not save', expectedHash: hash('before admission') }), {
    onOperationDispatch: async () => { await writeFile(target, 'changed during admission'); }
  });
  assert.equal(result.success, false);
  assert.equal(body(result).code, 'WORKSPACE_WRITE_CONFLICT');
  assert.equal(await readFile(target, 'utf8'), 'changed during admission');
});

test('protected-path checks still win before guarded-write admission', async t => {
  const { cwd } = await fixture(t);
  const target = path.join(cwd, 'managed.cjs');
  await writeFile(target, 'protected');
  let admitted = 0;
  const handler = createWorkspaceToolHandler({ cwd, protectedPaths: [target] });
  const result = await handler(call({ action: 'write', path: target, text: 'changed', expectedHash: hash('protected') }), {
    onOperationDispatch: () => { admitted++; }
  });
  assert.equal(result.success, false);
  assert.equal(body(result).code, 'WORKSPACE_PROTECTED_PATH');
  assert.equal(admitted, 0);
  assert.equal(await readFile(target, 'utf8'), 'protected');
});

test('empty existing file is distinct from an absent expected target', async t => {
  const { cwd, handler } = await fixture(t);
  await writeFile(path.join(cwd, 'empty.cjs'), '');
  const result = await handler(call({ action: 'write', path: 'empty.cjs', text: 'saved', expectedHash: hash('') }));
  assert.equal(result.success, true);
  assert.equal(await readFile(path.join(cwd, 'empty.cjs'), 'utf8'), 'saved');
});

test('cancelled guarded write preserves the current file', async t => {
  const { cwd, handler } = await fixture(t);
  await writeFile(path.join(cwd, 'code.cjs'), 'current');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(handler(call({ action: 'write', path: 'code.cjs', text: 'changed', expectedHash: hash('current') }), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await readFile(path.join(cwd, 'code.cjs'), 'utf8'), 'current');
});

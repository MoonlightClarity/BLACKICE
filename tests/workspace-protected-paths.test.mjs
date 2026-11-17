import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { FilePatchStore } from '../lib/file-patches.mjs';

const call = arguments_ => ({ name: 'relay_workspace', arguments: arguments_ });
const parsed = response => JSON.parse(response.contentItems[0].text);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-protected-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), cwd = path.join(root, 'project');
  await mkdir(profile); await mkdir(cwd);
  const user = path.join(profile, 'USER.md');
  await writeFile(user, 'owner text');
  const patchStore = new FilePatchStore({ dataDir: root });
  let admissions = 0;
  const events = [];
  const handler = createWorkspaceToolHandler({ cwd, patchStore, protectedPaths: [user], onEvent: event => events.push(event) });
  const deny = async args => {
    const result = await handler(call(args), { onOperationDispatch: () => { admissions++; } });
    assert.equal(result.success, false);
    assert.equal(parsed(result).code, 'WORKSPACE_PROTECTED_PATH');
    assert.equal(parsed(result).actionDispatched, false);
    assert.equal(admissions, 0); assert.equal(events.length, 0);
  };
  return { root, profile, cwd, user, patchStore, handler, deny };
}

test('protected paths reject writes, patches and saved-receipt undo before admission', async t => {
  const { user, profile, cwd, patchStore, handler, deny } = await fixture(t);
  await deny({ action: 'write', path: user, text: 'changed' });
  await deny({ action: 'write', cwd: profile, path: './sub/../USER.md', text: 'changed' });
  await deny({ action: 'patch', path: user, oldText: 'owner', newText: 'agent' });
  const receipt = await patchStore.patch({ cwd, path: user, oldText: 'owner', newText: 'human' });
  await deny({ action: 'undo_patch', patchId: receipt.id, path: 'unprotected-decoy.txt' });
  assert.equal(await readFile(user, 'utf8'), 'human text');
  assert.equal((await handler(call({ action: 'read', path: user }))).success, true);
  assert.equal((await handler(call({ action: 'patch_history', patchId: receipt.id }))).success, true);
});

test('protects canonical directory aliases, including absent targets below junctions', async t => {
  const { root, profile, user, cwd, deny } = await fixture(t);
  const alias = path.join(root, 'alias');
  await symlink(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await deny({ action: 'write', path: path.join(alias, 'USER.md'), text: 'changed' });
  await deny({ action: 'patch', path: path.join(alias, 'USER.md'), oldText: 'owner', newText: 'agent' });
  const absent = path.join(profile, 'new', 'USER.md');
  const handler = createWorkspaceToolHandler({ cwd, protectedPaths: [absent] });
  const denied = await handler(call({ action: 'write', path: path.join(alias, 'new', 'USER.md'), text: 'new' }));
  assert.equal(parsed(denied).code, 'WORKSPACE_PROTECTED_PATH');
  assert.equal(parsed(denied).actionDispatched, false);
  assert.equal(await readFile(user, 'utf8'), 'owner text');
  const inverse = createWorkspaceToolHandler({ cwd, protectedPaths: [path.join(alias, 'USER.md')] });
  assert.equal(parsed(await inverse(call({ action: 'write', path: user, text: 'changed' }))).code, 'WORKSPACE_PROTECTED_PATH');
});

test('Windows case variants cannot bypass protection', { skip: process.platform !== 'win32' }, async t => {
  const { user, deny } = await fixture(t);
  await deny({ action: 'write', path: user.toUpperCase(), text: 'changed' });
});

test('unrelated same-basename files and default unprotected handlers remain writable', async t => {
  const { cwd, user, handler } = await fixture(t);
  assert.equal((await handler(call({ action: 'write', path: 'USER.md', text: 'project documentation' }))).success, true);
  const direct = createWorkspaceToolHandler({ cwd });
  assert.equal((await direct(call({ action: 'write', path: user, text: 'explicit direct edit' }))).success, true);
  assert.equal(await readFile(user, 'utf8'), 'explicit direct edit');
});

test('rejects relative or invalid protected configuration', async t => {
  const { cwd } = await fixture(t);
  for (const protectedPaths of [['USER.md'], [null], 'USER.md']) {
    assert.throws(() => createWorkspaceToolHandler({ cwd, protectedPaths }), /absolute file paths/);
  }
});

test('directory protection includes history and new descendants, not prefix siblings', async t => {
  const { root, cwd, profile } = await fixture(t);
  const handler = createWorkspaceToolHandler({ cwd, protectedPaths: [profile] });
  for (const destination of [path.join(profile, 'USER.md'), path.join(profile, 'history', 'new.json')]) {
    const denied = await handler(call({ action: 'write', path: destination, text: 'changed' }));
    assert.equal(parsed(denied).code, 'WORKSPACE_PROTECTED_PATH');
    assert.equal(parsed(denied).actionDispatched, false);
  }
  assert.equal((await handler(call({ action: 'write', path: path.join(root, 'profile-extra', 'USER.md'), text: 'allowed' }))).success, true);
});

test('rechecks a junction retargeted during operation admission before any mutation', async t => {
  const { root, cwd, profile, user } = await fixture(t);
  const other = path.join(root, 'other');
  const alias = path.join(root, 'moving-alias');
  await mkdir(other);
  await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const events = [];
  const handler = createWorkspaceToolHandler({ cwd, protectedPaths: [profile], onEvent: event => events.push(event) });
  let admissions = 0;
  const denied = await handler(call({ action: 'write', path: path.join(alias, 'USER.md'), text: 'changed' }), {
    onOperationDispatch: async () => {
      admissions++;
      await rm(alias, { recursive: true });
      await symlink(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
    },
  });
  assert.equal(admissions, 1);
  assert.equal(parsed(denied).code, 'WORKSPACE_PROTECTED_PATH');
  assert.equal(parsed(denied).actionDispatched, false);
  assert.equal(events.length, 0);
  assert.equal(await readFile(user, 'utf8'), 'owner text');
});

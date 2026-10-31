import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';

const node = (request, id) => request.nodes.find(value => value.id === id);

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-atomic-rename-'));
  const store = new PlanningBrowserStore({ dataDir });
  t.after(async () => {
    await store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await store.init();
  const request = await store.create({
    conversationId: 'rename-fixture', title: 'Fictional route choice',
    objective: 'Retain the actual saved route decision.', cwd: dataDir
  });
  const state = await store.addNode(request.id, {
    id: 'left', kind: 'decision', title: 'Original route', prompt: 'Compare the available routes.'
  });
  const file = store.file(request.id);
  return { dataDir, store, state, file, beforeMain: await fs.readFile(file, 'utf8') };
}

function renameError(code, source, destination) {
  return Object.assign(new Error(`Injected ${code} while replacing a planning fixture`), {
    code, syscall: 'rename', path: source, dest: destination
  });
}

// This isolated suite is serial. Intercept only its exact destination and leave
// all other filesystem operations, including the real commit, unchanged.
async function withRenameInterceptor(destination, intercept, work) {
  const original = fs.rename;
  const calls = [];
  fs.rename = async function(source, target) {
    if (target !== destination) return original.call(this, source, target);
    if (calls.length) assert.equal(source, calls[0].source, 'retry must retain the same temporary file');
    assert.equal(target, destination);
    calls.push({ source, destination: target });
    return intercept({
      source, destination: target, attempt: calls.length,
      commit: () => original.call(this, source, target)
    });
  };
  try { return await work(calls); }
  finally { fs.rename = original; }
}

async function assertNoTemporaryFiles(f) {
  assert.deepEqual((await fs.readdir(f.store.requestDirectory)).filter(name => name.endsWith('.tmp')), []);
}

describe('planning browser atomic replacement', { concurrency: false }, () => {
  for (const scenario of [
    { label: 'request', suffix: '', codes: ['EPERM', 'EBUSY'] },
    { label: 'backup', suffix: '.bak', codes: ['EACCES', 'EPERM'] }
  ]) {
    test(`retries transient ${scenario.label} rename failures without replacing the old bytes early`, async t => {
      const f = await fixture(t), destination = f.file + scenario.suffix;
      const oldBytes = await fs.readFile(destination, 'utf8');
      let replacementBytes;
      await withRenameInterceptor(destination, async ({ source, destination, attempt, commit }) => {
        assert.equal(await fs.readFile(destination, 'utf8'), oldBytes, 'live destination must remain intact until commit');
        const bytes = await fs.readFile(source, 'utf8');
        if (replacementBytes === undefined) replacementBytes = bytes;
        else assert.equal(bytes, replacementBytes, 'retry must retain the already flushed replacement');
        if (attempt <= scenario.codes.length) throw renameError(scenario.codes[attempt - 1], source, destination);
        return commit();
      }, async calls => {
        const saved = await f.store.updateNode(f.state.id, 'left', { title: 'Updated route' }, {
          expectedNodeRevision: node(f.state, 'left').revision
        });
        assert.equal(calls.length, 3, 'two refused renames must recover on the third attempt');
        assert.equal(saved.revision, f.state.revision + 1);
        assert.equal(node(saved, 'left').revision, node(f.state, 'left').revision + 1);
        assert.equal(node(saved, 'left').title, 'Updated route');
      });
      assert.equal(await fs.readFile(destination, 'utf8'), replacementBytes);
      assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), f.beforeMain);
      assert.equal(node(await f.store.get(f.state.id), 'left').title, 'Updated route');
      await assertNoTemporaryFiles(f);
    });
  }

  for (const scenario of [
    { label: 'request', suffix: '' },
    { label: 'backup', suffix: '.bak' }
  ]) {
    test(`persistent ${scenario.label} rename failure remains bounded and preserves the original error and saved bytes`, async t => {
      const f = await fixture(t), destination = f.file + scenario.suffix;
      const oldBytes = await fs.readFile(destination, 'utf8');
      let injected, replacementBytes;
      await withRenameInterceptor(destination, async ({ source, destination }) => {
        assert.equal(await fs.readFile(destination, 'utf8'), oldBytes);
        const bytes = await fs.readFile(source, 'utf8');
        if (replacementBytes === undefined) replacementBytes = bytes;
        else assert.equal(bytes, replacementBytes);
        injected ||= renameError('EPERM', source, destination);
        throw injected;
      }, async calls => {
        await assert.rejects(f.store.updateNode(f.state.id, 'left', { title: 'Uncommitted route' }, {
          expectedNodeRevision: node(f.state, 'left').revision
        }), error => {
          assert.strictEqual(error, injected, 'do not replace the filesystem error with an apparent success or wrapper');
          return true;
        });
        assert.equal(calls.length, 6, 'use the existing bounded rename retry contract');
      });
      assert.equal(await fs.readFile(destination, 'utf8'), oldBytes);
      assert.equal(await fs.readFile(f.file, 'utf8'), f.beforeMain);
      const saved = await f.store.get(f.state.id);
      assert.equal(saved.revision, f.state.revision);
      assert.equal(node(saved, 'left').revision, node(f.state, 'left').revision);
      assert.equal(node(saved, 'left').title, 'Original route');
      await assertNoTemporaryFiles(f);
    });
  }

  test('does not retry or mask a nontransient rename failure', async t => {
    const f = await fixture(t);
    let injected;
    await withRenameInterceptor(f.file, async ({ source, destination }) => {
      injected ||= renameError('EIO', source, destination);
      throw injected;
    }, async calls => {
      await assert.rejects(f.store.updateNode(f.state.id, 'left', { title: 'Uncommitted route' }, {
        expectedNodeRevision: node(f.state, 'left').revision
      }), error => {
        assert.strictEqual(error, injected);
        return true;
      });
      assert.equal(calls.length, 1);
    });
    assert.equal(await fs.readFile(f.file, 'utf8'), f.beforeMain);
    await assertNoTemporaryFiles(f);
  });

  test('two real store instances still retain independent edits and reject the stale same-node update', async t => {
    const f = await fixture(t);
    let state = await f.store.addNode(f.state.id, {
      id: 'right', kind: 'decision', title: 'Other route', prompt: 'Compare another route.'
    });
    const other = new PlanningBrowserStore({ dataDir: f.dataDir });
    await other.init();
    t.after(() => other.close());
    await Promise.all([
      f.store.updateNode(state.id, 'left', { title: 'Left improved' }, { expectedNodeRevision: node(state, 'left').revision }),
      other.updateNode(state.id, 'right', { title: 'Right improved' }, { expectedNodeRevision: node(state, 'right').revision })
    ]);
    state = await f.store.get(state.id);
    assert.equal(node(state, 'left').title, 'Left improved');
    assert.equal(node(state, 'right').title, 'Right improved');
    const revision = node(state, 'left').revision;
    const settled = await Promise.allSettled([
      f.store.updateNode(state.id, 'left', { prompt: 'First competing edit' }, { expectedNodeRevision: revision }),
      other.updateNode(state.id, 'left', { prompt: 'Second competing edit' }, { expectedNodeRevision: revision })
    ]);
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(settled.find(result => result.status === 'rejected').reason.code, 'PLANNING_NODE_CONFLICT');
    const saved = await f.store.get(state.id);
    assert.equal(node(saved, 'left').revision, revision + 1);
    assert(['First competing edit', 'Second competing edit'].includes(node(saved, 'left').prompt));
    await assertNoTemporaryFiles(f);
  });
});

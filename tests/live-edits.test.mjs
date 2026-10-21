import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveEditJournal, buildTextDiff, validateObservePresentation } from '../lib/live-edits.mjs';

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-live-edits-')), cwd = path.join(base, 'workspace'), dataDir = path.join(base, 'data'), events = [];
  await fs.mkdir(cwd); await fs.mkdir(dataDir);
  const journal = new LiveEditJournal({ dataDir, pollMs: 80, debounceMs: 15, onEvent: (runId, event) => events.push({ runId, ...event }), ...options });
  t.after(async () => { await journal.close(); await fs.rm(base, { recursive: true, force: true }); });
  return { base, cwd, dataDir, journal, events, write: (file, text) => fs.writeFile(path.join(cwd, file), text) };
}

test('actual file writes produce precise diff evidence from a fresh baseline, not pre-entry changes', async t => {
  const f = await fixture(t); await f.write('report.txt', 'one\ntwo\nthree\n');
  const ready = await f.journal.start('actual-run', { cwd: f.cwd });
  assert.equal(ready.sequence, 0); assert.deepEqual(ready.events, []);
  await f.write('report.txt', 'one\nTWO\nthree\n'); const snapshot = await f.journal.flush('actual-run');
  assert.equal(snapshot.events.length, 1); const edit = snapshot.events[0];
  assert.equal(edit.source, 'filesystem'); assert.equal(edit.path, 'report.txt'); assert.equal(edit.change, 'modified'); assert.equal(edit.sequence, 1);
  assert.equal(edit.beforeHash, createHash('sha256').update('one\ntwo\nthree\n').digest('hex'));
  assert.deepEqual(edit.diff.hunks[0].lines.filter(line => line.kind !== 'context'), [{ kind: 'remove', oldLine: 2, newLine: null, text: 'two' }, { kind: 'add', oldLine: null, newLine: 2, text: 'TWO' }]);
  assert.equal(f.events.length, 1);
  await f.journal.forget('actual-run'); await f.write('report.txt', 'changed while not watching\n');
  assert.equal(await f.journal.get('actual-run'), null); assert.equal(f.journal.runs.size, 0);
  const next = await f.journal.start('actual-run', { cwd: f.cwd }); assert.equal(next.sequence, 0); assert.deepEqual(next.events, []);
  await f.write('report.txt', 'new live edit\n'); const second = await f.journal.flush('actual-run');
  assert.equal(second.events[0].diff.hunks[0].lines.find(line => line.kind === 'remove').text, 'changed while not watching');
  assert.deepEqual(await fs.readdir(f.dataDir), [], 'no edit payload or baseline is persisted');
});

test('created, atomic-replaced, and deleted files remain actual disk changes with monotonically increasing sequences', async t => {
  const f = await fixture(t); await f.journal.start('changes', { cwd: f.cwd });
  await f.write('new.txt', 'first\n'); await f.journal.flush('changes');
  await f.write('replacement.tmp', 'second\n'); await fs.rename(path.join(f.cwd, 'replacement.tmp'), path.join(f.cwd, 'new.txt')); await f.journal.flush('changes');
  await fs.rm(path.join(f.cwd, 'new.txt')); const value = await f.journal.flush('changes');
  // The real watcher can also observe replacement.tmp under machine load. Its
  // truthful creation/deletion must not make the logical-file assertions race.
  const target = value.events.filter(event => event.path === 'new.txt');
  assert.deepEqual(target.map(event => event.change), ['created', 'modified', 'deleted']);
  assert.ok(value.events.every((event, index) => event.sequence === index + 1));
  assert.equal(target[2].afterHash, null); assert.equal(target[2].diff.removed, 1);
});

test('stop closes observation immediately, forget frees buffers, and aborted baseline does not leave a watcher', async t => {
  const f = await fixture(t); await f.write('code.txt', 'before'); await f.journal.start('stopped', { cwd: f.cwd });
  await f.write('code.txt', 'pending change'); const stopping = f.journal.stop('stopped');
  assert.equal(f.journal.runs.get('stopped').active, false);
  await stopping; await f.write('code.txt', 'after close'); await delay(140);
  assert.equal(f.events.length, 0); assert.equal((await f.journal.flush('stopped')).sequence, 0);
  await f.journal.forget('stopped'); assert.equal(f.journal.snapshot('stopped'), null); assert.equal(f.journal.runs.size, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.journal.start('aborted', { cwd: f.cwd, signal: controller.signal }), { name: 'AbortError' }); assert.equal(f.journal.runs.size, 0);
});

test('ignored paths, traversal, symbolic links, binary files, and bounded content cannot leak into text diffs', async t => {
  const f = await fixture(t, { limits: { fileBytes: 64, baselineBytes: 128 } });
  await fs.mkdir(path.join(f.cwd, 'node_modules')); await fs.writeFile(path.join(f.cwd, 'node_modules', 'hidden.txt'), 'ignored');
  await f.write('image.bin', Buffer.from([0, 1, 2])); await f.write('.env', 'SECRET=before'); await f.write('large.txt', 'a'.repeat(100));
  const outside = path.join(f.base, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.txt'), 'OUTSIDE_PRIVATE');
  let linked = false; try { await fs.symlink(outside, path.join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true; } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  const ready = await f.journal.start('bounds', { cwd: f.cwd }), state = f.journal.runs.get('bounds');
  assert.equal(ready.coverage.files, 3); assert.equal(f.journal.safeRelative(state, '../outside/private.txt'), null); assert.equal(f.journal.safeRelative(state, 'C:\\outside\\private.txt'), null);
  if (linked) assert.equal(await f.journal.read(state, 'linked/private.txt'), null);
  await f.write('image.bin', Buffer.from([0, 3, 4])); await f.write('.env', 'SECRET=after'); await f.write('large.txt', 'b'.repeat(110));
  const value = await f.journal.flush('bounds'); assert.equal(value.events.length, 3);
  for (const event of value.events) { assert.equal(event.diff, null); assert.ok(event.contentOmitted); }
  assert.ok(!JSON.stringify(value.events).includes('SECRET=')); assert.ok(!JSON.stringify(value).includes('OUTSIDE_PRIVATE'));
});

test('journal and diff bounds are explicit rather than implying missing edits were displayed', async t => {
  const f = await fixture(t, { limits: { events: 2, diffLines: 4, diffChars: 50 } }); await f.journal.start('bounded', { cwd: f.cwd });
  for (let index = 0; index < 4; index++) { await f.write('file.txt', Array.from({ length: 15 }, (_, line) => `${index}-${line}`).join('\n')); await f.journal.flush('bounded'); }
  const value = f.journal.snapshot('bounded', { limit: 100 }); assert.equal(value.events.length, 2); assert.equal(value.truncated, true); assert.equal(value.firstSequence, 3); assert.equal(value.sequence, 4);
  for (const event of value.events) { assert.equal(event.diff.truncated, true); assert.ok(event.diff.hunks.flatMap(hunk => hunk.lines).length <= 4); }
});

for (const route of ['explicit flush', 'watcher during rescan', 'watcher without filename', 'polling fallback']) {
  test(`${route} verifies same-size rewritten bytes even when filesystem timestamps collide`, async t => {
    const f = await fixture(t, { pollMs: 60000, debounceMs: 60000 }); await f.write('rapid.txt', 'first\n'); await f.journal.start('coarse-timestamp', { cwd: f.cwd });
    const state = f.journal.runs.get('coarse-timestamp'); state.watcher?.close(); state.watcher = null;
    await f.write('rapid.txt', 'other\n');
    const stat = await fs.stat(path.join(f.cwd, 'rapid.txt'));
    // Deterministically model the real coarse timestamp collision: the cached
    // metadata matches the new disk file while its prior text/hash stay intact.
    state.baseline.get('rapid.txt').signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    state.dirty.clear(); state.rescan = true;
    if (route === 'watcher during rescan') state.dirty.add('rapid.txt');
    if (route === 'watcher without filename') { f.journal.queueChange(state, null); assert.equal(state.forceContent, true); clearTimeout(state.scanTimer); state.scanTimer = null; }
    if (route === 'polling fallback') state.coverage.mode = 'poll';
    const value = route === 'explicit flush' ? await f.journal.flush('coarse-timestamp') : (await f.journal._flush(state), f.journal.snapshot('coarse-timestamp'));
    assert.equal(value.sequence, 1); assert.equal(value.events.length, 1);
    const edit = value.events[0]; assert.equal(edit.change, 'modified'); assert.notEqual(edit.beforeHash, edit.afterHash);
    assert.deepEqual(edit.diff.hunks[0].lines.filter(line => line.kind !== 'context').map(line => [line.kind, line.text]), [['remove', 'first'], ['add', 'other']]);
    assert.equal(state.baseline.get('rapid.txt').text, 'other\n');
    assert.equal(state.forceContent, false, 'an unknown-path hint is consumed only by the flush that verifies it');
    await f.journal.flush('coarse-timestamp'); assert.equal(f.journal.snapshot('coarse-timestamp').sequence, 1, 'identical actual bytes do not invent duplicate edits');
  });
}

test('real watcher emits without manual rescan and cancellation prevents later emissions', async t => {
  const f = await fixture(t); const controller = new AbortController(); await f.journal.start('watcher', { cwd: f.cwd, signal: controller.signal });
  await f.write('watched.txt', 'actual watched write');
  for (let attempt = 0; attempt < 40 && !f.events.length; attempt++) await delay(25);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].path, 'watched.txt');
  controller.abort(); await f.journal.stop('watcher'); const count = f.events.length; await f.write('watched.txt', 'after cancel'); await delay(120); assert.equal(f.events.length, count);
});

test('a default workspace inside the app data directory remains observable', async t => {
  const f = await fixture(t); const journal = new LiveEditJournal({ dataDir: f.base }); t.after(() => journal.close());
  await f.write('normal.txt', 'before'); await journal.start('default-workspace', { cwd: f.cwd });
  await f.write('normal.txt', 'after'); const value = await journal.flush('default-workspace'); assert.equal(value.events.length, 1); assert.equal(value.events[0].path, 'normal.txt');
});

test('presentation schema accepts a layout choice but never model supplied evidence or traversal', () => {
  assert.deepEqual(validateObservePresentation({ version: 1, title: 'Writing the report', focus: 'edits', file: 'src/app.mjs', stepIds: ['write'], showAgents: false }), { version: 1, title: 'Writing the report', focus: 'edits', file: 'src/app.mjs', stepIds: ['write'], showAgents: false });
  for (const value of [{ diff: 'invented changes' }, { html: '<script>' }, { completed: true }, { file: '../outside.txt' }, { file: 'C:\\private.txt' }, { stepIds: ['same', 'same'] }, { focus: 'fake' }, { showAgents: 'yes' }, { version: 2 }]) assert.throws(() => validateObservePresentation(value));
  const diff = buildTextDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl');
  assert.equal(diff.added, 2); assert.equal(diff.removed, 2); assert.equal(diff.hunks.length, 2); assert.equal(diff.hunks[1].lines.find(line => line.kind === 'add').newLine, 11);
});

test('SVG previews contain only complete actual after-file bytes observed after entry and are freed on leave', async t => {
  const f = await fixture(t), initial = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red" width="20" height="20"/></svg>', changed = initial.replace('red', 'blue');
  await f.write('art.svg', initial); const ready = await f.journal.start('svg-live', { cwd: f.cwd });
  assert.deepEqual(ready.events, [], 'existing images are never preloaded into Observe');
  await f.write('art.svg', changed); let snapshot = await f.journal.flush('svg-live');
  const event = snapshot.events.find(entry => entry.path === 'art.svg'); assert.deepEqual(event.preview, { type: 'svg', text: changed });
  assert.equal(event.source, 'filesystem'); assert.equal(event.bytes.after, Buffer.byteLength(changed)); assert.equal(event.diff.truncated, false);
  assert.equal(event.afterHash, createHash('sha256').update(changed).digest('hex')); assert.notEqual(event.preview.text, initial);
  await fs.rm(path.join(f.cwd, 'art.svg')); snapshot = await f.journal.flush('svg-live'); assert.equal(snapshot.events.at(-1).change, 'deleted'); assert.equal(snapshot.events.at(-1).preview, undefined);
  await f.journal.forget('svg-live'); assert.equal(f.journal.snapshot('svg-live'), null); assert.equal(f.journal.runs.size, 0);
  assert.deepEqual(await fs.readdir(f.dataDir), [], 'SVG previews are not persisted');
});

test('unsafe, sensitive, incomplete, oversize and shortened SVG edits retain their truthful diff without an image', async t => {
  const f = await fixture(t); await f.journal.start('svg-omitted', { cwd: f.cwd });
  const wrap = value => `<svg xmlns="http://www.w3.org/2000/svg">${value}</svg>`;
  const files = {
    'unsafe.svg': wrap('<rect onload="alert(1)"/>'), '.env.visual.svg': wrap('<rect/>'),
    'unfinished.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect',
    'oversize.svg': wrap(Array.from({ length: 80 }, () => `<desc>${'x'.repeat(430)}</desc>`).join('\n')),
    'shortened.svg': wrap(`<desc>${'x'.repeat(2500)}</desc>`),
  };
  for (const [name, text] of Object.entries(files)) await f.write(name, text);
  const snapshot = await f.journal.flush('svg-omitted');
  for (const [name] of Object.entries(files)) { const entry = snapshot.events.find(event => event.path === name); assert.ok(entry, name); assert.equal(entry.preview, undefined, name); }
  assert.equal(snapshot.events.find(event => event.path === '.env.visual.svg').contentOmitted, 'sensitive-file');
  assert.equal(snapshot.events.find(event => event.path === 'shortened.svg').diff.truncated, true);
  assert.equal(snapshot.events.find(event => event.path === 'oversize.svg').diff.truncated, false, 'the source-byte bound also applies when a diff itself fits');
});

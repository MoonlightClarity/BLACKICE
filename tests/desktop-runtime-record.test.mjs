import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { writeDesktopRuntimeRecord } from '../desktop/runtime-record.mjs';

const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const errorFor = code => Object.assign(new Error(`Fixture ${code}`), { code });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-runtime-record-')), file = path.join(directory, 'desktop-runtime.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file };
}
async function mainWriter(directory, write) {
  // Exercise the actual main-process chain without starting Electron or a profile.
  const source = await fs.readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const declaration = source.match(/function saveRuntimeRecord\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(declaration, 'main keeps its runtime publication function');
  const errors = [], state = { mode: 'background', restart: 'scheduled' };
  const context = {
    runtimeRecord: { pid: 123, revision: 1 }, runtimeWriteChain: Promise.resolve(), hardRestartIdentity: null,
    desktopLifecycle: { status: () => ({ mode: state.mode }) }, desktopRestart: { status: () => ({ status: state.restart }) },
    app: { getPath: key => { assert.equal(key, 'userData'); return directory; } }, path,
    writeDesktopRuntimeRecord: write,
    diagnostics: { recordError: async (...args) => { errors.push(args); } },
  };
  return { save: runInNewContext(`${declaration}\nsaveRuntimeRecord;`, context), context, state, errors };
}

test('transient Windows rename failures retain the old complete snapshot until atomic publication succeeds', async t => {
  const { file } = await fixture(t), previous = JSON.stringify({ pid: 123, complete: 'old' }), next = JSON.stringify({ pid: 456, complete: 'new' });
  await fs.writeFile(file, previous);
  const delays = [], codes = ['EPERM', 'EACCES', 'EBUSY']; let renames = 0, writes = 0;
  const io = {
    writeFile: async (...args) => { writes++; await fs.writeFile(...args); },
    rename: async (...args) => {
      assert.equal(await fs.readFile(file, 'utf8'), previous); assert.equal(await fs.readFile(file + '.tmp', 'utf8'), next);
      const code = codes[renames++]; if (code) throw errorFor(code);
      await fs.rename(...args);
    },
  };
  await writeDesktopRuntimeRecord(file, next, { io, platform: 'win32', wait: async milliseconds => { delays.push(milliseconds); assert.equal(await fs.readFile(file, 'utf8'), previous); } });
  assert.deepEqual(delays, [25, 50, 100]); assert.equal(renames, 4); assert.equal(writes, 1);
  assert.equal(await fs.readFile(file, 'utf8'), next); await assert.rejects(fs.stat(file + '.tmp'), { code: 'ENOENT' });
});

test('persistent Windows rename refusal is bounded and never removes the previous snapshot', async t => {
  const { file } = await fixture(t), previous = '{"revision":1}', next = '{"revision":2}', error = errorFor('EPERM');
  await fs.writeFile(file, previous);
  const delays = []; let renames = 0;
  const io = { writeFile: fs.writeFile, rename: async () => { renames++; throw error; } };
  await assert.rejects(writeDesktopRuntimeRecord(file, next, { io, platform: 'win32', wait: async value => { delays.push(value); } }), actual => actual === error);
  assert.equal(renames, 7); assert.deepEqual(delays, [25, 50, 100, 200, 400, 800]); assert.equal(delays.reduce((sum, value) => sum + value, 0), 1575);
  assert.equal(await fs.readFile(file, 'utf8'), previous); assert.equal(await fs.readFile(file + '.tmp', 'utf8'), next);
});

test('unrelated filesystem errors and non-Windows failures are not retried', async t => {
  const { file } = await fixture(t);
  for (const [platform, code] of [['win32', 'EIO'], ['win32', 'ENOENT'], ['linux', 'EPERM']]) {
    const error = errorFor(code); let renames = 0, waits = 0;
    await assert.rejects(writeDesktopRuntimeRecord(file, '{}', {
      platform, io: { writeFile: fs.writeFile, rename: async () => { renames++; throw error; } }, wait: async () => { waits++; },
    }), actual => actual === error);
    assert.equal(renames, 1); assert.equal(waits, 0);
  }
});

test('a failed temporary write never attempts to publish or touches the old snapshot', async t => {
  const { file } = await fixture(t), previous = '{"revision":1}', error = errorFor('ENOSPC'); await fs.writeFile(file, previous);
  let renames = 0, waits = 0;
  await assert.rejects(writeDesktopRuntimeRecord(file, '{"revision":2}', {
    platform: 'win32', io: { writeFile: async () => { throw error; }, rename: async () => { renames++; } }, wait: async () => { waits++; },
  }), actual => actual === error);
  assert.equal(renames, 0); assert.equal(waits, 0); assert.equal(await fs.readFile(file, 'utf8'), previous);
});

test('main serializes writes across rename retries and publishes the latest captured snapshot last', async t => {
  const { directory, file } = await fixture(t), retrying = held(), resume = held(); t.after(() => resume.resolve());
  await fs.writeFile(file, '{"revision":0}');
  const published = []; let writes = 0, renames = 0;
  const io = {
    writeFile: async (...args) => { writes++; await fs.writeFile(...args); },
    rename: async (...args) => { if (++renames === 1) throw errorFor('EBUSY'); published.push(JSON.parse(await fs.readFile(args[0], 'utf8'))); await fs.rename(...args); },
  };
  const f = await mainWriter(directory, (target, contents) => writeDesktopRuntimeRecord(target, contents, { io, platform: 'win32', wait: async () => { retrying.resolve(); await resume.promise; } }));
  const first = f.save(); await retrying.promise;
  f.context.runtimeRecord.revision = 2; f.state.mode = 'headless'; f.state.restart = 'completed';
  const second = f.save(); f.context.runtimeRecord.revision = 999; f.state.mode = 'window';
  assert.equal(writes, 1); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { revision: 0 });
  resume.resolve(); await Promise.all([first, second]);
  assert.deepEqual(published.map(value => [value.revision, value.lifecycle.mode, value.restart.status]), [[1, 'background', 'scheduled'], [2, 'headless', 'completed']]);
  const last = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(last.revision, 2); assert.equal(last.lifecycle.mode, 'headless'); assert.equal(last.restart.status, 'completed');
  assert.equal(writes, 2); assert.deepEqual(f.errors, []);
});

test('main records a terminal write failure with an allowed event and later publications still succeed', async t => {
  const { directory, file } = await fixture(t), failure = errorFor('EIO'); let writes = 0;
  const io = { writeFile: async (...args) => { if (++writes === 1) throw failure; await fs.writeFile(...args); }, rename: fs.rename };
  const f = await mainWriter(directory, (target, contents) => writeDesktopRuntimeRecord(target, contents, { io }));
  await f.save(); assert.equal(f.errors.length, 1); assert.deepEqual(f.errors[0], ['desktop', 'storage_failed', failure]);
  f.context.runtimeRecord.revision = 2; await f.save();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).revision, 2); assert.equal(f.errors.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createWindowsSession } from '../lib/windows-session.mjs';

function harness(t, respond) {
  const children = [], spawns = [];
  const session = createWindowsSession({
    spawnImpl(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.killed = false; child.killCount = 0; child.writes = [];
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          child.writes.push(chunk.toString('utf8'));
          callback();
          respond?.(child, JSON.parse(chunk.toString('utf8')), children.length - 1);
        },
      });
      child.kill = () => { child.killed = true; child.killCount++; return true; };
      child.reply = value => child.stdout.write(`${JSON.stringify(value)}\n`);
      children.push(child); spawns.push({ command, args, options });
      return child;
    },
  });
  t.after(() => session.close());
  return { session, children, spawns };
}

test('native session reuses one hidden worker and frames Unicode requests and fragmented responses', async t => {
  const { session, children, spawns } = harness(t, (child, value) => {
    if (value.action === 'windows') {
      child.stdout.write('\uFEFF\r\n  \n\uFEFF{"ok":true,"win');
      child.stdout.write('dows":[{"title":"Editor λ🚀"}]}\r\n');
    } else child.reply({ ok: true, text: value.text });
  });
  assert.deepEqual(await session({ action: 'windows' }), { windows: [{ title: 'Editor λ🚀' }] });
  const text = 'First line\nUnicode λ🚀\nQuotes " and backslash \\';
  assert.deepEqual(await session({ action: 'type', text }), { text });
  assert.equal(children.length, 1, 'subsequent requests use the warm worker');
  assert.equal(children[0].writes.length, 2);
  assert.equal(children[0].writes[1].split('\n').length, 2, 'embedded newlines remain inside one JSON record');
  assert.equal(spawns[0].command, 'powershell.exe');
  assert.ok(spawns[0].args.includes('-Stream'));
  assert.ok(spawns[0].args.includes('-Mta'),'UI Automation runs away from the application UI thread');
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(spawns[0].options.shell, false);
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('native session refuses overlapping requests without disturbing its active operation', async t => {
  const { session, children } = harness(t);
  const first = session({ action: 'windows' });
  await assert.rejects(session({ action: 'screenshot' }), /already in progress/);
  assert.equal(children.length, 1);
  assert.equal(children[0].writes.length, 1, 'overlap never reaches native input');
  children[0].reply({ ok: true, windows: [] });
  assert.deepEqual(await first, { windows: [] });
  assert.equal(children[0].killed, false);
});

test('an already cancelled request never creates a native worker', async t => {
  const { session, children } = harness(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(session({ action: 'windows' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(children.length, 0);
});

test('cancellation kills the worker and a fresh request ignores all late events from the old worker', async t => {
  const { session, children } = harness(t);
  const controller = new AbortController();
  const first = session({ action: 'screenshot' }, { signal: controller.signal });
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  controller.abort(); await cancelled;
  const old = children[0];
  assert.equal(old.killCount, 1);
  assert.equal(old.stdin.writableEnded, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const next = session({ action: 'windows' });
  assert.equal(children.length, 2);
  old.reply({ ok: true, windows: [{ title: 'stale response' }] });
  old.emit('close', 0); old.emit('error', new Error('late old error'));
  old.stdin.emit('error', new Error('late old stdin error'));
  assert.equal(children[1].killed, false, 'old process callbacks cannot stop the new worker');
  children[1].reply({ ok: true, windows: [{ title: 'fresh response' }] });
  assert.deepEqual(await next, { windows: [{ title: 'fresh response' }] });
});

test('closing an active session rejects pending work, removes abort listeners and releases the worker once', async t => {
  const { session, children } = harness(t);
  const controller = new AbortController();
  const pending = session({ action: 'windows' }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  session.close(); session.close();
  await rejected;
  assert.equal(children[0].stdin.writableEnded, true);
  assert.equal(children[0].killCount, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const restarted = session({ action: 'windows' });
  children[1].reply({ ok: true, windows: [] });
  await restarted;
  session.close();
  assert.equal(children[1].killCount, 1, 'reattached desktop releases its replacement worker');
});

test('timed out native work kills its worker and does not poison the next request', async t => {
  const { session, children } = harness(t);
  await assert.rejects(session({ action: 'screenshot' }, { timeoutMs: 10 }), /timed out/);
  assert.equal(children[0].killed, true);
  const next = session({ action: 'windows' });
  assert.equal(children.length, 2);
  children[1].reply({ ok: true, windows: [] });
  assert.deepEqual(await next, { windows: [] });
});

test('native operation errors and malformed JSON reject only that response and leave the warm session usable', async t => {
  const { session, children } = harness(t);
  const nativeError = session({ action: 'focus', handle: '123' });
  children[0].reply({ ok: false, error: 'Window no longer exists.' });
  await assert.rejects(nativeError, /Window no longer exists/);
  const malformed = session({ action: 'windows' });
  children[0].stdout.write('not valid JSON\n');
  await assert.rejects(malformed, /invalid response/);
  const missingSuccess = session({ action: 'windows' });
  children[0].reply({ windows: [] });
  await assert.rejects(missingSuccess, /Windows desktop operation failed/);
  const recovered = session({ action: 'windows' });
  children[0].stderr.write('a native diagnostic that is not a protocol response');
  children[0].reply({ ok: true, windows: [] });
  assert.deepEqual(await recovered, { windows: [] });
  assert.equal(children.length, 1);
});

for (const source of ['spawn', 'stdin', 'close']) {
  test(`native worker ${source} failure rejects pending work and permits a replacement`, async t => {
    const { session, children } = harness(t);
    const pending = session({ action: 'windows' });
    if (source === 'spawn') children[0].emit('error', new Error('powershell missing'));
    else if (source === 'stdin') children[0].stdin.emit('error', new Error('broken pipe'));
    else children[0].emit('close', 23);
    await assert.rejects(pending, source === 'spawn' ? /could not start: powershell missing/ : source === 'stdin' ? /input failed: broken pipe/ : /stopped \(23\)/);
    assert.equal(children[0].killed, true);
    const next = session({ action: 'windows' });
    children[1].reply({ ok: true, windows: [] });
    assert.deepEqual(await next, { windows: [] });
  });
}

test('oversized native responses terminate the worker before it can retain unbounded output', async t => {
  const { session, children } = harness(t);
  const pending = session({ action: 'screenshot' });
  children[0].stdout.write('x'.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(pending, /exceeded its size limit/);
  assert.equal(children[0].killed, true);
  const next = session({ action: 'windows' });
  children[1].reply({ ok: true, windows: [] });
  assert.deepEqual(await next, { windows: [] });
});

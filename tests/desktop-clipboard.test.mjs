import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createClipboardHandler, isTrustedDesktopSender, MAX_CLIPBOARD_CHARS } from '../desktop/clipboard.mjs';
import { MAX_CLIPBOARD_CHARS as BROWSER_MAX } from '../public/clipboard.mjs';

function boundary() {
  const mainFrame = { url: 'http://127.0.0.1:4317/' }, webContents = { mainFrame };
  const mainWindow = { webContents, isDestroyed: () => false }, origin = 'http://127.0.0.1:4317';
  const event = { sender: webContents, senderFrame: mainFrame }, writes = [];
  const handler = createClipboardHandler({ trustedSender: value => isTrustedDesktopSender(value, mainWindow, origin), writeText: text => writes.push(text) });
  return { mainFrame, webContents, mainWindow, origin, event, writes, handler };
}

test('only the current BLACKICE main frame at its exact loopback origin can write', () => {
  const f = boundary();
  for (const url of [f.origin + '/', f.origin + '/index.html']) {
    f.mainFrame.url = url; assert.deepEqual(f.handler(f.event, 'Exact value'), { copied: true });
  }
  assert.deepEqual(f.writes, ['Exact value', 'Exact value']);
  for (const event of [undefined, {}, { ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.origin + '/' } }]) assert.throws(() => f.handler(event, 'unauthorized'), /not allowed/);
  for (const url of ['https://remote.example/', 'http://127.0.0.1:4318/', f.origin + '/other', 'data:text/html,anything', 'not a URL']) {
    f.mainFrame.url = url; assert.throws(() => f.handler(f.event, 'unauthorized'), /not allowed/);
  }
  f.mainFrame.url = f.origin + '/'; f.mainWindow.isDestroyed = () => true;
  assert.throws(() => f.handler(f.event, 'unauthorized'), /not allowed/);
  assert.equal(isTrustedDesktopSender(f.event, undefined, f.origin), false); assert.equal(f.writes.length, 2);
});

test('native clipboard accepts one bounded string and rejects arbitrary arguments before writing', () => {
  const f = boundary(); assert.equal(MAX_CLIPBOARD_CHARS, BROWSER_MAX);
  const bound = 'a'.repeat(MAX_CLIPBOARD_CHARS);
  assert.deepEqual(f.handler(f.event, bound), { copied: true }); assert.equal(f.writes[0], bound);
  for (const args of [[], [''], [null], [42], [{}], [new String('text')], ['text', 'second'], [bound + 'a']]) assert.throws(() => f.handler(f.event, ...args), /clipboard size limit/);
  assert.equal(f.writes.length, 1);
});

test('native clipboard exceptions produce no success or reflected payload', () => {
  const f = boundary(), handler = createClipboardHandler({ trustedSender: () => true, writeText: () => { throw new Error('fixture-credential-payload'); } });
  assert.throws(() => handler(f.event, 'fixture-credential-payload'), error => {
    assert.equal(error.message, 'The desktop clipboard is unavailable. Try copying again.');
    assert.equal(error.cause, undefined); return true;
  });
  let invoked = false;
  const blocked = createClipboardHandler({ trustedSender: () => false, writeText: () => { invoked = true; } });
  assert.throws(() => blocked(f.event, 'text'), /not allowed/); assert.equal(invoked, false);
});

test('the actual isolated preload exposes one bounded write channel and no clipboard reader', async () => {
  const source = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8'), calls = [];
  let exposed;
  vm.runInNewContext(source, {
    process: { argv: ['app', '--relay-version=fixture'], platform: 'win32' },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'relayDesktop'); exposed = value; } }, ipcRenderer: { invoke: async (...args) => { calls.push(args); return { copied: true }; } } };
    },
  });
  assert.ok(Object.isFrozen(exposed)); assert.equal(typeof exposed.writeClipboard, 'function');
  assert.deepEqual(Object.keys(exposed).filter(name => /clipboard|readText|writeText|invoke|send/i.test(name)), ['writeClipboard']);
  assert.deepEqual(await exposed.writeClipboard('Exact supplied copy'), { copied: true });
  assert.deepEqual(calls, [['relay:write-clipboard', 'Exact supplied copy']]);
  for (const value of ['', undefined, {}, 'a'.repeat(MAX_CLIPBOARD_CHARS + 1)]) await assert.rejects(exposed.writeClipboard(value), /clipboard size limit/);
  assert.equal(calls.length, 1);
});

test('desktop wiring retains denied Chromium permissions and registers only the scoped native writer', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /ipcMain\.handle\('relay:write-clipboard', createClipboardHandler\(\{ trustedSender, writeText: text => clipboard\.writeText\(text\) \}\)\)/);
  assert.match(source, /return isTrustedDesktopSender\(event, mainWindow, origin\)/);
  assert.match(source, /setPermissionRequestHandler\([^\n]*callback\(false\)/);
  assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.doesNotMatch(source, /clipboard\.(?:read|readText|readHTML|readImage|availableFormats)\s*\(/);
});

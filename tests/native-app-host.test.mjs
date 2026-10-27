import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeAppHost, nativeHandle } from '../desktop/native-app-host.mjs';

class Helper extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stdin = new EventEmitter();
    this.messages = [];
    this.killed = false;
    this.stdin.write = line => {
      const message = JSON.parse(line);
      this.messages.push(message);
      const results = {
        windows: [{ id: '374828', title: 'Unlisted application', process: 'unlisted.exe', pid: 234 }],
        attach: { attached: true, visible: true, windowId: message.windowId, title: 'Unlisted application', isolated: false },
        position: { attached: true, visible: true },
        show: { attached: true, visible: true },
        hide: { attached: true, visible: false },
        dialogs: [{ id: '332245', title: 'Save As', process: 'Dialog', pid: 234 }],
        detach: { attached: false, visible: false },
        status: { attached: true, visible: true, title: 'Unlisted application', windowId: '374828' },
      };
      queueMicrotask(() => this.stdout.emit('data', JSON.stringify({
        requestId: message.requestId, ok: true, result: results[message.action],
      }) + '\n'));
    };
    this.stdin.end = () => {};
  }
  kill() { this.killed = true; this.emit('close', 0); }
}

function fixture() {
  const instances = [];
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(777888n);
  const host = new NativeAppHost({
    platform: 'win32', ownerPid: 1111, getWindow: () => ({ getNativeWindowHandle: () => handle }),
    spawnImpl: () => { const child = new Helper(); instances.push(child); return child; },
  });
  return { host, instances };
}

test('HWND from Electron resolves as a real native 64-bit window handle', () => {
  const data = Buffer.alloc(8); data.writeBigUInt64LE(0x12345678n);
  assert.equal(nativeHandle({ getNativeWindowHandle: () => data }), String(0x12345678n));
  assert.throws(() => nativeHandle({ getNativeWindowHandle: () => Buffer.alloc(0) }));
});

test('retired native application embedding cannot be launched from the production BLACKICE entry points', async () => {
  const {readFile} = await import('node:fs/promises');
  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../public/next/index.html', import.meta.url), 'utf8');
  assert.match(main, /nativeWindows:null/);
  assert.doesNotMatch(main, /new NativeAppWorkspace\(|new NativeAppHost\(/);
  assert.doesNotMatch(preload, /relay:native-apps/);
  assert.doesNotMatch(shell, /data-space="applications"/);
});
test('an unobserved or invalid handle cannot accidentally embed a different application', async () => {
  const { host } = fixture();
  await assert.rejects(host.attach('55555', { x: 0, y: 0, width: 400, height: 300 }), /Refresh the window list/);
  await assert.rejects(host.attach('374828', { x: -12, y: 0, width: 400, height: 300 }), /Invalid native application x/);
  await host.close();
});

test('native Windows embedding stays unavailable on non-Windows hosts', async () => {
  const host = new NativeAppHost({ platform: 'linux', getWindow: () => null });
  assert.equal(host.availability().available, false);
  await assert.rejects(host.windows(), /Windows desktop/);
});

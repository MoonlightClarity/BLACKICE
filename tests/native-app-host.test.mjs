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

test('ordinary Windows applications embed without a supported-app allowlist or isolation', async () => {
  const { host, instances } = fixture();
  assert.deepEqual(host.availability().isolated, false);
  const windows = await host.windows();
  assert.equal(windows[0].process, 'unlisted.exe');
  const dimensions = { x: 55, y: 170, width: 900, height: 500 };
  const joined = await host.attach('374828', dimensions);
  assert.equal(joined.attached, true);
  assert.equal(joined.isolated, false);
  assert.equal(host.attached, true);
  const attached = instances[0].messages.find(value => value.action === 'attach');
  assert.equal(attached.windowId, '374828');
  assert.equal(attached.hostWindowId, '777888');
  assert.equal(attached.x, 55);
  assert.equal(attached.height, 500);
  assert.equal(instances[0].messages.find(value => value.action === 'windows').excludePid, 1111);
  assert.deepEqual((await host.dialogs()).map(value => value.title), ['Save As']);
  assert.equal((await host.visibleState(false)).visible, false);
  assert.equal((await host.visibleState(true)).visible, true);
  await host.position({ ...dimensions, width: 880 });
  assert.equal(instances[0].messages.find(value => value.action === 'position').width, 880);
  await host.detach();
  assert.equal(host.attached, false);
  await host.close();
  assert.equal(instances[0].killed, true, 'Only the window manager helper terminates.');
  assert.equal(instances[0].messages.some(value => value.action === 'terminate'), false);
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

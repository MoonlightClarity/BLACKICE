import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../desktop/browser-compatibility/main.js', import.meta.url), 'utf8');
const install = context => vm.runInContext(source, context);

function fixture() {
  const context = vm.createContext({});
  vm.runInContext(`
    class DOMException extends Error { constructor(message, name) { super(message); this.name = name; } }
    class FileSystemFileHandle {
      get kind() { return 'native-file'; }
      get name() { return 'native-name'; }
    }
    class Input {
      constructor() { this.type = 'text'; this.multiple = false; this.hidden = false; this.tabIndex = 0; this.accept = ''; this.files = []; this.listeners = new Map(); this.attributes = new Map(); this.connected = false; this.removed = false; }
      setAttribute(name, value) { this.attributes.set(name, value); }
      addEventListener(name, listener) { let values = this.listeners.get(name); if (!values) this.listeners.set(name, values = new Set()); values.add(listener); }
      removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
      dispatch(name) { for (const listener of [...(this.listeners.get(name) || [])]) listener({ type: name, target: this }); }
      click() { clicks++; opened = this; }
      remove() { this.connected = false; this.removed = true; }
    }
    let clicks = 0, opened = null, nativeCalls = 0;
    const document = {
      createElement(name) { if (name !== 'input') throw new Error('Unexpected element'); return new Input(); },
      documentElement: { append(input) { input.connected = true; } },
      body: null,
    };
    async function nativeShowOpenFilePicker() { nativeCalls++; return []; }
    Object.defineProperty(globalThis, 'showOpenFilePicker', { configurable: true, enumerable: false, writable: true, value: nativeShowOpenFilePicker });
    Object.assign(globalThis, { DOMException, document, FileSystemFileHandle, Input });
    const originalInputClick = Input.prototype.click;
  `, context);
  install(context);
  return context;
}

test('File System Access selection becomes an exact private input and returns read-only file handles', async () => {
  const context = fixture();
  const promise = vm.runInContext(`showOpenFilePicker({ multiple: true, types: [{ accept: { 'application/pdf': ['.pdf', '.PDF'] } }] })`, context);
  assert.equal(vm.runInContext('nativeCalls', context), 0);
  assert.equal(vm.runInContext('clicks', context), 1);
  assert.equal(vm.runInContext(`opened.type === 'file' && opened.multiple && opened.hidden && opened.tabIndex === -1 && opened.connected`, context), true);
  assert.equal(vm.runInContext(`opened.attributes.has('data-blackice-contained-file-picker')`, context), true);
  assert.equal(vm.runInContext('opened.accept', context), 'application/pdf,.pdf,.PDF');

  vm.runInContext(`selectedFile = Object.freeze({ name: 'resume.pdf', size: 161514, type: 'application/pdf' }); opened.files = [selectedFile]; opened.dispatch('input'); opened.dispatch('change');`, context);
  const handles = await promise;
  assert.equal(handles.length, 1); assert.equal(handles[0].kind, 'file'); assert.equal(handles[0].name, 'resume.pdf');
  context.selectedHandle = handles[0];
  assert.equal(vm.runInContext('selectedHandle instanceof FileSystemFileHandle', context), true);
  assert.equal(await handles[0].getFile(), vm.runInContext('selectedFile', context));
  assert.equal(await handles[0].isSameEntry(handles[0]), true); assert.equal(await handles[0].isSameEntry({}), false);
  assert.equal(await handles[0].queryPermission(), 'granted'); assert.equal(await handles[0].requestPermission({ mode: 'readwrite' }), 'denied');
  await assert.rejects(handles[0].createWritable(), { name: 'NotAllowedError' });
  assert.equal(vm.runInContext('opened.removed && !opened.connected', context), true);
  assert.equal(vm.runInContext('Input.prototype.click === originalInputClick', context), true, 'Ordinary file inputs retain their native behavior.');
  assert.equal(Object.hasOwn(handles[0], 'path'), false);
});

test('cancelled and repeated pickers settle once without reusing stale selection state', async () => {
  const context = fixture();
  const cancelled = vm.runInContext('showOpenFilePicker()', context);
  vm.runInContext(`firstInput = opened; opened.dispatch('cancel')`, context);
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(vm.runInContext('firstInput.removed', context), true);

  const first = vm.runInContext('showOpenFilePicker()', context);
  vm.runInContext('replacedInput = opened', context);
  const second = vm.runInContext('showOpenFilePicker({ multiple: false })', context);
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(vm.runInContext('replacedInput.removed && opened !== replacedInput', context), true);
  vm.runInContext(`freshInput = opened; freshFile = { name: 'fresh.pdf', size: 7, type: 'application/pdf' }; freshInput.files = [freshFile]; freshInput.dispatch('change'); freshInput.dispatch('cancel')`, context);
  const handles = await second;
  assert.equal(handles.length, 1); assert.equal(handles[0].name, 'fresh.pdf');
  assert.equal(vm.runInContext('freshInput.removed', context), true);
});

test('an empty input event cancels the contained picker and malformed options never open one', async () => {
  const context = fixture();
  const empty = vm.runInContext('showOpenFilePicker()', context);
  vm.runInContext(`opened.files = []; opened.dispatch('input')`, context);
  await assert.rejects(empty, { name: 'AbortError' });
  const before = vm.runInContext('clicks', context);
  for (const expression of [
    'showOpenFilePicker(null)',
    'showOpenFilePicker({ multiple: "yes" })',
    'showOpenFilePicker({ types: {} })',
    'showOpenFilePicker({ types: [{ accept: { "application/pdf": ["pdf"] } }] })',
  ]) await assert.rejects(vm.runInContext(expression, context), reason => reason?.name === 'TypeError');
  assert.equal(vm.runInContext('clicks', context), before);
});

test('the compatibility layer does not invent a picker or a page-to-host bridge', () => {
  for (const initial of ['', 'globalThis.showOpenFilePicker = undefined;']) {
    const context = vm.createContext({}); vm.runInContext(initial, context);
    const before = vm.runInContext('Reflect.ownKeys(globalThis)', context);
    install(context);
    assert.deepEqual(vm.runInContext('Reflect.ownKeys(globalThis)', context), before);
    assert.equal(vm.runInContext(`typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined'`, context), true);
  }
});

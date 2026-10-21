import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const canonicalURL = process.env.BLACKICE_UPLOAD_REPO_ROOT
  ? pathToFileURL(path.join(process.env.BLACKICE_UPLOAD_REPO_ROOT, 'desktop', 'browser-driver.mjs'))
  : new URL('../desktop/browser-driver.mjs', import.meta.url);
const candidateURL = process.env.BLACKICE_UPLOAD_DRIVER_PATH
  ? pathToFileURL(process.env.BLACKICE_UPLOAD_DRIVER_PATH)
  : canonicalURL;
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { transformReceipt, exception = false, behavior, assignmentFailure = false, cdpResponse } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-upload-regression-'));
  const windows = [], session = new EventEmitter();
  session.cookies = new EventEmitter();
  session.webRequest = { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} };
  session.setPermissionRequestHandler = () => {}; session.setPermissionCheckHandler = () => {};
  session.flushStorageData = async () => {};
  class DataTransfer {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  }
  let selection = [];
  const input = { isConnected: true, tagName: 'INPUT', type: 'file', disabled: false, webkitdirectory: false, multiple: true, received: [], events: [], appState: '', alert: '', getAttribute: () => null,
    get files() { return selection; }, set files(value) { selection = assignmentFailure ? [] : value; },
    dispatchEvent(event) {
      this.events.push(event.type);
      if (event.type === 'input') this.received = [...this.files];
      if (event.type === 'change' && behavior === 'consume') { this.appState = `${this.files[0].name}; Remove file`; selection = []; }
      if (event.type === 'change' && behavior === 'reject') { this.alert = 'You have chosen incorrect file type!'; selection = []; }
      if (event.type === 'change' && behavior === 'replace') selection = [new File(['site replacement'], 'site-copy.txt', { type: 'text/plain' })];
      return true;
    } };
  const context = vm.createContext({ File, DataTransfer, Event, atob, Uint8Array, selectedInput: input });
  const transform = value => clone(transformReceipt ? transformReceipt(clone(value)) : value);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.protocol = []; windows.push(this);
      const contents = this.webContents = new EventEmitter(), debugger_ = contents.debugger = new EventEmitter();
      debugger_.attached = false; debugger_.isAttached = () => debugger_.attached;
      debugger_.attach = () => { debugger_.attached = true; };
      debugger_.sendCommand = async (method, params) => {
        this.protocol.push({ method, params });
        if (method === 'DOM.resolveNode') return { object: { objectId: 'fixture-input' } };
        if (method === 'Runtime.callFunctionOn') {
          if (cdpResponse) return cdpResponse();
          if (exception) return { exceptionDetails: { text: 'Uncaught fixture page rejection' } };
          context.payload = params.arguments[0].value;
          return { result: { value: transform(vm.runInContext(`(${params.functionDeclaration}).call(selectedInput, payload)`, context)) } };
        }
        return {};
      };
      contents.isOffscreen = () => true; contents.isDestroyed = () => this.destroyed;
      contents.getURL = () => this.url || ''; contents.getTitle = () => 'Upload regression fixture';
      contents.isLoading = () => false; contents.isLoadingMainFrame = () => false;
      contents.mainFrame = { processId: 1, routingId: 1, framesInSubtree: [], executeJavaScript: async script => {
        if (script.startsWith('(function elementAction')) return transform(vm.runInContext(script, context));
        return { title: 'Upload regression fixture', url: this.url, elements: input.alert ? [{ role: 'alert', name: input.alert }] : [], text: ['Owned fixture', input.appState, input.alert].filter(Boolean).join('\n'), readyState: 'complete' };
      } };
      contents.setWindowOpenHandler = () => {}; contents.loadURL = async url => { this.url = url; };
      contents.capturePage = async () => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }), toDataURL: () => 'data:image/png;base64,fixture' });
    }
    removeMenu() {} isDestroyed() { return this.destroyed; } isVisible() { return false; } isFocusable() { return false; }
    show() { assert.fail('Fixture must not show a native window'); } focus() { assert.fail('Fixture must not focus a native window'); }
    hide() {} destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  let source = await readFile(candidateURL, 'utf8');
  const key = '__uploadRegression_' + randomUUID().replaceAll('-', '');
  source = source.replace("import { BrowserWindow, session } from 'electron';", `const { BrowserWindow, session } = globalThis[${JSON.stringify(key)}];`)
    .replace(/from '(\.\.?\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, canonicalURL).href}'`);
  globalThis[key] = { BrowserWindow: Window, session: { fromPartition: () => session } };
  let ElectronBrowserDriver;
  try { ({ ElectronBrowserDriver } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))); }
  finally { delete globalThis[key]; }
  const driver = new ElectronBrowserDriver({ dataDir: directory, downloadDir: path.join(directory, 'downloads') });
  const tab = driver.newTab('https://upload.example.test/'); await tab.loading;
  context[driver.key] = { elements: new Map([['observed-file', input]]) };
  t.after(async () => { await driver.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^blackice-upload-regression-/); await rm(directory, { recursive: true, force: true }); });
  return { driver, tab, input, directory, windows };
}

async function requestFor(f, mode, names = ['resume.PDF']) {
  const bytes = Buffer.from('%PDF-1.7\nfixture bytes: \x00\xff\n%%EOF\n', 'latin1');
  const files = names.map(name => path.join(f.directory, name));
  for (const file of files) await writeFile(file, bytes);
  if (mode === 'chooser') {
    f.windows[0].webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectMultiple' }); await tick();
    const pending = f.tab.pendingInteraction;
    return { request: { action: 'upload', tabId: f.tab.id, chooserId: pending.id, expectedUrl: pending.url, expectedDocumentId: pending.documentId, paths: files }, bytes };
  }
  f.tab.refs.set('observed-file', f.tab.window.webContents.mainFrame);
  return { request: { action: 'upload', tabId: f.tab.id, ref: 'observed-file', expectedUrl: f.tab.window.url, expectedDocumentId: `${f.tab.id}:${f.tab.revision}`, paths: files }, bytes };
}

for (const mode of ['ref', 'chooser']) {
  test(`${mode}: actual driver constructs byte-identical PDF File and truthful name/type/size receipt`, async t => {
    const f = await fixture(t), { request, bytes } = await requestFor(f, mode);
    const result = await f.driver.perform(request);
    assert.equal(f.input.received.length, 1);
    const file = f.input.received[0];
    assert.ok(file instanceof File); assert.equal(file.name, 'resume.PDF'); assert.equal(file.type, 'application/pdf'); assert.equal(file.size, bytes.length);
    assert.equal(digest(Buffer.from(await file.arrayBuffer())), digest(bytes));
    assert.deepEqual(clone(result.receipt.uploaded), [{ name: file.name, size: file.size, type: file.type }]);
    assert.deepEqual(clone(result.receipt.delivered), clone(result.receipt.uploaded));
    assert.deepEqual(clone(result.receipt.retained), clone(result.receipt.uploaded));
    assert.equal(result.receipt.deliveryVerified, true); assert.equal(result.receipt.inputSelection, 'retained');
    assert.equal(result.receipt.siteAcceptance, 'unconfirmed'); assert.equal(result.receipt.inspectBeforeContinuing, true);
    assert.equal(Object.hasOwn(result.receipt, 'warning'), false);
    assert.deepEqual(f.input.events, ['input', 'change']);
    if (mode === 'chooser') assert.equal(f.tab.pendingInteraction, null);
  });
  for (const behavior of ['consume', 'reject']) test(`${mode}: ${behavior} handler can clear the input; delivery is verified while site acceptance remains unconfirmed`, async t => {
    const f = await fixture(t, { behavior }), { request, bytes } = await requestFor(f, mode);
    const result = await f.driver.perform(request), receipt = result.receipt;
    assert.equal(f.input.received.length, 1); assert.equal(f.input.files.length, 0);
    assert.deepEqual(clone(receipt.delivered), [{ name: 'resume.PDF', size: bytes.length, type: 'application/pdf' }]);
    assert.deepEqual(clone(receipt.retained), []); assert.equal(receipt.deliveryVerified, true);
    assert.equal(receipt.inputSelection, 'cleared_by_page'); assert.equal(receipt.siteAcceptance, 'unconfirmed'); assert.equal(receipt.inspectBeforeContinuing, true);
    assert.equal(Object.hasOwn(receipt, 'uploaded'), false); assert.equal(typeof receipt.warning, 'string');
    if (behavior === 'consume') assert.match(result.frames[0].text, /resume.PDF; Remove file/);
    else { assert.match(result.frames[0].text, /incorrect file type/); assert.equal(result.frames[0].elements[0].role, 'alert'); }
    if (mode === 'chooser') assert.equal(f.tab.pendingInteraction, null);
  });
  test(`${mode}: page replaces input selection and receipt preserves delivery separately`, async t => {
    const f = await fixture(t, { behavior: 'replace' }), { request, bytes } = await requestFor(f, mode);
    const { receipt } = await f.driver.perform(request);
    assert.deepEqual(clone(receipt.delivered), [{ name: 'resume.PDF', size: bytes.length, type: 'application/pdf' }]);
    assert.deepEqual(clone(receipt.retained), [{ name: 'site-copy.txt', size: Buffer.byteLength('site replacement'), type: 'text/plain' }]);
    assert.equal(receipt.inputSelection, 'changed_by_page'); assert.equal(receipt.deliveryVerified, true);
    assert.equal(receipt.siteAcceptance, 'unconfirmed'); assert.equal(receipt.inspectBeforeContinuing, true);
    assert.equal(Object.hasOwn(receipt, 'uploaded'), false); assert.equal(typeof receipt.warning, 'string');
  });
  test(`${mode}: failed assignment cannot dispatch site events or claim delivery`, async t => {
    const f = await fixture(t, { assignmentFailure: true }), { request } = await requestFor(f, mode);
    await assert.rejects(f.driver.perform(request), { code: 'BROWSER_UPLOAD_REJECTED' });
    assert.deepEqual(f.input.events, []); assert.deepEqual(f.input.received, []);
  });
  test(`${mode}: untrusted page receipt cannot promote delivery into site acceptance`, async t => {
    const f = await fixture(t, { behavior: 'consume', transformReceipt: value => ({ ...value, uploadedSuccess: true, siteAcceptance: 'accepted', inputSelection: 'retained', deliveryVerified: false, inspectBeforeContinuing: false }) });
    const { request } = await requestFor(f, mode), { receipt } = await f.driver.perform(request);
    assert.equal(receipt.siteAcceptance, 'unconfirmed'); assert.equal(receipt.inputSelection, 'cleared_by_page');
    assert.equal(receipt.deliveryVerified, true); assert.equal(receipt.inspectBeforeContinuing, true);
    assert.equal(Object.hasOwn(receipt, 'uploaded'), false); assert.equal(Object.hasOwn(receipt, 'uploadedSuccess'), false);
  });
  for (const [label, transformReceipt] of [
    ['missing receipt', () => undefined], ['null receipt', () => null],
    ['legacy empty uploaded-only receipt', () => ({ uploaded: [] })],
    ['legacy uploaded metadata without delivery proof', value => ({ uploaded: value.uploaded, eventsDispatched: true })],
    ['missing delivery field', value => { delete value.delivered; return value; }], ['malformed delivery field', value => ({ ...value, delivered: true })],
    ['empty delivery list', value => ({ ...value, delivered: [] })],
    ['partial delivery list', value => ({ ...value, delivered: value.delivered.slice(0, 1) })],
    ['extra delivered file', value => ({ ...value, delivered: [...value.delivered, value.delivered[0]] })],
    ['null delivery entry', value => ({ ...value, delivered: value.delivered.map((file, index) => index ? file : null) })],
    ['sparse delivery entry', value => { delete value.delivered[0]; return value; }],
    ['wrong delivered filename', value => ({ ...value, delivered: value.delivered.map(file => ({ ...file, name: 'other.pdf' })) })],
    ['wrong delivered MIME type', value => ({ ...value, delivered: value.delivered.map(file => ({ ...file, type: '' })) })],
    ['wrong delivered size', value => ({ ...value, delivered: value.delivered.map(file => ({ ...file, size: file.size + 1 })) })],
    ['missing events confirmation', value => { delete value.eventsDispatched; return value; }],
    ['false events confirmation', value => ({ ...value, eventsDispatched: false })],
    ['string events confirmation', value => ({ ...value, eventsDispatched: 'true' })],
    ['missing retained field', value => { delete value.uploaded; return value; }],
    ['malformed retained field', value => ({ ...value, uploaded: true })],
    ['null retained entry', value => ({ ...value, uploaded: [null] })],
    ['sparse retained entry', value => { delete value.uploaded[0]; return value; }],
    ['non-string retained filename', value => ({ ...value, uploaded: [{ name: 1, size: 1, type: 'text/plain' }] })],
    ['negative retained size', value => ({ ...value, uploaded: [{ name: 'site.txt', size: -1, type: 'text/plain' }] })],
    ['non-string retained MIME type', value => ({ ...value, uploaded: [{ name: 'site.txt', size: 1, type: null }] })],
  ]) test(`${mode}: host validation rejects ${label}`, async t => {
    const f = await fixture(t, { transformReceipt }), { request } = await requestFor(f, mode, ['first.pdf', 'second.pdf']);
    await assert.rejects(f.driver.perform(request), { code: 'BROWSER_UPLOAD_REJECTED' });
    if (mode === 'chooser') assert.equal(f.tab.pendingInteraction, null);
  });
}

test('chooser: CDP exception is a failure and always consumes/releases the handled chooser', async t => {
  const f = await fixture(t, { exception: true }), { request } = await requestFor(f, 'chooser');
  await assert.rejects(f.driver.perform(request), { code: 'BROWSER_UPLOAD_REJECTED' });
  assert.equal(f.tab.pendingInteraction, null);
  assert.ok(f.windows[0].protocol.some(call => call.method === 'Runtime.releaseObject'));
  assert.equal(f.input.received.length, 0);
});

for (const [label, response] of [['null', null], ['empty', {}], ['malformed result', { result: { type: 'undefined' } }]]) {
  test(`chooser: ${label} CDP response is rejected with a truthful upload error`, async t => {
    const f = await fixture(t, { cdpResponse: () => response }), { request } = await requestFor(f, 'chooser');
    await assert.rejects(f.driver.perform(request), { code: 'BROWSER_UPLOAD_REJECTED' });
    assert.equal(f.tab.pendingInteraction, null);
    assert.ok(f.windows[0].protocol.some(call => call.method === 'Runtime.releaseObject'));
  });
}

test('extension mapping is case-insensitive and unknown bytes retain binary fallback without renaming', async t => {
  const f = await fixture(t), { request } = await requestFor(f, 'ref', ['cv.DOCX', 'attachment.unknown']);
  const result = await f.driver.perform(request);
  assert.equal(f.input.received[0].type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(f.input.received[1].type, 'application/octet-stream');
  assert.deepEqual(result.receipt.uploaded.map(file => file.name), ['cv.DOCX', 'attachment.unknown']);
});


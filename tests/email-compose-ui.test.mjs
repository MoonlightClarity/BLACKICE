import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { initEmailUI, emailDeliveryCopy } from '../public/email-ui.mjs';
import { AgentEmailStore } from '../lib/agent-email.mjs';
import { parseEmailMessage } from '../lib/email-message.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const lost = () => Object.assign(Error('Response lost'), { uncertain: true, status: 503 });
const decode = value => String(value).replaceAll('&quot;', '\"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
function makeDocument() {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {}; this.dataset = {}; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this._text = ''; this.listeners = new Map(); this.classList = { add() {} }; }
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      if (name === 'value') this.value = value;
      if (['disabled', 'hidden', 'checked'].includes(name)) this[name] = true;
    }
    matches(selector) {
      if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
      if (selector.startsWith('.')) return (this.attributes.class || '').split(/\s+/).includes(selector.slice(1));
      if (selector.startsWith('[')) { const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || []; return name && Object.hasOwn(this.attributes, name) && (value === undefined || this.attributes[name] === value); }
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(value => value.trim()), found = [];
      for (const child of this.children) { if (selectors.some(value => child.matches(value))) found.push(child); found.push(...child.querySelectorAll(selector)); }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener) { this.listeners.set(type, [...this.listeners.get(type) || [], listener]); }
    async dispatch(type, event = {}) {
      event.target ||= this; event.preventDefault ||= () => {};
      for (const listener of this.listeners.get(type) || []) await listener(event);
      const result = await this[`on${type}`]?.(event);
      if (type === 'input' && this.parentNode) await this.parentNode.dispatch(type, event);
      return result;
    }
    set textContent(value) { this.children = []; this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(source) {
      this.children = []; this._text = ''; const stack = [this];
      for (const match of source.matchAll(/<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)\b([^>]*)>|([^<]+)/gi)) {
        if (match[1]) { if (stack.length > 1) { const node = stack.pop(); if (node.tagName === 'TEXTAREA') node.value = node.textContent; } }
        else if (match[2]) {
          const node = new Element(match[2]);
          for (const attribute of match[3].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1], decode(attribute[2] || ''));
          node.parentNode = stack.at(-1); node.parentNode.children.push(node);
          if (!['INPUT', 'BR', 'IMG', 'HR', 'META', 'LINK'].includes(node.tagName)) stack.push(node);
        } else stack.at(-1)._text += decode(match[4] || '');
      }
    }
  }
  const body = new Element('body');
  return { body, getElementById: id => body.querySelector(`#${id}`), querySelector: selector => body.querySelector(selector === '#modal-root .modal' ? '.modal' : selector) };
}

const memoryStorage = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; };
const status = () => ({ revision: 1, configured: true, enabled: true, config: { enabled: true, account: 'fixture', executable: '/fixture/mail', configPath: '/fixture/mail.toml' }, cli: { checked: true }, drafts: [], capabilities: { compose: true, send: true } });
const attachment = { fileName: '<résumé>.pdf', size: 2048, sha256: 'a'.repeat(64), contentType: 'application/pdf' };
function fixture(t, options = {}) {
  const previous = globalThis.document, document = makeDocument(), storage = options.storage || memoryStorage(), calls = [], saved = options.saved || new Map(); let ui;
  globalThis.document = document;
  const normal = async (url, request) => {
    if (url === '/api/email') return options.status || status();
    if (url === '/api/email/client') return { available: false };
    if (url === '/api/email/compose') {
      const input = request.body, prior = [...saved.values()].find(item => item.requestId === input.requestId);
      if (prior) return { delivery: structuredClone(prior) };
      const delivery = { ...input, id: `message-${saved.size + 1}`, state: 'prepared', sent: false, transportAccepted: false, recipientAcknowledged: false, attachments: input.attachments.map(() => ({ ...attachment })), messageId: '<fixture@example.test>', messageSha256: 'b'.repeat(64) };
      saved.set(delivery.id, delivery); return { delivery: structuredClone(delivery) };
    }
    if (url === '/api/email/send') {
      const item = saved.get(request.body.id); assert.ok(item);
      Object.assign(item, { state: 'sent', sent: true, transportAccepted: true, delivery: { state: 'sent', requestId: request.body.requestId, transportAccepted: true, recipientAcknowledged: false } });
      return { delivery: structuredClone(item) };
    }
    if (url === '/api/email/deliveries') return { deliveries: [...saved.values()].map(({ body, path, ...item }) => structuredClone(item)) };
    if (url.startsWith('/api/email/deliveries/')) return { delivery: structuredClone(saved.get(decodeURIComponent(url.split('/').at(-1)))) };
    if (url === '/api/email/drafts') return { draft: { id: 'local-draft' } };
    throw Error(`Unexpected request: ${url}`);
  };
  const api = async (url, request = {}) => { calls.push({ url, method: request.method || 'GET', body: structuredClone(request.body) }); return options.api ? options.api(url, request, () => normal(url, request)) : normal(url, request); };
  const create = () => initEmailUI({ api, storage, pickFiles: options.pickFiles, showModal(_id, html) { document.body.innerHTML = `<section class="modal">${html}</section>`; } });
  ui = create();
  t.after(() => { ui.cancel(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const get = id => document.getElementById(id);
  return { get ui() { return ui; }, document, get, calls, saved, storage,
    input: async (id, value) => { get(id).value = value; await get(id).dispatch('input'); },
    click: async id => { assert.equal(get(id).disabled, false, `${id} enabled`); return get(id).dispatch('click'); },
    mutations: () => calls.filter(item => item.method === 'POST'),
    recreate() { ui.cancel(); document.body.innerHTML = ''; ui = create(); return ui.open(); },
    close() { ui.cancel(); document.body.innerHTML = ''; }
  };
}
async function fill(f) {
  for (const [field, value] of Object.entries({ from: 'writer@example.test', to: 'one@example.test, two@example.test', cc: 'copy@example.test', bcc: 'hidden@example.test', subject: 'Literal <subject>', body: 'Hello\n<literal text>\nThanks' })) await f.input(`email-${field}`, value);
}

test('Send composes the exact message and chosen paths, then sends once and displays copied attachment metadata', async t => {
  let pickerCalls = 0;
  const f = fixture(t, { pickFiles: async () => { pickerCalls++; return { filePaths: ['C:\\files\\résumé.pdf'] }; } });
  await f.ui.open(); assert.equal(f.mutations().length, 0); await fill(f);
  await f.click('email-attachment-choose'); await f.input('email-attachment-path', '/files/notes.txt'); await f.click('email-attachment-add');
  await f.input('email-attachment-path', '/files/notes.txt'); await f.click('email-attachment-add');
  await f.click('email-send');
  assert.equal(pickerCalls, 1);
  const [compose, send] = f.mutations(); assert.equal(compose.url, '/api/email/compose'); assert.equal(send.url, '/api/email/send');
  const { requestId, ...fields } = compose.body;
  assert.match(requestId, /^[\w-]+$/); assert.deepEqual(fields, { from: 'writer@example.test', to: ['one@example.test', 'two@example.test'], cc: ['copy@example.test'], bcc: ['hidden@example.test'], subject: 'Literal <subject>', body: 'Hello\n<literal text>\nThanks', attachments: ['C:\\files\\résumé.pdf', '/files/notes.txt'] });
  assert.equal(send.body.id, 'message-1'); assert.notEqual(send.body.requestId, requestId);
  assert.match(f.get('email-send-status').textContent, /^Sent\..*mail service accepted.*Recipient receipt has not been confirmed/);
  assert.equal(f.get('email-send').disabled, true); assert.equal(f.get('email-body').readOnly, true);
  assert.match(f.get('email-compose-attachments').textContent, /<résumé>\.pdf.*2 KB.*application\/pdf.*SHA-256/);
  const durable = [...f.storage.values.values()].join(''); assert.doesNotMatch(durable, /writer@|hidden@|literal text|files|résumé|Literal/);
  assert.equal(f.calls.filter(item => item.url === '/api/email/client/open').length, 0);
});

test('one pending Send cannot dispatch a second compose or send and native form validity is honored', async t => {
  const pending = deferred();
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/compose' ? pending.promise.then(next) : next() });
  await f.ui.open(); await fill(f); f.get('email-draft-form').reportValidity = () => false; await f.click('email-send'); assert.equal(f.mutations().length, 0);
  f.get('email-draft-form').reportValidity = () => true;
  const sending = f.click('email-send'); await f.get('email-send').onclick(); assert.equal(f.get('email-send').disabled, true); assert.equal(f.mutations().length, 1);
  pending.resolve(); await sending; assert.equal(f.mutations().length, 2);
});

test('known compose rejection preserves editable text and paths, without claiming the message was sent', async t => {
  const f = fixture(t, { api: (url, request, next) => { if (url === '/api/email/compose') throw Object.assign(Error('Sender is not configured'), { status: 400 }); return next(); } });
  await f.ui.open(); await fill(f); await f.input('email-attachment-path', '/files/notes.txt'); await f.click('email-attachment-add'); await f.click('email-send');
  assert.match(f.get('email-send-status').textContent, /^Message not sent.*Sender is not configured/); assert.equal(f.get('email-body').readOnly, false);
  assert.equal(f.get('email-body').value, 'Hello\n<literal text>\nThanks'); assert.match(f.get('email-compose-attachments').textContent, /notes.txt/);
  assert.equal(f.mutations().filter(item => item.url === '/api/email/send').length, 0); assert.equal(f.storage.values.size, 0);
});

test('lost compose response reconciles the saved original and waits for a deliberate Send using the original send ID', async t => {
  let lose = true;
  const f = fixture(t, { api: async (url, request, next) => { const result = await next(); if (url === '/api/email/compose' && lose) { lose = false; throw lost(); } return result; } });
  await f.ui.open(); await fill(f); await f.click('email-send');
  assert.match(f.get('email-send-status').textContent, /^Delivery uncertain/); assert.equal(f.get('email-send').disabled, true);
  const savedRequest = JSON.parse([...f.storage.values.values()][0]);
  await f.click('email-delivery-check'); assert.match(f.get('email-send-status').textContent, /^Ready to send/);
  assert.equal(f.mutations().length, 1, 'a recovery read never sends');
  await f.click('email-send'); assert.equal(f.mutations().length, 2); assert.deepEqual(f.mutations()[1].body, { id: 'message-1', requestId: savedRequest.sendRequestId });
});

test('lost send acknowledgement survives UI recreation and recovers Sent without sending again', async t => {
  const f = fixture(t, { api: async (url, request, next) => { const result = await next(); if (url === '/api/email/send') throw lost(); return result; } });
  await f.ui.open(); await fill(f); await f.click('email-send'); assert.match(f.get('email-send-status').textContent, /^Delivery uncertain/);
  const original = f.mutations()[1].body;
  await f.recreate(); assert.match(f.get('email-send-status').textContent, /^Sent\./); assert.equal(f.mutations().length, 2);
  assert.equal(f.get('email-from').value, 'writer@example.test'); assert.equal(f.get('email-bcc').value, 'hidden@example.test'); assert.equal(f.get('email-body').value, 'Hello\n<literal text>\nThanks');
  assert.equal(JSON.parse([...f.storage.values.values()][0]).sendRequestId, original.requestId);
  await f.get('email-send').onclick(); assert.equal(f.mutations().length, 2);
});

test('an uncertain transport result stays uncertain, including delivery history, and refresh never retries', async t => {
  const f = fixture(t, { api: async (url, request, next) => {
    if (url !== '/api/email/send') return next();
    const item = f.saved.get(request.body.id); Object.assign(item, { state: 'uncertain', sent: false, transportAccepted: false, error: 'Connection ended' }); return { delivery: structuredClone(item) };
  } });
  await f.ui.open(); await fill(f); await f.click('email-send');
  assert.match(f.get('email-send-status').textContent, /^Delivery uncertain/); assert.match(f.get('email-deliveries').textContent, /Delivery uncertain/); assert.equal(f.get('email-send').disabled, true);
  await f.click('email-delivery-check'); assert.equal(f.mutations().length, 2); assert.doesNotMatch(f.get('email-send-status').textContent, /^Sent/);
  assert.equal(emailDeliveryCopy({ state: 'sent', sent: true, transportAccepted: false }).label, 'Delivery uncertain');
});

test('transport acceptance without a saved final receipt is not shown as a completed Sent delivery', async t => {
  const f = fixture(t, { api: async (url, request, next) => {
    if (url !== '/api/email/send') return next();
    const item = f.saved.get(request.body.id); Object.assign(item, { state: 'uncertain', sent: false, transportAccepted: true, persistenceFailed: true }); return { delivery: structuredClone(item) };
  } });
  await f.ui.open(); await fill(f); await f.click('email-send'); assert.match(f.get('email-send-status').textContent, /^Delivery uncertain\..*acceptance was reported.*final saved outcome is unconfirmed/); assert.equal(f.get('email-send').disabled, true); assert.equal(f.mutations().length, 2);
});

test('preflight send rejection leaves the composed message and retries with the same durable request ID', async t => {
  let reject = true;
  const f = fixture(t, { api: (url, request, next) => { if (url === '/api/email/send' && reject) { reject = false; throw Object.assign(Error('Account needs attention'), { status: 400 }); } return next(); } });
  await f.ui.open(); await fill(f); await f.click('email-send'); assert.match(f.get('email-send-status').textContent, /^Message not sent/); assert.equal(f.get('email-send').disabled, false);
  await f.click('email-send'); assert.deepEqual(f.mutations().map(item => item.url), ['/api/email/compose', '/api/email/send', '/api/email/send']); assert.deepEqual(f.mutations()[1].body, f.mutations()[2].body);
});

test('a provider queue acknowledgement remains Queued across reload and is never labeled Sent or retried', async t => {
  const f = fixture(t, { api: async (url, request, next) => {
    if (url !== '/api/email/send') return next();
    const item = f.saved.get(request.body.id); Object.assign(item, { state: 'queued', sent: false, transportAccepted: false, delivery: { state: 'queued', queueId: 'queue-1' } }); return { delivery: structuredClone(item) };
  } });
  await f.ui.open(); await fill(f); await f.click('email-send'); assert.match(f.get('email-send-status').textContent, /^Queued\..*later sending.*not been confirmed/); assert.equal(f.get('email-send').disabled, true);
  await f.recreate(); assert.match(f.get('email-send-status').textContent, /^Queued\./); assert.equal(f.get('email-send').textContent, 'Queued'); assert.equal(f.mutations().length, 2);
  assert.match(f.get('email-deliveries').textContent, /Queued/); assert.doesNotMatch(f.get('email-deliveries').textContent, /Sent/);
});

test('closing during compose never continues to send; reopening reconciles and retired Send handlers cannot act', async t => {
  const pending = deferred(); let first = true;
  const f = fixture(t, { api: async (url, request, next) => { const result = await next(); if (url === '/api/email/compose' && first) { first = false; await pending.promise; } return result; } });
  await f.ui.open(); await fill(f); const retired = f.get('email-send'); const sending = f.click('email-send'); await new Promise(resolve => setImmediate(resolve)); f.close();
  await f.ui.open(); assert.equal(f.mutations().length, 1); assert.match(f.get('email-send-status').textContent, /^Ready to send/);
  pending.resolve(); await sending; await retired.onclick(); assert.equal(f.mutations().length, 1);
});

test('attachment picker results belong to their originating message and relative paths are rejected', async t => {
  const pending = deferred();
  const f = fixture(t, { pickFiles: () => pending.promise }); await f.ui.open(); const picking = f.click('email-attachment-choose'); await f.click('email-draft-new'); pending.resolve(['/files/old.pdf']); await picking;
  assert.equal(f.get('email-compose-attachments').textContent, '');
  await f.input('email-attachment-path', 'relative.txt'); await f.click('email-attachment-add'); assert.match(f.get('email-send-status').textContent, /absolute path/); assert.equal(f.get('email-compose-attachments').textContent, '');
  await f.input('email-attachment-path', '/files/notes.txt'); await f.click('email-attachment-add'); await f.document.querySelector('[data-email-remove-attachment]').dispatch('click'); assert.equal(f.get('email-compose-attachments').textContent, '');
});

test('saved delivery preview shows exact literal metadata and content without a mail composer link', async t => {
  const f = fixture(t); f.saved.set('existing', { id: 'existing', requestId: 'prior', from: 'writer@example.test', to: ['one@example.test'], cc: [], bcc: [], subject: '<script>literal</script>', body: '<img src=x>literal', attachments: [attachment], state: 'prepared', sent: false });
  await f.ui.open(); await f.document.querySelector('[data-email-delivery]').dispatch('click');
  const preview = f.get('email-delivery-preview'); assert.match(preview.textContent, /Ready to send.*\n/); assert.match(preview.textContent, /<script>literal<\/script>/); assert.match(preview.textContent, /<résumé>\.pdf · 2 KB · application\/pdf/); assert.match(preview.textContent, /<img src=x>literal/);
  assert.equal(preview.children.length, 0); assert.equal(f.document.querySelector('[href]'), null); assert.equal(f.mutations().length, 0);
});

test('unsupported sending remains unavailable while the existing local draft action works and saves no attachment bytes', async t => {
  const f = fixture(t, { status: { ...status(), capabilities: { compose: false, send: false } } }); await f.ui.open(); await fill(f);
  assert.equal(f.get('email-send').disabled, true); await f.get('email-send').onclick();
  await f.get('email-draft-form').dispatch('submit'); assert.deepEqual(f.mutations().map(item => item.url), ['/api/email/drafts']);
  assert.deepEqual(Object.keys(f.mutations()[0].body).sort(), ['body', 'requestId', 'subject', 'to']);
  assert.match(f.get('email-receipt').textContent, /Local draft saved.*No email was sent/);
});

test('unavailable recovery storage warns without blocking an authorized Send or fabricating delivery evidence', async t => {
  const f = fixture(t, { storage: { getItem() { return null; }, setItem() { throw Error('Denied'); }, removeItem() { throw Error('Denied'); } } });
  await f.ui.open(); await fill(f); await f.click('email-send'); assert.equal(f.mutations().length, 2); assert.match(f.get('email-send-status').textContent, /^Sent\..*could not save recovery information/);
});

test('real local message store receives the UI payload and sends the immutable MIME attachment exactly once through an owned fixture', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-compose-store-ui-'));
  const configPath = path.join(directory, 'fixture.toml'), file = path.join(directory, 'résumé.pdf');
  await fs.writeFile(configPath, '# No real account or network transport.'); await fs.writeFile(file, Buffer.from([0, 255, 10, 80, 68, 70]));
  let sends = 0, raw;
  const store = await new AgentEmailStore({ dataDir: directory, runner: async request => {
    if (request.args.includes('--version')) return { stdout: 'himalaya v2.2.1 +smtp', exitCode: 0 };
    if (request.args.includes('--help')) return { stdout: '--json --account --mailbox --page-size --page --raw --seen leaving its flags alone otherwise <MESSAGE>', exitCode: 0 };
    if (request.args.includes('send')) { sends++; raw = await fs.readFile(request.args.at(-1), 'utf8'); return { stdout: '{"message":"Message sent","queueId":null}', exitCode: 0 }; }
    throw Error('Unexpected fixture command');
  } }).init();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await store.configure({ enabled: true, executable: process.execPath, configPath, account: 'fixture' }); await store.check();
  const f = fixture(t, { status: store.snapshot(), pickFiles: async () => [file], api: async (url, request, next) => {
    if (url === '/api/email/compose') return { delivery: await store.compose(request.body) };
    if (url === '/api/email/send') return { delivery: await store.send(request.body) };
    if (url === '/api/email/deliveries') return { deliveries: store.listDeliveries() };
    if (url.startsWith('/api/email/deliveries/')) return { delivery: store.getDelivery(url.split('/').at(-1)) };
    return next();
  } });
  await f.ui.open(); await fill(f); await f.click('email-attachment-choose'); await f.click('email-send');
  assert.equal(sends, 1); assert.match(f.get('email-send-status').textContent, /^Sent\./);
  const message = parseEmailMessage(raw); assert.equal(message.subject, 'Literal <subject>'); assert.equal(message.text.trim(), 'Hello\n<literal text>\nThanks'); assert.equal(message.attachments[0].filename, 'résumé.pdf'); assert.equal(message.attachments[0].size, 6);
  const saved = store.listDeliveries()[0]; assert.equal(saved.to.length, 2); assert.deepEqual(saved.cc, ['copy@example.test']); assert.deepEqual(saved.bcc, ['hidden@example.test']); assert.equal(saved.transportAccepted, true); assert.equal(saved.recipientAcknowledged, false);
  await f.click('email-delivery-check'); await f.get('email-send').onclick(); assert.equal(sends, 1);
});

test('hidden isolated Chromium composer validates real layout and one-click send wiring', { skip: process.env.BLACKICE_EMAIL_COMPOSE_QA !== '1' && 'Set BLACKICE_EMAIL_COMPOSE_QA=1 for the isolated native UI fixture.', timeout: 60000 }, async t => {
  const directory = process.env.BLACKICE_EMAIL_COMPOSE_QA_OUTPUT ? path.resolve(process.env.BLACKICE_EMAIL_COMPOSE_QA_OUTPUT) : await fs.mkdtemp(path.join(tmpdir(), 'blackice-email-compose-'));
  await fs.mkdir(directory, { recursive: true });
  if (!process.env.BLACKICE_EMAIL_COMPOSE_QA_OUTPUT) t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const require = createRequire(import.meta.url), script = fileURLToPath(new URL('./fixtures/email-compose-native.mjs', import.meta.url));
  const child = spawn(require('electron'), [script, `--fixture-data=${directory}`], { env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-6000); });
  const timer = setTimeout(() => child.kill(), 55000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  const report = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  assert.equal(code, 0, report.error || output); assert.equal(report.ok, true); assert.equal(report.closedWindows, true); assert.equal(report.liveMailRequests, 0); assert.ok(report.checks.length >= 6);
});

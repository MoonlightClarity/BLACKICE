import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {emailStatusCopy, initEmailUI} from '../public/email-ui.mjs';
import {AgentEmailStore} from '../lib/agent-email.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const uncertain = () => Object.assign(new Error('The response timed out.'), { uncertain: true, timedOut: true });
const decode = value => String(value).replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

// Only DOM structure and event delivery are simulated. The actual email module
// owns requests, ownership checks, state transitions, form values and controls.
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

function snapshot(account = 'first-account', revision = 1, checked = true) {
  return { revision, configured: true, enabled: true, config: { enabled: true, executable: '/fixture/himalaya', configPath: '/fixture/mail.toml', account, timeoutMs: 30000 }, cli: { checked, version: checked ? '2.2.1' : null }, account: { observed: false }, drafts: [], capabilities: { send: false } };
}

function fixture(t, options = {}) {
  const previous = globalThis.document, document = makeDocument(), calls = [], drafts = new Map();
  let saved = structuredClone(options.snapshot || snapshot());
  globalThis.document = document;
  const normal = async (url, request) => {
    if (url === '/api/email') return structuredClone(saved);
    if (url === '/api/email/config') {
      assert.equal(request.body.expectedRevision, saved.revision, 'setup save uses the current base revision');
      saved = { ...saved, revision: saved.revision + 1, config: { ...saved.config, ...request.body.config }, cli: { checked: false }, account: { observed: false } };
      return structuredClone(saved);
    }
    if (url === '/api/email/check') return structuredClone(saved);
    if (url === '/api/email/action') return request.body.action === 'list' ? [{ id: 'message-1', subject: 'A fixture message' }] : { body: 'Fixture body' };
    if (url === '/api/email/drafts') {
      const { requestId, ...fields } = request.body;
      const prior = drafts.get(requestId);
      if (prior) { assert.deepEqual(fields, { to: prior.to, subject: prior.subject, body: prior.body }); return { draft: structuredClone(prior) }; }
      const draft = { id: `draft-${drafts.size + 1}`, requestId, ...fields, sent: false };
      drafts.set(requestId, draft); saved.revision++; saved.drafts.push({ ...draft });
      return { draft: structuredClone(draft) };
    }
    if (url.startsWith('/api/email/drafts/')) return { draft: [...drafts.values()].find(draft => draft.id === url.split('/').at(-1)) };
    throw Error(`Unexpected request: ${url}`);
  };
  const api = async (url, request = {}) => {
    calls.push({ url, method: request.method || 'GET', body: structuredClone(request.body), signal: request.signal });
    return options.api ? options.api(url, request, () => normal(url, request)) : normal(url, request);
  };
  const ui = initEmailUI({ api, showModal(_id, html) { document.body.innerHTML = `<section class="modal">${html}</section>`; } });
  t.after(() => { ui.cancel(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const get = id => document.getElementById(id);
  return {
    ui, calls, drafts, get, document, saved: () => structuredClone(saved), setSaved: value => { saved = structuredClone(value); },
    async input(id, value) { const element = get(id); assert.ok(element, id); if (element.attributes.type === 'checkbox') element.checked = value; else element.value = value; await element.dispatch('input'); },
    click(id) { const element = get(id); assert.ok(element, id); assert.equal(element.disabled, false, `${id} is enabled`); return element.dispatch('click'); },
    submit(id) { return get(id).dispatch('submit'); },
    close() { ui.cancel(); document.body.innerHTML = ''; }
  };
}

async function compose(f, suffix = '') {
  await f.input('email-to', 'author@example.test'); await f.input('email-subject', `Original subject${suffix}`); await f.input('email-body', `Original body\n<literal text>${suffix}`);
}

const nativeClient = () => ({ id: 'thunderbird', name: 'Thunderbird', supported: true, available: true, capabilities: { open: true, compose: true }, localManagement: true, accountReuse: false });

test('Thunderbird handoff is explicit, passes no local draft content and preserves the composer', async t => {
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/client' ? nativeClient() : url === '/api/email/client/open' ? { requested: true, action: request.body.action, sent: false, windowVerified: false } : next() });
  await f.ui.open();
  assert.ok(f.get('email-client-handoff')); assert.match(f.get('email-client-note').textContent, /own window.*own accounts/);
  assert.equal(f.calls.filter(call => call.url === '/api/email/client/open').length, 0);
  await compose(f); await f.click('email-client-open'); await f.click('email-client-compose');
  assert.deepEqual(f.calls.filter(call => call.url === '/api/email/client/open').map(call => ({ method: call.method, body: call.body })), [{ method: 'POST', body: { action: 'open' } }, { method: 'POST', body: { action: 'compose' } }]);
  assert.equal(f.get('email-to').value, 'author@example.test'); assert.equal(f.get('email-subject').value, 'Original subject'); assert.equal(f.get('email-body').value, 'Original body\n<literal text>');
  assert.match(f.get('email-client-receipt').textContent, /empty compose window was requested.*draft is unchanged.*No email was sent/);
  assert.equal(f.drafts.size, 0, 'native compose does not save or send a BLACKICE draft');
});

test('optional Thunderbird discovery failure does not block existing setup, mailbox, or draft controls', async t => {
  const f = fixture(t, { api: (url, request, next) => { if (url === '/api/email/client') throw Error('Availability service unavailable'); return next(); } });
  await f.ui.open();
  assert.match(f.get('email-client-note').textContent, /could not be checked.*Availability service unavailable/);
  assert.equal(f.get('email-client-open').disabled, true); assert.equal(f.get('email-client-compose').disabled, true);
  assert.equal(f.get('email-check').disabled, false); assert.equal(f.get('email-mailbox-read').disabled, false);
  await compose(f); await f.submit('email-draft-form'); assert.equal(f.drafts.size, 1);
  await f.input('email-account', 'Still editable'); assert.equal(f.get('email-save-config').disabled, false);
});

test('native Thunderbird handoff remains usable when optional mailbox storage needs recovery', async t => {
  const f = fixture(t, { snapshot: { state: 'unavailable', config: {}, storage: { healthy: false }, drafts: [] }, api: (url, request, next) => url === '/api/email/client' ? nativeClient() : url === '/api/email/client/open' ? { requested: true, sent: false } : next() });
  await f.ui.open(); assert.equal(f.get('email-draft-save').disabled, true);
  assert.equal(f.get('email-client-open').disabled, false); await f.click('email-client-open');
  assert.match(f.get('email-client-receipt').textContent, /Check its native window/);
});

test('remote management cannot launch the native email app even through retained handlers', async t => {
  const f = fixture(t, { snapshot: { ...snapshot(), localManagement: false }, api: (url, request, next) => url === '/api/email/client' ? nativeClient() : next() });
  await f.ui.open();
  assert.equal(f.get('email-client-open').disabled, true); assert.equal(f.get('email-client-compose').disabled, true);
  assert.match(f.get('email-client-note').textContent, /on this computer/);
  await f.get('email-client-open').onclick(); await f.get('email-client-compose').onclick();
  assert.equal(f.calls.filter(call => call.url === '/api/email/client/open').length, 0);
});

test('one pending Thunderbird request cannot be duplicated or reenabled by unrelated email refresh', async t => {
  const pending = deferred();
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/client' ? nativeClient() : url === '/api/email/client/open' ? pending.promise : next() });
  await f.ui.open(); const first = f.click('email-client-compose');
  assert.equal(f.get('email-client-open').disabled, true); assert.equal(f.get('email-client-compose').disabled, true);
  await f.get('email-client-compose').onclick(); await f.click('email-refresh');
  assert.equal(f.get('email-client-compose').disabled, true);
  assert.equal(f.calls.filter(call => call.url === '/api/email/client/open').length, 1);
  pending.resolve({ requested: true, sent: false }); await first; assert.equal(f.get('email-client-compose').disabled, false);
});

test('retired Thunderbird status and launch responses cannot change a reopened Email workspace', async t => {
  const status = deferred(), request = deferred(); let reads = 0;
  const f = fixture(t, { api: (url, options, next) => url === '/api/email/client' ? ++reads === 1 ? status.promise : nativeClient() : url === '/api/email/client/open' ? request.promise : next() });
  const oldOpen = f.ui.open(); await new Promise(resolve => setImmediate(resolve));
  await f.ui.open(); status.resolve({ ...nativeClient(), available: false }); await oldOpen;
  assert.equal(f.get('email-client-compose').disabled, false, 'obsolete availability cannot disable the current card');
  await compose(f); const retired = f.get('email-client-compose'), pending = f.click('email-client-compose');
  f.close(); await f.ui.open();
  const currentReceipt = f.get('email-client-receipt').textContent;
  assert.match(currentReceipt, /response was interrupted/);
  request.resolve({ requested: true, sent: false }); await pending; await retired.onclick();
  assert.equal(f.get('email-client-receipt').textContent, currentReceipt);
  assert.equal(f.get('email-body').value, 'Original body\n<literal text>');
  assert.equal(f.calls.filter(call => call.url === '/api/email/client/open').length, 1);
});

test('saved email configuration and CLI protocol checks never imply mailbox verification', () => {
  assert.match(emailStatusCopy({}).label, /Setup required/);
  assert.match(emailStatusCopy({configured:true,enabled:true}).label, /checks required/);
  const checked=emailStatusCopy({configured:true,enabled:true,cli:{checked:true,version:'2.2.1'}});
  assert.match(checked.label, /mailbox unchecked/); assert.match(checked.note, /No mailbox operation/);
  const observed=emailStatusCopy({configured:true,enabled:true,account:{observed:true,lastOperationAt:'2026-10-19T00:00:00.000Z'}});
  assert.match(observed.label,/operation observed/); assert.match(observed.note,/future requests can still fail/);
  assert.equal(emailStatusCopy({state:'error',lastError:{message:'CLI unavailable'}}).note,'CLI unavailable');
  assert.equal(emailStatusCopy({state:'unavailable',storage:{healthy:false,error:'Restore the preserved email state.'},configured:true,enabled:true,cli:{checked:true},account:{observed:true}}).label,'Email unavailable');
});

test('unavailable email storage exposes recovery and blocks all write and mailbox handlers while status stays readable', async t => {
  const unavailable={state:'unavailable',revision:null,config:null,configured:false,enabled:false,localDrafts:null,drafts:[],storage:{healthy:false,readOnly:true,recoveryRequired:true,error:'Existing files are preserved. Restore or repair agent-email/state.json, then restart BLACKICE.'},cli:{checked:false},account:{observed:false},capabilities:{draft:false,read:false,send:false}};
  const f=fixture(t);await f.ui.open();await compose(f);await f.submit('email-mailbox-form');
  const oldMessage=f.document.querySelector('[data-email-message]');assert.ok(oldMessage);
  f.setSaved(unavailable);await f.click('email-refresh');
  assert.equal(f.get('email-state').textContent,'Email unavailable');assert.match(f.get('email-state-note').textContent,/preserved.*Restore or repair.*restart/);
  assert.match(f.get('email-drafts').textContent,/Saved drafts are unavailable/);assert.doesNotMatch(f.get('email-drafts').textContent,/No local drafts yet/);
  assert.equal(f.get('email-body').value,'Original body\n<literal text>');
  for(const id of ['email-save-config','email-check','email-mailbox-read','email-draft-save','email-draft-check','email-draft-retry'])assert.equal(f.get(id).disabled,true,id);
  assert.equal(oldMessage.disabled,true);assert.equal(f.get('email-refresh').disabled,false);
  const before=f.calls.filter(call=>call.method!=='GET').length;
  await f.submit('email-config-form');await f.get('email-check').onclick();await f.submit('email-mailbox-form');await oldMessage.onclick();await f.submit('email-draft-form');await f.get('email-draft-retry').onclick();
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,before);
  f.close();await f.ui.open();assert.equal(f.get('email-state').textContent,'Email unavailable');assert.equal(f.get('email-body').value,'Original body\n<literal text>');
  await f.click('email-refresh');assert.equal(f.get('email-draft-save').disabled,true);
});

test('a delayed open cannot replace the active snapshot or its setup save revision', async t => {
  const old = deferred(); let reads = 0;
  const f = fixture(t, { snapshot: snapshot('current-account', 9), api: (url, request, next) => url === '/api/email' && ++reads === 1 ? old.promise : next() });
  const obsolete = f.ui.open(); await f.ui.open();
  assert.equal(f.calls[0].signal.aborted, true);
  old.resolve(snapshot('obsolete-account', 1, false)); await obsolete;
  await f.input('email-account', 'edited-account');
  assert.equal(f.get('email-check').disabled, true);
  await f.submit('email-config-form');
  assert.equal(f.saved().config.account, 'edited-account');
  assert.equal(f.calls.find(call => call.method === 'PUT').body.expectedRevision, 9);
  assert.equal(f.get('email-account').value, 'edited-account');
});

test('an unconfirmed draft can retry the same original content while current edits survive close and reopen', async t => {
  let posts = 0;
  const f = fixture(t, { api: (url, request, next) => { if (url === '/api/email/drafts' && ++posts === 1) throw uncertain(); return next(); } });
  await f.ui.open(); await compose(f); await f.submit('email-draft-form');
  const original = f.calls.find(call => call.url === '/api/email/drafts').body;
  assert.equal(f.get('email-draft-save').disabled, true);
  assert.equal(f.get('email-draft-recovery').hidden, false);
  await f.input('email-subject', 'New edits are not the retry'); await f.input('email-body', 'Keep these unsaved changes.');
  await f.click('email-draft-check');
  assert.match(f.get('email-receipt').textContent, /Retry the same local save/);
  assert.equal(posts, 1, 'reading status does not retry a write');
  f.close(); await f.ui.open();
  assert.equal(f.get('email-subject').value, 'New edits are not the retry');
  assert.equal(f.get('email-body').value, 'Keep these unsaved changes.');
  assert.match(f.get('email-draft-retry-preview').textContent, /Original body\n<literal text>/);
  await f.submit('email-draft-form'); assert.equal(posts, 1, 'ordinary Save cannot discard an uncertain request');
  await f.click('email-draft-retry');
  assert.deepEqual(f.calls.filter(call => call.url === '/api/email/drafts')[1].body, original);
  assert.equal(f.drafts.size, 1); assert.equal(f.get('email-draft-save').disabled, false);
  assert.equal(f.get('email-body').value, 'Keep these unsaved changes.');
  await f.submit('email-draft-form');
  assert.equal(f.drafts.size, 2);
  const next = f.calls.filter(call => call.url === '/api/email/drafts').at(-1).body;
  assert.notEqual(next.requestId, original.requestId); assert.equal(next.body, 'Keep these unsaved changes.');
});

test('closing a pending draft save exposes recovery and its late rejection cannot poison a newer draft', async t => {
  const pending = deferred(); let posts = 0;
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/drafts' && ++posts === 1 ? pending.promise : next() });
  await f.ui.open(); await compose(f);
  const first = f.submit('email-draft-form');
  await new Promise(resolve => setImmediate(resolve));
  f.close(); await f.ui.open();
  assert.equal(f.get('email-draft-recovery').hidden, false); assert.equal(f.get('email-body').value, 'Original body\n<literal text>');
  await f.click('email-draft-retry');
  await compose(f, ' second'); await f.submit('email-draft-form');
  const receipt = f.get('email-receipt').textContent;
  pending.reject(uncertain()); await first;
  assert.equal(f.get('email-receipt').textContent, receipt);
  assert.equal(f.get('email-draft-recovery').hidden, true); assert.equal(f.get('email-draft-save').disabled, false);
  await f.submit('email-draft-form'); assert.equal(f.drafts.size, 2, 'late rejection neither blocks nor duplicates the current draft');
});

test('a committed draft with a lost response retries idempotently against the real local store', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-ui-'));
  const store = await new AgentEmailStore({ dataDir: directory, runner: async () => { throw Error('No CLI or account requests are permitted.'); } }).init();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  let posts = 0;
  const f = fixture(t, { api: async (url, request) => {
    if (url === '/api/email') return store.snapshot();
    assert.equal(url, '/api/email/drafts');
    const draft = await store.draft(request.body);
    if (++posts === 1) throw uncertain();
    return { draft };
  } });
  await f.ui.open(); await compose(f); await f.submit('email-draft-form');
  assert.equal(store.listDrafts().length, 1);
  await f.click('email-draft-retry');
  assert.equal(store.listDrafts().length, 1);
  const draft = await store.getDraft(store.listDrafts()[0].id);
  assert.equal(draft.body, 'Original body\n<literal text>'); assert.equal(draft.sent, false);
  assert.equal(await fs.readFile(draft.path, 'utf8'), draft.eml);
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.body.requestId), [draft.requestId, draft.requestId]);
  assert.equal(f.get('email-draft-recovery').hidden, true);
});

test('reading a matching saved draft confirms a lost response without another write or lost edits', async t => {
  let posts = 0;
  const f = fixture(t, { api: async (url, request, next) => { const result = await next(); if (url === '/api/email/drafts' && ++posts === 1) throw uncertain(); return result; } });
  await f.ui.open(); await compose(f); await f.submit('email-draft-form');
  await f.input('email-body', 'Keep this edit after recovery.');
  await f.click('email-draft-check');
  assert.match(f.get('email-receipt').textContent, /previous draft is saved/);
  assert.equal(posts, 1); assert.equal(f.get('email-draft-save').disabled, false);
  assert.equal(f.get('email-body').value, 'Keep this edit after recovery.');
});

test('changed saved setup blocks CLI and both mailbox entry points until deliberate reload', async t => {
  const f = fixture(t); await f.ui.open(); await compose(f); await f.submit('email-mailbox-form');
  const oldMessage = f.document.querySelector('[data-email-message]'); assert.ok(oldMessage);
  f.setSaved(snapshot('different-account', 2)); await f.click('email-refresh');
  assert.equal(f.get('email-account').value, 'first-account');
  assert.equal(f.get('email-check').disabled, true); assert.equal(f.get('email-mailbox-read').disabled, true); assert.equal(oldMessage.disabled, true);
  assert.match(f.get('email-state-note').textContent, /Reload saved setup/);
  const before = f.calls.filter(call => call.method === 'POST').length;
  await f.get('email-check').onclick(); await f.submit('email-mailbox-form'); await oldMessage.onclick();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, before, 'disabled actions are also guarded by their handlers');
  f.close(); await f.ui.open();
  assert.equal(f.get('email-account').value, 'first-account'); assert.equal(f.get('email-mailbox-read').disabled, true, 'reopening does not silently adopt a different saved account');
  await f.click('email-reload-config');
  assert.equal(f.get('email-account').value, 'different-account'); assert.equal(f.get('email-mailbox-read').disabled, false);
  assert.equal(f.get('email-body').value, 'Original body\n<literal text>');
  assert.equal(f.document.querySelector('[data-email-message]'), null);
  await oldMessage.onclick(); assert.equal(f.calls.filter(call => call.method === 'POST').length, before, 'a stale message ID cannot be read through the replacement account');
  await f.submit('email-mailbox-form'); assert.equal(f.calls.filter(call => call.method === 'POST').length, before + 1);
});

test('status refresh preserves unsaved setup and compose content while reload explicitly replaces setup edits', async t => {
  const f = fixture(t); await f.ui.open(); await compose(f); await f.input('email-account', 'unsaved-account');
  f.setSaved(snapshot('external-account', 4)); await f.click('email-draft-check');
  assert.equal(f.get('email-account').value, 'unsaved-account'); assert.equal(f.get('email-save-config').disabled, true);
  assert.match(f.get('email-reload-config').textContent, /replace edits/);
  await f.submit('email-config-form'); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  f.close(); await f.ui.open(); assert.equal(f.get('email-account').value, 'unsaved-account');
  await f.click('email-reload-config');
  assert.equal(f.get('email-account').value, 'external-account'); assert.equal(f.get('email-body').value, 'Original body\n<literal text>');
  await f.input('email-account', 'deliberately-edited-account'); await f.submit('email-config-form');
  assert.equal(f.calls.find(call => call.method === 'PUT').body.expectedRevision, 4);
});

test('local draft revisions advance an unchanged setup base without replacing unsaved setup edits', async t => {
  const f = fixture(t); await f.ui.open(); await f.input('email-account', 'edited-account');
  await compose(f); await f.submit('email-draft-form');
  assert.equal(f.get('email-account').value, 'edited-account'); assert.equal(f.get('email-save-config').disabled, false);
  await f.submit('email-config-form');
  assert.equal(f.calls.find(call => call.method === 'PUT').body.expectedRevision, 2);
  assert.equal(f.saved().config.account, 'edited-account');
});

test('unsaved setup can be deliberately discarded while its saved base is unchanged', async t => {
  const f = fixture(t); await f.ui.open(); await compose(f);
  assert.equal(f.get('email-reload-config').hidden, true);
  await f.input('email-account', 'unsaved-account');
  assert.equal(f.get('email-folders-load').disabled, true);
  assert.equal(f.get('email-reload-config').hidden, false);
  assert.match(f.get('email-reload-config').textContent, /replace edits/);
  await f.click('email-reload-config');
  assert.equal(f.get('email-account').value, 'first-account');
  assert.equal(f.get('email-body').value, 'Original body\n<literal text>');
  assert.equal(f.get('email-folders-load').disabled, false);
  assert.equal(f.get('email-reload-config').hidden, true);
  assert.equal(f.calls.filter(call => call.method === 'POST' || call.method === 'PUT').length, 0);
});

test('Himalaya envelope wrappers display address arrays and preserve literal sender names', async t => {
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/action' ? { envelopes: [{ id: 'actual-shape', subject: 'CLI fixture', from: [{ name: null, email: 'fixture@example.invalid' }, { name: 'Author <literal>', email: 'second@example.invalid' }], to: [{ name: null, email: 'reader@example.invalid' }] }] } : next() });
  await f.ui.open(); await f.submit('email-mailbox-form');
  const row = f.document.querySelector('[data-email-message]');
  assert.match(row.textContent, /fixture@example\.invalid/);
  assert.match(row.textContent, /Author <literal> <second@example\.invalid>/);
  assert.equal(row.querySelector('literal'), null, 'sender display names are text, not markup');
});

test('empty and partial indexing results remain visibly incomplete until a later completed list', async t => {
  let result = { messages: [], queued: 2, indexingPending: true };
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/action' ? structuredClone(result) : next() });
  await f.ui.open(); await f.submit('email-mailbox-form');
  assert.equal(f.get('email-indexing-note').hidden, false);
  assert.match(f.get('email-indexing-note').textContent, /indexing is in progress.*2 queued.*Results may be incomplete/);
  assert.match(f.get('email-messages').textContent, /No messages are available yet while indexing/);
  assert.match(f.get('email-receipt').textContent, /Results may be incomplete/);
  result = { messages: [{ id: 'indexed-first', subject: 'Available part of the list' }], queued: 1, indexingPending: true };
  await f.submit('email-mailbox-form');
  assert.match(f.document.querySelector('[data-email-message]').textContent, /Available part of the list/);
  assert.equal(f.get('email-indexing-note').hidden, false);
  await f.click('email-refresh');
  assert.equal(f.get('email-indexing-note').hidden, false, 'reading saved status does not assert the mailbox list is complete');
  result = { ...result, queued: 0, indexingPending: false };
  await f.submit('email-mailbox-form');
  assert.equal(f.get('email-indexing-note').hidden, true); assert.equal(f.get('email-indexing-note').textContent, '');
  assert.doesNotMatch(f.get('email-receipt').textContent, /incomplete/);
});

const pageResult = (page, { count = page === 1 ? 20 : 3, mayHaveMore = page === 1, queued = 0 } = {}) => ({ page, limit: 20, mayHaveMore, queued, indexingPending: queued > 0, messages: Array.from({ length: count }, (_, index) => ({ id: `page-${page}-message-${index + 1}`, subject: `Page ${page} message ${index + 1}` })) });
const listRequests = f => f.calls.filter(call => call.url === '/api/email/action' && call.body.action === 'list');

test('mailbox pages preserve the exact search, bind message IDs to their page and stop at reported boundaries', async t => {
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/action' && request.body.action === 'list' ? pageResult(request.body.page, { queued: request.body.page === 1 ? 2 : 0 }) : next() });
  const query = '  subject "a literal ; $(value)" and from author@example.test  ';
  await f.ui.open(); await f.input('email-folder', 'Archive'); await f.input('email-query', query); await f.submit('email-mailbox-form');
  assert.equal(f.get('email-pages').hidden, false); assert.equal(f.get('email-page-previous').disabled, true); assert.equal(f.get('email-page-next').disabled, false);
  assert.equal(f.get('email-page-status').textContent, 'Page 1 · 20 messages'); assert.equal(f.get('email-indexing-note').hidden, false);
  await f.get('email-page-previous').onclick(); assert.equal(listRequests(f).length, 1, 'page zero cannot be requested through the handler');
  const oldMessage = f.document.querySelector('[data-email-message]'); await oldMessage.onclick();
  assert.equal(f.get('email-message-preview').hidden, false);
  await f.click('email-page-next');
  assert.equal(f.get('email-page-status').textContent, 'Page 2 · 3 messages'); assert.equal(f.get('email-message-preview').hidden, true); assert.equal(f.get('email-message-preview').textContent, '');
  assert.equal(f.get('email-page-next').disabled, true); assert.equal(f.get('email-page-previous').disabled, false); assert.equal(f.get('email-indexing-note').hidden, true);
  const before = f.calls.length; await oldMessage.onclick(); await f.get('email-page-next').onclick();
  assert.equal(f.calls.length, before, 'retired message buttons and an unavailable next page cannot issue account requests');
  await f.document.querySelector('[data-email-message]').onclick();
  assert.deepEqual(f.calls.filter(call => call.body?.action === 'read').map(call => call.body), [
    { action: 'read', folder: 'Archive', id: 'page-1-message-1' }, { action: 'read', folder: 'Archive', id: 'page-2-message-1' },
  ]);
  await f.click('email-page-previous');
  assert.deepEqual(listRequests(f).map(call => call.body), [1, 2, 1].map(page => ({ action: 'list', folder: 'Archive', query, limit: 20, page })));
});

test('folder, query, account and external configuration changes reset paging without making automatic mailbox requests', async t => {
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/action' && request.body.action === 'list' ? pageResult(request.body.page, { mayHaveMore: true }) : next() });
  await f.ui.open(); await f.submit('email-mailbox-form'); await f.click('email-page-next');
  const query = 'subject "new search"';
  await f.input('email-query', query); assert.equal(f.get('email-pages').hidden, true); assert.equal(f.document.querySelector('[data-email-message]'), null);
  await f.get('email-page-next').onclick(); assert.equal(listRequests(f).length, 2);
  await f.submit('email-mailbox-form'); await f.click('email-page-next');
  await f.input('email-folder', 'Archive'); assert.equal(f.get('email-pages').hidden, true); assert.equal(listRequests(f).length, 4);
  await f.submit('email-mailbox-form'); await f.click('email-page-next');
  await f.input('email-account', 'replacement-account'); assert.equal(f.get('email-pages').hidden, true); assert.equal(f.get('email-mailbox-read').disabled, true);
  await f.submit('email-config-form'); assert.equal(listRequests(f).length, 6, 'saving setup does not read a mailbox');
  const checked = f.saved(); checked.cli = { checked: true, version: '2.2.1' }; f.setSaved(checked); await f.click('email-refresh');
  await f.submit('email-mailbox-form'); await f.click('email-page-next');
  const replacement = f.saved(); replacement.revision++; replacement.config.configPath = '/fixture/other-config.toml'; f.setSaved(replacement);
  await f.click('email-refresh'); assert.equal(f.get('email-pages').hidden, true); assert.equal(f.get('email-mailbox-read').disabled, true);
  await f.click('email-reload-config'); assert.equal(listRequests(f).length, 8, 'adopting external setup does not read a mailbox');
  await f.submit('email-mailbox-form');
  assert.deepEqual(listRequests(f).map(call => [call.body.page, call.body.folder, call.body.query]), [
    [1, 'INBOX', ''], [2, 'INBOX', ''], [1, 'INBOX', query], [2, 'INBOX', query],
    [1, 'Archive', query], [2, 'Archive', query], [1, 'Archive', query], [2, 'Archive', query], [1, 'Archive', query],
  ]);
});

test('a delayed page response is discarded after the selection changes, even when its text changes back', async t => {
  const pending = deferred(); let hold = true;
  const f = fixture(t, { api: (url, request, next) => {
    if (url !== '/api/email/action' || request.body.action !== 'list') return next();
    return request.body.page === 2 && hold ? pending.promise : pageResult(request.body.page);
  } });
  await f.ui.open(); await f.submit('email-mailbox-form');
  const loading = f.click('email-page-next'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.get('email-page-next').disabled, true);
  // Simulate selection changes delivered while the transport is still settling.
  await f.input('email-query', 'subject changed'); await f.input('email-query', '');
  const receipts = f.get('email-receipt').textContent, before = f.calls.length;
  pending.resolve(pageResult(2)); await loading; hold = false;
  assert.equal(f.get('email-pages').hidden, true); assert.equal(f.document.querySelector('[data-email-message]'), null); assert.equal(f.get('email-receipt').textContent, receipts);
  assert.equal(f.calls.length, before, 'a retired page result does not trigger a follow-up status read');
  await f.submit('email-mailbox-form'); assert.equal(f.get('email-page-status').textContent, 'Page 1 · 20 messages');
  assert.deepEqual(listRequests(f).map(call => call.body.page), [1, 2, 1]);
});

test('closing a pending page request prevents its late result from replacing a reopened mailbox', async t => {
  const pending = deferred(); let hold = true;
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/action' && request.body.action === 'list' ? request.body.page === 2 && hold ? pending.promise : pageResult(request.body.page) : next() });
  await f.ui.open(); await f.submit('email-mailbox-form'); const loading = f.click('email-page-next'); await new Promise(resolve => setImmediate(resolve));
  const signal = listRequests(f).at(-1).signal;
  f.close(); await f.ui.open(); hold = false; await f.input('email-folder', 'Reopened'); await f.submit('email-mailbox-form');
  const receipt = f.get('email-receipt').textContent; assert.equal(signal.aborted, true);
  pending.resolve(pageResult(2)); await loading;
  assert.equal(f.get('email-page-status').textContent, 'Page 1 · 20 messages'); assert.equal(f.get('email-receipt').textContent, receipt);
  await f.document.querySelector('[data-email-message]').onclick();
  assert.equal(f.calls.filter(call => call.body?.action === 'read').at(-1).body.folder, 'Reopened');
});

test('a delayed message preview cannot appear after changing folders', async t => {
  const pending = deferred();
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/action' ? request.body.action === 'read' ? pending.promise : pageResult(request.body.page) : next() });
  await f.ui.open(); await f.submit('email-mailbox-form');
  const loading = f.document.querySelector('[data-email-message]').onclick(); await new Promise(resolve => setImmediate(resolve));
  await f.input('email-folder', 'A different folder'); pending.resolve({ message: 'This body belongs to the retired INBOX selection.' }); await loading;
  assert.equal(f.get('email-message-preview').hidden, true); assert.equal(f.get('email-message-preview').textContent, ''); assert.match(f.get('email-receipt').textContent, /selection changed/);
  await f.submit('email-mailbox-form'); assert.equal(listRequests(f).at(-1).body.page, 1); assert.equal(listRequests(f).at(-1).body.folder, 'A different folder');
});

test('a failed next page keeps the current page and permits a bounded retry', async t => {
  let nextAttempts = 0;
  const f = fixture(t, { api: (url, request, next) => {
    if (url !== '/api/email/action' || request.body.action !== 'list') return next();
    if (request.body.page === 2 && ++nextAttempts === 1) throw new Error('Fixture page request failed.');
    return pageResult(request.body.page);
  } });
  await f.ui.open(); await f.submit('email-mailbox-form'); await f.click('email-page-next');
  assert.equal(f.get('email-page-status').textContent, 'Page 1 · 20 messages'); assert.equal(f.get('email-page-next').disabled, false); assert.match(f.get('email-receipt').textContent, /page request failed/);
  await f.click('email-page-next'); assert.equal(f.get('email-page-status').textContent, 'Page 2 · 3 messages');
  assert.deepEqual(listRequests(f).map(call => call.body.page), [1, 2, 2]);
});

const readableMessage = () => ({ message: 'RAW MIME SOURCE', content: { subject: 'Decoded <subject>', from: [{ name: '<Sender>', email: 'sender@example.test' }], to: [{ email: 'reader@example.test' }], replyTo: [{ email: 'reply@example.test' }], date: 'Tue, 20 Oct 2026', text: 'Readable message\n<script>literal, not executable</script>', attachments: [{ filename: '<report>.pdf', contentType: 'application/pdf', size: 1024 }] } });

test('the message reader displays decoded text and attachment descriptions with lazy raw source and no markup execution', async t => {
  const value = readableMessage(), f = fixture(t, { api: (url, request, next) => url === '/api/email/action' && request.body.action === 'read' ? value : next() });
  await f.ui.open(); await f.submit('email-mailbox-form'); await f.document.querySelector('[data-email-message]').onclick();
  const preview = f.get('email-message-preview');
  assert.equal(preview.hidden, false); assert.match(preview.textContent, /Decoded <subject>/); assert.match(preview.textContent, /Readable message/);
  assert.match(preview.textContent, /<report>\.pdf/); assert.equal(preview.querySelector('script'), null); assert.equal(preview.querySelector('iframe'), null);
  assert.equal(f.get('email-message-raw').textContent, ''); const details = f.get('email-message-source'); details.open = true; details.ontoggle();
  assert.equal(f.get('email-message-raw').textContent, value.message);
});

test('reply preparation fills the local composer without saving, sending, or replacing unsaved text', async t => {
  const value = readableMessage(), f = fixture(t, { api: (url, request, next) => url === '/api/email/action' && request.body.action === 'read' ? value : next() });
  await f.ui.open(); await f.submit('email-mailbox-form'); await f.document.querySelector('[data-email-message]').onclick();
  await compose(f); await f.click('email-reply-draft');
  assert.equal(f.get('email-subject').value, 'Original subject'); assert.match(f.get('email-receipt').textContent, /current draft/);
  await f.click('email-draft-new'); await f.click('email-reply-draft');
  assert.equal(f.get('email-to').value, 'reply@example.test'); assert.equal(f.get('email-subject').value, 'Re: Decoded <subject>'); assert.match(f.get('email-body').value, /> Readable message/);
  assert.equal(f.calls.filter(call => call.url === '/api/email/drafts').length, 0);
  f.close(); await f.ui.open(); assert.equal(f.get('email-to').value, 'reply@example.test'); assert.match(f.get('email-body').value, /> Readable message/);
});

test('folder discovery is explicit and selecting a folder does not fetch or alter another folder automatically', async t => {
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/action' && request.body.action === 'mailboxes' ? { mailboxes: [{ id: 'inbox-id', name: 'INBOX' }, { id: 'archive-one', name: 'Archive & receipts' }, { id: 'archive-two', name: 'Archive & receipts' }] } : next() });
  await f.ui.open(); assert.equal(f.calls.filter(call => call.body?.action === 'mailboxes').length, 0);
  await f.input('email-folder', 'My typed folder'); await f.click('email-folders-load');
  assert.equal(f.get('email-folder').value, 'My typed folder'); assert.equal(f.get('email-folder-select').hidden, false);
  assert.equal(listRequests(f).length, 0); assert.match(f.get('email-folder-select').textContent, /Archive & receipts/);
  f.get('email-folder-select').value = 'archive-two'; await f.get('email-folder-select').dispatch('change');
  assert.equal(f.get('email-folder').value, 'archive-two'); assert.equal(listRequests(f).length, 0);
  await f.submit('email-mailbox-form'); assert.equal(listRequests(f)[0].body.folder, 'archive-two'); assert.equal(listRequests(f)[0].body.page, 1);
});

test('an obsolete folder response cannot populate a different account or reopened email workspace', async t => {
  const pending = deferred(); let hold = true;
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/action' && request.body.action === 'mailboxes' && hold ? pending.promise : next() });
  await f.ui.open(); const loading = f.click('email-folders-load'); await new Promise(resolve => setImmediate(resolve));
  f.close(); f.setSaved(snapshot('replacement-account', 9)); await f.ui.open(); hold = false;
  pending.resolve({ mailboxes: [{ name: 'Private old folder' }] }); await loading;
  assert.equal(f.get('email-folder-select').hidden, true); assert.equal(f.get('email-folder-select').textContent, '');
  assert.equal(f.get('email-mailbox-read').disabled, true); await f.click('email-reload-config');
  assert.equal(f.get('email-account').value, 'replacement-account');
});

test('unconfirmed local saves keep New draft blocked until the original receipt is resolved', async t => {
  const f = fixture(t, { api: (url, request, next) => url === '/api/email/drafts' ? Promise.reject(uncertain()) : next() });
  await f.ui.open(); await compose(f); await f.submit('email-draft-form');
  assert.equal(f.get('email-draft-new').disabled, true); await f.get('email-draft-new').onclick();
  assert.equal(f.get('email-subject').value, 'Original subject'); assert.equal(f.get('email-draft-recovery').hidden, false);
});

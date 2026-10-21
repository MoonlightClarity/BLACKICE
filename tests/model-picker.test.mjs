import test from 'node:test';
import assert from 'node:assert/strict';
import { filterModelChoices, initModelPicker, modelPickerChoices, modelPickerPosition } from '../public/model-picker.mjs';
import { missionModels } from '../public/mission-model.mjs';

const status = () => ({ defaultModel: 'gpt-6.1-sol', defaultModelAvailable: true, codex: { connected: true, authenticated: true },
  providers: [{ id: 'router', name: 'OpenRouter' }, { id: 'local', name: 'My local server' }],
  models: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1', available: true }, { id: 'router::vendor/model', displayName: 'A different model', available: true, providerId: 'router' }, { id: 'local::tiny', displayName: 'Tiny', available: false, providerId: 'local' }] });

function fixture(t, { onConnect, onChatModeSetup, onChatModeRefresh, onChatModeAcknowledge, selected = 'default' } = {}) {
  const old = ['document', 'window'].map(key => [key, Object.hasOwn(globalThis, key), globalThis[key]]);
  let doc;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.attrs = new Map(); this.listeners = new Map(); this.dataset = {}; this.style = {}; this.className = ''; this.hidden = false; this.disabled = false; this._text = ''; this.value = ''; this.id = ''; this.scrollCount = 0;
      this.classList = { add: value => { if (!this.classList.contains(value)) this.className = `${this.className} ${value}`.trim(); }, remove: value => { this.className = this.className.split(/\s+/).filter(item => item !== value).join(' '); }, contains: value => this.className.split(/\s+/).includes(value), toggle: (value, force) => { const next = force ?? !this.classList.contains(value); this.classList[next ? 'add' : 'remove'](value); return next; } };
    }
    get ownerDocument() { return doc; }
    get isConnected() { return this === doc.body || Boolean(this.parentElement?.isConnected); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    set innerHTML(_) { throw new Error('Model names must be inserted as text, never markup.'); }
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
    closest(selector) { if (selector === '[data-model-value]' && this.dataset.modelValue !== undefined) return this; return this.parentElement?.closest(selector) || null; }
    setAttribute(key, value) { this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.get(key); }
    removeAttribute(key) { this.attrs.delete(key); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) { if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true }); for (const callback of this.listeners.get(event.type) || []) callback(event); if (event.bubbles && !event.stopped) this.parentElement?.dispatchEvent(event); return true; }
    focus() { doc.activeElement = this; }
    scrollIntoView() { this.scrollCount++; }
    getBoundingClientRect() { if (this.rect) return this.rect; if (this.classList.contains('model-picker-panel')) { const height = Math.min(400, Number.parseFloat(this.style.maxHeight) || 400), width = Math.min(460, Number.parseFloat(this.style.width) || 460); return { width, height, left: 0, top: 0, bottom: height }; } return { width: 220, height: 32, left: 270, top: 600, bottom: 632 }; }
  }
  class TestEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } preventDefault() { this.prevented = true; } stopPropagation() { this.stopped = true; } }
  const body = new Element('body'); doc = { body, activeElement: null, defaultView: { Event: TestEvent }, createElement: tag => new Element(tag), listeners: new Map() };
  doc.addEventListener = Element.prototype.addEventListener; doc.removeEventListener = Element.prototype.removeEventListener; doc.dispatchEvent = Element.prototype.dispatchEvent;
  const win = { innerWidth: 1000, innerHeight: 700, listeners: new Map(), addEventListener: Element.prototype.addEventListener, removeEventListener: Element.prototype.removeEventListener, dispatchEvent: Element.prototype.dispatchEvent };
  globalThis.document = doc; globalThis.window = win;
  const owner = new Element('label'), select = new Element('select'); select.id = 'test-model'; select.value = selected; select.options = [...missionModels(status(), selected).map(model => ({ value: model.value })), { value: '__connections__' }]; owner.append(select); body.append(owner);
  const changes = []; select.addEventListener('change', event => changes.push({ value: select.value, bubbles: event.bubbles }));
  const ui = initModelPicker({ select, onConnect, onChatModeSetup, onChatModeRefresh, onChatModeAcknowledge }); const snapshot = status(); ui.update({ models: missionModels(snapshot, selected), status: snapshot, selected });
  const find = (root, className) => root.classList?.contains(className) ? root : root.children?.map(child => find(child, className)).find(Boolean);
  const button = () => find(owner, 'model-picker-button'), panel = () => find(body, 'model-picker-panel'), search = () => find(panel(), 'model-picker-search'), list = () => find(panel(), 'model-picker-list'), connect = () => find(panel(), 'model-picker-connect');
  const options = () => list().children.flatMap(group => group.children.filter(child => child.dataset.modelValue !== undefined));
  const fire = (element, type, values = {}) => { const event = new TestEvent(type, values); element.dispatchEvent(event); return event; };
  t.after(() => { ui.destroy(); for (const [key, present, value] of old) if (present) globalThis[key] = value; else delete globalThis[key]; });
  return { ui, select, owner, doc, win, changes, button, panel, search, list, options, connect, route: () => find(panel(), 'model-picker-route'), routeSetup: () => find(panel(), 'model-picker-route-setup'), routeRefresh: () => find(panel(), 'model-picker-route-refresh'), routeAcknowledge: () => find(panel(), 'model-picker-route-acknowledge'), routeError: () => find(panel(), 'model-picker-route-error'), notice: () => find(panel(), 'model-picker-status'), observation: () => find(panel(), 'model-picker-observation'), fire, element: tag => new Element(tag), open() { fire(button(), 'click'); }, query(value) { search().value = value; fire(search(), 'input'); }, key(key, values = {}) { return fire(panel(), 'keydown', { target: search(), key, ...values }); }, update(snapshot = status(), selected = select.value) { ui.update({ models: missionModels(snapshot, selected), status: snapshot, selected }); } };
}

test('display choices retain provider routing IDs and distinguish inherited default from an explicit identical model', () => {
  const snapshot = status(), choices = modelPickerChoices(missionModels(snapshot), snapshot);
  assert.deepEqual(choices.map(choice => choice.value), ['default', 'gpt-6.1-sol', 'router::vendor/model', 'local::tiny']);
  assert.equal(choices[0].label, 'Use default'); assert.equal(choices[0].name, 'GPT-6.1'); assert.equal(choices[0].detail, 'GPT-6.1 · Codex'); assert.equal(choices[1].label, 'GPT-6.1'); assert.equal(choices[2].providerLabel, 'OpenRouter');
  assert.deepEqual(filterModelChoices(choices, 'openrouter DIFFERENT').map(choice => choice.value), ['router::vendor/model']); assert.deepEqual(filterModelChoices(choices, 'vendor/model').map(choice => choice.value), ['router::vendor/model']);
});
test('a registered retired candidate keeps its exact selectable ID and lifecycle alongside request-specific acceptance', t => {
  const f = fixture(t), id = 'gpt-5.3-codex-spark', snapshot = status();
  snapshot.models.push({ id, model: id, displayName: 'Codex Spark', source: 'custom', lifecycle: { state: 'retired', date: '2026-09-14' }, access: { state: 'unverified' } });
  f.select.options = missionModels(snapshot).map(model => ({ value: model.value })); f.update(snapshot); f.open(); f.query('retired');
  assert.equal(f.options().length, 1); assert.match(f.options()[0].textContent, /Retired 2026-09-14/); assert.doesNotMatch(f.options()[0].textContent, /unverified|untested|access/i); assert.equal(f.observation().hidden, true);
  f.fire(f.list(), 'click', { target: f.options()[0] }); assert.equal(f.select.value, id); assert.equal(f.changes.length, 1);
  snapshot.models.at(-1).access = { state: 'accepted', checkedAt: '2026-10-18T01:00:00Z', scope: 'current-connection' }; f.update(snapshot, id); f.open(); f.query('retired');
  assert.match(f.button().textContent, /Retired/); assert.doesNotMatch(f.button().getAttribute('aria-label'), /accepted|verified|completed/i); assert.match(f.observation().textContent, /Last request completed/); assert.equal(f.select.value, id);
});

test('remote defaults and unknown saved selections remain visible without inventing availability', () => {
  const snapshot = { ...status(), defaultModel: 'router::vendor/model' }, choices = modelPickerChoices(missionModels(snapshot), snapshot, 'removed::old');
  assert.equal(choices[0].name, 'A different model'); assert.equal(choices[0].providerLabel, 'OpenRouter'); assert.equal(choices.at(-1).value, 'removed::old'); assert.equal(choices.at(-1).name, 'old'); assert.equal(choices.at(-1).available, false);
});

test('native alias choices keep the saved routing value available with one friendly hidden row', () => {
  const snapshot = { defaultModel: 'actual-slug', defaultModelAvailable: true, codex: { connected: true, authenticated: true }, models: [{ id: 'picker-alias', model: 'actual-slug', displayName: 'Friendly model', available: true, hidden: true, inputModalities: ['text'], availabilityNux: { message: 'Informational only.' } }] };
  const choices = modelPickerChoices(missionModels(snapshot), snapshot, 'actual-slug');
  assert.deepEqual(choices.map(choice => choice.value), ['default', 'actual-slug']);
  assert.equal(choices[0].name, 'Friendly model'); assert.equal(choices[0].detail, 'Friendly model · Codex · Hidden by Codex');
  assert.equal(choices[1].name, 'Friendly model'); assert.equal(choices[1].available, true); assert.equal(choices[1].hidden, true);
  assert.deepEqual(choices[1].inputModalities, ['text']); assert.deepEqual(choices[1].availabilityNux, { message: 'Informational only.' });
  assert.deepEqual(filterModelChoices(choices, 'hidden informational').map(choice => choice.value), ['default', 'actual-slug']);
});

test('custom native picker stays quiet until a real request and keeps exact IDs selectable after a failed result', t => {
  const id = 'Vendor/Explicit.Model:preview', f = fixture(t), snapshot = status();
  snapshot.models.push({ id, model: id, source: 'custom', access: { state: 'unverified' } });
  f.select.options.push({ value: id }); f.update(snapshot); f.open(); f.query('custom preview');
  assert.equal(f.options().length, 1); assert.equal(f.options()[0].dataset.modelValue, id); assert.match(f.options()[0].textContent, /Custom model ID/); assert.doesNotMatch(f.options()[0].textContent, /unverified|untested|access/i); assert.equal(f.observation().hidden, true);
  f.key('Enter'); assert.equal(f.select.value, id); assert.deepEqual(f.changes, [{ value: id, bubbles: true }]); assert.doesNotMatch(f.button().title, /unverified|untested|access/i);
  snapshot.models.at(-1).access = { state: 'accepted', checkedAt: '2026-10-18T01:00:00Z', lastSuccessAt: '2026-10-18T01:00:00Z', scope: 'current-connection' }; f.update(snapshot, id); f.open(); f.query('explicit');
  assert.equal(f.observation().hidden, false); assert.equal(f.observation().open, false); assert.match(f.observation().textContent, /Last request completed/); assert.match(f.observation().textContent, /2026-10-18 01:00:00\.000 UTC/); assert.match(f.observation().textContent, /Current Codex account and connection/); assert.equal(f.options()[0].classList.contains('is-unavailable'), false);
  const search = f.search(); snapshot.models.at(-1).access = { state: 'failed', outcome: 'failed', checkedAt: '2026-10-18T01:10:00Z', lastSuccessAt: '2026-10-18T01:00:00Z', scope: 'current-connection', errorCode: 'MODEL_REQUEST_REJECTED' }; f.update(snapshot, id);
  assert.equal(f.search(), search); assert.equal(f.search().value, 'explicit'); assert.equal(f.doc.activeElement, search); assert.match(f.observation().textContent, /Last request failed/); assert.match(f.observation().textContent, /MODEL_REQUEST_REJECTED/); assert.match(f.observation().textContent, /Earlier completed request2026-10-18 01:00:00\.000 UTC/); assert.equal(f.options()[0].classList.contains('is-unavailable'), false);
  assert.equal(f.select.value, id); assert.equal(f.changes.length, 1, 'passive outcome updates do not rewrite or replay a choice');
  f.key('Enter'); assert.deepEqual(f.changes, [{ value: id, bubbles: true }, { value: id, bubbles: true }], 'the user can choose the exact failed ID again without substitution');
});

test('timed request details retain keyboard focus through refresh and disappear when the current connection has no record', t => {
  const f = fixture(t), snapshot = status();
  snapshot.models[0].access = { state: 'failed', outcome: 'interrupted', errorCode: 'CODEX_MODEL_CHECK_TIMEOUT', checkedAt: '2026-10-18T02:00:00Z', scope: 'current-connection' };
  f.update(snapshot); f.open();
  const details = f.observation(), summary = details.children[0];
  assert.equal(details.parentElement, f.panel()); assert.equal(f.list().contains(details), false, 'the disclosure is not an interactive descendant of a model option');
  assert.match(details.textContent, /Last request timed out/); assert.match(details.textContent, /CODEX_MODEL_CHECK_TIMEOUT/); assert.match(details.textContent, /Model IDgpt-6\.1-sol/); assert.doesNotMatch(f.options()[0].textContent, /timed out|unverified/i);
  details.open = true; summary.focus(); f.fire(f.doc, 'focusin', { target: summary });
  const enter = f.fire(f.panel(), 'keydown', { target: summary, key: 'Enter' }); assert.notEqual(enter.prevented, true, 'native disclosure keyboard behavior is preserved');
  snapshot.models[0].access.checkedAt = '2026-10-18T02:01:00Z'; f.update(snapshot);
  assert.equal(f.observation(), details); assert.equal(details.open, true); assert.equal(details.children[0], summary); assert.equal(f.doc.activeElement, summary); assert.match(details.textContent, /02:01:00\.000 UTC/);
  snapshot.models[0].access = { state: 'unverified' }; f.update(snapshot);
  assert.equal(details.hidden, true); assert.equal(details.open, false); assert.equal(f.doc.activeElement, f.search()); assert.equal(f.changes.length, 0); assert.doesNotMatch(details.children[1].textContent, /02:01|Current Codex/);
});

test('an inherited default change refreshes the exact model in details even when both observations have identical metadata', t => {
  const f = fixture(t), snapshot = status(), access = { state: 'accepted', checkedAt: '2026-10-18T02:00:00Z', scope: 'current-connection' };
  snapshot.models[0].access = { ...access }; snapshot.models.push({ id: 'Unadvertised/Exact:ID', model: 'Unadvertised/Exact:ID', source: 'custom', access: { ...access } });
  f.update(snapshot); f.open(); f.observation().open = true;
  snapshot.defaultModel = 'Unadvertised/Exact:ID'; f.update(snapshot);
  assert.equal(f.observation().open, false); assert.match(f.observation().textContent, /Model IDUnadvertised\/Exact:ID/); assert.doesNotMatch(f.observation().textContent, /gpt-6\.1-sol/); assert.equal(f.select.value, 'default'); assert.equal(f.changes.length, 0);
});

test('a reported hidden model remains selectable and its notice is literal text while disconnection still opens setup', t => {
  const connections = [], f = fixture(t, { onConnect: choice => connections.push(choice) }), snapshot = status();
  snapshot.models.push({ id: 'picker-alias', model: 'actual-slug', displayName: 'Friendly hidden', available: true, hidden: true, availabilityNux: { message: '<b>Informational only</b>' } });
  f.select.options.push({ value: 'actual-slug' }); f.select.value = 'actual-slug'; f.update(snapshot, 'actual-slug'); f.open(); f.query('hidden');
  assert.equal(f.options().length, 1); const option = f.options()[0];
  assert.equal(option.dataset.modelValue, 'actual-slug'); assert.equal(option.getAttribute('aria-selected'), 'true');
  assert.equal(option.classList.contains('is-unavailable'), false); assert.match(option.textContent, /Friendly hidden/); assert.match(option.textContent, /Hidden by Codex/); assert.match(f.observation().textContent, /Codex notice<b>Informational only<\/b>/); assert.equal(f.observation().open, false); assert.doesNotMatch(option.textContent, /Informational only/);
  f.key('Enter'); assert.deepEqual(f.changes, [{ value: 'actual-slug', bubbles: true }]); assert.equal(connections.length, 0); assert.match(f.button().textContent, /Hidden by Codex/);
  snapshot.codex.connected = false; f.update(snapshot, 'actual-slug'); f.open(); f.query('hidden'); f.key('Enter');
  assert.equal(connections.length, 1); assert.equal(connections[0].value, 'actual-slug'); assert.equal(f.changes.length, 1); assert.equal(f.select.value, 'actual-slug');
});

test('picker searches by provider and model, displays selected check, and routes exact native selection once', t => {
  const f = fixture(t); f.open(); assert.equal(f.panel().hidden, false); assert.equal(f.doc.activeElement, f.search()); assert.equal(f.button().getAttribute('aria-expanded'), 'true');
  assert.equal(f.options().find(option => option.dataset.modelValue === 'default').getAttribute('aria-selected'), 'true');
  f.query('router different'); assert.equal(f.options().length, 1); const option = f.options()[0]; f.fire(f.list(), 'click', { target: option.children[0] });
  assert.deepEqual(f.changes, [{ value: 'router::vendor/model', bubbles: true }]); assert.equal(f.select.value, 'router::vendor/model'); assert.equal(f.panel().hidden, true); assert.equal(f.doc.activeElement, f.button()); assert.match(f.button().textContent, /A different model/);
});

test('keyboard arrows, Enter, Escape and focus return work without submitting the message form', t => {
  const f = fixture(t); f.fire(f.button(), 'keydown', { key: 'ArrowDown' }); const down = f.key('ArrowDown'); assert.equal(down.prevented, true); assert.equal(f.search().getAttribute('aria-activedescendant'), f.options()[1].id);
  const enter = f.key('Enter'); assert.equal(enter.prevented, true); assert.equal(enter.stopped, true); assert.deepEqual(f.changes.map(change => change.value), ['gpt-6.1-sol']);
  f.open(); f.query('tiny'); const escape = f.key('Escape'); assert.equal(escape.stopped, true); assert.equal(f.panel().hidden, true); assert.equal(f.doc.activeElement, f.button()); f.open(); assert.equal(f.search().value, '');
});

test('model search supports composed names while IME confirmation never chooses a model', t => {
  const f = fixture(t), snapshot = status();
  snapshot.models[1].displayName = 'Raisonnement élargi'; snapshot.providers[0].name = 'Équipe models'; f.update(snapshot); f.open();
  f.query('EQUIPE elargi'); assert.deepEqual(f.options().map(option => option.dataset.modelValue), ['router::vendor/model']);
  const option = f.options()[0]; assert.match(option.title, /Raisonnement élargi/); assert.match(option.title, /vendor\/model/);
  for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
    const confirmation = f.key('Enter', flags); assert.notEqual(confirmation.prevented, true); assert.equal(f.select.value, 'default'); assert.equal(f.changes.length, 0); assert.equal(f.panel().hidden, false);
  }
  f.key('Enter'); assert.deepEqual(f.changes, [{ value: 'router::vendor/model', bubbles: true }]);
});

test('model catalog loading and failure notices preserve editable results and exact selection', t => {
  const f = fixture(t); f.open(); f.query('different'); const option = f.options()[0], search = f.search(), snapshot = status();
  snapshot.codex.modelCatalog = { refreshing: true }; f.update(snapshot);
  assert.equal(f.list().getAttribute('aria-busy'), 'true'); assert.equal(f.notice().hidden, false); assert.match(f.notice().textContent, /Updating models/);
  assert.equal(f.search(), search); assert.equal(f.options()[0], option); assert.equal(f.doc.activeElement, search); assert.equal(search.value, 'different');
  snapshot.codex.modelCatalog = { refreshing: false, error: 'private transport detail' }; f.update(snapshot);
  assert.equal(f.list().getAttribute('aria-busy'), 'false'); assert.match(f.notice().textContent, /could not refresh/); assert.doesNotMatch(f.notice().textContent, /private transport detail/); assert.equal(f.select.value, 'default'); assert.equal(f.changes.length, 0);
  f.key('Enter'); assert.deepEqual(f.changes.map(change => change.value), ['router::vendor/model']);
  snapshot.codex.modelCatalog = {}; f.update(snapshot); assert.equal(f.notice().hidden, true); assert.equal(f.notice().textContent, '');
});

test('unavailable models open connection setup without replacing the saved working model', t => {
  const calls = [], f = fixture(t, { onConnect: choice => calls.push(choice) }); f.open(); f.query('tiny'); assert.match(f.options()[0].title, /Connect My local server/); f.key('Enter');
  assert.equal(f.select.value, 'default'); assert.equal(f.changes.length, 0); assert.equal(calls[0].value, 'local::tiny'); assert.equal(f.panel().hidden, true);
  f.open(); f.fire(f.connect(), 'click'); assert.equal(calls.length, 2); assert.equal(f.select.value, 'default');
});

test('composer-style disconnected choice dispatches the existing connections sentinel', t => {
  const f = fixture(t); f.open(); f.query('tiny'); f.key('Enter'); assert.deepEqual(f.changes, [{ value: '__connections__', bubbles: true }]);
});

test('catalog refresh preserves search input, focus, and active routing ID while updating availability', t => {
  const f = fixture(t); f.open(); f.query('model'); const search = f.search(), list = f.list(), before = f.options()[0]; search.selectionStart = 2; search.selectionEnd = 2;
  f.update(); assert.equal(f.options()[0], before, 'an unchanged streaming snapshot must not rebuild options');
  const changed = status(); changed.providers[0].name = 'Router renamed'; changed.models.push({ id: 'router::vendor/model-v2', displayName: 'Second model', providerId: 'router', available: true }); f.select.options.push({ value: 'router::vendor/model-v2' }); f.update(changed);
  assert.equal(f.search(), search); assert.equal(f.list(), list); assert.equal(f.doc.activeElement, search); assert.equal(search.value, 'model'); assert.equal(search.selectionStart, 2); assert.equal(f.options().length, 2); assert.equal(f.search().getAttribute('aria-activedescendant'), f.options().find(option => option.dataset.modelValue === 'router::vendor/model').id);
});

test('empty searches remain editable; Enter does nothing and Connect is still available', t => {
  const f = fixture(t); f.open(); f.query('nothing-matches'); assert.equal(f.options().length, 0); f.key('Enter'); assert.equal(f.changes.length, 0); assert.equal(f.doc.activeElement, f.search()); f.fire(f.connect(), 'click'); assert.equal(f.changes.at(-1).value, '__connections__');
});

test('disabled state and removal from the authoritative native catalog prevent stale commits', t => {
  const f = fixture(t); f.open(); f.query('different'); f.select.options = f.select.options.filter(option => option.value !== 'router::vendor/model'); f.key('Enter'); assert.equal(f.changes.length, 0); assert.equal(f.select.value, 'default');
  f.open(); f.select.disabled = true; f.key('Enter'); assert.equal(f.changes.length, 0); f.update(); assert.equal(f.panel().hidden, true); assert.equal(f.button().disabled, true); f.open(); assert.equal(f.panel().hidden, true);
});

test('outside click, focus exit, outside scroll and destroy dismiss without stealing another control', t => {
  const f = fixture(t), outside = f.element('input'); f.doc.body.append(outside); f.open(); outside.focus(); f.fire(f.doc, 'pointerdown', { target: outside }); assert.equal(f.panel().hidden, true); assert.equal(f.doc.activeElement, outside);
  f.open(); outside.focus(); f.fire(f.doc, 'focusin', { target: outside }); assert.equal(f.panel().hidden, true); assert.equal(f.doc.activeElement, outside);
  f.open(); f.fire(f.doc, 'scroll', { target: f.list() }); assert.equal(f.panel().hidden, false); f.fire(f.doc, 'scroll', { target: outside }); assert.equal(f.panel().hidden, true);
  const button = f.button(), panel = f.panel(); f.open(); f.ui.destroy(); assert.equal(button.isConnected, false); assert.equal(panel.isConnected, false); assert.equal(f.select.hidden, false); assert.equal([...f.doc.listeners.values()].every(listeners => listeners.size === 0), true); assert.equal([...f.win.listeners.values()].every(listeners => listeners.size === 0), true); f.fire(button, 'click'); assert.equal(panel.hidden, true);
});

test('opening another dialog by keyboard dismisses the picker when the dialog receives focus without reclaiming that focus', t => {
  const f = fixture(t), commands = f.element('section'), commandSearch = f.element('input'), models = f.element('section'), defaultModel = f.element('select');
  commands.setAttribute('role', 'dialog'); commands.setAttribute('aria-modal', 'true'); commands.append(commandSearch); models.setAttribute('role', 'dialog'); models.setAttribute('aria-modal', 'true'); models.append(defaultModel); f.doc.body.append(commands, models);
  for (const destination of [commandSearch, defaultModel]) {
    f.open(); f.query('different'); assert.equal(f.panel().hidden, false);
    // Ctrl+K / Ctrl+M create a dialog, then its scheduled focus lands on its first control.
    destination.focus(); f.fire(f.doc, 'focusin', { target: destination });
    assert.equal(f.panel().hidden, true); assert.equal(f.doc.activeElement, destination); assert.equal(f.button().getAttribute('aria-expanded'), 'false'); assert.equal(f.changes.length, 0);
  }
});

test('Tab can reach Connect inside the picker and leaving the picker by Tab dismisses it without a focus loop', t => {
  const f = fixture(t), nextControl = f.element('button'); f.doc.body.append(nextControl); f.open();
  const tab = f.fire(f.panel(), 'keydown', { target: f.search(), key: 'Tab' }); assert.notEqual(tab.prevented, true, 'the picker preserves native Tab navigation');
  assert.equal(f.search().tabIndex, undefined); assert.equal(f.options().every(option => option.tabIndex === -1), true); assert.notEqual(f.connect().tabIndex, -1);
  f.connect().focus(); f.fire(f.doc, 'focusin', { target: f.connect() }); assert.equal(f.panel().hidden, false); assert.equal(f.doc.activeElement, f.connect());
  nextControl.focus(); f.fire(f.doc, 'focusin', { target: nextControl }); assert.equal(f.panel().hidden, true); assert.equal(f.doc.activeElement, nextControl); assert.equal(f.changes.length, 0);
  f.open(); f.connect().focus(); f.fire(f.doc, 'focusin', { target: f.connect() }); f.fire(f.connect(), 'click'); assert.equal(f.changes.at(-1).value, '__connections__');
});

test('model and provider names are inserted as literal text, including HTML-shaped names', t => {
  const f = fixture(t), snapshot = status(); snapshot.models[1].displayName = '<img src=x onerror=bad()>'; snapshot.providers[0].name = '<b>Provider</b>'; f.update(snapshot); f.open(); f.query('bad');
  assert.equal(f.options().length, 1); assert.match(f.options()[0].textContent, /<img src=x onerror=bad\(\)>/); assert.match(f.options()[0].textContent, /<b>Provider<\/b>/);
});

test('generic default settings choices select a draft and keep Automatic distinct from Codex default', t => {
  const f = fixture(t); f.select.options.push({ value: 'codex' }); const choices = [
    { value: 'default', name: 'Automatic', label: 'Automatic', provider: 'automatic', providerLabel: 'Relay', detail: 'Choose an available model', available: true },
    { value: 'codex', name: 'Codex default', label: 'Codex default', provider: 'codex', providerLabel: 'Codex', detail: 'Your Codex default', available: true },
  ]; f.ui.update({ choices, selected: 'default' }); f.open(); f.key('ArrowDown'); f.key('Enter'); assert.equal(f.select.value, 'codex'); assert.deepEqual(f.changes.map(change => change.value), ['codex']); assert.match(f.button().textContent, /Codex default/);
});

test('popup positioning stays inside a narrow viewport and opens above a bottom composer', () => {
  assert.deepEqual(modelPickerPosition({ anchor: { left: 270, top: 600, bottom: 632 }, width: 380, height: 400, viewportWidth: 1000, viewportHeight: 700 }), { left: 270, top: 193 });
  assert.deepEqual(modelPickerPosition({ anchor: { left: 300, top: 10, bottom: 42 }, width: 296, height: 200, viewportWidth: 320, viewportHeight: 640 }), { left: 12, top: 49 });
});

test('a smaller viewport keeps model search editable and navigation scrolls the active row after positioning', t => {
  const f = fixture(t); f.open(); f.query('model'); const search = f.search(), selected = f.select.value, activeId = search.getAttribute('aria-activedescendant');
  search.selectionStart = 2; search.selectionEnd = 4;
  f.win.innerWidth = 320; f.win.innerHeight = 300; f.button().rect = { left: 260, top: 150, bottom: 182, width: 48, height: 32 };
  f.fire(f.win, 'resize');
  const panel = f.panel(), rect = panel.getBoundingClientRect(), top = Number.parseFloat(panel.style.top), left = Number.parseFloat(panel.style.left);
  assert.ok(top >= 12 && top + rect.height <= f.button().rect.top - 7, 'the list fits the available side of its anchor');
  assert.ok(left >= 12 && left + rect.width <= f.win.innerWidth - 12);
  assert.equal(f.doc.activeElement, search); assert.equal(search.value, 'model'); assert.equal(search.selectionStart, 2); assert.equal(search.selectionEnd, 4); assert.equal(search.getAttribute('aria-activedescendant'), activeId);
  f.key('ArrowDown'); const active = f.options().find(option => option.id === search.getAttribute('aria-activedescendant')); assert.equal(active.scrollCount, 1);
  assert.equal(f.select.value, selected); assert.equal(f.changes.length, 0);
});

const retiredSnapshot = () => {
  const snapshot = status();
  snapshot.chatMode = { available: true, ready: true, state: 'ready' };
  snapshot.models.push({ id: 'chatgpt::chat-mode', displayName: 'ChatGPT Chat Mode', providerId: 'chatgpt', available: true, experimental: true, setupAction: 'chat-mode' });
  return snapshot;
};

test('a stale experimental catalog cannot offer the retired route to a working conversation', t => {
  const f = fixture(t); f.update(retiredSnapshot()); f.open(); f.query('ChatGPT');
  assert.equal(f.options().length, 0); assert.equal(f.route(), undefined);
  assert.equal(f.select.value, 'default'); assert.deepEqual(f.changes, []);
});

test('a saved retired selection remains visible and unavailable without browser setup controls', t => {
  const connections = [], reverse = [], id = 'chatgpt::chat-mode';
  const f = fixture(t, { selected: id, onConnect: choice => connections.push(choice.value), onChatModeSetup: () => reverse.push(true) });
  f.update(retiredSnapshot()); f.open(); f.query('ChatGPT');
  assert.equal(f.options().length, 1); assert.match(f.options()[0].textContent, /Retired/);
  assert.equal(f.options()[0].classList.contains('is-unavailable'), true);
  assert.equal(f.route(), undefined); assert.equal(f.routeSetup(), undefined); assert.equal(f.routeRefresh(), undefined); assert.equal(f.routeAcknowledge(), undefined);
  f.fire(f.list(), 'click', { target: f.options()[0] });
  assert.deepEqual(connections, [id]); assert.deepEqual(reverse, []);
  assert.equal(f.select.value, id); assert.deepEqual(f.changes, []);
});

test('a retired inherited default cannot appear ready even when a stale caller marks it available', t => {
  const snapshot = retiredSnapshot(); snapshot.defaultModel = 'chatgpt::chat-mode'; snapshot.defaultModelAvailable = true;
  const choices = modelPickerChoices(missionModels(snapshot), snapshot);
  assert.equal(choices[0].value, 'default'); assert.equal(choices[0].available, false); assert.equal(choices[0].availabilityLabel, 'Retired');
  assert.equal(choices.filter(choice => choice.modelId === snapshot.defaultModel).length, 1);
});

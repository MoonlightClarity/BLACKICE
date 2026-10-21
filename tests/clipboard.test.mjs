import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardWriter, clipboardFailureMessage, CLIPBOARD_UNAVAILABLE_MESSAGE, MAX_CLIPBOARD_CHARS } from '../public/clipboard.mjs';
import { mountRemoteAccess } from '../public/remote-access-ui.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

// No test reads or writes the machine clipboard. This event surface models the
// browser command's affirmative/denied results and observes only supplied text.
function browser({ commandResult = true, commandError = null, modal = false } = {}) {
  const commands = [], nodes = [], document = { activeElement: null };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
      this.value = ''; this.style = {}; this.attributes = {}; this.scrollLeft = 0; this.scrollTop = 0;
      this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; nodes.push(this);
    }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
    closest(selector) { return selector === 'dialog[open]' && this.tagName === 'DIALOG' ? this : this.parentElement?.closest(selector) || null; }
    focus() { document.activeElement = this; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    setAttribute(name, value) { this.attributes[name] = value; }
    remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; if (document.activeElement === this) document.activeElement = document.body; }
  }
  document.body = new Element('body'); document.scrollingElement = document.body;
  const scope = modal ? document.body.appendChild(new Element('dialog')) : document.body;
  const editor = scope.appendChild(new Element('textarea')); editor.value = 'My carefully selected unsent draft.';
  editor.setSelectionRange(3, 22, 'backward'); editor.scrollTop = 51; editor.scrollLeft = 7; editor.focus();
  document.body.scrollTop = 200;
  document.defaultView = { scrollX: 11, scrollY: 210, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } };
  const range = { commonAncestorContainer: scope, cloneRange() { return { ...this }; } };
  const selection = {
    ranges: [range], anchorNode: scope, anchorOffset: 4, focusNode: scope, focusOffset: 1,
    get rangeCount() { return this.ranges.length; }, getRangeAt(i) { return this.ranges[i]; },
    removeAllRanges() { this.ranges = []; }, addRange(value) { this.ranges.push(value); },
    setBaseAndExtent(anchor, start, focus, end) { this.anchorNode = anchor; this.anchorOffset = start; this.focusNode = focus; this.focusOffset = end; },
  };
  document.getSelection = () => selection;
  document.createElement = tag => new Element(tag);
  document.querySelectorAll = selector => selector === 'dialog[open]' && modal ? [scope] : [];
  document.execCommand = command => {
    const field = document.activeElement;
    commands.push({ command, text: field.value, start: field.selectionStart, end: field.selectionEnd, parent: field.parentElement });
    // Model the selection/focus/scroll changes that a native selection may make.
    selection.removeAllRanges(); selection.anchorNode = field; selection.anchorOffset = 0; selection.focusNode = field; selection.focusOffset = field.value.length;
    editor.setSelectionRange(0, 0); editor.scrollLeft = 0; editor.scrollTop = 0;
    document.body.scrollTop = 0; document.defaultView.scrollTo(0, 0);
    if (commandError) throw commandError;
    return commandResult;
  };
  const assertRestored = () => {
    assert.equal(document.activeElement, editor); assert.equal(editor.value, 'My carefully selected unsent draft.');
    assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [3, 22, 'backward']);
    assert.deepEqual([editor.scrollLeft, editor.scrollTop, document.body.scrollTop], [7, 51, 200]);
    assert.deepEqual([document.defaultView.scrollX, document.defaultView.scrollY], [11, 210]);
    assert.deepEqual([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset], [scope, 4, scope, 1]);
    assert.equal(selection.rangeCount, 1);
    for (const node of nodes.filter(node => node !== editor && node.tagName === 'TEXTAREA')) { assert.equal(node.isConnected, false); assert.equal(node.value, ''); }
  };
  return { document, editor, scope, commands, nodes, assertRestored };
}

test('native write-only receipt completes Copy without browser permission or selection work', async () => {
  const supplied = 'Exact copied text\n<script>literal, not HTML</script>\n😀', calls = [];
  const write = createClipboardWriter({
    getDesktop: () => ({ writeClipboard: async text => { calls.push(text); return { copied: true }; } }),
    getDocument: () => { throw new Error('Browser fallback must not run.'); },
    getNavigator: () => { throw new Error('Browser permission must not be requested.'); },
  });
  assert.deepEqual(await write(supplied), { copied: true, method: 'desktop' }); assert.deepEqual(calls, [supplied]);
});

test('remote browser selection-copy runs synchronously in the user action and preserves the draft', async () => {
  const f = browser(), supplied = 'Exact remote-device copy\n<literal> & 😀'; let apiCalls = 0, gesture = true;
  const command = f.document.execCommand;
  f.document.execCommand = name => { assert.equal(gesture, true, 'copy must precede any await that can lose activation'); return command(name); };
  const write = createClipboardWriter({ getDesktop: () => undefined, getDocument: () => f.document, getNavigator: () => ({ clipboard: { writeText: async () => { apiCalls++; throw new Error('NotAllowedError: permission denied'); } } }) });
  const pending = write(supplied); gesture = false;
  assert.equal(f.commands.length, 1); assert.deepEqual(await pending, { copied: true, method: 'selection' });
  assert.equal(apiCalls, 0); assert.deepEqual(f.commands.map(({ command, text, start, end }) => ({ command, text, start, end })), [{ command: 'copy', text: supplied, start: 0, end: supplied.length }]);
  f.assertRestored();
});

test('selection-copy stays inside an open native dialog and restores backward document selection', async () => {
  const f = browser({ modal: true });
  const write = createClipboardWriter({ getDesktop: () => undefined, getDocument: () => f.document, getNavigator: () => undefined });
  await write('Dialog path'); assert.equal(f.commands[0].parent, f.scope); f.assertRestored();
});

test('a denied selection command falls back to the Clipboard API and awaits completion', async () => {
  const f = browser({ commandResult: false }); let resolve, completed = false;
  const accepted = new Promise(yes => { resolve = yes; }), calls = [];
  const write = createClipboardWriter({ getDesktop: () => undefined, getDocument: () => f.document, getNavigator: () => ({ clipboard: { writeText(text) { calls.push(text); return accepted; } } }) });
  const pending = write('API-owned text').then(result => { completed = true; return result; });
  await Promise.resolve(); assert.equal(completed, false); assert.deepEqual(calls, ['API-owned text']); f.assertRestored();
  resolve(); assert.deepEqual(await pending, { copied: true, method: 'clipboard' });
});

test('denied browser APIs never claim success, reflect an exception, or lose the selection', async () => {
  const f = browser({ commandResult: false }), confidential = 'fixture-credential-must-never-appear-in-errors';
  const write = createClipboardWriter({ getDesktop: () => undefined, getDocument: () => f.document, getNavigator: () => ({ clipboard: { async writeText() { throw new Error(`Failed to execute writeText: permission denied ${confidential}`); } } }) });
  await assert.rejects(write(confidential), error => {
    assert.equal(error.code, 'CLIPBOARD_UNAVAILABLE'); assert.equal(error.message, CLIPBOARD_UNAVAILABLE_MESSAGE);
    assert.equal(error.cause, undefined); assert.doesNotMatch(String(error), /fixture-credential|writeText|permission denied/); return true;
  });
  f.assertRestored();
});

test('an exception during selection-copy cleans temporary text and still permits API recovery', async () => {
  const f = browser({ commandError: new Error('Disabled command') }), supplied = [];
  const write = createClipboardWriter({ getDesktop: () => undefined, getDocument: () => f.document, getNavigator: () => ({ clipboard: { async writeText(text) { supplied.push(text); } } }) });
  assert.equal((await write('Recover this copy')).method, 'clipboard'); assert.deepEqual(supplied, ['Recover this copy']); f.assertRestored();
});

test('a browser refusing temporary focus never copies the editor’s previous selection', async () => {
  const f = browser(), create = f.document.createElement, supplied = [];
  f.document.createElement = tag => { const field = create(tag); field.focus = () => {}; return field; };
  const write = createClipboardWriter({ getDesktop: () => undefined, getDocument: () => f.document, getNavigator: () => ({ clipboard: { async writeText(text) { supplied.push(text); } } }) });
  assert.equal((await write('Copy this exact response')).method, 'clipboard');
  assert.deepEqual(f.commands, []); assert.deepEqual(supplied, ['Copy this exact response']); f.assertRestored();
});

test('native denial or an unconfirmed native result cannot masquerade as a successful copy', async () => {
  for (const writeClipboard of [async () => { throw new Error('Native denial containing fixture-secret'); }, async () => ({}), async () => ({ copied: false })]) {
    const write = createClipboardWriter({ getDesktop: () => ({ writeClipboard }), getDocument: () => undefined, getNavigator: () => undefined });
    await assert.rejects(write('Exact text'), { code: 'CLIPBOARD_UNAVAILABLE', message: CLIPBOARD_UNAVAILABLE_MESSAGE });
  }
});

test('missing browser APIs fail usefully while a missing selection API still allows modern copying', async () => {
  const unavailable = createClipboardWriter({ getDesktop: () => undefined, getDocument: () => undefined, getNavigator: () => undefined });
  await assert.rejects(unavailable('Text'), { code: 'CLIPBOARD_UNAVAILABLE' });
  const supplied = [], modern = createClipboardWriter({ getDesktop: () => undefined, getDocument: () => ({}), getNavigator: () => ({ clipboard: { async writeText(text) { supplied.push(text); } } }) });
  assert.equal((await modern('Text')).method, 'clipboard'); assert.deepEqual(supplied, ['Text']);
});

test('empty, non-text and oversized copy requests stop before any clipboard or DOM access', async () => {
  const stop = () => { throw new Error('Invalid input must not reach a capability.'); };
  const write = createClipboardWriter({ getDesktop: stop, getDocument: stop, getNavigator: stop });
  for (const value of ['', null, 42, {}, new String('text')]) await assert.rejects(write(value), { code: 'CLIPBOARD_EMPTY' });
  await assert.rejects(write('a'.repeat(MAX_CLIPBOARD_CHARS + 1)), { code: 'CLIPBOARD_TOO_LARGE' });
  assert.equal(clipboardFailureMessage(new Error('fixture-secret')), CLIPBOARD_UNAVAILABLE_MESSAGE);
  assert.equal(clipboardFailureMessage({ code: 'CLIPBOARD_TOO_LARGE', message: 'fixture-secret' }), 'This text is too large to copy at once. Use Export or select a smaller section.');
});

test('remote Settings retains the pairing code and agent draft after denial and confirms only a completed retry', async t => {
  const f = planningDOM(t), status = { enabled: true, mode: 'private', url: 'https://owned-fixture.example.test/', devices: [] }, calls = [], supplied = [];
  const code = 'fixture-one-use-code', draft = 'My unsaved agent name'; let denied = true, finish, started;
  const accepted = new Promise(resolve => { finish = resolve; });
  const copying = new Promise(resolve => { started = resolve; });
  const ui = mountRemoteAccess({ mount: f.mount, status, api: async (...args) => {
    calls.push(args); assert.equal(args[0], '/api/remote-access/pair'); return { code, pairUrl: status.url + '?code=' + code, expiresAt: '2026-10-20T12:00:00Z', status };
  }, writeClipboard: async text => {
    supplied.push(text);
    if (denied) throw new Error(`Failed to execute writeText: permission denied ${code}`);
    started();
    await accepted;
  } });
  t.after(() => { finish(); ui.destroy(); });
  await f.click('#remote-pair'); await f.input('#remote-agent-name', draft);
  const field = f.$('#remote-agent-name'); field.focus(); field.setSelectionRange(3, 12, 'backward');
  await f.click('[data-remote-action="copy-code"]');
  const error = f.$('#remote-access-message');
  assert.equal(error.getAttribute('role'), 'alert'); assert.equal(error.textContent, CLIPBOARD_UNAVAILABLE_MESSAGE);
  assert.doesNotMatch(error.textContent, /fixture-one-use-code|writeText|permission denied|copied/i);
  assert.equal(f.$('#remote-pair-code').value, code); assert.equal(f.$('#remote-agent-name').value, draft);
  assert.equal(f.document.activeElement, f.$('#remote-agent-name'));
  assert.deepEqual([f.document.activeElement.selectionStart, f.document.activeElement.selectionEnd, f.document.activeElement.selectionDirection], [3, 12, 'backward']);
  denied = false; const pending = f.click('[data-remote-action="copy-code"]'); await copying;
  assert.equal(Boolean(f.$('#remote-access-message')), false, 'an unconfirmed write has no success receipt');
  finish(); await pending;
  assert.equal(f.$('#remote-access-message').getAttribute('role'), 'status'); assert.equal(f.$('#remote-access-message').textContent, 'Pairing code copied.');
  assert.deepEqual(supplied, [code, code]); assert.equal(calls.length, 1, 'retrying Copy neither creates a new code nor sends it to the host');
  assert.equal(f.$('#remote-agent-name').value, draft);
});

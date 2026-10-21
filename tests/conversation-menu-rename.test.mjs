import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationMenuActions, initConversationMenu } from '../public/conversation-menu.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const event = (target, extra = {}) => ({ target, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
function fixture(t, { state = 'active', working = false, action } = {}) {
  const original = Object.fromEntries(['document', 'window'].map(key => [key, globalThis[key]]));
  const calls = [], errors = [], targets = new Map(), nodes = [];
  function element(tagName = 'DIV') {
    const listeners = new Map(), attributes = new Map(), node = {
      tagName, dataset: {}, children: [], parent: null, hidden: false, disabled: false, style: {}, isConnected: true,
      setAttribute(key, value) { attributes.set(key, String(value)); }, getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key),
      focus() { globalThis.document.activeElement = this; },
      contains(other) { for (let current = other; current; current = current.parent) if (current === this) return true; return false; },
      append(child) { child.parent = this; this.children.push(child); },
      remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      closest(selector) { const key = { '[data-conversation-id]': 'conversationId', '[data-chat-action]': 'chatAction', '[data-chat-more]': 'chatMore' }[selector]; return key && this.dataset[key] ? this : this.parent?.closest(selector) || null; },
      querySelectorAll(selector) { return selector === '[role="menuitem"]' ? this.children.filter(child => child.getAttribute('role') === 'menuitem') : []; },
      getBoundingClientRect: () => ({ left: 18, top: 32, bottom: 66, width: 176, height: 130 }),
      addEventListener(type, handler) { const list = listeners.get(type) || []; list.push(handler); listeners.set(type, list); },
      removeEventListener(type, handler) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== handler)); },
      dispatch(type, input) { return Promise.all((listeners.get(type) || []).map(handler => handler(input))); },
    };
    let html = '';
    Object.defineProperty(node, 'innerHTML', { get: () => html, set(value) {
      html = value; for (const child of node.children) child.isConnected = false; node.children = [];
      for (const match of value.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
        const child = element('BUTTON'); child.textContent = match[2]; child.dataset.chatAction = match[1].match(/data-chat-action="([^"]+)"/)[1]; child.disabled = / disabled/.test(match[1]); child.setAttribute('role', 'menuitem');
        for (const attribute of match[1].matchAll(/(aria-[\w-]+)="([^"]*)"/g)) child.setAttribute(attribute[1], attribute[2]);
        node.append(child);
      }
    } });
    nodes.push(node); return node;
  }
  const documentEvents = element(), windowEvents = element(), mount = element(), fallback = element('INPUT'), editor = element('INPUT');
  globalThis.document = { activeElement: fallback, createElement: element, addEventListener: documentEvents.addEventListener, removeEventListener: documentEvents.removeEventListener };
  globalThis.window = { innerWidth: 900, innerHeight: 700, addEventListener: windowEvents.addEventListener, removeEventListener: windowEvents.removeEventListener };
  const ui = initConversationMenu({ mount, resolveTarget: (id, runId) => { const value = targets.get(id); return value?.runId === runId ? value : null; },
    onAction: async (...args) => { calls.push(args); return action?.(...args, editor); }, onError: error => errors.push(error.message), fallbackFocus: () => fallback });
  function row(id = 'target', bucket = state, extra = {}) {
    const button = element('BUTTON'); button.dataset = { conversationId: id, id: `${id}-latest`, ...extra }; mount.append(button);
    targets.set(id, { id, runId: button.dataset.id, title: `Chat ${id}`, state: bucket, working }); return button;
  }
  const target = row(), menu = mount.children[0];
  t.after(() => { ui.destroy(); for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  return { ui, mount, target, menu, targets, calls, errors, editor, fallback, row, element,
    item: action => menu.children.find(child => child.dataset.chatAction === action),
    async open(button = target) { button.focus(); await mount.dispatch('contextmenu', event(button, { clientX: 885, clientY: 690 })); },
    key(button = target, extra = {}) { button.focus(); const input = event(button, { key: 'F2', ...extra }); return { input, pending: mount.dispatch('keydown', input) }; },
  };
}

test('Rename is first for active and archived chats, including working chats; Trash only offers Restore', () => {
  for (const state of ['active', 'archived']) {
    const actions = conversationMenuActions({ state, working: true });
    assert.equal(actions[0].action, 'rename'); assert.equal(actions[0].disabled, false); assert.equal(actions[0].shortcut, 'F2');
    assert.equal(actions.find(item => item.action === 'delete').disabled, true);
  }
  assert.deepEqual(conversationMenuActions({ state: 'deleted' }).map(item => item.action), ['restore']);
});

test('menu Rename uses the captured row, retains the editor focus, and does not resolve a different selected chat', async t => {
  const f = fixture(t, { state: 'archived', action: (_action, _target, editor) => editor.focus() });
  await f.open(); assert.equal(document.activeElement, f.item('rename')); assert.equal(f.item('rename').getAttribute('aria-keyshortcuts'), 'F2'); assert.equal(f.calls.length, 0);
  f.targets.get('target').title = 'A newer catalog title';
  await f.menu.dispatch('click', event(f.item('rename')));
  assert.deepEqual(f.calls, [['rename', { id: 'target', runId: 'target-latest', title: 'Chat target', state: 'archived', working: false }]]);
  assert.equal(f.menu.hidden, true); assert.equal(document.activeElement, f.editor); assert.equal(f.target.getAttribute('aria-expanded'), undefined);
});

test('F2 directly opens Rename for a focused chat row or More button with a fresh copied target', async t => {
  const f = fixture(t, { action: (_action, _target, editor) => editor.focus() });
  for (const button of [f.target, f.row('archived', 'archived', { chatMore: 'true' })]) {
    const { input, pending } = f.key(button); await pending;
    assert.equal(input.defaultPrevented, true); assert.equal(input.stopped, true); assert.equal(f.menu.hidden, true); assert.equal(document.activeElement, f.editor);
    const [action, target] = f.calls.at(-1); assert.equal(action, 'rename'); assert.equal(target.id, button.dataset.conversationId); assert.notEqual(target, f.targets.get(target.id));
  }
  assert.equal(f.calls.length, 2);
});

test('F2 ignores typing/composition, modifiers, repeats, default-prevented events and unavailable targets', async t => {
  const f = fixture(t);
  for (const extra of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) await f.key(f.target, extra).pending;
  await f.key(f.row('trash', 'deleted')).pending;
  f.target.dataset.id = 'stale-run'; await f.key().pending;
  await f.mount.dispatch('keydown', event(f.fallback, { key: 'F2' }));
  f.target.dataset.id = 'target-latest'; f.fallback.focus(); await f.mount.dispatch('keydown', event(f.target, { key: 'F2' }));
  const editor = f.element('INPUT'); f.target.append(editor); editor.focus(); await f.mount.dispatch('keydown', event(editor, { key: 'F2' }));
  assert.equal(f.calls.length, 0); assert.equal(f.menu.hidden, true);
});

test('a delayed menu Rename coalesces click and F2 activation, reports failure, and restores row focus', async t => {
  const gate = deferred(), f = fixture(t, { action: () => gate.promise }); await f.open();
  const pending = f.menu.dispatch('click', event(f.item('rename'))); await f.menu.dispatch('click', event(f.item('rename')));
  assert.equal(f.menu.getAttribute('aria-busy'), 'true'); assert.equal(f.menu.children.every(item => item.disabled), true); assert.equal(document.activeElement, f.menu);
  const other = f.row('other'); const repeated = f.key(other); await repeated.pending; assert.equal(f.calls.length, 1);
  f.menu.focus(); gate.reject(new Error('Rename is temporarily unavailable.')); await pending;
  assert.deepEqual(f.errors, ['Rename is temporarily unavailable.']); assert.equal(f.menu.hidden, true); assert.equal(document.activeElement, f.target);
});

test('keyboard Rename stays single flight and never steals a newer focus when its callback fails', async t => {
  const gate = deferred(), f = fixture(t, { action: () => gate.promise });
  const first = f.key(); await f.key(f.row('other')).pending; assert.equal(f.calls.length, 1);
  f.editor.focus(); gate.reject(new Error('Try again.')); await first.pending;
  assert.deepEqual(f.errors, ['Try again.']); assert.equal(document.activeElement, f.editor); assert.equal(f.menu.hidden, true);
});

test('Rename remains reachable by menu keyboard navigation while working-chat Delete cannot be forced', async t => {
  const f = fixture(t, { working: true }); await f.open(); assert.equal(document.activeElement, f.item('rename'));
  await f.menu.dispatch('keydown', event(f.item('rename'), { key: 'ArrowDown' })); assert.equal(document.activeElement, f.item('archive'));
  await f.menu.dispatch('keydown', event(f.item('archive'), { key: 'ArrowDown' })); assert.equal(document.activeElement, f.item('rename'));
  f.item('delete').disabled = false; await f.menu.dispatch('click', event(f.item('delete'))); assert.equal(f.calls.length, 0);
  await f.menu.dispatch('click', event(f.item('rename'))); assert.equal(f.calls[0][0], 'rename');
});

test('closed or destroyed menus cannot act, and disposing a pending Rename suppresses late focus and errors', async t => {
  const gate = deferred(), f = fixture(t, { action: () => gate.promise }); await f.open(); const stale = f.item('rename'); f.ui.close();
  await f.menu.dispatch('click', event(stale)); assert.equal(f.calls.length, 0);
  const first = f.key(); f.ui.destroy(); f.fallback.focus(); gate.reject(new Error('Late failure')); await first.pending;
  await f.key().pending; assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, []); assert.equal(f.menu.isConnected, false);
});

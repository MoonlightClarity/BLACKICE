// Small event-driven DOM for plan editing identity and focus. Windows Chromium
// acceptance is responsible for real CSS, geometry and native control painting.
export function planningDOM(t, { width = 1440, normalizeMarkup = false } = {}) {
  const old = new Map(['document', 'window'].map(key => [key, { present: Object.hasOwn(globalThis, key), value: globalThis[key] }]));
  const decode = value => String(value || '').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const camel = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set(); this.scrollTop = 0; this.scrollLeft = 0; this.markup = ''; this.rawText = ''; this.hidden = false; this.inert = false; this.open = false; this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; this.style = { setProperty(name,value) { this[name]=String(value); } }; this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: name => this.classes.has(name), toggle: (name, value) => { const next = value ?? !this.classes.has(name); next ? this.classes.add(name) : this.classes.delete(name); return next; } }; }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); } get className() { return [...this.classes].join(' '); }
    set id(value) { this.attributes.set('id', String(value)); } get id() { return this.attributes.get('id') || ''; }
    get name() { return this.getAttribute('name') || ''; } get type() { return this.getAttribute('type') || this.tagName.toLowerCase(); }
    get ownerDocument() { return document; } get isConnected() { return this.root || this.parentElement?.isConnected === true; }
    set value(value) { this.fieldValue = String(value); } get value() { return this.fieldValue ?? (this.tagName === 'TEXTAREA' ? this.rawText : this.tagName === 'SELECT' ? ((this.children.find(item => item.hasAttribute('selected')) || this.children[0])?.getAttribute('value') ?? (this.children.find(item => item.hasAttribute('selected')) || this.children[0])?.textContent ?? '') : this.getAttribute('value') || ''); }
    set checked(value) { this.checkValue = Boolean(value); } get checked() { return this.checkValue ?? this.hasAttribute('checked'); }
    set disabled(value) { value ? this.attributes.set('disabled', '') : this.attributes.delete('disabled'); } get disabled() { return this.attributes.has('disabled'); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = String(value); if (key === 'class') this.className = value; if (key === 'hidden') this.hidden = true; if (key === 'inert') this.inert = true; if (key === 'open') this.open = true; }
    getAttribute(key) { return key === 'class' ? this.className : key.startsWith('data-') ? this.dataset[camel(key.slice(5))] ?? null : this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.getAttribute(key) !== null; }
    removeAttribute(key) { this.attributes.delete(key); if (key.startsWith('data-')) delete this.dataset[camel(key.slice(5))]; }
    appendChild(item) { this.append(item); return item; }
    append(...items) { for (const item of items) { item.remove(); this.children.push(item); item.parentElement = this; } }
    insertBefore(item, reference) { item.remove(); const index = reference ? this.children.indexOf(reference) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, item); item.parentElement = this; }
    remove() { if (!this.parentElement) return; const index = this.parentElement.children.indexOf(this); if (index >= 0) this.parentElement.children.splice(index, 1); this.parentElement = null; }
    replaceWith(item) { const parent = this.parentElement; parent?.insertBefore(item, this); this.remove(); }
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
    matches(selector) {
      if (selector.includes(',')) return selector.split(',').some(value => this.matches(value.trim()));
      const parts = selector.trim().split(/\s+/); if (parts.length > 1) { const leaf = parts.pop(), direct = parts.at(-1) === '>'; if (direct) parts.pop(); if (!this.matches(leaf)) return false; for (let parent = this.parentElement; parent; parent = parent.parentElement) { if (parent.matches(parts.join(' '))) return true; if (direct) break; } return false; }
      const bare = selector.replace(/\[[^\]]*\]/g, ''), tag = bare.match(/^[A-Za-z][\w-]*/)?.[0], id = bare.match(/#([\w-]+)/)?.[1];
      if (tag && this.tagName !== tag.toUpperCase() || id && id !== this.id) return false;
      for (const [, name] of bare.matchAll(/\.([\w-]+)/g)) if (!this.classes.has(name)) return false;
      for (const [, key, value] of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) if (!this.hasAttribute(key) || value !== undefined && this.getAttribute(key) !== value) return false;
      return true;
    }
    querySelectorAll(selector) { const result = []; const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child); } }; visit(this); return result; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    set innerHTML(markup) {
      for (const child of this.children) child.parentElement = null; this.children = []; this.markup = markup; this.rawText = ''; const stack = [this], tokens = /<!--[^]*?-->|<\/?([A-Za-z][\w:-]*)([^>]*?)\/?\s*>/g; let previous = 0;
      for (const match of markup.matchAll(tokens)) { stack.at(-1).rawText += decode(markup.slice(previous, match.index)); previous = match.index + match[0].length; if (!match[1]) continue; if (match[0].startsWith('</')) { if (stack.length > 1) { const ended = stack.pop(); ended.markup = markup.slice(ended.contentStart, match.index); } continue; } const child = new Element(match[1]); child.contentStart = previous; for (const [, key, double, single, unquoted] of match[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'">]+)))?/g)) child.setAttribute(key, decode(double ?? single ?? unquoted ?? '')); stack.at(-1).append(child); if (!match[0].endsWith('/>') && !['LINK', 'IMG', 'INPUT', 'BR', 'HR', 'META'].includes(child.tagName)) stack.push(child); }
      stack.at(-1).rawText += decode(markup.slice(previous));
    }
    get innerHTML() {
      if (!normalizeMarkup) return this.markup;
      // Native details.open reflects into its serialized boolean attribute,
      // just as the browser removes insignificant opening-tag whitespace.
      const details = this.querySelectorAll('details'); let index = 0;
      return this.markup.replace(/\s+>/g, '>').replace(/<details\b([^>]*)>/g, (_, attributes) => {
        const open = details[index++]?.open;
        return `<details${attributes.replace(/\sopen(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/g, '')}${open ? ' open=""' : ''}>`;
      });
    }
    set textContent(value) { this.rawText = String(value); this.children = []; } get textContent() { return this.rawText + this.children.map(child => child.textContent).join(''); }
    focus(options) { if (this.disabled || !this.isConnected) return; this.focusOptions = options; document.activeElement = this; }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    getBoundingClientRect() { return { top: 0, bottom: 50, left: 0, right: 450, height: 50, width: 450 }; }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    async dispatch(type, values = {}, bubble = false) { const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values }; for (let node = this; node; node = bubble && !event.stopped ? node.parentElement : null) { for (const handler of node.listeners.get(type) || []) await handler(event); await node[`on${type}`]?.(event); } return event; }
  }
  const body = new Element('body'), head = new Element('head'), events = new Element('document'), windowEvents = new Element('window'), mount = new Element('section'); body.root = true; head.root = true; body.append(mount);
  const document = { body, head, activeElement: null, visibilityState: 'visible', createElement: tag => new Element(tag), createElementNS: (_namespace,tag) => new Element(tag), getElementById: id => head.querySelector(`#${id}`) || body.querySelector(`#${id}`), querySelector: selector => head.querySelector(selector) || body.querySelector(selector), addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args) };
  const medias = new Map();
  globalThis.document = document; globalThis.window = { addEventListener: (...args) => windowEvents.addEventListener(...args), removeEventListener: (...args) => windowEvents.removeEventListener(...args), matchMedia(query) { if (!medias.has(query)) { const media = new Element('media'); media.matches = width <= Number(/max-width:\s*(\d+)/.exec(query)?.[1] || 0); medias.set(query, media); } return medias.get(query); }, getSelection: () => null };
  t.after(() => { for (const [key, before] of old) if (before.present) globalThis[key] = before.value; else delete globalThis[key]; });
  return { mount, document, element: tag => new Element(tag), $(selector) { return mount.querySelector(selector); }, async visibility(value) { document.visibilityState = value; await events.dispatch('visibilitychange'); }, async page(event) { await windowEvents.dispatch(event); }, async click(selector) { const target = typeof selector === 'string' ? mount.querySelector(selector) : selector; if (!target) throw new Error(`Missing test control: ${selector}`); return target.dispatch('click', {}, true); }, async input(selector, value) { const target = mount.querySelector(selector); target.value = value; await target.dispatch('input', {}, true); return target; }, async key(target, key) { return target.dispatch('keydown', { key }, true); }, async resize(next) { width = next; for (const [query, media] of medias) { media.matches = width <= Number(/max-width:\s*(\d+)/.exec(query)?.[1] || 0); await media.dispatch('change', { matches: media.matches }); } } };
}

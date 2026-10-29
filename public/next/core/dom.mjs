export const one = (root, selector) => root.querySelector(selector);
export const all = (root, selector) => Array.from(root.querySelectorAll(selector));
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '"': '&quot;', "'": '&#39;' }[c]));
export const text = (parent, content, tag = 'span', className = '') => {
  const node = parent.ownerDocument.createElement(tag);
  node.className = className; node.textContent = String(content ?? '');
  parent.append(node); return node;
};
let dateFormatter;
export const formatDate = value => {
  if (!value) return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? (dateFormatter ||= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })).format(ms) : '';
};
export const showError = (node, error) => { if (!node) return; node.textContent = String(error?.message || error || 'An operation failed.'); node.hidden = false; };
export function stableId(prefix = 'action') {
  return prefix + '_' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
}

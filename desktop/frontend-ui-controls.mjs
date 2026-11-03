// Browser-local references expire with the document. Never use them across reloads.
export function uiRegistry() {
  const key = Symbol.for('blackice.frontend.ui.references');
  if (!document[key]) Object.defineProperty(document, key, { value: {
    documentId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), nodes: new Map(), refs: new WeakMap(), next: 0,
  } });
  const state = document[key];
  for (const [ref, node] of state.nodes) if (!node.isConnected) state.nodes.delete(ref);
  return { ...state, ref(node) {
    if (!state.refs.has(node)) { const ref = 'ui-' + ++state.next; state.refs.set(node, ref); state.nodes.set(ref, node); }
    const ref = state.refs.get(node); state.nodes.set(ref, node); return ref;
  } };
}

// Serialized into the app renderer. It intentionally does not evaluate caller JS.
export function prepareUI(args, registry) {
  const fail = (message, code) => ({ ok: false, error: { message, code } });
  if (args.expectedDocumentId !== registry.documentId || args.expectedUrl !== location.href)
    return fail('The document changed. Take a fresh snapshot before acting.', 'FRONTEND_UI_STALE_DOCUMENT');
  const node = registry.nodes.get(args.ref);
  if (!node?.isConnected) return fail('The referenced element is no longer attached. Take a fresh snapshot.', 'FRONTEND_UI_STALE_REF');
  if (node.disabled || node.matches?.(':disabled') || node.closest('[inert],[aria-disabled="true"]')) return fail('The target is disabled or inert.', 'FRONTEND_UI_DISABLED');
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' ||
      (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })))
    return fail('The target is not visible.', 'FRONTEND_UI_HIDDEN');
  const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
  const y = Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2;
  if (rect.bottom <= 0 || rect.right <= 0 || rect.left >= innerWidth || rect.top >= innerHeight)
    return fail('The target is outside the viewport. Scroll it into view and take another snapshot.', 'FRONTEND_UI_OFFSCREEN');
  const hit = document.elementFromPoint(x, y);
  if (hit !== node && !node.contains(hit)) return fail('Another element covers the target.', 'FRONTEND_UI_OCCLUDED');
  if (args.operation === 'fill') {
    if (node.type === 'password' || /(?:password|one-time-code)/i.test(node.autocomplete || ''))
      return fail('Use the dedicated credential flow for secrets.', 'FRONTEND_UI_SECRET_INPUT');
    if (!['INPUT', 'TEXTAREA'].includes(node.tagName) || node.readOnly || (node.tagName === 'INPUT' && !['text','search','email','url','tel','number'].includes(node.type)))
      return fail('Fill supports editable text inputs and textareas only.', 'FRONTEND_UI_NOT_EDITABLE');
  }
  if (args.focus) node.focus({ preventScroll: true });
  return { ok: true, documentId: registry.documentId, url: location.href, ref: args.ref,
    tag: node.tagName.toLowerCase(), x, y, focused: document.activeElement === node };
}

export function prepareUIExpression(args) {
  return `(${prepareUI.toString()})(${JSON.stringify(args)}, (${uiRegistry.toString()})())`;
}

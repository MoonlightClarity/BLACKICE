// Shared renderer-only identity and hit-test functions. Their source is injected
// into the exact observed frame; do not close over host state.
export function browserControlDescriptor(el, role) {
  const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
  if (role === undefined) role = el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[el.tagName]) || (/^H[1-6]$/.test(el.tagName) ? 'heading' : '');
  const root = el.getRootNode?.(), doc = el.ownerDocument || document;
  const textOf = node => {
    // textContent omits assigned slot nodes. Use the rendered slot assignment
    // only when the name actually contains a slot; retain the ordinary path.
    if (!node?.querySelector?.('slot') && node?.tagName !== 'SLOT') return node?.textContent || '';
    const parts = []; let count = 0, chars = 0;
    const visit = current => {
      if (!current || ++count > 512 || chars >= 1200) return;
      if (current.nodeType === 3) { const text = String(current.textContent || '').slice(0, 1200 - chars); parts.push(text); chars += text.length; return; }
      if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(current.tagName)) return;
      const assigned = current.tagName === 'SLOT' ? current.assignedNodes?.({ flatten: true }) : null;
      for (const child of assigned?.length ? assigned : current.childNodes || []) visit(child);
    };
    visit(node); return parts.join(' ');
  };
  const labelled = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean).map(id => textOf(root?.getElementById?.(id) || doc?.getElementById?.(id))).join(' ');
  const label = [el.getAttribute('aria-label'), labelled, el.labels ? [...el.labels].map(textOf).join(' ') : '', el.getAttribute('placeholder'), el.getAttribute('aria-placeholder'), el.getAttribute('data-placeholder'), textOf(el), el.getAttribute('title'), el.getAttribute('alt'), el.tagName === 'INPUT' && el.type === 'file' ? (el.name || el.id) : ''].map(normalized).find(Boolean) || '';
  return [el.tagName, el.type || '', role || (el.isContentEditable ? 'textbox' : el.tagName === 'CANVAS' ? 'canvas' : 'element'), label.slice(0, 300)];
}

export function browserPointerHitMatches(el, hit, point, diagnostic) {
  const reject = relationship => {
    if (diagnostic) diagnostic.pointerHitRelationship = relationship;
    return false;
  };
  // A slotted node belongs to its composed ancestor, not necessarily its DOM
  // parent. Never accept an unrelated sibling, overlay, or ordinary ancestor.
  const within = node => {
    const seen = new Set();
    while (node && !seen.has(node)) {
      if (node === el) return true;
      seen.add(node);
      node = node.assignedSlot || node.parentNode || node.host || null;
    }
    return false;
  };
  if (!el?.isConnected || !hit?.isConnected) return reject('disconnected');
  if (hit.ownerDocument !== el.ownerDocument) return reject('different-document');
  if (within(hit)) return true;
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return reject('invalid-local-point');
  // CDP may retarget a hit on assigned text to a custom-element host. Descend
  // ONLY that exact host's open root, using its topmost rendered hit. An
  // ancestor rectangle, text match or a lower hit-stack entry is insufficient.
  const hosts = new Set();
  for (let root = el.getRootNode?.(); root?.host; root = root.host.getRootNode?.()) hosts.add(root.host);
  const seen = new Set();
  while (hit && hosts.has(hit) && !seen.has(hit)) {
    seen.add(hit);
    const root = hit.shadowRoot;
    if (!root || typeof root.elementsFromPoint !== 'function') return reject('shadow-root-unavailable');
    const next = root.elementsFromPoint(point.x, point.y)[0];
    if (!next || next === hit || !next.isConnected) return reject('shadow-hit-unavailable');
    if (within(next)) return true;
    hit = next;
  }
  return reject(seen.size ? 'shadow-hit-unrelated' : 'unrelated');
}

/** A native file picker may be deliberately unrendered while its label or form
 * remains visible. Publish only a named, enabled, connected exact file control;
 * never treat a hidden input as a pointer or keyboard target. */
export function browserAssociatedFileInput(el) {
  if (!el?.isConnected || el.tagName !== 'INPUT' || el.type !== 'file' || el.disabled
    || el.matches?.(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.webkitdirectory) return false;
  const root = el.getRootNode?.();
  const doc = el.ownerDocument;
  const labels = [...(el.labels || [])];
  for (const id of (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean)) {
    const label = root?.getElementById?.(id) || doc?.getElementById?.(id);
    if (label) labels.push(label);
  }
  const visible = node => {
    if (!node?.isConnected) return false;
    const style = getComputedStyle(node), box = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && box.width > 0 && box.height > 0;
  };
  const named = Boolean(String(el.getAttribute('aria-label') || el.name || el.id || labels.map(label => label.textContent || '').join(' ')).trim());
  return named && (labels.some(visible) || visible(el.form));
}

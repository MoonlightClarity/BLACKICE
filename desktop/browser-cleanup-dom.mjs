/**
 * Passive in-page cleanup eligibility probe. Invoked via executeJavaScript with
 * this function stringified, so keep it dependency-free. A clean result requires
 * inspecting every reachable same-origin document and open shadow root.
 * Opaque frames/custom elements are unknown, never interpreted as empty.
 * Even after traversing all reachable roots, closed shadows on ordinary built-in
 * elements cannot be detected by page JS. Such pages have LIMITED coverage,
 * never verified-clean status; they require deliberate manual review to close.
 */
export function inspectCleanupDOM(documentRoot) {
  const unknown = reason => ({ state: 'unknown', reason });
  const interactive = { state: 'interactive' };
  const editableSelector = 'form, input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
  const visited = new Set();
  let nodes = 0, documents = 0;
  function scan(root, depth) {
    if (!root || visited.has(root) || depth > 24) return unknown('An embedded document or shadow tree could not be fully inspected.');
    visited.add(root);
    if (root.nodeType === 9) {
      if (root.readyState !== 'complete') return unknown('A page or embedded frame is still loading.');
      if (++documents > 40) return unknown('The page contains too many embedded documents for bounded inspection.');
    }
    if (typeof root.querySelector !== 'function' || typeof root.querySelectorAll !== 'function')
      return unknown('A document or shadow tree cannot be inspected.');
    if (root.querySelector(editableSelector)) return interactive;
    const elements = root.querySelectorAll('*');
    if (!elements || !Number.isSafeInteger(elements.length) || (nodes += elements.length) > 30000)
      return unknown('This document is too large or cannot be fully inspected.');
    for (const element of elements) {
      const tag = typeof element.localName === 'string' ? element.localName.toLowerCase() : '';
      if (!tag) return unknown('An embedded page element could not be identified.');
      if (tag === 'object' || tag === 'embed' || tag === 'portal')
        return unknown('An embedded surface is not inspectable.');
      if (tag === 'iframe' || tag === 'frame') {
        // Cross-origin frames throw on contentDocument access or return null.
        // Neither means they are empty; both must retain the parent tab.
        let inner;
        try { inner = element.contentDocument; } catch { return unknown('An embedded frame is cross-origin or inaccessible.'); }
        if (!inner) return unknown('An embedded frame is inaccessible or loading.');
        const result = scan(inner, depth + 1);
        if (result.state !== 'clear') return result;
      }
      let shadow;
      try { shadow = element.shadowRoot; } catch { return unknown('An embedded shadow tree is inaccessible.'); }
      if (shadow) {
        const result = scan(shadow, depth + 1);
        if (result.state !== 'clear') return result;
      } else if (tag.includes('-')) {
        // Closed custom-element shadow roots cannot be read through JS.
        // Do not mistake their inaccessible contents for an empty page.
        return unknown('A custom component may contain a closed shadow tree.');
      }
    }
    return { state: 'clear' };
  }
  try {
    const observed = scan(documentRoot, 0);
    if (observed.state !== 'clear') return observed;
    return { state: 'limited', coverage: 'reachable-dom-only',
      reason: 'No editable content was observed in reachable roots; closed shadow roots on ordinary div/span elements may hide unfinished forms.' };
  }
  catch { return unknown('A nested document or shadow tree could not be verified.'); }
}

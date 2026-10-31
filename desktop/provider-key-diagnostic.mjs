/** Self-contained, read-only page diagnostic. Never returns page text or field values. */
export function providerKeyDiagnosticPage(args) {
  try {
    if (location.origin !== args.origin || globalThis.origin !== args.origin || window.top.location.href !== args.expectedUrl) return { valid: false };
    const visible = el => {
      if (!el?.isConnected || el.ownerDocument?.defaultView?.origin !== args.origin || el.closest?.('[hidden],[inert]')) return false;
      const box = el.getBoundingClientRect(), style = el.ownerDocument.defaultView.getComputedStyle(el);
      return (box.width > 0 || box.height > 0) && style.display !== 'none' && style.visibility !== 'hidden';
    };
    for (let frame = window; frame !== frame.top; frame = frame.parent) if (frame.parent.origin !== args.origin || !visible(frame.frameElement)) return { valid: false };
    const token = value => value.length >= 24 && value.length <= 20000 && /^(?=.*[0-9_+/=-])[A-Za-z0-9_+/.=-]+$/.test(value);
    const shape = value => !value ? 'empty' : /(?:\*{2,}|[•●…]|\.{3})/.test(value) ? 'masked' : /\s|[\u0000-\u001f\u007f]/.test(value) ? 'whitespace' : token(value) ? 'token_shaped' : 'other';
    const safeTag = el => ['INPUT', 'TEXTAREA', 'CODE', 'PRE', 'OUTPUT', 'SAMP', 'KBD', 'P', 'SPAN', 'DIV', 'BUTTON', 'A', 'SELECT', 'DIALOG', 'FORM'].includes(el.tagName) ? el.tagName.toLowerCase() : 'other';
    const typeOf = el => ['text', 'password', 'search', 'email', 'number', 'tel', 'url', 'checkbox', 'radio', 'hidden', 'button', 'submit', 'reset', 'date', 'datetime-local'].includes(el.type) ? el.type : el.tagName === 'TEXTAREA' ? 'textarea' : 'other';
    const nameOf = el => String(el.getAttribute('aria-label') || (el.labels ? [...el.labels].map(label => label.textContent).join(' ') : '') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
    const category = label => /api[\s_-]*key|access[\s_-]*token|secret[\s_-]*key/i.test(label) ? 'api_key'
      : /(?:^|\W)(?:cap|limit|budget|credits?)(?:$|\W)/i.test(label) ? 'limit'
        : /expir|duration|ttl/i.test(label) ? 'expiration' : /(?:^|\W)name(?:$|\W)/i.test(label) ? 'name' : 'other';
    const controlKind = el => {
      const label = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (/^(?:copy(?: (?:api )?(?:key|token|secret))?(?: to clipboard)?|copy to clipboard)$/.test(label)) return 'copy';
      if (/^(?:show|reveal)(?: (?:api )?(?:key|token|secret|password))?$/.test(label) || label === 'toggle visibility') return 'reveal';
      if (/^hide(?: (?:api )?(?:key|token|secret|password))?$/.test(label)) return 'hide';
      if (/^create(?: (?:a |new )?(?:api )?key)?$/.test(label) || label === 'generate key') return 'create';
      if (/^(?:close|done|dismiss|cancel|back)$/.test(label)) return label;
      if (/^download(?: (?:api )?(?:key|token|secret))?$/.test(label)) return 'download';
      return 'other';
    };
    const bound = (el, name) => { const value = String(el.getAttribute(name) ?? ''); return /^-?(?:\d{1,12})(?:\.\d{1,8})?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null; };
    const validityKeys = ['valid', 'valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'];
    const roots = [document], seenRoots = new Set(roots), fields = [], controls = [], textCandidates = [];
    const shapes = { empty: 0, masked: 0, whitespace: 0, token_shaped: 0, other: 0 };
    let scannedElements = 0, visibleElements = 0, dialogs = 0, forms = 0, shadowRoots = 0, clipboardAttributeElements = 0, truncated = false;
    for (let rootIndex = 0; rootIndex < roots.length && rootIndex < 40; rootIndex++) {
      for (const el of roots[rootIndex].querySelectorAll('*')) {
        if (++scannedElements > 4000) { truncated = true; break; }
        if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) { seenRoots.add(el.shadowRoot); if (roots.length < 40) { roots.push(el.shadowRoot); shadowRoots++; } else truncated = true; }
        if (!visible(el)) continue;
        visibleElements++;
        const role = el.getAttribute('role'), tag = safeTag(el), withinDialog = Boolean(el.closest?.('[role="dialog"],dialog'));
        if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') dialogs++;
        if (tag === 'form') forms++;
        const clipboardAttributePresent = ['data-clipboard-text', 'data-copy', 'data-clipboard'].some(name => el.hasAttribute(name));
        if (clipboardAttributePresent) clipboardAttributeElements++;
        if (['input', 'textarea', 'select'].includes(tag) || role === 'textbox') {
          if (fields.length >= 48) { truncated = true; continue; }
          const value = String(['input', 'textarea', 'select'].includes(tag) ? el.value ?? '' : el.textContent ?? '').trim(), valueShape = shape(value); shapes[valueShape]++;
          const validity = {};
          if (el.validity) for (const key of validityKeys) validity[key] = el.validity[key] === true;
          fields.push({ index: fields.length, tag, type: typeOf(el), category: category(nameOf(el)), withinDialog,
            readOnly: el.readOnly === true, disabled: el.disabled === true, required: el.required === true,
            valuePresent: value.length > 0, valueShape, validity, min: bound(el, 'min'), max: bound(el, 'max'), step: bound(el, 'step') });
        }
        if (tag === 'button' || role === 'button' || tag === 'input' && ['button', 'submit', 'reset'].includes(typeOf(el))) {
          if (controls.length < 64) controls.push({ index: controls.length, tag, type: typeOf(el), kind: controlKind(el), disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true', withinDialog, clipboardAttributePresent });
          else truncated = true;
        }
        if (['code', 'pre', 'output', 'samp', 'kbd', 'p', 'span', 'div', 'other'].includes(tag)) {
          const text = String(el.textContent ?? '').trim(), textShape = shape(text);
          const direct = [...el.childNodes || []].filter(node => node.nodeType === 3).map(node => String(node.textContent ?? '').trim()).filter(Boolean);
          const directTokenCount = direct.filter(value => shape(value) === 'token_shaped').length;
          if (textShape === 'token_shaped' || textShape === 'masked' || directTokenCount) {
            if (textCandidates.length < 64) textCandidates.push({ index: textCandidates.length, tag, withinDialog, textShape, hasChildElements: Boolean(el.childElementCount), directTokenCount: Math.min(directTokenCount, 32), clipboardAttributePresent });
            else truncated = true;
          }
        }
      }
      if (scannedElements > 4000) break;
    }
    return { valid: true, protectedContent: true, diagnosticsOnly: true, scannedElements: Math.min(scannedElements, 4000), visibleElements,
      dialogs, forms, shadowRoots, clipboardAttributeElements, fields, controls, textCandidates, shapes, truncated };
  } catch { return { valid: false, protectedContent: true, diagnosticsOnly: true }; }
}

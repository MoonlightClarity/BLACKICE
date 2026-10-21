// Write-only copying for explicit UI actions. A remote browser always copies on
// that device; it never asks BLACKICE's HTTP server to touch the host clipboard.
export const MAX_CLIPBOARD_CHARS = 4 * 1024 * 1024;
export const CLIPBOARD_UNAVAILABLE_MESSAGE = 'Copy is unavailable here. Select the text and use your device’s Copy command.';
const TOO_LARGE_MESSAGE = 'This text is too large to copy at once. Use Export or select a smaller section.';

export function clipboardFailureMessage(error, fallback = CLIPBOARD_UNAVAILABLE_MESSAGE) {
  // Native/browser exceptions can include arbitrary text. Never reflect them.
  return error?.code === 'CLIPBOARD_TOO_LARGE' ? TOO_LARGE_MESSAGE : fallback;
}

function failure(code, message) { return Object.assign(new Error(message), { code }); }

function rememberSelection(document) {
  const active = document.activeElement, view = document.defaultView;
  let input = null, selection = null;
  try {
    if (Number.isInteger(active?.selectionStart) && Number.isInteger(active?.selectionEnd)) {
      input = { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
    }
    const current = document.getSelection?.();
    if (current) selection = {
      ranges: Array.from({ length: current.rangeCount }, (_, index) => current.getRangeAt(index).cloneRange()),
      anchorNode: current.anchorNode, anchorOffset: current.anchorOffset,
      focusNode: current.focusNode, focusOffset: current.focusOffset,
    };
  } catch {}
  const scroll = new Map();
  for (let element = active; element; element = element.parentElement) {
    if (typeof element.scrollTop === 'number') scroll.set(element, [element.scrollLeft, element.scrollTop]);
  }
  if (document.scrollingElement) scroll.set(document.scrollingElement, [document.scrollingElement.scrollLeft, document.scrollingElement.scrollTop]);
  const page = view ? [view.scrollX, view.scrollY] : null;
  return () => {
    if (active?.isConnected !== false) {
      try { active?.focus?.({ preventScroll: true }); } catch {}
    }
    if (selection) try {
      const current = document.getSelection();
      current.removeAllRanges();
      for (const range of selection.ranges) {
        if (range.commonAncestorContainer?.isConnected !== false) current.addRange(range);
      }
      // addRange alone loses backward selections in browsers with one range.
      if (selection.ranges.length === 1 && selection.anchorNode?.isConnected !== false && selection.focusNode?.isConnected !== false && selection.anchorNode && selection.focusNode) {
        current.setBaseAndExtent?.(selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset);
      }
    } catch {}
    if (input && active?.isConnected !== false) try { active.setSelectionRange(input.start, input.end, input.direction); } catch {}
    for (const [element, [left, top]] of scroll) {
      if (element.isConnected !== false) { element.scrollLeft = left; element.scrollTop = top; }
    }
    if (page && (view.scrollX !== page[0] || view.scrollY !== page[1])) {
      try { view.scrollTo(page[0], page[1]); } catch {}
    }
  };
}

function copySelection(text, document) {
  if (!document?.body || typeof document.execCommand !== 'function') return false;
  const restore = rememberSelection(document);
  let field;
  try {
    field = document.createElement('textarea');
    field.value = text; field.readOnly = true; field.tabIndex = -1;
    field.autocomplete = 'off'; field.spellcheck = false;
    field.setAttribute('inputmode', 'none');
    field.setAttribute('aria-label', 'Copy text');
    // Do not use hidden/display:none: those prevent selection. Keep native
    // modal dialogs working by placing the temporary field inside their scope.
    field.style.cssText = 'position:fixed;inset:0 auto auto 0;width:1px;height:1px;padding:0;margin:0;border:0;opacity:0;pointer-events:none;font-size:16px;';
    const host = document.activeElement?.closest?.('dialog[open]') || Array.from(document.querySelectorAll?.('dialog[open]') || []).at(-1) || document.body;
    host.appendChild(field);
    field.focus({ preventScroll: true }); field.select();
    field.setSelectionRange(0, text.length);
    if (document.activeElement !== field || field.selectionStart !== 0 || field.selectionEnd !== text.length) return false;
    // Only the browser's affirmative command result counts as a copied value.
    return document.execCommand('copy') === true;
  } catch { return false; }
  finally {
    if (field) { field.value = ''; field.remove(); }
    restore();
  }
}

export function createClipboardWriter({
  getDesktop = () => globalThis.relayDesktop,
  getNavigator = () => globalThis.navigator,
  getDocument = () => globalThis.document,
} = {}) {
  return async function writeClipboard(text) {
    if (typeof text !== 'string' || !text.length) throw failure('CLIPBOARD_EMPTY', 'There is no text to copy.');
    if (text.length > MAX_CLIPBOARD_CHARS) throw failure('CLIPBOARD_TOO_LARGE', TOO_LARGE_MESSAGE);
    const desktop = getDesktop();
    if (typeof desktop?.writeClipboard === 'function') {
      try { if ((await desktop.writeClipboard(text))?.copied === true) return { copied: true, method: 'desktop' }; } catch {}
    }
    // A denied writeText Promise can outlast Firefox's transient activation.
    // Try selection-copy within the Copy click, before the first browser await.
    // execCommand is a compatibility path; the browser still decides access.
    if (copySelection(text, getDocument())) return { copied: true, method: 'selection' };
    try {
      const clipboard = getNavigator()?.clipboard;
      if (typeof clipboard?.writeText === 'function') {
        await clipboard.writeText(text);
        return { copied: true, method: 'clipboard' };
      }
    } catch {}
    throw failure('CLIPBOARD_UNAVAILABLE', CLIPBOARD_UNAVAILABLE_MESSAGE);
  };
}

export const writeClipboard = createClipboardWriter();

import { browserOwner } from '../lib/browser.mjs';
import { providerKeyTarget, providerKeyFailure } from '../lib/provider-key-contract.mjs';

const changed = () => Object.assign(new Error('The protected provider key source changed.'), { code: 'PROVIDER_KEY_SOURCE_CHANGED' });
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('Provider key setup cancelled.'), { code: 'ABORT_ERR', name: 'AbortError' }); };
const owns = (tab, owner) => !owner || (tab.owner ? tab.owner.taskId === owner.taskId && tab.owner.nodeId === owner.nodeId : owner.allowUserTabs === true);

/** Runs in one exact same-origin frame. Only capture returns bytes, to the host. */
export function providerKeyPage(key, prefix, args) {
  try {
    // Restoration never reads a value or grants input. A same-document history
    // change must not prevent removal of this exact operation's interceptor.
    if (args.action === 'copy_cleanup') {
      const current = globalThis[key], capture = current?.providerKeyClipboardCapture;
      if (current?.document !== document || current?.prefix !== prefix || !capture || capture.ref !== args.ref || args.captureId !== undefined && capture.id !== args.captureId) return { valid: false };
      capture.cleanup(); return { valid: true };
    }
    if (location.origin !== args.origin || globalThis.origin !== args.origin || window.top.location.href !== args.expectedUrl) return { valid: false };
    const visible = el => {
      if (!el?.isConnected || el.ownerDocument?.defaultView?.origin !== args.origin || el.closest?.('[hidden],[inert]')) return false;
      const box = el.getBoundingClientRect(), style = el.ownerDocument.defaultView.getComputedStyle(el);
      return (box.width > 0 || box.height > 0) && style.display !== 'none' && style.visibility !== 'hidden';
    };
    for (let frame = window; frame !== frame.top; frame = frame.parent) if (frame.parent.origin !== args.origin || !visible(frame.frameElement)) return { valid: false };
    let state = globalThis[key];
    if (!state || state.document !== document || state.prefix !== prefix) state = globalThis[key] = { document, prefix, documentId: Math.random().toString(36).slice(2), elements: new Map(), identities: new Map(), descriptors: new WeakMap(), ids: new WeakMap(), next: 0, credentialFields: new WeakSet() };
    state.providerKeySources ||= new Map(); state.providerKeyRefs ||= new WeakMap();
    const valueOf = el => ['INPUT', 'TEXTAREA'].includes(el.tagName) ? String(el.value ?? '').trim() : String(el.textContent ?? '').trim();
    const validValue = value => value.length >= 8 && value.length <= 20000 && !/\s|[\u0000-\u001f\u007f]/.test(value) && !/(?:\*{2,}|[•●…]|\.{3})/.test(value);
    const labelOf = el => {
      const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
      return String(el.getAttribute('aria-label') || labelled || (el.labels ? [...el.labels].map(label => label.textContent).join(' ') : '') || el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    };
    const copyControl = el => visible(el) && !el.disabled && !el.matches?.(':disabled') && el.getAttribute('aria-disabled') !== 'true'
      && /^(?:copy(?: (?:api )?(?:key|token|secret))?(?: to clipboard)?|copy to clipboard)$/i.test(labelOf(el));
    const copySourceIdentityCurrent = source => visible(source.element) && visible(source.displayElement) && state.elements.get(args.ref) === source.element && state.providerKeySources.get(args.ref) === source
      && source.element.closest?.('[role="dialog"],dialog') === source.dialog && source.displayElement.closest?.('[role="dialog"],dialog') === source.dialog
      && valueOf(source.displayElement) === source.observedDisplayValue;
    const copySourceCurrent = source => copyControl(source.element) && copySourceIdentityCurrent(source);
    const copyResultCurrent = source => copySourceIdentityCurrent(source) && (copyControl(source.element) || /^copied(?: to clipboard)?!?$/i.test(labelOf(source.element)));
    if (['copy_verify', 'copy_take'].includes(args.action)) {
      const capture = state.providerKeyClipboardCapture;
      if (!capture || capture.ref !== args.ref || capture.id !== args.captureId) return { valid: false };
      if (args.action === 'copy_verify') return { valid: !capture.closed && !capture.hit && copySourceCurrent(capture.source) && navigator.clipboard.writeText === capture.writeText };
      return capture.ready.then(() => {
        let value = capture.value;
        const valid = !capture.closed && !capture.invalid && capture.hit && capture.writes === 1 && copyResultCurrent(capture.source) && typeof value === 'string' && validValue(value) && navigator.clipboard.writeText === capture.writeText;
        const restored = capture.cleanup();
        if (!valid || !restored) { value = undefined; return { valid: false }; }
        return { valid: true, value };
      });
    }
    if (args.action === 'import') {
      const source = state.providerKeySources.get(args.ref), el = source?.element;
      if (!source || source.used || !visible(el) || state.elements.get(args.ref) !== el) return { valid: false };
      if (source.kind === 'copy_control') {
        if (!copySourceCurrent(source) || state.providerKeyClipboardCapture || !globalThis.navigator?.clipboard || typeof navigator.clipboard.writeText !== 'function') return { valid: false };
        const clipboard = navigator.clipboard, descriptor = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
        if (descriptor && descriptor.configurable !== true) return { valid: false };
        source.used = true;
        let settle, timer;
        const capture = { id: Math.random().toString(36).slice(2), ref: args.ref, source, value: null, writes: 0, hit: false, invalid: false, closed: false, ready: new Promise(resolve => { settle = resolve; }) };
        const onClick = event => {
          if (capture.closed || !event.isTrusted || !(event.composedPath?.() || []).includes(el) || !copySourceCurrent(source)) {
            capture.invalid = true; event.preventDefault?.(); event.stopImmediatePropagation?.(); settle(false); return;
          }
          capture.hit = true;
        };
        capture.writeText = value => {
          capture.writes++;
          if (capture.closed || !capture.hit || capture.writes !== 1 || !copyResultCurrent(source) || typeof value !== 'string' || !validValue(value)) {
            capture.invalid = true; settle(false); return Promise.reject(new Error('The protected copy did not match the observed key control.'));
          }
          capture.value = value; settle(true); return Promise.resolve();
        };
        capture.cleanup = () => {
          if (capture.closed) return false;
          capture.closed = true; clearTimeout(timer); capture.value = null; el.removeEventListener('click', onClick, true);
          let restored = false;
          try {
            if (clipboard.writeText === capture.writeText) {
              if (descriptor) Object.defineProperty(clipboard, 'writeText', descriptor); else delete clipboard.writeText;
              restored = true;
            }
          } catch {}
          if (state.providerKeyClipboardCapture === capture) state.providerKeyClipboardCapture = null;
          settle(false); return restored;
        };
        try {
          Object.defineProperty(clipboard, 'writeText', { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: capture.writeText });
          el.addEventListener('click', onClick, true); state.providerKeyClipboardCapture = capture;
          timer = setTimeout(() => capture.cleanup(), 15000);
          return { valid: true, clipboardPrepared: true, captureId: capture.id };
        } catch { capture.cleanup(); return { valid: false }; }
      }
      const value = valueOf(el);
      if (!validValue(value) || value !== source.observedValue) return { valid: false };
      source.used = true; source.observedValue = null; state.credentialFields.add(el);
      return { valid: true, value };
    }
    const sources = [], roots = [document], seenRoots = new Set(roots); let scanned = 0, shadowScanned = 0;
    for (let rootIndex = 0; rootIndex < roots.length && rootIndex < 40; rootIndex++) {
      for (const el of roots[rootIndex].querySelectorAll('input,textarea,code,pre,[role="textbox"],[data-api-key],p,span,div')) {
        if (++scanned > 2000 || sources.length >= 32) break;
        if (!visible(el) || el.type === 'hidden') continue;
        const value = valueOf(el); if (!validValue(value)) continue;
        const label = String(el.getAttribute('aria-label') || (el.labels ? [...el.labels].map(item => item.textContent).join(' ') : '') || el.getAttribute('placeholder') || '');
        const identified = /api[\s_-]*key|access[\s_-]*token|secret[\s_-]*key/i.test(label) || el.hasAttribute('data-api-key');
        const tokenLeaf = ['P', 'SPAN', 'DIV'].includes(el.tagName) && !el.childElementCount && /^(?=.*[0-9_+/=-])[A-Za-z0-9_+/.=-]{24,}$/.test(value);
        const textSource = ['CODE', 'PRE'].includes(el.tagName) || tokenLeaf, readOnly = Boolean(el.readOnly);
        if (!identified && !textSource && !(readOnly && /^[A-Za-z0-9_+/.=-]{24,}$/.test(value))) continue;
        let ref = state.providerKeyRefs.get(el);
        if (!ref) { ref = `${prefix}:${state.documentId}:provider-key-${++state.next}`; state.providerKeyRefs.set(el, ref); }
        state.elements.set(ref, el); state.providerKeySources.set(ref, { element: el, observedValue: value, used: false }); state.credentialFields.add(el);
        sources.push({ ref, sourceKind: 'visible_value', label: `API key ${textSource ? 'text' : 'field'} ${sources.length + 1}`, tag: el.tagName.toLowerCase(), type: ['INPUT', 'TEXTAREA'].includes(el.tagName) ? (el.type || 'textarea') : 'text', readOnly, withinDialog: Boolean(el.closest?.('[role="dialog"],dialog')), identifiedKeyField: identified, valuePresent: true });
      }
      for (const dialog of roots[rootIndex].querySelectorAll('[role="dialog"],dialog')) {
        if (sources.length >= 32 || !visible(dialog)) continue;
        const displays = [...dialog.querySelectorAll('code,pre')].filter(el => visible(el) && el.closest?.('[role="dialog"],dialog') === dialog && /(?:\*{2,}|[•●…]|\.{3})/.test(valueOf(el)));
        const controls = [...dialog.querySelectorAll('button,[role="button"],input[type="button"]')].filter(el => el.closest?.('[role="dialog"],dialog') === dialog && copyControl(el));
        if (displays.length !== 1 || controls.length !== 1) continue;
        const el = controls[0], displayElement = displays[0];
        let ref = state.providerKeyRefs.get(el);
        if (!ref) { ref = `${prefix}:${state.documentId}:provider-key-copy-${++state.next}`; state.providerKeyRefs.set(el, ref); }
        state.elements.set(ref, el); state.providerKeySources.set(ref, { element: el, kind: 'copy_control', dialog, displayElement, observedDisplayValue: valueOf(displayElement), used: false });
        const role = el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : 'textbox');
        state.identities.set(ref, JSON.stringify([el.tagName, el.type || '', role, labelOf(el)]));
        sources.push({ ref, sourceKind: 'copy_control', label: 'API key Copy control', tag: el.tagName === 'BUTTON' ? 'button' : el.tagName === 'INPUT' ? 'input' : 'element', type: 'button', readOnly: true, withinDialog: true, identifiedKeyField: false, valuePresent: false, keyDisplayMasked: true, requiresCopyClick: true });
      }
      for (const el of roots[rootIndex].querySelectorAll('*')) { if (++shadowScanned > 4000) break; if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) { seenRoots.add(el.shadowRoot); roots.push(el.shadowRoot); } }
    }
    for (const [ref, source] of state.providerKeySources) if (!source.element?.isConnected) state.providerKeySources.delete(ref);
    return { valid: true, sources, truncated: scanned > 2000 || shadowScanned > 4000 || roots.length > 40 || sources.length >= 32 };
  } catch { return { valid: false }; }
}

/** The browser queue owns this operation; no secret or page exception is returned. */
export async function performProviderKeySource(driver, value, { signal, owner: context, consume, beforeDispatch } = {}) {
  const args = providerKeyTarget(value), owner = browserOwner(context);
  let tab, cleanupCopy, clickDispatched = false, importAttempted = false;
  const assertTab = ({ requireDocument = true } = {}) => {
    check(signal);
    if (!tab || driver.closed || tab.purpose === 'chat-mode' || !owns(tab, owner) || !tab.window || tab.window.isDestroyed() || tab.pendingInteraction || tab.authenticationChallenge || tab.suspendedWork.size) throw changed();
    const url = tab.window.webContents.getURL();
    if (url !== args.expectedUrl || new URL(url).origin !== args.origin) throw changed();
    if (requireDocument && args.expectedDocumentId) driver.assertInputDocument(tab, { ...args, action: undefined });
  };
  try {
    tab = driver.tab(args.tabId);
    if (tab.purpose === 'chat-mode' || !owns(tab, owner)) throw changed();
    await driver.activate(tab, signal); assertTab();
    if (beforeDispatch) await beforeDispatch({ signal }); assertTab();
    tab.providerKeyProtected = true; tab.credentialCaptureBlocked = true;
    driver.persist(); await driver.flushPersistence(); assertTab();
    if (args.action === 'click_inspect') {
      // Set the privacy marker durably before a potentially consequential click.
      // Only an explicit host option suppresses automatic result snapshots.
      if (!driver.referenceCurrent(tab, args.ref, args.expectedDocumentId)) throw changed();
      clickDispatched = true;
      await driver.perform({ action: 'click', browser: 'relay', tabId: args.tabId, ref: args.ref, expectedUrl: args.expectedUrl, expectedDocumentId: args.expectedDocumentId }, { signal, source: 'agent', owner, suppressResultSnapshot: true });
      assertTab({ requireDocument: false });
    }
    const documentId = `${tab.id}:${tab.revision}`, main = tab.window.webContents.mainFrame;
    const frames = args.action === 'import' ? [tab.refs.get(args.ref)] : [main, ...main.framesInSubtree.filter(frame => frame !== main)].slice(0, 30);
    const sources = [], captured = []; let truncated = false;
    for (const frame of frames) {
      assertTab({ requireDocument: args.action !== 'click_inspect' });
      if (!frame) throw changed();
      if (new URL(frame.url).origin !== args.origin) { if (args.action === 'import') throw changed(); continue; }
      const stamp = driver.frameStamp(tab, frame); if (!stamp) throw changed();
      if (args.action === 'import' && !driver.referenceCurrent(tab, args.ref, args.expectedDocumentId)) throw changed();
      const prefix = `${stamp.mainRevision}-${stamp.lineage.map(item => item.revision).join('_')}-${frame.processId}-${frame.routingId}`;
      const input = { action: args.action === 'import' ? 'import' : 'inspect', origin: args.origin, expectedUrl: args.expectedUrl, ...(args.ref ? { ref: args.ref } : {}) };
      if (args.action === 'import') cleanupCopy = () => driver.pageWork(tab, frame.executeJavaScript(`(${providerKeyPage.toString()})(${JSON.stringify(driver.key)},${JSON.stringify(prefix)},${JSON.stringify({ ...input, action: 'copy_cleanup' })})`), AbortSignal.timeout(1500), 1500);
      let result = await driver.pageWork(tab, frame.executeJavaScript(`(${providerKeyPage.toString()})(${JSON.stringify(driver.key)},${JSON.stringify(prefix)},${JSON.stringify(input)})`), signal);
      assertTab({ requireDocument: args.action !== 'click_inspect' });
      if (!driver.frameStampCurrent(tab, stamp) || `${tab.id}:${tab.revision}` !== documentId || result?.valid !== true) throw changed();
      if (args.action === 'import') {
        if (result.clipboardPrepared === true) {
          const captureId = result.captureId;
          if (typeof captureId !== 'string' || !/^[a-z0-9]{1,64}$/.test(captureId)) throw changed();
          const copyAction = action => frame.executeJavaScript(`(${providerKeyPage.toString()})(${JSON.stringify(driver.key)},${JSON.stringify(prefix)},${JSON.stringify({ ...input, action, captureId })})`);
          try {
            if (beforeDispatch) await beforeDispatch({ signal }); assertTab();
            if (!driver.frameStampCurrent(tab, stamp) || !driver.referenceCurrent(tab, args.ref, args.expectedDocumentId)) throw changed();
            const verified = await driver.pageWork(tab, copyAction('copy_verify'), signal);
            assertTab(); if (verified?.valid !== true || !driver.frameStampCurrent(tab, stamp)) throw changed();
            clickDispatched = true;
            await driver.perform({ action: 'click', browser: 'relay', tabId: args.tabId, ref: args.ref, expectedUrl: args.expectedUrl, expectedDocumentId: args.expectedDocumentId }, { signal, source: 'agent', owner, suppressResultSnapshot: true });
            assertTab(); if (!driver.frameStampCurrent(tab, stamp)) throw changed();
            result = await driver.pageWork(tab, copyAction('copy_take'), signal);
            assertTab();
            if (!driver.frameStampCurrent(tab, stamp) || `${tab.id}:${tab.revision}` !== documentId || result?.valid !== true) throw changed();
          } finally {
            // Cleanup is independent of the cancelled operation. A page deadline
            // also restores the method if the frame or host becomes unavailable.
            try { await driver.pageWork(tab, copyAction('copy_cleanup'), AbortSignal.timeout(1500), 1500); } catch {}
          }
        }
        let secret = result.value; result.value = undefined;
        if (typeof secret !== 'string' || !secret || typeof consume !== 'function') throw Object.assign(changed(), { code: 'PROVIDER_KEY_SOURCE_EMPTY' });
        try { if (beforeDispatch) await beforeDispatch({ signal }); assertTab(); importAttempted = true; return await consume(secret, { signal }); }
        finally { secret = undefined; }
      }
      const items = Array.isArray(result.sources) ? result.sources.slice(0, 32 - sources.length) : [];
      sources.push(...items); captured.push({ stamp, elements: items }); truncated ||= result.truncated === true || sources.length >= 32;
      if (sources.length >= 32) break;
    }
    assertTab({ requireDocument: args.action !== 'click_inspect' });
    if (captured.some(item => !driver.frameStampCurrent(tab, item.stamp))) throw changed();
    driver.rememberReferences(tab, captured, documentId);
    return { tabId: args.tabId, origin: args.origin, url: args.expectedUrl, documentId, sources, truncated, protectedContent: true, ...(args.action === 'click_inspect' ? { clickDispatched: true, inspectBeforeRepeating: true } : {}) };
  } catch (cause) { throw providerKeyFailure(cause, { clickDispatched, importAttempted }); }
  finally { if (cleanupCopy) try { await cleanupCopy(); } catch {} }
}
